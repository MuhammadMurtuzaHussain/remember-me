import fs from "node:fs";

export type Config = {
  port: number;
  host: string;
  dbPath: string;
  telegramToken: string | undefined;
  ollamaHost: string;
  ollamaModel: string;
  retentionDays: number;
  demoMode: "auto" | "replay" | "live";
  trustProxy: boolean;
};

/** Reads .env (if present) without a dependency, then the real environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && fs.existsSync(".env")) process.loadEnvFile(".env");
  const demoMode = (env.DEMO_MODE ?? "auto") as Config["demoMode"];
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.DB_PATH ?? "data/remember-me.db",
    telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    ollamaHost: (env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, ""),
    ollamaModel: env.OLLAMA_MODEL ?? "gemma4:e4b",
    retentionDays: Number(env.RETENTION_DAYS ?? 90),
    demoMode: ["auto", "replay", "live"].includes(demoMode) ? demoMode : "auto",
    trustProxy: env.TRUST_PROXY === "1",
  };
}
