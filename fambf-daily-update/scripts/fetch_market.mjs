// FAMBF · ежедневный снапшот котировок Deribit -> market.json
// Запускается GitHub Action-ом (node 20+, встроенный fetch). Ключи API не нужны.
import { writeFileSync } from "node:fs";

const API = "https://www.deribit.com/api/v2/public/";
async function j(u) {
  const r = await fetch(API + u);
  if (!r.ok) throw new Error("HTTP " + r.status + " " + u);
  const x = await r.json();
  if (x.error || !x.result) throw new Error("API error " + u);
  return x.result;
}

const spot = (await j("get_index_price?index_name=btc_usd")).index_price;
const list = await j("get_instruments?currency=BTC&kind=option&expired=false");

const now = Date.now(), exps = {};
for (const o of list) {
  if (o.option_type !== "call") continue;
  const dd = (o.expiration_timestamp - now) / 86400000;
  if (dd < 8) continue; // слишком короткие серии пропускаем
  (exps[o.expiration_timestamp] = exps[o.expiration_timestamp] || []).push(o);
}
const keys = Object.keys(exps).map(Number);
if (!keys.length) throw new Error("no expiries");

const targets = { m: 30, q: 90, h: 180 }, used = new Set(), slots = {};
for (const s of ["m", "q", "h"]) {
  let best = null, bd = 1e18;
  for (const ts of keys) {
    if (used.has(ts)) continue;
    const diff = Math.abs((ts - now) / 86400000 - targets[s]);
    if (diff < bd) { bd = diff; best = ts; }
  }
  used.add(best);
  const arr = exps[best];
  const atm = arr.reduce((a, b) => Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a);
  const tk = await j("ticker?instrument_name=" + encodeURIComponent(atm.instrument_name));
  slots[s] = {
    series: atm.instrument_name.split("-").slice(0, 2).join("-"),
    expiry_ts: best,
    mark_pct: Math.round((tk.mark_price || 0) * 10000) / 100, // % от спота
    iv: tk.mark_iv ? Math.round(tk.mark_iv * 10) / 10 : null,
    strike: atm.strike
  };
  if (!(slots[s].mark_pct > 0)) throw new Error("bad mark for " + s);
}

writeFileSync("market.json",
  JSON.stringify({ updated: new Date().toISOString(), spot: Math.round(spot), slots }, null, 1) + "\n");
console.log("market.json updated:", JSON.stringify(slots));
