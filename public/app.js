const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const OUTCOME = {
  saved: ["Saved as a memory", true],
  saved_pending: ["Saved, waiting for the model", true],
  no_consent: ["Ignored: this person has not opted in", false],
  paused: ["Ignored: saving is paused", false],
  chat_not_watched: ["Ignored: this chat is not being watched", false],
  sender_excluded: ["Ignored: this sender used /notme", false],
  duplicate: ["Ignored: already saved", false],
  empty: ["Ignored: nothing to save", false],
};

let sid = null;
let info = null;

let local = null; // set when there is no server API (static hosting)

async function api(path, body) {
  if (local) return local(path, body);
  const res = await fetch(path.replace(/^\//, ""), body ? { method: "POST", body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: res.status });
  return data;
}

function showError(e) {
  const box = $("demo-error");
  box.hidden = !e;
  box.textContent = e ? e.message : "";
}

async function startSession() {
  sid = (await api("/api/session", {})).sid;
}

async function guarded(fn) {
  try {
    showError(null);
    await fn();
  } catch (e) {
    if (e.status === 404) {
      await startSession();
      showError(new Error("Your sandbox expired, so it was reset. Try again."));
      await refresh();
    } else showError(e);
  }
}

const act = (action, arg) => guarded(async () => { await api("/api/action", { sid, action, arg }); await refresh(); });

function toggleRow(label, on, onLabel, offLabel, onClick) {
  const row = el("div", "toggle");
  row.append(el("span", "", `${label}: ${on ? onLabel : offLabel}`));
  const b = el("button", "btn", on ? "Stop" : "Start");
  b.type = "button";
  b.addEventListener("click", onClick);
  row.append(b);
  return row;
}

function render(s) {
  const cs = $("consent-state");
  cs.className = "state" + (s.consent && !s.paused ? " on" : "");
  cs.textContent = !s.consent ? "No consent. Nothing is saved." : s.paused ? "Opted in, but paused." : "Opted in. Saving is active.";
  $("b-optin").disabled = s.consent;
  $("b-optout").disabled = !s.consent;
  $("b-pause").disabled = !s.consent || s.paused;
  $("b-resume").disabled = !s.consent || !s.paused;

  const chats = $("chats");
  chats.replaceChildren(...info.chats.map((c) => {
    const on = s.watched.includes(c.id);
    return toggleRow(c.name, on, "watched", "not watched", () => act(on ? "unwatch" : "watch", c.id));
  }));

  const members = $("members");
  const people = info.messages.filter((m) => m.chat === "family").map((m) => [m.senderId, m.sender]).filter((p, i, a) => a.findIndex((x) => x[0] === p[0]) === i);
  members.replaceChildren(...people.map(([id, name]) => {
    const out = s.excluded.includes(id);
    const row = toggleRow(name, !out, "included", "sent /notme", () => act(out ? "includeme" : "notme", id));
    row.lastChild.textContent = out ? "/includeme" : "/notme";
    return row;
  }));

  $("audit").replaceChildren(...(s.audit.length ? s.audit.map((a) => el("li", "", `${a.actor}: ${a.event}`)) : [el("li", "", "Nothing yet.")]));

  $("log").replaceChildren(...s.log.slice().reverse().map((l) => {
    const [text, ok] = OUTCOME[l.outcome] || [l.outcome, false];
    const li = el("li");
    li.append(el("span", `tag ${ok ? "ok" : "no"}`, text), el("span", "", l.text));
    return li;
  }));
  if (!s.log.length) $("log").append(el("li", "empty", "No messages delivered yet."));

  $("memories").replaceChildren(...(s.memories.length ? s.memories.map((m) => {
    const d = el("div", `mem ${m.importance}`);
    d.append(el("p", "", m.summary));
    const meta = [m.eventTimeText, m.importance + " importance", m.needsConfirmation ? "needs confirming" : null].filter(Boolean).join(" · ");
    d.append(el("small", "", `${meta} — from ${m.sender}`));
    return d;
  }) : [el("div", "empty", "Empty. Opt in, watch a chat, then deliver a message.")]));
}

async function refresh() {
  render(await api(`/api/state?sid=${encodeURIComponent(sid)}`));
}

function buildStatic() {
  $("msgs").replaceChildren(...info.messages.map((m) => {
    const b = el("button", "msg");
    b.type = "button";
    const chat = info.chats.find((c) => c.id === m.chat)?.name ?? m.chat;
    b.append(el("small", "", `${chat} · ${m.sender}`), document.createTextNode(m.text));
    b.addEventListener("click", () => guarded(async () => { await api("/api/send", { sid, key: m.key }); await refresh(); }));
    return b;
  }));
  $("questions").replaceChildren(...info.questions.map((q) => {
    const b = el("button", "chip", q.text);
    b.type = "button";
    b.addEventListener("click", () => ask(q.text));
    return b;
  }));
  const live = info.mode === "live";
  $("custom").hidden = !live;
  $("ask").hidden = !live;
  $("mode-note").textContent = live
    ? `A local ${info.model} model is running here, so you can also write your own messages and questions.`
    : `This is a replay: the answers below were recorded from a real ${info.model} run on these exact messages, so no model is needed and no free text is ever sent anywhere. Run it locally for the live model.`;
}

async function ask(question) {
  await guarded(async () => {
    const out = $("answer");
    out.replaceChildren(el("div", "empty", "Thinking…"));
    const r = await api("/api/ask", { sid, question });
    if (r.status === "no_consent") return out.replaceChildren(el("div", "a", "Opt in first. I do not hold any memories for this person."));
    if (r.status === "no_memories") return out.replaceChildren(el("div", "a", "I do not have any saved memories yet."));
    const wrap = el("div");
    wrap.append(el("div", "a", r.answer));
    if (r.uncertain) wrap.append(el("div", "warn", "Please check the original message or ask someone you trust if this matters."));
    for (const s of r.sources) wrap.append(el("div", "src", `${s.sender}: “${s.text}”`));
    out.replaceChildren(wrap);
  });
}

async function boot() {
  try {
    try {
      info = await api("/api/info");
    } catch {
      // No API here (for example GitHub Pages): run the same sandbox inside the browser.
      local = await (await import("./local-backend.js")).createLocalBackend();
      info = await api("/api/info");
    }
    await startSession();
    buildStatic();
    $("demo-app").hidden = false;
    await refresh();
  } catch (e) {
    showError(new Error("The sandbox is unavailable right now. " + e.message));
    return;
  }
  $("b-optin").addEventListener("click", () => act("optin"));
  $("b-optout").addEventListener("click", () => act("optout"));
  $("b-pause").addEventListener("click", () => act("pause"));
  $("b-resume").addEventListener("click", () => act("resume"));
  $("b-delete").addEventListener("click", () => act("delete"));
  $("b-brief").addEventListener("click", () => guarded(async () => {
    const r = await api(`/api/briefing?sid=${encodeURIComponent(sid)}`);
    $("brief").textContent = r.text ?? "Nothing to report yet. Briefings only use saved memories, and are built without the model.";
  }));
  $("custom").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = $("custom-text").value.trim();
    if (text) guarded(async () => { await api("/api/send", { sid, text }); $("custom-text").value = ""; await refresh(); });
  });
  $("ask").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = $("ask-text").value.trim();
    if (q) ask(q);
  });
}
boot();
