import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { DemoManager, type Fixtures, type Scenario } from "../src/demo.js";
import { createServer, RateLimiter } from "../src/web.js";

const scenario = JSON.parse(fs.readFileSync("demo/scenario.json", "utf8")) as Scenario;
const fixtures = JSON.parse(fs.readFileSync("demo/fixtures.json", "utf8")) as Fixtures;
let server: http.Server;
let base = "";

before(async () => {
  server = createServer({ demo: new DemoManager(scenario, fixtures, () => undefined), demoMode: () => "replay", model: "gemma4:e4b", trustProxy: false });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (p: string, body: object) => fetch(base + p, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
const get = (p: string) => fetch(base + p).then(async (r) => ({ status: r.status, json: await r.json() as any }));

test("demo sandbox: consent gate, watch, replayed memory, grounded answer, delete", async () => {
  const { sid } = (await post("/api/session", {})).json;
  assert.equal((await post("/api/send", { sid, key: "lunch" })).json.outcome, "no_consent");
  await post("/api/action", { sid, action: "optin" });
  assert.equal((await post("/api/send", { sid, key: "lunch" })).json.outcome, "chat_not_watched");
  await post("/api/action", { sid, action: "watch", arg: "family" });
  assert.equal((await post("/api/send", { sid, key: "lunch" })).json.outcome, "saved");
  assert.equal((await post("/api/send", { sid, key: "standup" })).json.outcome, "chat_not_watched");
  const q = scenario.questions[0].text;
  const ans = (await post("/api/ask", { sid, question: q })).json;
  assert.equal(ans.status, "ok");
  assert.equal(ans.sources[0].text, scenario.messages[0].text);
  await post("/api/action", { sid, action: "delete" });
  assert.equal((await get(`/api/state?sid=${sid}`)).json.memories.length, 0);
});

test("an answer is withheld when its source message was never saved", async () => {
  const { sid } = (await post("/api/session", {})).json;
  await post("/api/action", { sid, action: "optin" });
  await post("/api/action", { sid, action: "watch", arg: "family" });
  await post("/api/send", { sid, key: "cake" });
  const r = (await post("/api/ask", { sid, question: scenario.questions[0].text })).json;
  assert.equal(r.uncertain, true);
  assert.equal(r.sources.length, 0);
});

test("sessions are isolated from each other", async () => {
  const a = (await post("/api/session", {})).json.sid;
  const b = (await post("/api/session", {})).json.sid;
  await post("/api/action", { sid: a, action: "optin" });
  await post("/api/action", { sid: a, action: "watch", arg: "family" });
  await post("/api/send", { sid: a, key: "lunch" });
  assert.equal((await get(`/api/state?sid=${b}`)).json.memories.length, 0);
  assert.equal((await get(`/api/state?sid=${a}`)).json.memories.length, 1);
});

test("replay mode refuses free text and unknown questions; unknown sessions 404", async () => {
  const { sid } = (await post("/api/session", {})).json;
  assert.equal((await post("/api/send", { sid, text: "hello" })).status, 400);
  assert.equal((await post("/api/ask", { sid, question: "make up something" })).status, 400);
  assert.equal((await get("/api/state?sid=nope")).status, 404);
});

test("oversized bodies are rejected and static files cannot escape public/", async () => {
  const r = await fetch(base + "/api/action", { method: "POST", body: "x".repeat(5000) });
  assert.equal(r.status, 400);
  assert.equal((await fetch(base + "/..%2f..%2fpackage.json")).status, 404);
  const page = await fetch(base + "/");
  assert.match(page.headers.get("content-security-policy")!, /default-src 'none'/);
});

test("rate limiter blocks after the limit and resets", () => {
  let t = 0;
  const rl = new RateLimiter(2, () => t);
  assert.ok(rl.allow("a") && rl.allow("a"));
  assert.ok(!rl.allow("a"));
  assert.ok(rl.allow("b"));
  t = 61_000;
  assert.ok(rl.allow("a"));
});

test("the demo code path has no Telegram, disk or network access", () => {
  const src = fs.readFileSync("src/demo.ts", "utf8");
  assert.doesNotMatch(src, /node:fs|node:net|node:http|fetch\(|telegram\.js/);
  assert.match(src, /new Store\(":memory:"\)/);
});
