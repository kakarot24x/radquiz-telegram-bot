// RADEQuiz Telegram Quiz Bot — Cloudflare Worker version
// --------------------------------------------------------
// Narendra's rules (2026-11-03), same as the Python bot:
//   * EVERYTHING is managed from inside the Telegram group — no other app.
//     Topic -> number of questions -> time per question -> Start, via buttons.
//   * Everything is saved by the bot itself (per-group storage): selections,
//     scores, progress. A restart loses nothing.
//   * NO auto quiz: a quiz runs only when the admin starts one.
//   * /stop (admin) stops a running quiz. /score shows all-time ranking.
//     /ping checks the bot is alive.
// The bot runs on the owner's own Cloudflare account (free plan, no card).
// The question bank lives as small JSON parts in this GitHub repo; the
// Worker fetches only the few parts a quiz needs.

const BANK_BASE =
  "https://raw.githubusercontent.com/kakarot24x/radquiz-telegram-bot/main/bank";
const COUNT_CHOICES = [10, 20, 30, 50, 100];
const SECOND_CHOICES = [10, 15, 20, 30, 45, 60];
const PAGE_SIZE = 8;
const Q_LIMIT = 300, OPT_LIMIT = 100, EXPL_LIMIT = 200;
const MAX_PARTS_PER_QUIZ = 12;
const DEFAULT_COUNT = 50, DEFAULT_SECONDS = 20;

// ------------------------------------------------------------------ helpers
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickSome(arr, n) {
  return shuffle([...arr]).slice(0, n);
}

async function tg(token, method, params = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) clean[k] = v;
  }
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(clean),
  });
  const out = await resp.json().catch(() => null);
  if (!resp.ok || !out || !out.ok) {
    const detail = out ? JSON.stringify(out) : `HTTP ${resp.status}`;
    if (detail.includes("message is not modified")) return true;
    throw new Error(`${method} failed: ${detail}`);
  }
  return out.result;
}

// Anonymous admins act through the GroupAnonymousBot account. A group
// message whose sender_chat is the group itself comes from an anonymous
// admin of that group — treat it as the admin, not as a stranger.
const ANON_ADMIN_ID = 1087968824;
function effectiveSenderId(msg) {
  if (msg?.sender_chat && msg.chat && msg.sender_chat.id === msg.chat.id) {
    return ANON_ADMIN_ID;
  }
  return msg?.from?.id;
}

// Appendix 3A marking: +1 correct, -1/3 wrong, 0 skipped.
// Session entry: [name, correct, wrong, timeSec]; totals: [name, correct, answered, wrong, timeSec].
function ptsOf(e, isTotals) {
  const wrong = isTotals ? (e[3] || 0) : (e[2] || 0);
  return (e[1] || 0) - wrong / 3;
}
function fmtPts(e, isTotals) {
  const v = Math.round(ptsOf(e, isTotals) * 100) / 100;
  return Object.is(v, -0) ? "0" : String(v);
}
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ bank
let _indexCache = null;
let _indexCacheAt = 0;
const INDEX_TTL_MS = 5 * 60 * 1000; // bank updates show up within ~5 minutes
async function loadIndex() {
  if (_indexCache && Date.now() - _indexCacheAt < INDEX_TTL_MS) {
    return _indexCache;
  }
  const resp = await fetch(`${BANK_BASE}/index.json`);
  if (!resp.ok) {
    if (_indexCache) return _indexCache; // serve stale on a transient failure
    throw new Error("bank index fetch failed");
  }
  _indexCache = await resp.json();
  _indexCacheAt = Date.now();
  return _indexCache;
}

async function fetchPart(name) {
  const resp = await fetch(`${BANK_BASE}/${name}`);
  if (!resp.ok) return [];
  return resp.json();
}

// candidate parts for a selection, as [{name, size}]
function candidateParts(index, subjectI, chapterI) {
  const parts = [];
  const addChapter = (ci) => {
    const ch = index.chapters[ci];
    for (let k = 0; k < ch.parts; k++) {
      const size = Math.min(index.part_size,
        ch.count - k * index.part_size);
      parts.push({ name: `p-${ci}-${k}.json`, size });
    }
  };
  if (subjectI === null || subjectI === undefined) {
    index.chapters.forEach((c) => addChapter(c.ci));
  } else if (chapterI === null || chapterI === undefined) {
    index.subjects[subjectI].chapters.forEach(addChapter);
  } else {
    addChapter(chapterI);
  }
  return parts;
}

// Fetch a bounded random subset of parts big enough for `count` questions.
// mode: "all" | "new" (never asked) | "done" (already asked, for revision).
// askedOf(partName) -> Promise<Set of asked indices within that part>.
// Every returned item is tagged with _k = "<part>#<index>" and _ci (chapter).
async function fetchPool(index, subjectI, chapterI, count, mode = "all", askedOf = null) {
  const cand = candidateParts(index, subjectI, chapterI);
  const totalQ = cand.reduce((s, p) => s + p.size, 0);
  const want = Math.max(300, count * 3);
  let chosen = cand;
  if (mode === "done" && askedOf) {
    const withDone = [];
    for (const p of cand) {
      const set = await askedOf(p.name);
      if (set && set.size) withDone.push({ p, n: set.size });
    }
    withDone.sort((a, b) => b.n - a.n);
    chosen = [];
    let acc = 0;
    for (const { p, n } of withDone) {
      if (chosen.length >= 30 || acc >= want) break;
      chosen.push(p);
      acc += n;
    }
  } else if (totalQ > want) {
    chosen = [];
    let acc = 0;
    for (const p of shuffle([...cand])) {
      if (chosen.length >= MAX_PARTS_PER_QUIZ || acc >= want) break;
      chosen.push(p);
      acc += p.size;
    }
  }
  const items = [];
  for (const p of chosen) {
    const qs = await fetchPart(p.name);
    const asked = (mode !== "all" && askedOf) ? await askedOf(p.name) : null;
    qs.forEach((q, i) => {
      const isDone = asked ? asked.has(i) : false;
      if (mode === "new" && isDone) return;
      if (mode === "done" && !isDone) return;
      q._k = `${p.name}#${i}`;
      q._ci = parseInt(p.name.split("-")[1], 10);
      items.push(q);
    });
  }
  return items;
}

// ------------------------------------------------------------- poll payload
// Faithful port of bot.py's build_poll_payload.
// Returns {pre, poll} or {skip: reason}.
function buildPollPayload(item, number, seconds) {
  const optsMap = item.options || {};
  let letters, options;
  if (Array.isArray(optsMap)) {
    letters = optsMap.map((_, i) => String.fromCharCode(65 + i));
    options = optsMap.map(String);
  } else {
    letters = Object.keys(optsMap).sort();
    options = letters.map((l) => String(optsMap[l]));
  }
  if (options.length < 2 || !letters.includes(item.answer)) {
    return { skip: "answer letter not in options / too few options" };
  }
  const correct = letters.indexOf(item.answer);
  let qtext = String(item.q || "").trim();
  let pre = null;
  if (qtext.length > Q_LIMIT) {
    pre = `Question ${number}:\n${qtext}`;
    qtext = qtext.slice(0, Q_LIMIT - 1) + "…";
  }
  const fixed = options.map((o) => {
    o = o.trim();
    return o.length > OPT_LIMIT ? o.slice(0, OPT_LIMIT - 1) + "…" : o;
  });
  if (new Set(fixed).size !== fixed.length) {
    return { skip: "duplicate options" };
  }
  const explanation = `Correct answer: ${item.answer}. ${options[correct]}`
    .slice(0, EXPL_LIMIT);
  let question = `Q${number}. ${qtext}`;
  if (question.length > Q_LIMIT) question = question.slice(0, Q_LIMIT - 1) + "…";
  return {
    pre,
    poll: {
      question,
      options: fixed,
      type: "quiz",
      correct_option_id: correct,
      is_anonymous: false,
      open_period: seconds,
      explanation,
    },
  };
}

function labelFor(index, subjectI, chapterI) {
  if (subjectI === null || subjectI === undefined) {
    return "🎲 Full Bank (Random)";
  }
  const s = index.subjects[subjectI];
  if (chapterI === null || chapterI === undefined) {
    return `${s.icon || "📚"} ${s.name} — All Topics`;
  }
  return `${s.icon || "📚"} ${s.name} — ${index.chapter_titles[chapterI]}`;
}

// ================================================================== worker
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/" && request.method === "GET") {
        return htmlPage(await statusPage(env));
      }
      if (url.pathname === "/setup" && request.method === "POST") {
        return htmlPage(await handleSetup(request, env, url.origin));
      }
      if (url.pathname === "/activate" && request.method === "GET") {
        return htmlPage(await handleActivate(env, url.origin));
      }
      if (url.pathname === "/hook" && request.method === "POST") {
        return await handleHook(request, env, ctx);
      }
      if (url.pathname === "/hook") return new Response("ok");
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response(`error: ${e.message}`, { status: 500 });
    }
  },
};

function htmlPage(body) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RADEQuiz Bot Setup</title></head>
<body style="font-family: system-ui; max-width: 560px; margin: 24px auto; padding: 0 16px;">
${body}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function getConfig(env) {
  const raw = await env.KV.get("config");
  return raw ? JSON.parse(raw) : null;
}

// The bot token can also arrive as a Worker secret named BOT_TOKEN
// (added from the Cloudflare dashboard). That path avoids the setup
// form entirely; the webhook secret is then derived from the token.
const _derivedSecrets = new Map();
async function deriveSecret(token) {
  if (_derivedSecrets.has(token)) return _derivedSecrets.get(token);
  const buf = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const secret = hex.slice(0, 40);
  _derivedSecrets.set(token, secret);
  return secret;
}

async function resolveConfig(env) {
  if (env.BOT_TOKEN) {
    const rawPaste = String(env.BOT_TOKEN);
    const found = rawPaste.match(/\d{6,}:[A-Za-z0-9_-]{30,}/);
    const token = found ? found[0] : rawPaste.trim();
    const kvCfg = await getConfig(env).catch(() => null);
    return {
      token, secret: await deriveSecret(token),
      username: kvCfg ? kvCfg.username : null, viaEnv: true,
    };
  }
  return getConfig(env);
}

async function handleActivate(env, origin) {
  const cfg = await resolveConfig(env);
  if (!cfg) {
    return `<h2>❌ No token found yet</h2>
<p>First add the bot token in the Cloudflare dashboard:
<b>Workers &amp; Pages → radquiz-bot → Settings → Variables and Secrets →
Add → Secret</b>, name it <b>BOT_TOKEN</b> and paste the BotFather token
as its value. Then open this page again.</p>`;
  }
  try {
    const me = await tg(cfg.token, "getMe");
    await tg(cfg.token, "setWebhook", {
      url: `${origin}/hook`,
      secret_token: cfg.secret,
      drop_pending_updates: true,
      allowed_updates: ["message", "callback_query", "poll_answer"],
    });
    await env.KV.put("config", JSON.stringify({
      token: cfg.token, secret: cfg.secret, username: me.username,
    }));
    return `<h2>✅ Bot is Live!</h2>
<p>Bot <b>@${me.username}</b> is now connected to Telegram.</p>
<p>Open the <b>RADEQuiz</b> group and type <b>/ping</b> — the bot will reply.
Then start a quiz with <b>/quiz</b>.</p>`;
  } catch (e) {
    return `<h2>❌ Activation failed</h2>
<p>Telegram did not accept the token stored in BOT_TOKEN.</p>
<p>Check in BotFather (BotFather → /mybots → your bot → API Token) that the
token there matches the BOT_TOKEN value exactly, then open this page again.</p>
<small style="color:#555">Details: ${e.message}</small>`;
  }
}

async function statusPage(env) {
  const cfg = await resolveConfig(env);
  if (cfg && cfg.viaEnv && !cfg.username) {
    return `<h2>🚂 RADEQuiz Bot — One Last Tap</h2>
<p>Your bot token was found. ✅</p>
<p>Tap the button below to connect the bot to Telegram:</p>
<p><a href="/activate" style="display:block; text-align:center;
background:#2f7cf6; color:#fff; padding:14px; border-radius:8px;
font-size:17px; text-decoration:none;">▶ Activate the Bot</a></p>`;
  }
  if (!cfg) {
    return `<h2>🚂 RADEQuiz Bot — First-time Setup</h2>
<p>Paste your <b>bot token</b> from BotFather here, just once. The token
stays safe inside your own Cloudflare account.</p>
<form method="POST" action="/setup">
<input name="token" type="text" placeholder="Paste bot token here"
 autocomplete="off" autocapitalize="off" spellcheck="false"
 style="width:100%; padding:12px; font-size:16px;">
<p style="color:#555">After pasting, you should <b>see</b> the token in the box
above — it starts with about 10 numbers, then a <b>:</b>, then a long line of
letters and numbers. If the box looks empty, the paste did not happen —
long-press the box and tap <b>Paste</b> again.</p>
<button style="width:100%; padding:14px; margin-top:6px; font-size:17px;">
▶ Start the Bot</button></form>`;
  }
  return `<h2>✅ RADEQuiz Bot is Running</h2>
<p>Bot: <b>@${cfg.username || "RADEQuiz"}</b> · Build <b>2026-11-04 v9</b></p>
<p>Now open your Telegram group <b>RADEQuiz</b> and type <b>/quiz</b> —
choose a topic, the number of questions and the timer, and the quiz starts.
Everything is controlled from Telegram itself.</p>
<hr>
<p style="color:#555">To change the token: get a new token from BotFather,
enter the <b>last 6 characters of the current token</b> as the code below,
then paste the new token.</p>
<form method="POST" action="/setup">
<input name="code" placeholder="Last 6 characters of current token"
 style="width:100%; padding:10px; font-size:15px;">
<input name="token" type="password" placeholder="New bot token"
 style="width:100%; padding:10px; font-size:15px; margin-top:8px;">
<button style="width:100%; padding:11px; margin-top:10px; font-size:15px;">
Change Token</button></form>`;
}

async function handleSetup(request, env, origin) {
  const form = await request.formData();
  const rawPaste = String(form.get("token") || "");
  // If the whole BotFather message was pasted by mistake, pull the
  // token itself out of it automatically.
  const found = rawPaste.match(/\d{6,}:[A-Za-z0-9_-]{30,}/);
  const token = found ? found[0] : rawPaste.replace(/\s+/g, "");
  if (!token) {
    return `❌ The token box was empty. Please go back and paste the token.`;
  }
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    return `❌ This does not look like a bot token. A bot token looks like
<code>123456789:AAE...</code> — a number, then a colon (:), then letters.
Please copy it again from BotFather (BotFather → /mybots → your bot →
API Token) and paste it carefully.`;
  }
  const existing = await getConfig(env);
  if (existing) {
    const code = String(form.get("code") || "").trim();
    if (code !== existing.token.slice(-6)) {
      return "❌ Wrong code — the last 6 characters of the current token are needed. The token was not changed.";
    }
  }
  let me;
  try {
    me = await tg(token, "getMe");
  } catch (e) {
    return `❌ Telegram did not accept this token.<br>
Please open BotFather → /mybots → your RADEQuiz bot → <b>API Token</b>,
copy the token shown there exactly, and try again.<br>
<small style="color:#555">Details: ${e.message}</small>`;
  }
  const secret = [...crypto.getRandomValues(new Uint8Array(18))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const cfg = { token, secret, username: me.username };
  await env.KV.put("config", JSON.stringify(cfg));
  await tg(token, "setWebhook", {
    url: `${origin}/hook`,
    secret_token: secret,
    drop_pending_updates: true,
    allowed_updates: ["message", "callback_query", "poll_answer"],
  });
  return `<h2>✅ Done!</h2>
<p>Bot <b>@${me.username}</b> is now running and connected to Telegram.</p>
<p>Now type <b>/ping</b> in the <b>RADEQuiz</b> group — the bot will reply.
Then start your first quiz with <b>/quiz</b>.</p>
<p style="color:#555">Do not share this page's address (URL) with anyone —
the bot is set up from here.</p>`;
}

async function handleHook(request, env, ctx) {
  const cfg = await resolveConfig(env);
  if (!cfg) return new Response("ok");
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== cfg.secret) return new Response("forbidden", { status: 403 });
  const update = await request.json();

  if (update.poll_answer) {
    const chatId = await env.KV.get(`pollmap:${update.poll_answer.poll_id}`);
    if (chatId) {
      const stub = env.QUIZ.get(env.QUIZ.idFromName(String(chatId)));
      ctx.waitUntil(stub.fetch("https://do/poll_answer", {
        method: "POST", body: JSON.stringify(update.poll_answer),
      }));
    }
    return new Response("ok");
  }
  if (update.callback_query) {
    const chatId = update.callback_query.message?.chat?.id;
    if (chatId) {
      const stub = env.QUIZ.get(env.QUIZ.idFromName(String(chatId)));
      ctx.waitUntil(stub.fetch("https://do/callback", {
        method: "POST", body: JSON.stringify(update.callback_query),
      }));
    }
    return new Response("ok");
  }
  const msg = update.message;
  if (msg && msg.chat && ["group", "supergroup"].includes(msg.chat.type)) {
    const text = (msg.text || "").split("@")[0].trim();
    if (text === "/ping") {
      ctx.waitUntil(tg(cfg.token, "sendMessage", {
        chat_id: msg.chat.id, text: "✅ RADEQuiz bot is live!",
      }).catch(() => {}));
      return new Response("ok");
    }
    if (["/quiz", "/stop", "/score", "/settings"].includes(text)) {
      const stub = env.QUIZ.get(env.QUIZ.idFromName(String(msg.chat.id)));
      ctx.waitUntil(stub.fetch("https://do/message", {
        method: "POST", body: JSON.stringify(msg),
      }));
    }
  }
  return new Response("ok");
}

// ============================================================ Durable Object
export class QuizRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this._token = null;
  }

  async token() {
    if (!this._token) {
      const cfg = await resolveConfig(this.env);
      if (!cfg) throw new Error("bot is not configured yet");
      this._token = cfg.token;
    }
    return this._token;
  }

  async call(method, params) {
    return tg(await this.token(), method, params);
  }

  async send(chatId, text, keyboard) {
    return this.call("sendMessage", {
      chat_id: chatId, text,
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  }

  async edit(chatId, messageId, text, keyboard) {
    return this.call("editMessageText", {
      chat_id: chatId, message_id: messageId, text,
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  }

  async answerCb(id, text) {
    try {
      await this.call("answerCallbackQuery", {
        callback_query_id: id, text,
      });
    } catch (e) { /* ignore */ }
  }

  async isAdmin(chatId, userId) {
    if (userId === ANON_ADMIN_ID) return true; // anonymous admin of this chat
    const key = `admin:${userId}`;
    const cached = await this.state.storage.get(key);
    if (cached && Date.now() - cached[1] < 10 * 60 * 1000) return cached[0];
    let ok = false;
    try {
      const m = await this.call("getChatMember", {
        chat_id: chatId, user_id: userId,
      });
      ok = ["creator", "administrator"].includes(m.status);
    } catch (e) { ok = false; }
    await this.state.storage.put(key, [ok, Date.now()]);
    return ok;
  }

  // ------------------------------------------------------------ routing
  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      const body = await request.json();
      if (path === "/message") await this.onMessage(body);
      else if (path === "/callback") await this.onCallback(body);
      else if (path === "/poll_answer") await this.onPollAnswer(body);
    } catch (e) {
      console.log("room error:", e.message);
    }
    return new Response("ok");
  }

  async onMessage(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || "").split("@")[0].trim();
    const sender = effectiveSenderId(msg);
    if (text === "/quiz") {
      const session = await this.state.storage.get("session");
      if (session) {
        await this.send(chatId, "⏳ Quiz is already running — please wait for it to finish.");
      } else if (sender && await this.isAdmin(chatId, sender)) {
        await this.startFlow(chatId, sender);
      } else {
        await this.send(chatId, "Only a group admin can start a quiz.");
      }
    } else if (text === "/stop") {
      const session = await this.state.storage.get("session");
      if (session && sender && await this.isAdmin(chatId, sender)) {
        session.stop = true;
        await this.state.storage.put("session", session);
        await this.send(chatId, "🛑 Stopping the quiz after this question…");
      } else if (session) {
        await this.send(chatId, "Only a group admin can stop the quiz.");
      }
    } else if (text === "/score") {
      const totals = (await this.state.storage.get("scores")) || {};
      const vals = Object.values(totals);
      if (vals.length) {
        const ranked = vals
          .sort((a, b) => (ptsOf(b, true) - ptsOf(a, true)) || ((a[4] || 0) - (b[4] || 0)))
          .slice(0, 10);
        const lines = ["🏆 All-time Ranking (saved by the bot):"];
        ranked.forEach((t, i) => lines.push(`${i + 1}. ${t[0]} — ${fmtPts(t, true)} pts · ✓${t[1] || 0} ✗${t[3] || 0} · ⏱ ${fmtTime(t[4] || 0)}`));
        await this.send(chatId, lines.join("\n"));
      } else {
        await this.send(chatId, "No scores saved yet.");
      }
    } else if (text === "/settings") {
      await this.send(chatId, "⚙️ Auto quiz has been removed — a quiz now starts only with /quiz, whenever you want.");
    }
  }

  // ------------------------------------------------------------ flow UI
  btn(text, data) { return { text, callback_data: data }; }

  subjectsKeyboard(meta) {
    const rows = [];
    if (meta.lastSelection) {
      const l = meta.lastSelection;
      rows.push([this.btn(`🔁 Repeat Last: ${l.label} • ${l.count}Q • ${l.seconds}s`, "repeat")]);
    }
    rows.push([this.btn(`⚡ Default Quiz — Full Bank Random • ${DEFAULT_COUNT}Q • ${DEFAULT_SECONDS}s`, "default")]);
    return rows;
  }

  async subjectsKeyboardFull(meta, index) {
    const rows = this.subjectsKeyboard(meta);
    index.subjects.forEach((s, i) => {
      rows.push([this.btn(`${s.icon || "📚"} ${s.name} (${s.questions} Q)`, `sub:${i}`)]);
    });
    rows.push([this.btn("❌ Cancel", "cancel")]);
    return rows;
  }

  chaptersKeyboard(index, flow, counts = {}) {
    const s = index.subjects[flow.subject];
    // Hide chapters with 0 questions (section/divider chapters in the bank,
    // mostly in Appendix 3 and Archive) — they can never start a quiz.
    const chapters = s.chapters.filter((ci) => (index.chapter_counts[ci] || 0) > 0);
    const pages = Math.max(1, Math.ceil(chapters.length / PAGE_SIZE));
    flow.page = Math.min(flow.page || 0, pages - 1);
    const rows = [[this.btn(`🎲 All Topics of ${s.name} (Random)`, "top:all")]];
    for (const ci of chapters.slice(flow.page * PAGE_SIZE, (flow.page + 1) * PAGE_SIZE)) {
      let t = index.chapter_titles[ci];
      if (t.length > 32) t = t.slice(0, 31) + "…";
      const done = counts[ci] || 0;
      rows.push([this.btn(`${t} (${index.chapter_counts[ci]} Q${done ? ` · ✓${done} done` : ""})`, `top:${ci}`)]);
    }
    const nav = [];
    if (flow.page > 0) nav.push(this.btn("⬅️ Prev", `page:${flow.page - 1}`));
    if (flow.page < pages - 1) nav.push(this.btn("Next ➡️", `page:${flow.page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([this.btn("⬅️ Back to Subjects", "back:subjects"),
               this.btn("❌ Cancel", "cancel")]);
    return rows;
  }

  // --------------------------------------- asked-question tracking (per group)
  async askedSet(partName) {
    const arr = await this.state.storage.get(`asked:${partName}`);
    return new Set(arr || []);
  }

  // Record questions a started quiz actually used. `pairs`: [{part, idx, ci}].
  async recordAsked(pairs) {
    const byPart = new Map();
    for (const { part, idx, ci } of pairs) {
      if (!byPart.has(part)) {
        byPart.set(part, { set: await this.askedSet(part), ci, added: 0 });
      }
      const e = byPart.get(part);
      if (!e.set.has(idx)) { e.set.add(idx); e.added += 1; }
    }
    const counts = (await this.state.storage.get("askedCounts")) || {};
    for (const [part, e] of byPart) {
      if (!e.added) continue;
      await this.state.storage.put(`asked:${part}`,
        [...e.set].sort((a, b) => a - b));
      counts[e.ci] = (counts[e.ci] || 0) + e.added;
    }
    await this.state.storage.put("askedCounts", counts);
  }

  async doneInScope(index, subjectI, chapterI) {
    const counts = (await this.state.storage.get("askedCounts")) || {};
    if (chapterI !== null && chapterI !== undefined) return counts[chapterI] || 0;
    if (subjectI !== null && subjectI !== undefined) {
      return index.subjects[subjectI].chapters
        .reduce((s, ci) => s + (counts[ci] || 0), 0);
    }
    return Object.values(counts).reduce((s, n) => s + n, 0);
  }

  async startFlow(chatId, userId) {
    const index = await loadIndex();
    const meta = (await this.state.storage.get("meta")) || {};
    const flow = {
      owner: userId, step: "subjects", messageId: null,
      subject: null, chapter: null, page: 0, count: null, seconds: null,
      mode: null,
    };
    const sent = await this.send(chatId, "📚 Quiz Setup — first choose a Subject:",
      await this.subjectsKeyboardFull(meta, index));
    flow.messageId = sent.message_id;
    await this.state.storage.put("flow", flow);
  }

  async showStep(chatId) {
    const flow = await this.state.storage.get("flow");
    if (!flow) return;
    const index = await loadIndex();
    const meta = (await this.state.storage.get("meta")) || {};
    const mid = flow.messageId;
    if (flow.step === "subjects") {
      await this.edit(chatId, mid, "📚 Quiz Setup — first choose a Subject:",
        await this.subjectsKeyboardFull(meta, index));
    } else if (flow.step === "chapters") {
      const s = index.subjects[flow.subject];
      const counts = (await this.state.storage.get("askedCounts")) || {};
      await this.edit(chatId, mid, `${s.icon || "📚"} ${s.name} — now choose a Topic:`,
        this.chaptersKeyboard(index, flow, counts));
      await this.state.storage.put("flow", flow); // page clamp saved
    } else if (flow.step === "mode") {
      const label = labelFor(index, flow.subject, flow.chapter);
      const cand = candidateParts(index, flow.subject, flow.chapter);
      const total = cand.reduce((s2, p) => s2 + p.size, 0);
      const done = await this.doneInScope(index, flow.subject, flow.chapter);
      const rows = [
        [this.btn(`🆕 New Questions (${total - done} left)`, "mode:new")],
        [this.btn(`🔁 Completed Questions (${done} done)`, "mode:done")],
        [this.btn(`🎲 All Questions (${total})`, "mode:all")],
        [this.btn("⬅️ Back", "back:chapters"), this.btn("❌ Cancel", "cancel")],
      ];
      await this.edit(chatId, mid,
        `✅ Topic: ${label}\nWhich questions should the quiz use?`, rows);
    } else if (flow.step === "count") {
      const label = labelFor(index, flow.subject, flow.chapter);
      const rows = COUNT_CHOICES.map((n) => [this.btn(`${n} Questions`, `cnt:${n}`)]);
      rows.push([this.btn("⬅️ Back", "back:mode"), this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid, `✅ Topic: ${label}\nHow many questions?`, rows);
    } else if (flow.step === "seconds") {
      const rows = SECOND_CHOICES.map((n) => [this.btn(`${n} seconds / question`, `sec:${n}`)]);
      rows.push([this.btn("⬅️ Back", "back:count"), this.btn("❌ Cancel", "cancel")]);
      await this.edit(chatId, mid, "⏱️ How much time per question?", rows);
    } else if (flow.step === "confirm") {
      const label = labelFor(index, flow.subject, flow.chapter);
      const cand = candidateParts(index, flow.subject, flow.chapter);
      const total = cand.reduce((s2, p) => s2 + p.size, 0);
      let poolSize = total;
      if (flow.mode === "new" || flow.mode === "done") {
        const done = await this.doneInScope(index, flow.subject, flow.chapter);
        poolSize = flow.mode === "new" ? total - done : done;
      }
      const count = Math.min(flow.count, poolSize);
      const modeName = { new: "🆕 New Questions", done: "🔁 Completed Questions", all: "🎲 All Questions" }[flow.mode || "all"];
      const text = `🚀 Quiz is ready:\n📚 ${label}\n🎯 ${modeName}\n📌 ${count} questions (pool: ${poolSize})\n⏱️ ${flow.seconds} seconds per question\n\nStart the quiz?`;
      await this.edit(chatId, mid, text,
        [[this.btn("▶️ START QUIZ", "start"), this.btn("❌ Cancel", "cancel")]]);
    }
  }

  async onCallback(cq) {
    const chatId = cq.message?.chat?.id;
    if (!chatId) return;
    const data = cq.data || "";
    const userId = cq.from?.id;
    let flow = await this.state.storage.get("flow");
    if (!flow) {
      await this.answerCb(cq.id, "No quiz setup is open. Type /quiz to start one.");
      return;
    }
    if (userId !== flow.owner) {
      // Telegram reports an anonymous admin under a different identity for
      // button taps than for messages, so the same person can mismatch their
      // own flow. A setup can only be created by an admin anyway — let any
      // admin operate it; members stay refused.
      const tapperAdmin = userId && (await this.isAdmin(chatId, userId));
      const ownerAdmin = flow.owner === ANON_ADMIN_ID ||
        (flow.owner && (await this.isAdmin(chatId, flow.owner)));
      if (!(tapperAdmin && ownerAdmin)) {
        await this.answerCb(cq.id, "This selection is only for the admin who started the setup.");
        return;
      }
    }
    const index = await loadIndex();

    if (data === "cancel") {
      await this.state.storage.delete("flow");
      await this.edit(chatId, flow.messageId, "❌ Quiz setup cancelled.");
      await this.answerCb(cq.id);
      return;
    }
    if (data === "repeat" || data === "default") {
      const meta = (await this.state.storage.get("meta")) || {};
      await this.state.storage.delete("flow");
      if (data === "repeat" && meta.lastSelection) {
        const l = meta.lastSelection;
        await this.edit(chatId, flow.messageId, "🔁 Starting the last quiz again…");
        await this.answerCb(cq.id);
        await this.startSession(chatId, l.label, l.subject, l.chapter, l.count, l.seconds, l.mode || "all");
      } else if (data === "default") {
        await this.edit(chatId, flow.messageId, "⚡ Starting the default quiz…");
        await this.answerCb(cq.id);
        await this.startSession(chatId, "🎲 Full Bank (Random)", null, null, DEFAULT_COUNT, DEFAULT_SECONDS);
      } else {
        await this.answerCb(cq.id);
      }
      return;
    }
    if (data === "start") {
      const label = labelFor(index, flow.subject, flow.chapter);
      const meta = (await this.state.storage.get("meta")) || {};
      meta.lastSelection = {
        subject: flow.subject, chapter: flow.chapter,
        count: flow.count, seconds: flow.seconds, label,
        mode: flow.mode || "all",
      };
      await this.state.storage.put("meta", meta);
      await this.state.storage.delete("flow");
      await this.edit(chatId, flow.messageId, `▶️ Starting the quiz — ${label}`);
      await this.answerCb(cq.id);
      await this.startSession(chatId, label, flow.subject, flow.chapter, flow.count, flow.seconds, flow.mode || "all");
      return;
    }
    if (data.startsWith("sub:")) {
      flow.subject = parseInt(data.slice(4), 10);
      flow.chapter = null; flow.page = 0; flow.step = "chapters";
    } else if (data.startsWith("page:")) {
      flow.page = parseInt(data.slice(5), 10);
    } else if (data.startsWith("top:")) {
      const v = data.slice(4);
      flow.chapter = v === "all" ? null : parseInt(v, 10);
      flow.step = "mode";
    } else if (data.startsWith("mode:")) {
      flow.mode = data.slice(5);
      flow.step = "count";
    } else if (data.startsWith("cnt:")) {
      flow.count = parseInt(data.slice(4), 10);
      flow.step = "seconds";
    } else if (data.startsWith("sec:")) {
      flow.seconds = parseInt(data.slice(4), 10);
      flow.step = "confirm";
    } else if (data === "back:subjects") {
      flow.step = "subjects";
    } else if (data === "back:chapters") {
      flow.step = "chapters";
    } else if (data === "back:count") {
      flow.step = "count";
    } else if (data === "back:mode") {
      flow.step = "mode";
    } else {
      await this.answerCb(cq.id);
      return;
    }
    await this.state.storage.put("flow", flow);
    await this.answerCb(cq.id);
    await this.showStep(chatId);
  }

  // ------------------------------------------------------------ session
  async startSession(chatId, label, subjectI, chapterI, count, seconds, mode = "all") {
    const index = await loadIndex();
    const askedOf = (name) => this.askedSet(name);
    const pool = await fetchPool(index, subjectI, chapterI, count, mode, askedOf);
    const items = shuffle(pool);
    const payloads = [];
    const usedKeys = [];
    for (const item of items) {
      if (payloads.length >= count) break;
      const built = buildPollPayload(item, payloads.length + 1, seconds);
      if (built.skip) continue;
      payloads.push(built);
      if (item._k) {
        const [part, idx] = item._k.split("#");
        usedKeys.push({ part, idx: parseInt(idx, 10), ci: item._ci });
      }
    }
    if (!payloads.length) {
      const msg = mode === "new"
        ? "✅ No new questions left here — every question is already completed. Try Completed Questions or All Questions."
        : mode === "done"
          ? "No completed questions here yet — run a New Questions quiz first."
          : "⚠️ No quiz-worthy questions found in this topic.";
      await this.send(chatId, msg);
      return;
    }
    if (usedKeys.length) await this.recordAsked(usedKeys);
    const session = {
      chatId, label, seconds, items: payloads, idx: 0,
      scores: {}, pollMap: {}, pollSentAt: {}, answered: {},
      stop: false, asked: 0,
    };
    await this.state.storage.put("session", session);
    const modeLine = mode === "new" ? "\n🎯 Mode: 🆕 New questions only"
      : mode === "done" ? "\n🎯 Mode: 🔁 Completed questions (revision)" : "";
    await this.send(chatId,
      `🚂 RADEQuiz — ${label}\n📌 ${payloads.length} questions • ⏱️ ${seconds} seconds each${modeLine}\n📝 Marking (Appendix 3A): +1 correct • −⅓ wrong • 0 skipped\n🏆 Ranking at the end. All the best!`);
    await this.sendCurrent(session);
  }

  async sendCurrent(session) {
    const built = session.items[session.idx];
    if (built.pre) {
      try { await this.send(session.chatId, built.pre); } catch (e) { /* skip */ }
    }
    const sent = await this.call("sendPoll", {
      chat_id: session.chatId, ...built.poll,
    });
    session.pollMap[sent.poll.id] = built.poll.correct_option_id;
    (session.pollSentAt ||= {})[sent.poll.id] = Date.now();
    session.asked += 1;
    session.idx += 1;
    await this.state.storage.put("session", session);
    await this.env.KV.put(`pollmap:${sent.poll.id}`, String(session.chatId));
    await this.state.storage.setAlarm(Date.now() + (session.seconds + 2) * 1000);
  }

  async alarm() {
    const session = await this.state.storage.get("session");
    if (!session) return;
    if (session.stop || session.idx >= session.items.length) {
      await this.finishSession(session);
      return;
    }
    try {
      await this.sendCurrent(session);
    } catch (e) {
      console.log("sendPoll failed, skipping:", e.message);
      session.idx += 1;
      await this.state.storage.put("session", session);
      await this.state.storage.setAlarm(Date.now() + 500);
    }
  }

  async finishSession(session) {
    await this.state.storage.delete("session");
    const meta = (await this.state.storage.get("meta")) || {};
    meta.sessionsDone = (meta.sessionsDone || 0) + 1;
    await this.state.storage.put("meta", meta);
    const entries = Object.values(session.scores);
    let resultText;
    if (entries.length) {
      const ranked = entries
        .sort((a, b) => (ptsOf(b) - ptsOf(a)) || ((a[3] || 0) - (b[3] || 0)))
        .slice(0, 10);
      const medals = ["🥇", "🥈", "🥉"];
      const lines = ["🏆 Ranking (score • time taken):"];
      ranked.forEach((e, i) => {
        lines.push(`${i < 3 ? medals[i] : `${i + 1}.`} ${e[0]} — ${fmtPts(e)} pts · ✓${e[1] || 0} ✗${e[2] || 0} · ⏱ ${fmtTime(e[3] || 0)}`);
      });
      resultText = lines.join("\n");
    } else {
      resultText = "No answers were recorded in this quiz.";
    }
    const head = session.stop ? "🛑 Quiz stopped." : "✅ Quiz finished!";
    await this.send(session.chatId, `${head} ${session.asked} questions done.\n\n${resultText}`);
  }

  async onPollAnswer(pa) {
    const session = await this.state.storage.get("session");
    if (!session) return;
    const correct = session.pollMap[pa.poll_id];
    if (correct === undefined) return;
    if (!pa.option_ids || !pa.option_ids.length) return; // vote retract: ignore
    const user = pa.user;
    session.answered ||= {};
    const akey = `${pa.poll_id}:${user.id}`;
    if (session.answered[akey]) return; // first answer only (exam rule)
    session.answered[akey] = 1;
    const sentAt = (session.pollSentAt || {})[pa.poll_id];
    let elapsed = sentAt ? Math.round((Date.now() - sentAt) / 1000) : 0;
    if (elapsed < 0) elapsed = 0;
    if (elapsed > session.seconds) elapsed = session.seconds;
    // entry/totals format: [name, correct, wrong, timeSec] (totals: [name, correct, answered, wrong, timeSec])
    let entry = session.scores[user.id];
    if (!entry || entry.length < 4) {
      entry = session.scores[user.id] =
        [user.first_name || "Player", (entry && entry[1]) || 0, 0, 0];
    }
    entry[0] = user.first_name || entry[0];
    const totals = (await this.state.storage.get("scores")) || {};
    let tot = totals[user.id];
    if (!tot || tot.length < 5) {
      tot = totals[user.id] =
        [user.first_name || "Player", (tot && tot[1]) || 0, (tot && tot[2]) || 0, 0, 0];
    }
    tot[0] = user.first_name || tot[0];
    tot[2] += 1;
    if (JSON.stringify(pa.option_ids) === JSON.stringify([correct])) {
      entry[1] += 1; tot[1] += 1;
    } else {
      entry[2] += 1; tot[3] += 1;
    }
    entry[3] += elapsed; tot[4] += elapsed;
    await this.state.storage.put("session", session);
    await this.state.storage.put("scores", totals);
  }
}
