// Облачный сканер: те же правила, что на странице, и сообщение в Telegram. Сделок не открывает.
// Правила берутся прямо из index.html, поэтому страница и сканер считают одинаково.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import vm from "node:vm";

const COINS = 50, WORKERS = 3, STATE = "scan_state.json", SITE = "https://sat1k100500-design.github.io/zone-terminal/";
const LOADS = { "1d": 150, "4h": 300, "1h": 300, "15m": 300 };
const { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, SCAN_TEST: TEST } = process.env;

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const from = html.indexOf("/* ---------- Правила курса ---------- */"), to = html.indexOf("/* ---------- Данные ---------- */");
if (from < 0 || to < 0) throw new Error("Не найден блок правил в index.html");
const { buildModel, fmt } = vm.runInNewContext(`${html.slice(from, to)}; ({ buildModel, fmt })`);

const json = async url => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.json();
};
const FAPI = "https://fapi.binance.com/fapi/v1", SPOT = "https://data-api.binance.vision/api/v3";

async function coinList() {
  try {
    const [info, ticks] = await Promise.all([json(`${FAPI}/exchangeInfo`), json(`${FAPI}/ticker/24hr`)]);
    const live = new Set(info.symbols.filter(s => s.contractType === "PERPETUAL" && s.status === "TRADING" && s.quoteAsset === "USDT").map(s => s.symbol));
    return { api: FAPI, source: "Binance Futures", list: ticks.filter(t => live.has(t.symbol)).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, COINS).map(t => t.symbol) };
  } catch (e) {
    console.log(`Фьючерсы недоступны (${e.message}), считаю по споту`);
    const stable = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|USDE|RLUSD|USD1|EUR|U)USDT$/;
    const ticks = await json(`${SPOT}/ticker/24hr`);
    return { api: SPOT, source: "Binance Spot", list: ticks.filter(t => t.symbol.endsWith("USDT") && !stable.test(t.symbol)).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, COINS).map(t => t.symbol) };
  }
}
async function candles(api, sym, tf) {
  const rows = await json(`${api}/klines?symbol=${sym}&interval=${tf}&limit=${LOADS[tf]}`);
  return rows.map(x => ({ t: x[0] / 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4] }));
}
async function send(text) {
  if (!TOKEN || !CHAT) { console.log("[без отправки]\n" + text); return; }
  let problem = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }),
      });
      if (r.ok) return;
      problem = `ответ ${r.status}`;
      if (r.status >= 400 && r.status < 500 && r.status !== 429) break; // неверный токен или чат: повтор не поможет
    } catch (e) { problem = e.name; }
    console.log(`Telegram: ${problem}, попытка ${attempt}`);
    await new Promise(done => setTimeout(done, attempt * 5000));
  }
  throw new Error(`Telegram не принял сообщение: ${problem}`);
}

function entryLines(r, f) {
  if (!r) return ["Зоны входа после Shift нет"];
  const out = [];
  if (r.ob) out.push(`Вход OB ${f(r.ob.open)}, 50% ${f(r.ob.mid)}`);
  if (r.fvg) out.push(`Вход FVG ${f(r.fvg.edge)}, 50% ${f(r.fvg.mid)}`);
  if (r.touched) out.push("Цена уже заходила в зону");
  return out;
}

const { api, source, list } = await coinList();
if (TEST === "true") await send(`Проверка связи. Сканер работает, данные: ${source}.`);

let seen = {};
if (existsSync(STATE)) try { seen = JSON.parse(readFileSync(STATE, "utf8")); } catch (e) { seen = {}; }

const hits = [], early = [];
let next = 0, failed = 0;
await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (next < list.length) {
    const sym = list[next++];
    try {
      const data = {};
      for (const tf of Object.keys(LOADS)) data[tf] = await candles(api, sym, tf);
      const m = buildModel(data, "15m", { lo: null, hi: null });
      for (const side of ["long", "short"]) {
        const s = m.setup[side];
        if (s.ok) hits.push({ sym, side, rr: s.rr, stop: s.stop, target: s.target.v, price: m.price, sweepT: s.sweep.t, retest: s.retest });
        if (s.early) early.push({ sym, side, s, price: m.price });
      }
    } catch (e) { failed++; console.log(`${sym}: ${e.message}`); }
  }
}));
console.log(`Источник ${source}. Проверено ${list.length - failed} из ${list.length}, сетапов ${hits.length}, ранних сигналов ${early.length}.`);
if (failed === list.length) throw new Error("Не удалось получить данные ни по одной монете");

for (const e of early) {
  const key = `early:${e.sym}:${e.side}:${e.s.sweep.t}`;
  if (seen[key]) continue;
  const f = v => fmt(v, e.price), { s } = e;
  await send([
    `Ранний сигнал. ${e.sym}: Shift ${e.side === "long" ? "вверх" : "вниз"} после свипа`,
    `Свип ${s.sweep.name} ${f(s.sweep.v)}`,
    `Shift через ${f(s.shift.v)}`,
    `Цена ${f(e.price)}`,
    ...entryLines(s.retest, f),
    `Стоп-лосс ${f(s.stop)}`,
    s.target && s.rr !== null ? `${s.rr.toFixed(1)}R до ${f(s.target.v)}` : "Цели рядом нет",
    `Условий курса ${s.passed} из 9${s.missing.length ? `. Нет: ${s.missing.join(", ")}` : ""}`,
    `Данные: ${source}. Это не сигнал на вход, сверь график:`,
    `${SITE}?s=${e.sym}`,
  ].join("\n"));
  seen[key] = Date.now();
}

for (const h of hits) {
  const key = `${h.sym}:${h.side}:${h.sweepT}`;
  if (seen[key]) continue;
  await send([
    `${h.sym}: условия ${h.side === "long" ? "лонга" : "шорта"} собраны`,
    `Цена ${fmt(h.price, h.price)}`,
    ...entryLines(h.retest, v => fmt(v, h.price)),
    `${h.rr.toFixed(1)}R до ${fmt(h.target, h.price)}`,
    `Стоп-лосс ${fmt(h.stop, h.price)}`,
    `Данные: ${source}`,
    `Это проверка условий, а не сигнал. Сверь график:`,
    `${SITE}?s=${h.sym}`,
  ].join("\n"));
  seen[key] = Date.now();
}
const week = Date.now() - 7 * 864e5;
for (const k of Object.keys(seen)) if (seen[k] < week) delete seen[k];
writeFileSync(STATE, JSON.stringify(seen));
