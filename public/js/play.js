import { h, clear, badge, fmtScore, makeClock, fitHeadline, placeLabel, ordinalWord } from "./common.js";
import { sfx } from "./sfx.js";

const REACTIONS = ["😂", "🔥", "💀", "😱", "👏", "🤮"];
const socket = io({ reconnectionDelay: 400, reconnectionDelayMax: 3000, timeout: 10000 });
const clock = makeClock();
const app = document.getElementById("app");
const topRight = document.getElementById("top-right");
const timerEl = document.getElementById("timer");
const toastEl = document.getElementById("toast");

let session = loadSession();   // { code, playerId, token, name }
let state = null;
let viewKey = null;
let connected = false;
let joining = false;
const drafts = {};             // write drafts keyed by item key
let rankPick = { first: null, second: null };

// ── session persistence ─────────────────────────────────────────────────────
function loadSession() {
  try { const raw = localStorage.getItem("dd_session"); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function saveSession(s) { session = s; try { if (s) localStorage.setItem("dd_session", JSON.stringify(s)); else localStorage.removeItem("dd_session"); } catch (e) { /* ignore */ } }
function lastName() { try { return localStorage.getItem("dd_name") || ""; } catch (e) { return ""; } }
function rememberName(n) { try { localStorage.setItem("dd_name", n); } catch (e) { /* ignore */ } }

const urlCode = (new URLSearchParams(location.search).get("code") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);

// ── connection ──────────────────────────────────────────────────────────────
socket.on("connect", () => {
  connected = true;
  renderTop();
  hideToast();
  if (session && session.code) {
    socket.emit("player:rejoin", { code: session.code, playerId: session.playerId, token: session.token }, (res) => {
      if (res && res.ok) { onState(res.state); return; }
      // Seat is gone: start over, but keep the code handy.
      const code = session.code;
      saveSession(null);
      state = null; viewKey = null;
      renderJoin(code, res && res.error ? res.error : "");
    });
  } else if (!state) {
    renderJoin(urlCode, "");
  }
});
socket.on("disconnect", () => { connected = false; renderTop(); toast("Reconnecting…", 0); });
socket.on("player:state", onState);
socket.on("player:removed", () => { saveSession(null); state = null; viewKey = null; renderJoin("", "You were removed from the lobby."); });
socket.on("player:closed", () => { saveSession(null); state = null; viewKey = null; renderJoin("", "That game has ended."); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !socket.connected) socket.connect(); });
document.addEventListener("pointerdown", () => sfx.unlock(), { once: true });

function onState(s) {
  if (!s) return;
  const prev = state;
  state = s;
  clock.sync(s.serverNow);
  if (prev && prev.phase !== s.phase && /_(write|vote)$/.test(s.phase)) sfx.play("pop");
  render();
}

// ── timer ───────────────────────────────────────────────────────────────────
let timerTotal = 0, timerKey = null;
setInterval(() => {
  const interactive = state && state.endsAt && /_(write|vote)$/.test(state.phase) && state.task && state.task.type !== "wait";
  timerEl.hidden = !interactive;
  if (!interactive) return;
  if (timerKey !== viewKey) { timerKey = viewKey; timerTotal = Math.max(1, state.endsAt - clock.now()); }
  const remaining = clock.remaining(state.endsAt);
  timerEl.querySelector(".fill").style.width = `${Math.max(0, Math.min(100, (remaining / timerTotal) * 100))}%`;
  timerEl.classList.toggle("urgent", remaining <= 5000 && remaining > 0);
}, 100);

// ── top bar ─────────────────────────────────────────────────────────────────
function renderTop() {
  clear(topRight);
  if (state && state.you) topRight.appendChild(badge(state.you));
  if (state && state.code) topRight.appendChild(h("span", { class: "code" }, state.code));
  topRight.appendChild(h("span", { class: `dot ${connected ? "" : "off"}`, title: connected ? "connected" : "reconnecting" }));
}

// ── join screen ─────────────────────────────────────────────────────────────
function renderJoin(prefillCode, message) {
  viewKey = "join";
  clear(app);
  renderTop();
  const codeInput = h("input", { type: "text", class: "code", id: "code", maxlength: 4, autocomplete: "off", autocapitalize: "characters", spellcheck: "false", placeholder: "CODE", inputmode: "text", value: prefillCode || "", enterkeyhint: "next" });
  const nameInput = h("input", { type: "text", id: "name", maxlength: 12, autocomplete: "nickname", placeholder: "Your name", value: lastName(), enterkeyhint: "go" });
  codeInput.addEventListener("input", () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4); if (codeInput.value.length === 4) nameInput.focus(); });
  const btn = h("button", { class: "btn big", type: "submit" }, "Join the newsroom");
  const form = h("form", { class: "screen", onsubmit: (e) => {
    e.preventDefault();
    if (joining) return;
    const code = codeInput.value.trim().toUpperCase();
    const name = nameInput.value.trim();
    if (code.length !== 4) { shake(codeInput); toast("Room codes are 4 letters."); return; }
    if (!name) { shake(nameInput); toast("Pick a name first."); return; }
    joining = true; btn.disabled = true; btn.textContent = "Joining…";
    sfx.unlock();
    socket.emit("player:join", { code, name }, (res) => {
      joining = false; btn.disabled = false; btn.textContent = "Join the newsroom";
      if (!res || !res.ok) { shake(codeInput); toast((res && res.error) || "Couldn't join."); return; }
      rememberName(name);
      saveSession({ code: res.code, playerId: res.playerId, token: res.token, name });
      sfx.play("join");
      onState(res.state);
    });
  } },
    h("div", { class: "me", style: { marginTop: "0.5rem" } }, h("h1", { class: "head" }, "Extra! Extra!"), h("p", { class: "note" }, "Enter the room code from the TV.")),
    message ? h("p", { class: "note", style: { color: "var(--red)" } }, message) : null,
    h("div", { class: "field" }, h("label", { for: "code" }, "Room code"), codeInput),
    h("div", { class: "field" }, h("label", { for: "name" }, "Your name"), nameInput),
    btn,
    h("div", { class: "rules" }, h("b", null, "How it works · "), "Three rounds of tabloid headlines about the people in this room. Write funny, vote honestly, lie convincingly. 3 to 10 players."),
    h("div", { class: "host-link" }, "Setting up the TV? ", h("a", { href: "/host" }, "Open the host screen")),
  );
  app.appendChild(form);
  (prefillCode && prefillCode.length === 4 ? nameInput : codeInput).focus();
}

// ── state rendering ─────────────────────────────────────────────────────────
function keyFor(s) {
  const t = s.task || {};
  const parts = [s.phase, t.type, t.voteId || "", t.spotlight ? "spot" : ""];
  if (t.type === "write") { const cur = t.items.find((i) => !i.done); parts.push(cur ? cur.key : "done"); }
  if (t.type === "vote" || t.type === "rank") parts.push(t.picked ? "picked" : "open");
  if (t.type === "lobby") parts.push(t.canStart ? "go" : "wait");
  if (t.type === "final") parts.push(s.you.isVip ? "vip" : "");
  return parts.join("|");
}

function render() {
  if (!state) return;
  renderTop();
  const key = keyFor(state);
  if (key === viewKey) { patch(state); return; }
  viewKey = key;
  if (!/rank/.test(key)) rankPick = { first: null, second: null };
  clear(app);
  const t = state.task;
  let screen;
  switch (t.type) {
    case "lobby": screen = screenLobby(state); break;
    case "audience_lobby": screen = screenAudienceLobby(state); break;
    case "write": screen = screenWrite(state); break;
    case "vote": screen = screenVote(state); break;
    case "rank": screen = screenRank(state); break;
    case "final": screen = screenFinal(state); break;
    case "wait": default: screen = screenWait(state); break;
  }
  app.appendChild(screen);
}

function patch(s) {
  // Lightweight updates that shouldn't rebuild the DOM (and wipe a draft).
  const roster = app.querySelector(".roster[data-live]");
  if (roster) roster.replaceWith(rosterEl(s));
  const sb = app.querySelector(".scorebox[data-live]");
  if (sb) sb.replaceWith(scoreBox(s));
}

function rosterEl(s) {
  return h("div", { class: "roster", dataset: { live: "1" } }, s.players.map((p) => badge(p, { vip: true })));
}

function scoreBox(s) {
  if (s.you.role !== "player") return h("div", { class: "scorebox", dataset: { live: "1" } }, h("span", null, h("b", null, "🎟️"), "audience"));
  return h("div", { class: "scorebox", dataset: { live: "1" } },
    h("span", null, h("b", null, fmtScore(s.you.score)), "points"),
    s.you.place ? h("span", null, h("b", null, placeLabel(s.you.place)), "place") : null,
  );
}

function meBlock(s) {
  const y = s.you;
  return h("div", { class: "me" },
    h("div", { class: "ava-big", style: { "--bc": y.color } }, y.emoji),
    h("div", { class: "nm" }, y.name),
    y.isVip ? h("div", { class: "vip" }, "VIP · you start the game") : null,
  );
}

function reactionBar() {
  return h("div", null,
    h("div", { class: "reactions-label" }, "React on the TV"),
    h("div", { class: "reactions" }, REACTIONS.map((e) => h("button", { type: "button", onclick: (ev) => { ev.preventDefault(); sfx.unlock(); socket.emit("player:react", { emoji: e }, () => {}); } }, e))),
  );
}

// ── screens ─────────────────────────────────────────────────────────────────
function screenLobby(s) {
  const t = s.task;
  const startBtn = t.isVip ? h("button", { class: "btn big yellow", disabled: !t.canStart, onclick: () => {
    sfx.unlock();
    socket.emit("player:start", {}, (r) => { if (r && !r.ok) toast(r.error); });
  } }, t.canStart ? "Everybody's in — start!" : `Need ${t.minPlayers} players to start`) : null;
  return h("div", { class: "screen" },
    meBlock(s),
    h("p", { class: "note" }, "You're in! Keep an eye on the TV."),
    rosterEl(s),
    startBtn,
    !t.isVip ? h("p", { class: "note" }, "Waiting for the VIP to start the game…") : null,
    h("div", { class: "rules" }, h("b", null, "Tonight's plan · "), "Round 1: fill in tabloid headlines. Round 2: confess a true thing while friends plant lies. Round 3: connect two scandals into one headline."),
    h("button", { class: "linkish", type: "button", onclick: leave }, "Leave this room"),
  );
}

function screenAudienceLobby(s) {
  return h("div", { class: "screen center" },
    h("div", { class: "big-msg" }, "You're in the audience"),
    h("p", { class: "note" }, s.task.message),
    rosterEl(s),
    h("button", { class: "linkish", type: "button", onclick: leave }, "Leave this room"),
  );
}

function screenWrite(s) {
  const t = s.task;
  const idx = t.items.findIndex((i) => !i.done);
  const item = t.items[idx];
  const ta = h("textarea", { maxlength: item.maxLen, placeholder: t.kind === "connect" ? "BREAKING: …" : "Type your answer…", autocomplete: "off", autocapitalize: "sentences", enterkeyhint: "send" });
  ta.value = drafts[item.key] || "";
  const counter = h("div", { class: "counter" }, `${ta.value.length} / ${item.maxLen}`);
  ta.addEventListener("input", () => { drafts[item.key] = ta.value; counter.textContent = `${ta.value.length} / ${item.maxLen}`; counter.classList.toggle("full", ta.value.length >= item.maxLen); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
  const btn = h("button", { class: "btn big", type: "button", onclick: submit }, t.kind === "confession" && item.truth ? "Confess" : "File it");
  let sending = false;
  function submit() {
    if (sending) return;
    const text = ta.value.trim();
    if (!text) { shake(ta); toast("Write something first."); return; }
    sending = true; btn.disabled = true;
    socket.emit("player:write", { key: item.key, text }, (r) => {
      sending = false;
      if (!r || !r.ok) { btn.disabled = false; toast((r && r.error) || "Couldn't send that."); return; }
      delete drafts[item.key];
      sfx.play("pop");
      // The next state message re-renders the next item; if it's slow, keep the button disabled so we never double-send.
    });
  }
  const header = [];
  if (t.kind === "headline") {
    header.push(h("div", { class: "progress" }, h("span", null, `Headline ${idx + 1} of ${t.items.length}`), h("span", null, "Round 1 · Hot Takes")));
    header.push(h("div", { class: "prompt-card card" }, fitHeadline(item.prompt)));
    header.push(h("div", { class: "plant" },
      h("div", null, h("div", { class: "info" }, h("b", null, "Secret plant word")), h("div", { class: "word" }, item.plantWord)),
      h("div", { class: "info" }, "Sneak it into your answer for ", h("b", null, "+250"), " if it gets a vote, ", h("b", null, "+500"), " if it wins. Nobody else knows your word."),
    ));
  } else if (t.kind === "confession") {
    header.push(h("div", { class: "progress" }, h("span", null, `${idx + 1} of ${t.items.length}`), h("span", null, "Round 2 · Anonymous Source")));
    header.push(h("div", { class: `label-pill ${item.truth ? "truth" : "lie"}` }, item.truth ? "Confess — must be true" : "Lie — make it believable"));
    header.push(h("div", { class: "prompt-card card confess" }, item.prompt));
    header.push(h("p", { class: "note", style: { textAlign: "left" } }, item.truth
      ? "Everyone will try to spot your true answer among two fakes. Score +250 for every friend who doesn't believe you."
      : `This fake will sit next to the real answer. Score +500 for every voter who falls for it.`));
  } else {
    header.push(h("div", { class: "progress" }, h("span", null, "Final round"), h("span", null, "Connect the Dots")));
    header.push(h("div", { class: "label-pill" }, "Two scandals from tonight"));
    header.push(h("div", { class: "quotes" }, item.quotes.map((q) => h("div", { class: "quote" }, q))));
    header.push(h("div", { class: "prompt-card card confess" }, "Write the headline that connects them"));
  }
  const screen = h("div", { class: "screen" }, ...header, ta, counter, btn);
  setTimeout(() => ta.focus({ preventScroll: true }), 50);
  return screen;
}

function screenVote(s) {
  const t = s.task;
  const picked = t.picked;
  const tags = t.kind === "headline" ? { A: "A", B: "B" } : null;
  const buttons = t.options.map((o, i) => {
    const b = h("button", { class: `opt ${picked === o.id ? "picked locked" : ""}`, type: "button", disabled: !!picked },
      h("span", { class: "tag" }, tags ? tags[o.id] : String(i + 1)), h("span", { class: "t" }, o.text));
    b.addEventListener("click", () => {
      if (picked) return;
      sfx.unlock();
      buttons.forEach((x) => { x.disabled = true; });
      b.classList.add("picked");
      const payload = t.kind === "headline" ? { matchupId: t.voteId, choice: o.id } : { subjectId: t.voteId, choice: o.id };
      socket.emit("player:vote", payload, (r) => {
        if (!r || !r.ok) { buttons.forEach((x) => { x.disabled = false; }); b.classList.remove("picked"); toast((r && r.error) || "Vote didn't go through."); return; }
        sfx.play("click");
      });
    });
    return b;
  });
  return h("div", { class: "screen" },
    h("div", { class: "progress" }, h("span", null, t.kind === "headline" ? "Vote for the funnier one" : "Which one is TRUE?"), h("span", null, s.you.role === "audience" ? "Audience vote" : "")),
    h("div", { class: `prompt-card card ${t.kind === "truth" ? "confess" : ""}` }, t.kind === "headline" ? fitHeadline(t.prompt) : t.prompt),
    h("div", { class: "options" }, buttons),
    picked ? h("div", { class: "locked-note" }, "Vote locked in. Watch the TV.") : null,
  );
}

function screenRank(s) {
  const t = s.task;
  if (t.picked) {
    return h("div", { class: "screen center" },
      h("div", { class: "big-msg" }, "Votes locked in"),
      h("p", { class: "note" }, "The results are about to hit the TV."),
      reactionBar(),
    );
  }
  const label = h("div", { class: "progress" }, h("span", { class: "red ui" }, ""), h("span", null, "Final round"));
  const list = h("div", { class: "options" });
  const confirm = h("button", { class: "btn big", type: "button", disabled: true }, "Lock it in");
  const refresh = () => {
    clear(list);
    t.options.forEach((o, i) => {
      const isFirst = rankPick.first === o.id, isSecond = rankPick.second === o.id;
      const b = h("button", { class: `opt ${isFirst ? "picked" : ""} ${isSecond ? "second" : ""}`, type: "button" },
        h("span", { class: "tag" }, String(i + 1)),
        h("span", { class: "t" }, o.text, (isFirst || isSecond) ? h("div", { class: "rank" }, isFirst ? "Top story" : "Runner-up") : null));
      b.addEventListener("click", () => {
        sfx.unlock(); sfx.play("click");
        if (rankPick.first === o.id) { rankPick.first = rankPick.second; rankPick.second = null; }
        else if (rankPick.second === o.id) { rankPick.second = null; }
        else if (!rankPick.first) rankPick.first = o.id;
        else if (!rankPick.second && t.needSecond) rankPick.second = o.id;
        else { rankPick.second = t.needSecond ? rankPick.first : null; rankPick.first = o.id; }
        refresh();
      });
      list.appendChild(b);
    });
    const ready = rankPick.first && (!t.needSecond || rankPick.second);
    confirm.disabled = !ready;
    label.firstChild.textContent = !rankPick.first ? "Tap your TOP STORY" : t.needSecond && !rankPick.second ? "Now tap a RUNNER-UP" : "Ready?";
  };
  confirm.addEventListener("click", () => {
    confirm.disabled = true;
    socket.emit("player:vote", { first: rankPick.first, second: t.needSecond ? rankPick.second : null }, (r) => {
      if (!r || !r.ok) { confirm.disabled = false; toast((r && r.error) || "Vote didn't go through."); return; }
      sfx.play("pop");
    });
  });
  refresh();
  return h("div", { class: "screen" }, label, h("p", { class: "note", style: { textAlign: "left", margin: 0 } }, "Top story earns the writer 1000 per vote, runner-up 500."), list, confirm);
}

function screenWait(s) {
  const t = s.task;
  const intro = t.intro;
  return h("div", { class: "screen center" },
    t.spotlight ? h("div", { class: "spotlight" }, t.message) : h("div", { class: "big-msg" }, t.message),
    intro ? h("div", { class: "rules", style: { textAlign: "left" } }, h("b", null, `${intro.kicker}: ${intro.title}`), h("ul", { style: { margin: "0.4rem 0 0", paddingLeft: "1.1rem" } }, intro.rules.map((r) => h("li", null, r)))) : null,
    scoreBox(s),
    reactionBar(),
  );
}

function screenFinal(s) {
  const t = s.task;
  const you = s.you;
  const rows = t.standings.map((p) => h("div", { class: `row ${p.id === you.id ? "me-row" : ""}` }, h("span", { class: "pl" }, placeLabel(p.place)), badge(p), h("span", { class: "sc" }, fmtScore(p.score))));
  return h("div", { class: "screen center" },
    you.role === "player" ? h("div", { class: "place-big" }, t.place === 1 ? "WINNER" : ordinalWord(t.place)) : h("div", { class: "big-msg" }, "That's a wrap"),
    you.role === "player" ? h("p", { class: "note" }, `${fmtScore(t.score)} points`) : h("p", { class: "note" }, "You'll be a player next game."),
    h("div", { class: "standings" }, rows),
    t.isVip ? h("button", { class: "btn big yellow", type: "button", onclick: () => { sfx.unlock(); socket.emit("player:playAgain", {}, (r) => { if (r && !r.ok) toast(r.error); }); } }, "Play again") : h("p", { class: "note" }, "The VIP or the TV can start another game."),
    reactionBar(),
    h("button", { class: "linkish", type: "button", onclick: leave }, "Leave this room"),
  );
}

// ── misc ────────────────────────────────────────────────────────────────────
function leave() {
  socket.emit("player:leave", {}, () => {});
  saveSession(null);
  state = null; viewKey = null;
  renderJoin("", "");
}

function shake(el) { el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake"); }

let toastTimer = null;
function toast(msg, ms = 3000) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { toastEl.hidden = true; }

// First paint while the socket connects.
if (!session) renderJoin(urlCode, "");
else { clear(app); app.appendChild(h("div", { class: "screen center" }, h("div", { class: "big-msg" }, "Finding your seat…"))); }
