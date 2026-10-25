import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server as SocketServer } from "socket.io";
import QRCode from "qrcode";
import { Room, REACTIONS } from "./game.js";
import { cleanText } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const TIMER_SCALE = Math.max(0.01, Number(process.env.DD_TIMER_SCALE) || 1);
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const ROOM_IDLE_MS = 15 * 60 * 1000;      // empty rooms are removed after 15 minutes
const ROOM_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_ROOMS = 500;
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels: no accidental words

// ── rooms ─────────────────────────────────────────────────────────────────────
const rooms = new Map();          // code -> Room
const roomsByHostToken = new Map(); // hostToken -> Room

function makeCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function normalizeCode(raw) {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{4}$/.test(code) ? code : null;
}

function destroyRoom(room) {
  room.clearTimer();
  rooms.delete(room.code);
  roomsByHostToken.delete(room.hostToken);
  if (room.hostSocketId) io.to(room.hostSocketId).emit("host:closed");
  for (const p of room.players.values()) if (p.socketId) io.to(p.socketId).emit("player:closed");
  for (const a of room.audience.values()) if (a.socketId) io.to(a.socketId).emit("player:closed");
}

setInterval(() => {
  const now = Date.now();
  for (const room of Array.from(rooms.values())) {
    const idle = !room.anyoneConnected() && now - room.lastActivity > ROOM_IDLE_MS;
    const ancient = now - room.createdAt > ROOM_MAX_AGE_MS;
    if (idle || ancient) destroyRoom(room);
  }
}, 60 * 1000).unref();

// ── broadcasting (coalesced per tick) ─────────────────────────────────────────
const dirty = new Set();
let flushScheduled = false;
function markDirty(room) {
  dirty.add(room);
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    flushScheduled = false;
    const batch = Array.from(dirty);
    dirty.clear();
    for (const room of batch) broadcast(room);
  });
}

function broadcast(room) {
  if (!rooms.has(room.code)) return;
  if (room.hostSocketId) io.to(room.hostSocketId).emit("host:state", room.hostView());
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit("player:state", room.playerView(p.id));
  }
  for (const a of room.audience.values()) {
    if (a.socketId) io.to(a.socketId).emit("player:state", room.playerView(a.id));
  }
}

function createRoom() {
  if (rooms.size >= MAX_ROOMS) return null;
  const code = makeCode();
  if (!code) return null;
  const room = new Room(code, {
    timerScale: TIMER_SCALE,
    onUpdate: markDirty,
    onReaction: (r, rx) => { if (r.hostSocketId) io.to(r.hostSocketId).emit("host:reaction", rx); },
    onSound: (r, name) => { /* sounds are inferred client-side from state; hook kept for future use */ },
  });
  rooms.set(code, room);
  roomsByHostToken.set(room.hostToken, room);
  return room;
}

// ── http ──────────────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir, {
  extensions: ["html"], etag: true, maxAge: "10m",
  setHeaders: (res, filePath) => { if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); },
}));
app.get("/health", (req, res) => res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
app.get("/host", (req, res) => res.sendFile(path.join(publicDir, "host.html")));
app.get("/play", (req, res) => res.sendFile(path.join(publicDir, "index.html")));
// Four-letter paths double as join links: /XKPT -> join form with the code filled in.
app.get(/^\/([A-Za-z]{4})$/, (req, res) => res.redirect(302, `/?code=${req.params[0].toUpperCase()}`));
app.use((req, res) => res.status(404).sendFile(path.join(publicDir, "index.html")));

const server = http.createServer(app);
const io = new SocketServer(server, {
  maxHttpBufferSize: 16 * 1024,
  pingInterval: 10000,
  pingTimeout: 20000,
  cors: { origin: false },
});

function originFor(socket) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, "");
  const h = socket.handshake.headers;
  const proto = (h["x-forwarded-proto"] || "").split(",")[0].trim() || (socket.handshake.secure ? "https" : "http");
  const host = (h["x-forwarded-host"] || h.host || `localhost:${PORT}`).split(",")[0].trim();
  return `${proto}://${host}`;
}

async function roomCard(room, socket) {
  const origin = originFor(socket);
  const joinUrl = `${origin}/?code=${room.code}`;
  let qr = "";
  try {
    qr = await QRCode.toString(joinUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#141414", light: "#00000000" } });
  } catch (err) {
    console.error("qr failed", err);
  }
  const display = origin.replace(/^https?:\/\//, "");
  return { code: room.code, hostToken: room.hostToken, joinUrl, joinDisplay: display, qr };
}

// Simple per-socket rate limiter: at most N events per second.
function limiter(max = 25) {
  let windowStart = Date.now(), count = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    count++;
    return count <= max;
  };
}

const ack = (cb, payload) => { if (typeof cb === "function") cb(payload); };

io.on("connection", (socket) => {
  const allowed = limiter();
  socket.data.role = null;
  const guard = (fn) => (payload, cb) => {
    if (!allowed()) return ack(cb, { ok: false, error: "Slow down." });
    try {
      fn(payload || {}, cb);
    } catch (err) {
      console.error(`socket handler error (${socket.id}):`, err);
      ack(cb, { ok: false, error: "Something broke on our end. Try again." });
    }
  };

  const currentRoom = () => (socket.data.code ? rooms.get(socket.data.code) : null);

  // ── host ──
  socket.on("host:create", guard(async (payload, cb) => {
    let room = null;
    if (typeof payload.hostToken === "string") room = roomsByHostToken.get(payload.hostToken) || null;
    if (!room) room = createRoom();
    if (!room) return ack(cb, { ok: false, error: "The newsroom is full right now. Try again in a minute." });
    if (room.hostSocketId && room.hostSocketId !== socket.id) io.to(room.hostSocketId).emit("host:replaced");
    socket.data.role = "host";
    socket.data.code = room.code;
    room.attachHost(socket.id);
    const card = await roomCard(room, socket);
    ack(cb, { ok: true, ...card });
  }));

  const hostOnly = (fn) => guard((payload, cb) => {
    const room = currentRoom();
    if (!room || socket.data.role !== "host" || room.hostSocketId !== socket.id) return ack(cb, { ok: false, error: "Not the host." });
    fn(room, payload, cb);
  });

  socket.on("host:start", hostOnly((room, payload, cb) => ack(cb, room.startGame())));
  socket.on("host:next", hostOnly((room, payload, cb) => ack(cb, room.hostNext())));
  socket.on("host:playAgain", hostOnly((room, payload, cb) => ack(cb, room.playAgain())));
  socket.on("host:remove", hostOnly((room, payload, cb) => {
    const targetId = String(payload.playerId || "");
    const res = room.removePlayer(targetId);
    if (res.ok) {
      // Tell the removed phone to forget its session.
      for (const s of io.sockets.sockets.values()) {
        if (s.data.code === room.code && s.data.id === targetId) { s.emit("player:removed"); s.data.role = null; s.data.code = null; s.data.id = null; }
      }
    }
    ack(cb, res);
  }));

  // ── player ──
  socket.on("player:join", guard((payload, cb) => {
    const code = normalizeCode(payload.code);
    if (!code) return ack(cb, { ok: false, error: "Room codes are 4 letters." });
    const room = rooms.get(code);
    if (!room) return ack(cb, { ok: false, error: "No room with that code. Check the TV." });
    const name = cleanText(String(payload.name || ""), 40);
    if (!name) return ack(cb, { ok: false, error: "Pick a name first." });
    const res = room.join(name, socket.id);
    if (!res.ok) return ack(cb, res);
    socket.data.role = res.role;
    socket.data.code = code;
    socket.data.id = res.id;
    ack(cb, { ok: true, role: res.role, code, playerId: res.id, token: res.token, state: room.playerView(res.id) });
  }));

  socket.on("player:rejoin", guard((payload, cb) => {
    const code = normalizeCode(payload.code);
    const room = code ? rooms.get(code) : null;
    if (!room) return ack(cb, { ok: false, error: "That game is over." });
    const res = room.rejoin(String(payload.playerId || ""), String(payload.token || ""), socket.id);
    if (!res.ok) return ack(cb, { ok: false, error: "Couldn't find your seat. Join again." });
    socket.data.role = res.role;
    socket.data.code = code;
    socket.data.id = String(payload.playerId);
    ack(cb, { ok: true, role: res.role, code, playerId: socket.data.id, state: room.playerView(socket.data.id) });
  }));

  const participantOnly = (fn) => guard((payload, cb) => {
    const room = currentRoom();
    if (!room || !socket.data.id) return ack(cb, { ok: false, error: "You're not in a room." });
    fn(room, payload, cb);
  });

  socket.on("player:start", participantOnly((room, payload, cb) => {
    const p = room.players.get(socket.data.id);
    if (!p || !p.isVip) return ack(cb, { ok: false, error: "Only the VIP can start." });
    ack(cb, room.startGame());
  }));
  socket.on("player:playAgain", participantOnly((room, payload, cb) => {
    const p = room.players.get(socket.data.id);
    if (!p || !p.isVip) return ack(cb, { ok: false, error: "Only the VIP can restart." });
    ack(cb, room.playAgain());
  }));
  socket.on("player:write", participantOnly((room, payload, cb) => {
    const text = typeof payload.text === "string" ? payload.text.slice(0, 500) : "";
    ack(cb, room.submitWrite(socket.data.id, String(payload.key || ""), text));
  }));
  socket.on("player:vote", participantOnly((room, payload, cb) => {
    const clean = {};
    for (const k of ["matchupId", "subjectId", "choice", "first", "second"]) {
      if (payload[k] === null || payload[k] === undefined) continue;
      clean[k] = String(payload[k]).slice(0, 32);
    }
    ack(cb, room.submitVote(socket.data.id, clean));
  }));
  socket.on("player:react", participantOnly((room, payload, cb) => {
    const emoji = typeof payload.emoji === "string" && REACTIONS.includes(payload.emoji) ? payload.emoji : null;
    if (!emoji) return ack(cb, { ok: false });
    ack(cb, room.react(socket.data.id, emoji));
  }));
  socket.on("player:leave", participantOnly((room, payload, cb) => {
    // Only meaningful in the lobby; mid-game we keep the seat so they can come back.
    if (room.phase === "lobby" && room.players.has(socket.data.id)) room.removePlayer(socket.data.id);
    else if (room.audience.has(socket.data.id)) { room.audience.delete(socket.data.id); markDirty(room); }
    socket.data.role = null; socket.data.code = null; socket.data.id = null;
    ack(cb, { ok: true });
  }));

  socket.on("disconnect", () => {
    const room = currentRoom();
    if (!room) return;
    if (socket.data.role === "host") room.detachHost(socket.id);
    else room.detachParticipant(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`The Daily Dirt is on the presses at http://localhost:${PORT} (timer scale ${TIMER_SCALE})`);
});

function shutdown() {
  console.log("shutting down");
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { app, server, io, rooms };
