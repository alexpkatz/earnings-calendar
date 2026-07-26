#!/usr/bin/env node
// ============================================================================
// refresh.mjs — pulls fresh prices, 30/60-day performance, and earnings dates
// for every ticker in data/stocks.js, then writes data/live.js.
//
// Usage:   node refresh.mjs            (all tickers)
//          node refresh.mjs AAPL NVDA  (just these tickers, for testing)
//
// No API key needed. Uses Yahoo Finance public endpoints with throttling.
// ============================================================================
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");

// ---- load ticker universe from stocks.js (it's a browser file; eval the array)
const stocksSrc = readFileSync(join(DATA_DIR, "stocks.js"), "utf8");
const sandbox = { window: {} };
new Function("window", stocksSrc)(sandbox.window);
let tickers = sandbox.window.STOCKS.filter(s => !s.fund && s.t && !s.t.includes("(")).map(s => s.t);

const cliArgs = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (cliArgs.length) tickers = cliArgs.map(t => t.toUpperCase());

// Yahoo symbol mapping (dots become dashes for share classes)
const ysym = t => t.replace(".", "-");

const HEADERS = {
  "User-Agent": "Mozilla/5.0",
  "Accept": "application/json",
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      // hard 12s timeout — some endpoints stall connections from datacenter IPs
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
      if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

// ---- prices + 30/60d performance from the chart API -------------------------
async function getPricePerf(t) {
  const sym = encodeURIComponent(ysym(t));
  let j;
  try {
    j = await fetchJSON(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}?range=4mo&interval=1d`);
  } catch {
    j = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=4mo&interval=1d`);
  }
  const r = j?.chart?.result?.[0];
  if (!r || !r.timestamp?.length) throw new Error("no chart data");
  const ts = r.timestamp;
  const closes = r.indicators?.quote?.[0]?.close || [];
  // build clean [date, close] series
  const series = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] != null) series.push([ts[i] * 1000, closes[i]]);
  }
  if (!series.length) throw new Error("empty series");
  const last = series[series.length - 1];
  const price = last[1];
  const now = last[0];
  const findCloseTo = daysAgo => {
    const target = now - daysAgo * 86400e3;
    let best = null, bestDiff = Infinity;
    for (const [d, c] of series) {
      const diff = Math.abs(d - target);
      if (diff < bestDiff) { bestDiff = diff; best = c; }
    }
    return best;
  };
  const p30 = findCloseTo(30), p60 = findCloseTo(60);
  return {
    price: +price.toFixed(2),
    perf30: p30 ? +(((price - p30) / p30) * 100).toFixed(2) : null,
    perf60: p60 ? +(((price - p60) / p60) * 100).toFixed(2) : null,
    currency: r.meta?.currency || "USD",
    name: r.meta?.longName || r.meta?.shortName || null,
  };
}

// ---- earnings dates (Nasdaq calendar + researched overrides) ----------------
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

function calTime(t) {                       // Nasdaq calendar 'time' -> BMO/AMC
  if (t === "time-pre-market") return "BMO";
  if (t === "time-after-hours") return "AMC";
  return null;
}
const normSym = s => (s || "").replace("/", ".").toUpperCase();

// Scan Nasdaq's published earnings calendar day-by-day across the window.
// Returns { TICKER: [ {date, time, estimated:false, source:"Nasdaq"} ] } — real,
// confirmed dates only; nothing is fabricated.
async function fetchNasdaqCalendar(universe, startMs, endMs) {
  const days = [];
  for (let ms = startMs; ms <= endMs; ms += 86400e3) {
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(isoDay(ms));
  }
  const out = {};
  let idx = 0, done = 0;
  async function worker() {
    while (idx < days.length) {
      const day = days[idx++];
      try {
        const j = await fetchJSON(`https://api.nasdaq.com/api/calendar/earnings?date=${day}`, 2);
        for (const r of (j?.data?.rows || [])) {
          const sym = normSym(r.symbol);
          if (universe.has(sym))
            (out[sym] = out[sym] || []).push({ date: day, time: calTime(r.time), estimated: false, source: "Nasdaq" });
        }
      } catch { /* skip day */ }
      if (++done % 20 === 0) process.stdout.write(`  ...scanned ${done}/${days.length} calendar days\n`);
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: 5 }, worker));   // concurrency 5
  return out;
}

// Researched dates for names Nasdaq hasn't scheduled yet (data/earnings-research.js).
// Shape: window.EARNINGS_RESEARCH = { TICKER: {date,time,estimated,source} | [ ... ] }
function loadResearch() {
  const p = join(DATA_DIR, "earnings-research.js");
  if (!existsSync(p)) return {};
  try {
    const w = {};
    new Function("window", readFileSync(p, "utf8"))(w);
    return w.EARNINGS_RESEARCH || {};
  } catch { return {}; }
}

// Merge Nasdaq calendar hits with researched overrides for one ticker.
function buildEarnings(t, calendar, research, endMs) {
  const list = (calendar[t] || []).slice();
  const rr = research[t];
  if (rr) {
    const arr = Array.isArray(rr) ? rr : [rr];
    for (const e of arr) {
      if (!e || !e.date) continue;
      const dms = Date.parse(e.date + "T12:00:00Z");
      if (isNaN(dms) || dms > endMs) continue;
      if (list.some(x => Math.abs(Date.parse(x.date + "T12:00:00Z") - dms) < 6 * 86400e3)) continue;
      list.push({ date: e.date, time: e.time || null,
                  estimated: e.estimated !== false, source: e.source || "research" });
    }
  }
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

// ---- main -------------------------------------------------------------------
const START = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
const END_2026 = Date.UTC(2026, 11, 31, 23, 59, 59);
const out = {};
const failures = [];
let done = 0;

// One pass over Nasdaq's published calendar (real confirmed dates), plus any
// web-researched dates for names Nasdaq hasn't scheduled yet.
const universe = new Set(tickers.map(normSym));
console.log(`Scanning Nasdaq earnings calendar ${isoDay(START)} → ${isoDay(END_2026)}...`);
const calendar = await fetchNasdaqCalendar(universe, START, END_2026);
const research = loadResearch();
console.log(`Calendar: ${Object.keys(calendar).length} tickers with confirmed dates; ` +
            `${Object.keys(research).length} researched overrides available.\n`);

console.log(`Refreshing ${tickers.length} tickers (prices + earnings)...`);
for (const t of tickers) {
  process.stdout.write(`  [${++done}/${tickers.length}] ${t.padEnd(6)} `);
  const rec = {};
  try {
    const pp = await getPricePerf(t);
    Object.assign(rec, pp);
    rec.earnings = buildEarnings(normSym(t), calendar, research, END_2026);
    out[t] = rec;
    const nd = rec.earnings[0];
    console.log(`$${rec.price}  next: ${nd ? nd.date + (nd.estimated ? " (est·" + nd.source + ")" : " (" + nd.source + ")") : "not scheduled"}`);
  } catch (err) {
    failures.push(t);
    console.log(`FAILED (${err.message})`);
  }
  await sleep(200);
}

function fmtPct(v) { return v == null ? "–" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%"; }

// merge with previous run so a partial refresh (CLI ticker list) keeps old data
let prev = {};
const livePath = join(DATA_DIR, "live.js");
if (existsSync(livePath) && cliArgs.length) {
  try {
    const src = readFileSync(livePath, "utf8");
    const sb = { window: {} };
    new Function("window", src)(sb.window);
    prev = sb.window.LIVE?.data || {};
  } catch { /* ignore */ }
}

const merged = { ...prev, ...out };
const payload = { refreshedAt: new Date().toISOString(), data: merged };
writeFileSync(livePath, "window.LIVE = " + JSON.stringify(payload, null, 1) + ";\n");

console.log(`\nWrote data/live.js — ${Object.keys(merged).length} tickers, refreshed ${payload.refreshedAt}`);
if (failures.length) console.log(`Failed (${failures.length}): ${failures.join(", ")}\n(You can re-run just these: node refresh.mjs ${failures.join(" ")})`);
