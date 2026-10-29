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
      ...r.sinais.map((s) => el('option', { value: s.sinal, textContent: `${s.sinal} (${num(s.n)})` })));
    $('an-secao').hidden = true;
  }
  an.rankingDe = uf;
  $('an-msg').textContent = `${num(r.secoes.length)} seções destoantes${r.secoes.length === 200 ? ' (primeiras 200)' : ''}; clique numa linha para ver os sinais`;
  $('an-ranking').tBodies[0].replaceChildren(...r.secoes.map((s) => {
    const tr = el('tr', {}, td(s.mun), td(s.zona), td(s.secao), td(String(s.pontuacao)),
      el('td', {}, ...s.sinais.map((x) => el('span', { className: 'sinal', textContent: x }))), td(s.explicacoes.join(', ') || '—'));
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
function linhaDoTempo(t) {
  const ivs = t.intervalos;
  if (!ivs.length) return el('p', { className: 'dica', textContent: 'sem votos no log do dia da eleição' });
  const min = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  const ini = Math.min(...ivs.map((i) => min(i.inicio)), 7 * 60);
  const fim = Math.max(...ivs.map((i) => min(i.inicio) + 10), 17 * 60);
  const maxV = Math.max(...ivs.map((i) => i.votos), 1);
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

async function abrirSecao(uf, s) {
  const box = $('an-secao');
  box.hidden = false;
  box.replaceChildren(el('p', { textContent: 'carregando…' }));
  try {
    const d = await obterJson(`/api/analise/${uf}/secao/${encodeURIComponent(s.mun)}/${encodeURIComponent(s.zona)}/${encodeURIComponent(s.secao)}`);
    const turno = (t) => {
      const pres = d.presidente.filter((p) => p.pleito === t.pleito);
      const lt = d.linhaDoTempo.find((x) => x.pleito === t.pleito);
      const par = (k, v) => [el('dt', { textContent: k }), el('dd', { textContent: v ?? '—' })];
      return el('div', {},
        el('h4', { textContent: `Pleito ${t.pleito} (${t.status})` }),
        el('dl', {}, ...par('Aptos', t.aptos), ...par('Comparecimento', t.comparecimento), ...par('Abstenção', t.abstencao),
          ...par('Hab. biometria', t.qtdHabilitacaoBiometrica), ...par('Hab. mesário', t.qtdHabilitacaoMesario),
          ...par('Hab. ano de nascimento', t.qtdHabilitacaoAnoNascimento), ...par('Tipo de urna', t.tipoUrna),
          ...par('Abertura', t.abertura), ...par('Encerramento', t.encerramento),
          ...par('1º / último voto (log)', lt ? `${lt.primeiroVoto} / ${lt.ultimoVoto} (${lt.votos} votos)` : null),
          ...par('Inconsistências', t.inconsistencias), ...par('Seções agregadas', t.secoesAgregadas)),
        el('h5', { textContent: 'Presidente (BU)' }),
        el('ul', {}, ...pres.map((p) => el('li', { textContent: `${p.tipo === 'nominal' ? p.numero : p.tipo}: ${num(p.votos)}` }))),
        el('h5', { textContent: `Linha do tempo (horário local da urna; +${d.horasParaBrasilia} h = Brasília)` }),
        lt ? linhaDoTempo(lt) : el('p', { className: 'dica', textContent: 'sem log' }));
    };
    const legenda = el('p', { className: 'legenda' }, ...Object.keys(CORES).map((k) =>
      el('span', {}, Object.assign(el('i'), { style: `background:${CORES[k]}` }), ROTULO_HAB[k])));
    box.replaceChildren(
      el('h3', { textContent: `${uf.toUpperCase()} município ${d.mun} zona ${d.zona} seção ${d.secao}: destoante (${d.achados.length} sinais)` }),
      el('div', { className: 'turnos' }, ...d.turnos.map(turno)), legenda,
      el('h4', { textContent: 'Sinais (verificar as explicações candidatas antes de qualquer conclusão)' }),
      el('table', {}, el('thead', {}, el('tr', {}, ...['Pleito', 'Cruzamento', 'Sinal', 'Pontuação', 'Valor', 'Referência', 'Explicações candidatas', 'Detalhe']
        .map((h) => el('th', { textContent: h })))),
      el('tbody', {}, ...d.achados.map((a) => el('tr', {}, td(String(a.pleito)), td(a.cruzamento), td(a.sinal), td(String(a.pontuacao)),
        td(a.valor == null ? null : String(Math.round(a.valor * 10000) / 10000)),
        td(a.referencia == null ? null : String(Math.round(a.referencia * 10000) / 10000)),
        td(a.explicacoesCandidatas || '—'), el('td', {}, el('code', { textContent: a.detalhe ?? '' })))))));
  } catch (err) {
    box.replaceChildren(el('p', { className: 'erro', textContent: `não foi possível abrir a seção: ${err.message}` }));
  }
}

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
