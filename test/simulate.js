// Teste do modo com apresentador: 3 jogadores, 2 rodadas (STOP + votação + tempo esgotado), placar e reconexão.
// Uso: npm test   (sobe um servidor de teste próprio na porta 3998, com cronômetros acelerados, e desliga no fim)
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path');
const PORT = process.env.PORT || 3998;
const URL = `http://localhost:${PORT}`;
const HOST_KEY = 'teste';
const wait = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, HOST_KEY, TIME_SCALE: '0.05', RULES_FILE: path.join(__dirname, 'regras-com-apresentador.json') }, stdio: ['ignore', 'pipe', 'inherit'],
});
const srvReady = new Promise(r => srv.stdout.on('data', d => { if (String(d).includes('no ar')) r(); }));
process.on('exit', () => srv.kill());
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failures++; };

function client(name, host) {
  const s = io(URL, { auth: { host, hostKey: host ? HOST_KEY : '' }, forceNew: true });
  const c = { s, name, state: null, token: 'tok-' + name };
  s.on('state', st => { c.state = st; });
  c.join = () => new Promise(r => s.emit('join', { name, token: c.token }, r));
  c.until = async (pred, label, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (c.state && pred(c.state)) return c.state; await wait(30); }
    throw new Error(`timeout esperando: ${label} (fase atual: ${c.state && c.state.phase})`);
  };
  return c;
}

(async () => {
  await srvReady;
  const host = client('Ana', true), b = client('Bruno', false), c = client('Carla', false);
  for (const x of [host, b, c]) { if (!x.s.connected) await new Promise(r => x.s.once('connect', r)); }
  ok((await host.join()).isHost, 'Ana entrou como apresentadora');
  ok(!(await b.join()).isHost, 'Bruno entrou como jogador');
  await c.join();
  const dup = await new Promise(r => client('bruno', false).s.emit('join', { name: 'BRUNO', token: 'x' }, r));
  ok(!!dup.error, 'nome repetido é recusado');

  // regras pelo lobby
  const res = await new Promise(r => host.s.emit('host:rules', { rules: { rodadas: 2, categorias: ['Nome', 'Animal', 'Cor'], tempoRodadaSegundos: 60, tempoMinimoParaStopSegundos: 0, letras: 'B', naoRepetirLetra: false, pontos: { respostaUnica: 10, respostaRepetida: 5, bonusQuemDeuStop: 3 } } }, r));
  ok(res.ok && res.rules.categorias.length === 3 && res.rules.rodadas === 2, 'apresentador mudou as regras');
  const nope = await new Promise(r => b.s.emit('host:rules', { rules: { rodadas: 9 } }, r));
  ok(!!nope.error, 'jogador comum não muda regras');

  // ---- rodada 1
  host.s.emit('host:start');
  await b.until(s => s.phase === 'playing', 'rodada 1 começar');
  ok(b.state.letter === 'B' && b.state.categories.length === 3, 'letra sorteada B com 3 categorias');
  b.s.emit('answers', ['Beatriz', 'Baleia', 'Branco']);
  c.s.emit('answers', ['Bia', 'Baleia', 'Azul']);           // "Azul" = letra errada
  host.s.emit('answers', ['Bruna', 'Boi', '']);             // em branco
  await wait(100);
  const stopFail = await new Promise(r => host.s.emit('stop', ['Bruna', 'Boi', ''], r));
  ok(!!stopFail.error, 'STOP bloqueado sem tudo preenchido');
  const stopOk = await new Promise(r => b.s.emit('stop', ['Beatriz', 'Baleia', 'Branco'], r));
  ok(stopOk.ok, 'Bruno deu STOP');
  await c.until(s => s.phase === 'voting', 'votação');
  ok(c.state.voting.category === 'Nome', 'votação começa pela 1ª categoria');
  // categoria Nome: Ana e Carla invalidam "Beatriz" de Bruno (2 de 2 → invalidada)
  host.s.emit('vote', { target: 'bruno', reject: true });
  c.s.emit('vote', { target: 'bruno', reject: true });
  b.s.emit('vote', { target: 'bruno', reject: true });        // não pode votar em si mesmo
  await wait(100);
  const e = c.state.voting.entries.find(x => x.key === 'bruno');
  ok(e.rejects === 2 && e.rejected, 'resposta invalidada pela maioria (auto-voto ignorado)');
  [host, b, c].forEach(x => x.s.emit('confirm'));
  await c.until(s => s.phase === 'voting' && s.voting.index === 1, 'categoria Animal');
  ok(c.state.voting.entries.filter(x => x.repeated).length === 2, 'Baleia marcada como repetida');
  [host, b, c].forEach(x => x.s.emit('confirm'));
  await c.until(s => s.phase === 'voting' && s.voting.index === 2, 'categoria Cor');
  [host, b, c].forEach(x => x.s.emit('confirm'));
  await host.until(s => s.phase === 'roundResult', 'resultado rodada 1');
  const rr = host.state.roundResult, row = k => rr.rows.find(r => r.key === k);
  // Bruno: Beatriz invalidada 0 + Baleia rep 5 + Branco 10 + bônus 3 = 18
  ok(row('bruno').total === 18, `Bruno fez 18 (fez ${row('bruno').total})`);
  // Carla: Bia 10 + Baleia 5 + Azul 0 = 15
  ok(row('carla').total === 15, `Carla fez 15 (fez ${row('carla').total})`);
  // Ana: Bruna 10 + Boi 10 + vazio 0 = 20
  ok(row('ana').total === 20, `Ana fez 20 (fez ${row('ana').total})`);
  ok(rr.stopBy === 'Bruno', 'resultado mostra quem deu STOP');

  // ---- reconexão durante a rodada 2
  host.s.emit('host:next');
  await b.until(s => s.phase === 'playing' && s.round === 2, 'rodada 2');
  b.s.emit('answers', ['Bento', 'Burro', 'Bege']);
  await wait(100);
  b.s.disconnect();
  const b2 = client('Bruno', false); b2.token = b.token;
  await new Promise(r => b2.s.on('connect', r));
  await b2.join();
  await b2.until(s => s.myAnswers, 'respostas restauradas');
  ok(b2.state.myAnswers[0] === 'Bento', 'reconectou e recuperou as respostas');
  // tempo esgota (60s * 0.05 = 3s)
  await host.until(s => s.phase === 'voting', 'votação rodada 2 por tempo', 10000);
  ok(host.state.stopBy === null, 'rodada 2 acabou no tempo');
  host.s.emit('host:next'); // pula categorias
  await wait(50); host.s.emit('host:next');
  await wait(50); host.s.emit('host:next');
  await host.until(s => s.phase === 'roundResult', 'resultado rodada 2');
  host.s.emit('host:next');
  await host.until(s => s.phase === 'final', 'final');
  ok(host.state.ranking[0].key === 'bruno' && host.state.ranking[0].score === 48, `Bruno campeão com 48 (${JSON.stringify(host.state.ranking.map(r => [r.name, r.score]))})`);

  host.s.emit('host:lobby');
  await c.until(s => s.phase === 'lobby', 'volta ao lobby');
  ok(c.state.players.every(p => p.score === 0), 'placar zerado no lobby');

  console.log(failures ? `\n${failures} falha(s)` : '\nTudo certo!');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
