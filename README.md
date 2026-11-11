# 🔤 ADEDONHA

Adedonha (Stop) multiplayer para a equipe. Cada um joga no **próprio notebook ou celular**.

**Modo automático (padrão):** não tem apresentador. É só mandar o link: quando a sala tem o mínimo de jogadores,
começa uma contagem e a partida inicia sozinha. Resultado, próxima rodada, pódio e a volta ao lobby também avançam por tempo.

**Modo com apresentador** (`"automatico": { "ligado": false }` no `regras.json`): um dos jogadores controla a partida
e pode mudar as regras pelo lobby. As seções sobre apresentador abaixo valem só para esse modo.

## Modo automático

| Campo em `regras.json` → `automatico` | O que faz |
|---|---|
| `ligado` | `true` = sem apresentador; `false` = volta o modo com apresentador |
| `minimoJogadores` | Quantas pessoas precisam estar na sala para a contagem começar |
| `esperaParaComecarSegundos` | Duração da contagem (quem entrar até o fim já joga). Se alguém sair e ficar abaixo do mínimo, a contagem cancela |
| `tempoNoResultadoSegundos` | Quanto tempo o resultado da rodada fica na tela antes da próxima |
| `tempoNoFinalSegundos` | Quanto tempo o pódio fica na tela antes de voltar ao lobby |

- Quem entra no meio de uma partida joga a partir da próxima rodada.
- No modo automático a votação sempre tem tempo: se `tempoPorCategoriaSegundos` for `0`, vale 60s.
- Se todo mundo sair no meio, o jogo volta para o lobby.

## Como rodar

Precisa do **Node.js 18+** no notebook que vai ser o servidor.

```bash
cd adedonha
npm install
npm start
```

O terminal mostra:

```
🔤  ADEDONHA está no ar!
   💻 Jogadores:            http://192.168.0.10:3001
   🎤 Apresentador (neste notebook): http://localhost:3001/?host
      ↳ de outro notebook: http://192.168.0.10:3001/?host=k3x9p  (código secreto, não mande pros jogadores)
```

1. O apresentador abre **http://localhost:3001/?host** e entra com o nome.
2. No lobby aparece o **link do jogo** com o botão **Copiar**: mande no grupo.
3. A galera entra com o nome. O apresentador ajusta as regras (se quiser) e clica em **▶ Iniciar partida**.

Mesmo esquema do BONÉ IMPOSSÍVEL: todos no mesmo Wi-Fi, ou um túnel (`npx cloudflared tunnel --url http://localhost:3001`)
para quem estiver em outro lugar. A porta é **3001**, então dá para rodar os dois jogos ao mesmo tempo. Outra porta: `PORT=4000 npm start`.

## Online no Render (link fixo)

O jogo está configurado para o Render (arquivo `render.yaml`).

- **Jogadores:** `https://SEU-ENDERECO.onrender.com`
- **Apresentador** (só no modo com apresentador): `https://SEU-ENDERECO.onrender.com/?host=CÓDIGO`. O CÓDIGO é o `HOST_KEY` definido no painel do Render, em *Environment*.
- **Atualizar o jogo:** todo `git push` para o GitHub faz o Render publicar a versão nova sozinho.
- **Mudar as regras de vez:** edite o `regras.json` no GitHub. O botão "Salvar como padrão" do lobby só dura até o servidor reiniciar.
- **Plano grátis:** depois de ~15 min sem ninguém, o servidor dorme. O primeiro acesso depois disso demora ~1 min para acordar, e a partida em andamento se perde. Abra o link um minutinho antes de chamar a galera.

## Como funciona uma rodada

1. **Sorteio:** uma letra é sorteada para todo mundo.
2. **Respondendo:** cada um preenche as categorias. O campo fica verde quando começa com a letra certa e vermelho quando não.
3. **STOP:** quem terminar aperta **STOP!** e a rodada acaba para todos (ou acaba quando o tempo zera).
4. **Votação:** categoria por categoria, todo mundo vê as respostas e marca **✗** nas que não valem. Ninguém vota na própria.
   Em branco e letra errada são zeradas automaticamente.
5. **Pontos:** resposta válida e única vale 10, repetida (igual à de outra pessoa) vale 5. Para comparar, acentos, maiúsculas e pontuação são ignorados.
6. **Resultado:** tabela da rodada e placar geral. O apresentador avança para a próxima.

Depois da última rodada aparece o pódio.

## As suas regras

Tudo fica em **`regras.json`**. Também dá para mudar pelo lobby (formulário do apresentador):
**Aplicar** vale só para esta partida e **Salvar como padrão** grava no `regras.json`.

| Campo | O que faz |
|---|---|
| `nomeDoJogo` | Nome que aparece no topo |
| `rodadas` | Quantas rodadas a partida tem |
| `tempoRodadaSegundos` | Tempo máximo de cada rodada |
| `tempoMinimoParaStopSegundos` | O botão STOP só libera depois desse tempo |
| `stopSoComTudoPreenchido` | `true` = só dá STOP com todas as categorias preenchidas |
| `letras` | Letras que podem ser sorteadas (ex.: tire K, W, X, Y) |
| `naoRepetirLetra` | Não sorteia a mesma letra duas vezes na partida |
| `categorias` | Lista de categorias (até 20) |
| `categoriasPorRodada` | `0` = todas; um número = sorteia essa quantidade a cada rodada |
| `pontos.respostaUnica` | Pontos de resposta válida que ninguém mais deu |
| `pontos.respostaRepetida` | Pontos de resposta válida repetida |
| `pontos.bonusQuemDeuStop` | Bônus para quem apertou STOP (pode ser negativo, como punição) |
| `votacao.ligada` | `false` = sem votação, vale tudo que começa com a letra |
| `votacao.tempoPorCategoriaSegundos` | Tempo para votar cada categoria (`0` = sem limite) |
| `votacao.invalidaSeRejeitadaPorMaisDe` | Fração dos votos para invalidar (`0.5` = mais da metade) |

Se a regra que você quer não cabe nesses campos (ex.: bônus por resposta mais longa, categoria que vale o dobro),
a pontuação está toda na função `computeRoundResult` do `server.js`.

## Controles do apresentador (barra embaixo)

| Botão | O que faz |
|---|---|
| ⏩ Começar já | Pula a animação do sorteio |
| ⏹ Encerrar tempo | Acaba a rodada agora (como se o tempo zerasse) |
| ⏭ Pular categoria | Fecha a votação da categoria atual |
| ▶ Próxima rodada / 🏁 Ver resultado final | Avança depois do resultado |
| 🏁 Encerrar partida | Vai direto para o pódio |
| ♻ Voltar ao lobby / Jogar de novo | Zera os pontos e volta ao lobby |

No lobby, o apresentador remove um jogador clicando no **✕** ao lado do nome.

## Situações comuns

- **Recarregou a página?** Volta sozinho como o mesmo jogador, com as respostas da rodada.
- **Entrou no meio da rodada?** Espera e joga a partir da próxima.
- **Alguém caiu durante a votação?** A votação não fica esperando quem está desconectado.

## Teste automático

```bash
npm test
```

Sobe servidores de teste nas portas 3998 e 3997 e simula partidas completas nos dois modos
(STOP, votação, repetidas, letra errada, reconexão, placar, início e avanço automáticos).

## Arquivos

- `server.js`: servidor (Express + Socket.io), todo o estado do jogo em memória
- `regras.json`: as regras
- `public/index.html`, `app.js`, `app.css`: a tela do jogo (jogador e apresentador)
- `test/simulate.js`: teste da partida completa

Obs.: o estado fica só na memória, então **reiniciar o servidor apaga a partida**.
