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
function rsi(closes: number[], period = 14): number {
  const gains: number[] = [], losses: number[] = [];
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
    return "👋 سلام! من سیگنال‌یارم 🤖\n\nدستورات:\n/price BTC — قیمت لحظه‌ای\n/signal — تحلیل تکنیکال واقعی\n/top — ۳ سیگنال برتر\n/rank — رتبه‌بندی ۲۵ ارز (قوی→ضعیف)\n/news — اخبار بازار\n/stats — کارنامه واقعی\n/models — انتخاب هوش مصنوعی\n/subscribe — سیگنال خودکار\n/unsubscribe — لغو\n\n💬 یا آزادانه بپرس.\n\n⚠️ تصمیم نهایی معامله با خودته";
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
        const reply = await handleMessage(m.chat.id, m.text);
        const sr = await tg("sendMessage", {chat_id: m.chat.id, text: reply});
        console.log(`[send] ${sr.ok?"ok":"FAIL"} chat=${m.chat.id} len=${reply.length} head=${JSON.stringify(reply.slice(0,120))}`);
      }
    } catch (e) { console.error(e); }
    return new Response("ok");
  }
  return new Response("not found", {status: 404});
});
