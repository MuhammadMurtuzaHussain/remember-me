import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngine } from "./helpers.js";
import { handleUpdate } from "../src/bot.js";
import type { TgUpdate } from "../src/telegram.js";

let uid = 0;
function harness() {
  const ctx = makeEngine();
  const out: Array<[string, string]> = [];
  const reply = async (c: string, t: string) => void out.push([c, t]);
  const say = (from: number, chat: number, text: string, type: "private" | "group" = chat > 0 ? "private" : "group") =>
    handleUpdate({ update_id: ++uid, message: { message_id: uid, date: 1_760_000_000, text, from: { id: from, first_name: `U${from}` }, chat: { id: chat, type } } } as TgUpdate, ctx.engine, reply);
  return { ...ctx, out, say, last: () => out[out.length - 1] };
}

test("/start explains consent and stores nothing", async () => {
  const h = harness();
  await h.say(1, 1, "/start");
  assert.match(h.last()[1], /Send \/optin to agree/);
  assert.equal(h.store.getUser("1"), undefined);
});

test("plain text in DM is not saved before /optin", async () => {
  const h = harness();
  await h.say(1, 1, "remember my keys are in the drawer");
  assert.match(h.last()[1], /not saved/);
  assert.equal(h.store.countFor("1").messages, 0);
});

test("full flow: opt in, watch a group, group message saved, ask, delete", async () => {
  const h = harness();
  await h.say(1, 1, "/optin");
  await h.say(1, -100, "/watch");
  assert.match(h.last()[1], /\/notme/); // the group is told, and shown how to opt out
  await h.say(2, -100, "Lunch tomorrow at 1pm");
  assert.equal(h.store.countFor("1").memories, 1);
  await h.say(1, 1, "/ask what is happening?");
  assert.match(h.last()[1], /Lunch tomorrow/);
  await h.say(1, 1, "/deletemydata");
  assert.match(h.last()[1], /confirm/);
  assert.ok(h.store.getUser("1"));
  await h.say(1, 1, "/deletemydata confirm");
  assert.equal(h.store.getUser("1"), undefined);
});

test("someone who has not opted in cannot /watch a group", async () => {
  const h = harness();
  await h.say(5, -100, "/watch");
  assert.match(h.last()[1], /opted in/);
  await h.say(6, -100, "hello");
  assert.equal(h.store.countFor("5").messages, 0);
});

test("a group member can /notme", async () => {
  const h = harness();
  await h.say(1, 1, "/optin");
  await h.say(1, -100, "/watch");
  await h.say(2, -100, "I am bringing cake");
  await h.say(2, -100, "/notme");
  assert.match(h.last()[1], /erased 1/);
  assert.equal(h.store.countFor("1").messages, 0);
});

test("caregiver flow: invite, link, pause, user is told, caregiver cannot read memories", async () => {
  const h = harness();
  await h.say(1, 1, "/optin");
  await h.say(1, 1, "/invite");
  const code = /\n\n([A-Z2-9]{8})\n/.exec(h.last()[1])![1];
  await h.say(9, 9, `/caregiver ${code}`);
  assert.match(h.last()[1], /now linked/);
  await h.say(9, 9, "/pause");
  assert.equal(h.store.getUser("1")!.paused, true);
  assert.ok(h.out.some(([c, t]) => c === "1" && /caregiver paused/.test(t)));
  await h.say(9, 9, "/ask what is happening");
  assert.match(h.last()[1], /optin first/); // no access to the person's memories
  await h.say(1, 1, "/removecaregiver");
  await h.say(9, 9, "/pause");
  assert.equal(h.store.getUser("9"), undefined); // nothing created for a stranger
});

test("a stranger's /pause changes nothing", async () => {
  const h = harness();
  await h.say(1, 1, "/optin");
  await h.say(7, 7, "/pause");
  assert.equal(h.store.getUser("1")!.paused, false);
});

test("bad briefing input is rejected", async () => {
  const h = harness();
  await h.say(1, 1, "/optin");
  await h.say(1, 1, "/briefing 25:99");
  assert.match(h.last()[1], /24-hour/);
  await h.say(1, 1, "/briefing 09:30");
  assert.equal(h.store.getUser("1")!.briefingTime, "09:30");
});
