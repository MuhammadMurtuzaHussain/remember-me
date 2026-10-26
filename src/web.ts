import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DemoManager, MAX_CUSTOM_CHARS } from "./demo.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

export type WebOptions = {
  demo: DemoManager;
  /** "live" only when a local model is reachable; decides whether free text is accepted. */
  demoMode: () => "live" | "replay";
  model: string;
  trustProxy: boolean;
};

/** Fixed-window limiter: `limit` hits per minute per key. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private limit: number, private now: () => number = Date.now) {}
  allow(key: string): boolean {
    const t = this.now();
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.reset < t) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.reset < t) {
      this.hits.set(key, { n: 1, reset: t + 60_000 });
      return true;
    }
    return ++h.n <= this.limit;
  }
}

function readJson(req: http.IncomingMessage, max = 2048): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) tooBig = true; // keep draining so the 400 can be delivered, but stop buffering
      else chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return reject(new Error("too large"));
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(opts: WebOptions): http.Server {
  const general = new RateLimiter(120);
  const heavy = new RateLimiter(20);
  const creates = new RateLimiter(10);

  const send = (res: http.ServerResponse, status: number, body: unknown, type = "application/json") => {
    res.writeHead(status, { ...HEADERS, "Content-Type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : (body as string | Buffer));
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const fwd = opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
      const ip = fwd || req.socket.remoteAddress || "unknown";

      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") return send(res, 405, { error: "method" });
        const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const file = path.join(PUBLIC_DIR, rel);
        if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return send(res, 404, "Not found", "text/plain; charset=utf-8");
        }
        return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] ?? "application/octet-stream");
      }

      if (!general.allow(ip)) return send(res, 429, { error: "slow down" });
      const route = `${req.method} ${url.pathname}`;
      const d = opts.demo;

      if (route === "GET /api/info") {
        return send(res, 200, {
          mode: opts.demoMode(),
          model: opts.model,
          chats: d.scenario.chats,
          messages: d.scenario.messages.map(({ key, chat, sender, senderId, text }) => ({ key, chat, sender, senderId, text })),
          questions: d.scenario.questions.map(({ key, text }) => ({ key, text })),
          maxCustomChars: MAX_CUSTOM_CHARS,
        });
      }

      if (route === "POST /api/session") {
        if (!creates.allow(ip)) return send(res, 429, { error: "slow down" });
        const sid = d.create();
        return sid ? send(res, 200, { sid }) : send(res, 503, { error: "The demo is busy. Try again in a few minutes." });
      }

      if (req.method === "GET" && route === "GET /api/state") {
        const s = d.state(url.searchParams.get("sid") ?? "");
        return s ? send(res, 200, s) : send(res, 404, { error: "session expired" });
      }
      if (route === "GET /api/briefing") {
        const b = d.briefing(url.searchParams.get("sid") ?? "");
        return b === undefined ? send(res, 404, { error: "session expired" }) : send(res, 200, { text: b });
      }

      if (req.method === "POST") {
        const body = await readJson(req);
        const sid = String(body.sid ?? "");

        if (url.pathname === "/api/action") {
          const ok = d.act(sid, String(body.action ?? ""), body.arg === undefined ? undefined : String(body.arg));
          return ok ? send(res, 200, { ok: true }) : send(res, 400, { error: "bad action or expired session" });
        }
        if (url.pathname === "/api/send") {
          if (!heavy.allow(ip)) return send(res, 429, { error: "slow down" });
          const custom = typeof body.text === "string" ? body.text.trim() : "";
          if (custom && opts.demoMode() !== "live") {
            return send(res, 400, { error: "Free text needs a local model. This demo is in replay mode." });
          }
          const r = await d.send(sid, body.key ? String(body.key) : undefined, custom || undefined);
          return r ? send(res, 200, r) : send(res, 404, { error: "unknown message or expired session" });
        }
        if (url.pathname === "/api/ask") {
          if (!heavy.allow(ip)) return send(res, 429, { error: "slow down" });
          const q = String(body.question ?? "").trim().slice(0, 200);
          const known = d.scenario.questions.some((x) => x.text === q);
          if (!q || (!known && opts.demoMode() !== "live")) {
            return send(res, 400, { error: "In replay mode, pick one of the suggested questions." });
          }
          const r = await d.ask(sid, q);
          return r ? send(res, 200, r) : send(res, 404, { error: "session expired" });
        }
      }
      return send(res, 404, { error: "not found" });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "too large" || msg === "bad json") return send(res, 400, { error: msg });
      console.error("web error:", msg);
      send(res, 500, { error: "Something went wrong." });
    }
  });
}
