import type { Engine } from "./engine.js";

/** How late a briefing may still be sent (process was down at 09:00). After this we skip the day. */
const CATCH_UP_MINUTES = 180;

export type SendFn = (userId: string, text: string) => Promise<void>;

export function localParts(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** One scheduler pass. Exported so tests can drive it with a fake clock. */
export async function tick(engine: Engine, send: SendFn): Promise<string[]> {
  const sent: string[] = [];
  const now = engine.now();
  for (const user of engine.store.listBriefingUsers()) {
    const [h, m] = user.briefingTime!.split(":").map(Number);
    const local = localParts(now, user.timezone);
    const target = h * 60 + m;
    if (user.lastBriefingOn === local.date) continue;
    if (local.minutes < target || local.minutes > target + CATCH_UP_MINUTES) continue;

    const text = engine.briefing(user.id);
    // Mark the day first so a failing send never turns into a retry storm.
    engine.store.updateUser(user.id, { last_briefing_on: local.date });
    if (!text) continue;
    try {
      await send(user.id, text);
      sent.push(user.id);
    } catch (err) {
      console.error("briefing send failed:", (err as Error).message);
    }
  }
  return sent;
}

/** A plain interval loop. No external scheduler, no cron service. */
export function startScheduler(
  engine: Engine,
  send: SendFn,
  opts: { intervalMs?: number; retentionDays: number },
): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await engine.processPending();
      await tick(engine, send);
      engine.purgeExpired(opts.retentionDays);
    } catch (err) {
      console.error("scheduler pass failed:", (err as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, opts.intervalMs ?? 30_000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
