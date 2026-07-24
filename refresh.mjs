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

// ---- earnings dates ---------------------------------------------------------
// Primary: Nasdaq earnings-date API (gives date, BMO/AMC, and estimated flag).
// Fallback: Yahoo quoteSummary calendarEvents.
async function getEarningsNasdaq(t) {
  // Nasdaq uses dots for share classes (BRK.B) — but its API wants no dots either; try as-is then dashless
  const url = `https://api.nasdaq.com/api/analyst/${encodeURIComponent(t)}/earnings-date`;
  const j = await fetchJSON(url, 2);
  const txt = j?.data?.reportText || "";
  const m = txt.match(/on\s+(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const dateMs = Date.UTC(+m[3], +m[1] - 1, +m[2], 12);
  const time = /before market open/i.test(txt) ? "BMO"
             : /after market close/i.test(txt) ? "AMC" : null;
  const estimated = /expected\*/.test(txt);
  return { dateMs, time, estimated };
}

// Yahoo quoteSummary needs a cookie + crumb pair; fetch once and cache.
let yahooAuth = null;
async function getYahooAuth() {
  if (yahooAuth !== null) return yahooAuth;
  try {
    const r1 = await fetch("https://fc.yahoo.com/", { headers: HEADERS, redirect: "manual", signal: AbortSignal.timeout(12000) });
    const cookie = (r1.headers.get("set-cookie") || "").split(";")[0];
    const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { ...HEADERS, Cookie: cookie }, signal: AbortSignal.timeout(12000),
    });
    const crumb = (await r2.text()).trim();
    yahooAuth = crumb && !crumb.includes("<") ? { cookie, crumb } : false;
  } catch { yahooAuth = false; }
  return yahooAuth;
}

async function getEarningsYahoo(t) {
  const auth = await getYahooAuth();
  if (!auth) return null;
  const sym = encodeURIComponent(ysym(t));
  const urls = [
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=calendarEvents&crumb=${encodeURIComponent(auth.crumb)}`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=calendarEvents&crumb=${encodeURIComponent(auth.crumb)}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { ...HEADERS, Cookie: auth.cookie }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const j = await res.json();
      const cal = j?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
      const raw = (cal?.earningsDate || []).map(d => d?.raw).filter(Boolean);
      if (!raw.length) continue;
      const dateMs = raw[0] * 1000;
      const isEst = cal?.isEarningsDateEstimate?.raw ?? cal?.isEarningsDateEstimate ?? false;
      return { dateMs, time: timeOfDay(dateMs), estimated: !!isEst };
    } catch { /* try next */ }
  }
  return null;
}

// Historical report dates (Nasdaq earnings-surprise) — used for seasonal projection.
async function getEarningsHistory(t) {
  const url = `https://api.nasdaq.com/api/company/${encodeURIComponent(t)}/earnings-surprise`;
  const j = await fetchJSON(url, 2);
  const rows = j?.data?.earningsSurpriseTable?.rows || [];
  const dates = [];
  for (const r of rows) {
    const m = String(r?.dateReported || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) dates.push(Date.UTC(+m[3], +m[1] - 1, +m[2], 12));
  }
  return dates.sort((a, b) => a - b);
}

async function getEarnings(t) {
  let next = null;
  try { next = await getEarningsNasdaq(t); } catch { /* fall through */ }
  if (!next) { try { next = await getEarningsYahoo(t); } catch { /* none */ } }
  let history = [];
  try { history = await getEarningsHistory(t); } catch { /* none */ }
  return { next, history };
}

const DAY = 86400e3, YEAR = 364 * DAY;  // 52 weeks keeps the same weekday
// nudge weekends onto the adjacent weekday (earnings almost never land on Sat/Sun)
function snapWeekday(ms) {
  const d = new Date(ms), dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

// ---- project report dates through end of 2026, seasonally --------------------
// Companies report on a stable seasonal cadence, so we predict each 2026 date as
// the matching quarter's date one year earlier + 52 weeks. Any confirmed/expected
// date from Nasdaq/Yahoo overrides a nearby prediction.
function projectQuarters(info, endMs, nowMs) {
  const { next, history } = info;
  const cand = [];
  // seasonal predictions from each historical report date
  for (const h of history) cand.push({ dateMs: snapWeekday(h + YEAR), estimated: true, time: null });
  // a real confirmed/expected date, if we have one
  if (next) cand.push({ dateMs: next.dateMs, estimated: !!next.estimated, time: next.time });

  // if no history at all, fall back to stepping the confirmed date forward ~91d
  if (!history.length) {
    if (!next) return [];
    const out = [{ date: isoDay(next.dateMs), estimated: !!next.estimated, time: next.time }];
    let cur = next.dateMs;
    while ((cur += 91 * DAY) <= endMs) out.push({ date: isoDay(snapWeekday(cur)), estimated: true, time: null });
    return out;
  }

  // keep upcoming-through-end-of-window, earliest first
  const keep = cand
    .filter(r => r.dateMs >= nowMs - 10 * DAY && r.dateMs <= endMs)
    .sort((a, b) => a.dateMs - b.dateMs);

  // merge near-duplicates (within 20 days), preferring a confirmed date over an estimate
  const merged = [];
  for (const r of keep) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(r.dateMs - last.dateMs) < 20 * DAY) {
      if (!r.estimated && last.estimated) merged[merged.length - 1] = r;
    } else merged.push(r);
  }
  return merged.map(r => ({ date: isoDay(r.dateMs), estimated: r.estimated, time: r.time }));
}

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
function timeOfDay(ms) {
  // Yahoo earnings timestamps encode announce time; before 10:00 ET ≈ BMO, after 15:30 ≈ AMC
  const d = new Date(ms);
  const utcH = d.getUTCHours();
  if (utcH <= 13) return "BMO";       // before market open (≤ 9:00 ET)
  if (utcH >= 19) return "AMC";       // after market close (≥ 15:00 ET)
  return null;
}

// ---- main -------------------------------------------------------------------
const END_2026 = Date.UTC(2026, 11, 31, 23, 59, 59);
const out = {};
const failures = [];
let done = 0;

console.log(`Refreshing ${tickers.length} tickers...`);
for (const t of tickers) {
  process.stdout.write(`  [${++done}/${tickers.length}] ${t.padEnd(6)} `);
  const rec = {};
  try {
    const pp = await getPricePerf(t);
    Object.assign(rec, pp);
    await sleep(150);
    const e = await getEarnings(t);
    rec.earnings = projectQuarters(e, END_2026, Date.now());
    out[t] = rec;
    const nd = rec.earnings[0];
    console.log(`$${rec.price}  30d ${fmtPct(rec.perf30)}  60d ${fmtPct(rec.perf60)}  next: ${nd ? nd.date + (nd.estimated ? " (est)" : "") : "—"}`);
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
