// Smoke test against a deployed instance: node test/live.playwright.js https://your-app.example
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium, devices } = createRequire(import.meta.url)("playwright");
const base = (process.argv[2] || "").replace(/\/$/, "");
if (!base) { console.error("usage: node test/live.playwright.js <url>"); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, "screenshots", "live");
fs.mkdirSync(shots, { recursive: true });
const assert = (c, m) => { if (!c) throw new Error(`ASSERT: ${m}`); };
const errors = [];

const browser = await chromium.launch();
try {
  const tv = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  tv.on("pageerror", (e) => errors.push(`tv: ${e.message}`));
  await tv.goto(`${base}/host`, { waitUntil: "domcontentloaded" });
  await tv.waitForSelector(".join-panel .code", { timeout: 20000 });
  const code = (await tv.textContent(".join-panel .code")).trim();
  const shown = (await tv.textContent(".join-panel .url")).trim();
  assert(/^[A-Z]{4}$/.test(code), `code ${code}`);
  assert(shown === base.replace(/^https?:\/\//, ""), `join url shows ${shown}`);
  assert((await tv.locator(".join-panel .qr svg").count()) === 1, "QR present");
  console.log(`TV up: code ${code}, join at ${shown}`);

  const phones = [];
  for (const name of ["Kyle", "Sam", "Jo"]) {
    const page = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${name} console: ${m.text()}`); });
    await page.goto(`${base}/${code}`, { waitUntil: "domcontentloaded" }); // short join link redirects
    await page.waitForSelector("#name", { timeout: 20000 });
    assert((await page.inputValue("#code")) === code, "short link prefilled the code");
    await page.fill("#name", name);
    await page.click("button[type=submit]");
    try {
      await page.waitForSelector(".me .nm", { timeout: 20000 });
    } catch (e) {
      console.error(`${name} did not reach the lobby. toast="${await page.textContent("#toast")}" dot="${await page.getAttribute("#top-right .dot", "class")}" app=${(await page.innerHTML("#app")).slice(0, 400)}`);
      throw e;
    }
    phones.push({ name, page });
  }
  await tv.waitForFunction(() => document.querySelectorAll(".roster .players .badge").length === 3, null, { timeout: 15000 });
  await tv.screenshot({ path: path.join(shots, "live-lobby.png") });
  console.log("3 phones joined");

  await phones[0].page.click("button.btn.big.yellow");
  await tv.waitForSelector(".intro .title", { timeout: 15000 });
  await tv.click("#btn-skip");
  for (const p of phones) await p.page.waitForSelector("textarea", { timeout: 15000 });
  for (const p of phones) {
    for (let i = 0; i < 2; i++) {
      await p.page.waitForSelector("textarea");
      await p.page.fill("textarea", `${p.name}'s live answer ${i + 1}`);
      await p.page.click("button.btn.big");
      await p.page.waitForFunction(() => { const ta = document.querySelector("textarea"); return !ta || ta.value === ""; });
    }
  }
  await tv.waitForSelector(".matchup .answers", { timeout: 15000 });
  console.log("round 1 writing done, voting on TV");
  let voter = null;
  for (const p of phones) {
    await p.page.waitForFunction(() => document.querySelector(".opt") || document.querySelector(".spotlight"), null, { timeout: 10000 });
    if ((await p.page.locator(".opt").count()) > 0) voter = p;
  }
  assert(voter, "a voter exists");
  await voter.page.locator(".opt").first().click();
  await tv.waitForSelector(".matchup .reveal-zone", { timeout: 15000 });
  await tv.waitForTimeout(3500);
  await tv.screenshot({ path: path.join(shots, "live-reveal.png") });
  console.log("vote accepted, reveal shown on TV");

  // Phone reload keeps its seat on the live server too.
  await phones[1].page.reload({ waitUntil: "domcontentloaded" });
  await phones[1].page.waitForSelector(".big-msg, .spotlight, .opt, textarea", { timeout: 15000 });
  const name = await phones[1].page.textContent("#top-right .badge .name");
  assert(name.trim() === "Sam", `rejoined as Sam, got ${name}`);
  console.log("phone reload rejoined the same seat");
} finally {
  await browser.close();
}
if (errors.length) { console.error("Browser errors:\n" + errors.join("\n")); process.exit(1); }
console.log("LIVE SMOKE PASSED");
