/**
 * MEETZ v4 — Production Server
 * Real-time Socket.IO signaling + smart matchmaking
 */
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ── State ── */
const waiting      = [];       // [{ id, profile, filters, joinedAt }]
const pairs        = new Map();// socketId → partnerId
const users        = new Map();// socketId → { profile, filters }
const codePools    = new Map();// code → [socketId, ...]
const recentPairs  = new Map();// socketId → [recentPartnerId, ...] (last 5)
const BASE_ONLINE  = 50;

const liveCount = () => BASE_ONLINE + users.size;
const broadcast = () => io.emit('online', liveCount());

// Track recent partners for a socket (last 5, expires after 3 min)
const recentHistory = new Map(); // socketId → [{pid, ts}]
function addRecent(a, b) {
  const now = Date.now();
  for (const [me, them] of [[a,b],[b,a]]) {
    const hist = (recentHistory.get(me) || [])
      .filter(r => now - r.ts < 3 * 60 * 1000) // keep last 3 min only
      .slice(-5); // keep last 5
    hist.push({ pid: them, ts: now });
    recentHistory.set(me, hist);
  }
}
function wasRecent(a, b) {
  const hist = recentHistory.get(a) || [];
  return hist.some(r => r.pid === b);
}

/* ── Matchmaking ── */
function tryMatch(socket, profile, filters) {
  // 1. Connect Code priority (bypasses recent-pair check — intentional)
  const codes = (filters.codes || []).filter(c => c && c.trim());
  for (const raw of codes) {
    const code = raw.toLowerCase().trim();
    const pool = codePools.get(code) || [];
    const partner = pool.find(pid => pid !== socket.id && users.has(pid) && !pairs.has(pid));
    if (partner) {
      codePools.set(code, pool.filter(p => p !== partner && p !== socket.id));
      const wi = waiting.findIndex(w => w.id === partner);
      if (wi > -1) waiting.splice(wi, 1);
      pair(socket.id, partner, `code:${code}`);
      return;
    }
    if (!pool.includes(socket.id)) codePools.set(code, [...pool, socket.id]);
  }

  // 2. Filter matching — skip recently seen partners
  const now = Date.now();
  const candidates = waiting.filter(w => {
    if (w.id === socket.id || pairs.has(w.id)) return false;
    if (filters.gender && filters.gender !== 'any' && w.profile.gender !== filters.gender) return false;
    // Avoid immediate re-match with same person (unless they are the ONLY option)
    return true;
  });

  // Prefer candidates not recently seen; fall back to any if none available
  const fresh = candidates.filter(c => !wasRecent(socket.id, c.id));
  const pool = fresh.length > 0 ? fresh : candidates;

  if (pool.length > 0) {
    const scored = pool.map(c => {
      const wait = (now - (c.joinedAt || now)) / 1000;
      return { ...c, score: Math.min(wait, 30) * 0.02 + Math.random() * 0.5 };
    }).sort((a, b) => b.score - a.score);
    const match = scored[0];
    waiting.splice(waiting.findIndex(w => w.id === match.id), 1);
    pair(socket.id, match.id, 'random');
    return;
  }

  if (!waiting.find(w => w.id === socket.id)) {
    waiting.push({ id: socket.id, profile, filters, joinedAt: Date.now() });
  }
  socket.emit('waiting', { position: waiting.length, online: liveCount() });
}

function pair(a, b, reason) {
  pairs.set(a, b); pairs.set(b, a);
  addRecent(a, b); // track so they don't immediately re-match
  const pa = users.get(a), pb = users.get(b);
  io.to(a).emit('matched', { partnerId: b, partnerProfile: pb?.profile || {}, initiator: true,  reason });
  io.to(b).emit('matched', { partnerId: a, partnerProfile: pa?.profile || {}, initiator: false, reason });
  console.log(`PAIR ${a.slice(0,6)} ↔ ${b.slice(0,6)} (${reason})`);
}

function cleanup(id) {
  const pid = pairs.get(id);
  if (pid) {
    io.to(pid).emit('partner-left');
    pairs.delete(pid);
    // Re-queue partner
    const pu = users.get(pid);
    if (pu) {
      setTimeout(() => {
        if (users.has(pid) && !pairs.has(pid)) {
          waiting.push({ id: pid, ...pu, joinedAt: Date.now() });
          io.to(pid).emit('waiting', { position: waiting.length, online: liveCount() });
        }
      }, 1000);
    }
  }
  pairs.delete(id);
  users.delete(id);
  const wi = waiting.findIndex(w => w.id === id);
  if (wi > -1) waiting.splice(wi, 1);
  for (const [code, pool] of codePools) {
    codePools.set(code, pool.filter(p => p !== id));
  }
  broadcast();
}

/* ── Socket Events ── */
io.on('connection', socket => {
  console.log(`+ ${socket.id.slice(0,8)}`);

  socket.on('register', ({ profile, filters }) => {
    users.set(socket.id, { profile, filters });
    broadcast();
    tryMatch(socket, profile, filters);
  });

  socket.on('skip', () => {
    const pid = pairs.get(socket.id);
    if (pid) { io.to(pid).emit('partner-left'); pairs.delete(pid); pairs.delete(socket.id); }
    const wi = waiting.findIndex(w => w.id === socket.id);
    if (wi > -1) waiting.splice(wi, 1);
    for (const [code, pool] of codePools) {
      codePools.set(code, pool.filter(p => p !== socket.id));
    }
  });

  socket.on('re-queue', ({ profile, filters }) => {
    users.set(socket.id, { profile, filters });
    const wi = waiting.findIndex(w => w.id === socket.id);
    if (wi > -1) waiting.splice(wi, 1);
    broadcast();
    tryMatch(socket, profile, filters);
  });

  // WebRTC
  socket.on('offer',  d => io.to(d.to).emit('offer',  { from: socket.id, sdp: d.sdp }));
  socket.on('answer', d => io.to(d.to).emit('answer', { from: socket.id, sdp: d.sdp }));
  socket.on('ice',    d => io.to(d.to).emit('ice',    { from: socket.id, candidate: d.candidate }));

  // Chat & interactions — relay to partner
  const relay = (ev, data) => { const p = pairs.get(socket.id); if (p) io.to(p).emit(ev, data); };
  socket.on('chat',     d => relay('chat', d));
  socket.on('reaction', d => relay('reaction', d));
  socket.on('like',     () => relay('liked', {}));
  socket.on('add-friend', () => relay('friend-request', {}));
  socket.on('friend-accept', () => {
    const pid = pairs.get(socket.id);
    if (pid) {
      relay('friend-accepted', {});
      // Both save each other
      io.to(socket.id).emit('save-friend', { partnerId: pid, profile: users.get(pid)?.profile });
      io.to(pid).emit('save-friend', { partnerId: socket.id, profile: users.get(socket.id)?.profile });
    }
  });

  // Truth or Dare — SYNC to both
  socket.on('tod', d => {
    const pid = pairs.get(socket.id);
    if (!pid) return;
    // Send to both
    io.to(socket.id).emit('tod-show', d);
    io.to(pid).emit('tod-show', d);
  });

  // Filters update while in chat
  socket.on('update-filters', ({ filters }) => {
    const u = users.get(socket.id);
    if (u) { u.filters = { ...u.filters, ...filters }; users.set(socket.id, u); }
  });

  socket.on('report', d => console.log(`REPORT ${socket.id.slice(0,6)} → ${d.reason}`));


  // Friend calling relay
  socket.on('call-friend',    d => io.to(d.targetId).emit('incoming-call',   { callerId: socket.id, callerName: d.callerName, callerAvatar: d.callerAvatar }));
  socket.on('call-accepted',  d => {
    io.to(d.callerId).emit('call-was-accepted', { acceptorId: socket.id });
    // Pair them for WebRTC
    pairs.set(socket.id, d.callerId);
    pairs.set(d.callerId, socket.id);
  });
  socket.on('call-rejected',  d => io.to(d.callerId).emit('call-was-rejected'));
  socket.on('call-cancelled', d => io.to(d.targetId).emit('call-was-cancelled'));


  socket.on('disconnect', () => {
    console.log(`- ${socket.id.slice(0,8)}`);
    cleanup(socket.id);
  });
});

setInterval(broadcast, 8000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Meetz v4 → http://localhost:${PORT}`));
