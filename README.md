# SignalYar Bot 🤖

Telegram trading-signal bot in Persian. Free, no international card required.

## Features
- Real technical analysis (RSI, MACD, volume) from Binance
- Live crypto news (CoinDesk + Google News FA)
- Real track record with auto-evaluation (+9% / -3% within 72h)
- Auto signals every 4 hours (Deno Cron)
- Multi-model AI chat: GLM default + OpenRouter free models (/models, /model orN)
- Automatic fallback to GLM when a model is unavailable
- Persistent storage on Deno KV

## Commands
/price /signal /top /news /stats /models /model /subscribe /unsubscribe

## Deploy (Deno Deploy)
1. App: signalyar-bot (org: kavehir66-coder)
2. Secrets: TELEGRAM_TOKEN, LLM_KEY, OPENROUTER_KEY
3. deno.json: {"unstable": ["kv"]}
4. KV database attached via production.databases deploy binding
5. Visit /set-webhook once to activate the Telegram webhook

Educational signals only - not financial advice.
