const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n) => n.toLocaleString('pt-BR');
const ROTULO = {
  aguardando: 'Aguardando', baixando: 'Baixando', pausada: 'Pausada', pausando: 'Pausando…',
  baixado: 'Baixado', baixado_com_erros: 'Concluída c/ erros',
};

function fmtBytes(b) {
  if (b == null) return '—';
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < unidades.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i ? 1 : 0)} ${unidades[i]}`;
}

function linhaUf(u) {
  const pct = u.total ? Math.floor(((u.concluidas + u.erros) / u.total) * 100) : 0;
  const acao = u.pausada ? 'iniciar' : 'pausar';
  return `<tr class="${esc(u.status)}">
    <td>${esc(u.uf.toUpperCase())}</td>
    <td>${esc(ROTULO[u.status] ?? u.status)}</td>
    <td>${num(u.concluidas)} / ${num(u.total)}</td>
    <td><progress max="100" value="${pct}"></progress> ${pct}%</td>
    <td>${u.erros ? `<b class="erro">${num(u.erros)}</b>` : '0'}</td>
    <td>${num(u.semArquivos)}</td>
    <td>${fmtBytes(u.bytes)}</td>
    <td><button data-uf="${esc(u.uf)}" data-acao="${acao}" title="${u.pausada ? 'retoma a coleta (todas as UFs não pausadas)' : 'pausa esta UF'}">${u.pausada ? 'Retomar' : 'Pausar'}</button></td>
  </tr>`;
}

let ultimoEstado = null;

function render(e) {
  ultimoEstado = e;
  const c = e.coleta;
  const semConfig = !e.configuracao;
  if (semConfig) $('configuracao').open = true;
  $('situacao').textContent = e.manifestErro
    ? `Manifest com erro de gravação (HD desconectado?): ${e.manifestErro}`
    : semConfig
    ? 'Sem configuração: escolha pleitos e UFs em "Configuração" e aplique'
    : c.rodando
    ? `Coletando ${c.ufAtual?.toUpperCase() ?? ''} ${c.municipioAtual ?? ''}`
    : `Parada${c.motivoParada ? `: ${c.motivoParada}` : ''}`;
  $('situacao').classList.toggle('erro', Boolean(e.manifestErro));
  $('btn-iniciar').hidden = c.rodando || semConfig;
  $('btn-parar').hidden = !c.rodando;
  $('btn-iniciar').disabled = c.rodando;
  $('btn-parar').disabled = !c.rodando;
  $('velocidade').textContent = `${fmtBytes(c.velocidadeBps)}/s`;
  $('baixado').textContent = fmtBytes(e.totais.bytes);
  $('projecao').textContent = e.disco.projecaoBytes == null
    ? '—'
    : `${fmtBytes(e.disco.projecaoBytes)}${e.disco.projecaoPreliminar ? ' (preliminar)' : ''}`;
  $('livre').textContent = fmtBytes(e.disco.livres);
  $('secoes').textContent = `${num(e.totais.concluidas)} / ${num(e.totais.secoes)}`;
  $('ufs').innerHTML = e.ufs.map(linhaUf).join('');
  $('erros').innerHTML = e.errosSecoes.map((s) =>
    `<li>${esc(s.uf.toUpperCase())} ${esc(s.pleito)} mun ${esc(s.mun)} zona ${esc(s.zona)} seção ${esc(s.secao)}: ${esc(s.erro)}</li>`).join('');
  $('eventos').innerHTML = e.eventos.map((ev) =>
    `<li class="${esc(ev.nivel)}"><time>${esc(new Date(ev.ts).toLocaleString('pt-BR'))}</time> ${esc(ev.uf?.toUpperCase() ?? '')} ${esc(ev.msg)}</li>`).join('');
}

function avisar(msg) {
  $('situacao').textContent = msg;
  $('situacao').classList.add('erro');
}

async function enviar(caminho) {
  try {
    const r = await fetch(caminho, { method: 'POST', headers: { 'x-tse-auditor': '1' } });
    if (!r.ok) avisar(`falha no comando (${r.status}): ${(await r.json().catch(() => ({}))).erro ?? r.statusText}`);
    return r.ok;
  } catch (err) {
    avisar(`falha no comando: ${err.message}`);
    return false;
  }
}

document.addEventListener('click', async (ev) => {
  const botao = ev.target.closest('button');
  if (!botao) return;
  const caminho = botao.dataset.uf ? `/api/uf/${botao.dataset.uf}/${botao.dataset.acao}` : botao.dataset.coleta && `/api/coleta/${botao.dataset.coleta}`;
  if (!caminho) return;
  botao.disabled = true;
  if (!(await enviar(caminho))) botao.disabled = false;
});

// ---- configuração ----

const el = (tag, props = {}, ...filhos) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...filhos);
  return n;
};

// Opções avançadas, agrupadas. `campo` usa o mesmo caminho de `limites` (ex.: http.tentativas).
const AVANCADO = [
  ['Conexões com o TSE', [
    { campo: 'http.tentativas', rotulo: 'Tentativas por requisição', dica: 'quantas vezes repetir uma requisição que falhou (429, 5xx ou rede) antes de desistir' },
    { campo: 'http.esperaBaseMs', rotulo: 'Espera inicial (ms)', dica: 'espera antes de repetir; dobra a cada nova tentativa, com variação aleatória' },
    { campo: 'http.esperaMaxMs', rotulo: 'Espera máxima (ms)', dica: 'teto da espera entre tentativas; não pode ser menor que a inicial' },
    { campo: 'http.timeoutMs', rotulo: 'Tempo limite (ms)', dica: 'tempo máximo de uma requisição antes de contar como falha' },
    { campo: 'http.userAgent', rotulo: 'User-Agent', tipo: 'text', dica: 'identificação enviada ao TSE (só ASCII)' },
  ]],
  ['Verificação', [
    { campo: 'tentativasVerificacao', rotulo: 'Tentativas de verificação', dica: 'quantas vezes baixar um arquivo cujo hash não confere antes de marcar erro' },
  ]],
  ['Proteções', [
    { campo: 'limiteFalhasRede', rotulo: 'Falhas de rede seguidas', dica: 'quantas falhas sem resposta do TSE, em sequência, interrompem a coleta' },
    { campo: 'minLivreGB', rotulo: 'Espaço mínimo livre (GB)', dica: 'a coleta para quando o HD fica com menos que isso livre' },
  ]],
  ['Desempenho', [
    { campo: 'intervaloCommitMs', rotulo: 'Gravação do manifest (ms)', dica: 'de quanto em quanto tempo o progresso é gravado no disco; menor perde menos se cair, mas escreve mais' },
    { campo: 'intervaloPainelMs', rotulo: 'Atualização do painel (ms)', dica: 'ritmo em que esta página recebe o estado da coleta' },
  ]],
  ['Análise', [
    { campo: 'analisarAoConcluir', rotulo: 'Extrair e analisar ao concluir', tipo: 'checkbox', dica: 'quando a coleta de uma UF termina, roda extrair + analisar para ela' },
  ]],
  ['Caminhos', [
    { campo: 'hd', rotulo: 'HD externo', tipo: 'text', dica: 'pasta raiz do HD; os dados ficam só em <HD>/tse<ano>' },
  ]],
];

let cfg = null; // última resposta de GET /api/config

const obter = (objeto, campo) => campo.split('.').reduce((o, k) => o?.[k], objeto);

const curto = (texto, max = 40) => (texto.length > max ? `${texto.slice(0, max - 1)}…` : texto);

// Uma linha por pleito: "6257 1º turno · Presidente | ..." (consultas populares longas são encurtadas;
// o texto completo fica no title).
function descreverEleicoes(p) {
  return p.eleicoes.map((e) => `${e.cd} ${e.turno}º turno${e.cargos.length ? ` · ${e.cargos.map((c) => curto(c)).join(', ')}` : ''}`).join(' | ');
}

function caixa(name, value, marcada) {
  return el('input', { type: 'checkbox', name, value, checked: marcada });
}

function campoAvancado({ campo, rotulo, dica, tipo = 'number' }) {
  const lim = cfg.limites[campo] ?? {};
  const entrada = el('input', { type: tipo, id: `cfg-${campo}`, required: tipo !== 'checkbox' });
  entrada.dataset.campo = campo;
  if (tipo === 'number') Object.assign(entrada, { min: lim.min, max: lim.max, step: 1 });
  if (lim.maxLength) entrada.maxLength = lim.maxLength;
  let padrao = obter(cfg.padroes, campo);
  if (typeof padrao === 'boolean') padrao = padrao ? 'ligado' : 'desligado';
  const faixa = tipo === 'number' ? `; de ${num(lim.min)} a ${num(lim.max)}` : '';
  return el('label', { className: 'campo' },
    el('span', { textContent: rotulo }),
    entrada,
    el('span', { className: 'dica', textContent: `${dica} (padrão ${typeof padrao === 'number' ? num(padrao) : padrao}${faixa})` }));
}

function preencherOpcoes(origem) {
  $('cfg-concorrencia').value = origem.concorrencia;
  for (const entrada of $('cfg-avancado').querySelectorAll('[data-campo]')) {
    if (entrada.type === 'checkbox') entrada.checked = obter(origem, entrada.dataset.campo) !== false;
    else entrada.value = obter(origem, entrada.dataset.campo);
  }
  avisarConcorrencia();
}

function renderConfig() {
  const { atual, disponiveis, padroes, limites, somenteLeitura } = cfg;
  const escolhidos = new Set(atual?.pleitos ?? []);
  const ciclos = new Map();
  for (const p of disponiveis.pleitos) {
    if (!ciclos.has(p.ciclo)) ciclos.set(p.ciclo, []);
    ciclos.get(p.ciclo).push(p);
  }
  $('cfg-pleitos').replaceChildren(...[...ciclos].map(([ciclo, pleitos], i) =>
    el('details', { className: 'ciclo', open: atual ? atual.ciclo === ciclo : i === 0 },
      el('summary', { textContent: `${ciclo} (${pleitos.length} pleito${pleitos.length > 1 ? 's' : ''})` }),
      ...pleitos.map((p) => el('label', { title: p.eleicoes.map((e) => `${e.cd} ${e.nome}${e.cargos.length ? `: ${e.cargos.join(', ')}` : ''}`).join('\n') },
        caixa('pleito', p.cd, escolhidos.has(p.cd)),
        el('b', { textContent: ` ${p.cd}` }),
        el('span', { className: 'data', textContent: p.data }),
        el('span', { className: 'dica', textContent: descreverEleicoes(p) }))))));

  const ufs = new Set(atual?.ufs ?? []);
  $('cfg-ufs').replaceChildren(...disponiveis.ufs.map((uf) =>
    el('label', {}, caixa('uf', uf, ufs.has(uf)), ` ${uf.toUpperCase()}`)));

  Object.assign($('cfg-concorrencia'), { min: limites.concorrencia.min, max: limites.concorrencia.max });
  $('cfg-concorrencia-dica').textContent = `conexões simultâneas ao TSE (padrão ${padroes.concorrencia}; de ${limites.concorrencia.min} a ${limites.concorrencia.max})`;

  $('cfg-avancado').replaceChildren(...AVANCADO.map(([titulo, campos]) =>
    el('fieldset', {}, el('legend', { textContent: titulo }), ...campos.map(campoAvancado))));
  $('cfg-avancado').lastChild.append(
    el('p', { className: 'dica', textContent: somenteLeitura.dadosFixo
      ? `A pasta de dados foi fixada por --dados (${somenteLeitura.dadosFixo}); o HD acima não é usado.`
      : 'O HD precisa estar conectado ao aplicar. Nada é gravado fora de <HD>/tse<ano>.' }),
    el('dl', { className: 'leitura' },
      el('dt', { textContent: 'Fonte (oficial do TSE)' }), el('dd', {}, el('code', { textContent: `${somenteLeitura.base}/${somenteLeitura.ambiente}` })),
      el('dt', { textContent: 'Porta do painel' }), el('dd', { textContent: `${somenteLeitura.porta} — mudar a porta exige reiniciar: node src/cli.js painel --porta N` })));
  preencherOpcoes(atual ?? padroes);

  $('cfg-dados').textContent = atual?.dados ?? (somenteLeitura.dadosFixo || '— (definida ao aplicar: <HD>/tse<ano>)');
  $('cfg-resumo').textContent = atual
    ? `pleitos ${atual.pleitos.join(', ')} · ${atual.ufs.length === disponiveis.ufs.length ? 'todas as UFs' : atual.ufs.map((u) => u.toUpperCase()).join(', ')} · concorrência ${atual.concorrencia}`
    : 'nenhuma';
  if (!atual) $('configuracao').open = true;
}

function avisarConcorrencia() {
  const alerta = cfg?.limites.concorrencia.alerta ?? 16;
  $('cfg-concorrencia-alerta').hidden = !(Number($('cfg-concorrencia').value) > alerta);
}

async function carregarConfig() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    cfg = await r.json();
    renderConfig();
  } catch (err) {
    mensagemConfig(`não foi possível ler a configuração: ${err.message}`, 'erro');
  }
}

function mensagemConfig(texto, classe = '') {
  $('cfg-msg').textContent = texto;
  $('cfg-msg').className = classe;
}

const marcados = (name) => [...$('form-config').querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);

function lerFormulario() {
  const config = { pleitos: marcados('pleito'), ufs: marcados('uf'), concorrencia: Number($('cfg-concorrencia').value), http: {} };
  for (const entrada of $('cfg-avancado').querySelectorAll('[data-campo]')) {
    const valor = entrada.type === 'checkbox' ? entrada.checked : entrada.type === 'number' ? Number(entrada.value) : entrada.value;
    const partes = entrada.dataset.campo.split('.');
    if (partes.length === 2) config[partes[0]][partes[1]] = valor;
    else config[partes[0]] = valor;
  }
  return config;
}

// Mesmas regras do servidor, para avisar antes de enviar.
function problemaNaConfig(config) {
  if (config.pleitos.length === 0) return 'escolha ao menos um pleito';
  const ciclos = new Set(config.pleitos.map((cd) => cfg?.disponiveis.pleitos.find((p) => p.cd === cd)?.ciclo));
  if (ciclos.size > 1) return `os pleitos precisam ser do mesmo ciclo: ${[...ciclos].join(', ')}`;
  if (config.ufs.length === 0) return 'escolha ao menos uma UF';
  for (const [campo, lim] of Object.entries(cfg?.limites ?? {})) {
    if (lim.min === undefined) continue;
    const valor = obter(config, campo);
    if (!Number.isInteger(valor) || valor < lim.min || valor > lim.max) {
      const rotulo = campo === 'concorrencia' ? 'Concorrência' : $(`cfg-${campo}`)?.previousSibling?.textContent ?? campo;
      return `${rotulo}: use um inteiro de ${num(lim.min)} a ${num(lim.max)}`;
    }
  }
  if (config.http.esperaMaxMs < config.http.esperaBaseMs) return 'a espera máxima não pode ser menor que a inicial';
  const ua = config.http.userAgent.trim();
  if (!ua || ua.length > 200 || !/^[\x20-\x7e]+$/.test(ua)) return 'o User-Agent precisa ter de 1 a 200 caracteres ASCII visíveis (sem acentos)';
  if (!config.hd.trim().startsWith('/')) return 'o caminho do HD precisa ser absoluto (começar com /)';
  return null;
}

$('cfg-concorrencia').addEventListener('input', avisarConcorrencia);
$('ufs-todas').addEventListener('click', () => {
  for (const i of $('cfg-ufs').querySelectorAll('input')) i.checked = true;
});
$('ufs-limpar').addEventListener('click', () => {
  for (const i of $('cfg-ufs').querySelectorAll('input')) i.checked = false;
});
$('cfg-padroes').addEventListener('click', () => {
  if (!cfg) return;
  preencherOpcoes(cfg.padroes);
  mensagemConfig('padrões preenchidos (pleitos e UFs mantidos); aplique para valer');
});

$('form-config').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const iniciar = ev.submitter?.value === 'iniciar';
  const config = lerFormulario();
  const problema = problemaNaConfig(config);
  if (problema) return mensagemConfig(problema, 'erro');
  if (ultimoEstado?.coleta.rodando
    && !confirm('A coleta atual será parada e reiniciada com a nova configuração; o que já foi baixado é mantido. Continuar?')) return;
  const botoes = $('form-config').querySelectorAll('button[type=submit]');
  for (const b of botoes) b.disabled = true;
  mensagemConfig('aplicando… (se a coleta estiver rodando, espera as seções em andamento)');
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'x-tse-auditor': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ ...config, iniciar }),
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) {
      mensagemConfig(`não aplicada: ${corpo.erro ?? r.statusText}`, 'erro');
      return;
    }
    await carregarConfig();
    mensagemConfig(iniciar ? 'configuração aplicada; coleta iniciada' : 'configuração aplicada', 'ok');
  } catch (err) {
    mensagemConfig(`não aplicada: ${err.message}`, 'erro');
  } finally {
    for (const b of botoes) b.disabled = false;
  }
});

carregarConfig();

const fonte = new EventSource('/api/eventos');
fonte.onmessage = (m) => render(JSON.parse(m.data));
fonte.addEventListener('falha', (m) => avisar(`falha ao ler o estado: ${JSON.parse(m.data)}`));
fonte.onerror = () => avisar('sem conexão com o painel; tentando de novo…');

// ---- análise: seções destoantes (sinais + explicações candidatas; nunca veredito) ----

const CORES = { biometria: '#2f81f7', mesario: '#d29922', anoNascimento: '#8957e5' };
const ROTULO_HAB = { biometria: 'biometria', mesario: 'mesário', anoNascimento: 'ano de nascimento' };
const an = { ufs: [], jobs: { jobs: [] }, uf: null, rankingDe: null };

async function obterJson(caminho, opcoes) {
  const r = await fetch(caminho, opcoes);
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.erro ?? `HTTP ${r.status}`);
  return corpo;
}

const td = (texto) => el('td', { textContent: texto ?? '—' });

// Glossário dos códigos de sinais (por grupo de cor) e das explicações candidatas.
const SINAIS = {
  MESARIO_ACIMA_LOCAL: ['mesario', 'Mesário acima do local', 'Proporção de eleitores liberados pelo mesário bem acima das outras seções do mesmo local de votação.'],
  MESARIO_ACIMA_ZONA: ['mesario', 'Mesário acima da zona', 'Proporção de liberação pelo mesário bem acima das seções da mesma zona.'],
  MESARIO_SUBIU_OUTRO_TURNO: ['mesario', 'Mesário subiu entre turnos', 'A liberação pelo mesário aumentou muito em relação ao outro turno na mesma seção.'],
  MESARIO_ULTIMA_HORA: ['mesario', 'Mesário na última hora', 'Liberações pelo mesário concentradas na última hora de votação.'],
  ABSTENCAO_CAIU_MESARIO_SUBIU: ['mesario', 'Abstenção caiu e mesário subiu', 'Entre turnos, a abstenção caiu ao mesmo tempo em que a liberação pelo mesário subiu.'],
  VARIACAO_ATIPICA_ZONA: ['turnos', 'Variação atípica entre turnos', 'Votos de um candidato a presidente mudaram entre os turnos muito mais do que nas seções da zona.'],
  GANHO_ACIMA_DISPONIVEL: ['turnos', 'Ganho acima do disponível', 'Um candidato ganhou mais votos no 2º turno do que havia votos disponíveis na seção.'],
  VOTO_APOS_PAUSA_17H: ['horarios', 'Voto após pausa no encerramento', 'Voto registrado depois do encerramento após 30 min ou mais sem votos (não parece fila).'],
  VOTO_ANTES_ABERTURA: ['horarios', 'Voto antes da abertura', 'Voto computado antes do horário de abertura da votação.'],
  TESTE_CARGA_NO_DIA: ['horarios', 'Teste/carga no dia', 'Eventos de teste ou carga da urna misturados à votação no dia da eleição.'],
  COMPARECIMENTO_ACIMA_APTOS: ['limites', 'Comparecimento acima de aptos', 'Mais eleitores votaram do que o número de aptos da seção.'],
  VOTOS_ACIMA_COMPARECIMENTO: ['limites', 'Votos acima do comparecimento', 'Total de votos de um cargo maior que o comparecimento.'],
};
const EXPLICACOES = {
  fila_17h: ['Fila no encerramento', 'Votos contínuos até o encerramento, indicando fila real.'],
  leitor_biometrico_defeito: ['Leitor biométrico com defeito', 'Muitas tentativas de digital falhando desde cedo; o mesário precisa liberar mais.'],
  eleitores_sem_biometria: ['Eleitores sem biometria', 'Muitos eleitores habilitados pelo ano de nascimento (sem biometria cadastrada).'],
  secao_agregada: ['Seção agregada', 'A seção recebeu eleitores de outra seção, o que muda o perfil entre turnos.'],
  contingencia: ['Urna de reserva', 'A urna foi substituída no dia (contingência).'],
  desvio_relogio: ['Desvio no relógio', 'O relógio da urna parece adiantado ou atrasado.'],
};
const GRUPOS = { mesario: 'Liberação pelo mesário', turnos: '1º × 2º turno', horarios: 'Horários', limites: 'Limites' };
const badgeSinal = (c) => el('span', { className: `badge g-${SINAIS[c]?.[0] ?? 'outro'}`, textContent: SINAIS[c]?.[1] ?? c, title: SINAIS[c]?.[2] ?? c });
const badgeExp = (c) => el('span', { className: 'badge explicacao', textContent: EXPLICACOES[c]?.[0] ?? c, title: EXPLICACOES[c]?.[1] ?? c });
const listaExp = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;]\s*/)).filter(Boolean);
const tdBadges = (codigos, f) => el('td', {}, ...(codigos.length ? codigos.map(f) : [document.createTextNode('—')]));

function desenharGlossario() {
  const linha = (badge, texto) => el('li', {}, badge, document.createTextNode(` ${texto}`));
  $('an-glossario').replaceChildren(
    el('summary', { textContent: 'Glossário: sinais e explicações candidatas' }),
    el('p', { className: 'dica', textContent: 'Pontuação máx.: 0–100, quanto a seção foge do padrão das vizinhas/zona/outro turno (10 × desvio robusto, limitado a 100). Explicações candidatas são causas técnicas normais detectadas nos dados que podem explicar o sinal.' }),
    ...Object.entries(GRUPOS).map(([g, nome]) => el('div', {}, el('h4', { textContent: nome }),
      el('ul', {}, ...Object.entries(SINAIS).filter(([, v]) => v[0] === g).map(([c, v]) => linha(badgeSinal(c), v[2]))))),
    el('h4', { textContent: 'Explicações candidatas' }),
    el('ul', {}, ...Object.entries(EXPLICACOES).map(([c, v]) => linha(badgeExp(c), v[1]))));
}


function renderAnaliseUfs() {
  const coleta = new Map((ultimoEstado?.ufs ?? []).map((u) => [u.uf, u.status]));
  const dados = new Map(an.ufs.map((u) => [u.uf, u]));
  const todas = [...new Set([...coleta.keys(), ...dados.keys()])].sort();
  const ativo = new Set(an.jobs.jobs.filter((j) => j.estado === 'na fila' || j.estado === 'rodando').map((j) => j.uf));
  $('an-ufs').replaceChildren(...todas.map((uf) => {
    const d = dados.get(uf);
    const st = coleta.get(uf);
    const pronta = st === 'baixado' || st === 'baixado_com_erros';
    const botao = el('button', { type: 'button', textContent: ativo.has(uf) ? 'Na fila…' : 'Extrair e analisar',
      disabled: !pronta || ativo.has(uf), title: pronta ? 'roda extrair e depois analisar para a UF' : 'disponível quando a coleta da UF termina' });
    botao.dataset.analisar = uf;
    return el('tr', {}, td(uf.toUpperCase()), td(ROTULO[st] ?? st ?? '—'), td(d ? `${num(d.ok)} ok / ${num(d.secoes)}` : null),
      td(d?.achados != null ? num(d.achados) : null), td(d?.secoesComAchados != null ? num(d.secoesComAchados) : null),
      td(d?.analisadoEm ? new Date(d.analisadoEm).toLocaleString('pt-BR') : null), el('td', {}, botao));
  }));
  const comAchados = an.ufs.filter((u) => u.achados != null).map((u) => u.uf);
  const atual = $('an-uf').value;
  $('an-uf').replaceChildren(...comAchados.map((uf) => el('option', { value: uf, textContent: uf.toUpperCase() })));
  if (comAchados.includes(atual)) $('an-uf').value = atual;
  if (!comAchados.length) $('an-msg').textContent = 'nenhuma UF analisada ainda';
}

function renderJobs() {
  $('an-jobs').replaceChildren(...an.jobs.jobs.slice().reverse().map((j) => el('li', { className: j.estado === 'erro' ? 'erro' : '',
    textContent: `${j.uf.toUpperCase()} ${j.estado}${j.etapa && j.estado === 'rodando' ? ` (${j.etapa})` : ''}`
      + `${j.origem === 'automática' ? ' · automática' : ''}${j.progresso && j.estado === 'rodando' ? ` · ${j.progresso}` : ''}${j.erro ? ` · ${j.erro}` : ''}` })));
}

async function atualizarAnalise() {
  try {
    const antes = an.jobs.jobs.filter((j) => j.estado === 'concluído').length;
    an.jobs = await obterJson('/api/analise/jobs');
    const mudou = an.jobs.jobs.filter((j) => j.estado === 'concluído').length !== antes;
    if (mudou || !an.ufs.length) an.ufs = (await obterJson('/api/analise/ufs')).ufs;
    renderAnaliseUfs();
    renderJobs();
    const uf = $('an-uf').value;
    if (uf && (uf !== an.rankingDe || mudou)) await carregarRanking();
  } catch (err) {
    $('an-msg').textContent = `análise: ${err.message}`;
  }
}

async function carregarRanking() {
  const uf = $('an-uf').value;
  if (!uf) return;
  const sinal = $('an-sinal').value;
  const r = await obterJson(`/api/analise/${uf}/ranking?limite=200&sinal=${encodeURIComponent(sinal)}`);
  if (an.rankingDe !== uf) {
    $('an-sinal').replaceChildren(el('option', { value: '', textContent: 'todos' }),
      ...r.sinais.map((s) => el('option', { value: s.sinal, textContent: `${SINAIS[s.sinal]?.[1] ?? s.sinal} (${num(s.n)})` })));
  }
  an.rankingDe = uf;
  $('an-msg').textContent = `${num(r.secoes.length)} seções destoantes${r.secoes.length === 200 ? ' (primeiras 200)' : ''}; clique numa linha para ver os sinais`;
  $('an-ranking').tBodies[0].replaceChildren(...r.secoes.map((s) => {
    const tr = el('tr', {}, td(s.mun), td(s.zona), td(s.secao), td(String(s.pontuacao)),
      tdBadges(s.sinais, badgeSinal), tdBadges(listaExp(s.explicacoes), badgeExp));
    tr.addEventListener('click', () => {
      for (const o of $('an-ranking').querySelectorAll('tr.sel')) o.classList.remove('sel');
      tr.classList.add('sel');
      abrirSecao(uf, s);
    });
    return tr;
  }));
}

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...filhos) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...filhos);
  return n;
};

// Barras por 10 min (horário local da urna), empilhadas por tipo de habilitação.
function linhaDoTempo(t, escala) {
  const ivs = t.intervalos;
  if (!ivs.length) return el('p', { className: 'dica', textContent: 'sem votos no log do dia da eleição' });
  const min = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  const ini = 6 * 60;
  const fim = 18 * 60; // mesmo eixo para os dois turnos
  const maxV = escala ?? Math.max(...ivs.map((i) => i.votos), 1);
  const L = 40, A = 140, W = Math.max(400, ((fim - ini) / 10) * 8), x = (m) => L + ((m - ini) / 10) * 8;
  const g = svg('svg', { viewBox: `0 0 ${L + W + 10} ${A + 30}`, class: 'tempo', role: 'img' });
  g.append(svg('title', {}, `votos por 10 minutos, pleito ${t.pleito}`));
  for (let h = Math.ceil(ini / 60) * 60; h <= fim; h += 60) {
    g.append(svg('line', { x1: x(h), x2: x(h), y1: 0, y2: A, stroke: 'currentColor', 'stroke-opacity': 0.15 }),
      svg('text', { x: x(h), y: A + 14, 'text-anchor': 'middle' }, `${String(h / 60).padStart(2, '0')}h`));
  }
  g.append(svg('text', { x: 2, y: 10 }, String(maxV)), svg('text', { x: 2, y: A }, '0'));
  for (const i of ivs) {
    let y = A;
    for (const k of ['biometria', 'mesario', 'anoNascimento']) {
      const h = (i[k] / maxV) * (A - 4);
      if (!h) continue;
      y -= h;
      g.append(svg('rect', { x: x(min(i.inicio)) + 0.5, y, width: 7, height: h, fill: CORES[k] },
        svg('title', {}, `${i.inicio}: ${i[k]} ${ROTULO_HAB[k]} (${i.votos} votos)`)));
    }
  }
  return g;
}

const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);
const hora = (ts) => String(ts ?? '').slice(11, 16) || '—';
const vezes = (z) => `${Math.abs(z).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}×`;

// Frase em linguagem comum explicando por que o achado apareceu.
function frase(a, nomeTurno) {
  let d = {};
  try { d = JSON.parse(a.detalhe || '{}'); } catch { /* detalhe inválido: usa só o texto do glossário */ }
  const t = nomeTurno(a.pleito);
  switch (a.sinal) {
    case 'MESARIO_ACIMA_LOCAL':
      return `No ${t}, o mesário liberou ${d.mesario} de ${d.comparecimento} eleitores (${pct(a.valor)}). Nas ${d.secoesNoLocal} seções do mesmo local de votação, o normal foi ${pct(a.referencia)}, um desvio ${vezes(d.zRobusto)} acima do esperado.`;
    case 'MESARIO_ACIMA_ZONA':
      return `No ${t}, o mesário liberou ${d.mesario} de ${d.comparecimento} eleitores (${pct(a.valor)}). Nas ${d.secoesNaZona} seções da zona, o normal foi ${pct(a.referencia)}, um desvio ${vezes(d.zRobusto)} acima do esperado.`;
    case 'MESARIO_SUBIU_OUTRO_TURNO':
      return `No ${t}, o mesário liberou ${d.mesario} de ${d.comparecimento} eleitores (${pct(a.valor)}), contra ${pct(a.referencia)} no outro turno na mesma seção, um aumento ${vezes(d.zRobusto)} acima do que ocorreu na zona.`;
    case 'MESARIO_ULTIMA_HORA':
      return `No ${t}, ${d.mesarioUltimaHora} das ${d.mesarioDia} liberações pelo mesário aconteceram na última hora, quando só ${d.votosUltimaHora} dos ${d.votosDia} votos do dia foram registrados.`;
    case 'VARIACAO_ATIPICA_ZONA':
      return `O candidato ${d.candidato} teve ${d.v1} votos no 1º turno e ${d.v2} no 2º (comparecimento: ${d.comparecimento1} → ${d.comparecimento2}). Essa mudança foi ${vezes(d.zRobusto)} maior que o normal entre as ${d.secoesNaZona} seções da zona.`;
    case 'VOTO_APOS_PAUSA_17H':
      return `No ${t}, ${d.votos} voto(s) foram registrados entre ${hora(d.retomada)} e ${hora(d.ultimoVoto)} (horário local), depois de uma pausa de 30 min ou mais após o encerramento.`;
    case 'COMPARECIMENTO_ACIMA_APTOS':
      return `No ${t}, o comparecimento (${d.comparecimento}) é maior que o número de aptos (${d.aptos}).`;
    default:
      return `No ${t}: ${SINAIS[a.sinal]?.[2] ?? a.sinal}`;
  }
}

function fecharModal() { $('an-modal').close(); }

async function abrirSecao(uf, s) {
  const modal = $('an-modal');
  const corpo = $('an-modal-corpo');
  corpo.replaceChildren(el('p', { textContent: 'carregando…' }));
  if (!modal.open) modal.showModal();
  try {
    const d = await obterJson(`/api/analise/${uf}/secao/${encodeURIComponent(s.mun)}/${encodeURIComponent(s.zona)}/${encodeURIComponent(s.secao)}`);
    const turnos = [...d.turnos].sort((x, y) => x.pleito - y.pleito);
    const nomeTurno = (p) => (turnos.findIndex((t) => t.pleito === p) === 1 ? '2º turno' : '1º turno');
    const [t1, t2] = turnos;
    const pontuacao = Math.max(...d.achados.map((a) => a.pontuacao), 0);

    // O que é destacado na tabela: candidatos e linhas citados pelos sinais.
    const destaque = new Set();
    for (const a of d.achados) {
      if (a.sinal.startsWith('MESARIO') || a.sinal.startsWith('ABSTENCAO')) destaque.add('mesario');
      try { const j = JSON.parse(a.detalhe || '{}'); if (j.candidato != null) destaque.add(`c${j.candidato}`); } catch { /* ignora */ }
    }

    // Resumo: por que a seção apareceu.
    const cartoesAchados = d.achados.map((a) => {
      const exp = listaExp(a.explicacoesCandidatas);
      return el('div', { className: 'achado' },
        el('div', {}, badgeSinal(a.sinal), el('span', { className: 'pts', textContent: `pontuação ${a.pontuacao}` })),
        el('p', { textContent: frase(a, nomeTurno) }),
        exp.length
          ? el('p', { className: 'dica' }, document.createTextNode('Possível explicação técnica: '), ...exp.map(badgeExp))
          : el('p', { className: 'sem-exp', textContent: 'Nenhuma explicação técnica encontrada automaticamente: vale verificar com prioridade.' }));
    });

    // Tabela comparativa 1º × 2º turno.
    const val = (t, k) => (t ? t[k] : null);
    const votos = (t, chave) => {
      if (!t) return null;
      const v = d.presidente.filter((p) => p.pleito === t.pleito && (p.tipo === 'nominal' ? `c${p.numero}` : p.tipo) === chave);
      return v.length ? v.reduce((x, p) => x + p.votos, 0) : 0;
    };
    const fmt = (v, base) => (v == null ? '—' : base ? `${num(v)} (${pct(v / base)})` : num(v));
    const dif = (a, b) => {
      if (a == null || b == null) return el('td', { textContent: '—' });
      const x = b - a;
      return el('td', { className: x > 0 ? 'sobe' : x < 0 ? 'desce' : '', textContent: x === 0 ? '0' : `${x > 0 ? '+' : ''}${num(x)}` });
    };
    const linha = (rotulo, a, b, baseA, baseB, chave) => el('tr', { className: destaque.has(chave) ? 'destaque' : '' },
      el('th', { textContent: rotulo }), td(fmt(a, baseA)), td(fmt(b, baseB)), dif(a, b));
    const grupo = (titulo) => el('tr', { className: 'grupo' }, el('th', { colSpan: 4, textContent: titulo }));
    const c1 = val(t1, 'comparecimento'), c2 = val(t2, 'comparecimento');
    const chavesPres = [...new Set(d.presidente.map((p) => (p.tipo === 'nominal' ? `c${p.numero}` : p.tipo)))]
      .sort((x, y) => (x[0] === 'c') === (y[0] === 'c') ? x.localeCompare(y, 'pt', { numeric: true }) : x[0] === 'c' ? -1 : 1);
    const tabela = el('table', { className: 'comparacao' },
      el('thead', {}, el('tr', {}, el('th'), el('th', { textContent: '1º turno' }), el('th', { textContent: '2º turno' }), el('th', { textContent: 'Diferença' }))),
      el('tbody', {},
        grupo('Eleitores'),
        linha('Aptos', val(t1, 'aptos'), val(t2, 'aptos')),
        linha('Compareceram', c1, c2, val(t1, 'aptos'), val(t2, 'aptos')),
        linha('Abstenção', val(t1, 'abstencao'), val(t2, 'abstencao'), val(t1, 'aptos'), val(t2, 'aptos')),
        grupo('Como o eleitor foi liberado (% de quem compareceu)'),
        linha('Biometria', val(t1, 'qtdHabilitacaoBiometrica'), val(t2, 'qtdHabilitacaoBiometrica'), c1, c2),
        linha('Pelo mesário', val(t1, 'qtdHabilitacaoMesario'), val(t2, 'qtdHabilitacaoMesario'), c1, c2, 'mesario'),
        linha('Ano de nascimento', val(t1, 'qtdHabilitacaoAnoNascimento'), val(t2, 'qtdHabilitacaoAnoNascimento'), c1, c2),
        grupo('Presidente (% de quem compareceu)'),
        ...chavesPres.map((k) => linha(k[0] === 'c' ? `Candidato ${k.slice(1)}` : k === 'branco' ? 'Brancos' : k === 'nulo' ? 'Nulos' : k,
          votos(t1, k), votos(t2, k), c1, c2, k))));

    // Linhas do tempo na mesma escala.
    const lts = turnos.map((t) => d.linhaDoTempo.find((x) => x.pleito === t.pleito));
    const escala = Math.max(1, ...lts.flatMap((lt) => (lt ? lt.intervalos.map((i) => i.votos) : [])));
    const legenda = el('p', { className: 'legenda' }, ...Object.keys(CORES).map((k) =>
      el('span', {}, Object.assign(el('i'), { style: `background:${CORES[k]}` }), ROTULO_HAB[k])));
    const tempos = el('div', { className: 'tempos' }, ...turnos.map((t, i) => el('div', {},
      el('h5', { textContent: `${nomeTurno(t.pleito)}${lts[i] ? `: ${lts[i].votos} votos, de ${lts[i].primeiroVoto.slice(0, 5)} a ${lts[i].ultimoVoto.slice(0, 5)}` : ''}` }),
      lts[i] ? linhaDoTempo(lts[i], escala) : el('p', { className: 'dica', textContent: 'sem log' }))));

    // Dados técnicos, recolhidos.
    const tecnico = el('details', {}, el('summary', { textContent: 'Dados técnicos' }),
      el('table', {}, el('thead', {}, el('tr', {}, el('th'), ...turnos.map((t) => el('th', { textContent: `${nomeTurno(t.pleito)} (pleito ${t.pleito})` })))),
        el('tbody', {}, ...[['Situação da extração', 'status'], ['Local de votação', 'local'], ['Tipo de urna', 'tipoUrna'], ['Abertura', 'abertura'],
          ['Encerramento', 'encerramento'], ['1º voto (log)', 'logPrimeiroVoto'], ['Último voto (log)', 'logUltimoVoto'],
          ['Inconsistências', 'inconsistencias'], ['Seções agregadas', 'secoesAgregadas'], ['Agregada em', 'agregadaEm']]
          .map(([r, k]) => el('tr', {}, el('th', { textContent: r }), ...turnos.map((t) => td(t[k] == null || t[k] === '' ? '—' : String(t[k]))))))),
      el('p', { className: 'dica', textContent: `Horários da urna em horário local (+${d.horasParaBrasilia} h = Brasília).` }),
      ...d.achados.map((a) => el('pre', { textContent: `${a.sinal} (${nomeTurno(a.pleito)}): ${a.detalhe ?? ''}` })));

    corpo.replaceChildren(
      el('header', { className: 'modal-topo' },
        el('h3', { textContent: `${uf.toUpperCase()} · Município ${d.mun} · Zona ${d.zona} · Seção ${d.secao}` }),
        el('span', { className: 'pts grande', textContent: `pontuação máx. ${pontuacao}` })),
      el('h4', { textContent: 'Por que esta seção apareceu' }), ...cartoesAchados,
      el('p', { className: 'dica', textContent: 'Seção destoante não é prova de nada: confira as explicações antes de qualquer conclusão.' }),
      el('h4', { textContent: 'Comparação entre os turnos' }), tabela,
      el('h4', { textContent: 'Votos ao longo do dia (a cada 10 min)' }), legenda, tempos,
      tecnico);
  } catch (err) {
    corpo.replaceChildren(el('p', { className: 'erro', textContent: `não foi possível abrir a seção: ${err.message}` }));
  }
}

$('an-modal-fechar').addEventListener('click', fecharModal);
$('an-modal').addEventListener('click', (ev) => { if (ev.target === $('an-modal')) fecharModal(); });

$('an-ufs').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-analisar]');
  if (!b) return;
  b.disabled = true;
  try {
    await obterJson(`/api/analise/${b.dataset.analisar}/executar`, { method: 'POST', headers: { 'x-tse-auditor': '1' } });
  } catch (err) {
    $('an-msg').textContent = `não foi possível iniciar: ${err.message}`;
  }
  atualizarAnalise();
});
$('an-uf').addEventListener('change', () => carregarRanking().catch((err) => { $('an-msg').textContent = err.message; }));
$('an-sinal').addEventListener('change', () => carregarRanking().catch((err) => { $('an-msg').textContent = err.message; }));
atualizarAnalise();
setInterval(atualizarAnalise, 3000);

desenharGlossario();
