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
  fin?.params.text.includes("Quiz finished") && fin?.params.text.includes("Boss — 10 pts · ✓10 ✗0 · ⏱"));
check("negative marking: Ram -3.33 pts (10 wrong)",
  fin?.params.text.includes("Ram — -3.33 pts · ✓0 ✗10"));

// 7. /score all-time
await hook(msg("/score"), cfg.secret);
check("/score shows Boss 10 pts",
  lastCall("sendMessage")?.params.text.includes("Boss — 10 pts · ✓10 ✗0"));

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

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
