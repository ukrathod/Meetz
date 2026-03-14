/**
 * MEETZ — Real-Time Signaling & Matchmaking Server
 * Socket.IO + Express — Deploy FREE on Render / Railway
 */
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ── In-memory state ── */
const waiting   = [];       // [{ id, profile, filters }]
const pairs     = new Map();// id → partnerId
const users     = new Map();// id → { profile, filters }
const codePools = new Map();// "code" → [id, id, ...]
const BASE      = 100;      // fake floor shown to users

const liveCount = () => BASE + users.size;
const broadcast = () => io.emit('online', liveCount());

/* ── Matching ── */
function tryMatch(socket, profile, filters) {
  // 1. Connect Code priority matching
  const codes = (filters.codes || []).filter(Boolean).map(c => c.toLowerCase().trim());
  for (const code of codes) {
    const pool = codePools.get(code) || [];
    const partner = pool.find(pid => pid !== socket.id && users.has(pid) && !pairs.has(pid));
    if (partner) {
      // Remove from pool
      codePools.set(code, pool.filter(p => p !== partner && p !== socket.id));
      // Remove partner from waiting
      const wi = waiting.findIndex(w => w.id === partner);
      if (wi > -1) waiting.splice(wi, 1);
      pair(socket.id, partner, `code:${code}`);
      return true;
    }
    // Register in pool for later
    if (!pool.includes(socket.id)) {
      codePools.set(code, [...pool, socket.id]);
    }
  }

  // 2. Filter-based random matching
  const candidates = waiting.filter(w => {
    if (w.id === socket.id) return false;
    if (pairs.has(w.id)) return false;
    // Gender filter (both must match each other's preference)
    if (filters.gender !== 'any' && w.profile.gender !== filters.gender) return false;
    return true;
  });

  if (candidates.length > 0) {
    // Pick best match by interest overlap
    const scored = candidates.map(c => {
      const shared = (profile.interests || []).filter(i => (c.profile.interests || []).includes(i)).length;
      return { ...c, score: shared + Math.random() * 0.5 };
    }).sort((a, b) => b.score - a.score);

    const match = scored[0];
    waiting.splice(waiting.findIndex(w => w.id === match.id), 1);
    pair(socket.id, match.id, 'random');
    return true;
  }

  // 3. No match yet — add to waiting pool
  if (!waiting.find(w => w.id === socket.id)) {
    waiting.push({ id: socket.id, profile, filters });
  }
  socket.emit('waiting', { position: waiting.length, online: liveCount() });
  return false;
}

function pair(idA, idB, reason) {
  pairs.set(idA, idB);
  pairs.set(idB, idA);
  const pA = users.get(idA), pB = users.get(idB);
  io.to(idA).emit('matched', { partnerId: idB, partnerProfile: pB?.profile || {}, initiator: true,  matchReason: reason });
  io.to(idB).emit('matched', { partnerId: idA, partnerProfile: pA?.profile || {}, initiator: false, matchReason: reason });
  console.log(`[PAIR] ${idA} ↔ ${idB} (${reason})`);
}

function cleanup(id) {
  const partnerId = pairs.get(id);
  if (partnerId) {
    io.to(partnerId).emit('partner-left');
    pairs.delete(partnerId);
    // Re-queue partner
    const pu = users.get(partnerId);
    if (pu) setTimeout(() => {
      if (users.has(partnerId) && !pairs.has(partnerId)) {
        waiting.push({ id: partnerId, profile: pu.profile, filters: pu.filters });
        io.to(partnerId).emit('waiting', { position: waiting.length, online: liveCount() });
      }
    }, 500);
  }
  pairs.delete(id);
  users.delete(id);
  const wi = waiting.findIndex(w => w.id === id);
  if (wi > -1) waiting.splice(wi, 1);
  // Remove from code pools
  for (const [code, pool] of codePools) {
    const updated = pool.filter(p => p !== id);
    if (updated.length !== pool.length) codePools.set(code, updated);
  }
  broadcast();
}

/* ── Socket.IO events ── */
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  socket.on('register', ({ profile, filters }) => {
    users.set(socket.id, { profile, filters });
    broadcast();
    tryMatch(socket, profile, filters);
  });

  socket.on('skip', () => {
    cleanup(socket.id);
    // Re-register so user goes back to queue
    const u = users.get(socket.id); // already deleted — that's fine, user re-registers from client
  });

  socket.on('re-queue', ({ profile, filters }) => {
    users.set(socket.id, { profile, filters });
    if (!waiting.find(w => w.id === socket.id)) {
      waiting.push({ id: socket.id, profile, filters });
    }
    broadcast();
    tryMatch(socket, profile, filters);
  });

  // WebRTC relay
  socket.on('offer',     d => io.to(d.to).emit('offer',     { from: socket.id, sdp: d.sdp }));
  socket.on('answer',    d => io.to(d.to).emit('answer',    { from: socket.id, sdp: d.sdp }));
  socket.on('ice',       d => io.to(d.to).emit('ice',       { from: socket.id, candidate: d.candidate }));

  // Chat & interactions
  socket.on('chat',     d => { const p = pairs.get(socket.id); if(p) io.to(p).emit('chat',     d); });
  socket.on('reaction', d => { const p = pairs.get(socket.id); if(p) io.to(p).emit('reaction', d); });
  socket.on('like',     ()=> { const p = pairs.get(socket.id); if(p) io.to(p).emit('liked');       });
  socket.on('report',   d => console.log(`[REPORT] ${socket.id} → ${pairs.get(socket.id)}: ${d.reason}`));
  socket.on('game',     d => { const p = pairs.get(socket.id); if(p) io.to(p).emit('game', d);    });

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    cleanup(socket.id);
  });
});

setInterval(broadcast, 6000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Meetz → http://localhost:${PORT}`));
