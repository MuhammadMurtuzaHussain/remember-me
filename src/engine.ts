import { randomInt } from "node:crypto";
import { Store, type UserRow } from "./store.js";
import type { Answer, Llm, Memory } from "./types.js";

export const MAX_MESSAGE_CHARS = 1000;
const MAX_ATTEMPTS = 3;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type IngestOutcome =
  | "saved"
  | "saved_pending"
  | "no_consent"
  | "paused"
  | "chat_not_watched"
  | "sender_excluded"
  | "empty"
  | "duplicate";

export type IngestInput = {
  userId: string;
  chatId: string;
  messageId: number;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: Date;
  /** A private chat between the user and the bot needs no /watch. */
  isDirect?: boolean;
};

export type LinkResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "caregiver_busy" | "self" | "no_consent" };

export class Engine {
  constructor(
    readonly store: Store,
    readonly llm: Llm,
    readonly now: () => Date = () => new Date(),
  ) {}

  // ---- consent ----

  /** Nothing is ever stored for a user until this is called by that user. */
  optIn(userId: string): void {
    const now = this.now();
    this.store.ensureUser(userId, now);
    this.store.updateUser(userId, { consent_at: now.toISOString() });
    this.store.audit(userId, "user", "opted in", now);
  }

  /** Stops all capture and briefings. Saved data stays until deleteAll(). */
  optOut(userId: string): void {
    if (!this.store.getUser(userId)) return;
    this.store.updateUser(userId, { consent_at: null, paused: 0, briefing_time: null });
    this.store.audit(userId, "user", "opted out", this.now());
  }

  hasConsent(userId: string): boolean {
    return !!this.store.getUser(userId)?.consentAt;
  }

  deleteAll(userId: string): void {
    this.store.deleteUser(userId);
  }

  // ---- caregiver ----

  createInvite(userId: string): string | undefined {
    if (!this.hasConsent(userId)) return undefined;
    let code = "";
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const now = this.now();
    this.store.createInvite(code, userId, new Date(now.getTime() + INVITE_TTL_MS));
    this.store.audit(userId, "user", "created caregiver invite", now);
    return code;
  }

  linkCaregiver(code: string, caregiverId: string): LinkResult {
    const now = this.now();
    const userId = this.store.takeInvite(code.trim().toUpperCase(), now);
    if (!userId) return { ok: false, reason: "invalid" };
    if (userId === caregiverId) return { ok: false, reason: "self" };
    if (!this.hasConsent(userId)) return { ok: false, reason: "no_consent" };
    if (this.store.getUserByCaregiver(caregiverId)) return { ok: false, reason: "caregiver_busy" };
    this.store.updateUser(userId, { caregiver_id: caregiverId });
    this.store.audit(userId, "caregiver", "caregiver linked", now);
    return { ok: true, userId };
  }

  unlinkCaregiver(userId: string): boolean {
    const u = this.store.getUser(userId);
    if (!u?.caregiverId) return false;
    this.store.updateUser(userId, { caregiver_id: null });
    this.store.audit(userId, "user", "caregiver removed", this.now());
    return true;
  }

  /** Caregiver pause/resume only works inside the user's consent; it can never grant it. */
  setPaused(userId: string, paused: boolean, actor: "user" | "caregiver"): boolean {
    if (!this.hasConsent(userId)) return false;
    this.store.updateUser(userId, { paused: paused ? 1 : 0 });
    this.store.audit(userId, actor, paused ? "paused capture" : "resumed capture", this.now());
    return true;
  }

  status(userId: string) {
    const u = this.store.getUser(userId);
    return {
      consent: !!u?.consentAt,
      paused: !!u?.paused,
      caregiver: !!u?.caregiverId,
      watchedChats: u ? this.store.listWatchedChats(userId) : [],
      briefingTime: u?.briefingTime ?? null,
      timezone: u?.timezone ?? "UTC",
      ...this.store.countFor(userId),
    };
  }

  // ---- watching ----

  watch(userId: string, chatId: string): boolean {
    if (!this.hasConsent(userId)) return false;
    this.store.watchChat(userId, chatId, this.now());
    this.store.audit(userId, "user", "started watching a chat", this.now());
    return true;
  }

  unwatch(userId: string, chatId: string) {
    this.store.unwatchChat(userId, chatId);
    if (this.store.getUser(userId)) this.store.audit(userId, "user", "stopped watching a chat", this.now());
  }

  /** A group member declines capture. Honoured for everyone watching that chat, and erases past messages. */
  excludeSender(chatId: string, senderId: string): number {
    this.store.excludeSender(chatId, senderId);
    return this.store.purgeSenderInChat(chatId, senderId);
  }

  includeSender(chatId: string, senderId: string) {
    this.store.includeSender(chatId, senderId);
  }

  // ---- capture ----

  async ingest(input: IngestInput): Promise<IngestOutcome> {
    const user = this.store.getUser(input.userId);
    if (!user?.consentAt) return "no_consent";
    if (user.paused) return "paused";
    if (!input.isDirect && !this.store.isWatching(input.userId, input.chatId)) return "chat_not_watched";
    if (!input.isDirect && this.store.isExcluded(input.chatId, input.senderId)) return "sender_excluded";
    const text = input.text.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text || text.startsWith("/")) return "empty";

    const saved = this.store.saveMessage({
      userId: input.userId,
      chatId: input.chatId,
      messageId: input.messageId,
      senderId: input.senderId,
      senderName: input.senderName.slice(0, 60),
      text,
      sentAt: input.sentAt.toISOString(),
      receivedAt: this.now().toISOString(),
    });
    if (!saved.inserted) return "duplicate";
    return (await this.processMessage(saved.id)) ? "saved" : "saved_pending";
  }

  private async processMessage(id: number): Promise<boolean> {
    const msg = this.store.getMessage(id);
    if (!msg) return false;
    try {
      const ex = await this.llm.extract({ text: msg.text, sender: msg.senderName, sentAt: msg.sentAt });
      this.store.saveMemory(msg.userId, msg.id, ex, this.now());
      return true;
    } catch (err) {
      console.error(`memory extraction failed for message ${id}:`, (err as Error).message);
      this.store.markAttempt(id, msg.attempts + 1 >= MAX_ATTEMPTS);
      return false;
    }
  }

  /** Retry messages the model could not process (for example Ollama was not running). */
  async processPending(limit = 10): Promise<number> {
    let done = 0;
    for (const m of this.store.listPending(limit, MAX_ATTEMPTS)) {
      if (!this.hasConsent(m.userId)) continue;
      if (await this.processMessage(m.id)) done++;
    }
    return done;
  }

  /** Retention: nothing is kept forever. */
  purgeExpired(retentionDays: number): number {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000);
    return this.store.purgeOlderThan(cutoff);
  }

  // ---- recall ----

  async ask(userId: string, question: string): Promise<{ answer: Answer; sources: Memory[] } | "no_consent" | "no_memories"> {
    if (!this.hasConsent(userId)) return "no_consent";
    const memories = this.store.listMemories(userId, 40);
    if (memories.length === 0) return "no_memories";
    const answer = await this.llm.answer(question.trim().slice(0, 300), memories);
    const byId = new Map(memories.map((m) => [m.id, m]));
    return { answer, sources: answer.memoryIds.map((id) => byId.get(id)!).filter(Boolean) };
  }

  /** Only dated plans make the briefing, so an undated claim in a chat is never promoted to the top of someone's morning.
   * Deterministic on purpose: a briefing never passes through a model, so it cannot invent anything. */
  briefing(userId: string): string | undefined {
    if (!this.hasConsent(userId)) return undefined;
    const since = this.now().getTime() - 3 * 86_400_000;
    const rank = { high: 0, medium: 1, low: 2 } as const;
    const items = this.store
      .listMemories(userId, 40)
      .filter((m) => new Date(m.createdAt).getTime() >= since && m.importance !== "low" && !!m.eventTimeText)
      .sort((a, b) => rank[a.importance] - rank[b.importance] || b.id - a.id)
      .slice(0, 5);
    if (items.length === 0) return undefined;
    const lines = items.map((m) => {
      const when = m.eventTimeText ? ` (${m.eventTimeText})` : "";
      const check = m.needsConfirmation ? " - worth double-checking" : "";
      return `• ${m.summary}${when}${check}`;
    });
    return ["Good morning.", "", "Here is your memory briefing:", ...lines, "", "Ask me anything with /ask."].join("\n");
  }

  setBriefing(userId: string, time: string | null, timezone?: string): boolean {
    if (!this.hasConsent(userId)) return false;
    const patch: Record<string, string | null> = { briefing_time: time };
    if (timezone) patch.timezone = timezone;
    this.store.updateUser(userId, patch);
    return true;
  }

  user(userId: string): UserRow | undefined {
    return this.store.getUser(userId);
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidTime(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}
