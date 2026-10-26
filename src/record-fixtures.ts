import fs from "node:fs";
import { loadConfig } from "./config.js";
import { Engine } from "./engine.js";
import { Store } from "./store.js";
import { OllamaLlm } from "./llm.js";
import type { Fixtures, Scenario } from "./demo.js";
import type { MemoryExtraction } from "./types.js";

// Records real model output for the synthetic scenario so a hosted demo can replay it.
const cfg = loadConfig();
const llm = new OllamaLlm(cfg.ollamaHost, cfg.ollamaModel);
const scenario = JSON.parse(fs.readFileSync("demo/scenario.json", "utf8")) as Scenario;

const extractions: Record<string, MemoryExtraction> = {};
for (const m of scenario.messages) {
  extractions[m.key] = await llm.extract({ text: m.text, sender: m.sender, sentAt: m.sentAt });
  console.log("extracted", m.key, "->", extractions[m.key].summary);
}

const answers: Fixtures["answers"] = {};
for (const q of scenario.questions) {
  const engine = new Engine(new Store(":memory:"), llm);
  engine.optIn("rec");
  engine.watch("rec", "c");
  for (const key of q.requires) {
    const m = scenario.messages.find((x) => x.key === key)!;
    await engine.ingest({ userId: "rec", chatId: "c", messageId: scenario.messages.indexOf(m) + 1, senderId: m.senderId, senderName: m.sender, text: m.text, sentAt: new Date(m.sentAt) });
  }
  const r = await engine.ask("rec", q.text);
  if (typeof r === "string") throw new Error(`no answer for ${q.key}`);
  const sourceKeys = r.sources.map((s) => scenario.messages.find((m) => m.text === s.sourceText)!.key);
  answers[q.key] = { answer: r.answer.answer, sourceKeys, uncertain: r.answer.uncertain };
  console.log("answered", q.key, "->", r.answer.answer, sourceKeys);
}

const out: Fixtures = { model: cfg.ollamaModel, recordedAt: new Date().toISOString(), extractions, answers };
fs.writeFileSync("demo/fixtures.json", JSON.stringify(out, null, 2) + "\n");
console.log("wrote demo/fixtures.json");
