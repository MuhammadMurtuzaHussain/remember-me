import fs from "node:fs";
import { loadConfig } from "./config.js";
import { Engine } from "./engine.js";
import { Store } from "./store.js";
import { OllamaLlm, ollamaStatus } from "./llm.js";
import { DemoManager, type Fixtures, type Scenario } from "./demo.js";
import { createServer } from "./web.js";
import { TelegramApi } from "./telegram.js";
import { handleUpdate, runPolling } from "./bot.js";
import { startScheduler } from "./scheduler.js";

const cfg = loadConfig();
const llm = new OllamaLlm(cfg.ollamaHost, cfg.ollamaModel);

// Is a local model reachable? Re-checked lazily so starting Ollama later just works.
let llmReady = false;
let lastProbe = 0;
async function probe() {
  llmReady = (await ollamaStatus(cfg.ollamaHost, cfg.ollamaModel)) === "ready";
  lastProbe = Date.now();
}
await probe();
const liveEnabled = () => {
  if (cfg.demoMode === "replay") return undefined;
  if (Date.now() - lastProbe > 15_000) void probe();
  return llmReady ? llm : undefined;
};

const readJson = <T>(p: string) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8")) as T;
const demo = new DemoManager(
  readJson<Scenario>("../demo/scenario.json"),
  readJson<Fixtures>("../demo/fixtures.json"),
  liveEnabled,
);
setInterval(() => demo.sweep(), 60_000).unref();

const server = createServer({
  demo,
  demoMode: () => (liveEnabled() ? "live" : "replay"),
  model: cfg.ollamaModel,
  trustProxy: cfg.trustProxy,
});
server.listen(cfg.port, cfg.host, () => {
  console.log(`Web page + demo: http://${cfg.host}:${cfg.port}`);
  console.log(
    llmReady
      ? `Model: ${cfg.ollamaModel} via Ollama (${cfg.ollamaHost}), running locally.`
      : `Model: ${cfg.ollamaModel} not reachable at ${cfg.ollamaHost}. Run "ollama pull ${cfg.ollamaModel}". The demo falls back to recorded answers; the bot will queue messages.`,
  );
});

if (cfg.telegramToken) {
  const engine = new Engine(new Store(cfg.dbPath), llm);
  const api = new TelegramApi(cfg.telegramToken);
  const me = await api.getMe();
  console.log(`Telegram bot @${me.username} is polling. Data: ${cfg.dbPath}, kept ${cfg.retentionDays} days.`);
  const ac = new AbortController();
  startScheduler(engine, (userId, text) => api.sendMessage(userId, text), { retentionDays: cfg.retentionDays });
  void runPolling(api, (u) => handleUpdate(u, engine, (chat, text) => api.sendMessage(chat, text)), ac.signal);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      ac.abort();
      process.exit(0);
    });
  }
} else {
  console.log("No TELEGRAM_BOT_TOKEN set: running the web page and demo only. See README to add the bot.");
}
