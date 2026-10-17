'use strict';
const $ = id => document.getElementById(id);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const store = { get: (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const rtcConfig = { iceServers: [] };                 // LAN/VPN: sem STUN
const log = (...a) => console.log('[lan-share]', ...a);

const S = {                                            // estado da sala
  ws: null, me: null, nick: '', hosting: null,
  users: new Map(), thumbs: {},
  out: new Map(),                                      // viewerId -> RTCPeerConnection (eu transmitindo)
  inn: new Map(),                                      // sharerId -> {pc, tile, video, ...} (eu assistindo)
  cfg: { latency: 60, stats: true, ...JSON.parse(store.get('cfg', '{}') || '{}') },
};
const L = { on: false, stream: null, vt: null, at: null, src: null, vid: null, scale: 1, lastAudio: 192, thumbTimer: null, statsTimer: null };
const tx = o => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); };
function toast(t) { const d = el('div', 'toast', t); $('toasts').append(d); setTimeout(() => d.remove(), 4500); }
const avatar = u => { const a = el('div', 'avatar', (u.nick || '?')[0].toUpperCase()); a.style.background = u.color; return a; };
const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// =====================================================================
//  SDP / CODECS
// =====================================================================
const famOf = c => (c.mimeType.split('/')[1] || '').toLowerCase();
const CODECS = ['h264', 'vp8', 'vp9', 'av1'];
const orderFor = pref => (!pref || pref === 'auto') ? CODECS : [pref, ...CODECS.filter(x => x !== pref)];
function availableCodecs() {
  try { return [...new Set(RTCRtpSender.getCapabilities('video').codecs.map(famOf))].filter(f => CODECS.includes(f)); } catch { return []; }
}
function codecOrder(pref) {
  const order = orderFor(pref);
  const rank = c => { const i = order.indexOf(famOf(c)); return i < 0 ? 99 : i; };
  return [...RTCRtpSender.getCapabilities('video').codecs].sort((a, b) => rank(a) - rank(b));
}
// Quem decide o codec é a ORDEM da resposta do espectador; aqui reordenamos para respeitar a escolha do transmissor.
function preferCodecSdp(sdp, pref) {
  const order = orderFor(pref);
  const lines = sdp.split(/\r?\n/);
  const mi = lines.findIndex(l => l.startsWith('m=video'));
  if (mi < 0) return sdp;
  const name = {}, apt = {};
  lines.forEach(l => {
    let m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//); if (m) name[m[1]] = m[2].toLowerCase();
    m = l.match(/^a=fmtp:(\d+) apt=(\d+)/); if (m) apt[m[1]] = m[2];
  });
  const parts = lines[mi].split(' '), head = parts.slice(0, 3), pts = parts.slice(3);
  const rank = pt => { const i = order.indexOf(name[apt[pt] || pt]); return i < 0 ? 99 : i; };
  const sorted = [...pts].sort((a, b) => rank(a) - rank(b) || (apt[a] ? 1 : 0) - (apt[b] ? 1 : 0));
  lines[mi] = [...head, ...sorted].join(' ');
  return lines.join('\r\n');
}
// Bitrate de vídeo (mínimo BAIXO para não afogar a rede) + Opus estéreo no bitrate escolhido.
function tuneSdp(sdp, vk, ak) {
  const lines = sdp.split(/\r?\n/), kind = [], codec = {}, hasFmtp = new Set();
  let cur = '';
  lines.forEach((l, i) => {
    if (l.startsWith('m=')) cur = l.slice(2).split(' ')[0];
    kind[i] = cur;
    let m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//); if (m) codec[m[1]] = m[2].toLowerCase();
    m = l.match(/^a=fmtp:(\d+) /); if (m) hasFmtp.add(m[1]);
  });
  const V = `x-google-min-bitrate=${Math.round(Math.min(2000, vk * 0.2))};x-google-start-bitrate=${Math.round(Math.min(8000, vk * 0.5))};x-google-max-bitrate=${vk}`;
  const A = `stereo=1;sprop-stereo=1;maxaveragebitrate=${Math.max(32, ak) * 1000};maxplaybackrate=48000;sprop-maxcapturerate=48000`;
  const out = [];
  lines.forEach((l, i) => {
    const f = l.match(/^a=fmtp:(\d+) /);
    if (f) {
      const c = codec[f[1]];
      if (kind[i] === 'video' && CODECS.includes(c) && !l.includes('x-google-min-bitrate')) l += ';' + V;
      else if (c === 'opus' && !l.includes('maxaveragebitrate')) l += ';' + A;
    }
    out.push(l);
    const r = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
    if (r && !hasFmtp.has(r[1]) && kind[i] === 'video' && ['vp8', 'vp9', 'av1'].includes(r[2].toLowerCase())) out.push(`a=fmtp:${r[1]} ${V}`);
  });
  return out.join('\r\n');
}

// ---------- estatísticas ----------
async function collect(pc) {
  const st = await pc.getStats(); const c = {}, cd = {}, r = {};
  st.forEach(x => { if (x.type === 'local-candidate' || x.type === 'remote-candidate') c[x.id] = x; if (x.type === 'codec') cd[x.id] = x; });
  st.forEach(x => {
    if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') {
      r.rtt = x.currentRoundTripTime;
      const l = c[x.localCandidateId], rm = c[x.remoteCandidateId];
      r.path = `${l?.candidateType || '?'} ${l?.address || l?.ip || ''} → ${rm?.address || rm?.ip || ''}`;
    }
    if (x.type === 'outbound-rtp' && x.kind === 'video') r.out = x;
    if (x.type === 'outbound-rtp' && x.kind === 'audio') r.outA = x;
    if (x.type === 'inbound-rtp' && x.kind === 'video') r.in = x;
    if (x.type === 'inbound-rtp' && x.kind === 'audio') r.inA = x;
  });
  if (r.out) r.codecOut = cd[r.out.codecId]?.mimeType;
  if (r.in) r.codecIn = cd[r.in.codecId]?.mimeType;
  return r;
}
const mbps = (b, a) => a && b[1] > a[1] ? ((b[0] - a[0]) * 8 / (b[1] - a[1]) / 1000).toFixed(1) : '0.0';

// =====================================================================
//  LOBBY / CONEXÃO
// =====================================================================
$('nick').value = store.get('nick'); $('lobHost').value = store.get('host'); $('lobRoom').value = store.get('room', 'Sala de Lives');
document.querySelectorAll('#lobSeg button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#lobSeg button').forEach(x => x.classList.toggle('on', x === b));
  $('paneJoin').classList.toggle('hide', b.dataset.m !== 'join'); $('paneHost').classList.toggle('hide', b.dataset.m !== 'host');
});
const lobErr = t => { $('lobErr').textContent = t || ''; $('btnJoin').disabled = $('btnCreate').disabled = false; };
function needNick() { const n = $('nick').value.trim(); if (!n) { lobErr('Digite um nick.'); $('nick').focus(); return null; } store.set('nick', n); return n; }

$('btnJoin').onclick = () => {
  const n = needNick(); if (!n) return;
  let h = $('lobHost').value.trim().replace(/^(https?|wss?):\/\//, '').replace(/\/.*$/, '');
  if (!h) return lobErr('Digite o IP da sala.');
  if (!/:\d+$/.test(h)) h += ':3000';
  store.set('host', $('lobHost').value.trim());
  connect('ws://' + h, n);
};
$('btnCreate').onclick = async () => {
  const n = needNick(); if (!n) return;
  $('btnCreate').disabled = true; $('lobErr').textContent = 'Criando sala…';
  const room = $('lobRoom').value.trim() || 'Sala de Lives'; store.set('room', room);
  const r = await api.startServer(Number($('lobPort').value) || 3000, room);
  if (!r.ok) return lobErr('Não foi possível criar a sala: ' + r.error);
  S.hosting = r; connect('ws://127.0.0.1:' + r.port, n);
};

function connect(url, nick) {
  $('lobErr').textContent = 'Conectando…'; $('btnJoin').disabled = true;
  let opened = false;
  const ws = new WebSocket(url); S.ws = ws;
  ws.onopen = () => { opened = true; tx({ type: 'join', nick }); };
  ws.onmessage = e => onMsg(JSON.parse(e.data));
  ws.onclose = () => {
    if (S.me != null) cleanup('Conexão com a sala encerrada.');
    else { if (S.hosting) { api.stopServer(); S.hosting = null; } lobErr(opened ? 'A sala recusou a conexão.' : 'Não foi possível conectar. Confira o IP, a porta e o firewall.'); }
  };
}
function leave() { if (S.ws) { S.ws.onclose = null; S.ws.close(); } cleanup(''); }
function cleanup(msg) {
  stopLive();
  [...S.inn.keys()].forEach(id => closeTile(id, false));
  S.users.clear(); S.thumbs = {}; S.me = null; S.ws = null;
  cardEls.forEach(c => c.remove()); cardEls.clear(); $('msgs').innerHTML = '';
  closeLiveModal(); $('app').classList.add('hide'); $('lobby').classList.remove('hide');
  if (S.hosting) { api.stopServer(); S.hosting = null; }
  lobErr(msg);
}
$('btnLeave').onclick = leave;
window.addEventListener('beforeunload', () => { try { stopLive(); } catch {} });

function onMsg(m) {
  switch (m.type) {
    case 'welcome':
      S.me = m.me; S.nick = m.nick;
      S.users = new Map(m.users.map(u => [u.id, u])); S.thumbs = m.thumbs || {};
      $('roomName').textContent = m.room; document.title = m.room + ' — LAN Screen Share';
      $('meNick').textContent = S.nick; { const a = avatar(S.users.get(S.me)); $('meAvatar').textContent = a.textContent; $('meAvatar').style.background = a.style.background; }
      $('msgs').innerHTML = ''; m.history.forEach(addMsg);
      renderInvite(); renderMembers(); renderCards();
      $('lobby').classList.add('hide'); $('app').classList.remove('hide'); lobErr('');
      break;
    case 'user-joined': S.users.set(m.user.id, m.user); renderMembers(); break;
    case 'user-left': S.users.delete(m.id); delete S.thumbs[m.id]; closeTile(m.id, false); renderMembers(); renderCards(); break;
    case 'live-update': {
      const u = S.users.get(m.id); if (!u) break;
      u.live = m.live; u.viewers = m.viewers || 0;
      if (!m.live) { delete S.thumbs[m.id]; closeTile(m.id, false); }
      renderMembers(); renderCards(); break;
    }
    case 'viewers': { const u = S.users.get(m.id); if (u) { u.viewers = m.count; renderCards(); } break; }
    case 'thumb': { S.thumbs[m.id] = m.data; const c = cardEls.get(m.id); const img = c && c.querySelector('img'); if (img) img.src = m.data; break; }
    case 'chat': addMsg(m); break;
    case 'viewer-joined': if (L.on) createOut(m.id); break;
    case 'viewer-left': closeOut(m.id); break;
    case 'live-ended': closeTile(m.id, false); renderCards(); break;
    case 'signal': handleSignal(m.from, m.data); break;
  }
}

// =====================================================================
//  UI: membros, convite, chat, cards
// =====================================================================
function renderInvite() {
  const box = $('invite'); box.innerHTML = '';
  if (!S.hosting) { box.append(el('div', 'muted small', 'Você está conectado à sala de outra pessoa.')); return; }
  S.hosting.ips.forEach(i => {
    const addr = i.address + (S.hosting.port !== 3000 ? ':' + S.hosting.port : '');
    const c = el('div', 'ipchip', addr); c.append(el('small', '', i.name)); c.title = 'Clique para copiar';
    c.onclick = () => { navigator.clipboard?.writeText(addr); toast('Copiado: ' + addr); };
    box.append(c);
  });
  box.append(el('div', 'muted small', 'Passe o IP da rede Radmin/Hamachi para seus amigos.'));
}
function renderMembers() {
  const box = $('members'); box.innerHTML = '';
  const arr = [...S.users.values()].sort((a, b) => (!!b.live - !!a.live) || a.nick.localeCompare(b.nick));
  $('onlineCount').textContent = arr.length;
  arr.forEach(u => {
    const r = el('div', 'member'); r.append(avatar(u), el('span', 'mname', u.nick + (u.id === S.me ? ' (você)' : '')));
    if (u.live) { r.append(el('span', 'badge', 'AO VIVO')); if (u.id !== S.me) { r.style.cursor = 'pointer'; r.title = 'Assistir'; r.onclick = () => watch(u.id); } }
    box.append(r);
  });
  const me = S.users.get(S.me);
  $('meStatus').textContent = me?.live ? '🔴 Ao vivo' : 'Online'; $('btnGoLive').closest('.userpanel').classList.toggle('live', !!me?.live);
}
function addMsg(m) {
  const box = $('msgs'); const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 50;
  let d;
  if (m.sys) d = el('div', 'sys', m.text);
  else {
    d = el('div', 'msg'); const body = el('div'); const head = el('div', 'mhead');
    const n = el('b', '', m.nick); n.style.color = m.color; head.append(n, el('small', '', fmtTime(m.ts)));
    body.append(head, el('div', 'mtext', m.text)); d.append(avatar(m), body);
  }
  box.append(d); while (box.children.length > 300) box.firstChild.remove();
  if (stick || m.from === S.me) box.scrollTop = box.scrollHeight;
}
$('msgInput').onkeydown = e => { if (e.key === 'Enter') { const t = e.target.value.trim(); if (t) tx({ type: 'chat', text: t }); e.target.value = ''; } };

const cardEls = new Map();
function buildCard(id) {
  const mine = id === S.me; const c = el('div', 'card' + (mine ? ' mine' : ''));
  const th = el('div', 'thumb'); const media = document.createElement(mine ? 'video' : 'img');
  if (mine) { media.muted = true; media.autoplay = true; media.playsInline = true; }
  th.append(media, el('span', 'livebadge', 'AO VIVO'), el('span', 'viewers', '👁 0'));
  const info = el('div', 'cinfo'), tcol = el('div', 'ctext');
  tcol.append(el('b', 'ctitle'), el('small', 'cuser'), el('small', 'cmeta')); info.append(el('div', 'avatar'), tcol);
  const btns = el('div', 'cbtns'); c.append(th, info, btns);
  if (mine) {
    const a = el('button', 'ghost', '⚙ Configurações'); a.onclick = openLiveModal;
    const b = el('button', 'danger', '■ Encerrar'); b.onclick = stopLive; btns.append(a, b); c.append(el('pre', 'cstats'));
  } else {
    const w = el('button', 'watchbtn', '▶ Assistir'); w.onclick = () => toggleWatch(id); btns.append(w); th.onclick = () => toggleWatch(id);
  }
  return c;
}
function updateCard(c, u) {
  const mine = u.id === S.me;
  c.querySelector('.ctitle').textContent = u.live.title; c.querySelector('.cuser').textContent = mine ? 'Você' : u.nick; c.querySelector('.cmeta').textContent = u.live.info || '';
  const av = c.querySelector('.avatar'); av.textContent = u.nick[0].toUpperCase(); av.style.background = u.color;
  c.querySelector('.viewers').textContent = '👁 ' + (u.viewers || 0);
  if (mine) {
    const v = c.querySelector('video'); if (L.stream && v.srcObject !== L.stream) v.srcObject = L.stream;
    v.style.visibility = $('showPreview').checked ? '' : 'hidden';
  } else {
    const img = c.querySelector('img'), t = S.thumbs[u.id]; if (t && img.src !== t) img.src = t;
    c.querySelector('.watchbtn').textContent = S.inn.has(u.id) ? '✕ Parar de assistir' : '▶ Assistir'; c.classList.toggle('watching', S.inn.has(u.id));
  }
}
function renderCards() {
  const lives = [...S.users.values()].filter(u => u.live), seen = new Set();
  lives.forEach(u => {
    let c = cardEls.get(u.id); if (!c) { c = buildCard(u.id); cardEls.set(u.id, c); $('cards').append(c); }
    seen.add(u.id); updateCard(c, u);
  });
  cardEls.forEach((c, id) => { if (!seen.has(id)) { c.remove(); cardEls.delete(id); } });
  $('cardsSec').classList.toggle('compact', S.inn.size > 0);
}

// painéis laterais no modo estreito
$('btnMembers').onclick = () => $('side').classList.toggle('open');
$('btnChat').onclick = () => $('chat').classList.toggle('open');
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $(b.dataset.close).classList.remove('open'));

// =====================================================================
//  ASSISTIR (várias lives ao mesmo tempo)
// =====================================================================
function toggleWatch(id) { S.inn.has(id) ? closeTile(id, true) : watch(id); }
function watch(id) {
  if (S.inn.has(id) || id === S.me) return;
  const u = S.users.get(id); if (!u?.live) return;
  const tile = el('div', 'tile'), video = document.createElement('video');
  video.autoplay = true; video.playsInline = true; video.muted = [...S.inn.values()].some(e => !e.video.muted); // só o 1º começa com som
  const bar = el('div', 'tbar'), name = el('div', 'tname', `${u.nick} — ${u.live.title}`);
  const mute = el('button', '', video.muted ? '🔇' : '🔊'), vol = document.createElement('input'); vol.type = 'range'; vol.min = 0; vol.max = 1; vol.step = 0.01; vol.value = 1;
  const full = el('button', '', '⛶'), close = el('button', '', '✕');
  mute.onclick = () => { video.muted = !video.muted; mute.textContent = video.muted ? '🔇' : '🔊'; };
  vol.oninput = () => { video.volume = Number(vol.value); };
  full.onclick = () => tile.requestFullscreen?.(); video.ondblclick = full.onclick; close.onclick = () => closeTile(id, true);
  bar.append(name, mute, vol, full, close);
  const stat = el('div', 'tstat'); stat.style.display = 'none';
  const load = el('div', 'tload', 'Conectando…'); video.onplaying = () => load.remove();
  tile.append(video, bar, stat, load); $('tiles').append(tile);
  S.inn.set(id, { pc: null, tile, video, stat, pend: [] });
  tx({ type: 'watch', target: id }); renderCards();
}
function closeTile(id, notify) {
  const e = S.inn.get(id); if (!e) return;
  e.pc?.close(); e.tile.remove(); S.inn.delete(id);
  if (notify) tx({ type: 'unwatch', target: id });
  renderCards();
}
function applyLatency(pc) {
  pc.getReceivers().forEach(r => {
    const ms = r.track?.kind === 'audio' ? Math.max(120, S.cfg.latency) : S.cfg.latency;   // áudio nunca com buffer mínimo (evita chiado)
    if ('jitterBufferTarget' in r) r.jitterBufferTarget = ms;
    if ('playoutDelayHint' in r) r.playoutDelayHint = ms / 1000;
  });
}
async function onOffer(from, sdp) {
  const e = S.inn.get(from); if (!e) return;
  e.pc?.close(); e.lv = e.la = null;
  const pc = new RTCPeerConnection(rtcConfig); e.pc = pc;
  pc.onicecandidate = ev => ev.candidate && tx({ type: 'signal', to: from, data: { kind: 'candidate', role: 'viewer', candidate: ev.candidate } });
  pc.ontrack = ev => { e.video.srcObject = ev.streams[0]; applyLatency(pc); e.video.play().catch(() => { e.video.muted = true; e.video.play(); }); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') toast('Falha na conexão P2P com a live (firewall/VPN?).'); };
  await pc.setRemoteDescription(sdp);
  while (e.pend.length) pc.addIceCandidate(e.pend.shift()).catch(() => {});
  await pc.setLocalDescription(await pc.createAnswer());
  tx({ type: 'signal', to: from, data: { kind: 'answer', sdp: pc.localDescription } });
}
setInterval(async () => {
  for (const [, e] of S.inn) {
    e.stat.style.display = S.cfg.stats ? '' : 'none';
    if (!e.pc || e.pc.connectionState !== 'connected') continue;
    const s = await collect(e.pc); if (!s.in) continue;
    const v = mbps([s.in.bytesReceived, s.in.timestamp], e.lv); e.lv = [s.in.bytesReceived, s.in.timestamp];
    let a = 'sem áudio';
    if (s.inA) { a = e.la ? Math.round((s.inA.bytesReceived - e.la[0]) * 8 / (s.inA.timestamp - e.la[1])) + ' kbps' : '…'; e.la = [s.inA.bytesReceived, s.inA.timestamp]; }
    e.stat.textContent = `${s.in.frameWidth}x${s.in.frameHeight} · ${Math.round(s.in.framesPerSecond || 0)} fps · ${v} Mbps · ${(s.codecIn || '').replace('video/', '')} · perda ${s.in.packetsLost} · áudio ${a}`;
  }
}, 1000);

// =====================================================================
//  SINALIZAÇÃO
// =====================================================================
async function handleSignal(from, d) {
  if (!d) return;
  if (d.kind === 'offer') return onOffer(from, d.sdp);
  if (d.kind === 'answer') {
    const pc = S.out.get(from); if (!pc) return;
    const { fps, mb } = cfg(), ak = +$('audioQ').value || 96;
    try { await pc.setRemoteDescription({ type: 'answer', sdp: tuneSdp(preferCodecSdp(d.sdp.sdp, $('codec').value), mb * 1000, ak) }); }
    catch (err) { log('SDP ajustado falhou, usando original', err); await pc.setRemoteDescription(d.sdp); }
    while (pc._q?.length) pc.addIceCandidate(pc._q.shift()).catch(() => {});
    return;
  }
  if (d.kind === 'candidate') {
    if (d.role === 'sharer') { const e = S.inn.get(from); if (!e) return; if (e.pc?.remoteDescription) e.pc.addIceCandidate(d.candidate).catch(() => {}); else e.pend.push(d.candidate); }
    else { const pc = S.out.get(from); if (!pc) return; if (pc.remoteDescription) pc.addIceCandidate(d.candidate).catch(() => {}); else (pc._q = pc._q || []).push(d.candidate); }
  }
}

// =====================================================================
//  TRANSMITIR
// =====================================================================
function cfg() { const [w, h, fps, mb] = $('preset').value.split(',').map(Number); return { w, h, fps, mb }; }
const infoText = () => $('preset').selectedOptions[0].text.split(' · ').slice(0, 2).join(' · ');

async function capture(src) {
  const { w, h, fps } = cfg();
  await api.selectSource(src.id, true);
  const v = { frameRate: { ideal: fps, max: fps }, width: w ? { ideal: w, max: w } : { max: 7680 }, height: h ? { ideal: h, max: h } : { max: 4320 } };
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: v,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },  // sem processamento = áudio fiel
  });
  const vt = stream.getVideoTracks()[0], at = stream.getAudioTracks()[0];
  vt.contentHint = $('hint').value; vt.onended = stopLive;
  await vt.applyConstraints({ frameRate: { ideal: fps, max: fps } }).catch(() => {});
  if (at) { at.contentHint = 'music'; at.enabled = +$('audioQ').value > 0; }
  const old = L.stream; L.stream = stream; L.vt = vt; L.at = at;
  computeScale();
  // vídeo oculto usado para gerar miniaturas
  L.vid?.remove(); const hv = document.createElement('video');
  hv.muted = true; hv.autoplay = true; hv.playsInline = true; hv.srcObject = stream;
  Object.assign(hv.style, { position: 'fixed', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' }); document.body.append(hv); hv.play().catch(() => {}); L.vid = hv;
  // troca "a quente" para quem já está assistindo
  S.out.forEach(pc => pc.getSenders().forEach(s => {
    if (s.track?.kind === 'video') s.replaceTrack(vt).catch(() => {});
    else if (s.track?.kind === 'audio' && at) s.replaceTrack(at).catch(() => {});
  }));
  old?.getTracks().forEach(t => { t.onended = null; t.stop(); });
  if (L.on) { S.out.forEach(applySender); renderCards(); }
}
function computeScale() {
  const { w, h } = cfg(), st = L.vt.getSettings();
  L.scale = (w && st.width && st.height) ? Math.max(1, st.width / w, st.height / h) : 1;
  log('captura', st.width, st.height, st.frameRate, 'scale', L.scale);
}
function applySender(pc) {
  const { fps, mb } = cfg(), hint = $('hint').value;
  pc.getSenders().forEach(s => {
    if (!s.track) return;
    const p = s.getParameters(); if (!p.encodings?.length) p.encodings = [{}];
    if (s.track.kind === 'video') {
      Object.assign(p.encodings[0], { maxBitrate: mb * 1e6, maxFramerate: fps, networkPriority: 'high', priority: 'high', scaleResolutionDownBy: L.scale });
      p.degradationPreference = hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
    } else p.encodings[0].maxBitrate = Math.max(32, +$('audioQ').value || 96) * 1000;
    s.setParameters(p).catch(e => log('setParameters', e));
  });
}
async function createOut(vid) {
  closeOut(vid);
  const pc = new RTCPeerConnection(rtcConfig); S.out.set(vid, pc);
  L.stream.getTracks().forEach(t => pc.addTrack(t, L.stream));
  try { pc.getTransceivers().forEach(tr => { if (tr.sender.track?.kind === 'video') tr.setCodecPreferences(codecOrder($('codec').value)); }); } catch (e) { log('codec prefs', e); }
  pc.onicecandidate = ev => ev.candidate && tx({ type: 'signal', to: vid, data: { kind: 'candidate', role: 'sharer', candidate: ev.candidate } });
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') closeOut(vid); };
  await pc.setLocalDescription(await pc.createOffer());
  applySender(pc);
  tx({ type: 'signal', to: vid, data: { kind: 'offer', sdp: pc.localDescription } });
}
function closeOut(id) { S.out.get(id)?.close(); S.out.delete(id); }

async function goLive() {
  if (!L.src) return toast('Escolha uma tela ou janela primeiro.');
  $('liveGo').disabled = true;
  try { await capture(L.src); } catch (e) { $('liveGo').disabled = false; return toast('Falha na captura: ' + e.message); }
  $('liveGo').disabled = false; L.on = true; L.lastAudio = +$('audioQ').value;
  tx({ type: 'go-live', title: $('liveTitle').value.trim() || `Live de ${S.nick}`, info: infoText() });
  clearInterval(L.thumbTimer); L.thumbTimer = setInterval(snap, 5000); setTimeout(snap, 1500);
  startLiveStats(); closeLiveModal(); toast('Você está ao vivo!');
}
function snap() {
  const v = L.vid; if (!L.on || !v || !v.videoWidth) return;
  const c = snap.c || (snap.c = document.createElement('canvas')); c.width = 320; c.height = Math.round(320 * v.videoHeight / v.videoWidth);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  tx({ type: 'thumb', data: c.toDataURL('image/jpeg', 0.6) });
}
function stopLive() {
  const was = L.on;
  clearInterval(L.thumbTimer); clearInterval(L.statsTimer);
  S.out.forEach(pc => pc.close()); S.out.clear();
  L.stream?.getTracks().forEach(t => { t.onended = null; t.stop(); }); L.stream = null; L.vt = L.at = null;
  L.vid?.remove(); L.vid = null; L.on = false;
  if (was) { tx({ type: 'stop-live' }); toast('Live encerrada.'); }
  closeLiveModal(); renderCards();
}
async function applyLive(what) {
  persistForm();
  if (!L.on) return;
  if (what === 'quality') {
    const { w, h, fps } = cfg();
    await L.vt.applyConstraints({ width: w ? { max: w } : { max: 7680 }, height: h ? { max: h } : { max: 4320 }, frameRate: { ideal: fps, max: fps } }).catch(() => {});
    computeScale();
  }
  if (what === 'hint') L.vt.contentHint = $('hint').value;
  let recreate = what === 'codec';
  if (what === 'audio') {
    const v = +$('audioQ').value; if (L.at) L.at.enabled = v > 0;
    if (v > 0 && v !== L.lastAudio) { recreate = true; L.lastAudio = v; }
  }
  if (recreate) [...S.out.keys()].forEach(id => createOut(id)); else S.out.forEach(applySender);
  tx({ type: 'update-live', title: $('liveTitle').value.trim() || `Live de ${S.nick}`, info: infoText() });
}
function startLiveStats() {
  let last = null, lastEnc = null;
  clearInterval(L.statsTimer);
  L.statsTimer = setInterval(async () => {
    const box = cardEls.get(S.me)?.querySelector('.cstats'); if (!box) return;
    const pc = [...S.out.values()][0];
    if (!pc) { box.textContent = 'Aguardando espectadores…\nCodecs disponíveis: ' + (availableCodecs().join(', ').toUpperCase() || '?'); return; }
    const s = await collect(pc); const o = s.out; if (!o) return;
    const b = mbps([o.bytesSent, o.timestamp], last); last = [o.bytesSent, o.timestamp];
    let encMs = null; if (lastEnc && o.framesEncoded > lastEnc[1]) encMs = ((o.totalEncodeTime - lastEnc[0]) / (o.framesEncoded - lastEnc[1])) * 1000;
    lastEnc = [o.totalEncodeTime, o.framesEncoded];
    const { fps } = cfg(), lim = o.qualityLimitationReason || 'none';
    let hint = '';
    if (encMs != null && encMs > (1000 / fps) * 0.8) hint += `\n⚠ Codificador lento (${encMs.toFixed(0)} ms/quadro). Reduza a qualidade ou troque o codec.`;
    if (lim === 'bandwidth') hint += '\n⚠ Rede limitando: reduza o bitrate/qualidade.';
    if (lim === 'cpu') hint += '\n⚠ CPU limitando: reduza a qualidade.';
    box.textContent = `${o.frameWidth}x${o.frameHeight} · ${Math.round(o.framesPerSecond || 0)}/${fps} fps · ${b} Mbps\n` +
      `${(s.codecOut || '?').replace('video/', '')} · ${o.encoderImplementation || '?'}${o.powerEfficientEncoder ? ' (hardware)' : ''}${encMs != null ? ' · ' + encMs.toFixed(1) + ' ms/quadro' : ''}\n` +
      `Áudio: ${s.outA ? 'enviando' : 'sem faixa'} · RTT ${s.rtt != null ? Math.round(s.rtt * 1000) + ' ms' : '?'} · espectadores: ${S.out.size}\n` +
      `Codecs: ${availableCodecs().join(', ').toUpperCase() || '?'} · limite: ${lim}` + hint;
  }, 1000);
}

// =====================================================================
//  MODAL DE TRANSMISSÃO + SELETOR DE FONTES
// =====================================================================
let srcType = 'screen', srcTimer = null, srcList = []; const srcEls = new Map();
async function loadSources() { try { srcList = await api.getSources(); } catch { return; } renderSources(); }
function renderSources() {
  const q = $('srcSearch').value.trim().toLowerCase(), grid = $('srcGrid');
  const vis = srcList.filter(s => (srcType === 'screen') === s.screen && (!q || s.name.toLowerCase().includes(q)));
  const ids = new Set(vis.map(s => s.id));
  srcEls.forEach((e, id) => { if (!ids.has(id)) { e.remove(); srcEls.delete(id); } });
  vis.forEach(s => {
    let e = srcEls.get(s.id);
    if (!e) {
      e = el('div', 'src'); const th = document.createElement('img'), nm = el('div', 'sname'), ic = el('img', 'sicon');
      nm.append(ic, el('span')); e.append(th, nm); e.onclick = () => pickSource(srcList.find(x => x.id === s.id) || s);
      grid.append(e); srcEls.set(s.id, e);
    }
    const imgs = e.querySelectorAll('img'); if (s.thumb) imgs[0].src = s.thumb; if (s.icon) imgs[1].src = s.icon;
    e.querySelector('span').textContent = s.name; e.title = s.name; e.classList.toggle('sel', L.src?.id === s.id);
  });
  let empty = grid.querySelector('.srcempty');
  if (!vis.length) { if (!empty) grid.append(el('div', 'srcempty', srcType === 'screen' ? 'Nenhuma tela encontrada.' : 'Nenhuma janela encontrada. Abra o programa e clique em ⟳.')); }
  else empty?.remove();
}
async function pickSource(s) {
  L.src = s; renderSources();
  if (!L.on) return;
  try { await capture(s); toast('Fonte alterada: ' + s.name); } catch (e) { toast('Falha ao trocar de fonte: ' + e.message); }
}
document.querySelectorAll('#srcSeg button').forEach(b => b.onclick = () => {
  srcType = b.dataset.t; document.querySelectorAll('#srcSeg button').forEach(x => x.classList.toggle('on', x === b));
  srcEls.clear(); $('srcGrid').innerHTML = ''; renderSources();
});
$('srcSearch').oninput = renderSources; $('srcRefresh').onclick = loadSources;

function openLiveModal() {
  const on = L.on;
  $('liveH').textContent = on ? 'Configurações da transmissão' : 'Transmitir tela';
  $('liveGo').classList.toggle('hide', on); $('liveStop').classList.toggle('hide', !on);
  if (!$('liveTitle').value) $('liveTitle').value = `Live de ${S.nick}`;
  srcEls.clear(); $('srcGrid').innerHTML = ''; $('liveModal').classList.remove('hide');
  loadSources(); clearInterval(srcTimer); srcTimer = setInterval(loadSources, 2500);
}
function closeLiveModal() { $('liveModal').classList.add('hide'); clearInterval(srcTimer); }
$('btnGoLive').onclick = openLiveModal; $('liveClose').onclick = $('liveCancel').onclick = closeLiveModal;
$('liveGo').onclick = goLive; $('liveStop').onclick = stopLive;
$('preset').onchange = () => applyLive('quality'); $('hint').onchange = () => applyLive('hint');
$('codec').onchange = () => applyLive('codec'); $('audioQ').onchange = () => applyLive('audio');
$('liveTitle').onchange = () => applyLive('title'); $('showPreview').onchange = () => { persistForm(); renderCards(); };

const FORM = ['preset', 'hint', 'codec', 'audioQ'];
function persistForm() { store.set('form', JSON.stringify({ ...Object.fromEntries(FORM.map(k => [k, $(k).value])), showPreview: $('showPreview').checked })); }
(function restoreForm() {
  try { const f = JSON.parse(store.get('form', '{}')); FORM.forEach(k => { if (f[k] && [...$(k).options].some(o => o.value === f[k])) $(k).value = f[k]; }); if (f.showPreview === false) $('showPreview').checked = false; } catch {}
})();

// ---------- configurações do app ----------
$('setLatency').value = String(S.cfg.latency); $('setStats').checked = S.cfg.stats;
const saveCfg = () => { S.cfg.latency = Number($('setLatency').value); S.cfg.stats = $('setStats').checked; store.set('cfg', JSON.stringify(S.cfg)); S.inn.forEach(e => e.pc && applyLatency(e.pc)); };
$('setLatency').onchange = $('setStats').onchange = saveCfg;
$('btnSettings').onclick = () => $('setModal').classList.remove('hide'); $('setClose').onclick = () => $('setModal').classList.add('hide');
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLiveModal(); $('setModal').classList.add('hide'); } });
