// Visual check for dense layouts: simulate a 9-player game in the engine, then render the
// TV page for each interesting phase via the debug hook and screenshot it.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Room, PRESENTATION_PHASES } from "../server/game.js";
import { makeRng } from "../server/util.js";
import { startServer } from "./helpers.js";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, "screenshots", "dense");
fs.mkdirSync(shots, { recursive: true });

const N = Number(process.env.DD_VISUAL_PLAYERS) || 9;
const NAMES = ["Kyle", "Sam", "Jo", "Alex", "Priya", "Marcus", "Dani", "Theo", "Lupe", "Max"];
const FUNNY = [
  "a lifetime supply of beige paint", "crying in a Costco parking lot", "an emotional-support cactus", "forty pounds of expired yogurt",
  "the world's saddest bounce house", "a very illegal birdhouse", "a pyramid scheme for ferrets", "a limo made of pool noodles",
  "the ghost of a vending machine", "sixteen identical cardigans", "his own surprise party, uninvited", "a suspiciously warm trophy",
];

function simulate() {
  let now = 1_700_000_000_000;
  const timers = new Map(); let hid = 0;
  const room = new Room("DENS", {
    rng: makeRng(99), now: () => now,
    setTimeout: (fn, ms) => { const id = ++hid; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const fire = () => { const [id, t] = Array.from(timers.entries()).sort((a, b) => a[1].at - b[1].at)[0]; now = t.at; timers.delete(id); t.fn(); };
  const ids = [];
  for (let i = 0; i < N; i++) ids.push(room.join(NAMES[i], `s${i}`).id);
  room.join("Audience1", "a1"); // rejected as player? no: lobby not full for N<10 -> becomes player. Keep N players only:
  if (room.players.size > N) { const extra = Array.from(room.players.values()).slice(N); for (const p of extra) room.players.delete(p.id); }
  const snaps = {};
  const snap = (name) => { if (!snaps[name]) snaps[name] = JSON.parse(JSON.stringify(room.hostView())); };
  snap("lobby");
  room.startGame();
  const rng = makeRng(7);
  let guard = 0;
  while (room.phase !== "final" && guard++ < 2000) {
    const phase = room.phase;
    if (phase.endsWith("_write")) {
      // Let two players be slow so the "typing" state shows, then snapshot, then finish.
      const list = Array.from(room.players.values());
      for (const p of list.slice(0, N - 2)) {
        const pv = room.playerView(p.id);
        if (pv.task.type !== "write") continue;
        for (const item of pv.task.items) if (!item.done) room.submitWrite(p.id, item.key, phase === "r1_write" && rng() < 0.4 ? `${FUNNY[Math.floor(rng() * FUNNY.length)]} with a ${item.plantWord}` : FUNNY[Math.floor(rng() * FUNNY.length)]);
      }
      snap(phase);
      for (const p of list.slice(N - 2)) {
        const pv = room.playerView(p.id);
        if (pv.task.type !== "write") continue;
        for (const item of pv.task.items) if (!item.done) room.submitWrite(p.id, item.key, FUNNY[Math.floor(rng() * FUNNY.length)]);
      }
      if (room.phase === phase) fire();
      continue;
    }
    if (phase.endsWith("_vote")) {
      const voters = Array.from(room.players.values());
      let count = 0;
      for (const v of voters) {
        if (room.phase !== phase) break;
        const pv = room.playerView(v.id);
        if (count === Math.floor(voters.length / 2)) snap(phase);
        if (pv.task.type === "vote") {
          const opts = pv.task.options;
          const choice = opts[Math.floor(rng() * opts.length)].id;
          room.submitVote(v.id, phase === "r1_vote" ? { matchupId: pv.task.voteId, choice } : { subjectId: pv.task.voteId, choice });
          count++;
        } else if (pv.task.type === "rank") {
          const o = pv.task.options.slice();
          const first = o.splice(Math.floor(rng() * o.length), 1)[0].id;
          const second = pv.task.needSecond ? o[Math.floor(rng() * o.length)].id : null;
          room.submitVote(v.id, { first, second });
          count++;
        }
      }
      if (room.phase === phase) fire();
      continue;
    }
    if (PRESENTATION_PHASES.has(phase)) { snap(phase); fire(); continue; }
    throw new Error(`unhandled ${phase}`);
  }
  snap("final");
  return snaps;
}

async function main() {
  const snaps = simulate();
  const server = await startServer({ timerScale: 1 });
  const browser = await chromium.launch();
  const errors = [];
  for (const size of [{ w: 1600, h: 900 }, { w: 1280, h: 720 }]) {
    const page = await browser.newPage({ viewport: { width: size.w, height: size.h } });
    page.on("pageerror", (e) => errors.push(`${size.w}: ${e.message}`));
    await page.goto(`${server.url}/host`);
    await page.waitForSelector(".join-panel .code");
    const card = { code: "DENS", joinUrl: `${server.url}/?code=DENS`, joinDisplay: "dailydirt.example.app", qr: "" };
    for (const [name, state] of Object.entries(snaps)) {
      await page.evaluate(([s, c]) => window.ddDebugRender(s, c), [state, card]);
      await page.waitForTimeout(name.endsWith("_reveal") || name === "final" ? 4500 : 400);
      await page.screenshot({ path: path.join(shots, `${size.w}-${N}p-${name}.png`) });
      // Nothing may paint over the footer: every stage child must end above it.
      const overflow = await page.evaluate(() => {
        const stage = document.querySelector("#stage");
        const footerTop = document.querySelector("#footer").getBoundingClientRect().top;
        const bad = [];
        stage.querySelectorAll("*").forEach((el) => { const r = el.getBoundingClientRect(); if (r.height > 0 && r.bottom > footerTop + 1 && getComputedStyle(el).position !== "fixed") bad.push(`${el.className || el.tagName}`); });
        return bad.slice(0, 5);
      });
      if (overflow.length) console.log(`  [${size.w}x${size.h}] ${name}: content below footer (clipped): ${overflow.join(", ")}`);
    }
    await page.close();
  }
  await browser.close();
  await server.stop();
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log(`Dense visual pass done (${N} players). Screenshots in ${shots}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
