import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Boot the real server on a free-ish port and wait for its banner.
export function startServer({ timerScale = 0.02, port = 4000 + Math.floor(Math.random() * 2000) } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "server", "index.js")], {
      env: { ...process.env, PORT: String(port), DD_TIMER_SCALE: String(timerScale) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes("on the presses")) {
        child.stdout.off("data", onData);
        resolve({ child, port, url: `http://localhost:${port}`, logs: () => out, stop: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); }) });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.once("exit", (code) => reject(new Error(`server exited early (${code}): ${out}`)));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000).unref();
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function waitFor(fn, { timeout = 8000, interval = 25, label = "condition" } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - start > timeout) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, interval);
    };
    tick();
  });
}
