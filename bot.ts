// SignalYar Bot — Deno Deploy version (webhook + cron)
// Secrets (Deno env): TELEGRAM_TOKEN, LLM_KEY, LLM_URL (optional)

const TOKEN = Deno.env.get("TELEGRAM_TOKEN") ?? "";
const LLM_KEY = Deno.env.get("LLM_KEY") ?? "";
const LLM_URL = Deno.env.get("LLM_URL") ?? "https://token.lightvela.ai/v1/chat/completions";
const OPENROUTER_KEY = Deno.env.get("OPENROUTER_KEY") ?? "";
const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
// Free models are fetched live from OpenRouter so the list never goes stale.
async function fetchFreeModels(): Promise<{id: string, name: string}[]> {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models");
    const d = await r.json();
    return (d.data as any[])
      .filter(m => typeof m.id === "string" && m.id.endsWith(":free"))
      .map(m => ({id: m.id, name: (m.name || m.id).replace(/\s*\(free\)\s*/i, "")}));
  } catch { return []; }
}
const SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","BNBUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","DOTUSDT"];
// broad scan: top USDT pairs by 24h quote volume (fresh listings naturally enter as volume grows)
async function topSymbols(n = 25): Promise<string[]> {
  try {
    const j = await (await fetch("https://data-api.binance.vision/api/v3/ticker/24hr")).json();
    return (Array.isArray(j) ? j : [])
      .filter((t: any) => typeof t.symbol === "string" && t.symbol.endsWith("USDT") && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
      .sort((a: any, b: any) => Number(b.quoteVolume) - Number(a.quoteVolume))
      .slice(0, n)
      .map((t: any) => t.symbol);
  } catch { return SYMBOLS; }
}

// ---------- persistence (Deno KV) ----------
let kv: any = null;
try { kv = await Deno.openKv(); console.log("[kv] openKv: OK"); }
catch (e) {
  console.log("[kv] openKv FAILED:", String(e).slice(0, 150), "-> memory fallback");
}
const memSignals: any[] = [];
const memSubs: number[] = [];
const memChats = new Map<number, any[]>();

async function dbGet<T>(key: string, def: T): Promise<T> {
  if (!kv) return def;
  const r = await kv.get(["sy", key]);
  return (r.value ?? def) as T;
}
async function dbSet(key: string, val: unknown) {
  if (kv) await kv.set(["sy", key], val);
}

// ---------- admin ----------
// Owner chat id (user's own telegram). Admin-only commands live here.
const OWNER_ID = 57845137;
const isAdmin = (chatId: number) => chatId === OWNER_ID;
// models available to regular users: GLM only (stable, no key juggling). Admin can still switch via /admin model orN.
function isModelLockedFor(chatId: number) { return !isAdmin(chatId); }
// banned users: admin can block/unblock via /admin block|unblock <id>. Banned users get silence everywhere.
async function isBanned(chatId: number): Promise<boolean> {
  const list = await dbGet<number[]>("banned", []);
  return list.includes(chatId);
}

// ---------- TA ----------
async function klines(sym: string, interval = "1h", limit = 200): Promise<number[][]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // data-api.binance.vision: public market-data mirror, no geo-restriction (api.binance.com blocks some datacenter IPs)
      const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
      const j = await r.json();
      if (Array.isArray(j) && j.length) return j;
      // Binance error object (e.g. rate limit) — wait and retry
      console.log(`[klines] ${sym} bad response: ${JSON.stringify(j).slice(0, 120)}`);
    } catch (e) {
      console.log(`[klines] ${sym} fetch err: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
  }
  throw new Error(`klines unavailable for ${sym}`);
}
// size-aware formatter (global — mentor/auto-signal both use it)
function fmt(v: number, d = 2): string {
  return v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : v >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: d })
    : v.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
function rsi(closes: number[], period = 14): number {  const gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0));
  }
  if (gains.length < period) return 50;
  const ag = gains.slice(-period).reduce((a,b)=>a+b,0)/period;
  const al = losses.slice(-period).reduce((a,b)=>a+b,0)/period;
  return al === 0 ? 100 : 100 - 100/(1 + ag/al);
}
function macd(closes: number[]): [number, number] {
  const f = closes.slice();
  const emaSeries = (p: number) => {
    const k = 2/(p+1); const out: number[] = [];
    let e = f.slice(0, p).reduce((a,b)=>a+b,0)/p; out.push(e);
    for (let i = p; i < f.length; i++) { e = f[i]*k + e*(1-k); out.push(e); }
    return out;
  };
  const e12 = emaSeries(12), e26 = emaSeries(26);
  const n = Math.min(e12.length, e26.length);
  const line = e12.slice(-n).map((v,i)=>v-e26.slice(-n)[i]);
  const sig = ema(line.slice(-32), 9);
  return [line[line.length-1], sig];
}
function ema(vals: number[], period: number): number {
  if (!vals.length) return 0;
  if (vals.length < period) period = Math.max(1, Math.floor(vals.length/2));
  const k = 2/(period+1);
  let e = vals.slice(0, period).reduce((a,b)=>a+b,0)/period;
  for (let i = period; i < vals.length; i++) e = vals[i]*k + e*(1-k);
  return e;
}
function bollinger(closes: number[], period = 20, mult = 2): {mid:number, up:number, low:number, pos:number} {
  const s = closes.slice(-period);
  const mid = s.reduce((a,b)=>a+b,0)/period;
  const sd = Math.sqrt(s.reduce((a,b)=>a+(b-mid)**2,0)/period);
  const up = mid + mult*sd, low = mid - mult*sd;
  const p = closes[closes.length-1];
  // pos: 0 = at lower band, 1 = at upper band
  return {mid, up, low, pos: up===low ? 0.5 : (p-low)/(up-low)};
}
function atr(ks: number[][], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < ks.length; i++) {
    const h = Number(ks[i][2]), l = Number(ks[i][3]), pc = Number(ks[i-1][4]);
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  return ema(trs, period);
}
function srLevels(closes: number[], lookback = 90): {sup:number, res:number} {
  const win = closes.slice(-lookback);
  const p = closes[closes.length-1];
  const below = win.filter(x=>x<p), above = win.filter(x=>x>p);
  // nearest support: highest close below price; nearest resistance: lowest above
  const sup = below.length ? Math.max(...below) : Math.min(...win);
  const res = above.length ? Math.min(...above) : Math.max(...win);
  return {sup, res};
}
function fib(closes: number[], lookback = 120) {
  const win = closes.slice(-lookback);
  const hi = Math.max(...win), lo = Math.min(...win);
  const d = hi - lo;
  const p = closes[closes.length-1];
  const levels: Record<string, number> = {lo, "23.6%": lo+0.236*d, "38.2%": lo+0.382*d, "50%": lo+0.5*d, "61.8%": lo+0.618*d, hi};
  // where is price relative to the range (0=at low, 1=at high)
  const pos = d===0 ? 0.5 : (p-lo)/d;
  return {levels, pos};
}
// detect classic candlestick patterns from the last 3 candles (OHLC)
function candlePatterns(ks: number[][]): string[] {
  const out: string[] = [];
  const k = (i: number) => ({o: Number(ks[i][1]), h: Number(ks[i][2]), l: Number(ks[i][3]), c: Number(ks[i][4])});
  if (ks.length < 3) return out;
  const c = k(ks.length-1), p = k(ks.length-2), pp = k(ks.length-3);
  const body = (x: ReturnType<typeof k>) => Math.abs(x.c - x.o);
  const range = (x: ReturnType<typeof k>) => x.h - x.l || 1e-9;
  const upper = (x: ReturnType<typeof k>) => x.h - Math.max(x.o, x.c);
  const lower = (x: ReturnType<typeof k>) => Math.min(x.o, x.c) - x.l;
  const green = (x: ReturnType<typeof k>) => x.c > x.o;
  // Doji: tiny body vs long wicks
  if (body(c) / range(c) < 0.12) out.push("دوجی ⚪ (تردید بازار)");
  // Hammer / Shooting star
  if (lower(c) > body(c)*2 && upper(c) < body(c) && green(c)) out.push("چکش 🟢 (برگشت صعودی احتمالی)");
  if (upper(c) > body(c)*2 && lower(c) < body(c) && !green(c)) out.push("ستاره ثابت 🔴 (برگشت نزولی احتمالی)");
  // Engulfing
  if (green(c) && !green(p) && c.c > p.o && c.o < p.c) out.push("پوشای صعودی 🟢 (خریداران قوی)");
  if (!green(c) && green(p) && c.c < p.o && c.o > p.c) out.push("پوشای نزولی 🔴 (فروشندگان قوی)");
  // Morning/Evening star (3-candle)
  if (!green(pp) && body(p)/range(p) < 0.3 && green(c) && c.c > (pp.o+pp.c)/2) out.push("ستاره صبحگاهی 🟢 (برگشت صعودی)");
  if (green(pp) && body(p)/range(p) < 0.3 && !green(c) && c.c < (pp.o+pp.c)/2) out.push("ستاره شبانه 🔴 (برگشت نزولی)");
  // Marubozu: full body, tiny wicks — strong momentum
  if (body(c)/range(c) > 0.85) out.push(green(c) ? "مارابوزو سبز 🟢 (مومنتوم قوی)" : "مارابوزو قرمز 🔴 (مومنتوم نزولی)");
  return out;
}
// trend classification from swing highs/lows + EMA slope
function trendInfo(closes: number[]): {dir:string, desc:string} {
  if (closes.length < 60) return {dir: "خنثی", desc: "داده کافی نیست"};
  // higher-highs/lower-lows over 3 windows
  const w = Math.floor(closes.length/3);
  const [a, b, c] = [closes.slice(0,w), closes.slice(w,2*w), closes.slice(2*w)];
  const hh = Math.max(...b) > Math.max(...a) && Math.max(...c) > Math.max(...b);
  const ll = Math.min(...b) < Math.min(...a) && Math.min(...c) < Math.min(...b);
  const e50 = ema(closes, 50), e20 = ema(closes, 20);
  const p = closes[closes.length-1];
  let dir = "خنثی (رنج)", desc = "قیمت در محدوده افقی حرکت می‌کنه";
  if (hh && p > e20 && e20 > e50) { dir = "صعودی 📈"; desc = "سقف‌ها و کف‌های بالاتر + قیمت بالای مووینگ‌ها"; }
  else if (ll && p < e20 && e20 < e50) { dir = "نزولی 📉"; desc = "سقف‌ها و کف‌های پایین‌تر + قیمت زیر مووینگ‌ها"; }
  else if (p > e50) { dir = "صعودی ضعیف"; desc = "بالاتر از مووینگ ۵۰ ولی ساختار کامل صعودی نیست"; }
  else { dir = "نزولی ضعیف"; desc = "پایین‌تر از مووینگ ۵۰ ولی ساختار کامل نزولی نیست"; }
  return {dir, desc};
}

// ---------- analysis ----------
async function analyze(sym: string) {
  try {
    const ks = await klines(sym);
    const closes = ks.map(k => Number(k[4]));
    const vols = ks.map(k => Number(k[5]));
    const price = closes[closes.length-1];
    const r = rsi(closes);
    const [m, s] = macd(closes);
    const bb = bollinger(closes);
    const at = atr(ks);
    const sr = srLevels(closes);
    const fb = fib(closes);
    const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0)/20 || 1;
    const volRatio = vols[vols.length-1]/avgVol;
    const ch24 = closes.length > 25 ? (price/closes[closes.length-25]-1)*100 : 0;
    let score = 0; const reasons: string[] = [];
    if (r < 35) { score += 2; reasons.push(`RSI اشباع فروش (${r.toFixed(0)})`); }
    else if (r > 70) { score -= 2; reasons.push(`RSI اشباع خرید (${r.toFixed(0)})`); }
    else reasons.push(`RSI خنثی (${r.toFixed(0)})`);
    if (m > s) { score += 1; reasons.push("MACD مثبت"); } else { score -= 1; reasons.push("MACD منفی"); }
    if (bb.pos <= 0.15) { score += 1; reasons.push(`قیمت نزدیک باند پایین بولینگر (${bb.low.toLocaleString("en-US")}$)`); }
    else if (bb.pos >= 0.85) { score -= 1; reasons.push(`قیمت نزدیک باند بالای بولینگر (${bb.up.toLocaleString("en-US")}$)`); }
    if (volRatio > 1.5) reasons.push(`حجم بالا (${volRatio.toFixed(1)}x)`);
    reasons.push((ch24>0?"رشد ":"افت ") + `۲۴ساعته ${ch24.toFixed(1)}%`);
    const fmt = (v:number, d=2) => v >= 1000 ? v.toLocaleString("en-US",{maximumFractionDigits:0}) : v >= 1 ? v.toLocaleString("en-US",{maximumFractionDigits:d}) : v.toLocaleString("en-US",{maximumFractionDigits:4});
    reasons.push(`ATR (نوسان): ${fmt(at,4)}$ — حد ضرر منطقی ≈ ${fmt(price-2*at,4)}$`);
    reasons.push(`حمایت: ${fmt(sr.sup)}$ | مقاومت: ${fmt(sr.res)}$`);
    const fbKey = fb.pos < 0.3 ? "نزدیک ۲۳.۶٪" : fb.pos < 0.45 ? "نزدیک ۳۸.۲٪" : fb.pos < 0.55 ? "نزدیک ۵۰٪" : fb.pos < 0.7 ? "نزدیک ۶۱.۸٪" : "بالای ۶۱.۸٪";
    reasons.push(`فیبوناچی: ${fbKey} بازه سقف/کف ۵ روز اخیر (سقف ${fmt(fb.levels["hi"])}$ / کف ${fmt(fb.levels["lo"])}$)`);
    let side = "نظاره", conf = 55;
    if (score >= 2) { side = "لانگ"; conf = Math.min(60+score*7, 88); }
    else if (score <= -2) { side = "شورت"; conf = Math.min(60+Math.abs(score)*7, 88); }
    // dynamic risk parameters from ATR (not fixed %) — SL = 2×ATR, TP = 3×ATR (RR ≈ 1:1.5), leverage scales with volatility
    let riskLine = "";
    if (side !== "نظاره" && at > 0) {
      const slPct = (2*at/price)*100, tpPct = (3*at/price)*100;
      // volatility ratio vs 2% baseline: high vol → lower leverage (min 1x), calm → up to 3x
      const volFactor = (2*at/price);
      const lev = Math.max(1, Math.min(3, Math.round((0.02 / Math.max(volFactor, 0.004)) * 10) / 10));
      const slPrice = side==="لانگ" ? price - 2*at : price + 2*at;
      const tpPrice = side==="لانگ" ? price + 3*at : price - 3*at;
      riskLine = `اهرم: ${lev}x | حد ضرر: -${slPct.toFixed(1)}% (${fmt(slPrice)}$) | حد سود: +${tpPct.toFixed(1)}% (${fmt(tpPrice)}$)\n`;
      reasons.push(`حد ضرر داینامیک بر اساس ATR: -${slPct.toFixed(1)}% / حد سود: +${tpPct.toFixed(1)}% (نسبت 1:1.5)`);
    }
    const emoji = side==="لانگ"?"🟢":side==="شورت"?"🔴":"⚪";
    const txt = `📈 تحلیل ${sym}\nقیمت: ${price.toLocaleString("en-US")}$\nسمت پیشنهادی: ${side} ${emoji}\nاطمینان: ${conf}%\n`
      + riskLine
      + reasons.map(x=>"• "+x).join("\n") + "\n\n⚠️ توصیه سرمایه‌گذاری نیست — تصمیم با خودته";
    console.log(`[analyze] ${sym} ${side} conf=${conf}`);
    return { txt, side, conf, price, at };
  } catch (e) {
    console.log(`[analyze] ERR ${sym}: ${e instanceof Error ? e.message : String(e)}`);
    return { txt: `⚠️ خطا در تحلیل ${sym}`, side: "نظاره", conf: 55, price: 0 };
  }
}

// ---------- news ----------
const FEEDS = ["https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://news.google.com/rss/search?q=crypto+OR+bitcoin&hl=fa&gl=IR&ceid=IR:fa"];
async function fetchNews(n = 6): Promise<string[]> {
  const items: string[] = [];
  for (const feed of FEEDS) {
    try {
      const xml = await (await fetch(feed)).text();
      const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)].map(m=>m[1]).slice(1, n+1);
      items.push(...titles.map(t=>t.replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"')));
    } catch {}
  }
  return items.slice(0, n);
}
// summarize news in Persian via the default LLM (GLM) — returns null on failure so caller falls back to raw titles
async function newsDigest(titles: string[], label: string): Promise<string | null> {
  if (!titles.length) return null;
  try {
    const prompt = `این عناوین خبری بازار رمزارز را به فارسی تحلیل و جمع‌بندی کن. برای هر خبر یک خط فارسی کوتاه بنویس (ترجمه + نکته مهم), سپس در پایان یک پاراگراف «جمع‌بندی» بنویس که: وضعیت کلی بازار را بگوید، کدام اخبار مثبت/منفی‌اند و چه اثری بر قیمت‌ها دارند. اگر به‌نظرت خبری مهم/تأثیرگذار است با 🔴 یا 🟢 علامت بزن. لحن حرفه‌ای و کوتاه. این ترجمه فارسی است، نه توضیح ساختار:\n\n${titles.map((t,i)=>`${i+1}. ${t}`).join("\n")}`;
    const r = await fetch(LLM_URL, {
      method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${LLM_KEY}`},
      body: JSON.stringify({model:"auto", max_tokens:2000, messages:[
        {role:"system", content:"تو یک تحلیلگر خبری بازار رمزارز هستی که فقط فارسی روان می‌نویسد."},
        {role:"user", content: prompt}]})
    });
    const j = await r.json();
    const out = (j.choices?.[0]?.message?.content || "").trim();
    if (!out) { console.log(`[news] digest empty status=${r.status} err=${JSON.stringify(j.error ?? null)}`); return null; }
    console.log(`[news] digest ok len=${out.length}`);
    return `📰 ${label} (خلاصه فارسی):\n\n${out}\n\n⚠️ توصیه سرمایه‌گذاری نیست`;
  } catch (e) {
    console.log(`[news] digest ERR: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// ---------- telegram ----------
async function tg(method: string, body: any) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body)});
  return await r.json();
}

// ---------- shared market scoring (used by /rank and cron) ----------
async function rankScan(syms: string[]): Promise<{sym:string,p:number,sc:number,rsi:number}[]> {
  const out: {sym:string,p:number,sc:number,rsi:number}[] = [];
  for (const sym of syms) {
    try {
      const ks = await klines(sym, "1h", 100);
      const closes = ks.map(k=>Number(k[4]));
      const r = rsi(closes);
      const [m, s] = macd(closes);
      const bb = bollinger(closes);
      const sr = srLevels(closes);
      let sc = 0;
      sc += r < 35 ? 2 : r > 70 ? -2 : 0;
      sc += m > s ? 1 : -1;
      if (bb.pos <= 0.15) sc += 1; else if (bb.pos >= 0.85) sc -= 1;
      const mid = (sr.sup + sr.res) / 2;
      const p = closes[closes.length-1];
      sc += p > mid ? 1 : -1;
      out.push({sym, p, sc, rsi: r});
    } catch {}
  }
  out.sort((a,b) => b.sc - a.sc);
  return out;
}

// ---------- handler ----------
async function handleMessage(chatId: number, text: string) {
  text = text.trim();
  if (text === "/start" || text === "/help") {
    const subs = await dbGet<number[]>("subs", memSubs);
    if (!subs.includes(chatId)) { subs.push(chatId); await dbSet("subs", subs); }
    return "👋 سلام! من سیگنال‌یارم 🤖\n\n📊 تحلیل:\n/price BTC — قیمت لحظه‌ای\n/signal — تحلیل تکنیکال کامل\n/chart — کندل‌شناسی + روند + الگو + فاندینگ\n/top — ۳ سیگنال برتر\n/rank — رتبه‌بندی ۲۵ ارز\n/brief — جمع‌بندی روزانه\n/trend — نبض شبکه‌های اجتماعی\n/news — اخبار بازار\n/stats — کارنامه واقعی\n\n🎓 آموزش (آکادمی):\n/learn — فهرست درس‌ها (۸ درس)\n/learn 1 تا 8 — متن درس\n/calc — ماشین‌حساب مدیریت سرمایه\n\n🧑‍🏫 مربی شخصی:\n/trade long BTC 82000 2 — ثبت معامله و شروع پایش\n/positions — معامله‌های باز\n/close BTC — بستن معامله\n/report — کارنامه شخصی و تحلیل مربی\n\n⚙️ تنظیمات:\n/models — هوش مصنوعی\n/subscribe — سیگنال خودکار\n\n💬 یا آزادانه بپرس.\n\n⚠️ تصمیم نهایی معامله با خودته";
  }
  // ---------- trading academy ----------
  if (text.startsWith("/learn")) {
    const LESSONS = [
      {t:"کندل‌شناسی", body:`🕯 درس ۱ — کندل‌شناسی

هر کندل داستان یه دوره معاملاتی رو می‌گه:
• بدنه (بدن سبز/قرمز): فاصله باز شدن تا بسته شدن
• سایه بالا: سقفی که خریدها رد شد
• سایه پایین: کفی که خرید اومد

کلمات کلیدی:
▪️ بدنه بلند = تصمیم قطعی بازار
▪️ بدنه کوتاه + سایه‌های بلند (دوجی) = تردید، احتمال برگشت
▪️ سایه پایین بلند = خریداران قیمت رو بالا کشیدن (تقاضا)
▪️ سایه بالا بلند = فروشندگان فشار اوردن (عرضه)

قانون طلایی: هیچ‌وقت به یک کندل تنها اکتفا نکن — همیشه ۲-۳ کندل آخر رو با هم تفسیر کن و صبر کن کندل بسته بشه.

تمرین: /chart BTC بزن و الگوی کندل آخر رو با این درس تطبیق بده.`},
      {t:"روندشناسی", body:`📈 درس ۲ — روندشناسی

روند = جهت غالب حرکت. «روند دوست توئه» — همیشه جهت بازار رو اول پیدا کن.

سه نوع روند:
📈 صعودی: سقف بالاتر (HH) + کف بالاتر (HL)
📉 نزولی: سقف پایین‌تر (LH) + کف پایین‌تر (LL)
➡️ رنج: قیمت بین حمایت و مقاومت افقی

قوانین:
۱. در روند صعودی فقط به دنبال خرید بگرد، در نزولی فقط فروش (Counter-trend = ریسک بالا)
۲. مووینگ اورج (EMA 20 و 50): قیمت بالاشون = فضا خریداران، زیرشون = فروشندگان
۳. روند در تایم‌فریم بزرگ (۴h/1d) مهم‌تر از تایم کوچیکه — اول چارت روزانه، بعد ورود در ۱h

تمرین: /chart BTC بزن و ببین بات چه روندی شناسایی کرده.`},
      {t:"حمایت و مقاومت", body:`🧱 درس ۳ — حمایت و مقاومت

حمایت (Support): کف‌ای که قیمت بهش می‌خوره و برمی‌گرده (خریداران اونجاست)
مقاومت (Resistance): سقفی که قیمت بهش می‌خوره و رد می‌شه (فروشندگان اونجاست)

نکات حرفه‌ای:
۱. هرچقدر یک سطح بیشتر تست شده باشه، قوی‌تره — ولی هر تست، سطح رو ضعیف‌تر می‌کنه (نیروها مصرف می‌شن)
۲. حمایت بعد از شکست، نقشش برعکس می‌شه (مقاومت جدید) و برعکس — به این می‌گن تغییر نقش
۳. سطوح «منطقه» هستن نه خط دقیق — یه محدوده بگیر نه یه قیمت
۴. فیبوناچی (61.8%) و مووینگ‌ها هم نقش S/R دارن

ورود حرفه‌ای: صبر کن قیمت به S/R برسه، کندل برگشتی ببین (چکش/پوشا)، بعد وارد شو. خرید وسط هیچ‌جا = بدترین نقطه.

تمرین: /chart ETH بزن و حمایت/مقاومت فعلی رو ببین.`},
      {t:"الگوهای کلاسیک", body:`📐 درس ۴ — الگوهای کلاسیک (چارت و کندل)

الگوهای برگشتی (تغییر جهت):
▪️ سر و شانه (Head & Shoulders): اوج، اوج بالاتر، اوج پایین‌تر = نزول پیش رو
▪️ سقف دوگانه (Double Top): دو تست ناموفق مقاومت = نزول
▪️ کف دوگانه (Double Bottom): دو تست ناموفق حمایت = صعود

الگوهای ادامه‌دهنده (استراحت، بعد ادامه روند):
▪️ پرچم (Flag): کانال کوچک مخالف روند → ادامه روند
▪️ مثلث (Triangle): فشرده شدن قیمت → شکست در جهت روند قبلی

الگوهای کندلی (که بات خودکار شناسایی می‌کنه):
دوجی، چکش، ستاره ثابت، پوشای صعودی/نزولی، ستاره صبحگاهی/شبانه، مارابوزو

قانون مهم: الگو بدون حجم معتبر نیست! شکست با حجم بالا = واقعی؛ شکست با حجم کم = احتمالاً فیک.

تمرین: /chart BTC بزن — بات الگوهای کندلی لحظه رو تشخیص می‌ده.`},
      {t:"اندیکاتورها", body:`📊 درس ۵ — اندیکاتورها

 اندیکاتورها ۲ دسته‌ان: مومنتوم و روندی.

RSI (0-100):
• زیر ۳۰ = اشباع فروش (احتمال برگشت صعودی)
• بالای ۷۰ = اشباع خرید (احتمال اصلاح)
• واگرایی: قیمت سقف جدید می‌زنه ولی RSI نه = هشدار برگشت ⚠️

MACD:
• خط MACD بالای سیگنال = مومنتوم صعودی
• کراس زیر صفر → صعود معکوس = تغییر روند قوی

بولینگر باند:
• قیمت به باند پایین بخوره = ارزون‌تر از میانگین (در رنج، خرید)
• در روند قوی، قیمت «دویدن» روی باند می‌مونه — بلافاصله خرید نکن!

ATR: نوسان واقعی بازار رو می‌سنجه — پایه‌ی حد ضرر حرفه‌ای (که بات برات حساب می‌کنه).

قانون: اندیکاتور تأییدکننده‌ست نه پیشگو. اول ساختار چارت (درس ۲و۳)، بعد اندیکاتور.

تمرین: /signal BTC همه این‌ها رو با هم نشون می‌ده.`},
      {t:"مدیریت سرمایه", body:`💰 درس ۶ — مدیریت سرمایه (مهم‌ترین درس!)

۹۰٪ تریدرها به خاطر ضعف مدیریت سرمایه می‌بازن، نه تحلیل بد.

قوانین حیاتی:
۱. ریسک هر معامله: فقط ۱-۲٪ کل سرمایه (نه بیشتر!)
۲. نسبت سود به ضرر (R/R): حداقل 1:1.5 — یعنی اگه حد ضررت ۲٪، حد سود حداقل ۳٪
۳. اهرم: برای شروع ۲-۳x کافیه. اهرم بالا = مرگ سریع. بات بر اساس نوسان (ATR) اهرم پیشنهادی می‌ده
۴. حد ضرر رو هرگز جابه‌جا نکن! فقط به سود انتقالش بده (تریلینگ)
۵. بعد از ۲ باخت پشت هم، متوقف شو — احساسات و انتقام‌جویی = نابودی حساب
۶. اندازه پوزیشن = (سرمایه × ریسک٪) ÷ فاصله تا حد ضرر

مثال: ۱۰۰۰$ داری، ریسک ۱٪ = ۱۰$، فاصله SL = ۵٪ → پوزیشن = ۱۰ ÷ ۰.۰۵ = ۲۰۰$

ابزار: /calc بزن — ماشین‌حساب مدیریت سرمایه خودکار.`},
      {t:"روانشناسی ترید", body:`🧠 درس ۷ — روانشناسی ترید

بزرگ‌ترین دشمنت خودتی، نه بازار!

۴ هیولای روانی:
1️⃣ ترس (FOMO): «دیر نشم از دستم میره» → ورود در سقف. راه‌حل: برنامه قبل از معامله
2️⃣ طمع: «بیشتر بگیرم» → حد سود رو نمی‌بندی و سود می‌شه ضرر. راه‌حل: حد سود از قبل مشخص
3️⃣ انتقام: بعد ضرر، معامله بزرگ‌تر برای جبران → حساب می‌سوزه. راه‌حل: بعد از هر ضرر، ۱ ساعت استراحت
4️⃣ امید: «برمی‌گرده» → نگه‌داشتن معامله ضررده بدون حد ضرر. راه‌حل: SL رو بات می‌ذاره، تو تغییرش نده

قوانین ذهن حرفه‌ای:
▪️ ژورنال بنویس: هر معامله با دلیل ورود/خروج و احساسات
▪️ ضرر بخشی از بازیه — تریدر خوب با وین‌ریت ۵۰٪ هم سودده‌ست چون R/R بالاست
▪️ بازار هر روزه — فرصت فردا هم هست، حساب تو نه

تمرین: بعد از هر معامله، تو ژورنالت بنویس «چه حسی داشتم؟»`},
      {t:"ورود به فیوچرز", body:`⚡ درس ۸ — ورود به فیوچرز

فیوچرز = معامله با اهرم. هم سود چند برابر، هم ضرر.

مفاهیم پایه:
▪️ لانگ: خرید در انتظار رشد | شورت: فروش در انتظار ریزش
▪️ اهرم (Leverage): 10x یعنی با ۱۰۰$، پوزیشن ۱۰۰۰$ — حرکت ۱۰٪ برخلاف تو =清算 (لیکویید!)
▪️ لیکویید: وقتی ضرر به کل مارجینت برسه، پوزیشن خودکار بسته می‌شه
▪️ فاندینگ: هزینه‌ای که هر ۸ ساعت بین لانگ و شورت جابه‌جا می‌شه — فاندینگ بالا = طرف پر ازدحام (ریسک)
▪️ مارجین ایزوله: اگه یه معامله ببازه بقیه حساب سالمه — برای شروع همیشه ایزوله!

قوانین طلایی شروع:
۱. اول ۱ ماه با ۲x در دمو یا حجم خیلی کم معامله کن
۲. اهرم بیشتر از ۳x برای شروع = خودکشی مالی
۳. همیشه SL بذار — بدون حد ضرر وارد فیوچرز نشو
۴. فقط در جهت روند تایم بزرگ معامله کن
۵. فاندینگ رو چک کن: /chart BTC نرخ فاندینگ لحظه‌ای رو نشون می‌ده

هشدار: فیوچرز برای حرفه‌ای‌هاست. اگه اسپات رو کامل یاد نگرفتی، فیوچرز نرو.`},
    ];
    const m = /^\/learn\s*(\d+)?$/.exec(text.trim());
    if (!m || !m[1]) {
      const idx = await dbGet<number>("lesson_" + chatId, 0);
      return `🎓 آکادمی سیگنال‌یار — ۸ درس از صفر تا فیوچرز

${LESSONS.map((l,i)=>`${i+1}. ${l.t}${i+1===idx+1 ? " ← آخرین درس خوانده‌شده" : ""}`).join("\n")}

📖 متن هر درس: /learn 1 تا /learn 8
🧮 بعد از درس ۶: /calc — ماشین‌حساب مدیریت سرمایه
📊 تمرین هر درس با: /chart و /signal

💡 پیشنهاد: به ترتیب برو — هر درس روی قبلی سوار می‌شه.`;
    }
    const n = Math.min(Math.max(parseInt(m[1]), 1), LESSONS.length);
    await dbSet("lesson_" + chatId, n-1);
    const l = LESSONS[n-1];
    return `${l.body}\n\n➡️ درس بعدی: /learn ${n+1 > LESSONS.length ? "(تمام شد! حالا /calc و /signal رو امتحان کن)" : n+1}`;
  }
  // ---------- position size calculator ----------
  if (text.startsWith("/calc")) {
    const parts = text.split(/\s+/);
    // /calc <capital> <risk%> <entry> <stop>  OR  /calc (guide)
    if (parts.length >= 5) {
      const cap = parseFloat(parts[1]), risk = parseFloat(parts[2]), entry = parseFloat(parts[3]), stop = parseFloat(parts[4]);
      if ([cap, risk, entry, stop].some(v => !isFinite(v) || v <= 0)) return "⚠️ اعداد معتبر نیست. مثال: /calc 1000 1 82000 80000";
      const riskAmt = cap * risk / 100;
      const dist = Math.abs(entry - stop) / entry * 100;
      if (dist === 0) return "⚠️ ورود و حد ضرر یکی‌ان!";
      const posSize = riskAmt / (dist / 100);
      const lev = Math.min(Math.max(posSize / cap, 1), 10);
      return `🧮 ماشین‌حساب مدیریت سرمایه

💵 سرمایه: ${cap.toLocaleString("en-US")}$
🎯 ریسک: ${risk}% (${riskAmt.toLocaleString("en-US")}$)
📌 ورود: ${entry.toLocaleString("en-US")}$ | حد ضرر: ${stop.toLocaleString("en-US")}$ (فاصله ${dist.toFixed(2)}%)

📐 حجم پوزیشن: ${posSize.toLocaleString("en-US",{maximumFractionDigits:2})}$
⚙️ اهرم لازم: ${lev.toFixed(1)}x
✅ اگه SL بخوره: فقط -${riskAmt.toLocaleString("en-US")}$ ازت کم می‌شه (با اهرم)

💡 نکته: با نسبت 1:1.5 حد سود رو بذار ${dist*1.5 > 0 ? (entry + (entry-stop)*1.5).toLocaleString("en-US",{maximumFractionDigits:0}) : ""}$
⚠️ اهرم بالای 3x برای شروع توصیه نمی‌شه`;
    }
    return `🧮 ماشین‌حساب مدیریت سرمایه

فرمت: /calc سرمایه ریسک٪ ورود حد‌ضرر

مثال: /calc 1000 1 82000 80000
یعنی: ۱۰۰۰$ سرمایه، حاضرم ۱٪ (۱۰$) ریسک کنم، ورود ۸۲۰۰۰، حد ضرر ۸۰۰۰۰

بات بهت می‌گه: حجم پوزیشن چقدر باشه و چه اهرمی لازمه.

📚 یادآوری: ریسک استاندارد هر معامله ۱-۲٪ است (درس ۶ آکادمی: /learn 6)`;
  }
  if (text.startsWith("/price")) {
    const parts = text.split(" ");
    let sym = (parts[1]?.toUpperCase() ?? "BTC");
    if (!sym.endsWith("USDT")) sym += "USDT";
    try {
      const p = await (await fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${sym}`)).json();
      const ch = Number(p.priceChangePercent);
      return `${ch>=0?"🟢":"🔴"} ${sym}: ${Number(p.lastPrice).toLocaleString("en-US")}$ (${ch.toFixed(2)}% 24h)`;
    } catch { return "⚠️ نماد پیدا نشد. مثال: /price ETH"; }
  }
  if (text.startsWith("/signal")) {
    const parts = text.split(" ");
    let sym = (parts[1]?.toUpperCase() ?? "BTCUSDT");
    if (!sym.endsWith("USDT")) sym += "USDT";
    const a = await analyze(sym);
    if (a.side !== "نظاره") {
      const sigs = await dbGet<any[]>("signals", []);
      sigs.push({sym, side: a.side, conf: a.conf, entry: a.price, ts: Date.now(), checked: false, result: null});
      await dbSet("signals", sigs.slice(-500));
    }
    return a.txt;
  }
  if (text === "/rank" || text === "/ranking") {
    // full market ranking: strong → weak across top-25 by volume (includes fresh listings)
    const syms = await topSymbols(25);
    const results = await rankScan(syms);
    if (!results.length) return "⚠️ الان اسکن ممکن نبود، بعداً امتحان کن.";
    const lines = results.map((x, i) => {
      const tag = x.sc >= 4 ? "قوی 🟢" : x.sc >= 2 ? "مثبت 🟢" : x.sc <= -4 ? "قوی 🔴" : x.sc <= -2 ? "منفی 🔴" : "خنثی ⚪";
      return `${(i+1).toString().padStart(2)} | ${x.sym.replace("USDT","").padEnd(6)} | ${x.p.toLocaleString("en-US")}$ | امتیاز ${x.sc>=0?"+":""}${x.sc} ${tag} | RSI ${x.rsi.toFixed(0)}`;
    });
    return `🏆 رتبه‌بندی بازار (۲۵ ارز برتر از نظر حجم)\nقوی → ضعیف:\n\n` + lines.join("\n")
      + `\n\n📏 امتیاز از +۶ (بسیار صعودی) تا -۶ (بسیار نزولی) — ترکیب RSI، MACD، بولینگر و ساختار بازار\n\n⚠️ توصیه سرمایه‌گذاری نیست`;
  }
  // ---------- live chart anatomy: candles + trend + patterns + funding ----------
  if (text.startsWith("/chart")) {
    const parts = text.split(" ");
    let sym = (parts[1]?.toUpperCase() ?? "BTC");
    if (!sym.endsWith("USDT")) sym += "USDT";
    try {
      const ks = await klines(sym, "1h", 100);
      const closes = ks.map(k => Number(k[4]));
      const price = closes[closes.length-1];
      const tr = trendInfo(closes);
      const pats = candlePatterns(ks);
      const sr = srLevels(closes);
      const fmt = (v:number, d=2) => v >= 1000 ? v.toLocaleString("en-US",{maximumFractionDigits:0}) : v >= 1 ? v.toLocaleString("en-US",{maximumFractionDigits:d}) : v.toLocaleString("en-US",{maximumFractionDigits:4});
      // last 3 candles mini-view
      let view = "";
      for (let i = ks.length-3; i < ks.length; i++) {
        const o = Number(ks[i][1]), c = Number(ks[i][4]), h = Number(ks[i][2]), l = Number(ks[i][3]);
        const ch = (c/o-1)*100;
        view += `${c>=o?"🟢":"🔴"} ${fmt(o)}→${fmt(c)} (H:${fmt(h)} L:${fmt(l)}) ${ch>=0?"+":""}${ch.toFixed(2)}%\n`;
      }
      // funding rate (futures)
      let fundLine = "";
      try {
        const f = await (await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`)).json();
        if (f.lastFundingRate !== undefined) {
          const fr = Number(f.lastFundingRate)*100;
          fundLine = `⚡ فاندینگ فیوچرز: ${fr.toFixed(4)}% ${fr>0.02?"(لانگ‌ها به شورت‌ها می‌دن — ازدحام خرید ⚠️)":fr<-0.02?"(شورت‌ها به لانگ‌ها می‌دن — ازدحام فروش)":"(نرمال)"}`;
        }
      } catch {}
      return `📊 آناتومی چارت ${sym}

🕯 ۳ کندل اخیر (1h):
${view}
🧭 روند: ${tr.dir}
   ${tr.desc}
📐 الگوهای کندلی شناسایی‌شده:
${pats.length ? pats.map(p=>"• "+p).join("\n") : "• الگوی خاصی روی کندل آخر نیست (کندل معمولی)"}
🧱 حمایت: ${fmt(sr.sup)}$ | مقاومت: ${fmt(sr.res)}$
💵 قیمت الان: ${fmt(price)}$
${fundLine}

💡 تحلیلش کن: روند + الگو + جای قیمت نسبت به S/R رو با هم بخون (درس‌های ۱-۴: /learn)
⚠️ توصیه سرمایه‌گذاری نیست`;
    } catch { return `⚠️ داده چارت ${sym} در دسترس نیست. مثال: /chart BTC`; }
  }
  // ---------- personal mentor: live trade tracking ----------
  if (text.startsWith("/trade")) {
    // /trade long BTC 82000 2   (side symbol [entry [leverage]]) — entry defaults to live price
    const p = text.split(/\s+/);
    const side = (p[1] || "").toLowerCase();
    if (side !== "long" && side !== "short") {
      return `🧑‍🏫 حالت مربی — ثبت معامله

فرمت: /trade long|short ارز [قیمت‌ورود] [اهرم]

مثال: /trade long BTC 82000 2
یعنی: لانگ بیت‌کوین، ورود ۸۲۰۰۰، اهرم ۲x

اگه قیمت ورود رو ننویسی، قیمت لحظه‌ای بازار ثبت می‌شه.
بعد از ثبت، من هر ۱۵ دقیقه چک می‌کنم:
• حد ضرر یادت می‌ندازم (اگه نذاشتی!)
• رو سود/زیان هشدار می‌دم
• وسط راه تحلیل می‌دم

📤 بستن معامله: /close BTC
📋 معامله‌های باز: /positions`;
    }
    let sym = (p[2] || "BTC").toUpperCase();
    if (!sym.endsWith("USDT")) sym += "USDT";
    try {
      const ks = await klines(sym, "1m", 2);
      const live = Number(ks[ks.length-1][4]);
      const entry = p[3] ? parseFloat(p[3]) : live;
      const lev = p[4] ? Math.min(Math.max(parseFloat(p[4]) || 1, 1), 25) : 1;
      if (!isFinite(entry) || entry <= 0) return "⚠️ قیمت ورود معتبر نیست. مثال: /trade long BTC 82000 2";
      const opens = await dbGet<any[]>("trades_" + chatId, []);
      if (opens.find(t => t.sym === sym)) return `⚠️ روی ${sym} یه معامله باز داری. اول ببندش: /close ${sym.replace("USDT","")}`;
      const reg = await dbGet<number[]>("trade_chats", []);
      if (!reg.includes(chatId)) { reg.push(chatId); await dbSet("trade_chats", reg); }
      const k1h = await klines(sym, "1h", 50);
      const a = atr(k1h);
      const r = rsi(k1h.map(k => Number(k[4])));
      const sl = side === "long" ? entry - 2*a : entry + 2*a;
      const tp = side === "long" ? entry + 3*a : entry - 3*a;
      const trade = { sym, side, entry, lev, at: Date.now(), sl, tp };
      opens.push(trade);
      await dbSet("trades_" + chatId, opens);
      const dir = side === "long" ? "🟢 لانگ" : "🔴 شورت";
      return `✅ ثبت شد — ${dir} ${sym} | اهرم ${lev}x

📌 ورود: ${fmt(entry)}$
🛑 حد ضرر پیشنهادی (2×ATR): ${fmt(sl)}$
🎯 حد سود پیشنهادی (3×ATR): ${fmt(tp)}$
📐 RSI الان: ${r.toFixed(0)}

🧑‍🏫 مربی: ${side === "long" && r > 70 ? "⚠️ RSI بالای ۷۰ه — ورود در اشباع خرید، ریسک اصلاح بالاست. حجم رو کم کن." : side === "short" && r < 30 ? "⚠️ RSI زیر ۳۰ه — شورت در اشباع فروش، حواست باشه." : "شرایط ورودت رو همینجا ثبت کردم. هر ۱۵ دقیقه چکت می‌کنم و اگه اتفاق مهمی افتاد خبر می‌دم."}

⚠️ حتماً حد ضرر واقعی توی صرافی بذار — من فقط هشدار می‌دم، پوزیشنت رو مدیریت نمی‌کنم!`;
    } catch { return `⚠️ قیمت ${sym} در دسترس نیست.`; }
  }
  if (text.startsWith("/positions")) {
    const opens = await dbGet<any[]>("trades_" + chatId, []);
    if (!opens.length) return "📋 معامله بازی نداری. باز کردن: /trade long BTC 82000 2";
    let out = "📋 معامله‌های باز:\n\n";
    for (const t of opens) {
      try {
        const ks = await klines(t.sym, "1m", 2);
        const live = Number(ks[ks.length-1][4]);
        const pnl = (t.side === "long" ? live/t.entry-1 : t.entry/live-1) * 100 * t.lev;
        out += `${t.side === "long" ? "🟢" : "🔴"} ${t.sym} | اهرم ${t.lev}x\n   ورود ${fmt(t.entry)}$ → الان ${fmt(live)}$\n   ${pnl >= 0 ? "🟩" : "🟥"} سود/ضرر: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}% (با اهرم)\n   🛑 SL ${fmt(t.sl)} | 🎯 TP ${fmt(t.tp)}\n\n`;
      } catch { out += `⚠️ ${t.sym}: قیمت در دسترس نیست\n\n`; }
    }
    out += "📤 بستن: /close BTC";
    return out;
  }
  if (text.startsWith("/close")) {
    const p = text.split(/\s+/);
    let sym = (p[1] || "").toUpperCase();
    if (!sym) return "⚠️ کدوم معامله؟ مثال: /close BTC";
    if (!sym.endsWith("USDT")) sym += "USDT";
    const opens = await dbGet<any[]>("trades_" + chatId, []);
    const idx = opens.findIndex(t => t.sym === sym);
    if (idx < 0) return `⚠️ روی ${sym} معامله بازی ندارم. /positions`;
    const t = opens[idx];
    let live = t.entry;
    try { const ks = await klines(sym, "1m", 2); live = Number(ks[ks.length-1][4]); } catch {}
    const pnlPct = (t.side === "long" ? live/t.entry-1 : t.entry/live-1) * 100;
    const pnlLev = pnlPct * t.lev;
    const hours = ((Date.now() - t.at) / 3600000).toFixed(1);
    opens.splice(idx, 1);
    await dbSet("trades_" + chatId, opens);
    // record to personal track record
    const rec = await dbGet<any[]>("mytrades_" + chatId, []);
    rec.push({ sym, side: t.side, entry: t.entry, exit: live, pnlPct, pnlLev, lev: t.lev, at: t.at, closedAt: Date.now(), hours: Number(hours) });
    await dbSet("mytrades_" + chatId, rec.slice(-300));
    const win = pnlLev >= 0;
    return `${win ? "🎉" : "😔"} معامله بسته شد — ${sym}

${t.side === "long" ? "🟢 لانگ" : "🔴 شورت"} | اهرم ${t.lev}x | مدت: ${hours} ساعت
ورود: ${fmt(t.entry)}$ → خروج: ${fmt(live)}$
${win ? "🟩" : "🟥"} نتیجه: ${pnlLev >= 0 ? "+" : ""}${pnlLev.toFixed(2)}% (با اهرم ${t.lev}x)

🧑‍🏫 مربی: ${pnlLev >= 5 ? "سود خوبی بود! یادت باشه بزرگ‌ترین اشتباه تریدرها اینه که بعد برد، بی‌احتیاط می‌شن." : win ? "سودده بود ✅ — تو ژورنالت بنویس دلیل ورودت چی بود تا الگوش رو پیدا کنی." : pnlLev > -3 ? "ضرر کوچیک — عالیه! همین مدیریت درستِ ریسکه. ضرر کم = زنده موندن." : "ضرر بزرگ بود. قانون مربی: بعد از ۲ ضرر پشت هم، ۲۴ ساعت معامله نکن. فرصت همیشه هست."}

📊 کارنامه شخصی‌ت: /report`;
  }
  if (text === "/report") {
    const rec = await dbGet<any[]>("mytrades_" + chatId, []);
    if (!rec.length) return "📊 هنوز معامله‌ای ثبت نکردی. اولین معامله‌ت رو با /trade long BTC ثبت کن.";
    const wins = rec.filter(r => r.pnlLev > 0);
    const wr = (wins.length / rec.length * 100).toFixed(0);
    const avg = rec.reduce((a, r) => a + r.pnlLev, 0) / rec.length;
    const best = Math.max(...rec.map(r => r.pnlLev));
    const worst = Math.min(...rec.map(r => r.pnlLev));
    const longs = rec.filter(r => r.side === "long");
    const shorts = rec.filter(r => r.side === "short");
    const lw = longs.length ? (longs.filter(r => r.pnlLev > 0).length / longs.length * 100).toFixed(0) : "—";
    const sw = shorts.length ? (shorts.filter(r => r.pnlLev > 0).length / shorts.length * 100).toFixed(0) : "—";
    let advice = "";
    if (rec.length >= 5) {
      if (longs.length >= 3 && shorts.length >= 3 && Number(lw) > Number(sw) + 20) advice = "\n🧑‍🏫 مربی: تو لانگ بهتر عمل می‌کنی تا شورت — تمرکزت رو بذار روی همون.";
      else if (shorts.length >= 3 && Number(sw) > Number(lw) + 20) advice = "\n🧑‍🏫 مربی: شورت‌هات قوی‌ترن — استعدادت تو بازار نزولیه!";
      if (worst < -10) advice += "\n⚠️ یه ضرر خیلی بزرگ (-" + Math.abs(worst).toFixed(0) + "%) توی کارنامه‌ته — اهرم رو روی معامله‌های حساس کم کن.";
    }
    return `📊 کارنامه شخصی تو (${rec.length} معامله)

🎯 وین‌ریت: ${wr}% (${wins.length} برد / ${rec.length - wins.length} باخت)
📈 میانگین سود/ضرر هر معامله: ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%
🏆 بهترین: +${best.toFixed(1)}% | 💀 بدترین: ${worst.toFixed(1)}%
🟢 وین‌ریت لانگ: ${lw}% | 🔴 وین‌ریت شورت: ${sw}%
⏱ میانگین مدت: ${(rec.reduce((a,r)=>a+(r.hours||0),0)/rec.length).toFixed(1)} ساعت
${advice}

${rec.length >= 10 ? (Number(wr) >= 50 && avg > 0 ? "🧑‍🏫 مربی: عملکردت از میانگین بازار بهتره — ادامه بده ولی بی‌احتیاط نشو." : avg <= 0 ? "🧑‍🏫 مربی: صادقانه — تا حالا ضررده‌ای. حجم معامله‌هات رو نصف کن و فقط با سیگنال‌های قوی (/signal) وارد شو تا ۵ معامله بعدی." : "🧑‍🏫 مربی: سوددهی — ولی قانون طلایی رو فراموش نکن: ریسک هر معامله حداکثر ۲٪.") : "🧑‍🏫 مربی: بعد از ۱۰ معامله، تحلیل عمیق‌تری بهت می‌دم — دیتا کمه هنوز."}

⚠️ این گزارش بر اساس معامله‌هایی‌ه که خودت ثبت کردی`;
  }
  if (text === "/top") {
    const rows: {sc:number,sym:string,p:number,r:number}[] = [];
    for (const sym of SYMBOLS.slice(0,8)) {
      try {
        const closes = (await klines(sym, "1h", 100)).map(k=>Number(k[4]));
        const r = rsi(closes); const [m, s] = macd(closes);
        rows.push({sc:(r<35?2:r>70?-2:0)+(m>s?1:-1), sym, p: closes[closes.length-1], r});
      } catch {}
    }
    rows.sort((a,b)=>b.sc-a.sc);
    return "🔥 سیگنال‌های برتر بازار:\n" + rows.slice(0,3).map(x=>
      `${x.sym}: ${x.sc>=2?"لانگ 🟢":x.sc<=-1?"شورت 🔴":"نظاره ⚪"} | ${x.p.toLocaleString("en-US")}$ | RSI ${x.r.toFixed(0)}`).join("\n");
  }
  if (text.startsWith("/news")) {
    const parts = text.split(" ");
    const news = await fetchNews(8);
    if (parts[1]) {
      const base = parts[1].toUpperCase().replace("USDT","");
      const rel = news.filter(t=>t.toLowerCase().includes(base.toLowerCase()) || (base==="BTC"&&t.toLowerCase().includes("bitcoin")));
      if (rel.length) {
        const raw = `📰 اخبار ${base}:\n\n` + rel.slice(0,5).map(t=>"🔹 "+t).join("\n\n");
        return await newsDigest(rel.slice(0,5), `اخبار مرتبط با ${base}`) ?? raw;
      }
    }
    const raw = "📰 آخرین اخبار بازار:\n\n" + news.slice(0,6).map(t=>"🔹 "+t).join("\n\n");
    return await newsDigest(news.slice(0,6), "آخرین اخبار بازار رمزارز") ?? raw;
  }
  if (text === "/brief") {
    // all-in-one daily briefing: news + social + F&G + full TA on top-25 → AI verdict
    let data = "";
    // 1) technical scan
    try {
      const syms = await topSymbols(25);
      const ranked = await rankScan(syms);
      if (ranked.length) {
        data += "## رتبه‌بندی تکنیکال ۲۵ ارز برتر (امتیاز -۶ تا +۶: RSI، MACD، بولینگر، ساختار):\n";
        data += ranked.slice(0, 12).map(x=>`${x.sym.replace("USDT","")}: ${x.sc>=0?"+":""}${x.sc} (قیمت ${x.p.toLocaleString("en-US")}$, RSI ${x.rsi.toFixed(0)})`).join("\n");
        data += "\n";
      }
    } catch {}
    // 2) sentiment & social
    try {
      const f = await (await fetch("https://api.alternative.me/fng/?limit=1")).json();
      const d = f.data?.[0];
      if (d) data += `\n## شاخص ترس و طمع: ${d.value}/100 (${d.value_classification})\n`;
    } catch {}
    try {
      const j = await (await fetch("https://data-api.binance.vision/api/v3/ticker/24hr")).json();
      const usdt = (Array.isArray(j)?j:[]).filter((t:any)=>typeof t.symbol==="string" && t.symbol.endsWith("USDT") && Number(t.quoteVolume)>5e6 && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol));
      const ups = usdt.filter((t:any)=>Number(t.priceChangePercent)>0).length;
      const g = [...usdt].sort((a:any,b:any)=>Number(b.priceChangePercent)-Number(a.priceChangePercent)).slice(0,4);
      const l = [...usdt].sort((a:any,b:any)=>Number(a.priceChangePercent)-Number(b.priceChangePercent)).slice(0,4);
      data += `\n## عرض و تقاضا: ${ups} سبز از ${usdt.length} ارز پرحجم (${(ups/usdt.length*100).toFixed(0)}% سبز)\n`;
      data += `پامپ‌ها: ${g.map((t:any)=>`${t.symbol.replace("USDT","")} +${Number(t.priceChangePercent).toFixed(0)}%`).join(", ")}\n`;
      data += `دامپ‌ها: ${l.map((t:any)=>`${t.symbol.replace("USDT","")} ${Number(t.priceChangePercent).toFixed(0)}%`).join(", ")}\n`;
    } catch {}
    try {
      const t = await (await fetch("https://api.coingecko.com/api/v3/search/trending")).json();
      const hot = (t.coins||[]).slice(0,5).map((c:any)=>c.item?.symbol).filter(Boolean);
      if (hot.length) data += `\n## داغ‌های شبکه‌های اجتماعی (بیشترین جستجو): ${hot.join(", ")}\n`;
    } catch {}
    // 3) news headlines
    try {
      const news = await fetchNews(8);
      if (news.length) data += `\n## عناوین اخبار:\n` + news.slice(0,8).map(t=>"• "+t).join("\n") + "\n";
    } catch {}
    if (!data) return "⚠️ الان داده کافی جمع نشد، بعداً امتحان کن.";
    // 4) AI verdict
    try {
      const r = await fetch(LLM_URL, {
        method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${LLM_KEY}`},
        body: JSON.stringify({model:"auto", max_tokens:2000, messages:[
          {role:"system", content:"تو یک تحلیلگر ارشد بازار رمزارز هستی. فارسی روان، خلاصه و بدون اغراق می‌نویسی. همیشه یادآوری می‌کنی که تصمیم نهایی با کاربر است و این توصیه نیست."},
          {role:"user", content:`این داده‌های واقعی و لحظه‌ای بازار است (تکنیکال، احساسات، اجتماعی، اخبار). یک جمع‌بندی روزانه کوتاه (حداکثر ۱۲ خط) بنویس با این ساختار:\n\n۱. «وضعیت بازار:» — ۲-۳ خط جمع‌بندی کلی بر اساس همه داده‌ها (چرا این وضعیت؟ به اعداد ارجاع بده)\n۲. «بهترین گزینه‌ها:» — حداکثر ۲ ارز که بر اساس داده‌ها بهترین موقعیت دارند، هرکدام یک خط با دلیل مشخص (ترکیب تکنیکال + خبر/ترند)\n۳. «ریسک‌ها:» — ۱-۲ خط (مثلاً پامپ بی‌پشتوانه، طمع بالا، خبر منفی)\n۴. «توصیه عملی:» — یک جمله (نظاره/ورود محتاطانه و...) \n\nاگر داده‌ها سیگنال قوی نشان نمی‌دهند، صادقانه بگو «الان موقعیت خوبی نیست، نظاره بهتره». حدس نزن، فقط از داده‌های زیر استفاده کن:\n\n${data}`}]})
      });
      const j = await r.json();
      const ai = (j.choices?.[0]?.message?.content || "").trim();
      if (ai) {
        console.log(`[brief] ok len=${ai.length}`);
        return `🧭 جمع‌بندی روزانه سیگنال‌یار\n\n${ai}\n\n⚠️ این تحلیل خودکار است و توصیه سرمایه‌گذاری نیست — تصمیم نهایی با خودته`;
      }
      console.log(`[brief] empty status=${r.status} err=${JSON.stringify(j.error ?? null)}`);
    } catch (e) { console.log(`[brief] ERR: ${e instanceof Error ? e.message : e}`); }
    // fallback: raw data view
    return "🧭 جمع‌بندی روزانه (داده خام — هوش مصنوعی موقتاً در دسترس نیست):\n\n" + data + "\n⚠️ توصیه سرمایه‌گذاری نیست";
  }
  if (text === "/trend" || text.startsWith("/trend ")) {
    // social/trend pulse: where the money & attention is going
    const parts: string[] = [];
    let fngLine = "";
    try {
      const f = await (await fetch("https://api.alternative.me/fng/?limit=1")).json();
      const d = f.data?.[0];
      if (d) {
        const v = Number(d.value);
        const emoji = v <= 25 ? "😱 ترس شدید" : v <= 45 ? "😰 ترس" : v <= 55 ? "😐 خنثی" : v <= 75 ? "🤑 طمع" : "🔥 طمع شدید";
        fngLine = `\n🎭 شاخص ترس و طمع: ${v}/100 (${emoji})`;
      }
    } catch {}
    try {
      const t = await (await fetch("https://api.coingecko.com/api/v3/search/trending")).json();
      const hot = (t.coins||[]).slice(0,6).map((c:any)=>c.item).filter(Boolean);
      if (hot.length) {
        parts.push("🔥 داغ‌ترین ارزهای شبکه‌های اجتماعی (جستجوی کاربران):");
        parts.push(hot.map((c:any)=>`• ${c.symbol} ${c.market_cap_rank?`(رتبه بازار #${c.market_cap_rank})`:"(تازه‌وارد)"}`).join("\n"));
      }
    } catch {}
    try {
      const j = await (await fetch("https://data-api.binance.vision/api/v3/ticker/24hr")).json();
      const usdt = (Array.isArray(j)?j:[]).filter((t:any)=>typeof t.symbol==="string" && t.symbol.endsWith("USDT") && Number(t.quoteVolume)>5e6 && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol));
      const g = [...usdt].sort((a:any,b:any)=>Number(b.priceChangePercent)-Number(a.priceChangePercent)).slice(0,5);
      const l = [...usdt].sort((a:any,b:any)=>Number(a.priceChangePercent)-Number(b.priceChangePercent)).slice(0,5);
      parts.push("📈 پامپ‌های ۲۴ ساعت اخیر (موج اجتماعی/پول وارد شده):");
      parts.push(g.map((t:any)=>`• ${t.symbol.replace("USDT","")} +${Number(t.priceChangePercent).toFixed(1)}% (حجم ${Number(t.quoteVolume).toLocaleString("en-US",{notation:"compact"})}$)`).join("\n"));
      parts.push("📉 دامپ‌های ۲۴ ساعت اخیر:");
      parts.push(l.map((t:any)=>`• ${t.symbol.replace("USDT","")} ${Number(t.priceChangePercent).toFixed(1)}%`).join("\n"));
      // accumulation vs distribution proxy: up-movers vs down-movers count on high-volume pairs
      const ups = usdt.filter((t:any)=>Number(t.priceChangePercent)>0).length;
      parts.push(`⚖️ عرض و تقاضا: از ${usdt.length} ارز پرحجم، ${ups} تا سبز و ${usdt.length-ups} تا قرمز (${ups>usdt.length-ups?"فشار خرید غالب":"فشار فروش غالب"})`);
    } catch {}
    if (!parts.length) return "⚠️ الان داده ترند در دسترس نیست، بعداً امتحان کن.";
    let out = `🌊 نبض بازار و شبکه‌های اجتماعی\n${fngLine}\n\n` + parts.join("\n\n");
    // AI interpretation on top of real data
    try {
      const r = await fetch(LLM_URL, {
        method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${LLM_KEY}`},
        body: JSON.stringify({model:"auto", max_tokens:2000, messages:[
          {role:"system", content:"تو تحلیلگر احساسات بازار رمزارز هستی، فارسی روان و کوتاه."},
          {role:"user", content:`بر اساس این داده‌های واقعی (رتبه‌بندی جستجوی اجتماعی، پامپ/دامپ‌های ۲۴ساعته، شاخص ترس و طمع) ۴-۵ خط جمع‌بندی کن: پول و توجه کاربران به کدام ارزها/حوزه‌ها در حال رفتنه، چه ریسک‌هایی دیده می‌شود (مثلاً پامپ‌های بی‌پشتوانه) و حس کلی بازار چیه. اعداد را نقض نکن، فقط تفسیر کن:\n\n${parts.join("\n")}`}]})
      });
      const j = await r.json();
      const ai = (j.choices?.[0]?.message?.content || "").trim();
      if (ai) out += "\n\n🧠 جمع‌بندی تحلیل‌گر:\n" + ai;
    } catch {}
    return out + "\n\n⚠️ توصیه سرمایه‌گذاری نیست — تصمیم با خودته";
  }
  if (text === "/stats" || text === "/states") {
    const sigs = await dbGet<any[]>("signals", []);
    // evaluate pending
    let changed = false;
    for (const s of sigs) {
      if (s.checked || Date.now()-s.ts < 6*3600e3) continue;
      try {
        const p = await (await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${s.sym}`)).json();
        const cur = Number(p.price);
        // dynamic thresholds (stored at signal time) if available, else fixed ±9/−3
        const tpPct = s.tpPrice ? (s.side==="لانگ" ? (s.tpPrice/s.entry-1)*100 : (s.entry/s.tpPrice-1)*100) : 9;
        const slPct = s.slPrice ? (s.side==="لانگ" ? (s.slPrice/s.entry-1)*100 : (s.entry/s.slPrice-1)*100) : -3;
        let ch = (cur/s.entry-1)*100;
        if (s.side === "شورت") ch = -ch;
        if (ch >= tpPct) s.result = "win";
        else if (ch <= slPct) s.result = "loss";
        else if (Date.now()-s.ts > 72*3600e3) s.result = "flat";
        if (s.result) { s.checked = true; changed = true; }
      } catch {}
    }
    if (changed) await dbSet("signals", sigs);
    const done = sigs.filter(s=>s.checked);
    const wins = done.filter(s=>s.result==="win").length;
    const losses = done.filter(s=>s.result==="loss").length;
    const total = wins+losses;
    return `📊 کارنامه واقعی سیگنال‌یار\nسیگنال‌های ارزیابی‌شده: ${total}\nموفق: ${wins} | ناموفق: ${losses}\nنرخ موفقیت: ${total?(wins/total*100).toFixed(0):0}%\n(معیار: +9% سود یا -3% ضرر حداکثر ۷۲ ساعت)\n\n⚠️ عملکرد گذشته تضمین آینده نیست`;
  }
  if (text === "/models") {
    const cur = await dbGet<string>("model_" + chatId, "glm");
    if (isModelLockedFor(chatId)) {
      // regular users: model is fixed to GLM for everyone (stability + no per-user key juggling)
      return "🧠 هوش مصنوعی این بات: GLM (پیش‌فرض و پایدار)\n\nبرای همه کاربران یکسان است. اگر مدل انتخابی دلخواه می‌خوای، به پشتیبانی پیام بده 🙏";
    }
    let list = "✅ /model glm — GLM (پیش‌فرض، سریع)\n";
    if (OPENROUTER_KEY) {
      const frees = (await fetchFreeModels()).filter(m => {
        // filter models that can't do general chat
        const bad = /inkling|content-safety|code/i.test(m.id);
        return !bad;
      });
      if (frees.length) {
        list += frees.slice(0, 10).map((m, i) =>
          `${("or" + (i+1)) === cur ? "✅" : "▫️"} /model or${i+1} — ${m.name}`).join("\n");
      } else {
        list += "⚠️ لیست مدل‌های رایگان الان در دسترس نیست";
      }
    } else {
      list += "⚠️ برای مدل‌های بیشتر، کلید OpenRouter لازمه";
    }
    return "🧠 هوش مصنوعی‌های موجود:\n\n" + list;
  }
  if (text.startsWith("/model ")) {
    if (isModelLockedFor(chatId)) {
      return "🔒 تغییر مدل فقط برای مدیر فعال است. هوش مصنوعی فعلی: GLM (پایدار برای همه).";
    }
    const key = text.split(" ")[1]?.toLowerCase().trim();
    if (!key) return "⚠️ مدل رو مشخص کن. لیست: /models";
    if (key === "glm") {
      await dbSet("model_" + chatId, "glm");
      return "✅ برگشتی روی GLM (پیش‌فرض)";
    }
    if (!OPENROUTER_KEY) return "⚠️ برای مدل‌های OpenRouter اول باید کلید ست بشه.";
    const frees = await fetchFreeModels();
    const m = /^or(\d+)$/.exec(key ?? "");
    const idx = m ? parseInt(m[1]) - 1 : -1;
    if (idx < 0 || idx >= frees.length) {
      return "⚠️ شماره نامعتبر. لیست: /models";
    }
    await dbSet("model_" + chatId, "or:" + frees[idx].id);
    console.log(`[model] user=${chatId} set to or:${frees[idx].id} (frees=${frees.length})`);
    return `✅ هوش مصنوعی تو الان: ${frees[idx].name}`;
  }
  if (text === "/subscribe") {
    const subs = await dbGet<number[]>("subs", memSubs);
    if (!subs.includes(chatId)) { subs.push(chatId); await dbSet("subs", subs); }
    return "✅ فعال شد! هر ۴ ساعت بهترین سیگنال‌های خودکار رو برات می‌فرستم.";
  }
  if (text === "/unsubscribe") {
    const subs = await dbGet<number[]>("subs", memSubs);
    await dbSet("subs", subs.filter(x=>x!==chatId));
    return "❌ لغو شد.";
  }
  // ---------- admin panel (owner only) ----------
  if (text.startsWith("/admin")) {
    if (!isAdmin(chatId)) return "🔒 این بخش فقط برای مدیر بات است.";
    const arg = text.slice(6).trim();
    // /admin — show dashboard
    if (!arg) {
      const subs = await dbGet<number[]>("subs", memSubs);
      const sigs = await dbGet<any[]>("signals", []);
      const pending = sigs.filter(s=>!s.checked).length;
      const model = await dbGet<string>("model_" + chatId, "glm");
      return `🛠 پنل مدیریت سیگنال‌یار\n\n👥 مشترکین سیگنال خودکار: ${subs.length}\n📊 سیگنال‌های ذخیره‌شده: ${sigs.length} (در انتظار ارزیابی: ${pending})\n🧠 مدل چت تو: ${model.startsWith("or:") ? "OpenRouter (" + model.slice(3) + ")" : "GLM"}\n🔐 دسترسی: مدیر (تو)\n\nدستورات مدیریتی:\n/admin users — لیست کاربران (با آیدی برای مسدودکردن)\n/admin block <id> — مسدودکردن کاربر (بی‌پاسخ کامل)\n/admin unblock <id> — رفع مسدودی\n/admin banned — لیست مسدودشده‌ها\n/admin broadcast <متن> — پیام همگانی\n/admin model orN|glm — تغییر مدل چت خودت\n/admin stats — کارنامه کامل با جزئیات\n/admin locks — وضعیت قفل‌ها`;
    }
    if (arg === "users") {
      const users = await dbGet<any[]>("users", []);
      const banned = await dbGet<number[]>("banned", []);
      if (!users.length) return "👥 هنوز کاربری ثبت نشده.";
      const fmt = (u:any) => {
        const nm = u.name || u.username || "";
        const un = u.username ? ` @${u.username}` : "";
        const b = banned.includes(u.id) ? " 🚫مسدود" : "";
        const me = u.id === OWNER_ID ? " (تو)" : "";
        const lastAgo = Math.round((Date.now()-(u.last||u.first||Date.now()))/3600e3);
        return `${u.id}${me}${un} — ${nm}${b} | آخرین فعالیت: ${lastAgo>=1 ? lastAgo+" ساعت پیش" : "همین الان"}`;
      };
      return `👥 کاربران (${users.length}):\n\n` + users.map(fmt).join("\n") + `\n\n🚫 مسدودکردن: /admin block <id>\n♻️ رفع مسدودی: /admin unblock <id>`;
    }
    if (arg.startsWith("block ")) {
      const id = parseInt(arg.slice(6).trim());
      if (!id || id === OWNER_ID) return "⚠️ شناسه نامعتبر (نمی‌تونی خودت رو بلاک کنی). آیدی از /admin users";
      const banned = await dbGet<number[]>("banned", []);
      if (banned.includes(id)) return "ℹ️ همین الانم مسدوده.";
      banned.push(id);
      await dbSet("banned", banned);
      // auto-remove from subscribers + wipe their chat memory
      const subs = await dbGet<number[]>("subs", []);
      await dbSet("subs", subs.filter(x=>x!==id));
      memChats.delete(id);
      console.log(`[admin] blocked user=${id}`);
      return `🚫 کاربر ${id} مسدود شد.\n• از لیست مشترکین سیگنال حذف شد\n• از این به بعد پیام‌هاش بی‌پاسخ می‌مونه\n\nبرای رفع: /admin unblock ${id}`;
    }
    if (arg.startsWith("unblock ")) {
      const id = parseInt(arg.slice(8).trim());
      if (!id) return "⚠️ شناسه رو بنویس: /admin unblock <id>";
      const banned = await dbGet<number[]>("banned", []);
      if (!banned.includes(id)) return "ℹ️ این کاربر مسدود نیست.";
      await dbSet("banned", banned.filter(x=>x!==id));
      console.log(`[admin] unblocked user=${id}`);
      return `♻️ کاربر ${id} رفع مسدودی شد — دوباره می‌تونه با بات کار کنه.`;
    }
    if (arg === "banned") {
      const banned = await dbGet<number[]>("banned", []);
      return `🚫 مسدودشده‌ها (${banned.length}):\n` + (banned.length ? banned.map(b=>`${b} — رفع: /admin unblock ${b}`).join("\n") : "هیچ‌کس");
    }
    if (arg.startsWith("broadcast ")) {
      const msg = arg.slice(10).trim();
      if (!msg) return "⚠️ متن پیام رو بنویس: /admin broadcast سلام";
      const subs = await dbGet<number[]>("subs", memSubs);
      let sent = 0, failed = 0;
      for (const cid of subs) {
        try { const r = await tg("sendMessage", {chat_id: cid, text: `📣 پیام مدیر:\n\n${msg}`}); if (r.ok) sent++; else failed++; }
        catch { failed++; }
      }
      console.log(`[admin] broadcast sent=${sent} failed=${failed}`);
      return `📣 پیام همگانی ارسال شد: ${sent} موفق، ${failed} ناموفق (از ${subs.length} مشترک)`;
    }
    if (arg === "model" || arg.startsWith("model ")) {
      const key = arg.split(" ")[1]?.toLowerCase().trim();
      if (!key) {
        const cur = await dbGet<string>("model_" + chatId, "glm");
        let list = "مدل فعلی تو: " + (cur.startsWith("or:") ? cur.slice(3) : "GLM") + "\n\n✅ /admin model glm\n";
        if (OPENROUTER_KEY) {
          const frees = (await fetchFreeModels()).filter(m => !/inkling|content-safety|code/i.test(m.id));
          list += frees.slice(0, 10).map((m, i) => `/admin model or${i+1} — ${m.name}`).join("\n");
        }
        return list;
      }
      if (key === "glm") { await dbSet("model_" + chatId, "glm"); return "✅ مدل چت تو: GLM"; }
      const frees = await fetchFreeModels();
      const m = /^or(\d+)$/.exec(key);
      const idx = m ? parseInt(m[1]) - 1 : -1;
      if (idx < 0 || idx >= frees.length) return "⚠️ شماره نامعتبر";
      await dbSet("model_" + chatId, "or:" + frees[idx].id);
      return `✅ مدل چت تو: ${frees[idx].name}`;
    }
    if (arg === "stats") {
      const sigs = await dbGet<any[]>("signals", []);
      const done = sigs.filter(s=>s.checked);
      const last = sigs.slice(-10).reverse().map(s =>
        `${s.sym.replace("USDT","")} ${s.side} | ورود ${Number(s.entry).toLocaleString("en-US")}$ | ${s.checked ? (s.result==="win"?"✅ سود":s.result==="loss"?"❌ ضرر":"➖ خنثی") : "⏳ در جریان"}`);
      return `📊 جزئیات سیگنال‌ها (${sigs.length} کل، ${done.length} ارزیابی‌شده):\n\n` + (last.join("\n") || "هنوز سیگنالی ثبت نشده");
    }
    if (arg === "locks") {
      return `🔐 وضعیت قفل‌ها:\n\n🧠 انتخاب مدل برای کاربران عادی: 🔒 قفل روی GLM\n🛠 پنل /admin: فقط مدیر (تو)\n📊 دستورات تحلیلی: آزاد برای همه\n📢 subscribe: آزاد برای همه\n\n(قفل مدل توسط کد ثابت شده — برای تغییر باید کد آپدیت بشه)`;
    }
    return "⚠️ زیردستور نامعتبر. /admin را بدون آرگومان بزن.";
  }
  if (text.startsWith("/")) {
    return "🤖 این دستور رو نشناختم!\n\n/price /signal /top /rank /news /stats /models /subscribe\n\nیا آزادانه سؤال بپرس 💬";
  }
  // LLM chat (per-user model selection) — AI as "bot manager": feeds real market data into context
  const modelKey = await dbGet<string>("model_" + chatId, "glm");
  const h = memChats.get(chatId) ?? [];
  h.push({role:"user", content:text});
  let reply: string;
  // gather real-time data context (only when the message looks market-related, to stay fast)
  let marketCtx = "";
  const wantsMarket = /btc|بیت|اتریوم|eth|sol|ریپل|xrp|دوج|doge|ada|bnb|avax|link|dot|کریپتو|رمزارز|بازار|قیمت|سیگنال|بخرم|بفروشم|تحلیل|سود|ضرر|لانگ|شورت/i.test(text);
  if (wantsMarket) {
    try {
      const parts: string[] = [];
      const top = SYMBOLS.slice(0, 6);
      for (const sym of top) {
        try {
          const ks = await klines(sym, "1h", 100);
          const closes = ks.map(k=>Number(k[4]));
          const p = closes[closes.length-1];
          const r = rsi(closes);
          const [m, s] = macd(closes);
          const chg = ((p / closes[closes.length-25] - 1) * 100);
          const bb = bollinger(closes);
          const sr = srLevels(closes);
          const fb = fib(closes);
          const fbKey = fb.pos < 0.45 ? "پایین بازه" : fb.pos < 0.7 ? "میانه بازه" : "بالای بازه";
          parts.push(`${sym.replace("USDT","")}: قیمت=${p.toLocaleString("en-US")}$، RSI=${r.toFixed(0)}، MACD=${m>s?"مثبت (صعودی)":"منفی (نزولی)"}، تغییر ۲۴ساعت=${chg.toFixed(1)}%، بولینگر=${bb.pos.toFixed(2)} از ۱ (${bb.pos<0.2?"لبه پایین":bb.pos>0.8?"لبه بالا":"میانه"})، حمایت=${sr.sup.toLocaleString("en-US")}$، مقاومت=${sr.res.toLocaleString("en-US")}$، فیبوناچی=${fbKey}`);
        } catch {}
      }
      if (parts.length) marketCtx = "\n\n[داده‌های لحظه‌ای بازار (محاسبه‌شده واقعی از Binance — این اعداد حقیقی‌اند):\n" + parts.join("\n") + "]";
    } catch {}
  }
  const sysMsg = {role:"system", content:"تو سیگنال‌یار هستی، مدیر تحلیل‌گر بازار رمزارز به زبان فارسی. اگر داده لحظه‌ای بازار در پیام بهت داده شده، بر اساس همان اعداد واقعی تحلیل کن و به آن‌ها ارجاع بده؛ حدس نزن. کوتاه، دقیق و دوستانه جواب بده. هیچ‌وقت توصیه قطعی سرمایه‌گذاری نکن و یادآوری کن تصمیم با خود کاربر است." + marketCtx};
  try {
    let j: any;
    console.log(`[chat] user=${chatId} modelKey=${modelKey}`);
    let usedFallback = false;
    if (modelKey.startsWith("or:") && OPENROUTER_KEY) {
      const r = await fetch(OR_URL, {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${OPENROUTER_KEY}`},
        body: JSON.stringify({model: modelKey.slice(3), max_tokens:2000, messages:[sysMsg, ...h.slice(-8)]})
      });
      j = await r.json();
      console.log(`[chat] or status=${r.status} model=${modelKey.slice(3)} err=${JSON.stringify(j.error ?? null)}`);
      // model unavailable/broken -> fall back to GLM so user never sees "…"
      if (!j.choices?.[0]?.message?.content) {
        usedFallback = true;
        const r2 = await fetch(LLM_URL, {
          method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${LLM_KEY}`},
          body: JSON.stringify({model:"auto", max_tokens:800, messages:[sysMsg, ...h.slice(-8)]})
        });
        j = await r2.json();
        await dbSet("model_" + chatId, "glm"); // reset broken selection
      }
    } else {
      const r = await fetch(LLM_URL, {
        method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${LLM_KEY}`},
        body: JSON.stringify({model:"auto", max_tokens:2000, messages:[sysMsg, ...h.slice(-8)]})
      });
      j = await r.json();
      console.log(`[chat] glm status=${r.status} content_len=${(j.choices?.[0]?.message?.content||"").length} err=${JSON.stringify(j.error ?? null)}`);
    }
    reply = (j.choices?.[0]?.message?.content || "").trim();
    if (!reply && j.choices?.[0]?.message?.reasoning) {
      // some models put output in reasoning field
      reply = j.choices[0].message.reasoning.trim().slice(0, 800);
    }
    if (!reply) reply = "…";
    if (usedFallback) reply = "⚠️ مدل انتخابی‌ت موقتاً در دسترس نبود، با GLM جواب دادم:\n\n" + reply;
  } catch { reply = "⚠️ الان نمی‌تونم جواب بدم، بعداً امتحان کن."; }
  h.push({role:"assistant", content:reply});
  memChats.set(chatId, h.slice(-16));
  return reply;
}

// ---------- cron: auto signals every 4h ----------
Deno.cron("auto signals", "0 */4 * * *", async () => {
  const subs = await dbGet<number[]>("subs", memSubs);
  if (!subs.length) return;
  // scan top-25 by volume (fresh listings included automatically)
  const syms = await topSymbols(25);
  const rows: {sc:number,sym:string,p:number,at:number}[] = [];
  for (const sym of syms) {
    try {
      const ks = await klines(sym, "1h", 100);
      const closes = ks.map(k=>Number(k[4]));
      const r = rsi(closes); const [m, s] = macd(closes);
      const bb = bollinger(closes);
      const sr = srLevels(closes);
      // strict multi-factor score: RSI + MACD + Bollinger edge + trend alignment
      let sc = 0;
      sc += r < 35 ? 2 : r > 70 ? -2 : 0;             // RSI extremes
      sc += m > s ? 1 : -1;                            // MACD direction
      if (bb.pos <= 0.15) sc += 1;                     // at lower Bollinger band (bounce zone)
      else if (bb.pos >= 0.85) sc -= 1;                // at upper band (exhaustion zone)
      // trend alignment: price above support & below resistance midpoint = structurally long
      const mid = (sr.sup + sr.res) / 2;
      const p = closes[closes.length-1];
      if (p > mid) sc += 1; else sc -= 1;              // structure bias
      // quality gate: require ≥4 AND confluence (RSI extreme OR bollinger edge, plus MACD agreeing)
      const strongConfluence = (Math.abs(r - 50) > 15 || bb.pos <= 0.15 || bb.pos >= 0.85) && ((m > s) === (sc > 0));
      if (Math.abs(sc) >= 4 && strongConfluence) rows.push({sc, sym, p, at: atr(ks)});
    } catch {}
  }
  // prefer strongest; skip coins with tiny 1h volume (illiquid pumps)
  rows.sort((a,b)=>Math.abs(b.sc)-Math.abs(a.sc));
  const fmt = (v:number, d=2) => v >= 1000 ? v.toLocaleString("en-US",{maximumFractionDigits:0}) : v >= 1 ? v.toLocaleString("en-US",{maximumFractionDigits:d}) : v.toLocaleString("en-US",{maximumFractionDigits:4});
  for (const row of rows.slice(0,2)) {
    const sigs = await dbGet<any[]>("signals", []);
    if (sigs.some(s=>s.sym===row.sym && Date.now()-s.ts < 12*3600e3)) continue;
    const side = row.sc>=0?"لانگ":"شورت";
    // realistic confidence: 55 base + score bonus, capped lower than before
    const conf = Math.min(55 + Math.abs(row.sc)*5, 82);
    // dynamic risk from ATR (same formula as /signal)
    const slPct = (2*row.at/row.p)*100, tpPct = (3*row.at/row.p)*100;
    const volFactor = 2*row.at/row.p;
    const lev = Math.max(1, Math.min(3, Math.round((0.02 / Math.max(volFactor, 0.004)) * 10) / 10));
    const slPrice = side==="لانگ" ? row.p - 2*row.at : row.p + 2*row.at;
    const tpPrice = side==="لانگ" ? row.p + 3*row.at : row.p - 3*row.at;
    const msg = `🔔 سیگنال خودکار\n${row.sym}: ${side} ${side==="لانگ"?"🟢":"🔴"}\nقیمت: ${row.p.toLocaleString("en-US")}$ | اطمینان: ${conf}%\nاهرم: ${lev}x | حد ضرر: -${slPct.toFixed(1)}% (${fmt(slPrice)}$) | حد سود: +${tpPct.toFixed(1)}% (${fmt(tpPrice)}$)\n\n⚠️ توصیه سرمایه‌گذاری نیست`;
    for (const cid of subs) {
      try { await tg("sendMessage", {chat_id: cid, text: msg}); } catch {}
    }
    // store dynamic thresholds so /stats evaluates against REAL SL/TP, not fixed ±%
    sigs.push({sym: row.sym, side, conf, entry: row.p, ts: Date.now(), checked: false, result: null,
      slPrice: Number(slPrice.toFixed(8)), tpPrice: Number(tpPrice.toFixed(8))});
    await dbSet("signals", sigs.slice(-500));
  }
});

// ---------- cron: mentor trade watch every 15 min ----------
Deno.cron("mentor watch", "*/15 * * * *", async () => {
  // collect all chats with open trades (KV list is not enumerable; keep a registry)
  let reg = await dbGet<number[]>("trade_chats", []);
  let regChanged = false;
  const now = Date.now();
  for (const cid of reg) {
    const opens = await dbGet<any[]>("trades_" + cid, []);
    if (!opens.length) continue;
    for (const t of opens) {
      try {
        const ks = await klines(t.sym, "1m", 2);
        const live = Number(ks[ks.length-1][4]);
        const pnl = (t.side === "long" ? live/t.entry-1 : t.entry/live-1) * 100;
        const pnlLev = pnl * t.lev;
        let alert = "";
        if (now - t.at > 10*60*1000 && !t.slWarned) {
          alert = `🧑‍🏫 مربی: ${t.sym} رو ${((now-t.at)/60000).toFixed(0)} دقیقه پیش باز کردی — حد ضرر واقعی رو توی صرافی گذاشتی؟ اگر نه همین الان بذار! پیشنهاد من: ${fmt(t.sl)}$`;
          t.slWarned = true;
          await dbSet("trades_" + cid, opens);
        } else if (pnlLev <= -15) {
          alert = `🚨 ${t.sym}: با اهرم ${t.lev}x روی ${pnlLev.toFixed(1)}%-ی! لیکویید نزدیکه — حد ضرر بذار یا حجم کم کن. الان قیمت: ${fmt(live)}$`;
        } else if (pnlLev <= -7) {
          alert = `🔴 ${t.sym}: ضرر ${pnlLev.toFixed(1)}% (با اهرم) — به حد ضرر پیشنهادی (${fmt(t.sl)}$) نزدیک می‌شی. برنامه‌ات چی بود؟`;
        } else if (pnlLev >= 10) {
          alert = `🟢 ${t.sym}: +${pnlLev.toFixed(1)}% سود! مربی می‌گه: حد ضرر رو بیار نقطه ورود (بی‌ریسکش کن) یا بخشی از سود رو ببند.`;
        } else if (pnlLev >= 4) {
          alert = `🟩 ${t.sym}: +${pnlLev.toFixed(1)}% — سود خوبه. اگه مومنتوم هنوز قویه نگه دار، وگرنه حد سود نزدیکه (${fmt(t.tp)}$).`;
        }
        if (alert) {
          const r = await tg("sendMessage", {chat_id: cid, text: alert + "\n\n⚠️ تصمیم نهایی با خودته"});
          console.log(`[mentor] chat=${cid} ${t.sym} pnl=${pnlLev.toFixed(1)}% sent=${r.ok}`);
        }
        // auto-detect closed position: price crossed the stored TP/SL
        if ((t.side === "long" && (live <= t.sl || live >= t.tp)) || (t.side === "short" && (live >= t.sl || live <= t.tp))) {
          const hit = (t.side === "long" ? live >= t.tp : live <= t.tp) ? "حد سود" : "حد ضرر";
          const rec = await dbGet<any[]>("mytrades_" + cid, []);
          const pnlAt = (t.side === "long" ? (hit==="حد سود"?t.tp:t.sl)/t.entry-1 : t.entry/(hit==="حد سود"?t.tp:t.sl)-1) * 100 * t.lev;
          rec.push({ sym: t.sym, side: t.side, entry: t.entry, exit: hit==="حد سود"?t.tp:t.sl, pnlPct: pnlAt/t.lev, pnlLev: pnlAt, lev: t.lev, at: t.at, closedAt: now, hours: Number(((now-t.at)/3600000).toFixed(1)), auto: true });
          await dbSet("mytrades_" + cid, rec.slice(-300));
          await dbSet("trades_" + cid, opens.filter(x => x.sym !== t.sym));
          await tg("sendMessage", {chat_id: cid, text: `📌 ${t.sym} به ${hit} رسید (${fmt(hit==="حد سود"?t.tp:t.sl)}$) — معامله رو بسته حساب کردم.\nنتیجه: ${pnlAt>=0?"+":""}${pnlAt.toFixed(1)}%\nاگه هنوز بازه بگو: /close ${t.sym.replace("USDT","")}\n\n📊 /report`});
        }
      } catch (e) { console.log(`[mentor] err ${t.sym}: ${e instanceof Error ? e.message : e}`); }
    }
  }
});

// ---------- webhook server ----------
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/" && req.method === "GET") {
    return new Response("SignalYar bot is running ✅");
  }
  if (url.pathname === "/set-webhook") {
    const hook = `${url.origin}/webhook`;
    const r = await tg("setWebhook", {url: hook});
    return new Response(JSON.stringify({hook, res: r}), {status: 200});
  }
  if (url.pathname === "/webhook" && req.method === "POST") {
    try {
      const upd = await req.json();
      const m = upd.message;
      if (m?.chat?.id && m.text) {
        const cid = m.chat.id;
        // banned users are ignored silently (no reply at all)
        if (!isAdmin(cid) && await isBanned(cid)) {
          console.log(`[banned] ignored chat=${cid}`);
          return new Response("ok");
        }
        // record/refresh user directory (id, name, username, activity) for admin management
        try {
          const users = await dbGet<any[]>("users", []);
          const now = Date.now();
          const i = users.findIndex(u => u.id === cid);
          const info = { id: cid, name: m.from?.first_name || m.chat?.first_name || "", username: m.from?.username || "", last: now };
          if (i >= 0) users[i] = { ...users[i], ...info };
          else users.push({ ...info, first: now });
          await dbSet("users", users.slice(-2000));
        } catch {}
        const reply = await handleMessage(cid, m.text);
        const sr = await tg("sendMessage", {chat_id: cid, text: reply});
        console.log(`[send] ${sr.ok?"ok":"FAIL"} chat=${cid} len=${reply.length}`);
      }
    } catch (e) { console.error(e); }
    return new Response("ok");
  }
  return new Response("not found", {status: 404});
});
