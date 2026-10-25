import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as connect } from "socket.io-client";
import { startServer, waitFor, sleep } from "./helpers.js";

let server;
const clients = [];
before(async () => { server = await startServer({ timerScale: 0.03 }); });
after(async () => {
  for (const c of clients) { try { c.disconnect(); } catch (e) { /* ignore */ } }
  if (server) await server.stop();
});

function client() {
  const s = connect(server.url, { transports: ["websocket"], forceNew: true, reconnectionDelay: 100 });
  clients.push(s);
  s.latest = null;
  s.on("player:state", (st) => { s.latest = st; });
  s.on("host:state", (st) => { s.latest = st; });
  s.emitAsync = (ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));
  return s;
}

const connected = (s) => new Promise((r) => (s.connected ? r() : s.once("connect", r)));

test("full game over real sockets with reconnection, audience and host reclaim", async () => {
  const host = client();
  await connected(host);
  const created = await host.emitAsync("host:create", {});
  assert.equal(created.ok, true);
  assert.match(created.code, /^[A-Z]{4}$/);
  assert.ok(created.qr.startsWith("<svg"), "qr svg present");
  assert.ok(created.joinUrl.endsWith(`/?code=${created.code}`));
  await waitFor(() => host.latest && host.latest.phase === "lobby", { label: "lobby state" });

  const names = ["Kyle", "Sam", "Jo", "Alex"];
  const players = [];
  for (const name of names) {
    const c = client();
    await connected(c);
    const res = await c.emitAsync("player:join", { code: created.code.toLowerCase(), name });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.role, "player");
    assert.equal(res.state.task.type, "lobby");
    players.push({ socket: c, id: res.playerId, token: res.token, name });
  }
  await waitFor(() => host.latest.players.length === 4, { label: "4 players on host" });

  // Bad joins.
  const stranger = client();
  await connected(stranger);
  assert.equal((await stranger.emitAsync("player:join", { code: "ZZZZ", name: "x" })).ok, false);
  assert.equal((await stranger.emitAsync("player:join", { code: created.code, name: "" })).ok, false);
  assert.equal((await stranger.emitAsync("player:join", { code: "toolong", name: "x" })).ok, false);
  assert.equal((await stranger.emitAsync("player:write", { key: "x", text: "y" })).ok, false, "not in a room");
  assert.equal((await stranger.emitAsync("host:start", {})).ok, false, "not the host");

  // Non-VIP can't start; VIP can.
  assert.equal((await players[1].socket.emitAsync("player:start", {})).ok, false);
  assert.equal((await players[0].socket.emitAsync("player:start", {})).ok, true);
  await waitFor(() => host.latest.phase === "r1_intro", { label: "intro" });
  assert.ok(host.latest.intro.title);

  // Late joiner becomes audience.
  const audRes = await stranger.emitAsync("player:join", { code: created.code, name: "Latecomer" });
  assert.equal(audRes.role, "audience");

  // Host reclaim: a second host socket with the token takes over the same room.
  const host2 = client();
  await connected(host2);
  const replacedPromise = new Promise((r) => { host.once("host:replaced", () => r(true)); setTimeout(() => r(false), 2000); });
  const reclaimed = await host2.emitAsync("host:create", { hostToken: created.hostToken });
  assert.equal(reclaimed.code, created.code);
  assert.equal(await replacedPromise, true, "old host told it was replaced");
  await waitFor(() => host2.latest && host2.latest.phase, { label: "host2 state" });
  const tv = host2;
  assert.equal((await host.emitAsync("host:next", {})).ok, false, "old host lost control");

  const stats = { writes: 0, votes: 0 };
  const seen = new Set();
  const deadline = Date.now() + 60000;
  while (tv.latest.phase !== "final" && Date.now() < deadline) {
    const phase = tv.latest.phase;
    seen.add(phase);
    if (/_(intro|reveal|scores)$/.test(phase)) {
      const r = await tv.emitAsync("host:next", {});
      assert.equal(r.ok, true, `skip failed in ${phase}: ${r.error}`);
      await waitFor(() => tv.latest.phase !== phase, { label: `leave ${phase}` });
      continue;
    }
    if (phase.endsWith("_write")) {
      for (const p of players) {
        await waitFor(() => p.socket.latest && p.socket.latest.phase === phase, { label: `${p.name} sees ${phase}` });
        const task = p.socket.latest.task;
        if (task.type !== "write") continue;
        for (const item of task.items) {
          if (item.done) continue;
          const text = phase === "r1_write" ? `${p.name} wrote ${item.plantWord}` : phase === "r2_write" ? (item.truth ? `${p.name} truth` : `${p.name} lie about ${item.key}`) : `${p.name} connects`;
          const r = await p.socket.emitAsync("player:write", { key: item.key, text });
          assert.equal(r.ok, true, r.error);
          stats.writes++;
        }
      }
      await waitFor(() => tv.latest.phase !== phase, { label: `leave ${phase}` });
      continue;
    }
    if (phase.endsWith("_vote")) {
      // Simulate a phone going to sleep and coming back mid-vote.
      if (phase === "r1_vote" && !seen.has("reconnected")) {
        seen.add("reconnected");
        const p = players[2];
        p.socket.disconnect();
        await waitFor(() => tv.latest.players.find((x) => x.id === p.id).connected === false, { label: "player offline" });
        p.socket.connect();
        await connected(p.socket);
        const rj = await p.socket.emitAsync("player:rejoin", { code: created.code, playerId: p.id, token: p.token });
        assert.equal(rj.ok, true);
        assert.equal(rj.state.phase, tv.latest.phase);
        p.socket.latest = rj.state;
        await waitFor(() => tv.latest.players.find((x) => x.id === p.id).connected === true, { label: "player back" });
      }
      for (const p of [...players, { socket: stranger, name: "Latecomer" }]) {
        if (tv.latest.phase !== phase) break;
        await waitFor(() => p.socket.latest && p.socket.latest.phase === phase, { label: `${p.name} sees ${phase}`, timeout: 4000 }).catch(() => {});
        const task = p.socket.latest && p.socket.latest.task;
        if (!task) continue;
        if (task.type === "vote") {
          const payload = phase === "r1_vote" ? { matchupId: task.voteId, choice: task.options[0].id } : { subjectId: task.voteId, choice: task.options[0].id };
          const r = await p.socket.emitAsync("player:vote", payload);
          if (tv.latest.phase === phase) { assert.equal(r.ok, true, `${p.name} vote in ${phase}: ${r.error}`); stats.votes++; }
        } else if (task.type === "rank") {
          const r = await p.socket.emitAsync("player:vote", { first: task.options[0].id, second: task.needSecond ? task.options[1].id : null });
          if (tv.latest.phase === phase) { assert.equal(r.ok, true, r.error); stats.votes++; }
        }
      }
      await waitFor(() => tv.latest.phase !== phase, { label: `leave ${phase}`, timeout: 10000 });
      continue;
    }
    await sleep(20);
  }
  assert.equal(tv.latest.phase, "final");
  assert.ok(stats.writes >= 4 * 6, `writes ${stats.writes}`);
  assert.ok(stats.votes > 0);
  const final = tv.latest.final;
  assert.equal(final.standings.length, 4);
  assert.ok(final.topStory, "top story exists");
  for (const p of players) {
    await waitFor(() => p.socket.latest.phase === "final", { label: `${p.name} final` });
    assert.equal(p.socket.latest.task.type, "final");
  }
  await waitFor(() => stranger.latest && stranger.latest.phase === "final", { label: "audience final" });

  // Play again from the VIP phone; audience is promoted.
  assert.equal((await players[0].socket.emitAsync("player:playAgain", {})).ok, true);
  await waitFor(() => tv.latest.phase === "lobby", { label: "lobby again" });
  assert.equal(tv.latest.players.length, 5);
  await waitFor(() => stranger.latest.you.role === "player", { label: "audience promoted" });

  // Host removes a player from the lobby; that phone is told to forget its seat.
  const removedPromise = new Promise((r) => stranger.once("player:removed", () => r(true)));
  assert.equal((await tv.emitAsync("host:remove", { playerId: stranger.latest.you.id })).ok, true);
  assert.equal(await removedPromise, true);
  await waitFor(() => tv.latest.players.length === 4, { label: "player removed" });

  // Reactions reach the host.
  const reaction = new Promise((r) => tv.once("host:reaction", r));
  assert.equal((await players[1].socket.emitAsync("player:react", { emoji: "🔥" })).ok, true);
  const rx = await reaction;
  assert.equal(rx.emoji, "🔥");
  assert.equal(rx.name, "Sam");
  assert.equal((await players[1].socket.emitAsync("player:react", { emoji: "🍕" })).ok, false);

  for (const p of players) p.socket.disconnect();
  stranger.disconnect(); host.disconnect(); host2.disconnect();
});

test("rate limiter and payload hygiene", async () => {
  const host = client();
  await connected(host);
  const created = await host.emitAsync("host:create", {});
  const c = client();
  await connected(c);
  const res = await c.emitAsync("player:join", { code: created.code, name: "  Spammy\u0000  " });
  assert.equal(res.ok, true);
  assert.equal(res.state.you.name, "Spammy");
  // Hammer the server; some calls must be rejected but nothing crashes.
  const results = await Promise.all(Array.from({ length: 60 }, () => c.emitAsync("player:react", { emoji: "😂" })));
  assert.ok(results.some((r) => r && r.error === "Slow down."), "rate limited");
  await sleep(1100);
  const health = await fetch(`${server.url}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.ok(health.rooms >= 1);
  // Garbage payloads.
  assert.equal((await c.emitAsync("player:vote", "garbage")).ok, false);
  assert.equal((await c.emitAsync("player:write", { key: 42, text: { nested: true } })).ok, false);
  assert.equal((await c.emitAsync("player:join", null)).ok, false);
  c.disconnect(); host.disconnect();
});
