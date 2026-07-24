#!/usr/bin/env node
// Emits build/stocks.json and build/live.json from the browser data files,
// so the Python workbook builder can read clean JSON.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const evalWindow = file => {
  const w = {};
  new Function("window", readFileSync(join(root, file), "utf8"))(w);
  return w;
};

const s = evalWindow("data/stocks.js");
const l = evalWindow("data/live.js");

mkdirSync(join(root, "build"), { recursive: true });
writeFileSync(join(root, "build/stocks.json"), JSON.stringify({
  stocks: s.STOCKS, models: s.MODELS, sectors: s.SECTORS,
}));
writeFileSync(join(root, "build/live.json"), JSON.stringify(l.LIVE));
console.log(`dumped ${s.STOCKS.length} stocks, ${Object.keys(l.LIVE.data).length} live records`);
