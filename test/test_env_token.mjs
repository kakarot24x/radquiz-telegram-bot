// Test for the dashboard-secret path: BOT_TOKEN as a Worker secret,
// then one tap on /activate connects the bot. Run: node test/test_env_token.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const { default: worker } = await import("./worker.mjs");

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith("https://api.telegram.org/")) {
    const method = u.split("/").pop();
    const params = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ method, params });
    const ok = (result) => new Response(JSON.stringify({ ok: true, result }),
      { headers: { "Content-Type": "application/json" } });
    if (method === "getMe") return ok({ id: 1, username: "RADEQuizBot" });
    if (method === "sendMessage") return ok({ message_id: 1, chat: { id: params.chat_id } });
    return ok(true);
  }
  throw new Error("unexpected fetch: " + u);
};

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); }
}
const kv = new FakeKV();
const TOKEN = "999888777:AAE" + "x".repeat(32);
const env = { KV: kv, QUIZ: null, BOT_TOKEN: TOKEN };
const ctx = { waitUntil: (p) => p && p.catch && p.catch(() => {}) };
let failures = 0;
const check = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + " — " + name);
  if (!cond) failures++;
};

// 1. status page offers the Activate button
let res = await worker.fetch(new Request("https://x/"), env, ctx);
let body = await res.text();
check("status page shows Activate button", body.includes("/activate"));

// 2. /activate registers the webhook with the derived secret
res = await worker.fetch(new Request("https://x/activate"), env, ctx);
body = await res.text();
check("activate success page", body.includes("Bot is Live") && body.includes("@RADEQuizBot"));
const wh = calls.find((c) => c.method === "setWebhook");
const expectSecret = crypto.createHash("sha256").update(TOKEN).digest("hex").slice(0, 40);
check("webhook secret = derived from token", wh?.params.secret_token === expectSecret);
check("config saved to KV", JSON.parse(await kv.get("config"))?.username === "RADEQuizBot");

// 3. status page now shows Running
res = await worker.fetch(new Request("https://x/"), env, ctx);
body = await res.text();
check("status page shows Running", body.includes("Bot is Running"));

// 4. /ping via webhook with derived secret
res = await worker.fetch(new Request("https://x/hook", {
  method: "POST",
  headers: { "Content-Type": "application/json",
             "x-telegram-bot-api-secret-token": expectSecret },
  body: JSON.stringify({ message: { message_id: 1, text: "/ping",
    chat: { id: -1001, type: "supergroup" }, from: { id: 5 } } }),
}), env, ctx);
await new Promise((r) => setTimeout(r, 50));
check("/ping answered", calls.some((c) => c.method === "sendMessage" &&
  String(c.params.text).includes("bot is live")));

// 5. wrong secret is refused
res = await worker.fetch(new Request("https://x/hook", {
  method: "POST",
  headers: { "Content-Type": "application/json",
             "x-telegram-bot-api-secret-token": "nope" },
  body: JSON.stringify({ message: { message_id: 2, text: "/ping",
    chat: { id: -1001, type: "supergroup" }, from: { id: 5 } } }),
}), env, ctx);
check("wrong secret refused with 403", res.status === 403);

console.log(failures === 0 ? "\nALL ENV-TOKEN TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
