import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import type { Answer, ExtractInput, Llm, Memory, MemoryExtraction } from "../src/types.js";

export class FakeLlm implements Llm {
  calls: string[] = [];
  fail = false;
  async extract(input: ExtractInput): Promise<MemoryExtraction> {
    this.calls.push(input.text);
    if (this.fail) throw new Error("model down");
    return {
      summary: `Said: ${input.text}`,
      people: [input.sender],
      importance: /appointment|lunch/i.test(input.text) ? "high" : "low",
      eventTitle: null,
      eventTimeText: /tomorrow|Thursday|Friday|\d\s?(am|pm)/i.exec(input.text)?.[0] ?? null,
      memoryCue: "cue",
      confidence: 0.9,
      needsConfirmation: false,
    };
  }
  async answer(_q: string, memories: Memory[]): Promise<Answer> {
    return { answer: `Found ${memories.length}`, memoryIds: memories.map((m) => m.id), uncertain: false };
  }
}

export function makeEngine(start = new Date("2026-10-12T08:00:00Z")) {
  const clock = { t: start };
  const llm = new FakeLlm();
  const engine = new Engine(new Store(":memory:"), llm, () => clock.t);
  return { engine, llm, clock, store: engine.store };
}

let n = 0;
export const msg = (over: Partial<Parameters<Engine["ingest"]>[0]> = {}) => ({
  userId: "u1",
  chatId: "g1",
  messageId: ++n,
  senderId: "s1",
  senderName: "Sarah",
  text: "Lunch tomorrow at 1pm",
  sentAt: new Date("2026-10-12T07:00:00Z"),
  ...over,
});
