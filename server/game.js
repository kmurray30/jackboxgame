// ─────────────────────────────────────────────────────────────────────────────
// THE DAILY DIRT — game engine (authoritative state machine)
// A Room holds players, audience, phase, timers and all round data.
// Everything that mutates state goes through methods here; views are derived.
// ─────────────────────────────────────────────────────────────────────────────
import {
  HEADLINE_PROMPTS, CONFESSION_PROMPTS, DECOY_LIES, PLANT_WORDS, FILLER_QUOTES,
  ROUND_INFO, ANNOUNCER, AVATAR_EMOJI, AVATAR_COLORS,
} from "./content.js";
import {
  shuffle, pick, randomId, cleanText, cleanName, normalizeForCompare, usedPlantWord, fillName,
} from "./util.js";

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;
export const MAX_AUDIENCE = 100;

export const LIMITS = {
  headline: 80,
  truth: 70,
  lie: 70,
  final: 100,
};

// Base durations in ms (scaled by options.timerScale).
export const TIMINGS = {
  intro: 7000,
  r1_write: 90000,
  r1_vote: 25000,
  r1_reveal: 11000,
  scores: 9000,
  r2_write: 100000,
  r2_vote: 30000,
  r2_reveal: 14000,
  r3_write: 80000,
  r3_vote: 40000,
  r3_reveal: 16000,
};

export const SCORING = {
  r1Pool: 1000,
  r1Scoop: 500,          // unanimous with >= 3 voters
  r1ScoopMinVoters: 3,
  r1PlantUsed: 250,      // plant word + at least one vote
  r1PlantWin: 250,       // additional if the planted answer also wins outright
  r2TruthFound: 500,     // voter who spots the truth
  r2LieVote: 500,        // lie author, per fooled voter
  r2SubjectFooled: 250,  // subject, per fooled voter
  r3Unit: 500,           // first pick = 2 units, second pick = 1 unit
};

export const REACTIONS = ["😂", "🔥", "💀", "😱", "👏", "🤮"];

export const PRESENTATION_PHASES = new Set([
  "r1_intro", "r1_reveal", "r1_scores", "r2_intro", "r2_reveal", "r2_scores", "r3_intro", "r3_reveal",
]);

const NO_ANSWER = "";

export class Room {
  constructor(code, options = {}) {
    this.code = code;
    this.rng = options.rng || Math.random;
    this.now = options.now || Date.now;
    this._setTimeout = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = options.clearTimeout || ((h) => clearTimeout(h));
    this.timerScale = options.timerScale || 1;
    this.onUpdate = options.onUpdate || (() => {});
    this.onReaction = options.onReaction || (() => {});
    this.onSound = options.onSound || (() => {});

    this.createdAt = this.now();
    this.lastActivity = this.createdAt;
    this.hostToken = randomId(this.rng, 24);
    this.hostSocketId = null;
    this.hostConnected = false;

    this.players = new Map();   // id -> player
    this.audience = new Map();  // id -> audience member
    this.gamesPlayed = 0;

    this.usedHeadlines = new Set();
    this.usedConfessions = new Set();

    this.timer = { endsAt: null, handle: null, token: 0 };
    this.phase = "lobby";
    this.round = 0;
    this.announcer = "";
    this.r1 = null;
    this.r2 = null;
    this.r3 = null;
    this.final = null;
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  touch() { this.lastActivity = this.now(); }

  playerList() { return Array.from(this.players.values()); }
  connectedPlayers() { return this.playerList().filter((p) => p.connected); }
  connectedAudience() { return Array.from(this.audience.values()).filter((a) => a.connected); }
  inProgress() { return this.phase !== "lobby" && this.phase !== "final"; }
  anyoneConnected() {
    return this.hostConnected || this.connectedPlayers().length > 0 || this.connectedAudience().length > 0;
  }

  vip() {
    const list = this.playerList();
    return list.find((p) => p.isVip) || null;
  }

  ensureVip() {
    if (this.players.size === 0) return;
    if (this.vip()) return;
    const connected = this.connectedPlayers();
    const next = connected[0] || this.playerList()[0];
    next.isVip = true;
  }

  uniqueName(raw, excludeId = null) {
    let base = cleanName(raw);
    if (!base) base = "Anon";
    const taken = new Set();
    for (const p of this.players.values()) if (p.id !== excludeId) taken.add(p.name.toLowerCase());
    for (const a of this.audience.values()) if (a.id !== excludeId) taken.add(a.name.toLowerCase());
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; n < 100; n++) {
      const candidate = `${Array.from(base).slice(0, 12 - String(n).length).join("")}${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return base + randomId(this.rng, 3);
  }

  freeAvatar() {
    const usedEmoji = new Set(this.playerList().map((p) => p.emoji));
    const usedColor = new Set(this.playerList().map((p) => p.color));
    const emojis = AVATAR_EMOJI.filter((e) => !usedEmoji.has(e));
    const colors = AVATAR_COLORS.filter((c) => !usedColor.has(c));
    return {
      emoji: pick(emojis.length ? emojis : AVATAR_EMOJI, this.rng),
      color: pick(colors.length ? colors : AVATAR_COLORS, this.rng),
    };
  }

  // ── timers ─────────────────────────────────────────────────────────────────
  clearTimer() {
    if (this.timer.handle !== null) this._clearTimeout(this.timer.handle);
    this.timer.handle = null;
    this.timer.endsAt = null;
    this.timer.token++;
  }

  setTimer(baseMs) {
    this.clearTimer();
    const ms = Math.max(250, Math.round(baseMs * this.timerScale));
    const token = this.timer.token;
    this.timer.endsAt = this.now() + ms;
    this.timer.handle = this._setTimeout(() => {
      if (token !== this.timer.token) return; // stale
      this.timer.handle = null;
      this.timer.endsAt = null;
      try {
        this.advance();
      } catch (err) {
        // Never let a bug strand a room: log and try to recover to the final screen.
        console.error(`[room ${this.code}] advance failed in ${this.phase}:`, err);
        this.recover(err);
      }
    }, ms);
  }

  recover(err) {
    this.clearTimer();
    this.announcer = "TECHNICAL DIFFICULTIES";
    this.phase = "final";
    this.final = this.final || this.buildFinal();
    this.final.error = String(err && err.message ? err.message : err);
    this.onUpdate(this);
  }

  transition(phase, baseMs) {
    this.phase = phase;
    if (baseMs) this.setTimer(baseMs);
    else this.clearTimer();
    this.touch();
    this.onUpdate(this);
  }

  // ── host ───────────────────────────────────────────────────────────────────
  attachHost(socketId) {
    this.hostSocketId = socketId;
    this.hostConnected = true;
    this.touch();
    this.onUpdate(this);
  }

  detachHost(socketId) {
    if (this.hostSocketId !== socketId) return;
    this.hostSocketId = null;
    this.hostConnected = false;
    this.onUpdate(this);
  }

  // ── joining ────────────────────────────────────────────────────────────────
  // Returns { ok, role, id, token } or { ok:false, error }
  join(rawName, socketId) {
    const name = this.uniqueName(rawName);
    this.touch();
    const asPlayer = !this.inProgress() && this.players.size < MAX_PLAYERS;
    if (asPlayer) {
      const { emoji, color } = this.freeAvatar();
      const player = {
        id: randomId(this.rng, 12), token: randomId(this.rng, 24), name, emoji, color,
        connected: true, socketId, score: 0, isVip: this.players.size === 0,
        joinedAt: this.now(), stats: freshStats(),
      };
      this.players.set(player.id, player);
      this.ensureVip();
      this.onSound("join");
      this.onUpdate(this);
      return { ok: true, role: "player", id: player.id, token: player.token };
    }
    if (this.audience.size >= MAX_AUDIENCE) return { ok: false, error: "This room is packed. Try again later." };
    const member = {
      id: randomId(this.rng, 12), token: randomId(this.rng, 24), name,
      connected: true, socketId, joinedAt: this.now(),
    };
    this.audience.set(member.id, member);
    this.onUpdate(this);
    return { ok: true, role: "audience", id: member.id, token: member.token };
  }

  // Reattach a returning phone. Returns { ok, role } or { ok:false }
  rejoin(id, token, socketId) {
    const p = this.players.get(id);
    if (p && p.token === token) {
      p.connected = true;
      p.socketId = socketId;
      this.touch();
      this.onUpdate(this);
      return { ok: true, role: "player" };
    }
    const a = this.audience.get(id);
    if (a && a.token === token) {
      a.connected = true;
      a.socketId = socketId;
      this.touch();
      this.onUpdate(this);
      return { ok: true, role: "audience" };
    }
    return { ok: false };
  }

  detachParticipant(socketId) {
    let changed = false;
    for (const p of this.players.values()) {
      if (p.socketId === socketId) { p.connected = false; p.socketId = null; changed = true; }
    }
    for (const a of this.audience.values()) {
      if (a.socketId === socketId) { a.connected = false; a.socketId = null; changed = true; }
    }
    if (changed) {
      // A disconnect can satisfy an "everyone connected has answered" condition.
      this.maybeAdvance();
      this.onUpdate(this);
    }
    return changed;
  }

  // Host (or VIP) removes someone from the lobby.
  removePlayer(id) {
    if (this.phase !== "lobby") return { ok: false, error: "Can only remove players in the lobby." };
    const p = this.players.get(id);
    if (!p) return { ok: false, error: "No such player." };
    this.players.delete(id);
    this.ensureVip();
    this.onUpdate(this);
    return { ok: true };
  }

  // ── game flow ──────────────────────────────────────────────────────────────
  startGame() {
    if (this.phase !== "lobby") return { ok: false, error: "Game already started." };
    // Drop phones that never came back; they can rejoin as audience.
    for (const p of this.playerList()) if (!p.connected) this.players.delete(p.id);
    if (this.players.size < MIN_PLAYERS) {
      return { ok: false, error: `Need at least ${MIN_PLAYERS} players.` };
    }
    this.ensureVip();
    for (const p of this.players.values()) { p.score = 0; p.stats = freshStats(); }
    this.round = 1;
    this.final = null;
    this.setupRound1();
    this.onSound("start");
    this.transition("r1_intro", TIMINGS.intro);
    return { ok: true };
  }

  playAgain() {
    if (this.phase !== "final") return { ok: false, error: "The game isn't over yet." };
    this.gamesPlayed++;
    // Promote the audience into open player seats.
    for (const a of Array.from(this.audience.values())) {
      if (this.players.size >= MAX_PLAYERS) break;
      this.audience.delete(a.id);
      const { emoji, color } = this.freeAvatar();
      this.players.set(a.id, {
        id: a.id, token: a.token, name: a.name, emoji, color, connected: a.connected, socketId: a.socketId,
        score: 0, isVip: false, joinedAt: a.joinedAt, stats: freshStats(),
      });
    }
    for (const p of this.players.values()) { p.score = 0; p.stats = freshStats(); }
    this.ensureVip();
    this.round = 0;
    this.r1 = this.r2 = this.r3 = null;
    this.final = null;
    this.announcer = "";
    this.transition("lobby", 0);
    return { ok: true };
  }

  // Host skips a presentation phase (intro / reveal / scores).
  hostNext() {
    if (!PRESENTATION_PHASES.has(this.phase)) return { ok: false, error: "Nothing to skip right now." };
    this.advance();
    return { ok: true };
  }

  // Timer expired or everyone is done: move to the next phase.
  advance() {
    switch (this.phase) {
      case "lobby": return;
      case "r1_intro": return this.transition("r1_write", TIMINGS.r1_write);
      case "r1_write": {
        this.r1.current = 0;
        return this.transition("r1_vote", TIMINGS.r1_vote);
      }
      case "r1_vote": {
        this.scoreMatchup(this.r1.matchups[this.r1.current]);
        this.onSound("reveal");
        return this.transition("r1_reveal", TIMINGS.r1_reveal);
      }
      case "r1_reveal": {
        if (this.r1.current + 1 < this.r1.matchups.length) {
          this.r1.current++;
          return this.transition("r1_vote", TIMINGS.r1_vote);
        }
        this.onSound("scores");
        return this.transition("r1_scores", TIMINGS.scores);
      }
      case "r1_scores": {
        this.round = 2;
        this.setupRound2();
        return this.transition("r2_intro", TIMINGS.intro);
      }
      case "r2_intro": return this.transition("r2_write", TIMINGS.r2_write);
      case "r2_write": {
        this.finalizeRound2Writing();
        if (this.r2.active.length === 0) {
          this.announcer = "EVERYONE PLEADED THE FIFTH";
          return this.transition("r2_scores", TIMINGS.scores);
        }
        this.r2.current = 0;
        return this.transition("r2_vote", TIMINGS.r2_vote);
      }
      case "r2_vote": {
        this.scoreSubject(this.r2.active[this.r2.current]);
        this.onSound("reveal");
        return this.transition("r2_reveal", TIMINGS.r2_reveal);
      }
      case "r2_reveal": {
        if (this.r2.current + 1 < this.r2.active.length) {
          this.r2.current++;
          return this.transition("r2_vote", TIMINGS.r2_vote);
        }
        this.onSound("scores");
        return this.transition("r2_scores", TIMINGS.scores);
      }
      case "r2_scores": {
        this.round = 3;
        this.setupRound3();
        return this.transition("r3_intro", TIMINGS.intro);
      }
      case "r3_intro": return this.transition("r3_write", TIMINGS.r3_write);
      case "r3_write": {
        this.finalizeRound3Writing();
        return this.transition("r3_vote", TIMINGS.r3_vote);
      }
      case "r3_vote": {
        this.scoreRound3();
        this.onSound("reveal");
        return this.transition("r3_reveal", TIMINGS.r3_reveal);
      }
      case "r3_reveal": {
        this.final = this.buildFinal();
        this.onSound("fanfare");
        return this.transition("final", 0);
      }
      case "final": return;
      default:
        throw new Error(`Unknown phase ${this.phase}`);
    }
  }

  // If every connected participant who has something to do has done it, move on.
  maybeAdvance() {
    const pending = this.pendingParticipants();
    if (pending === null) return;
    if (pending.length === 0) this.advance();
  }

  // Who still owes an action in the current phase? null = phase isn't interactive.
  pendingParticipants() {
    switch (this.phase) {
      case "r1_write":
        return this.connectedPlayers().filter((p) => this.r1.assignments[p.id].some((mid) => this.r1.byId[mid].answers[p.id] === null));
      case "r1_vote": {
        const m = this.r1.matchups[this.r1.current];
        return this.eligibleVoters(new Set([m.a, m.b])).filter((v) => !(v.id in m.votes));
      }
      case "r2_write":
        return this.connectedPlayers().filter((p) => {
          const mine = this.r2.subjects.find((s) => s.subjectId === p.id);
          if (mine.truth === null) return true;
          return this.r2.subjects.some((s) => s.liars.includes(p.id) && s.lies[p.id] === null);
        });
      case "r2_vote": {
        const s = this.r2.active[this.r2.current];
        return this.eligibleVoters(new Set([s.subjectId])).filter((v) => !(v.id in s.votes));
      }
      case "r3_write":
        return this.connectedPlayers().filter((p) => this.r3.entries[p.id].answer === null);
      case "r3_vote":
        return this.eligibleVoters(new Set()).filter((v) => !(v.id in this.r3.votes));
      default:
        return null;
    }
  }

  eligibleVoters(excludeIds) {
    const voters = this.connectedPlayers().filter((p) => !excludeIds.has(p.id));
    return voters.concat(this.connectedAudience());
  }

  isVoterAllowed(id, excludeIds) {
    if (excludeIds.has(id)) return false;
    return this.players.has(id) || this.audience.has(id);
  }

  // ── round 1: HOT TAKES ─────────────────────────────────────────────────────
  pickHeadline() {
    let pool = HEADLINE_PROMPTS.filter((p) => !this.usedHeadlines.has(p));
    if (pool.length === 0) { this.usedHeadlines.clear(); pool = HEADLINE_PROMPTS.slice(); }
    const t = pick(pool, this.rng);
    this.usedHeadlines.add(t);
    return t;
  }

  pickConfession() {
    let pool = CONFESSION_PROMPTS.filter((p) => !this.usedConfessions.has(p));
    if (pool.length === 0) { this.usedConfessions.clear(); pool = CONFESSION_PROMPTS.slice(); }
    const t = pick(pool, this.rng);
    this.usedConfessions.add(t);
    return t;
  }

  setupRound1() {
    const order = shuffle(this.playerList(), this.rng);
    const n = order.length;
    const plants = shuffle(PLANT_WORDS, this.rng);
    const matchups = [];
    const byId = {};
    const assignments = {};
    for (const p of order) assignments[p.id] = [];
    let plantIdx = 0;
    for (let i = 0; i < n; i++) {
      const a = order[i], b = order[(i + 1) % n];
      const template = this.pickHeadline();
      let subject = null;
      if (template.includes("{name}")) {
        const others = order.filter((p) => p.id !== a.id && p.id !== b.id);
        subject = pick(others, this.rng);
      }
      const prompt = subject ? fillName(template, subject.name) : template;
      const slotsShuffled = shuffle([a.id, b.id], this.rng);
      const m = {
        id: `m${i}`, prompt, subjectId: subject ? subject.id : null,
        a: a.id, b: b.id,
        slots: { A: slotsShuffled[0], B: slotsShuffled[1] },
        answers: { [a.id]: null, [b.id]: null },
        plants: { [a.id]: plants[plantIdx++ % plants.length], [b.id]: plants[plantIdx++ % plants.length] },
        votes: {}, // voterId -> authorId
        result: null,
      };
      matchups.push(m);
      byId[m.id] = m;
      assignments[a.id].push(m.id);
      assignments[b.id].push(m.id);
    }
    // Present matchups in a shuffled order so the first player isn't always first.
    this.r1 = { matchups: shuffle(matchups, this.rng), byId, assignments, current: -1 };
  }

  scoreMatchup(m) {
    const tally = { [m.a]: 0, [m.b]: 0 };
    const voters = { [m.a]: [], [m.b]: [] };
    for (const [voterId, authorId] of Object.entries(m.votes)) {
      if (authorId in tally) { tally[authorId]++; voters[authorId].push(voterId); }
    }
    const total = tally[m.a] + tally[m.b];
    const points = { [m.a]: 0, [m.b]: 0 };
    const bonuses = { [m.a]: [], [m.b]: [] };
    let winner = null;
    if (total > 0) {
      if (tally[m.a] !== tally[m.b]) winner = tally[m.a] > tally[m.b] ? m.a : m.b;
      for (const pid of [m.a, m.b]) {
        points[pid] = Math.round((SCORING.r1Pool * tally[pid]) / total);
        if (winner === pid && total >= SCORING.r1ScoopMinVoters && tally[pid] === total) {
          bonuses[pid].push({ type: "scoop", label: pick(ANNOUNCER.scoop, this.rng), points: SCORING.r1Scoop });
          points[pid] += SCORING.r1Scoop;
        }
      }
    }
    for (const pid of [m.a, m.b]) {
      const text = m.answers[pid];
      if (text && usedPlantWord(text, m.plants[pid]) && tally[pid] > 0) {
        let plantPts = SCORING.r1PlantUsed;
        if (winner === pid) plantPts += SCORING.r1PlantWin;
        bonuses[pid].push({ type: "plant", label: `PLANTED “${m.plants[pid].toUpperCase()}”`, points: plantPts });
        points[pid] += plantPts;
        this.players.get(pid).stats.plants++;
      }
    }
    for (const pid of [m.a, m.b]) this.players.get(pid).score += points[pid];
    if (total === 0) this.announcer = pick(ANNOUNCER.noVotes, this.rng);
    else if (!winner) this.announcer = pick(ANNOUNCER.tie, this.rng);
    else this.announcer = "";
    m.result = { tally, voters, total, winner, points, bonuses };
  }

  // ── round 2: ANONYMOUS SOURCE ──────────────────────────────────────────────
  setupRound2() {
    const order = shuffle(this.playerList(), this.rng);
    const n = order.length;
    const subjects = order.map((p, i) => {
      const liars = [order[(i + 1) % n].id, order[(i + 2) % n].id];
      return {
        id: `s${i}`, subjectId: p.id,
        prompt: fillName(this.pickConfession(), p.name),
        liars,
        truth: null,
        lies: { [liars[0]]: null, [liars[1]]: null },
        options: null, votes: {}, result: null, skipped: false,
      };
    });
    this.r2 = { subjects, active: [], current: -1 };
  }

  finalizeRound2Writing() {
    const decoys = shuffle(DECOY_LIES, this.rng);
    let d = 0;
    const nextDecoy = () => decoys[d++ % decoys.length];
    for (const s of this.r2.subjects) {
      if (!s.truth) { s.skipped = true; continue; }
      const seen = new Set([normalizeForCompare(s.truth)]);
      const options = [{ id: null, text: s.truth, authorId: s.subjectId, isTruth: true, decoy: false }];
      for (const liarId of s.liars) {
        let text = s.lies[liarId];
        let decoy = false;
        if (!text || seen.has(normalizeForCompare(text))) {
          do { text = nextDecoy(); } while (seen.has(normalizeForCompare(text)));
          decoy = true;
        }
        seen.add(normalizeForCompare(text));
        options.push({ id: null, text, authorId: liarId, isTruth: false, decoy });
      }
      s.options = shuffle(options, this.rng).map((o, i) => ({ ...o, id: `o${i}` }));
    }
    this.r2.active = this.r2.subjects.filter((s) => !s.skipped);
  }

  scoreSubject(s) {
    const perOption = {};
    for (const o of s.options) perOption[o.id] = { voters: [], points: 0 };
    const points = {};
    const add = (pid, pts) => { points[pid] = (points[pid] || 0) + pts; };
    let fooled = 0, found = 0;
    for (const [voterId, optionId] of Object.entries(s.votes)) {
      const o = s.options.find((x) => x.id === optionId);
      if (!o) continue;
      perOption[o.id].voters.push(voterId);
      if (o.isTruth) {
        found++;
        if (this.players.has(voterId)) { add(voterId, SCORING.r2TruthFound); this.players.get(voterId).stats.truthHits++; }
      } else {
        fooled++;
        if (!o.decoy) {
          add(o.authorId, SCORING.r2LieVote);
          perOption[o.id].points += SCORING.r2LieVote;
          this.players.get(o.authorId).stats.lieVotes++;
        }
        add(s.subjectId, SCORING.r2SubjectFooled);
        this.players.get(s.subjectId).stats.fooled++;
      }
    }
    for (const [pid, pts] of Object.entries(points)) {
      const p = this.players.get(pid);
      if (p) p.score += pts;
    }
    const truthOption = s.options.find((o) => o.isTruth);
    perOption[truthOption.id].points = fooled * SCORING.r2SubjectFooled;
    this.announcer = fooled + found === 0
      ? pick(ANNOUNCER.noVotes, this.rng)
      : found > fooled ? pick(ANNOUNCER.truthFound, this.rng) : pick(ANNOUNCER.truthHidden, this.rng);
    s.result = { perOption, points, fooled, found, truthOptionId: truthOption.id };
  }

  // ── round 3: CONNECT THE DOTS ──────────────────────────────────────────────
  setupRound3() {
    const pool = [];
    for (const m of this.r1.matchups) {
      for (const pid of [m.a, m.b]) {
        const t = m.answers[pid];
        if (t) pool.push({ text: t, authorId: pid, source: m.id });
      }
    }
    for (const s of this.r2.subjects) {
      for (const liarId of s.liars) {
        const t = s.lies[liarId];
        if (t) pool.push({ text: t, authorId: liarId, source: s.id });
      }
    }
    const fillers = shuffle(FILLER_QUOTES, this.rng);
    let f = 0;
    const entries = {};
    const order = shuffle(this.playerList(), this.rng);
    for (const p of order) {
      const candidates = shuffle(pool.filter((q) => q.authorId !== p.id), this.rng);
      const chosen = [];
      for (const q of candidates) {
        if (chosen.length === 2) break;
        if (chosen.some((c) => c.source === q.source || c.authorId === q.authorId || normalizeForCompare(c.text) === normalizeForCompare(q.text))) continue;
        chosen.push(q);
      }
      // Relax the "different author" rule if the pool is thin.
      if (chosen.length < 2) {
        for (const q of candidates) {
          if (chosen.length === 2) break;
          if (chosen.some((c) => normalizeForCompare(c.text) === normalizeForCompare(q.text))) continue;
          chosen.push(q);
        }
      }
      while (chosen.length < 2) chosen.push({ text: fillers[f++ % fillers.length], authorId: null, source: "filler" });
      entries[p.id] = { quotes: chosen.map((c) => ({ text: c.text, authorId: c.authorId })), answer: null };
    }
    this.r3 = { entries, order: order.map((p) => p.id), slots: null, votes: {}, results: null };
  }

  finalizeRound3Writing() {
    // Opaque, shuffled slot ids so nobody can map an entry to its author.
    const shuffled = shuffle(this.r3.order, this.rng);
    this.r3.slots = shuffled.map((pid, i) => ({ id: `e${i}`, authorId: pid }));
  }

  scoreRound3() {
    const units = {}, firsts = {}, seconds = {};
    for (const slot of this.r3.slots) { units[slot.authorId] = 0; firsts[slot.authorId] = 0; seconds[slot.authorId] = 0; }
    const slotAuthor = (slotId) => { const s = this.r3.slots.find((x) => x.id === slotId); return s ? s.authorId : null; };
    for (const v of Object.values(this.r3.votes)) {
      const a1 = slotAuthor(v.first);
      if (a1) { units[a1] += 2; firsts[a1]++; }
      const a2 = v.second ? slotAuthor(v.second) : null;
      if (a2) { units[a2] += 1; seconds[a2]++; }
    }
    const results = this.r3.slots.map((slot) => {
      const e = this.r3.entries[slot.authorId];
      const pts = units[slot.authorId] * SCORING.r3Unit;
      this.players.get(slot.authorId).score += pts;
      return {
        slotId: slot.id, authorId: slot.authorId, text: e.answer || NO_ANSWER, quotes: e.quotes,
        units: units[slot.authorId], firsts: firsts[slot.authorId], seconds: seconds[slot.authorId], points: pts,
      };
    });
    results.sort((x, y) => y.units - x.units || y.firsts - x.firsts);
    this.announcer = pick(ANNOUNCER.finalWinner, this.rng);
    this.r3.results = results;
  }

  // ── final ──────────────────────────────────────────────────────────────────
  standings() {
    const list = this.playerList().slice().sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
    const out = [];
    let place = 0, prevScore = null;
    list.forEach((p, i) => {
      if (p.score !== prevScore) { place = i + 1; prevScore = p.score; }
      out.push({ id: p.id, name: p.name, emoji: p.emoji, color: p.color, score: p.score, place, connected: p.connected });
    });
    return out;
  }

  buildFinal() {
    const standings = this.standings();
    const awards = [];
    const best = (key, title, blurb) => {
      let max = 0, who = [];
      for (const p of this.players.values()) {
        const v = p.stats[key];
        if (v > max) { max = v; who = [p]; } else if (v === max && v > 0) who.push(p);
      }
      if (max > 0) awards.push({ title, blurb: blurb(max), players: who.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, color: p.color })) });
    };
    best("lieVotes", "SMOOTHEST LIAR", (n) => `fooled ${n} ${n === 1 ? "vote" : "votes"} with fake dirt`);
    best("truthHits", "HUMAN LIE DETECTOR", (n) => `sniffed out the truth ${n} ${n === 1 ? "time" : "times"}`);
    best("fooled", "TOO WILD TO BELIEVE", (n) => `told the truth and ${n} ${n === 1 ? "person" : "people"} didn't buy it`);
    best("plants", "MASTER GARDENER", (n) => `planted ${n} secret ${n === 1 ? "word" : "words"} and scored`);
    const top = this.r3 && this.r3.results && this.r3.results.length ? this.r3.results[0] : null;
    const topStory = top && top.text ? { text: top.text, author: this.publicPlayer(top.authorId) } : null;
    const headlines = this.bestHeadlines(5);
    return { standings, awards, topStory, headlines };
  }

  // Highest-voted round-1 answers, for the closing front page.
  bestHeadlines(limit) {
    const out = [];
    if (!this.r1) return out;
    for (const m of this.r1.matchups) {
      if (!m.result) continue;
      for (const pid of [m.a, m.b]) {
        const text = m.answers[pid];
        if (!text) continue;
        out.push({ prompt: m.prompt, text, author: this.publicPlayer(pid), votes: m.result.tally[pid] });
      }
    }
    out.sort((x, y) => y.votes - x.votes);
    return out.slice(0, limit);
  }

  // ── submissions ────────────────────────────────────────────────────────────
  submitWrite(playerId, key, rawText) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: "You're not a player in this game." };
    if (typeof key !== "string") return { ok: false, error: "Bad submission." };
    this.touch();
    switch (this.phase) {
      case "r1_write": {
        const m = this.r1.byId[key];
        if (!m || !(playerId in m.answers)) return { ok: false, error: "That isn't your headline." };
        if (m.answers[playerId] !== null) return { ok: true, duplicate: true };
        m.answers[playerId] = cleanText(rawText, LIMITS.headline);
        break;
      }
      case "r2_write": {
        if (key === "truth") {
          const s = this.r2.subjects.find((x) => x.subjectId === playerId);
          if (s.truth !== null) return { ok: true, duplicate: true };
          s.truth = cleanText(rawText, LIMITS.truth);
        } else if (key.startsWith("lie:")) {
          const s = this.r2.subjects.find((x) => x.id === key.slice(4));
          if (!s || !s.liars.includes(playerId)) return { ok: false, error: "That isn't your lie to tell." };
          if (s.lies[playerId] !== null) return { ok: true, duplicate: true };
          s.lies[playerId] = cleanText(rawText, LIMITS.lie);
        } else return { ok: false, error: "Bad submission." };
        break;
      }
      case "r3_write": {
        if (key !== "final") return { ok: false, error: "Bad submission." };
        const e = this.r3.entries[playerId];
        if (e.answer !== null) return { ok: true, duplicate: true };
        e.answer = cleanText(rawText, LIMITS.final);
        break;
      }
      default:
        return { ok: false, error: "Not accepting answers right now." };
    }
    this.onSound("submit");
    this.onUpdate(this);
    this.maybeAdvance();
    return { ok: true };
  }

  submitVote(voterId, payload) {
    if (!payload || typeof payload !== "object") return { ok: false, error: "Bad vote." };
    this.touch();
    switch (this.phase) {
      case "r1_vote": {
        const m = this.r1.matchups[this.r1.current];
        if (payload.matchupId !== m.id) return { ok: false, error: "That vote is for a different matchup." };
        if (!this.isVoterAllowed(voterId, new Set([m.a, m.b]))) return { ok: false, error: "You can't vote on your own headline." };
        const authorId = m.slots[payload.choice];
        if (!authorId) return { ok: false, error: "Bad vote." };
        if (voterId in m.votes) return { ok: true, duplicate: true };
        m.votes[voterId] = authorId;
        break;
      }
      case "r2_vote": {
        const s = this.r2.active[this.r2.current];
        if (payload.subjectId !== s.id) return { ok: false, error: "That vote is for a different story." };
        if (!this.isVoterAllowed(voterId, new Set([s.subjectId]))) return { ok: false, error: "You can't vote on your own confession." };
        if (!s.options.some((o) => o.id === payload.choice)) return { ok: false, error: "Bad vote." };
        if (voterId in s.votes) return { ok: true, duplicate: true };
        s.votes[voterId] = payload.choice;
        break;
      }
      case "r3_vote": {
        if (!this.isVoterAllowed(voterId, new Set())) return { ok: false, error: "You're not in this game." };
        const mine = this.r3.slots.find((s) => s.authorId === voterId);
        const allowed = this.r3.slots.filter((s) => s.authorId !== voterId).map((s) => s.id);
        const first = payload.first, second = payload.second == null ? null : payload.second;
        if (!allowed.includes(first)) return { ok: false, error: "Bad vote." };
        if (mine && (first === mine.id || second === mine.id)) return { ok: false, error: "You can't vote for yourself." };
        if (allowed.length >= 2) {
          if (!allowed.includes(second) || second === first) return { ok: false, error: "Pick a different runner-up." };
        } else if (second !== null) return { ok: false, error: "Bad vote." };
        if (voterId in this.r3.votes) return { ok: true, duplicate: true };
        this.r3.votes[voterId] = { first, second };
        break;
      }
      default:
        return { ok: false, error: "Not accepting votes right now." };
    }
    this.onSound("vote");
    this.onUpdate(this);
    this.maybeAdvance();
    return { ok: true };
  }

  react(id, emoji) {
    if (!REACTIONS.includes(emoji)) return { ok: false };
    const who = this.players.get(id) || this.audience.get(id);
    if (!who) return { ok: false };
    const now = this.now();
    if (who.lastReaction && now - who.lastReaction < 600) return { ok: false, error: "Slow down." };
    who.lastReaction = now;
    this.onReaction(this, { emoji, name: who.name, color: who.color || "#888" });
    return { ok: true };
  }

  // ── views ──────────────────────────────────────────────────────────────────
  publicPlayer(id) {
    const p = this.players.get(id);
    if (!p) return null;
    return { id: p.id, name: p.name, emoji: p.emoji, color: p.color, score: p.score, connected: p.connected, isVip: p.isVip };
  }

  publicPlayers() {
    return this.playerList().map((p) => this.publicPlayer(p.id));
  }

  hostView() {
    const v = {
      code: this.code,
      phase: this.phase,
      round: this.round,
      endsAt: this.timer.endsAt,
      serverNow: this.now(),
      players: this.publicPlayers(),
      audienceCount: this.audience.size,
      audienceConnected: this.connectedAudience().length,
      announcer: this.announcer,
      gamesPlayed: this.gamesPlayed,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      hostConnected: this.hostConnected,
    };
    const phase = this.phase;
    if (phase.endsWith("_intro")) v.intro = ROUND_INFO[this.round];
    if (phase === "r1_write" || phase === "r2_write" || phase === "r3_write") {
      const pending = new Set(this.pendingParticipants().map((p) => p.id));
      v.write = { doneIds: this.playerList().filter((p) => !pending.has(p.id) && p.connected).map((p) => p.id), round: this.round };
    }
    if (phase === "r1_vote" || phase === "r1_reveal") {
      const m = this.r1.matchups[this.r1.current];
      const slotView = (slot) => {
        const pid = m.slots[slot];
        return { slot, text: m.answers[pid] || "", blank: !m.answers[pid] };
      };
      v.matchup = {
        id: m.id, index: this.r1.current + 1, count: this.r1.matchups.length,
        prompt: m.prompt, subject: m.subjectId ? this.publicPlayer(m.subjectId) : null,
        slots: [slotView("A"), slotView("B")],
        votesIn: Object.keys(m.votes).length,
        votersTotal: this.eligibleVoters(new Set([m.a, m.b])).length,
      };
      if (phase === "r1_reveal" && m.result) {
        v.matchup.slots = v.matchup.slots.map((sv) => {
          const pid = m.slots[sv.slot];
          return {
            ...sv, author: this.publicPlayer(pid), votes: m.result.tally[pid],
            voters: m.result.voters[pid].map((vid) => this.voterName(vid)),
            points: m.result.points[pid], bonuses: m.result.bonuses[pid],
            plant: m.plants[pid], winner: m.result.winner === pid,
          };
        });
        v.matchup.total = m.result.total;
        v.matchup.tie = m.result.total > 0 && !m.result.winner;
      }
    }
    if (phase === "r2_vote" || phase === "r2_reveal") {
      const s = this.r2.active[this.r2.current];
      v.subject = {
        id: s.id, index: this.r2.current + 1, count: this.r2.active.length,
        prompt: s.prompt, subject: this.publicPlayer(s.subjectId),
        options: s.options.map((o) => ({ id: o.id, text: o.text })),
        votesIn: Object.keys(s.votes).length,
        votersTotal: this.eligibleVoters(new Set([s.subjectId])).length,
      };
      if (phase === "r2_reveal" && s.result) {
        v.subject.options = s.options.map((o) => ({
          id: o.id, text: o.text, isTruth: o.isTruth, decoy: o.decoy,
          author: this.publicPlayer(o.authorId),
          voters: s.result.perOption[o.id].voters.map((vid) => this.voterName(vid)),
          points: s.result.perOption[o.id].points,
        }));
        v.subject.found = s.result.found;
        v.subject.fooled = s.result.fooled;
      }
    }
    if (phase === "r1_scores" || phase === "r2_scores") v.scores = this.standings();
    if (phase === "r3_write") {
      v.r3 = { hint: "Everyone is connecting two scandals from tonight." };
    }
    if (phase === "r3_vote") {
      v.r3 = {
        entries: this.r3.slots.map((s) => ({ id: s.id, text: this.r3.entries[s.authorId].answer || "", quotes: this.r3.entries[s.authorId].quotes.map((q) => q.text) })),
        votesIn: Object.keys(this.r3.votes).length,
        votersTotal: this.eligibleVoters(new Set()).length,
      };
    }
    if (phase === "r3_reveal") {
      v.r3 = {
        results: this.r3.results.map((r) => ({
          id: r.slotId, text: r.text, quotes: r.quotes.map((q) => q.text), author: this.publicPlayer(r.authorId),
          units: r.units, firsts: r.firsts, seconds: r.seconds, points: r.points,
        })),
      };
    }
    if (phase === "final") v.final = this.final;
    return v;
  }

  voterName(id) {
    const p = this.players.get(id);
    if (p) return { name: p.name, emoji: p.emoji, color: p.color };
    const a = this.audience.get(id);
    if (a) return { name: a.name, emoji: "🎟️", color: "#777" };
    return { name: "?", emoji: "", color: "#777" };
  }

  playerView(id) {
    const p = this.players.get(id);
    const a = p ? null : this.audience.get(id);
    if (!p && !a) return null;
    const base = {
      code: this.code, phase: this.phase, round: this.round, endsAt: this.timer.endsAt, serverNow: this.now(),
      players: this.publicPlayers(),
      you: p
        ? { id: p.id, name: p.name, emoji: p.emoji, color: p.color, score: p.score, isVip: p.isVip, role: "player", place: this.placeOf(p.id) }
        : { id: a.id, name: a.name, emoji: "🎟️", color: "#777", score: 0, isVip: false, role: "audience", place: null },
      task: null,
    };
    base.task = p ? this.playerTask(p) : this.audienceTask(a);
    return base;
  }

  placeOf(id) {
    const s = this.standings().find((x) => x.id === id);
    return s ? s.place : null;
  }

  waitTask(message, extra = {}) { return { type: "wait", message, ...extra }; }

  playerTask(p) {
    switch (this.phase) {
      case "lobby":
        return {
          type: "lobby", isVip: p.isVip, playerCount: this.players.size, minPlayers: MIN_PLAYERS,
          canStart: p.isVip && this.connectedPlayers().length >= MIN_PLAYERS,
        };
      case "r1_intro": case "r2_intro": case "r3_intro":
        return this.waitTask("Eyes on the TV. Rules incoming.", { intro: ROUND_INFO[this.round] });
      case "r1_write": {
        const items = this.r1.assignments[p.id].map((mid) => {
          const m = this.r1.byId[mid];
          return { key: mid, prompt: m.prompt, plantWord: m.plants[p.id], maxLen: LIMITS.headline, done: m.answers[p.id] !== null };
        });
        if (items.every((i) => i.done)) return this.waitTask("Filed. Waiting on the slowpokes.");
        return { type: "write", kind: "headline", items };
      }
      case "r1_vote": {
        const m = this.r1.matchups[this.r1.current];
        if (p.id === m.a || p.id === m.b) return this.waitTask("You're in this one. Look innocent.", { spotlight: true });
        return {
          type: "vote", voteId: m.id, kind: "headline", prompt: m.prompt,
          options: ["A", "B"].map((slot) => ({ id: slot, text: m.answers[m.slots[slot]] || "(no answer)" })),
          picked: m.votes[p.id] ? Object.keys(m.slots).find((k) => m.slots[k] === m.votes[p.id]) : null,
        };
      }
      case "r1_reveal":
        return this.waitTask("Results on the TV!", { score: p.score });
      case "r1_scores": case "r2_scores":
        return this.waitTask("Scores on the TV.", { score: p.score });
      case "r2_write": {
        const items = [];
        const mine = this.r2.subjects.find((s) => s.subjectId === p.id);
        items.push({ key: "truth", label: "CONFESS — this one must be TRUE", prompt: mine.prompt, maxLen: LIMITS.truth, done: mine.truth !== null, truth: true });
        for (const s of this.r2.subjects) {
          if (!s.liars.includes(p.id)) continue;
          const subj = this.players.get(s.subjectId);
          items.push({ key: `lie:${s.id}`, label: `LIE — write a convincing fake for ${subj.name}`, prompt: s.prompt, maxLen: LIMITS.lie, done: s.lies[p.id] !== null, truth: false });
        }
        if (items.every((i) => i.done)) return this.waitTask("Filed. Waiting on the slowpokes.");
        return { type: "write", kind: "confession", items };
      }
      case "r2_vote": {
        const s = this.r2.active[this.r2.current];
        if (p.id === s.subjectId) return this.waitTask("This one's about you. Poker face.", { spotlight: true });
        return {
          type: "vote", voteId: s.id, kind: "truth", prompt: s.prompt,
          options: s.options.map((o) => ({ id: o.id, text: o.text })),
          picked: s.votes[p.id] || null,
        };
      }
      case "r2_reveal":
        return this.waitTask("The truth comes out on the TV.", { score: p.score });
      case "r3_write": {
        const e = this.r3.entries[p.id];
        if (e.answer !== null) return this.waitTask("Filed. Waiting on the slowpokes.");
        return {
          type: "write", kind: "connect",
          items: [{ key: "final", prompt: "Write the headline that connects these two scandals:", quotes: e.quotes.map((q) => q.text), maxLen: LIMITS.final, done: false }],
        };
      }
      case "r3_vote": {
        const options = this.r3.slots.filter((s) => s.authorId !== p.id).map((s) => ({ id: s.id, text: this.r3.entries[s.authorId].answer || "(no answer)" }));
        return { type: "rank", voteId: "r3", options, needSecond: options.length >= 2, picked: this.r3.votes[p.id] || null };
      }
      case "r3_reveal":
        return this.waitTask("Tonight's top story, on the TV.", { score: p.score });
      case "final":
        return { type: "final", place: this.placeOf(p.id), score: p.score, isVip: p.isVip, standings: this.standings() };
      default:
        return this.waitTask("Look at the TV.");
    }
  }

  audienceTask(a) {
    switch (this.phase) {
      case "lobby":
        return { type: "audience_lobby", message: "You're in the audience for now. You'll be a player when the next game starts." };
      case "r1_vote": {
        const m = this.r1.matchups[this.r1.current];
        return {
          type: "vote", voteId: m.id, kind: "headline", prompt: m.prompt,
          options: ["A", "B"].map((slot) => ({ id: slot, text: m.answers[m.slots[slot]] || "(no answer)" })),
          picked: m.votes[a.id] ? Object.keys(m.slots).find((k) => m.slots[k] === m.votes[a.id]) : null,
        };
      }
      case "r2_vote": {
        const s = this.r2.active[this.r2.current];
        return {
          type: "vote", voteId: s.id, kind: "truth", prompt: s.prompt,
          options: s.options.map((o) => ({ id: o.id, text: o.text })), picked: s.votes[a.id] || null,
        };
      }
      case "r3_vote": {
        const options = this.r3.slots.map((s) => ({ id: s.id, text: this.r3.entries[s.authorId].answer || "(no answer)" }));
        return { type: "rank", voteId: "r3", options, needSecond: options.length >= 2, picked: this.r3.votes[a.id] || null };
      }
      case "final":
        return { type: "final", place: null, score: 0, isVip: false, standings: this.standings() };
      default:
        return this.waitTask("You're in the audience. Watch the TV — you vote in every round.");
    }
  }
}

function freshStats() {
  return { lieVotes: 0, truthHits: 0, fooled: 0, plants: 0 };
}
