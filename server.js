/**
 * MEETZ — Production Server (Fixed)
 * Fixes: /api/stats missing, friend online tracking, call relay, count accuracy
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

/* ── API endpoints ── */

// FIX 1: /api/stats was missing — keep-alive ping was failing silently
app.get('/api/stats', (req, res) => {
  res.json({ online: BASE_ONLINE + users.size, waiting: waiting.length, pairs: pairs.size / 2 });
});

// TURN credentials endpoint
app.get('/api/turn', async (req, res) => {
  try {
    const KEY_ID    = process.env.CF_TURN_KEY_ID;
    const API_TOKEN = process.env.CF_TURN_API_TOKEN;
    if (!KEY_ID || !API_TOKEN) throw new Error('No CF TURN credentials');
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate`,
      { method:'POST', headers:{'Authorization':`Bearer ${API_TOKEN}`,'Content-Type':'application/json'}, body:JSON.stringify({ttl:86400}) }
    );
    const data = await r.json();
    res.json(data);
  } catch(e) {
    // Fallback to Metered TURN
    res.json({ iceServers: [
      { urls:'stun:stun.l.google.com:19302' },
      { urls:'stun:stun1.l.google.com:19302' },
      { urls:'stun:relay.metered.ca:80' },
      { urls:'turn:standard.relay.metered.ca:80',       username: process.env.METERED_USER || '292efe209928a23b8c893de8', credential: process.env.METERED_CRED || 'wlZrpnxdvFBIM6Ky' },
      { urls:'turn:standard.relay.metered.ca:80?transport=tcp', username: process.env.METERED_USER || '292efe209928a23b8c893de8', credential: process.env.METERED_CRED || 'wlZrpnxdvFBIM6Ky' },
      { urls:'turn:standard.relay.metered.ca:443',      username: process.env.METERED_USER || '292efe209928a23b8c893de8', credential: process.env.METERED_CRED || 'wlZrpnxdvFBIM6Ky' },
      { urls:'turns:standard.relay.metered.ca:443?transport=tcp', username: process.env.METERED_USER || '292efe209928a23b8c893de8', credential: process.env.METERED_CRED || 'wlZrpnxdvFBIM6Ky' }
    ]});
  }
});

// Sitemap for SEO
app.get('/sitemap.xml', (req, res) => {
  const base = process.env.RENDER_EXTERNAL_URL || 'https://meetz.onrender.com';
  res.header('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url></urlset>`);
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ── State ── */
const waiting      = [];        // [{ id, profile, filters, joinedAt }]
const pairs        = new Map(); // socketId → partnerId
const users        = new Map(); // socketId → { profile, filters }
const codePools    = new Map(); // code → [socketId, ...]
const recentHistory= new Map(); // socketId → [{pid, ts}]

// FIX 2: Name → socketId registry for friend calling
// When user registers with a name, we map name → socketId so friends can call them
const nameToSocket = new Map(); // lowerName → socketId
const socketToName = new Map(); // socketId → lowerName

const BASE_ONLINE = 50;
const liveCount   = () => BASE_ONLINE + users.size;
const broadcast   = () => io.emit('online', liveCount());

/* ── Recent partner tracking ── */
function addRecent(a, b) {
  const now = Date.now();
  for (const [me, them] of [[a,b],[b,a]]) {
    const hist = (recentHistory.get(me) || [])
      .filter(r => now - r.ts < 3 * 60 * 1000)
      .slice(-5);
    hist.push({ pid: them, ts: now });
    recentHistory.set(me, hist);
  }
}
function wasRecent(a, b) {
  return (recentHistory.get(a) || []).some(r => r.pid === b);
}

/* ── Matchmaking ── */
function tryMatch(socket, profile, filters) {
  // 1. Connect Code priority
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

  // 2. Filter matching — prefer fresh partners
  const now = Date.now();
  const candidates = waiting.filter(w => {
    if (w.id === socket.id || pairs.has(w.id)) return false;
    if (filters.gender && filters.gender !== 'any' && w.profile.gender !== filters.gender) return false;
    return true;
  });

  const fresh = candidates.filter(c => !wasRecent(socket.id, c.id));
  const pool  = fresh.length > 0 ? fresh : candidates;

  if (pool.length > 0) {
    const scored = pool.map(c => ({
      ...c,
      score: Math.min((now - (c.joinedAt || now)) / 1000, 30) * 0.02 + Math.random() * 0.5
    })).sort((a, b) => b.score - a.score);
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
  addRecent(a, b);
  const pa = users.get(a), pb = users.get(b);
  io.to(a).emit('matched', { partnerId: b, partnerProfile: pb?.profile || {}, initiator: true,  reason });
  io.to(b).emit('matched', { partnerId: a, partnerProfile: pa?.profile || {}, initiator: false, reason });
  console.log(`PAIR ${a.slice(0,6)} ↔ ${b.slice(0,6)} (${reason})`);
}

function removeFromWaiting(id) {
  const wi = waiting.findIndex(w => w.id === id);
  if (wi > -1) waiting.splice(wi, 1);
  for (const [code, pool] of codePools) {
    const np = pool.filter(p => p !== id);
    if (np.length === 0) codePools.delete(code);
    else codePools.set(code, np);
  }
}

function cleanup(id) {
  // Unregister from name map
  const oldName = socketToName.get(id);
  if (oldName) {
    nameToSocket.delete(oldName);
    socketToName.delete(id);
  }

  const pid = pairs.get(id);
  if (pid) {
    io.to(pid).emit('partner-left');
    pairs.delete(pid);
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
  removeFromWaiting(id);
  recentHistory.delete(id);
  broadcast();
}

/* ── Socket Events ── */
io.on('connection', socket => {
  console.log(`+ ${socket.id.slice(0,8)}`);
  // Add to users immediately so count is accurate
  users.set(socket.id, { profile: {}, filters: {} });
  broadcast();

  socket.on('register', ({ profile, filters }) => {
    users.set(socket.id, { profile, filters });

    // FIX 3: Register name → socketId for friend calling
    const lname = (profile.name || '').toLowerCase().trim();
    if (lname) {
      // Remove old mapping if they had one
      const oldName = socketToName.get(socket.id);
      if (oldName && oldName !== lname) nameToSocket.delete(oldName);
      nameToSocket.set(lname, socket.id);
      socketToName.set(socket.id, lname);
    }

    broadcast();
    tryMatch(socket, profile, filters);
  });

  socket.on('skip', () => {
    const pid = pairs.get(socket.id);
    if (pid) { io.to(pid).emit('partner-left'); pairs.delete(pid); pairs.delete(socket.id); }
    removeFromWaiting(socket.id);
  });

  socket.on('re-queue', ({ profile, filters }) => {
    users.set(socket.id, { profile, filters });
    // Update name mapping
    const lname = (profile.name || '').toLowerCase().trim();
    if (lname) { nameToSocket.set(lname, socket.id); socketToName.set(socket.id, lname); }
    removeFromWaiting(socket.id);
    broadcast();
    tryMatch(socket, profile, filters);
  });

  // WebRTC signaling
  socket.on('offer',  d => io.to(d.to).emit('offer',  { from: socket.id, sdp: d.sdp }));
  socket.on('answer', d => io.to(d.to).emit('answer', { from: socket.id, sdp: d.sdp }));
  socket.on('ice',    d => io.to(d.to).emit('ice',    { from: socket.id, candidate: d.candidate }));

  // Camera permission system (anti-vulgarity feature)
  socket.on('cam-request', d => {
    const pid = pairs.get(socket.id);
    if (pid) io.to(pid).emit('cam-request', { requesterId: socket.id, requesterName: d.requesterName });
  });
  socket.on('cam-approve', d => { io.to(d.requesterId).emit('cam-approved', { approverId: socket.id }); });
  socket.on('cam-deny',    d => { io.to(d.requesterId).emit('cam-denied',   { denierId:   socket.id }); });

  // Chat & interactions
  const relay = (ev, data) => { const p = pairs.get(socket.id); if (p) io.to(p).emit(ev, data); };
  socket.on('chat',     d => relay('chat', d));
  socket.on('reaction', d => relay('reaction', d));
  socket.on('like',     () => relay('liked', {}));

  socket.on('add-friend', () => relay('friend-request', {}));
  socket.on('friend-accept', () => {
    const pid = pairs.get(socket.id);
    if (pid) {
      relay('friend-accepted', {});
      io.to(socket.id).emit('save-friend', { partnerId: pid, profile: users.get(pid)?.profile });
      io.to(pid).emit('save-friend', { partnerId: socket.id, profile: users.get(socket.id)?.profile });
    }
  });

  // Truth or Dare — synced to both players
  socket.on('tod', d => {
    const pid = pairs.get(socket.id);
    if (!pid) return;
    io.to(socket.id).emit('tod-show', d);
    io.to(pid).emit('tod-show', d);
  });

  // XOX (Tic Tac Toe) — bidirectional
  socket.on('xox-open', d => { const p = pairs.get(socket.id); if (p) io.to(p).emit('xox-open', { size: d.size }); });
  socket.on('xox-move', d => { const p = pairs.get(socket.id); if (p) io.to(p).emit('xox-move', { idx: d.idx, mark: d.mark, size: d.size }); });
  socket.on('xox-reset', d => {
    const p = pairs.get(socket.id);
    if (!p) return;
    io.to(socket.id).emit('xox-reset', { size: d.size, initiator: true });
    io.to(p).emit('xox-reset', { size: d.size, initiator: false });
  });
  socket.on('xox-size-change', d => { const p = pairs.get(socket.id); if (p) io.to(p).emit('xox-size-change', { size: d.size }); });

  // Rock Paper Scissors — real-time synced
  socket.on('rps-open',   d => { const p = pairs.get(socket.id); if (p) io.to(p).emit('rps-open',   { rounds: d.rounds }); });
  socket.on('rps-choice', d => { const p = pairs.get(socket.id); if (p) io.to(p).emit('rps-choice', { choice: d.choice }); });
  socket.on('rps-reset',  d => { const p = pairs.get(socket.id); if (p) io.to(p).emit('rps-reset',  { rounds: d.rounds }); });

  socket.on('update-filters', ({ filters }) => {
    const u = users.get(socket.id);
    if (u) { u.filters = { ...u.filters, ...filters }; users.set(socket.id, u); }
  });

  socket.on('report', d => console.log(`REPORT ${socket.id.slice(0,6)} → ${d.reason}`));

  // FIX 4: Friend calling — resolve friend name → current socket ID
  socket.on('call-friend', d => {
    let targetId = d.targetId;

    // If targetId looks stale or missing, try to resolve by name
    if (d.targetName && (!targetId || !io.sockets.sockets.has(targetId))) {
      const resolved = nameToSocket.get(d.targetName.toLowerCase().trim());
      if (resolved) targetId = resolved;
    }

    if (!targetId || !io.sockets.sockets.has(targetId)) {
      // Friend is offline — tell caller
      socket.emit('call-was-rejected');
      return;
    }
    io.to(targetId).emit('incoming-call', { callerId: socket.id, callerName: d.callerName, callerAvatar: d.callerAvatar });
  });

  socket.on('call-accepted', d => {
    io.to(d.callerId).emit('call-was-accepted', { acceptorId: socket.id });
    pairs.set(socket.id, d.callerId);
    pairs.set(d.callerId, socket.id);
  });
  socket.on('call-rejected',  d => io.to(d.callerId).emit('call-was-rejected'));
  socket.on('call-cancelled', d => io.to(d.targetId).emit('call-was-cancelled'));

  // FIX 5: Check if friend is online by name
  socket.on('check-friend-online', ({ name }) => {
    const sid = nameToSocket.get((name || '').toLowerCase().trim());
    const isOnline = !!(sid && io.sockets.sockets.has(sid));
    socket.emit('friend-status', { name, online: isOnline, socketId: isOnline ? sid : null });
  });

  socket.on('disconnect', () => {
    console.log(`- ${socket.id.slice(0,8)}`);
    cleanup(socket.id);
  });
});

// Broadcast online count every 8 seconds
setInterval(broadcast, 8000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Meetz (Fixed) → http://localhost:${PORT}`);

  // Keep-alive ping — prevents Render free tier from sleeping
  const siteUrl = process.env.RENDER_EXTERNAL_URL;
  if (siteUrl) {
    setInterval(() => {
      fetch(siteUrl + '/api/stats')
        .then(r => r.json())
        .then(d => console.log(`✅ Keep-alive: ${d.online} online`))
        .catch(() => console.log('⚠️ Keep-alive ping failed'));
    }, 10 * 60 * 1000);
  }
});
