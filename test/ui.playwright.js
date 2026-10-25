// End-to-end browser test: a TV and three phones play a whole game through the real UI.
// Run with: node test/ui.playwright.js   (writes screenshots to test/screenshots/)
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, sleep } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Playwright is provided by the environment (global install), so resolve it the CommonJS way.
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const shots = path.join(here, "screenshots");
fs.mkdirSync(shots, { recursive: true });
const PHONES = ["Kyle", "Sam", "Jo"];
const errors = [];
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

function assert(cond, msg) { if (!cond) throw new Error(`ASSERT: ${msg}`); }

async function shot(page, name) { await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false }); }

// A vote is accepted when the phone shows the lock-in note, or the game has already moved on.
async function voteAccepted(page) {
  await page.waitForFunction(() => document.querySelector(".locked-note") || !document.querySelector(".opt") || document.querySelector(".big-msg"), null, { timeout: 5000 });
}

async function main() {
  const server = await startServer({ timerScale: 0.8 });
  const browser = await chromium.launch();
  const tvCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const tv = await tvCtx.newPage();
  tvForDebug = tv;
  const wire = (page, label) => {
    page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${label} console: ${m.text()}`); });
  };
  wire(tv, "tv");
  await tv.goto(`${server.url}/host`);
  await tv.waitForSelector(".join-panel .code");
  const code = (await tv.textContent(".join-panel .code")).trim();
  assert(/^[A-Z]{4}$/.test(code), `room code on TV: ${code}`);
  assert(await tv.locator(".join-panel .qr svg").count() === 1, "QR rendered");
  await shot(tv, "01-tv-lobby-empty");

  const phones = [];
  for (const name of PHONES) {
    const ctx = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await ctx.newPage();
    wire(page, name);
    await page.goto(`${server.url}/?code=${code}`);
    await page.waitForSelector("#name");
    assert((await page.inputValue("#code")) === code, "code prefilled from URL");
    await page.fill("#name", name);
    if (name === "Kyle") await shot(page, "02-phone-join");
    await page.click("button[type=submit]");
    await page.waitForSelector(".me .nm");
    phones.push({ name, page, ctx });
  }
  await tv.waitForFunction(() => document.querySelectorAll(".roster .players .badge").length === 3);
  await shot(tv, "03-tv-lobby-full");
  await shot(phones[0].page, "04-phone-lobby-vip");
  assert(await phones[1].page.locator(".btn.big").count() === 0, "non-VIP has no start button");

  // Phone reload keeps the seat.
  await phones[2].page.reload();
  await phones[2].page.waitForSelector(".me .nm");
  assert((await phones[2].page.textContent(".me .nm")).trim() === "Jo", "rejoined as Jo after reload");

  // VIP starts.
  await phones[0].page.click("button.btn.big.yellow");
  await tv.waitForSelector(".intro .title");
  await sleep(1500);
  await shot(tv, "05-tv-intro-r1");
  await shot(phones[1].page, "06-phone-intro-wait");
  await tv.click("#btn-skip");

  // Round 1 writing.
  await tv.waitForSelector(".write .roster-status");
  for (const p of phones) await p.page.waitForSelector("textarea");
  await shot(phones[0].page, "07-phone-write-r1");
  await shot(tv, "08-tv-write-r1");
  for (const p of phones) {
    for (let i = 0; i < 2; i++) {
      await p.page.waitForSelector("textarea");
      const plant = (await p.page.textContent(".plant .word")).trim();
      await p.page.fill("textarea", i === 0 ? `${p.name} blames the ${plant}` : `${p.name} says: a very long answer about nothing in particular, honestly`);
      await p.page.click("button.btn.big");
      await p.page.waitForFunction((prev) => { const ta = document.querySelector("textarea"); return !ta || ta.value === ""; }, null);
    }
  }
  // All filed -> voting starts without waiting for the timer.
  await tv.waitForSelector(".matchup", { timeout: 5000 });
  await shot(tv, "09-tv-matchup-vote");

  for (let m = 0; m < 3; m++) {
    await tv.waitForSelector(".matchup .answers");
    log(`matchup ${m}: on TV`);
    // Exactly one phone is a voter; the two authors wait. Capture the authors first so the vote is the last thing that happens.
    const voters = [], authors = [];
    for (const p of phones) {
      await p.page.waitForFunction(() => document.querySelector(".opt") || document.querySelector(".spotlight"), null, { timeout: 5000 });
      if ((await p.page.locator(".opt").count()) > 0) voters.push(p); else authors.push(p);
    }
    assert(voters.length === 1, `one voter per matchup with 3 players (got ${voters.length})`);
    if (m === 0) { await shot(authors[0].page, "11-phone-spotlight"); await shot(voters[0].page, "10-phone-vote-r1"); }
    await voters[0].page.locator(".opt").first().click();
    log(`matchup ${m}: ${voters[0].name} voted`);
    await voteAccepted(voters[0].page);
    await tv.waitForSelector(".matchup .reveal-zone", { timeout: 5000 });
    log(`matchup ${m}: reveal on TV`);
    await sleep(3600); // let the reveal animation play
    if (m === 0) await shot(tv, "12-tv-matchup-reveal");
    await tv.click("#btn-skip");
    await tv.waitForFunction(() => !document.querySelector(".matchup .reveal-zone"));
  }
  await tv.waitForSelector(".scores");
  await sleep(800);
  await shot(tv, "13-tv-scores-r1");
  await tv.click("#btn-skip");

  // Round 2.
  await tv.waitForSelector(".intro .title");
  await sleep(1500);
  await shot(tv, "14-tv-intro-r2");
  await tv.click("#btn-skip");
  for (const p of phones) await p.page.waitForSelector("textarea");
  await shot(phones[0].page, "15-phone-confess");
  for (const p of phones) {
    for (let i = 0; i < 3; i++) {
      await p.page.waitForSelector("textarea");
      const pill = (await p.page.textContent(".label-pill")).toLowerCase();
      if (i === 1 && p.name === "Kyle") await shot(p.page, "16-phone-lie");
      await p.page.fill("textarea", pill.includes("confess") ? `${p.name} once ate a crayon` : `${p.name} fakes it ${i}`);
      await p.page.click("button.btn.big");
      await p.page.waitForFunction(() => { const ta = document.querySelector("textarea"); return !ta || ta.value === ""; });
    }
  }
  await tv.waitForSelector(".subject", { timeout: 5000 });
  await shot(tv, "17-tv-subject-vote");
  for (let s = 0; s < 3; s++) {
    await tv.waitForSelector(".subject .options");
    let voted = 0;
    for (const p of phones) {
      const opt = p.page.locator(".opt");
      if ((await opt.count()) > 0) { if (s === 0) await shot(p.page, "18-phone-vote-truth"); await opt.nth(1).click(); await voteAccepted(p.page); voted++; }
    }
    assert(voted === 2, `two voters per confession (got ${voted})`);
    await tv.waitForSelector(".subject .reveal-zone", { timeout: 5000 });
    await sleep(5200);
    if (s === 0) await shot(tv, "19-tv-subject-reveal");
    await tv.click("#btn-skip");
    await tv.waitForFunction(() => !document.querySelector(".subject .reveal-zone"));
  }
  await tv.waitForSelector(".scores");
  await tv.click("#btn-skip");

  // Round 3.
  await tv.waitForSelector(".intro .title");
  await tv.click("#btn-skip");
  for (const p of phones) await p.page.waitForSelector("textarea");
  await shot(phones[0].page, "20-phone-connect");
  for (const p of phones) {
    const quotes = await p.page.locator(".quote").count();
    assert(quotes === 2, `two quotes on ${p.name}'s phone`);
    await p.page.fill("textarea", `${p.name.toUpperCase()} LINKS THE TWO SCANDALS IN A SHOCKING EXPOSÉ`);
    await p.page.click("button.btn.big");
  }
  await tv.waitForSelector(".r3 .entries", { timeout: 5000 });
  await shot(tv, "21-tv-r3-vote");
  for (const p of phones) {
    await p.page.waitForSelector(".opt");
    await p.page.locator(".opt").nth(0).click();
    await p.page.locator(".opt").nth(1).click();
    if (p.name === "Kyle") await shot(p.page, "22-phone-rank");
    await p.page.click("button.btn.big");
    await p.page.waitForSelector(".big-msg");
  }
  await tv.waitForSelector(".r3 .results", { timeout: 5000 });
  await sleep(3500);
  await shot(tv, "23-tv-r3-reveal");
  await tv.click("#btn-skip");
  await tv.waitForSelector(".final .winner-box", { timeout: 5000 });
  await sleep(1500);
  await shot(tv, "24-tv-final");
  for (const p of phones) await p.page.waitForSelector(".standings");
  await shot(phones[0].page, "25-phone-final");

  // Reactions from a phone show up on the TV.
  await phones[1].page.locator(".reactions button").first().click();
  await tv.waitForSelector(".reaction", { timeout: 3000 });

  // Play again from the TV.
  await tv.click(".final .again .btn");
  await tv.waitForSelector(".lobby");
  for (const p of phones) await p.page.waitForSelector(".me .nm");
  const scores = await tv.locator(".roster .players .badge").count();
  assert(scores === 3, "same three players back in the lobby");

  await browser.close();
  await server.stop();
  if (errors.length) { console.error("Browser errors:\n" + errors.join("\n")); process.exit(1); }
  console.log(`UI test passed. Screenshots in ${shots}`);
}

let tvForDebug = null;
main().catch(async (err) => {
  console.error(err);
  if (errors.length) console.error("Browser errors:\n" + errors.join("\n"));
  if (tvForDebug) { try { await shot(tvForDebug, "99-failure-tv"); console.error(await tvForDebug.evaluate(() => document.querySelector("#stage").innerHTML.slice(0, 3000))); } catch (e) { /* ignore */ } }
  process.exit(1);
});
