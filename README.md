# Remember Me

A consent-first memory companion for Telegram. Someone opts in, chooses which chats to share, and Remember Me turns the plans in them into short, source-backed memories. They can ask *"What am I doing tomorrow?"* and get an answer with the original message attached, plus an optional morning briefing.

The language model is open-weight **Gemma 4 running through [Ollama](https://ollama.com) on your own machine**. No cloud AI service is involved.

![The sandbox demo: consent controls, incoming synthetic messages, and the memories built from them](docs/screenshot.png)

> Remember Me is a memory aid, not a medical device. It does not diagnose, and nobody should rely on it as the only way to track an important appointment.

Created and maintained by **Muhammad Murtuza Hussain**. It began as a hackathon prototype; this version is a complete rework (see [What changed](#what-changed-from-the-hackathon-prototype)).

## Run it

You need Node 20+ and Ollama.

```bash
ollama pull gemma4:e4b
git clone https://github.com/MuhammadMurtuzaHussain/remember-me
cd remember-me && npm install && npm start
```

Open <http://127.0.0.1:8787> for the explainer page and the sandbox demo. With no configuration that is all that starts, and it works without Ollama too (the demo then replays recorded answers).

### Turn on the Telegram bot

1. Talk to [@BotFather](https://t.me/BotFather), create a bot, copy the token.
2. For group capture, also run `/setprivacy` in BotFather and choose **Disable**, otherwise Telegram only shows the bot commands in groups.
3. `cp .env.example .env`, set `TELEGRAM_BOT_TOKEN`, run `npm start`.

The bot uses long polling, so there is nothing to expose to the internet.

## How consent works

| Who | Command | What it does |
| --- | --- | --- |
| The person | `/start` | Explains what is stored. Stores nothing. |
| The person | `/optin` | Explicit consent. Nothing is saved for anyone before this. |
| The person | `/watch` *(in a group)* | Saves that group's text messages for them. The bot announces it to the group. |
| Anyone in the group | `/notme` | Leaves them out and **erases what was already saved from them**. `/includeme` reverses it. |
| The person | `/ask <question>` | Answers from their memories, citing the original messages. |
| The person | `/pause`, `/resume` | Stops or restarts saving. |
| The person | `/optout` | Stops all saving and briefings. Keeps data until deleted. |
| The person | `/deletemydata confirm` | Erases every message, memory, invite and log row for them. |
| The person | `/mydata` | Shows what is held, plus recent consent events. |
| The person | `/invite` | One-day, single-use code for a caregiver. |
| The caregiver | `/caregiver CODE` | Links to that person. |
| The caregiver | `/status`, `/pause`, `/resume` | See whether saving is active, pause or resume it. The person is told each time. A caregiver **cannot** read memories and **cannot** turn on capture the person has not consented to. |
| The person | `/briefing 09:00`, `/timezone Europe/Dublin` | Opt in to a daily briefing. Off by default. |

Plain text sent to the bot in a private chat is saved as a note, once the person has opted in.

Records are per user: every row carries the person's Telegram ID, and deleting that user cascades to everything else. There is no shared "demo recipient". If nobody has opted in, nothing is stored and nothing is sent.

## Configuration

Copy `.env.example` to `.env`. All values are optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | *(none)* | Enables the bot. |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Where Ollama listens. |
| `OLLAMA_MODEL` | `gemma4:e4b` | Any Ollama model that supports JSON-schema output. |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Web server bind address. |
| `DB_PATH` | `data/remember-me.db` | SQLite file for real users. |
| `RETENTION_DAYS` | `90` | Messages and memories older than this are deleted automatically. |
| `DEMO_MODE` | `auto` | `auto`, `replay` or `live`; see below. |

## The sandbox demo

The web page includes a demo that uses **only synthetic people and messages**. It shares the real engine (consent checks, watching, `/notme`, pause, delete, briefing) but:

- it uses its own in-memory database, never the real one, and never touches Telegram or the disk;
- each visitor gets an isolated session that is deleted after 20 minutes idle (max 300 at once);
- in **replay** mode (what a hosted server uses) answers come from `demo/fixtures.json`, recorded from a real `gemma4:e4b` run on exactly those messages, so a hosted instance needs no model and never sends visitor text anywhere;
- in **live** mode (Ollama has the model) visitors can type their own messages and questions;
- requests are rate limited, bodies are capped at 2 KB, and the CSP forbids anything but same-origin scripts.

Regenerate the recordings with `npm run demo:record`.

## Scheduler

The 9:00 briefing used to depend on Trigger.dev. It is now a 30-second interval loop in `src/scheduler.ts`. It checks each opted-in person's own timezone, sends at most one briefing a day, skips the day if the process was down for more than three hours, and retries messages the model could not process earlier. The briefing is built without the model from saved, dated memories so it cannot invent anything.

## Project layout

```
src/engine.ts      consent rules, capture, recall, briefing (the whole product logic)
src/store.ts       SQLite schema, per-user rows, cascade delete, secure_delete
src/llm.ts         Ollama client, prompts, output validation
src/bot.ts         Telegram commands, group handling, long polling
src/telegram.ts    tiny Bot API client over fetch
src/scheduler.ts   daily briefing + retry + retention loop
src/demo.ts        sandbox sessions and the replay model
src/web.ts         static server and demo API
public/            the explainer page
demo/              synthetic scenario and recorded Gemma output
docs/              threat model and screenshot
test/              node:test suites
```

## Tests

```bash
npm test         # consent, deletion, scheduler, bot flow, validation, demo API
npm run typecheck
```

The tests use a fake model; none of them need Ollama or Telegram. One of them writes a database file, deletes a user, and checks that the deleted text is no longer in any of the files on disk.

## Privacy and threat model

Read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) before running this for someone else. It states what is protected, what is not (Telegram can still see group traffic; a small local model can misread), and one prompt-injection result found while testing.

## What changed from the hackathon prototype

| Prototype | Now |
| --- | --- |
| OpenRouter cloud model | Gemma 4 via Ollama, local |
| Logged into a personal Telegram account (MTProto) to read chats | A normal bot that only sees groups it was added to, visible to every member |
| One global database, one hard-coded recipient | Per-user records, per-user consent, no recipient fallback |
| Consent was a README promise | `/optin`, `/watch`, `/notme`, `/optout`, `/deletemydata`, consent log |
| Trigger.dev cloud scheduler | Built-in interval scheduler, per-user timezone |
| No tests | 37 tests |
| No web presence | Explainer page with a sandboxed demo |

## Contributing

Issues and pull requests are welcome. Keep the consent rules in `src/engine.ts` covered by tests, and never commit tokens, `.env`, databases, or real chat text.

## License

MIT, see [LICENSE](LICENSE).
