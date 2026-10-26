import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngine, msg } from "./helpers.js";

test("nothing is stored or sent to the model before the user opts in", async () => {
  const { engine, llm, store } = makeEngine();
  assert.equal(await engine.ingest(msg({ isDirect: true })), "no_consent");
  assert.equal(llm.calls.length, 0);
  assert.equal(store.countFor("u1").messages, 0);
  assert.equal(engine.watch("u1", "g1"), false);
});

test("a group chat is ignored until the user watches it", async () => {
  const { engine, llm } = makeEngine();
  engine.optIn("u1");
  assert.equal(await engine.ingest(msg()), "chat_not_watched");
  assert.equal(llm.calls.length, 0);
  engine.watch("u1", "g1");
  assert.equal(await engine.ingest(msg()), "saved");
});

test("direct chat with the bot needs no /watch but still needs consent", async () => {
  const { engine } = makeEngine();
  engine.optIn("u1");
  assert.equal(await engine.ingest(msg({ chatId: "u1", isDirect: true })), "saved");
});

test("a group member who sends /notme is skipped and past messages are erased", async () => {
  const { engine, store } = makeEngine();
  engine.optIn("u1");
  engine.watch("u1", "g1");
  await engine.ingest(msg({ senderId: "alex", senderName: "Alex", text: "cake on Saturday" }));
  await engine.ingest(msg({ senderId: "sarah", text: "hello there" }));
  assert.equal(store.countFor("u1").messages, 2);
  const erased = engine.excludeSender("g1", "alex");
  assert.equal(erased, 1);
  assert.equal(store.countFor("u1").messages, 1);
  assert.equal(store.countFor("u1").memories, 1);
  assert.equal(await engine.ingest(msg({ senderId: "alex", text: "again" })), "sender_excluded");
  engine.includeSender("g1", "alex");
  assert.equal(await engine.ingest(msg({ senderId: "alex", text: "back" })), "saved");
});

test("pause stops capture, resume restarts it", async () => {
  const { engine } = makeEngine();
  engine.optIn("u1");
  engine.watch("u1", "g1");
  engine.setPaused("u1", true, "caregiver");
  assert.equal(await engine.ingest(msg()), "paused");
  engine.setPaused("u1", false, "caregiver");
  assert.equal(await engine.ingest(msg()), "saved");
});

test("a caregiver cannot create consent or resume after the user opts out", async () => {
  const { engine } = makeEngine();
  engine.optIn("u1");
  engine.optOut("u1");
  assert.equal(engine.setPaused("u1", false, "caregiver"), false);
  assert.equal(await engine.ingest(msg({ isDirect: true })), "no_consent");
  // a user that never opted in cannot be switched on either
  assert.equal(engine.setPaused("never", false, "caregiver"), false);
  assert.equal(engine.hasConsent("never"), false);
});

test("opt-out stops capture but keeps data until delete-my-data", async () => {
  const { engine, store } = makeEngine();
  engine.optIn("u1");
  await engine.ingest(msg({ isDirect: true }));
  engine.optOut("u1");
  assert.equal(store.countFor("u1").memories, 1);
  assert.equal(await engine.ask("u1", "q"), "no_consent");
});

test("delete-my-data removes every row for the user and nobody else's", async () => {
  const { engine, store } = makeEngine();
  for (const u of ["u1", "u2"]) {
    engine.optIn(u);
    engine.watch(u, "g1");
    await engine.ingest(msg({ userId: u }));
  }
  const code = engine.createInvite("u1")!;
  engine.linkCaregiver(code, "c1");
  engine.deleteAll("u1");
  const count = (t: string) => (store.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id = ?`).get("u1") as any).n;
  for (const t of ["users", "messages", "memories", "watched_chats", "invites", "audit"]) {
    const col = t === "users" ? "id" : "user_id";
    assert.equal((store.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${col} = ?`).get("u1") as any).n, 0, t);
  }
  void count;
  assert.equal(store.countFor("u2").memories, 1);
  assert.equal(store.getUserByCaregiver("c1"), undefined);
});

test("deleted text is not left in the database file", async () => {
  const { default: fs } = await import("node:fs");
  const { Engine } = await import("../src/engine.js");
  const { Store } = await import("../src/store.js");
  const { FakeLlm } = await import("./helpers.js");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-"));
  const file = path.join(dir, "t.db");
  const e = new Engine(new Store(file), new FakeLlm());
  e.optIn("u1");
  await e.ingest(msg({ isDirect: true, text: "ZEBRA-MARKER-8841 dentist appointment" }));
  e.deleteAll("u1");
  e.store.close();
  for (const f of fs.readdirSync(dir)) {
    assert.ok(!fs.readFileSync(path.join(dir, f)).includes("ZEBRA-MARKER-8841"), `${f} still holds the text`);
  }
  fs.rmSync(dir, { recursive: true });
});

test("there is no demo-recipient fallback: briefing needs consent and a set time", () => {
  const { engine } = makeEngine();
  assert.equal(engine.briefing("anyone"), undefined);
  assert.equal(engine.setBriefing("anyone", "09:00"), false);
});

test("caregiver invite: single use, expires, cannot self-link", () => {
  const { engine, clock } = makeEngine();
  engine.optIn("u1");
  const code = engine.createInvite("u1")!;
  assert.deepEqual(engine.linkCaregiver(code, "u1"), { ok: false, reason: "self" });
  const code2 = engine.createInvite("u1")!;
  assert.deepEqual(engine.linkCaregiver(code2, "c1"), { ok: true, userId: "u1" });
  assert.deepEqual(engine.linkCaregiver(code2, "c2"), { ok: false, reason: "invalid" });
  const code3 = engine.createInvite("u1")!;
  clock.t = new Date(clock.t.getTime() + 25 * 3600_000);
  assert.deepEqual(engine.linkCaregiver(code3, "c3"), { ok: false, reason: "invalid" });
  assert.equal(engine.createInvite("nobody"), undefined);
});

test("failed extraction keeps the message pending and retries later", async () => {
  const { engine, llm, store } = makeEngine();
  engine.optIn("u1");
  llm.fail = true;
  assert.equal(await engine.ingest(msg({ isDirect: true })), "saved_pending");
  assert.equal(store.countFor("u1").pending, 1);
  llm.fail = false;
  assert.equal(await engine.processPending(), 1);
  assert.equal(store.countFor("u1").memories, 1);
});

test("retention purges old messages and their memories", async () => {
  const { engine, clock, store } = makeEngine();
  engine.optIn("u1");
  await engine.ingest(msg({ isDirect: true }));
  clock.t = new Date(clock.t.getTime() + 91 * 86_400_000);
  engine.purgeExpired(90);
  assert.equal(store.countFor("u1").messages, 0);
  assert.equal(store.countFor("u1").memories, 0);
});
