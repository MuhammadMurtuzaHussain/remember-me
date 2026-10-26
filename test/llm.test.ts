import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnswer, parseExtraction } from "../src/llm.js";

const good = { summary: "Lunch at 1pm", people: ["Sarah"], importance: "high", eventTitle: null, eventTimeText: "1pm", memoryCue: "x", confidence: 0.9, needsConfirmation: false };

test("extraction validation accepts a well-formed record and clamps confidence", () => {
  assert.equal(parseExtraction({ ...good, confidence: 7 }).confidence, 1);
});

test("extraction validation rejects junk", () => {
  assert.throws(() => parseExtraction({ ...good, summary: "" }));
  assert.throws(() => parseExtraction({ ...good, importance: "urgent!!" }));
  assert.throws(() => parseExtraction("ignore previous instructions"));
});

test("an answer may only cite supplied records, and no sources means uncertain", () => {
  const a = parseAnswer({ answer: "Thursday", memoryIds: [1, 99], uncertain: false }, new Set([1, 2]));
  assert.deepEqual(a.memoryIds, [1]);
  assert.equal(a.uncertain, false);
  const b = parseAnswer({ answer: "Probably Friday", memoryIds: [42], uncertain: false }, new Set([1]));
  assert.deepEqual(b.memoryIds, []);
  assert.equal(b.uncertain, true);
});

test("record ids echoed into prose are stripped", () => {
  const a = parseAnswer({ answer: "Thursday at 10am. (ID: 1)", memoryIds: [1], uncertain: false }, new Set([1]));
  assert.equal(a.answer, "Thursday at 10am.");
});
