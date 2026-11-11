// Teste do modo automático (sem apresentador): contagem no lobby, cancelamento, rodada, resultado, final e volta ao lobby.
// Uso: npm test   (sobe um servidor próprio na porta 3997 com cronômetros acelerados 20x e desliga no fim)
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path');
const PORT = 3997;
const URL = `http://localhost:${PORT}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, HOST_KEY: 'teste', TIME_SCALE: '0.05', RULES_FILE: path.join(__dirname, 'regras-auto.json') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const srvReady = new Promise(r => srv.stdout.on('data', d => { if (String(d).includes('no ar')) r(); }));
process.on('exit', () => srv.kill());
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failures++; };

async function client(name, wantsHost = false) {
  const s = io(URL, { auth: { host: wantsHost, hostKey: wantsHost ? 'teste' : '' }, forceNew: true });
  const c = { s, name, state: null };
  s.on('state', st => { c.state = st; });
  await new Promise(r => s.once('connect', r));
  c.res = await new Promise(r => s.emit('join', { name, token: 'tok-' + name }, r));
  c.until = async (pred, label, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (c.state && pred(c.state)) return c.state; await wait(25); }
    throw new Error(`timeout esperando: ${label} (fase: ${c.state && c.state.phase})`);
  };
  return c;
}

(async () => {
  await srvReady;
  const a = await client('Ana', true); // pede para ser apresentadora, mas no modo automático não vira
  ok(!a.res.isHost, 'ninguém vira apresentador no modo automático, nem com o código');
  await a.until(s => s.phase === 'lobby' && s.connectedCount === 1, 'lobby com 1');
  ok(a.state.auto && a.state.remainingMs === null, 'com 1 jogador (mínimo 2) não começa a contagem');

  const b = await client('Bruno');
  await a.until(s => s.remainingMs !== null, 'contagem com 2');
  ok(true, 'com 2 jogadores a contagem para começar dispara');

  b.s.disconnect();
  await a.until(s => s.remainingMs === null && s.players.length === 1, 'cancelar contagem');
  ok(true, 'Bruno saiu: contagem cancelada e ele some da lista');

  const b2 = await client('Bruno');
  const c = await client('Carla');
  await a.until(s => s.phase === 'playing', 'partida começar sozinha');
  ok(a.state.letter === 'C' && a.state.players.filter(p => p.playing).length === 3, 'partida começou sozinha com os 3');

  b2.s.emit('answers', ['Caio', 'Cavalo']);
  c.s.emit('answers', ['Carla', 'Cavalo']);
  const stop = await new Promise(r => a.s.emit('stop', ['Cecília', 'Cobra'], r));
  ok(stop.ok, 'STOP funciona sem apresentador');
  await a.until(s => s.phase === 'voting', 'votação');
  [a, b2, c].forEach(x => x.s.emit('confirm'));
  await a.until(s => s.phase === 'voting' && s.voting.index === 1, 'categoria 2');
  // ninguém confirma a 2ª categoria: o tempo (40s × 0.05 = 2s) fecha sozinho
  await a.until(s => s.phase === 'roundResult', 'resultado pelo tempo da votação', 5000);
  ok(a.state.remainingMs !== null, 'resultado mostra a contagem para seguir');
  const row = k => a.state.roundResult.rows.find(r => r.key === k).total;
  ok(row('ana') === 20 && row('bruno') === 15 && row('carla') === 15, `pontos certos (Ana ${row('ana')}, Bruno ${row('bruno')}, Carla ${row('carla')})`);

  await a.until(s => s.phase === 'final', 'final sozinho', 4000);
  ok(a.state.ranking[0].name === 'Ana', 'pódio aparece sozinho depois da última rodada');

  c.s.disconnect(); // Carla vai embora no pódio
  await a.until(s => s.phase === 'lobby', 'volta ao lobby sozinho', 5000);
  ok(a.state.players.every(p => p.score === 0), 'nova partida com placar zerado');
  ok(!a.state.players.some(p => p.key === 'carla'), 'quem saiu não fica na lista do lobby');
  ok(a.state.remainingMs !== null, 'com 2 conectados a contagem da próxima partida já começa');

  console.log(failures ? `\n${failures} falha(s)` : '\nModo automático: tudo certo!');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
