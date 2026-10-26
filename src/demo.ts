import { randomBytes } from "node:crypto";
import { Engine } from "./engine.js";
import { Store } from "./store.js";
import type { Answer, ExtractInput, Llm, Memory, MemoryExtraction } from "./types.js";

export type Scenario = {
  chats: Array<{ id: string; name: string }>;
  messages: Array<{ key: string; chat: string; senderId: string; sender: string; sentAt: string; text: string }>;
  questions: Array<{ key: string; text: string; requires: string[] }>;
};

export type Fixtures = {
  model: string;
  recordedAt: string;
  extractions: Record<string, MemoryExtraction>;
  answers: Record<string, { answer: string; sourceKeys: string[]; uncertain: boolean }>;
};

export const MAX_SESSIONS = 300;
export const SESSION_TTL_MS = 20 * 60 * 1000;
export const MAX_CUSTOM_CHARS = 280;

/**
 * Replays answers recorded from a real Gemma run for the synthetic messages, and
 * falls back to a live model only when one is available. A hosted demo therefore
 * never needs a model and never sends visitor text to one.
 */
export class DemoLlm implements Llm {
  constructor(
    private scenario: Scenario,
    private fixtures: Fixtures,
    private live: () => Llm | undefined,
  ) {}

  private keyForText(text: string) {
    return this.scenario.messages.find((m) => m.text === text)?.key;
  }

  async extract(input: ExtractInput): Promise<MemoryExtraction> {
    const key = this.keyForText(input.text);
    if (key && this.fixtures.extractions[key]) return this.fixtures.extractions[key];
    const live = this.live();
    if (!live) throw new Error("This demo runs in replay mode: only the synthetic messages can be processed.");
    return live.extract(input);
  }

  async answer(question: string, memories: Memory[]): Promise<Answer> {
    const live = this.live();
    if (live) return live.answer(question, memories);
    const q = this.scenario.questions.find((x) => x.text === question);
    const rec = q && this.fixtures.answers[q.key];
    const have = new Map<string, Memory>();
    for (const m of memories) {
      const key = this.keyForText(m.sourceText);
      if (key) have.set(key, m);
    }
    // A recording is only valid if every message it was recorded from has been saved.
    if (!q || !rec || !q.requires.every((k) => have.has(k))) {
      return {
        answer: "I do not have a saved memory that answers that yet.",
        memoryIds: [],
        uncertain: true,
      };
    }
    return {
      answer: rec.answer,
      memoryIds: rec.sourceKeys.map((k) => have.get(k)?.id).filter((x): x is number => typeof x === "number"),
      uncertain: rec.uncertain,
    };
  }
}

type Session = { id: string; last: number; log: Array<{ at: string; text: string; outcome: string }> };

export class DemoManager {
  readonly engine: Engine;
  private sessions = new Map<string, Session>();

  constructor(
    readonly scenario: Scenario,
    fixtures: Fixtures,
    live: () => Llm | undefined,
    private now: () => number = Date.now,
  ) {
    // In-memory only: a demo never touches disk.
    this.engine = new Engine(new Store(":memory:"), new DemoLlm(scenario, fixtures, live));
  }

  private uid = (sid: string) => `demo:${sid}`;
  private chat = (sid: string, c: string) => `${sid}:${c}`;

  create(): string | undefined {
    this.sweep();
    if (this.sessions.size >= MAX_SESSIONS) return undefined;
    const id = randomBytes(9).toString("base64url");
    this.sessions.set(id, { id, last: this.now(), log: [] });
    return id;
  }

  private get(sid: string): Session | undefined {
    const s = this.sessions.get(sid);
    if (!s) return undefined;
    if (this.now() - s.last > SESSION_TTL_MS) {
      this.destroy(sid);
      return undefined;
    }
    s.last = this.now();
    return s;
  }

  destroy(sid: string) {
    if (!this.sessions.delete(sid)) return;
    this.engine.deleteAll(this.uid(sid));
    this.engine.store.db.prepare("DELETE FROM excluded_senders WHERE chat_id LIKE ?").run(`${sid}:%`);
  }

  sweep() {
    for (const s of [...this.sessions.values()]) {
      if (this.now() - s.last > SESSION_TTL_MS) this.destroy(s.id);
    }
  }

  size() {
    return this.sessions.size;
  }

  state(sid: string) {
    const s = this.get(sid);
    if (!s) return undefined;
    const uid = this.uid(sid);
    const st = this.engine.status(uid);
    const watched = st.watchedChats.map((c) => c.slice(sid.length + 1));
    const excluded = this.scenario.messages
      .map((m) => m.senderId)
      .filter((v, i, a) => a.indexOf(v) === i)
      .filter((sender) => this.scenario.chats.some((c) => this.engine.store.isExcluded(this.chat(sid, c.id), sender)));
    return {
      consent: st.consent,
      paused: st.paused,
      watched,
      excluded,
      counts: { messages: st.messages, memories: st.memories },
      memories: this.engine.store.listMemories(uid, 40).map((m) => ({
        id: m.id,
        summary: m.summary,
        importance: m.importance,
        eventTitle: m.eventTitle,
        eventTimeText: m.eventTimeText,
        needsConfirmation: m.needsConfirmation,
        sender: m.senderName,
        source: m.sourceText,
        sentAt: m.sentAt,
      })),
      audit: this.engine.store.listAudit(uid, 8).map((a) => ({ at: a.at, actor: a.actor, event: a.event })),
      log: s.log.slice(-12),
    };
  }

  act(sid: string, action: string, arg?: string): boolean {
    if (!this.get(sid)) return false;
    const uid = this.uid(sid);
    const chatOk = arg && this.scenario.chats.some((c) => c.id === arg);
    switch (action) {
      case "optin": this.engine.optIn(uid); return true;
      case "optout": this.engine.optOut(uid); return true;
      case "pause": return this.engine.setPaused(uid, true, "caregiver") || true;
      case "resume": return this.engine.setPaused(uid, false, "caregiver") || true;
      case "delete": this.engine.deleteAll(uid); return true;
      case "watch": if (chatOk) this.engine.watch(uid, this.chat(sid, arg!)); return true;
      case "unwatch": if (chatOk) this.engine.unwatch(uid, this.chat(sid, arg!)); return true;
      case "notme": {
        const m = this.scenario.messages.find((x) => x.senderId === arg);
        if (m) this.engine.excludeSender(this.chat(sid, "family"), m.senderId);
        return true;
      }
      case "includeme": {
        const m = this.scenario.messages.find((x) => x.senderId === arg);
        if (m) this.engine.includeSender(this.chat(sid, "family"), m.senderId);
        return true;
      }
      default: return false;
    }
  }

  async send(sid: string, key?: string, customText?: string): Promise<{ outcome: string; text: string } | undefined> {
    const s = this.get(sid);
    if (!s) return undefined;
    const base = this.scenario.messages.find((m) => m.key === key);
    const msg = base ?? (customText
      ? { key: "custom", chat: "family", senderId: "you", sender: "Sam", sentAt: new Date().toISOString(), text: customText.slice(0, MAX_CUSTOM_CHARS) }
      : undefined);
    if (!msg) return undefined;
    const outcome = await this.engine.ingest({
      userId: this.uid(sid),
      chatId: this.chat(sid, msg.chat),
      messageId: s.log.length + 1 + Math.floor(Math.random() * 1e6),
      senderId: msg.senderId,
      senderName: msg.sender,
      text: msg.text,
      sentAt: new Date(msg.sentAt),
    });
    s.log.push({ at: new Date(this.now()).toISOString(), text: `${msg.sender}: ${msg.text}`, outcome });
    return { outcome, text: msg.text };
  }

  async ask(sid: string, question: string) {
    if (!this.get(sid)) return undefined;
    const r = await this.engine.ask(this.uid(sid), question);
    if (typeof r === "string") return { status: r };
    return {
      status: "ok" as const,
      answer: r.answer.answer,
      uncertain: r.answer.uncertain,
      sources: r.sources.map((m) => ({ sender: m.senderName, text: m.sourceText, sentAt: m.sentAt })),
    };
  }

  briefing(sid: string) {
    if (!this.get(sid)) return undefined;
    return this.engine.briefing(this.uid(sid)) ?? null;
  }
}
