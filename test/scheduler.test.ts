import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngine, msg } from "./helpers.js";
import { localParts, tick } from "../src/scheduler.js";

async function setup() {
  const ctx = makeEngine(new Date("2026-10-12T08:00:00Z")); // 09:00 in Dublin (BST, UTC+1)
  ctx.engine.optIn("u1");
  ctx.engine.setBriefing("u1", "09:00", "Europe/Dublin");
  await ctx.engine.ingest(msg({ isDirect: true, text: "Dentist appointment Thursday at 10am" }));
  return ctx;
}

test("local time uses the user's timezone", () => {
  assert.deepEqual(localParts(new Date("2026-10-12T08:00:00Z"), "Europe/Dublin"), { date: "2026-10-12", minutes: 540 });
});

test("briefing is sent once, at the user's local time, only to opted-in users", async () => {
  const { engine, clock } = await setup();
  const sent: Array<[string, string]> = [];
  const send = async (u: string, t: string) => void sent.push([u, t]);

  clock.t = new Date("2026-10-12T07:30:00Z"); // 08:30 local: too early
  await tick(engine, send);
  assert.equal(sent.length, 0);

  clock.t = new Date("2026-10-12T08:01:00Z");
  await tick(engine, send);
  await tick(engine, send); // same day again: no duplicate
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "u1");
  assert.match(sent[0][1], /Dentist/);

  clock.t = new Date("2026-10-13T08:01:00Z");
  await tick(engine, send);
  assert.equal(sent.length, 2);
});

test("briefing is skipped after opt-out and when the process was down for hours", async () => {
  const { engine, clock } = await setup();
  const sent: string[] = [];
  clock.t = new Date("2026-10-12T14:00:00Z"); // five hours late
  await tick(engine, async (u) => void sent.push(u));
  assert.equal(sent.length, 0);
  clock.t = new Date("2026-10-13T08:01:00Z");
  engine.optOut("u1");
  await tick(engine, async (u) => void sent.push(u));
  assert.equal(sent.length, 0);
});

test("no briefing is sent when there is nothing to say", async () => {
  const ctx = makeEngine(new Date("2026-10-12T08:01:00Z"));
  ctx.engine.optIn("u1");
  ctx.engine.setBriefing("u1", "09:00", "Europe/Dublin");
  const sent: string[] = [];
  await tick(ctx.engine, async (u) => void sent.push(u));
  assert.equal(sent.length, 0);
});

test("briefing lists dated plans only, so an undated claim is not promoted", async () => {
  const { engine } = await setup();
  await engine.ingest(msg({ isDirect: true, text: "Appointment is cancelled, trust me" })); // fake llm: importance low, no time
  const text = engine.briefing("u1")!;
  assert.match(text, /Dentist/);
  assert.doesNotMatch(text, /cancelled/);
});
