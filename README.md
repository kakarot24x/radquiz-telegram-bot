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
- `bank_check.py` — **har bank badlav ke baad, push se pehle chalao.**
  Poora bank check karke `BANK-HEALTH.md` + `quarantine.json` banata hai.
- `add_ids.py` / `add_explanations.py` / `add_telegram.py` — neeche wali
  pipeline ke steps.

## Bank pipeline (ek hi asal source — app ka questions.json)
Parts ko KABHI haath se edit mat karo. Sudhaar hamesha asal source
(app questions.json / master / TG source) me karo, phir:
```
python3 split_bank.py && python3 add_telegram.py && python3 add_ids.py \
    && python3 add_explanations.py && python3 make_search_index.py \
    && python3 bank_check.py
```
`bank_check.py` ki HARD problems 0 honi chahiye tabhi push karo.
Har part item me `i` = sawal ki pakki ID hai (main bank = app wala
qidOf hash; Telegram chapters = asal TG_Q id) — sudhaar ID se khojo.
`bank/search.json` Telegram wale /edit editor ki khoj-soochi hai
(make_search_index.py banata hai).

## Telegram editor ke edits (/edit, v15)
Admin bot ke DM me `/edit` se sawal khoj kar sudhaar sakta hai. Wo
sudhaar bank files me NAHI jaate — KV ke `edits_all` me ID ke saath
save hote hain aur har quiz bante samay sawal par lag jaate hain
(bot me turant live). `/edits` se unki file (radequiz-edits.json)
export hoti hai — use asal bank (app questions.json / TG sources)
me mila kar pipeline chalao, phir bot me `/edits` → Clear kar do.

## Setup (one-time)
1. Cloudflare par free account (email se, card nahi).
2. Is repo ko Worker se jodo (Workers → Create → Import/GitHub),
   naam: `radquiz-bot`.
3. Ek KV namespace banao aur uski id `wrangler.toml` me dalo.
4. Worker ke address (URL) ko browser me kholo — wahan bot token
   ek baar bharne ka form milega. Token bharte hi bot Telegram se
   jud jayega aur group me `/quiz` chalne lagega.

## Keyword Quiz (v17)
/quiz setup me "🔑 Keyword Quiz": admin keyword type karta hai (setup
message ke baad wala message), bot search.json se matching sawal
ginata hai — kul/✅ Completed/🆕 Pending ke saath — count chunta hai;
aise hi aur keyword jod sakta hai. Mode (New/Completed/All) poore
keyword-mix par lagta hai; sawal har keyword ke matches se uski
ginati me aakar shuffle hote hain; Repeat Last me bhi rehta hai.
Group aur DM (private setup) dono me chalta hai.

## Akaza bot (v19) — dusri deployment, wahi code
Ek hi codebase do bot chalata hai. Jis deployment ke bot username me
"akaza" hoga (setup par getMe se apne aap pakda jata hai), wo Akaza
flavor me chalegi: group commands /maheshquiz, /maheshstop, /maheshscore, /maheshedit,
/maheshping, /maheshauto; bare /quiz, /stop, /score par wo chup rehti
hai taaki main bot se takraav na ho. DM me sab kuchh waisa hi (/quiz
private setup, /edit, /edits). Quiz announcement par "👹 Akaza" brand.
Dusri Cloudflare account ke liye `wrangler.akaza.toml` hai — Builds ka
Deploy command: `npx wrangler deploy -c wrangler.akaza.toml`, aur nayi
KV ki id us file me bharni hoti hai. Bank dono ka ek hi hai (yehi
repo), ranking/progress har bot ka apna hota hai.
