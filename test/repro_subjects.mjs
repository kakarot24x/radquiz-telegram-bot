// Repro: drive the /quiz flow for several subjects and report whether
// a poll actually gets sent. Run: node test/repro_subjects.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
fs.copyFileSync(path.join(ROOT, "worker.js"), path.join(ROOT, "test/worker.mjs"));
const { default: worker, QuizRoom } = await import("./worker.mjs");

const calls = [];
let midSeq = 1000, pollSeq = 0;
const ADMIN = 111, CHAT = -100123;

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
    if (method === "sendPoll") return ok({ message_id: ++midSeq, poll: { id: "poll" + (++pollSeq) } });
    if (method === "getChatMember") return ok({ status: "administrator" });
    return ok(true);
  }
  if (u.includes("raw.githubusercontent.com")) {
    const rel = u.split("/bank/")[1];
    const file = path.join(ROOT, "bank", rel);
    if (!fs.existsSync(file)) return new Response("nf", { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { "Content-Type": "application/json" } });
  }
  throw new Error("unexpected fetch: " + u);
};

class FakeKV { constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); } }
class FakeStorage { constructor() { this.m = new Map(); this.alarm = null; }
  async get(k) { return this.m.get(k); } async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); } async setAlarm(t) { this.alarm = t; } }
const kv = new FakeKV();
const rooms = new Map();
const env = { KV: kv, QUIZ: null };
function getRoom(chatId) {
  if (!rooms.has(chatId)) rooms.set(chatId, new QuizRoom({ storage: new FakeStorage() }, env));
  return rooms.get(chatId);
}
env.QUIZ = { idFromName: (n) => n,
  get: (id) => ({ fetch: async (url, opts) => getRoom(Number(id)).fetch(new Request(url, opts)) }) };
let pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
async function drain() { while (pending.length) await Promise.all(pending.splice(0)); }
async function hook(update, secret) {
  const res = await worker.fetch(new Request("https://x/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(update),
  }), env, ctx);
  await drain();
  return res;
}
const msg = (text) => ({ message: { message_id: 1, chat: { id: CHAT, type: "supergroup" },
  from: { id: ADMIN, first_name: "Boss" }, text } });
const cb = (data, mid) => ({ callback_query: { id: "cb" + Math.random(), data,
  from: { id: ADMIN }, message: { message_id: mid, chat: { id: CHAT } } } });
const lastCall = (m) => { const cs = calls.filter((c) => c.method === m); return cs[cs.length - 1]; };
const kbOf = (m) => (lastCall(m)?.params.reply_markup?.inline_keyboard || []).flat();

// setup
let res = await worker.fetch(new Request("https://x/"), env, ctx);
const form = new FormData();
form.set("token", "111222:AAEfake-token-for-test");
await worker.fetch(new Request("https://x/setup", { method: "POST", body: form }), env, ctx);
const cfg = JSON.parse(await kv.get("config"));

for (const subI of [0, 4, 5]) {
  calls.length = 0;
  await hook(msg("/quiz"), cfg.secret);
  const mid = midSeq;
  await hook(cb(`sub:${subI}`, mid), cfg.secret);
  const topics = kbOf("editMessageText").filter((b) => b.callback_data.startsWith("top:"));
  const topBtn = topics.find((b) => b.callback_data !== "top:all") || topics[0];
  if (!topBtn) { console.log(`sub:${subI} — NO TOPIC BUTTONS`); continue; }
  await hook(cb(topBtn.callback_data, mid), cfg.secret);
  await hook(cb("mode:all", mid), cfg.secret);
  await hook(cb("cnt:10", mid), cfg.secret);
  const secKb = kbOf("editMessageText").map((b) => b.callback_data);
  await hook(cb("sec:15", mid), cfg.secret);
  const confirmText = lastCall("editMessageText")?.params.text || "";
  await hook(cb("start", mid), cfg.secret);
  const polls = calls.filter((c) => c.method === "sendPoll").length;
  const noQ = calls.some((c) => c.method === "sendMessage" &&
    (c.params.text || "").includes("No quiz-worthy questions"));
  console.log(`sub:${subI} topic=${topBtn.callback_data} secOptions=${secKb.join(",")}`);
  console.log(`   confirm: ${confirmText.replace(/\n/g, " | ")}`);
  console.log(`   polls sent: ${polls} | no-question msg: ${noQ}`);
  // cleanup session
  await hook(msg("/stop"), cfg.secret);
  const room = getRoom(CHAT);
  await room.alarm();
}
