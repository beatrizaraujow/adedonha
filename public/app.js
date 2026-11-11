// ADEDONHA — cliente do jogador (e do apresentador)
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem('adedonha.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('adedonha.' + k, v); } catch { /* sem storage */ } },
  };
  // Identidade por aba: recarregar a página volta como o mesmo jogador; outra aba entra como outro jogador
  const tab = {
    get(k) { try { return sessionStorage.getItem('adedonha.' + k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem('adedonha.' + k, v); } catch { /* sem storage */ } },
  };
  const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

  // ---- apresentador: ?host (no notebook do servidor) ou ?host=CÓDIGO
  const params = new URLSearchParams(location.search);
  const wantsHost = params.has('host');
  const socket = io({ auth: { host: wantsHost, hostKey: params.get('host') || '' } });

  let S = null;           // último estado do servidor
  let me = null;          // { key, name, isHost }
  let token = tab.get('token') || Math.random().toString(36).slice(2) + Date.now().toString(36);
  tab.set('token', token);
  let deadline = 0;       // fim local da fase
  let startLocal = 0;     // início local da rodada (para o STOP mínimo)
  let builtRound = -1;    // rodada cujo formulário já foi montado
  let answers = [];
  let lastPhase = null;
  let sound = store.get('sound') !== 'off';

  // ---------------------------------------------------------------- som
  let actx = null;
  function beep(freq = 660, dur = 0.12, type = 'square', vol = 0.06) {
    if (!sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = freq; g.gain.value = vol;
      o.connect(g); g.connect(actx.destination);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
      o.start(); o.stop(actx.currentTime + dur);
    } catch { /* sem áudio */ }
  }
  $('soundBtn').onclick = () => { sound = !sound; store.set('sound', sound ? 'on' : 'off'); $('soundBtn').textContent = sound ? '🔊' : '🔇'; };
  $('soundBtn').textContent = sound ? '🔊' : '🔇';

  // ---------------------------------------------------------------- utilidades de tela
  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('hidden', s.id !== id));
  }
  let toastT = null;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const avatar = p => `<span class="avatar" style="background:${p.color}">${esc((p.name || '?')[0].toUpperCase())}</span>`;

  // ---------------------------------------------------------------- entrar
  $('hostHint').classList.toggle('hidden', !wantsHost);
  let savedName = tab.get('name');
  $('nameInput').value = savedName || store.get('name') || '';

  function join(name) {
    socket.emit('join', { name, token }, res => {
      if (res.error) { $('joinError').textContent = res.error; return; }
      me = { key: res.key, name: res.name, isHost: res.isHost };
      token = res.token || token; tab.set('token', token); tab.set('name', res.name); store.set('name', res.name);
      $('joinError').textContent = '';
      if (S) render();
    });
  }
  $('joinForm').onsubmit = e => { e.preventDefault(); join($('nameInput').value); };

  socket.on('connect', () => { if (me || savedName) join(me ? me.name : savedName); });
  socket.on('hello', h => { $('gameName').textContent = h.name; $('joinTitle').textContent = h.name; document.title = h.name; });
  socket.on('kicked', () => { me = null; savedName = null; tab.set('name', ''); show('scr-join'); toast('Você foi removido da sala.'); });
  socket.on('disconnect', () => toast('Conexão perdida… tentando voltar.'));

  socket.on('state', st => {
    S = st;
    if (st.remainingMs != null) deadline = Date.now() + st.remainingMs; else deadline = 0;
    if (st.elapsedMs != null) startLocal = Date.now() - st.elapsedMs;
    if (st.me) me = st.me;
    render();
  });

  socket.on('collect', () => {
    readAnswers();
    socket.emit('answers', answers);
    lockAnswers(true);
  });

  // ---------------------------------------------------------------- render principal
  function render() {
    const phaseChanged = S.phase !== lastPhase;
    $('hostHint').classList.toggle('hidden', !wantsHost || S.auto);
    $('gameName').textContent = S.rules.nomeDoJogo;
    document.title = S.rules.nomeDoJogo;
    const inGame = !['lobby', 'final'].includes(S.phase);
    $('roundInfo').classList.toggle('hidden', !inGame);
    $('roundInfo').textContent = `Rodada ${S.round}/${S.totalRounds}`;

    if (!me) { show('scr-join'); renderHostBar(); lastPhase = S.phase; return; }

    const playing = S.me && S.me.playing;
    switch (S.phase) {
      case 'lobby': renderLobby(); break;
      case 'countdown': if (playing) renderCountdown(phaseChanged); else show('scr-spectate'); break;
      case 'playing': case 'collecting': if (playing) renderPlay(phaseChanged); else show('scr-spectate'); break;
      case 'voting': renderVote(phaseChanged); break;
      case 'roundResult': renderResult(); break;
      case 'final': renderFinal(phaseChanged); break;
    }
    if (S.phase === 'collecting' && phaseChanged) showStop();
    if (S.phase !== 'collecting') $('stopOverlay').classList.add('hidden');
    renderHostBar();
    lastPhase = S.phase;
  }

  // ---------------------------------------------------------------- lobby
  let rulesFormFilled = false;
  function renderLobby() {
    show('scr-lobby');
    builtRound = -1;
    const isHost = me && me.isHost;
    $('lobbyCount').textContent = `(${S.players.filter(p => p.connected).length})`;
    $('lobbyPlayers').innerHTML = S.players.map(p => `
      <li class="${p.connected ? '' : 'off'}">${avatar(p)}<span class="pname">${esc(p.name)}</span>
        ${p.isHost ? '<span class="tag">apresentador</span>' : ''}
        ${p.key === me.key ? '<span class="tag tag-me">você</span>' : ''}
        ${isHost && !p.isHost ? `<button class="kick" data-kick="${esc(p.key)}" title="Remover ${esc(p.name)}" aria-label="Remover ${esc(p.name)}">✕</button>` : ''}
      </li>`).join('');
    $('inviteUrl').textContent = S.invite;
    $('waitHost').classList.toggle('hidden', isHost || S.auto);
    $('autoStatus').classList.toggle('hidden', !S.auto);
    updateAutoTexts();
    $('startBtn').classList.toggle('hidden', !isHost);
    $('rulesForm').classList.toggle('hidden', !isHost);
    $('rulesView').classList.toggle('hidden', isHost);
    if (isHost) { if (!rulesFormFilled) { fillRulesForm(S.rules); rulesFormFilled = true; } }
    else $('rulesView').innerHTML = rulesSummary(S.rules);
  }

  function rulesSummary(r) {
    return `
      <ul class="rules-list">
        <li><b>${r.rodadas}</b> rodadas de <b>${r.tempoRodadaSegundos}s</b></li>
        <li>STOP liberado depois de <b>${r.tempoMinimoParaStopSegundos}s</b>${r.stopSoComTudoPreenchido ? ' e só com tudo preenchido' : ''}</li>
        <li>Resposta única: <b>${r.pontos.respostaUnica}</b> pts · repetida: <b>${r.pontos.respostaRepetida}</b> pts${r.pontos.bonusQuemDeuStop ? ` · bônus STOP: <b>${r.pontos.bonusQuemDeuStop}</b>` : ''}</li>
        <li>${r.votacao.ligada ? 'Depois de cada rodada a galera vota nas respostas que não valem' : 'Sem votação: vale tudo que começa com a letra'}</li>
        <li>Letras: <b>${esc(r.letras.split('').join(' '))}</b></li>
        ${r.automatico.ligado ? `<li>Começa sozinha <b>${r.automatico.esperaParaComecarSegundos}s</b> depois de ter <b>${r.automatico.minimoJogadores}</b> jogadores na sala</li>` : ''}
      </ul>
      <p class="muted">Categorias${r.categoriasPorRodada ? ` (${r.categoriasPorRodada} sorteadas por rodada)` : ''}:</p>
      <div class="chips">${r.categorias.map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>`;
  }

  function fillRulesForm(r) {
    $('r-nome').value = r.nomeDoJogo; $('r-rodadas').value = r.rodadas; $('r-tempo').value = r.tempoRodadaSegundos;
    $('r-min').value = r.tempoMinimoParaStopSegundos; $('r-cheio').checked = r.stopSoComTudoPreenchido;
    $('r-cats').value = r.categorias.join('\n'); $('r-catsN').value = r.categoriasPorRodada; $('r-letras').value = r.letras;
    $('r-norep').checked = r.naoRepetirLetra; $('r-unica').value = r.pontos.respostaUnica; $('r-rep').value = r.pontos.respostaRepetida;
    $('r-bonus').value = r.pontos.bonusQuemDeuStop; $('r-voto').checked = r.votacao.ligada;
    $('r-vtempo').value = r.votacao.tempoPorCategoriaSegundos; $('r-vthr').value = Math.round(r.votacao.invalidaSeRejeitadaPorMaisDe * 100);
  }
  function readRulesForm() {
    return {
      nomeDoJogo: $('r-nome').value, rodadas: $('r-rodadas').value, tempoRodadaSegundos: $('r-tempo').value,
      tempoMinimoParaStopSegundos: $('r-min').value, stopSoComTudoPreenchido: $('r-cheio').checked,
      categorias: $('r-cats').value.split('\n'), categoriasPorRodada: $('r-catsN').value, letras: $('r-letras').value,
      naoRepetirLetra: $('r-norep').checked,
      pontos: { respostaUnica: $('r-unica').value, respostaRepetida: $('r-rep').value, bonusQuemDeuStop: $('r-bonus').value },
      votacao: { ligada: $('r-voto').checked, tempoPorCategoriaSegundos: $('r-vtempo').value, invalidaSeRejeitadaPorMaisDe: Number($('r-vthr').value) / 100 },
    };
  }
  function sendRules(persist, after) {
    socket.emit('host:rules', { rules: readRulesForm(), persist }, res => {
      if (res.error) { $('rulesMsg').textContent = res.error; return; }
      fillRulesForm(res.rules);
      $('rulesMsg').textContent = res.warning || (persist ? 'Salvo no regras.json ✓' : 'Regras aplicadas ✓');
      setTimeout(() => { $('rulesMsg').textContent = ''; }, res.warning ? 8000 : 2500);
      if (after) after();
    });
  }
  $('rulesForm').onsubmit = e => { e.preventDefault(); sendRules(false); };
  $('saveRulesBtn').onclick = () => sendRules(true);
  $('startBtn').onclick = () => sendRules(false, () => socket.emit('host:start'));
  $('lobbyPlayers').onclick = e => {
    const k = e.target.closest('[data-kick]');
    if (k && confirm('Remover esse jogador da sala?')) socket.emit('host:kick', k.dataset.kick);
  };
  $('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(S.invite); toast('Link copiado!'); }
    catch { toast('Copie o link manualmente.'); }
  };

  // ---------------------------------------------------------------- contagem
  function renderCountdown(changed) {
    show('scr-countdown');
    $('cdRound').textContent = `Rodada ${S.round} de ${S.totalRounds}`;
    if (!changed) return;
    // "roleta" de letras até revelar
    const tile = $('cdLetter'), letters = S.rules.letras.split('');
    let n = 0; tile.classList.add('spin'); tile.classList.remove('reveal');
    clearInterval(renderCountdown.t);
    renderCountdown.t = setInterval(() => {
      n++;
      tile.textContent = letters[Math.floor(Math.random() * letters.length)];
      beep(300 + (n % 6) * 60, 0.05, 'square', 0.03);
      if (n > 22) {
        clearInterval(renderCountdown.t);
        tile.textContent = S.revealLetter; tile.classList.remove('spin'); tile.classList.add('reveal');
        beep(880, 0.25, 'triangle', 0.08);
      }
    }, 90);
  }

  // ---------------------------------------------------------------- jogando
  function buildAnswers() {
    builtRound = S.round;
    answers = S.myAnswers ? S.myAnswers.slice() : S.categories.map(() => '');
    $('answersForm').innerHTML = S.categories.map((c, i) => `
      <div class="answer">
        <label for="ans-${i}">${esc(c)}</label>
        <input id="ans-${i}" data-i="${i}" maxlength="40" autocapitalize="words" spellcheck="false" value="${esc(answers[i])}">
      </div>`).join('');
    lockAnswers(false);
    const first = $('ans-0'); if (first && !matchMedia('(pointer:coarse)').matches) first.focus();
  }
  function readAnswers() {
    if (builtRound !== S.round) return;
    answers = S.categories.map((_, i) => ($('ans-' + i) || {}).value || '');
  }
  function lockAnswers(lock) { $('answersForm').querySelectorAll('input').forEach(i => { i.disabled = lock; }); }

  let sendT = null;
  $('answersForm').addEventListener('input', e => {
    const inp = e.target.closest('input'); if (!inp) return;
    readAnswers(); markInputs(); updateStop();
    clearTimeout(sendT); sendT = setTimeout(() => socket.emit('answers', answers), 400);
  });
  $('answersForm').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const i = Number(e.target.dataset.i);
    const next = $('ans-' + (i + 1));
    if (next) next.focus(); else $('stopBtn').focus();
  });
  $('answersForm').onsubmit = e => e.preventDefault();

  function markInputs() {
    if (!S || !S.letter) return;
    S.categories.forEach((_, i) => {
      const inp = $('ans-' + i); if (!inp) return;
      const v = fold(inp.value);
      inp.classList.toggle('bad', !!v && v[0].toUpperCase() !== S.letter);
      inp.classList.toggle('good', !!v && v[0].toUpperCase() === S.letter);
    });
  }

  function renderPlay(changed) {
    show('scr-play');
    if (builtRound !== S.round) buildAnswers();
    $('playLetter').textContent = S.letter;
    markInputs();
    const collecting = S.phase === 'collecting';
    if (collecting) lockAnswers(true);
    $('playPlayers').innerHTML = S.players.filter(p => p.playing).map(p => {
      const pct = S.categories.length ? Math.round((p.filled || 0) / S.categories.length * 100) : 0;
      return `<li class="${p.connected ? '' : 'off'}">${avatar(p)}<span class="pname">${esc(p.name)}</span>
        <span class="mini-bar"><span style="width:${pct}%"></span></span><span class="muted small">${p.filled || 0}/${S.categories.length}</span></li>`;
    }).join('');
    updateStop();
  }

  function stopReason() {
    if (!S || S.phase !== 'playing') return 'Rodada encerrada.';
    const elapsed = (Date.now() - startLocal) / 1000;
    const min = S.rules.tempoMinimoParaStopSegundos;
    if (elapsed < min) return `STOP liberado em ${Math.ceil(min - elapsed)}s`;
    if (S.rules.stopSoComTudoPreenchido && answers.some(a => !fold(a))) return 'Preencha tudo para dar STOP';
    return '';
  }
  function updateStop() {
    const r = stopReason();
    $('stopBtn').disabled = !!r;
    $('stopHint').textContent = r;
  }
  $('stopBtn').onclick = () => {
    readAnswers();
    socket.emit('stop', answers, res => { if (res && res.error) toast(res.error); });
  };

  function showStop() {
    $('stopWho').textContent = S.stopBy ? `${S.stopBy} deu STOP!` : 'Acabou o tempo!';
    $('stopOverlay').classList.remove('hidden');
    beep(220, 0.35, 'sawtooth', 0.08);
  }

  // ---------------------------------------------------------------- votação
  function renderVote(changed) {
    show('scr-vote');
    const v = S.voting;
    if (changed || renderVote.idx !== v.index) { beep(520, 0.08); renderVote.idx = v.index; }
    $('voteLetter').textContent = S.letter;
    $('voteStep').textContent = `Categoria ${v.index + 1} de ${S.categories.length}`;
    $('voteCat').textContent = v.category;
    const canVote = S.me && S.me.playing && !v.iConfirmed;
    $('voteList').innerHTML = v.entries.map(e => {
      let badge = '', cls = '';
      if (e.auto === 'vazio') { badge = '<span class="badge b-off">em branco</span>'; cls = 'auto'; }
      else if (e.auto === 'letra') { badge = '<span class="badge b-off">letra errada</span>'; cls = 'auto'; }
      else if (e.rejected) { badge = '<span class="badge b-bad">invalidada</span>'; cls = 'rejected'; }
      else if (e.repeated) badge = '<span class="badge b-rep">repetida</span>';
      const btn = (e.auto || e.mine) ? (e.mine ? '<span class="muted small">sua</span>' : '')
        : `<button class="vote-btn ${e.iRejected ? 'on' : ''}" data-target="${esc(e.key)}" data-rej="${e.iRejected ? 0 : 1}" ${canVote ? '' : 'disabled'}
             aria-pressed="${e.iRejected}" title="${e.iRejected ? 'Você marcou como inválida' : 'Marcar como inválida'}">✗</button>`;
      return `<li class="vote-item ${cls}">
        ${avatar(e)}<div class="vote-main"><span class="vote-name">${esc(e.name)}</span>
        <span class="vote-answer">${e.answer ? esc(e.answer) : '—'}</span></div>
        ${badge}${!e.auto && e.rejects ? `<span class="rej-count" title="votos contra">✗ ${e.rejects}</span>` : ''}${btn}</li>`;
    }).join('');
    $('confirmBtn').disabled = !canVote;
    $('confirmBtn').textContent = v.iConfirmed ? 'Confirmado ✓' : 'Confirmar ✓';
    $('confirmBtn').classList.toggle('hidden', !(S.me && S.me.playing));
    $('voteProgress').textContent = `${v.confirmedCount}/${v.voters} confirmaram`;
  }
  $('voteList').onclick = e => {
    const b = e.target.closest('.vote-btn'); if (!b || b.disabled) return;
    socket.emit('vote', { target: b.dataset.target, reject: b.dataset.rej === '1' });
  };
  $('confirmBtn').onclick = () => socket.emit('confirm');

  // ---------------------------------------------------------------- resultado
  const STATUS = { unica: 'única', repetida: 'repetida', rejeitada: 'invalidada', vazio: 'em branco', letra: 'letra errada' };
  function renderResult() {
    show('scr-result');
    const r = S.roundResult;
    $('resLetter').textContent = r.letter;
    $('resRound').textContent = `Rodada ${r.round} de ${S.totalRounds}`;
    $('resStop').textContent = r.stopBy ? `${r.stopBy} deu STOP${r.stopBonus ? ` (+${r.stopBonus} de bônus)` : ''}.` : 'A rodada acabou no tempo.';
    $('resTable').innerHTML = `
      <thead><tr><th>Jogador</th>${r.categories.map(c => `<th>${esc(c)}</th>`).join('')}<th>Total</th></tr></thead>
      <tbody>${r.rows.map(row => `<tr class="${me && row.key === me.key ? 'me' : ''}"><th>${esc(row.name)}</th>${row.cells.map(c =>
        `<td class="st-${c.status}" title="${STATUS[c.status]}"><span class="cell-ans">${c.answer ? esc(c.answer) : '—'}</span><span class="cell-pts">${c.points}</span></td>`).join('')}
        <td class="total">${row.total}</td></tr>`).join('')}</tbody>`;
    $('resRanking').innerHTML = rankingHTML(S.ranking);
    $('resWait').classList.toggle('hidden', !!(me && me.isHost));
    updateAutoTexts();
  }
  const rankingHTML = list => list.map((p, i) => `<li class="${me && p.key === me.key ? 'me' : ''}"><span class="pos">${i + 1}º</span>${avatar(p)}<span class="pname">${esc(p.name)}</span><b>${p.score}</b></li>`).join('');

  // ---------------------------------------------------------------- final
  function renderFinal(changed) {
    show('scr-final');
    const r = S.ranking;
    const order = [1, 0, 2].filter(i => r[i]);
    $('podium').innerHTML = order.map(i => `
      <div class="podium-col p${i + 1}">${avatar(r[i])}<span class="pname">${esc(r[i].name)}</span><span class="pscore">${r[i].score} pts</span>
        <div class="podium-block">${i + 1}º</div></div>`).join('');
    $('finalRanking').innerHTML = rankingHTML(r);
    $('finalWait').classList.toggle('hidden', !S.auto);
    updateAutoTexts();
    if (changed) { beep(523, 0.15, 'triangle'); setTimeout(() => beep(659, 0.15, 'triangle'), 160); setTimeout(() => beep(784, 0.3, 'triangle'), 320); }
  }

  // ---------------------------------------------------------------- barra do apresentador
  function renderHostBar() {
    const isHost = !!(me && me.isHost && S);
    $('hostBar').classList.toggle('hidden', !isHost || S.phase === 'lobby');
    document.body.classList.toggle('has-hostbar', isHost && S.phase !== 'lobby');
    if (!isHost) return;
    const label = {
      countdown: '⏩ Começar já', playing: '⏹ Encerrar tempo', voting: '⏭ Pular categoria',
      roundResult: S.round >= S.totalRounds ? '🏁 Ver resultado final' : '▶ Próxima rodada',
    }[S.phase];
    $('hNext').classList.toggle('hidden', !label);
    if (label) $('hNext').textContent = label;
    $('hEnd').classList.toggle('hidden', ['lobby', 'final'].includes(S.phase));
    $('hLobby').classList.toggle('hidden', S.phase === 'lobby');
    $('hLobby').textContent = S.phase === 'final' ? '♻ Jogar de novo' : '♻ Voltar ao lobby';
  }
  $('hNext').onclick = () => socket.emit('host:next');
  $('hEnd').onclick = () => { if (confirm('Encerrar a partida agora e mostrar o placar final?')) socket.emit('host:end'); };
  $('hLobby').onclick = () => {
    if (S.phase === 'final' || confirm('Voltar todo mundo ao lobby? Os pontos serão zerados.')) { rulesFormFilled = false; socket.emit('host:lobby'); }
  };

  // ---------------------------------------------------------------- modo automático (textos com contagem)
  function updateAutoTexts() {
    if (!S || !S.auto) return;
    const secs = deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null;
    if (S.phase === 'lobby') {
      const min = S.rules.automatico.minimoJogadores, n = S.connectedCount;
      $('autoStatus').innerHTML = secs != null
        ? `<span class="auto-big">${secs}</span><span>A partida começa em ${secs}s. Quem entrar até lá já joga!</span>`
        : `<span class="auto-big">${n}/${min}</span><span>Esperando jogadores: ${min - n === 1 ? 'falta 1' : `faltam ${min - n}`} para começar.</span>`;
    } else if (S.phase === 'roundResult') {
      $('resWait').textContent = secs == null ? '' : S.round >= S.totalRounds ? `Resultado final em ${secs}s…` : `Próxima rodada em ${secs}s…`;
    } else if (S.phase === 'final') {
      $('finalWait').textContent = secs == null ? '' : `Nova partida em ${secs}s…`;
    }
  }

  // ---------------------------------------------------------------- relógio
  setInterval(() => {
    if (!S) return;
    updateAutoTexts();
    const left = deadline ? deadline - Date.now() : null;
    if (S.phase === 'playing') {
      const total = S.rules.tempoRodadaSegundos * 1000;
      $('playTimer').textContent = fmt(left);
      $('playBar').style.width = `${Math.max(0, Math.min(100, left / total * 100))}%`;
      $('playBar').classList.toggle('low', left < 15000);
      $('playStatus').textContent = '';
      updateStop();
    } else if (S.phase === 'collecting') {
      $('playStatus').textContent = ' · recolhendo respostas…';
    }
    if (S.phase === 'voting') $('voteTimer').textContent = left != null ? fmt(left) : '';
  }, 250);
})();
