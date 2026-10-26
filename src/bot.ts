import { Engine, isValidTime, isValidTimezone } from "./engine.js";
import type { TgMessage, TgUpdate } from "./telegram.js";

export type Reply = (chatId: string, text: string) => Promise<void>;

export const CONSENT_TEXT = [
  "Remember Me helps you recall plans from messages you choose to share with it.",
  "",
  "If you opt in, this is what happens:",
  "• I save the text of messages from a private chat with me and from group chats you tell me to /watch.",
  "• A language model running on the machine hosting this bot (Gemma via Ollama) turns each message into a short memory.",
  "• Nothing is sent to a cloud AI service. Photos, voice notes and files are ignored.",
  "• Group members can send /notme in that group to be left out and have their past messages erased.",
  "• You can /pause, /optout, or /deletemydata at any time. Your caregiver can only pause and resume, never switch capture on for you.",
  "",
  "Send /optin to agree. Until you do, I store nothing.",
].join("\n");

const HELP = [
  "/ask <question> - ask about saved memories",
  "/optin, /optout - start or stop saving (stopping keeps data)",
  "/deletemydata - erase everything I hold about you",
  "/mydata - what I hold, and recent consent events",
  "/watch (in a group) - save that group's messages for you",
  "/unwatch (in a group) - stop saving that group",
  "/notme, /includeme (in a group) - leave yourself out of capture, or back in",
  "/pause, /resume - pause or resume saving",
  "/invite - create a one-day code for your caregiver",
  "/removecaregiver - unlink your caregiver",
  "/briefing HH:MM | off - daily briefing time",
  "/timezone Europe/Dublin - your timezone",
].join("\n");

const CAREGIVER_HELP = [
  "Caregiver commands:",
  "/status - see whether capture is active",
  "/pause - pause saving",
  "/resume - resume saving (only works while the person has consent)",
].join("\n");

function parseCommand(text: string): { cmd: string; args: string } | undefined {
  const m = /^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { cmd: m[1].toLowerCase(), args: (m[2] ?? "").trim() } : undefined;
}

export async function handleUpdate(update: TgUpdate, engine: Engine, reply: Reply): Promise<void> {
  const msg = update.message;
  if (!msg?.text || !msg.from || msg.from.is_bot) return;
  if (msg.chat.type === "channel") return;
  if (msg.chat.type === "private") return handlePrivate(msg, engine, reply);
  return handleGroup(msg, engine, reply);
}

async function handlePrivate(msg: TgMessage, engine: Engine, reply: Reply) {
  const uid = String(msg.from!.id);
  const chat = String(msg.chat.id);
  const say = (t: string) => reply(chat, t);
  const parsed = parseCommand(msg.text!);

  if (!parsed) {
    const outcome = await engine.ingest({
      userId: uid,
      chatId: chat,
      messageId: msg.message_id,
      senderId: uid,
      senderName: msg.from!.first_name ?? "You",
      text: msg.text!,
      sentAt: new Date(msg.date * 1000),
      isDirect: true,
    });
    if (outcome === "saved" || outcome === "saved_pending") return say("Saved.");
    if (outcome === "no_consent") return say("I have not saved that. I only store messages after you send /optin.");
    if (outcome === "paused") return say("Saving is paused, so I did not keep that.");
    return;
  }

  const { cmd, args } = parsed;
  const isCaregiverOf = engine.store.getUserByCaregiver(uid);

  switch (cmd) {
    case "start":
    case "help":
      return say(`${CONSENT_TEXT}\n\nCommands:\n${HELP}${isCaregiverOf ? `\n\n${CAREGIVER_HELP}` : ""}`);

    case "optin":
      engine.optIn(uid);
      return say("Thank you. Saving is on. Send me a message to remember, or add me to a family group and send /watch there. Ask with /ask. /optout stops it any time.");

    case "optout":
      engine.optOut(uid);
      return say("Saving is off and briefings are stopped. I kept what was already saved. Send /deletemydata to erase it.");

    case "deletemydata":
      if (args.toLowerCase() !== "confirm") {
        return say("This permanently erases every message, memory and setting I hold about you, and unlinks your caregiver. To go ahead, send:\n/deletemydata confirm");
      }
      engine.deleteAll(uid);
      return say("Done. Everything I held about you has been erased.");

    case "mydata": {
      const s = engine.status(uid);
      const log = engine.store.listAudit(uid, 5).map((a) => `• ${a.at.slice(0, 16).replace("T", " ")} ${a.actor}: ${a.event}`);
      return say([
        `Consent: ${s.consent ? "yes" : "no"}   Paused: ${s.paused ? "yes" : "no"}   Caregiver linked: ${s.caregiver ? "yes" : "no"}`,
        `Saved messages: ${s.messages}   Memories: ${s.memories}   Waiting for the model: ${s.pending}`,
        `Watched groups: ${s.watchedChats.length}`,
        s.briefingTime ? `Briefing: ${s.briefingTime} ${s.timezone}` : "Briefing: off",
        log.length ? `\nRecent consent events:\n${log.join("\n")}` : "",
      ].join("\n"));
    }

    case "ask": {
      if (!args) return say("Ask after the command, for example:\n/ask What am I doing tomorrow?");
      try {
        const r = await engine.ask(uid, args);
        if (r === "no_consent") return say("Send /optin first. I do not hold any memories for you yet.");
        if (r === "no_memories") return say("I do not have any saved memories yet.");
        const src = r.sources.map((m) => `• ${m.senderName}: "${m.sourceText}" (${new Date(m.sentAt).toLocaleString()})`);
        return say([
          r.answer.answer,
          r.answer.uncertain ? "\nPlease check the original message or ask someone you trust if this matters." : "",
          src.length ? `\nFrom:\n${src.join("\n")}` : "",
        ].filter(Boolean).join("\n"));
      } catch (err) {
        console.error("ask failed:", (err as Error).message);
        return say("I could not look that up just now. Is the model running? Please try again shortly.");
      }
    }

    case "pause":
    case "resume":
    case "status": {
      // A caregiver acts on the linked person; anyone else acts on themself.
      const target = isCaregiverOf?.id ?? uid;
      const actor = isCaregiverOf ? "caregiver" : "user";
      if (cmd === "status") {
        const s = engine.status(target);
        return say(`Capture is ${!s.consent ? "off (no consent)" : s.paused ? "paused" : "active"}. Watched groups: ${s.watchedChats.length}.`);
      }
      if (!engine.setPaused(target, cmd === "pause", actor)) return say("There is no active consent, so there is nothing to change.");
      if (isCaregiverOf) {
        await reply(target, `Your caregiver ${cmd === "pause" ? "paused" : "resumed"} saving. You can /optout or /deletemydata any time.`);
      }
      return say(cmd === "pause" ? "Paused. New messages will not be saved." : "Resumed.");
    }

    case "invite": {
      const code = engine.createInvite(uid);
      if (!code) return say("Send /optin first.");
      return say(`Give this code to your caregiver. It works once and expires in 24 hours:\n\n${code}\n\nThey send it to me as /caregiver ${code}. They will be able to see whether saving is active, and pause or resume it. They cannot read your memories.`);
    }

    case "caregiver": {
      const r = engine.linkCaregiver(args, uid);
      if (!r.ok) {
        const why = { invalid: "That code is not valid or has expired.", caregiver_busy: "You are already a caregiver for someone.", self: "You cannot be your own caregiver.", no_consent: "That person has not given consent." }[r.reason];
        return say(why);
      }
      await reply(r.userId, "A caregiver is now linked. They can see whether saving is active and pause or resume it. Send /removecaregiver to unlink them.");
      return say(`You are now linked. ${CAREGIVER_HELP}`);
    }

    case "removecaregiver":
      return say(engine.unlinkCaregiver(uid) ? "Caregiver unlinked." : "No caregiver is linked.");

    case "briefing": {
      if (args.toLowerCase() === "off") {
        engine.setBriefing(uid, null);
        return say("Daily briefing is off.");
      }
      if (!isValidTime(args)) return say("Use a 24-hour time such as /briefing 09:00, or /briefing off.");
      if (!engine.setBriefing(uid, args)) return say("Send /optin first.");
      return say(`Briefing set for ${args} (${engine.status(uid).timezone}). Set your zone with /timezone Europe/Dublin if that is wrong.`);
    }

    case "timezone": {
      if (!isValidTimezone(args)) return say("I did not recognise that. Use an IANA name such as /timezone Europe/Dublin.");
      const u = engine.user(uid);
      if (!u?.consentAt) return say("Send /optin first.");
      engine.store.updateUser(uid, { timezone: args });
      return say(`Timezone set to ${args}.`);
    }

    case "watch":
    case "unwatch":
      return say("Send /watch inside the group chat you want me to save. I need to be a member of that group.");

    default:
      return say(`I did not understand that.\n\n${HELP}`);
  }
}

async function handleGroup(msg: TgMessage, engine: Engine, reply: Reply) {
  const uid = String(msg.from!.id);
  const chat = String(msg.chat.id);
  const parsed = parseCommand(msg.text!);

  if (parsed) {
    switch (parsed.cmd) {
      case "watch":
        if (!engine.watch(uid, chat)) {
          return reply(chat, "Only someone who has opted in can do this. Message me privately and send /optin first.");
        }
        return reply(chat, `${msg.from!.first_name ?? "Someone"} has asked me to save this group's text messages as memories for them, using a model on their own machine. If you would rather not be included, send /notme and I will skip your messages and erase any I saved.`);
      case "unwatch":
        engine.unwatch(uid, chat);
        return reply(chat, "I have stopped saving this group for you.");
      case "notme": {
        const erased = engine.excludeSender(chat, uid);
        return reply(chat, `Okay. I will not save your messages here${erased ? ` and I erased ${erased} I had saved` : ""}. /includeme reverses this.`);
      }
      case "includeme":
        engine.includeSender(chat, uid);
        return reply(chat, "Okay. Your messages here can be saved again.");
      default:
        return; // other commands belong in a private chat
    }
  }

  const sentAt = new Date(msg.date * 1000);
  for (const watcher of engine.store.watchersOfChat(chat)) {
    await engine.ingest({
      userId: watcher,
      chatId: chat,
      messageId: msg.message_id,
      senderId: uid,
      senderName: msg.from!.first_name ?? "Someone",
      text: msg.text!,
      sentAt,
    });
  }
}

/** Long-polls Telegram until the signal aborts. */
export async function runPolling(
  api: { getUpdates(offset: number): Promise<TgUpdate[]> },
  handle: (u: TgUpdate) => Promise<void>,
  signal: AbortSignal,
) {
  let offset = 0;
  while (!signal.aborted) {
    try {
      for (const u of await api.getUpdates(offset)) {
        offset = u.update_id + 1;
        try {
          await handle(u);
        } catch (err) {
          console.error("update failed:", (err as Error).message);
        }
      }
    } catch (err) {
      console.error("polling error:", (err as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
