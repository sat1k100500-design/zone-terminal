// Облачный сканер: те же правила, что на странице, и сообщение в Telegram. Сделок не открывает.
// Правила берутся прямо из index.html, поэтому страница и сканер считают одинаково.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import vm from "node:vm";

const FUTURES = new URL("./futures.json", import.meta.url);
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
    /* На споте есть монеты без фьючерсов, например токены акций: терминал их не откроет, поэтому берём только те, что есть в списке фьючерсов. Из облака фьючерсы недоступны, список лежит в futures.json. */
    const known = new Set(existsSync(FUTURES) ? JSON.parse(readFileSync(FUTURES, "utf8")).symbols : []);
    const spot = ticks.filter(t => t.symbol.endsWith("USDT") && !stable.test(t.symbol)).sort((a, b) => b.quoteVolume - a.quoteVolume);
    const usable = known.size ? spot.filter(t => known.has(t.symbol)) : spot;
    const skipped = spot.slice(0, COINS).filter(t => known.size && !known.has(t.symbol)).map(t => t.symbol);
    console.log(`Список фьючерсов: ${known.size}. Убрано из верхних ${COINS} спота: ${skipped.join(", ") || "ничего"}`);
    return { api: SPOT, source: "Binance Spot", list: usable.slice(0, COINS).map(t => t.symbol) };
  }
}
async function candles(api, sym, tf) {
  const rows = await json(`${api}/klines?symbol=${sym}&interval=${tf}&limit=${LOADS[tf]}`);
  return rows.map(x => ({ t: x[0] / 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4] }));
}
/* silent: сообщение придёт без звука. */
async function send(text, silent = false) {
  if (!TOKEN || !CHAT) { console.log(`[без отправки${silent ? ", тихо" : ""}]\n` + text); return; }
  let problem = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true, disable_notification: silent }),
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
  return out;
}
const sideName = side => side === "long" ? "лонг" : "шорт";
const pdName = side => side === "long" ? "Discount" : "Premium";
const inBand = (a, price) => price >= a.band[0] && price <= a.band[1];
const planLines = (a, f) => [
  `Стоп-лосс ${f(a.stop)}`,
  `Тейк-профит 3R ${f(a.tp3)}`,
  a.target && a.rr !== null ? `${a.rr.toFixed(1)}R до ${a.target.name} ${f(a.target.v)}` : "Цели рядом нет",
];
/* Облако запускается редко, поэтому свежим считается Shift за последние 6 свечей m15, а не 2, как на компьютере. */
const FRESH = 6, RETURN = 40;

const { api, source, list } = await coinList();
if (TEST === "true") await send(`Проверка связи. Сканер работает, данные: ${source}.`);

let seen = {};
if (existsSync(STATE)) try { seen = JSON.parse(readFileSync(STATE, "utf8")); } catch (e) { seen = {}; }

const hits = [], retest = [];
let next = 0, failed = 0;
await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (next < list.length) {
    const sym = list[next++];
    try {
      const data = {};
      for (const tf of Object.keys(LOADS)) data[tf] = await candles(api, sym, tf);
      const m = buildModel(data, "15m", { lo: null, hi: null });
      for (const side of ["long", "short"]) {
        const a = m.setup[side].alert;
        if (!a) continue;
        if (a.age <= FRESH && inBand(a, m.price)) hits.push({ sym, side, a, price: m.price });
        if (a.retest && a.age <= RETURN) retest.push({ sym, side, a, price: m.price });
      }
    } catch (e) { failed++; console.log(`${sym}: ${e.message}`); }
  }
}));
console.log(`Источник ${source}. Проверено ${list.length - failed} из ${list.length}, свежих Shift ${hits.length}, ждут возврата ${retest.length}.`);
if (failed === list.length) throw new Error("Не удалось получить данные ни по одной монете");

for (const w of retest) {
  const { a } = w, dir = w.side === "long" ? 1 : -1;
  if (dir * (w.price - a.entry) > 0 || !inBand(a, w.price) || (a.target && dir * (w.price - a.target.v) >= 0) || dir * (w.price - a.stop) <= 0) continue;
  const key = `poi:${w.sym}:${w.side}:${a.shift.t}`;
  if (seen[key]) continue;
  const f = v => fmt(v, w.price), poi = a.pois.find(z => w.price >= z.lo && w.price <= z.hi);
  await send([
    `🟣 ${w.sym}: возврат в зону ${a.retest.name}, ${sideName(w.side)}`,
    `Цена ${f(w.price)}, ${pdName(w.side)}`,
    ...entryLines(a.retest, f),
    ...(poi ? [`Внутри старшей зоны ${poi.tfl} ${poi.type} ${f(poi.lo)}–${f(poi.hi)}`] : []),
    ...planLines(a, f),
    `Данные: ${source}. Проверь реакцию на графике:`,
    `${SITE}?s=${w.sym}`,
  ].join("\n"));
  seen[key] = Date.now();
}

for (const h of hits) {
  const { a } = h, key = `shift:${h.sym}:${h.side}:${a.shift.t}`;
  if (seen[key]) continue;
  const f = v => fmt(v, h.price);
  await send([
    `🟢 ${h.sym}: Shift ${h.side === "long" ? "вверх" : "вниз"} после свипа ${a.sweep.name}`,
    `Свип ${f(a.sweep.v)}, Shift через ${f(a.shift.v)}`,
    `Цена ${f(h.price)}, ${pdName(h.side)}`,
    ...entryLines(a.retest, f),
    ...planLines(a, f),
    `Данные: ${source}. Это не сигнал на вход, сверь график:`,
    `${SITE}?s=${h.sym}`,
  ].join("\n"));
  seen[key] = Date.now();
}
const week = Date.now() - 7 * 864e5;
for (const k of Object.keys(seen)) if (seen[k] < week) delete seen[k];
writeFileSync(STATE, JSON.stringify(seen));
