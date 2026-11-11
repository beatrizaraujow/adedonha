// ADEDONHA — servidor único (Express + Socket.io, estado em memória, uma sala só)
// Fluxo: lobby → sorteio da letra → respondendo → STOP → votação por categoria → resultado da rodada → ... → final
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3001;
const TIME_SCALE = Number(process.env.TIME_SCALE) || 1; // só para testes automatizados
const RULES_FILE = process.env.RULES_FILE || path.join(__dirname, 'regras.json');
const COUNTDOWN_MS = 3500 * TIME_SCALE; // revelação da letra
const COLLECT_MS = 1200;                // espera pelas últimas respostas depois do STOP

// ---------------------------------------------------------------- utilidades
const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20);
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const nameKey = n => fold(cleanName(n));
// Normaliza resposta para comparar repetidas: sem acento, minúsculas, sem pontuação, espaços únicos
const normAnswer = s => fold(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const cleanAnswer = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40);
const clamp = (v, min, max, def) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def; };
const pick = a => a[Math.floor(Math.random() * a.length)];
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------------------------------------------------------------- regras
const DEFAULT_RULES = {
  nomeDoJogo: 'ADEDONHA', rodadas: 5, tempoRodadaSegundos: 120, tempoMinimoParaStopSegundos: 20,
  stopSoComTudoPreenchido: true, letras: 'ABCDEFGHIJLMNOPQRSTUVZ', naoRepetirLetra: true,
  categorias: ['Nome', 'CEP (cidade, estado ou país)', 'Animal', 'Cor', 'Fruta, legume ou verdura', 'Objeto', 'Marca', 'Profissão'],
  categoriasPorRodada: 0,
  pontos: { respostaUnica: 10, respostaRepetida: 5, bonusQuemDeuStop: 0 },
  votacao: { ligada: true, tempoPorCategoriaSegundos: 40, invalidaSeRejeitadaPorMaisDe: 0.5 },
};

// Aceita qualquer objeto (arquivo ou formulário do apresentador) e devolve regras válidas
function sanitizeRules(r, base = DEFAULT_RULES) {
  r = r && typeof r === 'object' ? r : {};
  const p = r.pontos || {}, v = r.votacao || {}, bp = base.pontos, bv = base.votacao;
  let letras = [...new Set(fold(r.letras ?? base.letras).toUpperCase().replace(/[^A-Z]/g, ''))].join('');
  if (!letras) letras = base.letras;
  let cats = Array.isArray(r.categorias) ? r.categorias : String(r.categorias ?? '').split('\n');
  cats = [...new Set(cats.map(c => String(c).replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
  if (!cats.length) cats = base.categorias.slice();
  const tempo = clamp(r.tempoRodadaSegundos, 15, 900, base.tempoRodadaSegundos);
  const thr = Number(v.invalidaSeRejeitadaPorMaisDe ?? bv.invalidaSeRejeitadaPorMaisDe);
  return {
    nomeDoJogo: String(r.nomeDoJogo ?? base.nomeDoJogo).trim().slice(0, 30) || 'ADEDONHA',
    rodadas: clamp(r.rodadas, 1, 30, base.rodadas),
    tempoRodadaSegundos: tempo,
    tempoMinimoParaStopSegundos: clamp(r.tempoMinimoParaStopSegundos, 0, tempo, Math.min(base.tempoMinimoParaStopSegundos, tempo)),
    stopSoComTudoPreenchido: r.stopSoComTudoPreenchido !== undefined ? !!r.stopSoComTudoPreenchido : base.stopSoComTudoPreenchido,
    letras,
    naoRepetirLetra: r.naoRepetirLetra !== undefined ? !!r.naoRepetirLetra : base.naoRepetirLetra,
    categorias: cats,
    categoriasPorRodada: clamp(r.categoriasPorRodada, 0, cats.length, 0),
    pontos: {
      respostaUnica: clamp(p.respostaUnica, -100, 1000, bp.respostaUnica),
      respostaRepetida: clamp(p.respostaRepetida, -100, 1000, bp.respostaRepetida),
      bonusQuemDeuStop: clamp(p.bonusQuemDeuStop, -100, 1000, bp.bonusQuemDeuStop),
    },
    votacao: {
      ligada: v.ligada !== undefined ? !!v.ligada : bv.ligada,
      tempoPorCategoriaSegundos: clamp(v.tempoPorCategoriaSegundos, 0, 600, bv.tempoPorCategoriaSegundos),
      invalidaSeRejeitadaPorMaisDe: Number.isFinite(thr) ? Math.min(0.99, Math.max(0, thr)) : bv.invalidaSeRejeitadaPorMaisDe,
    },
  };
}

function loadRules() {
  try { return sanitizeRules(JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'))); }
  catch (e) { console.error('⚠️  Erro lendo regras.json, usando o padrão:', e.message); return sanitizeRules({}); }
}
let rules = loadRules();

// ---------------------------------------------------------------- rede / apresentador
function lanIPs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ name, address: a.address });
  }
  const score = ({ name, address }) => {
    let s = address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3;
    if (/vethernet|virtual|vmware|vbox|wsl|hyper-v|docker|loopback|bluetooth/i.test(name)) s += 10;
    if (address.startsWith('169.254.')) s += 20;
    return s;
  };
  return out.sort((a, b) => score(a) - score(b));
}
const IPS = lanIPs();
const LAN_URL = `http://${IPS[0] ? IPS[0].address : 'localhost'}:${PORT}`;
// No Render, RENDER_EXTERNAL_URL já vem preenchido com o endereço público do serviço
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const ON_RENDER = !!process.env.RENDER;
const HOST_KEY = String(process.env.HOST_KEY || Math.random().toString(36).slice(2, 7)).toLowerCase();
const isHostKey = k => typeof k === 'string' && k.trim().toLowerCase() === HOST_KEY;
const isLocalSocket = s => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(s.handshake.address) &&
  !s.handshake.headers['x-forwarded-for'] && !s.handshake.headers['cf-connecting-ip'];

// ---------------------------------------------------------------- estado
const players = new Map(); // key -> { key, name, token, socketId, connected, score, color, isHost }
const COLORS = ['#ff5c8a', '#3d7bff', '#1fbf6a', '#ffb020', '#8e44ff', '#00b8c4', '#ff7a2f', '#e0409b', '#4caf50', '#6d7cff', '#c2185b', '#00897b'];
let G;
let timer = null;

function freshGame() {
  return {
    phase: 'lobby',          // lobby | countdown | playing | collecting | voting | roundResult | final
    round: 0,
    letter: null,
    usedLetters: [],
    categories: [],
    deadline: 0,             // timestamp do fim da fase atual (0 = sem limite)
    startedAt: 0,
    stopBy: null,            // key de quem deu STOP (null = acabou o tempo)
    participants: [],        // keys que jogam a rodada atual
    answers: {},             // key -> [resposta por categoria]
    voteCat: 0,              // índice da categoria em votação
    rejects: {},             // catIndex -> { targetKey: Set(voterKey) }
    confirmed: new Set(),    // quem confirmou a categoria atual
    roundResult: null,
    history: [],
  };
}
G = freshGame();

const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };
const setPhaseTimer = (ms, fn) => { clearTimer(); G.deadline = ms > 0 ? Date.now() + ms : 0; if (ms > 0) timer = setTimeout(fn, ms); };
const connectedKeys = () => [...players.values()].filter(p => p.connected).map(p => p.key);

// ---------------------------------------------------------------- validação e pontos
function autoCheck(answer, letter) {
  const a = normAnswer(answer);
  if (!a) return 'vazio';
  if (a[0].toUpperCase() !== letter) return 'letra';
  return null;
}

function isRejected(cat, target) {
  const set = (G.rejects[cat] && G.rejects[cat][target]) || new Set();
  const voters = G.participants.filter(k => k !== target && players.has(k)).length;
  if (!voters) return false;
  return set.size / voters > rules.votacao.invalidaSeRejeitadaPorMaisDe;
}

function computeRoundResult() {
  const cats = G.categories;
  const rows = G.participants.filter(k => players.has(k)).map(k => ({ key: k, name: players.get(k).name, cells: [], total: 0 }));
  cats.forEach((_, ci) => {
    const valid = rows.map(r => {
      const answer = (G.answers[r.key] || [])[ci] || '';
      const auto = autoCheck(answer, G.letter);
      const rejected = !auto && rules.votacao.ligada && isRejected(ci, r.key);
      return { r, answer, auto, rejected, ok: !auto && !rejected, norm: normAnswer(answer) };
    });
    const count = {};
    valid.filter(v => v.ok).forEach(v => { count[v.norm] = (count[v.norm] || 0) + 1; });
    valid.forEach(v => {
      const repeated = v.ok && count[v.norm] > 1;
      const points = v.ok ? (repeated ? rules.pontos.respostaRepetida : rules.pontos.respostaUnica) : 0;
      v.r.cells.push({ answer: v.answer, points, status: v.auto || (v.rejected ? 'rejeitada' : repeated ? 'repetida' : 'unica') });
      v.r.total += points;
    });
  });
  let stopBonus = 0;
  if (G.stopBy && rules.pontos.bonusQuemDeuStop) {
    const r = rows.find(x => x.key === G.stopBy);
    if (r) { r.total += rules.pontos.bonusQuemDeuStop; stopBonus = rules.pontos.bonusQuemDeuStop; }
  }
  rows.forEach(r => { const p = players.get(r.key); if (p) p.score += r.total; });
  rows.sort((a, b) => b.total - a.total);
  return { round: G.round, letter: G.letter, categories: cats, rows, stopBy: G.stopBy && players.get(G.stopBy) ? players.get(G.stopBy).name : null, stopBonus };
}

// ---------------------------------------------------------------- fases
function startRound() {
  G.round += 1;
  let pool = rules.letras.split('');
  if (rules.naoRepetirLetra) {
    const left = pool.filter(l => !G.usedLetters.includes(l));
    if (left.length) pool = left; else G.usedLetters = [];
  }
  G.letter = pick(pool);
  G.usedLetters.push(G.letter);
  G.categories = rules.categoriasPorRodada > 0 && rules.categoriasPorRodada < rules.categorias.length
    ? shuffle(rules.categorias.slice()).slice(0, rules.categoriasPorRodada)
    : rules.categorias.slice();
  G.participants = connectedKeys();
  G.answers = {};
  G.participants.forEach(k => { G.answers[k] = G.categories.map(() => ''); });
  G.stopBy = null; G.rejects = {}; G.voteCat = 0; G.confirmed = new Set(); G.roundResult = null;
  G.phase = 'countdown';
  setPhaseTimer(COUNTDOWN_MS, beginPlaying);
  broadcast();
}

function beginPlaying() {
  G.phase = 'playing';
  G.startedAt = Date.now();
  setPhaseTimer(rules.tempoRodadaSegundos * 1000 * TIME_SCALE, () => endRound(null));
  broadcast();
}

function endRound(stopKey) {
  if (G.phase !== 'playing') return;
  G.stopBy = stopKey;
  G.phase = 'collecting';
  setPhaseTimer(COLLECT_MS, afterCollect);
  io.emit('collect'); // clientes mandam as respostas finais
  broadcast();
}

function afterCollect() {
  if (rules.votacao.ligada) { G.voteCat = 0; beginVoteCategory(); }
  else finishRound();
}

function beginVoteCategory() {
  G.phase = 'voting';
  G.confirmed = new Set();
  G.rejects[G.voteCat] = G.rejects[G.voteCat] || {};
  // Se nenhuma resposta da categoria é votável, pula direto
  const votable = G.participants.some(k => !autoCheck((G.answers[k] || [])[G.voteCat], G.letter));
  if (!votable) return nextVoteCategory();
  const s = rules.votacao.tempoPorCategoriaSegundos;
  setPhaseTimer(s > 0 ? s * 1000 * TIME_SCALE : 0, nextVoteCategory);
  broadcast();
}

function nextVoteCategory() {
  if (G.phase !== 'voting') return;
  G.voteCat += 1;
  if (G.voteCat >= G.categories.length) finishRound();
  else beginVoteCategory();
}

function maybeAllConfirmed() {
  const voters = G.participants.filter(k => players.get(k) && players.get(k).connected);
  if (voters.length && voters.every(k => G.confirmed.has(k))) nextVoteCategory();
  else broadcast();
}

function finishRound() {
  clearTimer(); G.deadline = 0;
  G.roundResult = computeRoundResult();
  G.history.push({ round: G.round, letter: G.letter });
  G.phase = 'roundResult';
  broadcast();
}

function finalRanking() {
  return [...players.values()].map(p => ({ key: p.key, name: p.name, score: p.score, color: p.color }))
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- estado público
function publicState(forKey) {
  const p = forKey && players.get(forKey);
  const filled = k => (G.answers[k] || []).filter(a => normAnswer(a)).length;
  const s = {
    phase: G.phase, round: G.round, totalRounds: rules.rodadas, letter: G.phase === 'countdown' ? null : G.letter,
    revealLetter: G.letter, categories: G.categories,
    remainingMs: G.deadline ? Math.max(0, G.deadline - Date.now()) : null,
    elapsedMs: G.phase === 'playing' ? Date.now() - G.startedAt : null,
    stopBy: G.stopBy && players.get(G.stopBy) ? players.get(G.stopBy).name : null,
    rules,
    players: [...players.values()].map(x => ({
      key: x.key, name: x.name, score: x.score, connected: x.connected, color: x.color, isHost: !!x.isHost,
      playing: G.participants.includes(x.key), filled: ['playing', 'collecting'].includes(G.phase) ? filled(x.key) : null,
      confirmed: G.phase === 'voting' ? G.confirmed.has(x.key) : null,
    })),
    me: p ? { key: p.key, name: p.name, isHost: !!p.isHost, playing: G.participants.includes(p.key) } : null,
    invite: PUBLIC_URL || LAN_URL,
  };
  if (p && ['playing', 'collecting'].includes(G.phase)) s.myAnswers = G.answers[p.key] || null;
  if (G.phase === 'voting') {
    const ci = G.voteCat, rej = G.rejects[ci] || {};
    s.voting = {
      index: ci, category: G.categories[ci],
      confirmedCount: G.participants.filter(k => G.confirmed.has(k)).length,
      voters: G.participants.filter(k => players.get(k) && players.get(k).connected).length,
      iConfirmed: p ? G.confirmed.has(p.key) : false,
      entries: G.participants.filter(k => players.has(k)).map(k => {
        const answer = (G.answers[k] || [])[ci] || '';
        const set = rej[k] || new Set();
        return {
          key: k, name: players.get(k).name, color: players.get(k).color, answer,
          auto: autoCheck(answer, G.letter), rejects: set.size,
          iRejected: p ? set.has(p.key) : false, mine: p ? p.key === k : false,
          rejected: isRejected(ci, k),
        };
      }),
    };
    // marca repetidas para facilitar a leitura
    const cnt = {};
    s.voting.entries.forEach(e => { if (!e.auto) { const n = normAnswer(e.answer); cnt[n] = (cnt[n] || 0) + 1; } });
    s.voting.entries.forEach(e => { e.repeated = !e.auto && cnt[normAnswer(e.answer)] > 1; });
  }
  if (G.phase === 'roundResult') s.roundResult = G.roundResult;
  if (G.phase === 'roundResult' || G.phase === 'final') s.ranking = finalRanking();
  return s;
}

let broadcastPending = null;
function broadcast() {
  if (broadcastPending) { clearTimeout(broadcastPending); broadcastPending = null; }
  for (const [id, socket] of io.of('/').sockets) socket.emit('state', publicState(socket.data.key));
}
// Versão com limite de frequência (atualização do progresso enquanto digitam)
function broadcastSoon() {
  if (broadcastPending) return;
  broadcastPending = setTimeout(() => { broadcastPending = null; broadcast(); }, 700);
}

// ---------------------------------------------------------------- servidor
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok')); // usado pelo Render para saber se o servidor está de pé

io.on('connection', socket => {
  const wantsHost = socket.handshake.auth && socket.handshake.auth.host;
  socket.data.host = !!wantsHost && (isHostKey(socket.handshake.auth.hostKey) || isLocalSocket(socket));

  socket.emit('hello', { invite: PUBLIC_URL || LAN_URL, name: rules.nomeDoJogo, isHost: socket.data.host });

  socket.on('join', (data, done) => {
    done = typeof done === 'function' ? done : () => {};
    const name = cleanName(data && data.name);
    const key = nameKey(name);
    if (!key) return done({ error: 'Digite um nome.' });
    const token = String((data && data.token) || '').slice(0, 64);
    let p = players.get(key);
    if (p) {
      const old = p.socketId && io.of('/').sockets.get(p.socketId);
      if (old && old.id !== socket.id && p.token !== token) return done({ error: 'Esse nome já está em uso. Escolha outro.' });
      if (old && old.id !== socket.id) old.disconnect(true);
      p.socketId = socket.id; p.connected = true; p.token = token || p.token;
    } else {
      if (players.size >= 40) return done({ error: 'Sala cheia.' });
      p = { key, name, token, socketId: socket.id, connected: true, score: 0, color: COLORS[players.size % COLORS.length], isHost: false };
      players.set(key, p);
    }
    if (socket.data.host) { players.forEach(x => { x.isHost = false; }); p.isHost = true; }
    socket.data.key = key;
    done({ ok: true, key, name: p.name, token: p.token, isHost: p.isHost });
    broadcast();
  });

  const me = () => socket.data.key && players.get(socket.data.key);
  const host = () => { const p = me(); return p && p.isHost; };

  // ---- jogador
  socket.on('answers', list => {
    const p = me();
    if (!p || !['playing', 'collecting'].includes(G.phase) || !G.answers[p.key] || !Array.isArray(list)) return;
    G.answers[p.key] = G.categories.map((_, i) => cleanAnswer(list[i]));
    if (G.phase === 'playing') broadcastSoon();
  });

  socket.on('stop', (list, done) => {
    done = typeof done === 'function' ? done : () => {};
    const p = me();
    if (!p || G.phase !== 'playing' || !G.answers[p.key]) return done({ error: 'Agora não dá.' });
    if (Array.isArray(list)) G.answers[p.key] = G.categories.map((_, i) => cleanAnswer(list[i]));
    const elapsed = (Date.now() - G.startedAt) / 1000;
    if (elapsed < rules.tempoMinimoParaStopSegundos * TIME_SCALE) return done({ error: `Só pode dar STOP depois de ${rules.tempoMinimoParaStopSegundos}s.` });
    if (rules.stopSoComTudoPreenchido && G.answers[p.key].some(a => !normAnswer(a))) return done({ error: 'Preencha todas as categorias para dar STOP.' });
    done({ ok: true });
    endRound(p.key);
  });

  socket.on('vote', ({ target, reject } = {}) => {
    const p = me();
    if (!p || G.phase !== 'voting' || !G.participants.includes(p.key) || target === p.key || !G.participants.includes(target)) return;
    if (G.confirmed.has(p.key)) return;
    const rej = G.rejects[G.voteCat];
    rej[target] = rej[target] || new Set();
    if (reject) rej[target].add(p.key); else rej[target].delete(p.key);
    broadcast();
  });

  socket.on('confirm', () => {
    const p = me();
    if (!p || G.phase !== 'voting' || !G.participants.includes(p.key)) return;
    G.confirmed.add(p.key);
    maybeAllConfirmed();
  });

  // ---- apresentador
  socket.on('host:rules', (data, done) => {
    done = typeof done === 'function' ? done : () => {};
    if (!host()) return done({ error: 'Só o apresentador.' });
    if (G.phase !== 'lobby') return done({ error: 'Só dá para mudar as regras no lobby.' });
    rules = sanitizeRules(data && data.rules, rules);
    if (data && data.persist) {
      try { fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2) + '\n', 'utf8'); }
      catch (e) { return done({ error: 'Não consegui salvar o regras.json: ' + e.message }); }
      // No Render o disco é apagado quando o servidor reinicia: o padrão de verdade é o regras.json do GitHub
      if (ON_RENDER) return done({ ok: true, rules, warning: 'Salvo até o servidor reiniciar. Para fixar de vez, edite o regras.json no GitHub.' });
    }
    done({ ok: true, rules });
    broadcast();
  });

  socket.on('host:start', () => {
    if (!host() || G.phase !== 'lobby') return;
    if (!connectedKeys().length) return;
    players.forEach(p => { p.score = 0; });
    G = freshGame();
    startRound();
  });

  socket.on('host:next', () => {
    if (!host()) return;
    if (G.phase === 'roundResult') {
      if (G.round >= rules.rodadas) { G.phase = 'final'; broadcast(); } else startRound();
    } else if (G.phase === 'playing') endRound(null);              // encerra o tempo agora
    else if (G.phase === 'voting') nextVoteCategory();             // pula a categoria
    else if (G.phase === 'countdown') { clearTimer(); beginPlaying(); }
  });

  socket.on('host:end', () => {             // encerra a partida e mostra o placar final
    if (!host() || G.phase === 'lobby') return;
    clearTimer(); G.deadline = 0; G.phase = 'final'; broadcast();
  });

  socket.on('host:lobby', () => {           // volta todo mundo para o lobby (zera a partida)
    if (!host()) return;
    clearTimer(); G = freshGame(); players.forEach(p => { p.score = 0; }); broadcast();
  });

  socket.on('host:kick', key => {
    if (!host() || !players.has(key) || players.get(key).isHost) return;
    const p = players.get(key);
    const s = p.socketId && io.of('/').sockets.get(p.socketId);
    players.delete(key);
    G.participants = G.participants.filter(k => k !== key);
    if (s) { s.emit('kicked'); s.data.key = null; }
    if (G.phase === 'voting') maybeAllConfirmed(); else broadcast();
  });

  socket.on('disconnect', () => {
    const p = me();
    if (p && p.socketId === socket.id) {
      p.connected = false;
      if (G.phase === 'voting') maybeAllConfirmed(); else broadcast();
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const local = `http://localhost:${PORT}`;
  console.log(`\n🔤  ${rules.nomeDoJogo} está no ar!`);
  console.log(`   💻 Jogadores:            ${PUBLIC_URL || LAN_URL}`);
  console.log(`   🎤 Apresentador (neste notebook): ${local}/?host`);
  console.log(`      ↳ de outro notebook: ${(PUBLIC_URL || LAN_URL)}/?host=${HOST_KEY}  (código secreto, não mande pros jogadores)`);
  if (IPS.length > 1) console.log(`   Outros IPs: ${IPS.slice(1).map(i => i.address).join(', ')}`);
  console.log(`   📜 Regras: ${RULES_FILE}\n`);
});
