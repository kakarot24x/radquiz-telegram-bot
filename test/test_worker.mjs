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
    const params = opts.body ? JSON.parse(opts.body) : {};
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
  fin?.params.text.includes("Quiz finished") && fin?.params.text.includes("Boss — 10 pts · ✅10 ❌0 · ⏱"));
check("negative marking: Ram -3.33 pts (10 wrong)",
  fin?.params.text.includes("Ram — -3.33 pts · ✅0 ❌10"));

// 7. /score all-time
await hook(msg("/score"), cfg.secret);
check("/score shows Boss 10 pts",
  lastCall("sendMessage")?.params.text.includes("Boss — 10 pts · ✅10 ❌0"));

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
