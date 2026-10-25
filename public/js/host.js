import { h, clear, badge, fmtPoints, fmtScore, makeClock, fitHeadline, placeLabel } from "./common.js";
import { sfx } from "./sfx.js";

const socket = io({ reconnectionDelay: 500, reconnectionDelayMax: 3000, timeout: 10000 });
const clock = makeClock();
const stage = document.getElementById("stage");
const footer = document.getElementById("footer");
const timerEl = document.getElementById("timer");
const toastEl = document.getElementById("toast");
const overlayEl = document.getElementById("overlay");
const btnSkip = document.getElementById("btn-skip");
const btnMute = document.getElementById("btn-mute");
const btnFull = document.getElementById("btn-full");

let card = null;      // { code, joinUrl, joinDisplay, qr }
let state = null;
let prev = null;
let viewKey = null;
let lastTickSecond = null;

// ── connection ──────────────────────────────────────────────────────────────
socket.on("connect", () => {
  let hostToken = null;
  try { hostToken = localStorage.getItem("dd_host_token"); } catch (e) { /* ignore */ }
  socket.emit("host:create", { hostToken }, (res) => {
    if (!res || !res.ok) { toast((res && res.error) || "Couldn't open a room. Refresh to try again.", 0); return; }
    card = res;
    try { localStorage.setItem("dd_host_token", res.hostToken); } catch (e) { /* ignore */ }
    hideToast();
    renderFooter();
    if (state) render(true);
  });
});
socket.on("host:state", (s) => {
  prev = state;
  state = s;
  clock.sync(s.serverNow);
  render();
});
socket.on("host:reaction", spawnReaction);
socket.on("host:replaced", () => overlay("This room is now being hosted on another screen.", "Take it back", () => location.reload()));
socket.on("host:closed", () => { try { localStorage.removeItem("dd_host_token"); } catch (e) { /* ignore */ } location.reload(); });
socket.on("disconnect", () => toast("Reconnecting…", 0));

// ── controls ────────────────────────────────────────────────────────────────
btnSkip.addEventListener("click", () => { sfx.unlock(); socket.emit("host:next", {}, () => {}); });
btnMute.addEventListener("click", () => { sfx.unlock(); const m = sfx.toggle(); btnMute.textContent = m ? "🔇" : "🔊"; });
btnMute.textContent = sfx.muted ? "🔇" : "🔊";
btnFull.addEventListener("click", () => {
  sfx.unlock();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
});
document.addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") btnFull.click();
  if (e.key === "m" || e.key === "M") btnMute.click();
  if ((e.key === " " || e.key === "ArrowRight" || e.key === "Enter") && !btnSkip.hidden) { e.preventDefault(); btnSkip.click(); }
});
document.addEventListener("pointerdown", () => sfx.unlock(), { once: true });

// ── timer loop ──────────────────────────────────────────────────────────────
let timerTotal = 0, timerPhase = null;
setInterval(() => {
  if (!state || !state.endsAt) { timerEl.hidden = true; return; }
  if (timerPhase !== viewKey) { timerPhase = viewKey; timerTotal = Math.max(1, state.endsAt - clock.now()); lastTickSecond = null; }
  const remaining = clock.remaining(state.endsAt);
  const secs = Math.ceil(remaining / 1000);
  const interactive = /_(write|vote)$/.test(state.phase);
  timerEl.hidden = !interactive;
  if (!interactive) return;
  timerEl.querySelector(".fill").style.width = `${Math.max(0, Math.min(100, (remaining / timerTotal) * 100))}%`;
  timerEl.querySelector(".num").textContent = String(secs);
  timerEl.classList.toggle("urgent", secs <= 5 && secs > 0);
  if (secs <= 5 && secs > 0 && secs !== lastTickSecond) { lastTickSecond = secs; sfx.play("tick"); }
}, 100);

// ── render ──────────────────────────────────────────────────────────────────
function keyFor(s) {
  const parts = [s.phase, s.round];
  if (s.matchup) parts.push(s.matchup.id);
  if (s.subject) parts.push(s.subject.id);
  if (s.gamesPlayed !== undefined) parts.push(s.gamesPlayed);
  return parts.join("|");
}

function render(force = false) {
  if (!state) return;
  const key = keyFor(state);
  const isIntro = state.phase.endsWith("_intro");
  document.body.classList.toggle("ink-bg", isIntro);
  document.body.classList.toggle("paper-bg", !isIntro);
  btnSkip.hidden = !/_(intro|reveal|scores)$/.test(state.phase);
  playTransitionSounds();
  if (key !== viewKey || force) {
    viewKey = key;
    clear(stage);
    stage.appendChild(build(state));
  } else {
    patch(state);
  }
  renderFooter();
}

function playTransitionSounds() {
  if (!prev) return;
  if (prev.phase !== state.phase) {
    if (state.phase.endsWith("_intro")) sfx.play("whoosh");
    else if (state.phase.endsWith("_reveal")) sfx.play("reveal");
    else if (state.phase.endsWith("_scores")) sfx.play("scores");
    else if (state.phase === "final") sfx.play("fanfare");
    else if (state.phase.endsWith("_vote")) sfx.play("pop");
    return;
  }
  if (state.phase === "lobby" && state.players.length > prev.players.length) sfx.play("join");
  if (state.write && prev.write && state.write.doneIds.length > prev.write.doneIds.length) sfx.play("pop");
  const vi = (s) => (s.matchup && s.matchup.votesIn) || (s.subject && s.subject.votesIn) || (s.r3 && s.r3.votesIn) || 0;
  if (vi(state) > vi(prev)) sfx.play("click");
}

function build(s) {
  switch (s.phase) {
    case "lobby": return buildLobby(s);
    case "r1_intro": case "r2_intro": case "r3_intro": return buildIntro(s);
    case "r1_write": case "r2_write": case "r3_write": return buildWrite(s);
    case "r1_vote": return buildMatchup(s, false);
    case "r1_reveal": return buildMatchup(s, true);
    case "r1_scores": case "r2_scores": return buildScores(s);
    case "r2_vote": return buildSubject(s, false);
    case "r2_reveal": return buildSubject(s, true);
    case "r3_vote": return buildR3Vote(s);
    case "r3_reveal": return buildR3Reveal(s);
    case "final": return buildFinal(s);
    default: return h("section", { class: "center" }, h("h1", { class: "head" }, "…"));
  }
}

function patch(s) {
  if (s.phase === "lobby") { const r = stage.querySelector(".roster"); if (r) r.replaceWith(buildRoster(s)); }
  if (s.write) { const r = stage.querySelector(".roster-status"); if (r) r.replaceWith(buildRosterStatus(s)); }
  const st = stage.querySelector(".status[data-live]");
  if (st) st.replaceWith(buildStatus(s));
}

function renderFooter() {
  clear(footer);
  if (!card) { footer.appendChild(h("span", null, "Opening the newsroom…")); return; }
  footer.appendChild(h("span", null, "Join at ", h("b", null, card.joinDisplay), " · code ", h("span", { class: "code" }, card.code)));
  if (state && state.round) footer.appendChild(h("span", null, `Round ${state.round} of 3`));
  if (state && state.audienceCount) footer.appendChild(h("span", null, `${state.audienceCount} in the audience`));
}

// ── lobby ───────────────────────────────────────────────────────────────────
function buildLobby(s) {
  const joinPanel = h("div", { class: "join-panel card" },
    h("div", { class: "kicker" }, "Join on your phone"),
    h("div", { class: "url" }, card ? card.joinDisplay : "…"),
    h("div", { class: "kicker" }, "Room code"),
    h("div", { class: "code" }, card ? card.code : "····"),
    card && card.qr ? h("div", { class: "qr", html: card.qr }) : null,
  );
  return h("section", { class: "lobby" },
    h("header", { class: "masthead" }, h("h1", { class: "title" }, "The Daily Dirt"), h("div", { class: "tagline" }, "All the news that's fit to fake")),
    h("div", { class: "lobby-grid" }, joinPanel, buildRoster(s)),
  );
}

function buildRoster(s) {
  const n = s.players.length;
  const canStart = s.players.filter((p) => p.connected).length >= s.minPlayers;
  const start = h("div", { class: "start" });
  if (canStart) {
    start.appendChild(h("button", { class: "btn yellow", onclick: () => { sfx.unlock(); socket.emit("host:start", {}, (r) => { if (r && !r.ok) toast(r.error); }); } }, "Everybody's in — start!"));
    start.appendChild(h("div", { class: "hint" }, "or the VIP can press start on their phone"));
  } else {
    start.appendChild(h("div", { class: "hint" }, `Waiting for at least ${s.minPlayers} reporters…`));
  }
  const vipHint = s.gamesPlayed ? h("div", { class: "audience-note" }, "Same crew, fresh dirt. New prompts loaded.") : null;
  return h("div", { class: "roster" },
    h("div", { class: "kicker" }, `Reporters on the beat · ${n} of ${s.maxPlayers}`),
    n === 0 ? h("div", { class: "empty" }, "Nobody here yet. Scan the code or type the URL on your phone.") : null,
    h("div", { class: `players ${n > 6 ? "dense" : ""}` }, s.players.map((p) => h("span", { class: "pop", title: p.connected ? "" : "offline" }, badge(p, { vip: true })))),
    s.audienceCount ? h("div", { class: "audience-note" }, `${s.audienceCount} waiting in the audience — they'll vote this game and play next game.`) : null,
    vipHint,
    start,
  );
}

// ── intro ───────────────────────────────────────────────────────────────────
function buildIntro(s) {
  const info = s.intro || { kicker: "", title: "", rules: [] };
  return h("section", { class: "intro" },
    h("div", { class: "kicker pop" }, info.kicker),
    h("h1", { class: "head title pop" }, info.title),
    h("ol", { class: "rules" }, info.rules.map((r) => h("li", null, r))),
  );
}

// ── writing ─────────────────────────────────────────────────────────────────
function buildWrite(s) {
  const titles = { 1: ["Hot Takes", "Reporters are filling in the blanks. Each headline hides a secret PLANT word — sneak it in for bonus points."],
                   2: ["Anonymous Source", "Everyone is confessing one true thing and inventing lies about two friends. Keep a straight face."],
                   3: ["Connect the Dots", "Each reporter has two scandals from tonight. They're writing the headline that connects them."] };
  const [title, hint] = titles[s.round] || ["", ""];
  return h("section", { class: "write" },
    h("div", { class: "kicker-row" }, h("div", { class: "kicker" }, `Round ${s.round} · ${title}`), h("div", { class: "kicker" }, "Write on your phone")),
    h("h2", { class: "head title" }, "Reporters are writing…"),
    h("p", { class: "hint" }, hint),
    buildRosterStatus(s),
  );
}

function buildRosterStatus(s) {
  const done = new Set(s.write ? s.write.doneIds : []);
  return h("div", { class: "roster-status" }, s.players.map((p) =>
    h("div", { class: `who ${done.has(p.id) ? "done" : ""} ${p.connected ? "" : "offline"}` },
      badge(p),
      h("span", { class: "state" }, done.has(p.id) ? "Filed ✓" : p.connected ? h("span", { class: "dots" }, "typing") : "offline"),
    )));
}

function buildStatus(s) {
  let text;
  if (s.matchup && s.phase === "r1_vote") text = ["Vote on your phone · ", h("b", null, `${s.matchup.votesIn} of ${s.matchup.votersTotal}`), " votes in"];
  else if (s.subject && s.phase === "r2_vote") text = ["Which one is true? Vote on your phone · ", h("b", null, `${s.subject.votesIn} of ${s.subject.votersTotal}`), " in"];
  else if (s.r3 && s.phase === "r3_vote") text = ["Pick your top story and runner-up · ", h("b", null, `${s.r3.votesIn} of ${s.r3.votersTotal}`), " in"];
  else text = [""];
  return h("div", { class: "status", dataset: { live: "1" } }, text);
}

// ── round 1 matchup ─────────────────────────────────────────────────────────
function buildMatchup(s, reveal) {
  const m = s.matchup;
  const answers = m.slots.map((slot) => {
    const el = h("div", { class: `answer card ${slot.blank ? "blank" : ""} ${reveal && slot.winner ? "winner" : ""}` },
      h("div", { class: "letter" }, slot.slot),
      h("div", { class: "text" }, slot.blank ? "(no answer)" : slot.text),
    );
    if (reveal) {
      const pct = m.total ? (slot.votes / m.total) * 100 : 0;
      const zone = h("div", { class: "reveal-zone" },
        h("div", { class: "bar" }, h("div", { class: "fill", style: { width: `${Math.max(pct, slot.votes ? 4 : 0)}%` } })),
        h("div", { class: "voters" }, slot.voters.map((v, i) => h("span", { style: { animationDelay: `${0.6 + i * 0.12}s` } }, badge(v)))),
        h("div", { class: "author-row" },
          badge(slot.author),
          h("div", { class: "points" }, fmtPoints(slot.points)),
        ),
        slot.bonuses && slot.bonuses.length ? h("div", { class: "bonus" }, slot.bonuses.map((b) => h("span", { class: b.type }, `${b.label} ${fmtPoints(b.points)}`))) : null,
      );
      el.appendChild(zone);
      const scoop = slot.bonuses && slot.bonuses.find((b) => b.type === "scoop");
      if (scoop) { el.appendChild(h("div", { class: "stamp" }, scoop.label)); el.classList.add("stamped"); }
      else if (slot.bonuses && slot.bonuses.some((b) => b.type === "plant") && slot.winner) { el.appendChild(h("div", { class: "stamp plant" }, "Planted!")); el.classList.add("stamped"); }
    }
    return el;
  });
  return h("section", { class: `matchup ${reveal ? "reveal" : ""}` },
    h("div", { class: "kicker-row" },
      h("div", { class: "kicker" }, `Round 1 · Headline ${m.index} of ${m.count}`),
      m.subject ? h("div", { class: "kicker" }, "Starring ", badge(m.subject, { noName: false })) : null),
    h("h2", { class: "head prompt" }, fitHeadline(m.prompt)),
    h("div", { class: "answers" }, answers[0], h("div", { class: "vs" }, "VS"), answers[1]),
    reveal && s.announcer ? h("div", { class: "announcer" }, s.announcer) : null,
    reveal ? h("div", { class: "status" }, m.total === 0 ? "No votes, no points." : m.tie ? "A tie splits the pot." : "") : buildStatus(s),
  );
}

// ── scores ──────────────────────────────────────────────────────────────────
function buildScores(s) {
  const rows = s.scores || [];
  const max = Math.max(1, ...rows.map((r) => r.score));
  return h("section", { class: "scores" },
    h("div", { class: "kicker" }, `After round ${s.round}`),
    h("h2", { class: "head title" }, "Standings"),
    h("div", { class: `table ${rows.length > 6 ? "dense" : ""}` }, rows.map((r, i) => h("div", { class: "score-row", style: { animationDelay: `${i * 0.12}s` } },
      h("div", { class: "place" }, placeLabel(r.place)),
      badge(r),
      h("div", { class: "bar" }, h("div", { class: "fill", style: { width: `${(r.score / max) * 100}%`, "--bc": r.color } })),
      h("div", { class: "score" }, fmtScore(r.score)),
    ))),
  );
}

// ── round 2 subject ─────────────────────────────────────────────────────────
function buildSubject(s, reveal) {
  const sub = s.subject;
  const lies = reveal ? sub.options.filter((o) => !o.isTruth) : [];
  const stepDelay = 1.6;
  const options = sub.options.map((o, i) => {
    const el = h("div", { class: `option card` },
      h("div", { class: "num" }, String(i + 1)),
      h("div", { class: "text" }, o.text),
    );
    if (reveal) {
      const order = o.isTruth ? lies.length : lies.indexOf(o);
      const delay = 0.9 + order * stepDelay;
      el.classList.add(o.isTruth ? "truth" : "lie");
      setTimeout(() => { el.classList.add("revealed"); sfx.play("stamp"); }, delay * 1000);
      el.appendChild(h("div", { class: `stamp animate ${o.isTruth ? "truth" : ""}`, style: { animationDelay: `${delay}s` } }, o.isTruth ? "TRUE" : "LIE"));
      const zone = h("div", { class: "reveal-zone", style: { animationDelay: `${delay + 0.25}s` } });
      if (o.isTruth) {
        zone.appendChild(h("div", { class: "label" }, o.voters.length ? "Spotted by" : "Nobody spotted it"));
        zone.appendChild(h("div", { class: "voters" }, o.voters.map((v, k) => h("span", { style: { animationDelay: `${delay + 0.3 + k * 0.1}s` } }, badge(v)))));
        zone.appendChild(h("div", { class: "author-row" }, badge(o.author), h("div", { class: "points", style: { animationDelay: `${delay + 0.5}s` } }, o.points ? fmtPoints(o.points) : "")));
      } else {
        zone.appendChild(h("div", { class: "label" }, o.decoy ? "A decoy from the editor" : o.voters.length ? "Fooled" : "Fooled nobody"));
        zone.appendChild(h("div", { class: "voters" }, o.voters.map((v, k) => h("span", { style: { animationDelay: `${delay + 0.3 + k * 0.1}s` } }, badge(v)))));
        zone.appendChild(h("div", { class: "author-row" }, o.decoy ? h("span", { class: "label" }, "no author") : badge(o.author), h("div", { class: "points", style: { animationDelay: `${delay + 0.5}s` } }, o.points ? fmtPoints(o.points) : "")));
      }
      el.appendChild(zone);
    }
    return el;
  });
  const announcerDelay = 0.9 + lies.length * stepDelay + 0.6;
  return h("section", { class: `subject ${reveal ? "reveal" : ""}` },
    h("div", { class: "kicker-row" }, h("div", { class: "kicker" }, `Round 2 · Source ${sub.index} of ${sub.count}`), h("div", { class: "kicker" }, "One of these is true")),
    h("div", { class: "about" }, badge(sub.subject)),
    h("h2", { class: "head prompt" }, sub.prompt),
    h("div", { class: "options" }, options),
    reveal && s.announcer ? h("div", { class: "announcer", style: { animationDelay: `${announcerDelay}s` } }, s.announcer) : null,
    reveal ? h("div", { class: "status" }, `${sub.fooled} fooled · ${sub.found} found the truth`) : buildStatus(s),
  );
}

// ── round 3 ─────────────────────────────────────────────────────────────────
function entryCard(e, i, opts = {}) {
  const el = h("div", { class: `entry card ${e.text ? "" : "blank"} ${opts.top ? "top" : ""}`, style: opts.style || null },
    i !== null ? h("div", { class: "num" }, String(i + 1)) : null,
    h("div", { class: "sources" }, (e.quotes || []).map((q) => h("span", null, q))),
    h("div", { class: "headline" }, e.text || "(no headline filed)"),
  );
  if (opts.result) {
    el.appendChild(h("div", { class: "author-row" }, badge(e.author), h("div", { class: "points" }, fmtPoints(e.points))));
    if (opts.top && e.text) el.appendChild(h("div", { class: "stamp animate yellow", style: { animationDelay: `${opts.stampDelay || 0}s` } }, "Top Story"));
  }
  return el;
}

function buildR3Vote(s) {
  const entries = s.r3.entries;
  const n = entries.length;
  const cols = n <= 4 ? 2 : 3;
  return h("section", { class: "r3" },
    h("div", { class: "kicker-row" }, h("div", { class: "kicker" }, "Final round · Connect the Dots"), h("div", { class: "kicker" }, "Top story = 1000 · runner-up = 500 per vote")),
    h("h2", { class: "head title" }, "Pick tonight's top story"),
    h("div", { class: `entries ${n > 6 ? "dense" : ""}`, style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } }, entries.map((e, i) => entryCard(e, i))),
    buildStatus(s),
  );
}

function buildR3Reveal(s) {
  const results = s.r3.results;
  const [top, ...rest] = results;
  const n = results.length;
  const step = Math.min(0.55, 3.2 / Math.max(1, rest.length));
  const restEls = rest.map((e, i) => entryCard(e, null, { result: true, style: { animationDelay: `${(rest.length - i) * step}s` } }));
  const topDelay = rest.length * step + 0.9;
  const dense = rest.length > 3;
  const cols = rest.length <= 4 ? 2 : rest.length <= 6 ? 3 : 4;
  setTimeout(() => sfx.play("win"), topDelay * 1000);
  return h("section", { class: "r3" },
    h("div", { class: "kicker-row" }, h("div", { class: "kicker" }, "Final round · results"), h("div", { class: "kicker" }, `${n} headlines filed`)),
    h("div", { class: `announcer ${dense ? "dense" : ""}`, style: { animationDelay: "0.1s", opacity: 1 } }, s.announcer),
    h("div", { class: `results ${dense ? "dense" : ""}` },
      h("div", null, entryCard(top, null, { result: true, top: true, style: { animationDelay: `${topDelay}s` }, stampDelay: topDelay + 0.5 })),
      h("div", { class: `rest ${dense ? "dense" : ""}`, style: { "--cols": cols } }, restEls),
    ),
  );
}

// ── final ───────────────────────────────────────────────────────────────────
function buildFinal(s) {
  const f = s.final || { standings: [], awards: [], headlines: [], topStory: null };
  const winner = f.standings[0];
  const coWinners = f.standings.filter((p) => p.place === 1);
  const podium = f.standings.filter((p) => p.place > 1 && p.place <= 3);
  const again = () => { sfx.unlock(); socket.emit("host:playAgain", {}, (r) => { if (r && !r.ok) toast(r.error); }); };
  return h("section", { class: "final" },
    h("header", { class: "masthead" }, h("h1", { class: "title" }, "The Daily Dirt"), h("div", { class: "tagline" }, "Final edition · all scores are final, all dirt is permanent")),
    h("div", { class: "fp-grid" },
      h("div", { class: "fp-main" },
        h("div", { class: "kicker" }, coWinners.length > 1 ? "Winners" : "Winner"),
        winner ? h("div", { class: "winner-box" },
          h("div", { class: "avas" }, coWinners.slice(0, 3).map((p) => h("div", { class: "ava-big", style: { "--bc": p.color } }, p.emoji))),
          h("div", null,
            h("div", { class: "head name" }, coWinners.map((p) => p.name).join(" & ")),
            h("div", { class: "score" }, `${fmtScore(winner.score)} points`),
          ),
        ) : h("div", { class: "head name" }, "Nobody?"),
        podium.length ? h("div", { class: "podium" }, podium.map((p) => h("div", { class: "step" }, h("span", { class: "pl" }, placeLabel(p.place)), badge(p), h("span", { class: "sc" }, fmtScore(p.score))))) : null,
        f.topStory ? h("div", { class: "top-story card" },
          h("div", { class: "kicker" }, "Tonight's top story"),
          h("div", { class: "headline" }, f.topStory.text),
          h("div", { class: "by" }, "Filed by", badge(f.topStory.author)),
          h("div", { class: "stamp yellow" }, "Front page"),
        ) : null,
      ),
      h("aside", { class: "fp-side" },
        f.awards.length ? h("div", null, h("div", { class: "kicker" }, "Awards"), h("div", { class: "awards" }, f.awards.map((a, i) => h("div", { class: "award", style: { animationDelay: `${0.4 + i * 0.25}s` } },
          h("div", { class: "t" }, a.title), h("div", { class: "b" }, a.players.map((p) => p.name).join(" & ") + " " + a.blurb),
          h("div", { class: "who" }, a.players.map((p) => badge(p))),
        )))) : null,
        f.headlines.length ? h("div", { class: "best-list" }, h("div", { class: "kicker" }, "Best headlines of the night"), f.headlines.slice(0, f.awards.length >= 4 ? 2 : 3).map((x) => h("div", { class: "item" },
          h("div", { class: "p" }, x.prompt), h("div", { class: "a" }, x.text), h("div", { class: "w" }, `${x.author ? x.author.name : "?"} · ${x.votes} ${x.votes === 1 ? "vote" : "votes"}`),
        ))) : null,
      ),
    ),
    h("div", { class: "again" },
      h("button", { class: "btn yellow", onclick: again }, "Play again"),
      h("div", { class: "hint" }, "Same crew, new dirt · the VIP can also restart from their phone"),
    ),
  );
}

// Test hook: render an arbitrary host state (used by the visual regression script).
window.ddDebugRender = (s, cardOverride) => { if (cardOverride) card = cardOverride; prev = state; state = s; clock.sync(s.serverNow); render(true); };

// ── reactions / toasts ──────────────────────────────────────────────────────
function spawnReaction(rx) {
  const container = document.getElementById("reactions");
  if (container.childElementCount > 40) container.firstChild.remove();
  const el = h("div", { class: "reaction", style: { left: `${8 + Math.random() * 84}%`, "--rc": rx.color } },
    h("div", { class: "emoji" }, rx.emoji), h("div", { class: "who" }, rx.name));
  container.appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

let toastTimer = null;
function toast(msg, ms = 3500) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { toastEl.hidden = true; }
function overlay(msg, btnLabel, onClick) {
  clear(overlayEl);
  overlayEl.appendChild(h("div", null, h("div", null, msg), btnLabel ? h("button", { class: "btn yellow", onclick: onClick }, btnLabel) : null));
  overlayEl.hidden = false;
}
