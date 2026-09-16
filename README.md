# Remember Me

Consent-first Telegram memory companion hackathon prototype.

## Credits

Created and maintained by **Muhammad Murtuza Hussain**.

## Run locally

Open three terminals in this directory:

```bash
npm run listen
npm run bot
npm run trigger:dev
```

Use `npm run briefing:test` to send one manual briefing and `npm run sources` to inspect captured Telegram messages.

The configured caregiver can use `/status`, `/pause`, and `/resume` in the bot's private chat. Set `CAREGIVER_TELEGRAM_CHAT_ID` to restrict those controls; during the hackathon, the app falls back to `DEMO_RECIPIENT_CHAT_ID`.

## Project layout

- `src/listen.ts` receives new messages from only the chat IDs in `MONITORED_CHAT_IDS` and ignores replies sent by the configured bot.
- `src/extract-memory.ts` converts one saved message into a structured memory with OpenRouter.
- `src/bot.ts` answers `/ask` questions from saved memories.
- `src/send-briefing.ts` sends a briefing to the configured demo recipient.
- `trigger/daily-briefing.ts` schedules the 9:00 AM Europe/Dublin briefing.

## Local-only data

SQLite data is stored in `data/remember-me.db`. This is suitable for the hackathon demo only. A deployed version needs a managed database, encrypted sessions, per-user records, and explicit consent controls.
