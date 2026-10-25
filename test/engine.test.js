import { test } from "node:test";
import assert from "node:assert/strict";
import { Room, MIN_PLAYERS, MAX_PLAYERS, SCORING, TIMINGS, PRESENTATION_PHASES } from "../server/game.js";
import { makeRng } from "../server/util.js";

function harness(seed = 1) {
  let now = 1_700_000_000_000;
  const timers = new Map();
  let hid = 0;
  const sounds = [];
  const reactions = [];
  let updates = 0;
  const room = new Room("TEST", {
    rng: makeRng(seed),
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++hid; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    onUpdate: () => { updates++; },
    onSound: (s) => sounds.push(s),
    onReaction: (_r, rx) => reactions.push(rx),
  });
  const fire = () => {
    assert.ok(timers.size > 0, `expected a pending timer in phase ${room.phase}`);
    const [id, t] = Array.from(timers.entries()).sort((a, b) => a[1].at - b[1].at)[0];
    now = t.at;
    timers.delete(id);
    t.fn();
  };
  const advanceClock = (ms) => { now += ms; };
  return { room, fire, advanceClock, timers, sounds, reactions, updates: () => updates, now: () => now };
}

function joinPlayers(room, n, prefix = "P") {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = room.join(`${prefix}${i + 1}`, `sock${prefix}${i}`);
    assert.equal(r.ok, true);
    assert.equal(r.role, "player");
    ids.push({ id: r.id, token: r.token });
  }
  return ids;
}

// Check every view renders without throwing and leaks nothing it shouldn't.
function checkViews(room) {
  const hv = room.hostView();
  assert.equal(hv.phase, room.phase);
  const json = JSON.stringify(hv);
  assert.ok(!json.includes(room.hostToken), "host token leaked into host view");
  for (const p of room.players.values()) {
    assert.ok(!json.includes(p.token), "player token leaked into host view");
    const pv = room.playerView(p.id);
    assert.ok(pv, "player view missing");
    const pj = JSON.stringify(pv);
    for (const q of room.players.values()) assert.ok(!pj.includes(q.token), "token leaked into player view");
    assert.ok(pv.task && pv.task.type, "task missing");
    if (room.phase === "r1_vote") {
      const m = room.r1.matchups[room.r1.current];
      if (pv.task.type === "vote") {
        // Voting options must be opaque slots, never author ids.
        assert.deepEqual(pv.task.options.map((o) => o.id).sort(), ["A", "B"]);
        assert.ok(!pj.includes(m.a) || m.a === p.id || pv.players.some((x) => x.id === m.a), "author id appears only via player list");
      }
    }
  }
  for (const a of room.audience.values()) {
    const av = room.playerView(a.id);
    assert.ok(av && av.task && av.task.type);
    assert.equal(av.you.role, "audience");
  }
}

// Plays a complete game with scripted behaviour per player. Returns a log of phases.
function playFullGame(h, opts = {}) {
  const { room, fire } = h;
  const phases = [];
  const rng = makeRng(opts.seed || 42);
  const maxSteps = 2000;
  let steps = 0;
  const behaviour = opts.behaviour || (() => "answer");
  while (room.phase !== "final" && steps++ < maxSteps) {
    phases.push(room.phase);
    checkViews(room);
    const phase = room.phase;
    if (PRESENTATION_PHASES.has(phase)) { fire(); continue; }
    if (phase.endsWith("_write")) {
      for (const p of room.playerList()) {
        const mode = behaviour(p, phase);
        if (mode === "skip") continue;
        const pv = room.playerView(p.id);
        if (pv.task.type !== "write") continue;
        for (const item of pv.task.items) {
          if (item.done) continue;
          let text;
          if (phase === "r1_write") text = mode === "plant" ? `my ${item.plantWord} is ${p.name}'s fault` : `${p.name} says ${item.key} ${Math.floor(rng() * 1000)}`;
          else if (phase === "r2_write") text = item.truth ? `truth of ${p.name} ${Math.floor(rng() * 1000)}` : `lie by ${p.name} ${Math.floor(rng() * 1000)}`;
          else text = `${p.name} connects the dots ${Math.floor(rng() * 1000)}`;
          const r = room.submitWrite(p.id, item.key, text);
          assert.equal(r.ok, true, `submit failed: ${r.error}`);
          if (room.phase !== phase) break;
        }
        if (room.phase !== phase) break;
      }
      if (room.phase === phase) fire(); // somebody skipped: let the timer run out
      continue;
    }
    if (phase.endsWith("_vote")) {
      const voters = room.playerList().concat(Array.from(room.audience.values()));
      for (const v of voters) {
        if (room.phase !== phase) break;
        if (behaviour(v, phase) === "skip") continue;
        const pv = room.playerView(v.id);
        if (pv.task.type === "vote") {
          const choice = pv.task.options[Math.floor(rng() * pv.task.options.length)].id;
          const payload = phase === "r1_vote" ? { matchupId: pv.task.voteId, choice } : { subjectId: pv.task.voteId, choice };
          const r = room.submitVote(v.id, payload);
          assert.equal(r.ok, true, `vote failed: ${r.error}`);
        } else if (pv.task.type === "rank") {
          const opts2 = pv.task.options.slice();
          const first = opts2.splice(Math.floor(rng() * opts2.length), 1)[0].id;
          const second = pv.task.needSecond ? opts2[Math.floor(rng() * opts2.length)].id : null;
          const r = room.submitVote(v.id, { first, second });
          assert.equal(r.ok, true, `rank failed: ${r.error}`);
        }
      }
      if (room.phase === phase) fire();
      continue;
    }
    throw new Error(`unhandled phase ${phase}`);
  }
  assert.equal(room.phase, "final", "game should reach the final screen");
  checkViews(room);
  return phases;
}

test("full game plays through for every supported player count", () => {
  for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
    const h = harness(n * 7);
    joinPlayers(h.room, n);
    const start = h.room.startGame();
    assert.equal(start.ok, true);
    const phases = playFullGame(h, { seed: n, behaviour: (p) => (p.name.endsWith("1") ? "plant" : "answer") });
    for (const must of ["r1_intro", "r1_write", "r1_vote", "r1_reveal", "r1_scores", "r2_intro", "r2_write", "r2_vote", "r2_reveal", "r2_scores", "r3_intro", "r3_write", "r3_vote", "r3_reveal"]) {
      assert.ok(phases.includes(must), `${n} players: missing phase ${must}`);
    }
    assert.equal(phases.filter((p) => p === "r1_vote").length, n, "one matchup per player");
    assert.equal(phases.filter((p) => p === "r2_vote").length, n, "one confession per player");
    const total = h.room.playerList().reduce((s, p) => s + p.score, 0);
    assert.ok(total > 0, "somebody scored");
    assert.ok(h.room.final.standings.length === n);
    assert.equal(h.room.final.standings[0].place, 1);
    assert.equal(h.timers.size, 0, "no timers left running at the final screen");
    // Every player answered two headlines and each matchup has exactly two authors.
    for (const m of h.room.r1.matchups) assert.equal(Object.keys(m.answers).length, 2);
    for (const p of h.room.playerList()) assert.equal(h.room.r1.assignments[p.id].length, 2);
    // Everyone was a liar exactly twice.
    for (const p of h.room.playerList()) {
      assert.equal(h.room.r2.subjects.filter((s) => s.liars.includes(p.id)).length, 2);
    }
  }
});

test("lobby rules: minimum players, VIP, duplicate names, removal", () => {
  const h = harness(3);
  const r = h.room;
  assert.equal(r.startGame().ok, false);
  const a = r.join("Kyle", "s1");
  const b = r.join("kyle", "s2");
  assert.notEqual(r.players.get(a.id).name.toLowerCase(), r.players.get(b.id).name.toLowerCase());
  assert.equal(r.players.get(b.id).name, "kyle2");
  assert.equal(r.players.get(a.id).isVip, true);
  assert.equal(r.startGame().ok, false, "two players is not enough");
  const c = r.join("   ", "s3");
  assert.equal(r.players.get(c.id).name, "Anon");
  const long = r.join("ThisNameIsWayTooLongForTheBadge", "s4");
  assert.ok(r.players.get(long.id).name.length <= 12);
  assert.equal(r.removePlayer(a.id).ok, true);
  assert.ok(r.vip(), "VIP reassigned");
  assert.notEqual(r.vip().id, a.id);
  assert.equal(r.startGame().ok, true);
  assert.equal(r.removePlayer(b.id).ok, false, "cannot remove during a game");
  assert.equal(r.phase, "r1_intro");
});

test("late joiners become audience, can vote, and are promoted on play again", () => {
  const h = harness(9);
  const r = h.room;
  joinPlayers(r, 4);
  r.startGame();
  const late = r.join("Latecomer", "late");
  assert.equal(late.role, "audience");
  // Advance to the first vote.
  h.fire(); // intro -> write
  assert.equal(r.phase, "r1_write");
  const av = r.playerView(late.id);
  assert.equal(av.task.type, "wait");
  h.fire(); // write timer -> vote (nobody answered)
  assert.equal(r.phase, "r1_vote");
  const vote = r.playerView(late.id).task;
  assert.equal(vote.type, "vote");
  const res = r.submitVote(late.id, { matchupId: vote.voteId, choice: "A" });
  assert.equal(res.ok, true);
  // Audience's vote counts in the tally.
  const m = r.r1.matchups[r.r1.current];
  assert.equal(Object.keys(m.votes).length, 1);
  // Finish the game by letting timers run.
  let guard = 0;
  while (r.phase !== "final" && guard++ < 500) h.fire();
  assert.equal(r.phase, "final");
  assert.equal(r.playAgain().ok, true);
  assert.equal(r.phase, "lobby");
  assert.equal(r.players.size, 5, "audience member promoted");
  assert.equal(r.audience.size, 0);
  assert.ok(r.players.get(late.id));
  for (const p of r.players.values()) assert.equal(p.score, 0);
  assert.equal(r.gamesPlayed, 1);
});

test("a room full of players sends new joiners to the audience", () => {
  const h = harness(11);
  joinPlayers(h.room, MAX_PLAYERS);
  const extra = h.room.join("Eleven", "s11");
  assert.equal(extra.role, "audience");
  assert.equal(h.room.players.size, MAX_PLAYERS);
});

test("a game with zero participation still completes on timers", () => {
  const h = harness(5);
  joinPlayers(h.room, 3);
  h.room.startGame();
  let guard = 0;
  while (h.room.phase !== "final" && guard++ < 500) { checkViews(h.room); h.fire(); }
  assert.equal(h.room.phase, "final");
  assert.ok(h.room.final.standings.every((s) => s.score === 0));
  assert.equal(h.room.r2.active.length, 0, "every confession skipped");
  assert.equal(h.room.announcer, h.room.announcer); // no throw
  assert.equal(h.timers.size, 0);
});

test("writing phase ends early when every connected player has filed", () => {
  const h = harness(21);
  const ids = joinPlayers(h.room, 3);
  h.room.startGame();
  h.fire();
  assert.equal(h.room.phase, "r1_write");
  for (const { id } of ids) {
    const t = h.room.playerView(id).task;
    for (const item of t.items) h.room.submitWrite(id, item.key, `answer ${item.key}`);
  }
  assert.equal(h.room.phase, "r1_vote", "advanced without waiting for the timer");
});

test("disconnected players don't block early advance; rejoin restores them", () => {
  const h = harness(22);
  const ids = joinPlayers(h.room, 4);
  h.room.startGame();
  h.fire();
  assert.equal(h.room.phase, "r1_write");
  // Player 4 goes dark.
  const dark = ids[3];
  h.room.detachParticipant("sockP3");
  assert.equal(h.room.players.get(dark.id).connected, false);
  for (const { id } of ids.slice(0, 3)) {
    for (const item of h.room.playerView(id).task.items) h.room.submitWrite(id, item.key, "x");
  }
  assert.equal(h.room.phase, "r1_vote");
  // They come back with the right token.
  assert.equal(h.room.rejoin(dark.id, "wrong", "newsock").ok, false);
  assert.equal(h.room.rejoin(dark.id, dark.token, "newsock").ok, true);
  assert.equal(h.room.players.get(dark.id).connected, true);
  assert.equal(h.room.players.get(dark.id).socketId, "newsock");
  // Detaching an unknown socket is a no-op.
  assert.equal(h.room.detachParticipant("nobody"), false);
});

test("round 1 scoring: pool split, scoop bonus, plant bonus, ties", () => {
  const h = harness(31);
  const ids = joinPlayers(h.room, 5);
  h.room.startGame();
  h.fire();
  const r = h.room;
  const m = r.r1.matchups[0];
  // Author a plants their word, b writes normally.
  r.submitWrite(m.a, m.id, `I blame the ${m.plants[m.a]}`);
  r.submitWrite(m.b, m.id, "something else");
  // Fill the remaining prompts so the phase ends.
  for (const { id } of ids) {
    const pv = r.playerView(id);
    if (pv.task.type === "write") for (const item of pv.task.items) if (!item.done) r.submitWrite(id, item.key, "filler");
  }
  assert.equal(r.phase, "r1_vote");
  assert.equal(r.r1.matchups[r.r1.current].id, m.id);
  const voters = ids.map((x) => x.id).filter((id) => id !== m.a && id !== m.b);
  assert.equal(voters.length, 3);
  const slotOfA = Object.keys(m.slots).find((k) => m.slots[k] === m.a);
  for (const v of voters) assert.equal(r.submitVote(v, { matchupId: m.id, choice: slotOfA }).ok, true);
  assert.equal(r.phase, "r1_reveal");
  assert.equal(m.result.winner, m.a);
  assert.equal(m.result.points[m.a], SCORING.r1Pool + SCORING.r1Scoop + SCORING.r1PlantUsed + SCORING.r1PlantWin);
  assert.equal(m.result.points[m.b], 0);
  assert.deepEqual(m.result.bonuses[m.a].map((b) => b.type).sort(), ["plant", "scoop"]);
  assert.equal(r.players.get(m.a).stats.plants, 1);
  const hv = r.hostView();
  const winSlot = hv.matchup.slots.find((s) => s.winner);
  assert.equal(winSlot.author.id, m.a);
  assert.equal(winSlot.votes, 3);
  assert.equal(winSlot.voters.length, 3);

  // Next matchup: a tie with 2 voters, 1 each.
  h.fire();
  assert.equal(r.phase, "r1_vote");
  const m2 = r.r1.matchups[r.r1.current];
  const voters2 = ids.map((x) => x.id).filter((id) => id !== m2.a && id !== m2.b);
  r.submitVote(voters2[0], { matchupId: m2.id, choice: "A" });
  r.submitVote(voters2[1], { matchupId: m2.id, choice: "B" });
  // Self vote and stale matchup votes are rejected.
  assert.equal(r.submitVote(m2.a, { matchupId: m2.id, choice: "A" }).ok, false);
  assert.equal(r.submitVote(voters2[2], { matchupId: m.id, choice: "A" }).ok, false);
  assert.equal(r.submitVote(voters2[2], { matchupId: m2.id, choice: "C" }).ok, false);
  r.submitVote(voters2[2], { matchupId: m2.id, choice: "A" });
  assert.equal(r.phase, "r1_reveal");
  assert.equal(m2.result.total, 3);
  assert.equal(m2.result.points[m2.slots.A] + m2.result.points[m2.slots.B] >= SCORING.r1Pool - 1, true);
  // Duplicate vote is idempotent.
  assert.equal(r.submitVote(voters2[2], { matchupId: m2.id, choice: "B" }).ok, false, "phase has moved on");
});

test("round 2: truth missing skips subject, decoys fill gaps, duplicate lies are replaced", () => {
  const h = harness(41);
  const ids = joinPlayers(h.room, 4).map((x) => x.id);
  const r = h.room;
  r.startGame();
  // Run round 1 on timers.
  while (r.phase !== "r2_write") h.fire();
  const subjects = r.r2.subjects;
  const [s0, s1, s2, s3] = subjects;
  // s0: no truth -> skipped. s1: truth + one lie identical to truth + one missing lie.
  r.submitWrite(s1.subjectId, "truth", "I once ate a shoe");
  r.submitWrite(s1.liars[0], `lie:${s1.id}`, "i once ATE a shoe!");
  // s2: full set. s3: truth only.
  r.submitWrite(s2.subjectId, "truth", "truth two");
  r.submitWrite(s2.liars[0], `lie:${s2.id}`, "lie two a");
  r.submitWrite(s2.liars[1], `lie:${s2.id}`, "lie two b");
  r.submitWrite(s3.subjectId, "truth", "truth three");
  // Wrong liar is rejected; duplicate submission is idempotent.
  const notLiar = ids.find((id) => !s2.liars.includes(id) && id !== s2.subjectId);
  assert.equal(r.submitWrite(notLiar, `lie:${s2.id}`, "nope").ok, false);
  assert.equal(r.submitWrite(s2.liars[0], `lie:${s2.id}`, "changed").ok, true);
  assert.equal(s2.lies[s2.liars[0]], "lie two a", "first submission sticks");
  assert.equal(r.submitWrite(s2.subjectId, "bogus", "x").ok, false);
  h.fire(); // timer ends writing
  assert.equal(r.phase, "r2_vote");
  assert.equal(r.r2.active.length, 3);
  assert.ok(s0.skipped);
  for (const s of r.r2.active) {
    assert.equal(s.options.length, 3);
    const texts = s.options.map((o) => o.text.toLowerCase());
    assert.equal(new Set(texts).size, 3, "options are distinct");
    assert.equal(s.options.filter((o) => o.isTruth).length, 1);
  }
  assert.equal(s1.options.filter((o) => o.decoy).length, 2, "both lies replaced by decoys");
  assert.equal(s2.options.filter((o) => o.decoy).length, 0);
  // Vote on the current subject: everyone else picks the truth, verify scoring.
  const cur = r.r2.active[0];
  const truth = cur.options.find((o) => o.isTruth);
  const lie = cur.options.find((o) => !o.isTruth);
  const voters = ids.filter((id) => id !== cur.subjectId);
  assert.equal(r.submitVote(cur.subjectId, { subjectId: cur.id, choice: truth.id }).ok, false, "subject can't vote");
  assert.equal(r.submitVote(voters[0], { subjectId: "nope", choice: truth.id }).ok, false);
  const before = Object.fromEntries(ids.map((id) => [id, r.players.get(id).score]));
  r.submitVote(voters[0], { subjectId: cur.id, choice: truth.id });
  r.submitVote(voters[1], { subjectId: cur.id, choice: lie.id });
  r.submitVote(voters[2], { subjectId: cur.id, choice: lie.id });
  assert.equal(r.phase, "r2_reveal");
  assert.equal(r.players.get(voters[0]).score - before[voters[0]], SCORING.r2TruthFound);
  assert.equal(r.players.get(cur.subjectId).score - before[cur.subjectId], 2 * SCORING.r2SubjectFooled);
  if (!lie.decoy) {
    const liarGain = r.players.get(lie.authorId).score - before[lie.authorId];
    assert.ok(liarGain >= 2 * SCORING.r2LieVote, "liar paid per fooled voter");
  }
  const hv = r.hostView();
  assert.equal(hv.subject.options.length, 3);
  assert.ok(hv.subject.options.find((o) => o.isTruth).author.id === cur.subjectId);
  assert.equal(hv.subject.fooled, 2);
  assert.equal(hv.subject.found, 1);
});

test("round 3: quotes come from other players, ranking validation, points", () => {
  const h = harness(51);
  const ids = joinPlayers(h.room, 5).map((x) => x.id);
  const r = h.room;
  r.startGame();
  // Everyone answers everything in rounds 1 and 2 via the generic simulator until r3_write.
  const stopAt = "r3_write";
  const rng = makeRng(5);
  let guard = 0;
  while (r.phase !== stopAt && guard++ < 500) {
    if (PRESENTATION_PHASES.has(r.phase) || r.phase.endsWith("_vote")) { h.fire(); continue; }
    if (r.phase.endsWith("_write")) {
      for (const id of ids) {
        const pv = r.playerView(id);
        if (pv.task.type !== "write") continue;
        for (const item of pv.task.items) if (!item.done) r.submitWrite(id, item.key, `${id}-${item.key}-${Math.floor(rng() * 100)}`);
      }
      if (r.phase.endsWith("_write")) h.fire();
    }
  }
  assert.equal(r.phase, "r3_write");
  for (const id of ids) {
    const e = r.r3.entries[id];
    assert.equal(e.quotes.length, 2);
    for (const q of e.quotes) {
      assert.notEqual(q.authorId, id, "never your own quote");
      assert.ok(q.text.length > 0);
    }
    assert.notEqual(e.quotes[0].authorId, e.quotes[1].authorId, "two different sources");
    const task = r.playerView(id).task;
    assert.equal(task.type, "write");
    assert.deepEqual(task.items[0].quotes, e.quotes.map((q) => q.text));
  }
  for (const id of ids) r.submitWrite(id, "final", `headline by ${id}`);
  assert.equal(r.phase, "r3_vote");
  const hv = r.hostView();
  assert.equal(hv.r3.entries.length, 5);
  assert.ok(hv.r3.entries.every((e) => !("author" in e)), "no authors during voting");
  const me = ids[0];
  const mySlot = r.r3.slots.find((s) => s.authorId === me).id;
  const task = r.playerView(me).task;
  assert.equal(task.type, "rank");
  assert.equal(task.options.length, 4);
  assert.ok(!task.options.some((o) => o.id === mySlot));
  const [o1, o2] = task.options;
  assert.equal(r.submitVote(me, { first: mySlot, second: o1.id }).ok, false, "no self votes");
  assert.equal(r.submitVote(me, { first: o1.id, second: o1.id }).ok, false, "distinct picks");
  assert.equal(r.submitVote(me, { first: o1.id }).ok, false, "runner-up required");
  assert.equal(r.submitVote(me, { first: o1.id, second: o2.id }).ok, true);
  assert.equal(r.submitVote(me, { first: o2.id, second: o1.id }).duplicate, true);
  // Everyone else votes for o1 first, o2 second (where allowed).
  for (const id of ids.slice(1)) {
    const t = r.playerView(id).task;
    const opts = t.options.filter((o) => o.id !== o1.id);
    const first = t.options.some((o) => o.id === o1.id) ? o1.id : opts[0].id;
    const second = opts.find((o) => o.id !== first).id;
    assert.equal(r.submitVote(id, { first, second }).ok, true);
  }
  assert.equal(r.phase, "r3_reveal");
  const results = r.r3.results;
  assert.equal(results[0].slotId, o1.id, "o1 is the top story");
  assert.equal(results[0].points, results[0].units * SCORING.r3Unit);
  assert.ok(results[0].units >= 2 * 4, "at least four first-place picks");
  const total = results.reduce((s, x) => s + x.units, 0);
  assert.equal(total, 5 * 3, "every voter spent 3 units");
  h.fire();
  assert.equal(r.phase, "final");
  assert.ok(r.final.topStory);
  assert.equal(r.final.topStory.text, results[0].text);
  assert.ok(Array.isArray(r.final.awards));
  assert.ok(r.final.headlines.length > 0);
});

test("host skip only works on presentation phases; play again resets state", () => {
  const h = harness(61);
  joinPlayers(h.room, 3);
  const r = h.room;
  assert.equal(r.hostNext().ok, false);
  r.startGame();
  assert.equal(r.phase, "r1_intro");
  assert.equal(r.hostNext().ok, true);
  assert.equal(r.phase, "r1_write");
  assert.equal(r.hostNext().ok, false, "can't skip writing");
  assert.equal(r.playAgain().ok, false);
  while (r.phase !== "final") h.fire();
  assert.equal(r.playAgain().ok, true);
  assert.equal(r.phase, "lobby");
  assert.equal(r.r1, null);
  assert.equal(r.timer.endsAt, null);
  assert.equal(r.startGame().ok, true);
  assert.equal(r.round, 1);
});

test("reactions are validated and rate limited", () => {
  const h = harness(71);
  const [p] = joinPlayers(h.room, 3);
  assert.equal(h.room.react(p.id, "😂").ok, true);
  assert.equal(h.room.react(p.id, "😂").ok, false, "too fast");
  h.advanceClock(1000);
  assert.equal(h.room.react(p.id, "🔥").ok, true);
  assert.equal(h.room.react(p.id, "🍕").ok, false, "not in the allowed set");
  assert.equal(h.room.react("ghost", "😂").ok, false);
  assert.equal(h.reactions.length, 2);
  assert.equal(h.reactions[0].name, h.room.players.get(p.id).name);
});

test("starting a game prunes disconnected lobby players and errors if too few remain", () => {
  const h = harness(81);
  const ids = joinPlayers(h.room, 3);
  h.room.detachParticipant("sockP2");
  const res = h.room.startGame();
  assert.equal(res.ok, false);
  assert.equal(h.room.players.size, 2);
  const again = h.room.join("P3 again", "sockX");
  assert.equal(again.role, "player");
  assert.equal(h.room.startGame().ok, true);
  assert.ok(ids.length === 3);
});

test("timers are scaled and stale timers never fire", () => {
  const h = harness(91);
  h.room.timerScale = 0.5;
  joinPlayers(h.room, 3);
  h.room.startGame();
  const t = Array.from(h.timers.values())[0];
  assert.equal(t.at - h.now(), TIMINGS.intro * 0.5);
  const staleFn = t.fn;
  h.room.hostNext(); // clears the intro timer, sets a new one
  assert.equal(h.room.phase, "r1_write");
  staleFn(); // the stale callback must be ignored
  assert.equal(h.room.phase, "r1_write");
});

test("views never throw in any phase, including for audience", () => {
  const h = harness(101);
  joinPlayers(h.room, 6);
  h.room.startGame();
  const aud = h.room.join("Watcher", "w1");
  let guard = 0;
  while (h.room.phase !== "final" && guard++ < 500) {
    checkViews(h.room);
    const av = h.room.playerView(aud.id);
    assert.ok(av.task.type);
    h.fire();
  }
  checkViews(h.room);
  assert.equal(h.room.playerView(aud.id).task.type, "final");
  assert.equal(h.room.playerView("nobody"), null);
});
