// Облачный сканер мемов, режим «После слива»: те же правила, что в разделе «Мемы» терминала, и сообщение в Telegram.
// Ничего не покупает. Шлёт токены, где выполнены все условия, и тихо — те, где не хватает одного условия.
// Фильтры по умолчанию, как в терминале: капа до 3 млн $, ликвидность от 10 тыс $, падение от пика от 70%, объём за 6 ч от 1,5×.
// Проверка ликвидности: RugCheck для Solana, GoPlus для Base и BSC; показываем только с блокировкой от 90% и без опасных рисков.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const NETS = (process.env.MEME_NETS || "solana,base,bsc").split(","), STATE = "meme_state.json";
const SITE = "https://sat1k100500-design.github.io/zone-terminal/";
const F = { cap: 3e6, liq: 1e4, drop: 70, volx: 1.5 }, MIN_LOCK = 90, REPEAT_H = 48;
const { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, SCAN_TEST: TEST, DRY_RUN: DRY } = process.env;
const QUOTES = /^(SOL|WSOL|USDC|USDT|WETH|ETH|WBNB|BNB|USD1|cbBTC)$/i, GT = "https://api.geckoterminal.com/api/v2", DS = "https://api.dexscreener.com";
const KEYS = ["падение от пика", "пик давно", "нет нового минимума", "объём", "покупки ≥ продаж", "ещё не вырос"];
const NET_NAME = { solana: "Solana", base: "Base", bsc: "BSC" }, GOPLUS = { base: 8453, bsc: 56 }, BURN = /^0x0{40}$|^0x0{36}dead$/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const usd = v => !v ? "0 $" : v >= 1e6 ? `${(v / 1e6).toFixed(2)} млн $` : v >= 1e3 ? `${Math.round(v / 1e3)} тыс $` : `${Math.round(v)} $`;

async function getJson(url, tries = 3) {
  for (let a = 0; a < tries; a++) {
    try { const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) }); if (r.ok) return r.json(); if (r.status !== 429 && r.status < 500) throw new Error(`${r.status}`); } catch (e) { if (a === tries - 1) throw e; }
    await sleep(4000 * (a + 1));
  }
  throw new Error("лимит запросов");
}
let gtLast = 0;
async function gt(path) { const wait = gtLast + 2200 - Date.now(); if (wait > 0) await sleep(wait); gtLast = Date.now(); return getJson(GT + path); }

function checks(r) {
  return [
    [r.drop >= F.drop, `упал от пика на ${Math.round(r.drop)}% (нужно от ${F.drop}%)`],
    [r.peakAgo >= 2, `пик ${r.peakAgo < 1 ? "меньше суток" : Math.round(r.peakAgo) + " дн"} назад`],
    [!r.newLow, r.newLow ? "за сутки обновил минимум прошлых 3 дней" : "за сутки нового минимума нет"],
    [r.volx >= F.volx, `объём за 6 ч ${r.volx.toFixed(1)}× к обычному`],
    [r.buys6 >= r.sells6, `покупок за 6 ч ${r.buys6}, продаж ${r.sells6}`],
    [r.ch6 <= 50, `цена за 6 ч ${r.ch6 >= 0 ? "+" : ""}${Math.round(r.ch6)}%`],
  ];
}
async function scanNet(net) {
  const toks = new Set();
  for (const path of ["/community-takeovers/latest/v1", "/token-boosts/latest/v1", "/token-boosts/top/v1", "/token-profiles/latest/v1"]) { try { for (const x of await getJson(DS + path)) if (x.chainId === net && x.tokenAddress) toks.add(x.tokenAddress); } catch (e) {} }
  for (const d of ["6h", "24h"]) for (const pg of [1, 2]) { try { const r = await gt(`/networks/${net}/trending_pools?duration=${d}&page=${pg}`); for (const x of r.data || []) toks.add(String(x.relationships.base_token.data.id).replace(net + "_", "")); } catch (e) {} }
  const all = [...toks], pairs = [];
  for (let i = 0; i < all.length; i += 30) {
    try { const best = {}; for (const p of await getJson(`${DS}/tokens/v1/${net}/${all.slice(i, i + 30).join(",")}`)) { const k = p.baseToken?.address; if (k && (!best[k] || (p.liquidity?.usd || 0) > (best[k].liquidity?.usd || 0))) best[k] = p; } pairs.push(...Object.values(best)); } catch (e) {}
  }
  const pre = pairs.map(p => ({ net, tok: p.baseToken.address, pool: p.pairAddress, base: p.baseToken.symbol, price: +p.priceUsd || 0, cap: p.marketCap || p.fdv || 0, liq: p.liquidity?.usd || 0, v6: p.volume?.h6 || 0, v24: p.volume?.h24 || 0, buys6: p.txns?.h6?.buys || 0, sells6: p.txns?.h6?.sells || 0, ch6: p.priceChange?.h6 || 0, age: (Date.now() - p.pairCreatedAt) / 3600e3 }))
    .filter(r => !QUOTES.test(r.base) && r.age >= 48 && r.cap > 0 && r.cap <= F.cap && r.liq >= F.liq)
    .sort((a, b) => b.v6 / b.cap - a.v6 / a.cap).slice(0, 20);
  const rows = [];
  for (const r of pre) {
    let k; try { k = (await gt(`/networks/${net}/pools/${r.pool}/ohlcv/hour?limit=1000&currency=usd`)).data.attributes.ohlcv_list.map(([t, o, h, l, c, v]) => ({ t, h, l, c, v })).sort((a, b) => a.t - b.t); } catch (e) { continue; }
    if (k.length < 96) continue;
    const peak = Math.max(...k.map(x => x.h)), pk = k.findIndex(x => x.h === peak), last = k.at(-1).c, blocks = [];
    for (let j = k.length - 6 - 72; j < k.length - 6; j += 6) if (j >= 0) blocks.push(k.slice(j, j + 6).reduce((a, x) => a + x.v, 0));
    blocks.sort((a, b) => a - b);
    const med = blocks[Math.floor(blocks.length / 2)] || 0, v6 = k.slice(-6).reduce((a, x) => a + x.v, 0);
    const row = { ...r, drop: (1 - last / peak) * 100, peakAgo: (k.at(-1).t - k[pk].t) / 86400, newLow: Math.min(...k.slice(-24).map(x => x.l)) < Math.min(...k.slice(-96, -24).map(x => x.l)), volx: med ? v6 / med : 0 };
    row.checks = checks(row); row.failed = row.checks.map((c, i) => c[0] ? -1 : i).filter(i => i >= 0);
    rows.push(row);
  }
  return { rows, collected: pairs.length };
}
async function safety(r) {
  try {
    if (r.net === "solana") {
      const x = await getJson(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(r.tok)}/report/summary`, 2), risks = x.risks || [];
      const lock = x.lpLockedPct === undefined || x.lpLockedPct === null ? null : +x.lpLockedPct, danger = risks.filter(z => z.level === "danger").map(z => z.name);
      return { lock, danger, text: `RugCheck: ликвидность заблокирована ${lock === null ? "— нет данных" : `на ${Math.round(lock)}%`}${danger.length ? ", опасно: " + danger.join(", ") : ""}` };
    }
    const d = await getJson(`https://api.gopluslabs.io/api/v1/token_security/${GOPLUS[r.net]}?contract_addresses=${encodeURIComponent(r.tok)}`, 2), t = Object.values(d.result || {})[0];
    if (!t) return null;
    const lp = t.lp_holders || [], lock = lp.length ? lp.filter(h => String(h.is_locked) === "1" || BURN.test(h.address || "")).reduce((a, h) => a + (+h.percent || 0), 0) * 100 : null, danger = [];
    if (t.is_honeypot === "1") danger.push("honeypot"); if (+t.sell_tax > 0.1) danger.push(`налог на продажу ${Math.round(t.sell_tax * 100)}%`); if (t.cannot_sell_all === "1") danger.push("нельзя продать всё"); if (t.is_mintable === "1") danger.push("допечатка"); if (t.hidden_owner === "1") danger.push("скрытый владелец");
    return { lock, danger, text: `GoPlus: ликвидность заблокирована ${lock === null ? "— нет данных" : `на ${Math.round(lock)}%`}${danger.length ? ", опасно: " + danger.join(", ") : ""}` };
  } catch (e) { return null; }
}
async function send(text, silent) {
  if (DRY === "1" || !TOKEN || !CHAT) { console.log(`[без отправки${silent ? ", тихо" : ""}]\n${text}\n`); return; }
  for (let a = 1; a <= 4; a++) {
    try { const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true, disable_notification: !!silent }) }); if (r.ok) return; if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new Error(`Telegram ${r.status}`); } catch (e) { if (a === 4) throw e; }
    await sleep(a * 5000);
  }
}

if (TEST === "true") { await send("🐸 Пробное сообщение облачного сканера мемов. Если ты его видишь, уведомления работают."); process.exit(0); }
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {}, now = Date.now() / 1000;
for (const k of Object.keys(state)) if (now - state[k].at > 14 * 86400) delete state[k];
let sent = 0;
for (const net of NETS) {
  let res; try { res = await scanNet(net); } catch (e) { console.log(net, "не удалось:", e.message); continue; }
  const cand = res.rows.filter(r => r.failed.length <= 1);
  console.log(`${net}: собрано ${res.collected}, по свечам ${res.rows.length}, все условия ${cand.filter(r => !r.failed.length).length}, без одного ${cand.filter(r => r.failed.length === 1).length}`);
  for (const r of cand) {
    const key = `${net}:${r.tok}`, full = !r.failed.length, prev = state[key];
    /* Повтор не чаще раза в 48 ч; но если был «почти», а стал «все условия», сообщаем сразу. */
    if (prev && now - prev.at < REPEAT_H * 3600 && !(full && !prev.full)) continue;
    const s = await safety(r);
    if (!s || s.lock === null || s.lock < MIN_LOCK || s.danger.length) { console.log(`  ${r.base}: пропуск по ликвидности (${s ? s.text : "нет ответа"})`); continue; }
    const head = full ? `🐸 После слива · ${NET_NAME[net]} · все условия` : `🐸 Почти · ${NET_NAME[net]} · не хватает: ${KEYS[r.failed[0]]}`;
    const text = [head, `${r.base}: капа ${usd(r.cap)}, ликвидность ${usd(r.liq)}, объём за сутки ${usd(r.v24)}`, ...r.checks.map(([ok, t]) => `${ok ? "✓" : "✗"} ${t}`), s.text, `https://dexscreener.com/${net}/${r.pool}`, `Отметить и отслеживать: ${SITE} → Мемы. Это не сигнал на покупку.`].join("\n");
    await send(text, !full);
    state[key] = { at: now, full }; sent++;
  }
}
writeFileSync(STATE, JSON.stringify(state));
console.log("Отправлено сообщений:", sent);
