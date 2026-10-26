// Static-hosting fallback: the same sandbox rules as src/demo.ts, run entirely in the
// visitor's browser from recorded Gemma output. Nothing is sent anywhere.
const ORDER = { high: 0, medium: 1, low: 2 };

export async function createLocalBackend() {
  const [scenario, fixtures] = await Promise.all([
    fetch("demo/scenario.json").then((r) => r.json()),
    fetch("demo/fixtures.json").then((r) => r.json()),
  ]);
  const fresh = () => ({ consent: false, paused: false, watched: new Set(), excluded: new Set(), memories: [], log: [], audit: [], next: 1 });
  let s = fresh();
  const audit = (actor, event) => { s.audit.unshift({ at: new Date().toISOString(), actor, event }); s.audit = s.audit.slice(0, 8); };
  const byKey = (k) => scenario.messages.find((m) => m.key === k);

  const state = () => ({
    consent: s.consent,
    paused: s.paused,
    watched: [...s.watched],
    excluded: [...s.excluded],
    counts: { messages: s.memories.length, memories: s.memories.length },
    memories: s.memories.slice().reverse().map(({ key, senderId, ...m }) => m),
    audit: s.audit,
    log: s.log.slice(-12),
  });

  function send(key) {
    const m = byKey(key);
    if (!m) throw Object.assign(new Error("unknown message"), { status: 404 });
    let outcome = "saved";
    if (!s.consent) outcome = "no_consent";
    else if (s.paused) outcome = "paused";
    else if (!s.watched.has(m.chat)) outcome = "chat_not_watched";
    else if (m.chat === "family" && s.excluded.has(m.senderId)) outcome = "sender_excluded";
    else if (s.memories.some((x) => x.key === key)) outcome = "duplicate";
    if (outcome === "saved") {
      const ex = fixtures.extractions[key];
      s.memories.push({ id: s.next++, key, senderId: m.senderId, summary: ex.summary, importance: ex.importance, eventTitle: ex.eventTitle, eventTimeText: ex.eventTimeText, needsConfirmation: ex.needsConfirmation, sender: m.sender, source: m.text, sentAt: m.sentAt });
    }
    s.log.push({ at: new Date().toISOString(), text: `${m.sender}: ${m.text}`, outcome });
    return { outcome, text: m.text };
  }

  function ask(question) {
    if (!s.consent) return { status: "no_consent" };
    if (!s.memories.length) return { status: "no_memories" };
    const q = scenario.questions.find((x) => x.text === question);
    const rec = q && fixtures.answers[q.key];
    const have = new Map(s.memories.map((m) => [m.key, m]));
    if (!q || !rec || !q.requires.every((k) => have.has(k))) {
      return { status: "ok", answer: "I do not have a saved memory that answers that yet.", uncertain: true, sources: [] };
    }
    return { status: "ok", answer: rec.answer, uncertain: rec.uncertain, sources: rec.sourceKeys.map((k) => ({ sender: have.get(k).sender, text: have.get(k).source, sentAt: have.get(k).sentAt })) };
  }

  function briefing() {
    if (!s.consent) return null;
    const items = s.memories.filter((m) => m.importance !== "low" && m.eventTimeText)
      .sort((a, b) => ORDER[a.importance] - ORDER[b.importance] || b.id - a.id).slice(0, 5);
    if (!items.length) return null;
    const lines = items.map((m) => `• ${m.summary} (${m.eventTimeText})${m.needsConfirmation ? " - worth double-checking" : ""}`);
    return ["Good morning.", "", "Here is your memory briefing:", ...lines, "", "Ask me anything with /ask."].join("\n");
  }

  function action(a, arg) {
    switch (a) {
      case "optin": s.consent = true; audit("user", "opted in"); break;
      case "optout": if (s.consent) { s.consent = false; s.paused = false; audit("user", "opted out"); } break;
      case "pause": if (s.consent) { s.paused = true; audit("caregiver", "paused capture"); } break;
      case "resume": if (s.consent) { s.paused = false; audit("caregiver", "resumed capture"); } break;
      case "delete": s = fresh(); break;
      case "watch": if (s.consent && scenario.chats.some((c) => c.id === arg)) { s.watched.add(arg); audit("user", "started watching a chat"); } break;
      case "unwatch": s.watched.delete(arg); break;
      case "notme": s.excluded.add(arg); s.memories = s.memories.filter((m) => m.senderId !== arg); break;
      case "includeme": s.excluded.delete(arg); break;
      default: throw Object.assign(new Error("bad action"), { status: 400 });
    }
    return { ok: true };
  }

  return async (path, body) => {
    const p = path.split("?")[0].replace(/^\/?/, "");
    switch (p) {
      case "api/info":
        return { mode: "replay", model: fixtures.model, chats: scenario.chats, messages: scenario.messages.map(({ key, chat, sender, senderId, text }) => ({ key, chat, sender, senderId, text })), questions: scenario.questions.map(({ key, text }) => ({ key, text })), maxCustomChars: 280 };
      case "api/session": s = fresh(); return { sid: "local" };
      case "api/state": return state();
      case "api/briefing": return { text: briefing() };
      case "api/action": return action(body.action, body.arg);
      case "api/send": return send(body.key);
      case "api/ask": return ask(String(body.question ?? ""));
      default: throw Object.assign(new Error("not found"), { status: 404 });
    }
  };
}
