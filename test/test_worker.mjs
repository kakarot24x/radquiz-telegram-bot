// Offline test for the Cloudflare Worker bot: fake Telegram API + fake
// KV / Durable Object storage. Run: node test/test_worker.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
fs.copyFileSync(path.join(ROOT, "worker.js"), path.join(ROOT, "test/worker.mjs"));
const { default: worker, QuizRoom } = await import("./worker.mjs");

// ---------------------------------------------------------------- fake TG
const calls = [];
let midSeq = 1000, pollSeq = 0;
const ADMIN = 111, PLAYER = 222, CHAT = -100123;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith("https://api.telegram.org/")) {
    const method = u.split("/").pop();
    let params = {};
    try { params = opts.body ? JSON.parse(opts.body) : {}; } catch (e) { params = {}; }
    calls.push({ method, params });
    const ok = (result) => new Response(JSON.stringify({ ok: true, result }),
      { headers: { "Content-Type": "application/json" } });
    if (method === "getMe") return ok({ id: 1, username: "RADEQuizBot" });
    if (method === "sendMessage") return ok({ message_id: ++midSeq, chat: { id: params.chat_id } });
    if (method === "sendPoll") {
      return ok({ message_id: ++midSeq, poll: { id: "poll" + (++pollSeq) } });
    }
    if (method === "getChatMember") {
      return ok({ status: params.user_id === ADMIN ? "administrator" : "member" });
    }
    return ok(true);
  }
  if (u.includes("raw.githubusercontent.com")) {
    const rel = u.split("/bank/")[1];
    const file = path.join(ROOT, "bank", rel);
    if (!fs.existsSync(file)) return new Response("nf", { status: 404 });
    return new Response(fs.readFileSync(file), {
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error("unexpected fetch: " + u);
};

// ---------------------------------------------------------------- shims
class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); }
}
class FakeStorage {
  constructor() { this.m = new Map(); this.alarm = null; }
  async get(k) { return this.m.get(k); }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  async setAlarm(t) { this.alarm = t; }
}
const kv = new FakeKV();
const rooms = new Map();
const env = { KV: kv, QUIZ: null };
function getRoom(chatId) {
  if (!rooms.has(chatId)) {
    const room = new QuizRoom({ storage: new FakeStorage() }, env);
    rooms.set(chatId, room);
  }
  return rooms.get(chatId);
}
env.QUIZ = {
  idFromName: (n) => n,
  get: (id) => ({
    fetch: async (url, opts) => getRoom(Number(id)).fetch(new Request(url, opts)),
  }),
};
let pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
async function drain() { while (pending.length) await Promise.all(pending.splice(0)); }

async function hook(update, secret) {
  const res = await worker.fetch(new Request("https://x/hook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(update),
  }), env, ctx);
  await drain();
  return res;
}
const msg = (text, from = ADMIN) => ({
  message: { message_id: 1, chat: { id: CHAT, type: "supergroup" },
             from: { id: from, first_name: from === ADMIN ? "Boss" : "Ram" },
             text },
});
const cb = (data, mid, from = ADMIN) => ({
  callback_query: { id: "cb" + Math.random(), data, from: { id: from },
                    message: { message_id: mid, chat: { id: CHAT } } },
});
function lastCall(method) {
  const cs = calls.filter((c) => c.method === method);
  return cs[cs.length - 1];
}
let failures = 0;
function check(name, cond) {
  console.log((cond ? "PASS" : "FAIL") + " — " + name);
  if (!cond) failures++;
}

// ---------------------------------------------------------------- scenario
// 1. setup page + token submit
let res = await worker.fetch(new Request("https://x/"), env, ctx);
let body = await res.text();
check("setup page shows token form", body.includes('name="token"'));

const form = new FormData();
form.set("token", "111222:AAEfake-token-for-test");
res = await worker.fetch(new Request("https://x/setup", {
  method: "POST", body: form,
}), env, ctx);
body = await res.text();
check("setup success page", body.includes("Done!") && body.includes("@RADEQuizBot"));
check("webhook registered", calls.some((c) => c.method === "setWebhook"));
const cfg = JSON.parse(await kv.get("config"));

// 2. /ping
await hook(msg("/ping"), cfg.secret);
check("/ping replies live", lastCall("sendMessage")?.params.text.includes("bot is live"));

// 3. /quiz flow — subjects
await hook(msg("/quiz"), cfg.secret);
let kb = lastCall("sendMessage")?.params.reply_markup?.inline_keyboard || [];
check("subjects keyboard has default + sub:0",
  kb.flat().some((b) => b.callback_data === "default") &&
  kb.flat().some((b) => b.callback_data === "sub:0"));
let flowMid = lastCall("sendMessage") ? midSeq : 0;

// non-owner tap must be refused
await hook(cb("sub:0", flowMid, PLAYER), cfg.secret);
check("non-owner tap refused",
  lastCall("answerCallbackQuery")?.params.text?.includes("only for the admin who started"));

// 4. chapters -> pick first topic
await hook(cb("sub:0", flowMid), cfg.secret);
kb = lastCall("editMessageText")?.params.reply_markup?.inline_keyboard || [];
const topBtn = kb.flat().find((b) => b.callback_data.startsWith("top:") && b.callback_data !== "top:all");
check("chapters keyboard has topics", !!topBtn);
const room = getRoom(CHAT);

// 5. topic -> count -> seconds -> confirm -> start
await hook(cb(topBtn.callback_data, flowMid), cfg.secret);
check("mode step after topic", lastCall("editMessageText")?.params.text.includes("Which questions"));
const modeKb = lastCall("editMessageText").params.reply_markup.inline_keyboard;
check("mode buttons with counts", modeKb.flat().some((b) => b.callback_data === "mode:new") &&
  modeKb.flat().some((b) => b.text.includes("New Questions (20 left)")));
await hook(cb("mode:all", flowMid), cfg.secret);
check("count step", lastCall("editMessageText")?.params.text.includes("How many questions"));
await hook(cb("cnt:10", flowMid), cfg.secret);
check("seconds step", lastCall("editMessageText")?.params.text.includes("How much time per question"));
const secKb = lastCall("editMessageText")?.params.reply_markup?.inline_keyboard || [];
check("15 seconds option present", secKb.flat().some((b) => b.callback_data === "sec:15"));
await hook(cb("sec:10", flowMid), cfg.secret);
check("confirm step", lastCall("editMessageText")?.params.text.includes("Start the quiz?"));
await hook(cb("start", flowMid), cfg.secret);
check("intro sent", calls.some((c) => c.method === "sendMessage" && c.params.text.includes("RADEQuiz —")));
let pollCall = lastCall("sendPoll");
check("first poll sent as quiz, non-anonymous, 10s",
  pollCall?.params.type === "quiz" && pollCall?.params.is_anonymous === false &&
  pollCall?.params.open_period === 10);

// 6. answer polls + drive alarms to finish (10 questions)
let answered = 0;
for (let round = 0; round < 12; round++) {
  const session = room.state.storage.m.get("session");
  if (!session) break;
  const pollIds = Object.keys(session.pollMap);
  const pid = pollIds[pollIds.length - 1];
  const correct = session.pollMap[pid];
  // admin answers correctly, player answers wrong (if >1 option)
  await hook({ poll_answer: { poll_id: pid, user: { id: ADMIN, first_name: "Boss" }, option_ids: [correct] } }, cfg.secret);
  await hook({ poll_answer: { poll_id: pid, user: { id: PLAYER, first_name: "Ram" }, option_ids: [(correct + 1) % 4] } }, cfg.secret);
  answered++;
  await room.alarm();
}
check("session finished after 10 questions", !room.state.storage.m.get("session"));
check("all 10 polls answered in loop", answered === 10);
const fin = lastCall("sendMessage");
check("finish message with ranking 10 pts + time for Boss",
  fin?.params.text.includes("Quiz finished") && fin?.params.text.includes("Boss — 10 pts · ✅10   ❌0 · ⏱"));
check("negative marking: Ram -3.33 pts (10 wrong)",
  fin?.params.text.includes("Ram — -3.33 pts · ✅0   ❌10"));

// 7. /score all-time
await hook(msg("/score"), cfg.secret);
check("/score shows Boss 10 pts",
  lastCall("sendMessage")?.params.text.includes("Boss — 10 pts · ✅10   ❌0"));

// 8. default quiz + /stop
await hook(msg("/quiz"), cfg.secret);
flowMid = midSeq;
await hook(cb("default", flowMid), cfg.secret);
check("default quiz started", !!room.state.storage.m.get("session"));
await hook(msg("/stop"), cfg.secret);
await room.alarm();
check("stop finishes session with stopped header",
  !room.state.storage.m.get("session") &&
  lastCall("sendMessage")?.params.text.includes("Quiz stopped"));

// 9. non-admin /quiz refused
await hook(msg("/quiz", PLAYER), cfg.secret);
check("non-admin /quiz refused",
  lastCall("sendMessage")?.params.text.includes("Only a group admin"));

// 10. anonymous admin (Remain anonymous ON) can run the bot
const ANON = 1087968824;
const anonMsg = (text) => ({
  message: { message_id: 1, chat: { id: CHAT, type: "supergroup" },
             from: { id: ANON, first_name: "Group" },
             sender_chat: { id: CHAT, type: "supergroup" }, text },
});
await hook(anonMsg("/quiz"), cfg.secret);
check("anonymous admin /quiz opens setup",
  room.state.storage.m.get("flow")?.owner === ANON);
flowMid = midSeq;
await hook(cb("sub:0", flowMid, ANON), cfg.secret);
check("anonymous admin tap works (not refused)",
  !!lastCall("editMessageText") &&
  !lastCall("answerCallbackQuery")?.params.text?.includes("only for the admin"));
await hook(cb("cancel", flowMid, ANON), cfg.secret);

// 10b. mixed identities: anonymous-started setup tapped by the real admin,
// and admin-started setup tapped anonymously — both must work.
await hook(anonMsg("/quiz"), cfg.secret);
flowMid = midSeq;
await hook(cb("sub:0", flowMid, ADMIN), cfg.secret);
check("real admin can operate anonymous-started setup",
  !!lastCall("editMessageText") &&
  !lastCall("answerCallbackQuery")?.params.text?.includes("only for the admin"));
await hook(cb("cancel", flowMid, ADMIN), cfg.secret);
await hook(msg("/quiz"), cfg.secret);
flowMid = midSeq;
await hook(cb("sub:0", flowMid, ANON), cfg.secret);
check("anonymous tap works on admin-started setup",
  !!lastCall("editMessageText") &&
  !lastCall("answerCallbackQuery")?.params.text?.includes("only for the admin"));
await hook(cb("cancel", flowMid, ANON), cfg.secret);

// 11. New / Completed modes + per-topic done data
const countsNow = () => room.state.storage.m.get("askedCounts") || {};
const done0 = () => countsNow()[0] || 0;
const base = done0();
check("asked questions tracked from earlier quizzes", base >= 10);
async function finishSession() {
  for (let i = 0; i < 16 && room.state.storage.m.get("session"); i++) {
    const s = room.state.storage.m.get("session");
    for (const [pid, qi] of Object.entries(s.pollMap)) {
      if (s.answered[pid]) continue;
      await hook({ poll_answer: { poll_id: pid, user: { id: PLAYER, first_name: "Ram" }, option_ids: [s.items[qi].poll.correct_option_id] } }, cfg.secret);
    }
    await room.alarm();
  }
}
async function openFlowToTopic() {
  await hook(msg("/quiz"), cfg.secret);
  const mid = midSeq;
  await hook(cb("sub:0", mid), cfg.secret);
  const kb2 = lastCall("editMessageText").params.reply_markup.inline_keyboard;
  const tb = kb2.flat().find((b) => b.callback_data === "top:0");
  return { mid, tb };
}
async function runQuizFromFlow(mid, mode, count) {
  await hook(cb("top:0", mid), cfg.secret);
  const modeKb = lastCall("editMessageText").params.reply_markup.inline_keyboard;
  await hook(cb(`mode:${mode}`, mid), cfg.secret);
  await hook(cb(`cnt:${count}`, mid), cfg.secret);
  await hook(cb("sec:10", mid), cfg.secret);
  const confirmText = lastCall("editMessageText").params.text;
  await hook(cb("start", mid), cfg.secret);
  return { modeKb, confirmText };
}
{
  const { mid, tb } = await openFlowToTopic();
  check("topic button shows done count", !!tb && tb.text.includes(`✅${base} done`));
  await hook(cb("cancel", mid), cfg.secret);
}
{
  const o = await openFlowToTopic();
  const r = await runQuizFromFlow(o.mid, "done", 10);
  check("done-mode pool equals completed count", r.confirmText.includes(`(pool: ${base})`));
  const s = room.state.storage.m.get("session");
  check("revision quiz runs completed questions", !!s && s.items.length === Math.min(10, base));
  await finishSession();
  check("revision adds no new done", done0() === base);
}
{
  const o = await openFlowToTopic();
  const r = await runQuizFromFlow(o.mid, "new", 10);
  check("mode step shows left count", r.modeKb.flat().some((b) =>
    b.callback_data === "mode:new" && b.text.includes(`(${20 - base} left)`)));
  await finishSession();
  check("new mode completes the topic", done0() === 20);
}
{
  const o = await openFlowToTopic();
  await hook(cb("top:0", o.mid), cfg.secret);
  await hook(cb("mode:new", o.mid), cfg.secret);
  await hook(cb("cnt:10", o.mid), cfg.secret);
  await hook(cb("sec:10", o.mid), cfg.secret);
  await hook(cb("start", o.mid), cfg.secret);
  check("new mode exhausted message", calls.some((c) => c.method === "sendMessage" &&
    (c.params.text || "").includes("No new questions left")));
  check("no session when nothing new", !room.state.storage.m.get("session"));
}

// 12. Private (DM) setup: pick the group in DM, quiz starts inside the group
const dmMsg = (text, from = ADMIN) => ({
  message: { message_id: 9, chat: { id: from, type: "private" },
             from: { id: from, first_name: "Boss" }, text },
});
const dmCb = (data, mid, from = ADMIN) => ({
  callback_query: { id: "cb" + Math.random(), data, from: { id: from },
                    message: { message_id: mid, chat: { id: from, type: "private" } } },
});
await hook(dmMsg("/quiz", PLAYER), cfg.secret);
check("DM non-admin sees no groups",
  (lastCall("sendMessage")?.params.text || "").includes("No group found yet"));
await hook(dmMsg("/quiz"), cfg.secret);
const dmMid = midSeq;
const grpKb = lastCall("sendMessage").params.reply_markup.inline_keyboard;
check("DM group picker shows the group",
  grpKb.flat().some((b) => b.callback_data === `grp:${CHAT}`));
await hook(dmCb(`grp:${CHAT}`, dmMid), cfg.secret);
check("DM subjects after group pick",
  (lastCall("editMessageText")?.params.text || "").includes("choose a Subject"));
await hook(dmCb("sub:0", dmMid), cfg.secret);
await hook(dmCb("top:0", dmMid), cfg.secret);
await hook(dmCb("mode:all", dmMid), cfg.secret);
await hook(dmCb("cnt:10", dmMid), cfg.secret);
await hook(dmCb("sec:10", dmMid), cfg.secret);
await hook(dmCb("start", dmMid), cfg.secret);
const gRoom = getRoom(CHAT);
check("quiz session started inside the group room",
  !!gRoom.state.storage.m.get("session"));
check("DM told the quiz started",
  (lastCall("editMessageText")?.params.text || "").includes("Quiz started in"));
check("poll sent to the group chat",
  calls.some((c) => c.method === "sendPoll" && c.params.chat_id === CHAT));
check("group lastSelection saved from DM start",
  gRoom.state.storage.m.get("meta")?.lastSelection?.count === 10);
for (let i = 0; i < 16 && gRoom.state.storage.m.get("session"); i++) {
  await gRoom.alarm();
}

// 13. Bundled explanations ride inside the polls (<=200 chars, longer than
// the plain "Correct answer: X. <option>" fallback when a bundled text exists)
const explLens = calls.filter((c) => c.method === "sendPoll")
  .map((c) => (c.params.explanation || "").length);
check("all poll explanations within 200 chars", explLens.every((n) => n <= 200));
check("some polls carry bundled explanations",
  explLens.some((n) => n >= 120));

// 15. Mix Quiz — syllabus-wise combine (Leave Rules x10 + Pension topic x10)
await getRoom(CHAT).state.storage.delete("session");
await getRoom(CHAT).state.storage.delete("flow");
await hook(msg("/quiz"), cfg.secret);
{
  const kb0 = lastCall("sendMessage")?.params.reply_markup?.inline_keyboard || [];
  check("subjects keyboard has Mix button",
    kb0.flat().some((b) => b.callback_data === "mx:open"));
  const mMid = midSeq;
  const tap = async (data) => {
    await hook(cb(data, mMid), cfg.secret);
    return lastCall("editMessageText")?.params.reply_markup?.inline_keyboard || [];
  };
  const flat = (kb) => kb.flat();
  const lastText = () => lastCall("editMessageText")?.params.text || "";
  let kb = await tap("mx:open");
  check("mix home opens", lastText().includes("Mix Quiz"));
  kb = await tap("mx:add");
  check("syllabus papers shown", flat(kb).some((b) => b.callback_data === "mx:paper:0"));
  kb = await tap("mx:paper:0");
  check("paper groups shown (Establishment)",
    flat(kb).some((b) => b.callback_data === "mx:group:EST"));
  kb = await tap("mx:group:EST");
  const leaveBtn = flat(kb).find((b) => b.callback_data.startsWith("mx:chap:") &&
    b.text.includes("Leave Rules"));
  check("EST chapters include Leave Rules", !!leaveBtn);
  kb = await tap(leaveBtn.callback_data);
  kb = await tap("mx:cnt:10");
  check("mix shows Leave Rules + total 10",
    lastText().includes("Leave Rules") && lastText().includes("Total: 10"));
  kb = await tap("mx:add");
  kb = await tap("mx:paper:0");
  kb = await tap("mx:group:PPN");
  kb = await tap("mx:wholegroup");
  kb = await tap("mx:cnt:10");
  check("mix total now 20", lastText().includes("Total: 20"));
  kb = await tap("mx:go");
  check("mix mode step opens", lastText().includes("Which questions"));
  kb = await tap("mode:all");
  kb = await tap("sec:10");
  check("mix confirm lists parts + 20 questions",
    lastText().includes("Leave Rules") && lastText().includes("20 questions"));
  const pollsBefore = calls.filter((c) => c.method === "sendPoll").length;
  await tap("start");
  const announce = calls.filter((c) => c.method === "sendMessage").pop();
  check("mix quiz announced with 20 questions",
    (announce?.params.text || "").includes("20 questions"));
  check("mix first poll sent",
    calls.filter((c) => c.method === "sendPoll").length === pollsBefore + 1);
  await getRoom(CHAT).state.storage.delete("session");
}

// 16. 9 PM Auto Quiz — /autoquiz on/off + cron (scheduled) starts the quiz
{
  const aq = (t, from = ADMIN) => hook(msg(t, from), cfg.secret);
  await aq("/autoquiz on", PLAYER);
  check("autoquiz change refused for non-admin",
    (lastCall("sendMessage")?.params.text || "").includes("Only a group admin"));
  await aq("/autoquiz on");
  check("autoquiz turned ON by admin",
    (lastCall("sendMessage")?.params.text || "").includes("🟢 ON"));
  await aq("/autoquiz");
  check("autoquiz status shows today's rotation",
    (lastCall("sendMessage")?.params.text || "").includes("9 PM Auto Quiz"));
  await getRoom(CHAT).state.storage.delete("session");
  const pollsB = calls.filter((c) => c.method === "sendPoll").length;
  await worker.scheduled({}, env, ctx);
  await drain();
  const ann = calls.filter((c) => c.method === "sendMessage").pop();
  check("cron starts the auto quiz",
    (ann?.params.text || "").includes("9 PM Auto Quiz") &&
    calls.filter((c) => c.method === "sendPoll").length === pollsB + 1);
  await getRoom(CHAT).state.storage.delete("session");
  await aq("/autoquiz off");
  check("autoquiz turned OFF",
    (lastCall("sendMessage")?.params.text || "").includes("🔴 OFF"));
  const pollsC = calls.filter((c) => c.method === "sendPoll").length;
  await worker.scheduled({}, env, ctx);
  await drain();
  check("cron does nothing when OFF",
    calls.filter((c) => c.method === "sendPoll").length === pollsC);
}

// 17. Question editor (/edit in DM): search -> card -> edit -> save -> live -> export/revert
{
  await hook(dmMsg("/edit", PLAYER), cfg.secret);
  check("editor refused for non-admin",
    (lastCall("sendMessage")?.params.text || "").includes("only for a group admin"));
  await hook(dmMsg("/edit"), cfg.secret);
  check("editor asks for search words",
    (lastCall("sendMessage")?.params.text || "").includes("Question Editor"));
  const eMid = midSeq;
  await hook(dmMsg("error sheet manual"), cfg.secret);
  let kb = lastCall("editMessageText")?.params.reply_markup?.inline_keyboard || [];
  const pickBtn = kb.flat().find((b) => b.callback_data.startsWith("ed:pick:"));
  check("editor search finds the manual-system question", !!pickBtn);
  await hook(dmCb(pickBtn.callback_data, eMid), cfg.secret);
  let cardText = lastCall("editMessageText")?.params.text || "";
  check("editor card opens q1xtnaneriym",
    cardText.includes("q1xtnaneriym") && cardText.includes("under manual system"));
  await hook(dmCb("ed:a:A", eMid), cfg.secret);
  await hook(dmCb("ed:o:B", eMid), cfg.secret);
  await hook(dmMsg("4 copies (corrected)"), cfg.secret);
  cardText = lastCall("editMessageText")?.params.text || "";
  check("card shows the changed option",
    cardText.includes("4 copies (corrected)") && cardText.includes("changed"));
  await hook(dmCb("ed:save", eMid), cfg.secret);
  check("save confirmed",
    (lastCall("editMessageText")?.params.text || "").includes("✅ Saved"));
  const savedEdits = JSON.parse((await kv.get("edits_all")) || "{}");
  check("edit persisted in KV",
    savedEdits.q1xtnaneriym?.answer === "A" &&
    savedEdits.q1xtnaneriym?.options?.B === "4 copies (corrected)");
  const grpRoom = getRoom(CHAT);
  await grpRoom.state.storage.delete("session");
  await grpRoom.startSession(CHAT, "edtest", null, null, 500, 10, "all",
    [{ label: "Goods", cis: [2], count: 500 }]);
  const sess = grpRoom.state.storage.m.get("session");
  check("saved edit appears in built quiz payloads",
    JSON.stringify(sess || {}).includes("4 copies (corrected)"));
  await grpRoom.state.storage.delete("session");
  await hook(dmMsg("/edits"), cfg.secret);
  const edKb = lastCall("sendMessage")?.params.reply_markup?.inline_keyboard || [];
  check("edits list shows export + revert buttons",
    edKb.flat().some((b) => b.callback_data === "ed:exp") &&
    edKb.flat().some((b) => b.callback_data === "ed:rev:q1xtnaneriym"));
  const edMid = midSeq;
  await hook(dmCb("ed:exp", edMid), cfg.secret);
  check("export sends a document",
    calls.some((c) => c.method === "sendDocument"));
  await hook(dmCb("ed:rev:q1xtnaneriym", edMid), cfg.secret);
  const after = JSON.parse((await kv.get("edits_all")) || "{}");
  check("revert removes the edit", !after.q1xtnaneriym);
}

// 18. Keyword Quiz: type keywords, counts, completed/pending, combine + start
{
  await getRoom(CHAT).state.storage.delete("session");
  await getRoom(CHAT).state.storage.delete("flow");
  await hook(msg("/quiz"), cfg.secret);
  const kb0 = lastCall("sendMessage")?.params.reply_markup?.inline_keyboard || [];
  check("subjects keyboard has Keyword button",
    kb0.flat().some((b) => b.callback_data === "kw:open"));
  const kMid = midSeq;
  const tap = async (data) => {
    await hook(cb(data, kMid), cfg.secret);
    return lastCall("editMessageText")?.params.reply_markup?.inline_keyboard || [];
  };
  const lastText = () => lastCall("editMessageText")?.params.text || "";
  await tap("kw:open");
  check("keyword home opens", lastText().includes("Keyword Quiz"));
  await tap("kw:add");
  check("keyword input prompt", lastText().includes("next message"));
  await hook(msg("error sheet", PLAYER), cfg.secret);
  check("member keyword ignored", !lastText().includes("kitne sawal"));
  await hook(msg("error sheet"), cfg.secret);
  check("keyword count screen shows pool + completed/pending",
    lastText().includes("questions found") && lastText().includes("Completed") &&
    lastText().includes("Pending"));
  await tap("kw:cnt:10");
  check("keyword home total 10", lastText().includes("Total: 10"));
  await tap("kw:add");
  await hook(msg("nodal railway"), cfg.secret);
  await tap("kw:cnt:10");
  check("keyword home total 20", lastText().includes("Total: 20"));
  await tap("kw:go");
  check("keyword mode screen",
    lastText().includes("Which questions") && lastText().includes("Keywords:"));
  await tap("mode:all");
  await tap("sec:10");
  check("keyword confirm lists both + 20",
    lastText().includes("error sheet") && lastText().includes("nodal railway") &&
    lastText().includes("20 questions"));
  const pollsB = calls.filter((c) => c.method === "sendPoll").length;
  await tap("start");
  const ann = calls.filter((c) => c.method === "sendMessage").pop();
  check("keyword quiz announced with 20 questions",
    (ann?.params.text || "").includes("20 questions"));
  check("keyword first poll sent",
    calls.filter((c) => c.method === "sendPoll").length === pollsB + 1);
  const sess = getRoom(CHAT).state.storage.m.get("session");
  const sj = JSON.stringify(sess || {});
  check("payloads come from both keywords",
    sj.includes("Error sheet") && sj.includes("Nodal railway"));
  await getRoom(CHAT).state.storage.delete("session");

  // DM keyword capture (private setup)
  await hook(dmMsg("/quiz"), cfg.secret);
  const dMid = midSeq;
  await hook(dmCb(`grp:${CHAT}`, dMid), cfg.secret);
  const dKb = lastCall("editMessageText")?.params.reply_markup?.inline_keyboard || [];
  check("DM subjects show Keyword button",
    dKb.flat().some((b) => b.callback_data === "kw:open"));
  await hook(dmCb("kw:open", dMid), cfg.secret);
  await hook(dmCb("kw:add", dMid), cfg.secret);
  await hook(dmMsg("pension"), cfg.secret);
  check("DM keyword count screen",
    (lastCall("editMessageText")?.params.text || "").includes("questions found"));
  await hook(dmCb("kw:cnt:10", dMid), cfg.secret);
  check("DM keyword home total 10",
    (lastCall("editMessageText")?.params.text || "").includes("Total: 10"));
}

// 19. Keyword Quiz regression: a BROAD keyword (matches in hundreds of
// part files) must still start — pool is built from a capped file set.
{
  await getRoom(CHAT).state.storage.delete("session");
  await getRoom(CHAT).state.storage.delete("flow");
  await hook(msg("/quiz"), cfg.secret);
  const kMid = midSeq;
  const tap = async (data) => { await hook(cb(data, kMid), cfg.secret); };
  const lastText = () => lastCall("editMessageText")?.params.text || "";
  await tap("kw:open");
  await tap("kw:add");
  await hook(msg("leave"), cfg.secret);
  check("broad keyword finds a large pool",
    /\d{3,} questions found/.test(lastText()));
  await tap("kw:cnt:10");
  await tap("kw:go");
  await tap("mode:all");
  await tap("sec:10");
  const pollsB = calls.filter((c) => c.method === "sendPoll").length;
  await tap("start");
  const ann = calls.filter((c) => c.method === "sendMessage").pop();
  check("broad-keyword quiz announced",
    (ann?.params.text || "").includes("10 questions"));
  check("broad-keyword first poll sent",
    calls.filter((c) => c.method === "sendPoll").length === pollsB + 1);
  const sess = getRoom(CHAT).state.storage.m.get("session");
  const qs = (sess?.items || []).map((p) => (p.poll?.question || ""));
  check("broad-keyword payloads all match the keyword",
    qs.length === 10 && qs.every((q) => q.toLowerCase().includes("leave")));
  await getRoom(CHAT).state.storage.delete("session");
}

// 20. Akaza flavor: same code, second bot — /quiz ignored, /akaza starts
{
  const CHAT2 = -100999;
  const savedCfg = await kv.get("config");
  const c2 = JSON.parse(savedCfg);
  c2.username = "AkazaQuizBot";
  c2.flavor = "akaza";
  await kv.put("config", JSON.stringify(c2));
  const msg2 = (text, from = ADMIN) => ({
    message: { message_id: 3, chat: { id: CHAT2, type: "supergroup" },
               from: { id: from, first_name: "Boss" }, text },
  });
  const cb2 = (data, mid, from = ADMIN) => ({
    callback_query: { id: "cb" + Math.random(), data, from: { id: from },
                      message: { message_id: mid, chat: { id: CHAT2 } } },
  });
  const sendsTo2 = () => calls.filter((x) => x.method === "sendMessage" &&
    x.params.chat_id === CHAT2);
  await hook(msg2("/quiz"), cfg.secret);
  check("akaza ignores bare /quiz", sendsTo2().length === 0);
  await hook(msg2("/akaza"), cfg.secret);
  check("akaza ignores the old bare /akaza", sendsTo2().length === 0);
  await hook(msg2("/akazaquiz"), cfg.secret);
  check("akaza ignores the replaced /akazaquiz (now /maheshquiz)",
    sendsTo2().length === 0);
  await hook(msg2("/maheshedit"), cfg.secret);
  check("akaza group /maheshedit points to its DM",
    sendsTo2().some((x) => (x.params.text || "").includes("@akazaquizbot")));
  await hook(msg2("/maheshquiz"), cfg.secret);
  check("akaza opens setup on /maheshquiz",
    sendsTo2().some((x) => (x.params.reply_markup?.inline_keyboard || [])
      .flat().some((b) => b.callback_data === "sub:0")));
  const aMid = midSeq;
  await hook(cb2("sub:0", aMid), cfg.secret);
  const akb = lastCall("editMessageText")?.params.reply_markup?.inline_keyboard || [];
  check("akaza chapters show All Topics",
    akb.flat().some((b) => b.callback_data === "top:all"));
  await hook(cb2("top:all", aMid), cfg.secret);
  await hook(cb2("mode:all", aMid), cfg.secret);
  await hook(cb2("cnt:10", aMid), cfg.secret);
  await hook(cb2("sec:10", aMid), cfg.secret);
  await hook(cb2("start", aMid), cfg.secret);
  check("akaza announce carries its own brand",
    sendsTo2().some((x) => (x.params.text || "").includes("👹 Akaza")));
  await hook(msg2("/maheshping"), cfg.secret);
  check("akaza ping reply carries its own name",
    sendsTo2().some((x) => (x.params.text || "") === "✅ Akaza bot is live!"));
  const dmBefore = calls.filter((x) => x.method === "sendMessage" &&
    x.params.chat_id === ADMIN).length;
  await hook(dmMsg("/maheshping"), cfg.secret);
  check("akaza DM /maheshping replies live",
    calls.filter((x) => x.method === "sendMessage" &&
      x.params.chat_id === ADMIN)
      .some((x) => (x.params.text || "") === "✅ Akaza bot is live!"));
  await hook(dmMsg("/maheshquiz"), cfg.secret);
  check("akaza DM /maheshquiz gets a response (setup or add-me-first)",
    calls.filter((x) => x.method === "sendMessage" &&
      x.params.chat_id === ADMIN).length > dmBefore);
  await getRoom(CHAT2).state.storage.delete("session");
  await kv.put("config", savedCfg);
}

// 21. Day-wise Quiz: Telegram subject -> Group -> Month -> Day replays
// that day's original quiz, every question, in original order.
{
  const tg = JSON.parse(fs.readFileSync(path.join(ROOT, "bank", "tgdays.json"), "utf8"));
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, "bank", "index.json"), "utf8"));
  const tgSubj = idx.subjects.findIndex((s) => (s.chapters || []).includes(599));
  // Pick a small day whose questions are all short and askable, so the
  // session payloads must match the source order exactly.
  let pick = null;
  outer:
  for (let gi = 0; gi < tg.groups.length; gi++) {
    for (const mo of tg.groups[gi].months) {
      for (const dy of mo.days) {
        if (dy.n < 2 || dy.n > 12) continue;
        const qs = dy.keys.map((k) => {
          const [p, i] = k.split("#");
          const part = JSON.parse(fs.readFileSync(path.join(ROOT, "bank", p), "utf8"));
          return part[parseInt(i, 10)];
        });
        const okDay = qs.every((q) => q && q.options && q.options.length >= 2 &&
          q.q.length <= 280 &&
          q.options.map((o) => String(o).trim()).includes(q.options["ABCD".indexOf(q.answer)]) &&
          new Set(q.options.map((o) => String(o).trim().slice(0, 99))).size === q.options.length);
        if (okDay) { pick = { gi, m: mo.m, d: dy.d, n: dy.n, qs: qs.map((q) => q.q.trim()) }; break outer; }
      }
    }
  }
  check("a small fully-askable day exists for the test", !!pick);
  await getRoom(CHAT).state.storage.delete("session");
  await getRoom(CHAT).state.storage.delete("flow");
  await hook(msg("/quiz"), cfg.secret);
  const dMid = midSeq;
  const tap = async (data) => { await hook(cb(data, dMid), cfg.secret); };
  const kb = () => lastCall("editMessageText")?.params.reply_markup?.inline_keyboard || [];
  const has = (data) => kb().flat().some((b) => b.callback_data === data);
  const findPage = async (target, nextPrefix) => {
    for (let p = 0; p < 12 && !has(target); p++) {
      const nb = kb().flat().find((b) => b.callback_data?.startsWith(nextPrefix) &&
        parseInt(b.callback_data.split(":").pop(), 10) > p);
      if (!nb) break;
      await tap(nb.callback_data);
    }
    return has(target);
  };
  await tap(`sub:${tgSubj}`);
  check("day-wise button on Telegram subject", has("dw:open"));
  await tap("dw:open");
  check("day-wise groups shown", has(`dw:grp:${pick.gi}`));
  await tap(`dw:grp:${pick.gi}`);
  check("day-wise month reachable", await findPage(`dw:mon:${pick.m}`, "dw:monp:"));
  await tap(`dw:mon:${pick.m}`);
  check("day-wise day reachable", await findPage(`dw:day:${pick.d}`, "dw:dayp:"));
  await tap(`dw:day:${pick.d}`);
  await tap("sec:10");
  const confirmText = lastCall("editMessageText")?.params.text || "";
  check("day-wise confirm shows the day and full count",
    confirmText.includes("Day-wise Quiz is ready") &&
    confirmText.includes(`${pick.n} questions`));
  const pollsB = calls.filter((c) => c.method === "sendPoll").length;
  await tap("start");
  const ann = calls.filter((c) => c.method === "sendMessage").pop();
  check("day-wise quiz announced with full day count",
    (ann?.params.text || "").includes(`${pick.n} questions`));
  check("day-wise first poll sent",
    calls.filter((c) => c.method === "sendPoll").length === pollsB + 1);
  const sess = getRoom(CHAT).state.storage.m.get("session");
  const gotQs = (sess?.items || []).map((p) => p.poll?.question || "");
  check("day-wise payloads = the day's questions in ORIGINAL order",
    JSON.stringify(gotQs) ===
    JSON.stringify(pick.qs.map((q, i) => `Q${i + 1}. ${q}`)));
  await getRoom(CHAT).state.storage.delete("session");
}

// 14. Telegram command menu registered (v12) + no plain tick/cross glyphs left
const cmdCalls = calls.filter((c) => c.method === "setMyCommands");
check("setMyCommands registered", cmdCalls.length >= 1 &&
  JSON.stringify(cmdCalls.map((c) => c.params.commands)).includes('"quiz"') &&
  JSON.stringify(cmdCalls.map((c) => c.params.commands)).includes('"stop"'));
const glyphLeak = calls.filter((c) => (c.params.text || "").includes("✓") ||
  (c.params.text || "").includes("✗"));
check("no plain ✓/✗ glyphs in bot messages", glyphLeak.length === 0);

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
