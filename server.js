// Hub da sala: usuários, chat, lista de lives e sinalização WebRTC. O vídeo/áudio vai P2P (não passa aqui).
const http = require('http');
const os = require('os');
const { WebSocketServer } = require('ws');

const COLORS = ['#5865f2', '#eb459e', '#f0b232', '#23a55a', '#00a8fc', '#f23f43', '#9b59b6', '#e67e22', '#1abc9c', '#e91e63'];
const MDNS = /[0-9a-f-]{36}\.local/i;
const clean = a => (a || '').replace('::ffff:', '');
const isLoop = ip => ip === '127.0.0.1' || ip === '::1';
const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));

function localIps() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) out.push({ name, address: i.address });
  return out;
}

// Fallback: candidatos mascarados (xxxx.local) viram o IP real da conexão.
function fixSignal(d, from, to) {
  if (d && d.kind === 'candidate' && d.candidate && MDNS.test(d.candidate.candidate || '')) {
    const ip = isLoop(from.ip) ? to.localIp : from.ip;
    return { ...d, candidate: { ...d.candidate, candidate: d.candidate.candidate.replace(MDNS, ip) } };
  }
  return d;
}

function startServer(port = 3000, room = 'Sala de Lives') {
  return new Promise((resolve, reject) => {
    const users = new Map();
    const history = [];
    let nextId = 1, msgId = 1;

    const server = http.createServer((req, res) => { res.writeHead(200); res.end('LAN Screen Share'); });
    const wss = new WebSocketServer({ server });
    wss.on('error', () => {}); // erros de listen são tratados pelo reject abaixo

    const pub = u => ({ id: u.id, nick: u.nick, color: u.color, live: u.live, viewers: u.viewers.size });
    const broadcast = (o, except) => users.forEach(u => { if (u !== except) send(u.ws, o); });
    const pushChat = m => { history.push(m); if (history.length > 100) history.shift(); broadcast({ type: 'chat', ...m }); };
    const sys = text => pushChat({ id: msgId++, sys: true, text, ts: Date.now() });
    const viewerCount = t => broadcast({ type: 'viewers', id: t.id, count: t.viewers.size });

    function endLive(u) {
      if (!u.live) return;
      u.viewers.forEach(vid => {
        const v = users.get(vid);
        if (v) { v.watching.delete(u.id); send(v.ws, { type: 'live-ended', id: u.id }); }
      });
      u.viewers.clear(); u.live = null; u.thumb = null;
      broadcast({ type: 'live-update', id: u.id, live: null, viewers: 0 });
    }

    wss.on('connection', (ws, req) => {
      const ip = clean(req.socket.remoteAddress), localIp = clean(req.socket.localAddress);

      ws.on('message', raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        let u = ws.user;

        if (m.type === 'join') {
          if (u) return;
          let nick = String(m.nick || '').trim().slice(0, 24) || 'Convidado';
          const base = nick; let n = 2;
          const taken = x => [...users.values()].some(v => v.nick.toLowerCase() === x.toLowerCase());
          while (taken(nick)) nick = `${base} (${n++})`;
          const id = nextId++;
          u = ws.user = { id, nick, color: COLORS[id % COLORS.length], live: null, thumb: null, viewers: new Set(), watching: new Set(), ws, ip, localIp };
          users.set(id, u);
          const thumbs = {}; users.forEach(v => { if (v.thumb) thumbs[v.id] = v.thumb; });
          send(ws, { type: 'welcome', me: id, nick, room, users: [...users.values()].map(pub), thumbs, history });
          broadcast({ type: 'user-joined', user: pub(u) }, ws);
          sys(`${nick} entrou na sala.`);
          return;
        }
        if (!u) return;

        switch (m.type) {
          case 'chat': {
            const text = String(m.text || '').trim().slice(0, 500);
            if (text) pushChat({ id: msgId++, from: u.id, nick: u.nick, color: u.color, text, ts: Date.now() });
            break;
          }
          case 'go-live':
            u.live = { title: String(m.title || `Live de ${u.nick}`).slice(0, 60), info: String(m.info || '').slice(0, 60), since: Date.now() };
            broadcast({ type: 'live-update', id: u.id, live: u.live, viewers: u.viewers.size });
            sys(`${u.nick} iniciou uma live.`);
            break;
          case 'update-live':
            if (!u.live) break;
            if (m.title != null) u.live.title = String(m.title).slice(0, 60);
            if (m.info != null) u.live.info = String(m.info).slice(0, 60);
            broadcast({ type: 'live-update', id: u.id, live: u.live, viewers: u.viewers.size });
            break;
          case 'stop-live':
            if (u.live) { endLive(u); sys(`${u.nick} encerrou a live.`); }
            break;
          case 'thumb':
            if (u.live && typeof m.data === 'string' && m.data.length < 80000) {
              u.thumb = m.data; broadcast({ type: 'thumb', id: u.id, data: m.data }, ws);
            }
            break;
          case 'watch': {
            const t = users.get(m.target);
            if (!t || !t.live || t === u) return send(ws, { type: 'live-ended', id: m.target });
            if (t.viewers.has(u.id)) break;
            t.viewers.add(u.id); u.watching.add(t.id);
            send(t.ws, { type: 'viewer-joined', id: u.id, nick: u.nick });
            viewerCount(t);
            break;
          }
          case 'unwatch': {
            const t = users.get(m.target);
            if (t && t.viewers.delete(u.id)) { u.watching.delete(t.id); send(t.ws, { type: 'viewer-left', id: u.id }); viewerCount(t); }
            break;
          }
          case 'signal': {
            const to = users.get(m.to);
            if (to) send(to.ws, { type: 'signal', from: u.id, data: fixSignal(m.data, u, to) });
            break;
          }
        }
      });

      ws.on('close', () => {
        const u = ws.user; if (!u) return;
        endLive(u);
        u.watching.forEach(tid => { const t = users.get(tid); if (t) { t.viewers.delete(u.id); send(t.ws, { type: 'viewer-left', id: u.id }); viewerCount(t); } });
        users.delete(u.id);
        broadcast({ type: 'user-left', id: u.id });
        sys(`${u.nick} saiu da sala.`);
      });
    });

    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve({ port, ips: localIps(), close: () => { wss.clients.forEach(c => c.terminate()); wss.close(); server.close(); } });
    });
  });
}

module.exports = { startServer, localIps };
