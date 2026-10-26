import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Memory, MemoryExtraction } from "./types.js";

export type UserRow = {
  id: string;
  consentAt: string | null;
  paused: boolean;
  caregiverId: string | null;
  timezone: string;
  briefingTime: string | null;
  lastBriefingOn: string | null;
};

export type MessageRow = {
  id: number;
  userId: string;
  chatId: string;
  messageId: number;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: string;
  status: "pending" | "done" | "failed";
  attempts: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  consent_at TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  caregiver_id TEXT UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  briefing_time TEXT,
  last_briefing_on TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watched_chats (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, chat_id)
);
CREATE TABLE IF NOT EXISTS excluded_senders (
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, sender_id)
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  text TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  people_json TEXT NOT NULL,
  importance TEXT NOT NULL,
  event_title TEXT,
  event_time_text TEXT,
  memory_cue TEXT NOT NULL,
  confidence REAL NOT NULL,
  needs_confirmation INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL
);
`;

/**
 * All persistence lives here. Every row that holds personal content carries a
 * user_id with ON DELETE CASCADE, so deleting the users row removes everything.
 */
export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new Database(file);
    if (file !== ":memory:") this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // Overwrite deleted content so "delete my data" is not just an unlinked page.
    this.db.pragma("secure_delete = ON");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // ---- users ----

  getUser(id: string): UserRow | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
    return r && toUser(r);
  }

  ensureUser(id: string, now: Date): UserRow {
    this.db
      .prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)")
      .run(id, now.toISOString());
    return this.getUser(id)!;
  }

  updateUser(id: string, patch: Partial<Record<string, string | number | null>>) {
    const cols = Object.keys(patch);
    if (cols.length === 0) return;
    const sql = `UPDATE users SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...cols.map((c) => patch[c] as any), id);
  }

  listBriefingUsers(): UserRow[] {
    return (
      this.db
        .prepare("SELECT * FROM users WHERE consent_at IS NOT NULL AND briefing_time IS NOT NULL")
        .all() as any[]
    ).map(toUser);
  }

  getUserByCaregiver(caregiverId: string): UserRow | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE caregiver_id = ?").get(caregiverId) as any;
    return r && toUser(r);
  }

  /** Deletes the user and, via cascade, every message, memory, invite and audit row. */
  deleteUser(id: string) {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    if (this.db.name !== ":memory:" && this.db.name !== "") {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    }
  }

  audit(userId: string, actor: string, event: string, now: Date) {
    this.db
      .prepare("INSERT INTO audit (user_id, at, actor, event) VALUES (?, ?, ?, ?)")
      .run(userId, now.toISOString(), actor, event);
  }

  listAudit(userId: string, limit = 20) {
    return this.db
      .prepare("SELECT at, actor, event FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .all(userId, limit) as Array<{ at: string; actor: string; event: string }>;
  }

  // ---- watched chats / exclusions ----

  watchChat(userId: string, chatId: string, now: Date) {
    this.db
      .prepare("INSERT OR IGNORE INTO watched_chats (user_id, chat_id, added_at) VALUES (?, ?, ?)")
      .run(userId, chatId, now.toISOString());
  }

  unwatchChat(userId: string, chatId: string) {
    this.db.prepare("DELETE FROM watched_chats WHERE user_id = ? AND chat_id = ?").run(userId, chatId);
  }

  isWatching(userId: string, chatId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM watched_chats WHERE user_id = ? AND chat_id = ?")
      .get(userId, chatId);
  }

  listWatchedChats(userId: string): string[] {
    return (
      this.db.prepare("SELECT chat_id FROM watched_chats WHERE user_id = ?").all(userId) as any[]
    ).map((r) => r.chat_id);
  }

  watchersOfChat(chatId: string): string[] {
    return (
      this.db.prepare("SELECT user_id FROM watched_chats WHERE chat_id = ?").all(chatId) as any[]
    ).map((r) => r.user_id);
  }

  excludeSender(chatId: string, senderId: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO excluded_senders (chat_id, sender_id) VALUES (?, ?)")
      .run(chatId, senderId);
  }

  includeSender(chatId: string, senderId: string) {
    this.db
      .prepare("DELETE FROM excluded_senders WHERE chat_id = ? AND sender_id = ?")
      .run(chatId, senderId);
  }

  isExcluded(chatId: string, senderId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM excluded_senders WHERE chat_id = ? AND sender_id = ?")
      .get(chatId, senderId);
  }

  listExcluded(chatId: string): string[] {
    return (
      this.db.prepare("SELECT sender_id FROM excluded_senders WHERE chat_id = ?").all(chatId) as any[]
    ).map((r) => r.sender_id);
  }

  /** Erase what was already saved from one sender in one chat. */
  purgeSenderInChat(chatId: string, senderId: string): number {
    return this.db
      .prepare("DELETE FROM messages WHERE chat_id = ? AND sender_id = ?")
      .run(chatId, senderId).changes;
  }

  // ---- invites ----

  createInvite(code: string, userId: string, expiresAt: Date) {
    this.db.prepare("DELETE FROM invites WHERE user_id = ?").run(userId);
    this.db
      .prepare("INSERT INTO invites (code, user_id, expires_at) VALUES (?, ?, ?)")
      .run(code, userId, expiresAt.toISOString());
  }

  takeInvite(code: string, now: Date): string | undefined {
    const row = this.db.prepare("SELECT user_id, expires_at FROM invites WHERE code = ?").get(code) as any;
    if (!row) return undefined;
    this.db.prepare("DELETE FROM invites WHERE code = ?").run(code);
    return new Date(row.expires_at) > now ? row.user_id : undefined;
  }

  // ---- messages / memories ----

  saveMessage(m: {
    userId: string;
    chatId: string;
    messageId: number;
    senderId: string;
    senderName: string;
    text: string;
    sentAt: string;
    receivedAt: string;
  }): { inserted: boolean; id: number } {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
         (user_id, chat_id, message_id, sender_id, sender_name, text, sent_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.userId, m.chatId, m.messageId, m.senderId, m.senderName, m.text, m.sentAt, m.receivedAt);
    return { inserted: r.changes === 1, id: Number(r.lastInsertRowid) };
  }

  getMessage(id: number): MessageRow | undefined {
    const r = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as any;
    return r && toMessage(r);
  }

  listPending(limit: number, maxAttempts: number): MessageRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM messages WHERE status = 'pending' AND attempts < ? ORDER BY id LIMIT ?",
        )
        .all(maxAttempts, limit) as any[]
    ).map(toMessage);
  }

  markAttempt(id: number, failedForGood: boolean) {
    this.db
      .prepare("UPDATE messages SET attempts = attempts + 1, status = ? WHERE id = ?")
      .run(failedForGood ? "failed" : "pending", id);
  }

  saveMemory(userId: string, messageId: number, m: MemoryExtraction, now: Date): number {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO memories
         (user_id, message_id, summary, people_json, importance, event_title, event_time_text,
          memory_cue, confidence, needs_confirmation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        messageId,
        m.summary,
        JSON.stringify(m.people),
        m.importance,
        m.eventTitle,
        m.eventTimeText,
        m.memoryCue,
        m.confidence,
        m.needsConfirmation ? 1 : 0,
        now.toISOString(),
      );
    this.db.prepare("UPDATE messages SET status = 'done' WHERE id = ?").run(messageId);
    return Number(r.lastInsertRowid);
  }

  listMemories(userId: string, limit = 40): Memory[] {
    return (
      this.db
        .prepare(
          `SELECT m.*, s.text AS source_text, s.sender_name, s.sent_at, s.chat_id
           FROM memories m JOIN messages s ON s.id = m.message_id
           WHERE m.user_id = ? ORDER BY m.id DESC LIMIT ?`,
        )
        .all(userId, limit) as any[]
    ).map(toMemory);
  }

  countFor(userId: string) {
    const one = (sql: string) => (this.db.prepare(sql).get(userId) as any).n as number;
    return {
      messages: one("SELECT COUNT(*) n FROM messages WHERE user_id = ?"),
      memories: one("SELECT COUNT(*) n FROM memories WHERE user_id = ?"),
      pending: one("SELECT COUNT(*) n FROM messages WHERE user_id = ? AND status = 'pending'"),
    };
  }

  /** Retention: drop messages (and their memories) older than the cut-off. */
  purgeOlderThan(cutoff: Date): number {
    return this.db.prepare("DELETE FROM messages WHERE received_at < ?").run(cutoff.toISOString()).changes;
  }

  /** Remove demo-style users whose id starts with a prefix and who were created before cutoff. */
  deleteUsersCreatedBefore(prefix: string, cutoff: Date): number {
    return this.db
      .prepare("DELETE FROM users WHERE id LIKE ? AND created_at < ?")
      .run(`${prefix}%`, cutoff.toISOString()).changes;
  }
}

function toUser(r: any): UserRow {
  return {
    id: r.id,
    consentAt: r.consent_at,
    paused: r.paused === 1,
    caregiverId: r.caregiver_id,
    timezone: r.timezone,
    briefingTime: r.briefing_time,
    lastBriefingOn: r.last_briefing_on,
  };
}

function toMessage(r: any): MessageRow {
  return {
    id: r.id,
    userId: r.user_id,
    chatId: r.chat_id,
    messageId: r.message_id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    text: r.text,
    sentAt: r.sent_at,
    status: r.status,
    attempts: r.attempts,
  };
}

function toMemory(r: any): Memory {
  return {
    id: r.id,
    messageId: r.message_id,
    summary: r.summary,
    people: JSON.parse(r.people_json),
    importance: r.importance,
    eventTitle: r.event_title,
    eventTimeText: r.event_time_text,
    memoryCue: r.memory_cue,
    confidence: r.confidence,
    needsConfirmation: r.needs_confirmation === 1,
    sourceText: r.source_text,
    senderName: r.sender_name,
    sentAt: r.sent_at,
    chatId: r.chat_id,
    createdAt: r.created_at,
  };
}
