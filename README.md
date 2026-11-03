# RADEQuiz Telegram Bot — Cloudflare version

RADEQuiz group ke liye quiz bot, jo owner ke **apne Cloudflare (free)
account** par chalta hai. Na Termux, na PC, na kisi aur ka server.

## Chalana kaise hai
- Saara control Telegram group se: `/quiz` → Subject → Topic →
  sawalo ki ginati (10/20/30/50/100) → timer (10/20/30/45/60 sec) → Start.
- `/stop` (admin) chalta quiz rokta hai. `/score` all-time ranking
  (bot me saved). `/ping` liveness check.
- Auto quiz NAHI hai — quiz sirf admin ke chalane par chalta hai.
- Questions bot me hi save rehte hain: poora bank (80,697 sawal)
  `bank/` folder me topic-wise chhote tukdo (parts) me rakha hai;
  bot quiz ke samay sirf zaroori tukde padhta hai.

## Files
- `worker.js` — poora bot (Cloudflare Worker + Durable Object session).
- `wrangler.toml` — Cloudflare config (KV + Durable Object bindings).
- `bank/index.json` + `bank/p-<chapter>-<part>.json` — question bank parts.
- `split_bank.py` — bank dobara baantne ke liye (app ke questions.json se).

## Setup (one-time)
1. Cloudflare par free account (email se, card nahi).
2. Is repo ko Worker se jodo (Workers → Create → Import/GitHub),
   naam: `radquiz-bot`.
3. Ek KV namespace banao aur uski id `wrangler.toml` me dalo.
4. Worker ke address (URL) ko browser me kholo — wahan bot token
   ek baar bharne ka form milega. Token bharte hi bot Telegram se
   jud jayega aur group me `/quiz` chalne lagega.
