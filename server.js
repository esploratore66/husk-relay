const { WebSocketServer } = require("ws");
const http = require("http");

const PORT = process.env.PORT || 3000;
const MAX_MSG_SIZE = 65536;
const MAX_QUEUE = 200;
const MSG_TTL_MS = 24 * 3600000;

const clients = new Map();
const offlineQueue = new Map();
const rateLimits = new WeakMap();

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", clients: clients.size, queued: offlineQueue.size, uptime: Math.floor(process.uptime()) }));
  } else { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MSG_SIZE });

wss.on("connection", (ws) => {
  let huskId = null;

  ws.on("message", (raw) => {
    if (!checkRate(ws)) { send(ws, { t: "err", msg: "rate_limited" }); return; }
    let msg;
    try { msg = JSON.parse(raw.toString("utf8")); } catch { send(ws, { t: "err", msg: "invalid_json" }); return; }

    switch (msg.t) {
      case "reg":
        if (!validId(msg.id)) { send(ws, { t: "err", msg: "invalid_id" }); return; }
        const old = clients.get(msg.id);
        if (old && old !== ws && old.readyState === 1) { send(old, { t: "err", msg: "replaced" }); old.close(4000, "replaced"); }
        huskId = msg.id;
        clients.set(huskId, ws);
        send(ws, { t: "ack" });
        deliverOffline(huskId, ws);
        log(`+ ${mask(huskId)} (${clients.size} online)`);
        break;

      case "msg":
        if (!huskId) { send(ws, { t: "err", msg: "not_registered" }); return; }
        if (!validId(msg.to) || !msg.d || typeof msg.d !== "string" || msg.d.length > MAX_MSG_SIZE) {
          send(ws, { t: "err", msg: "invalid_msg" }); return;
        }
        const dest = clients.get(msg.to);
        const env = { t: "msg", from: huskId, d: msg.d, ts: Date.now() };
        if (dest && dest.readyState === 1) { send(dest, env); }
        else { queue(msg.to, env); }
        send(ws, { t: "ack" });
        break;

      case "ping": send(ws, { t: "pong" }); break;
      default: send(ws, { t: "err", msg: "unknown" });
    }
  });

  ws.on("close", () => {
    if (huskId && clients.get(huskId) === ws) { clients.delete(huskId); log(`- ${mask(huskId)} (${clients.size} online)`); }
  });
  ws.on("error", () => {});
});

function queue(id, env) {
  let q = offlineQueue.get(id);
  if (!q) { q = []; offlineQueue.set(id, q); }
  if (q.length >= MAX_QUEUE) q.shift();
  q.push(env);
}

function deliverOffline(id, ws) {
  const q = offlineQueue.get(id);
  if (!q || !q.length) return;
  send(ws, { t: "queued", count: q.length });
  for (const env of q) send(ws, env);
  offlineQueue.delete(id);
  log(`  delivered ${q.length} offline to ${mask(id)}`);
}

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, q] of offlineQueue.entries()) {
    const f = q.filter(m => now - m.ts < MSG_TTL_MS);
    if (!f.length) offlineQueue.delete(id); else offlineQueue.set(id, f);
    cleaned += q.length - f.length;
  }
  if (cleaned > 0) log(`cleanup: ${cleaned} expired`);
}, 600000);

function checkRate(ws) {
  const now = Date.now();
  let s = rateLimits.get(ws);
  if (!s || now > s.r) { s = { c: 0, r: now + 1000 }; rateLimits.set(ws, s); }
  return ++s.c <= 10;
}

function validId(id) { return typeof id === "string" && /^H-[a-f0-9]{16}$/.test(id); }
function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }
function mask(id) { return id ? id.substring(0, 6) + "..." : "?"; }
function log(msg) { console.log(`[${new Date().toISOString().substring(11, 19)}] ${msg}`); }

httpServer.listen(PORT, () => { log(`Husk relay on port ${PORT}`); });
process.on("SIGTERM", () => { log("shutdown"); wss.clients.forEach(ws => ws.close(1001)); httpServer.close(() => process.exit(0)); });
