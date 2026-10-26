/** Minimal Telegram Bot API client over fetch. No Telegram user session, no MTProto. */
export type TgUser = { id: number; is_bot?: boolean; first_name?: string; username?: string };
export type TgMessage = {
  message_id: number;
  date: number;
  text?: string;
  from?: TgUser;
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
};
export type TgUpdate = { update_id: number; message?: TgMessage };

export class TelegramApi {
  constructor(private token: string) {}

  private async call<T>(method: string, body: object, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
    return data.result;
  }

  getMe() {
    return this.call<{ id: number; username: string }>("getMe", {});
  }

  getUpdates(offset: number, timeoutSec = 25) {
    return this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message"] },
      (timeoutSec + 10) * 1000,
    );
  }

  async sendMessage(chatId: string | number, text: string) {
    await this.call("sendMessage", { chat_id: chatId, text: text.slice(0, 4000) });
  }
}
