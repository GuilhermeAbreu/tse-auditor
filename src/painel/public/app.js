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
  const entrada = el('input', { type: tipo, id: `cfg-${campo}`, required: true });
  entrada.dataset.campo = campo;
  if (tipo === 'number') Object.assign(entrada, { min: lim.min, max: lim.max, step: 1 });
  if (lim.maxLength) entrada.maxLength = lim.maxLength;
  const padrao = obter(cfg.padroes, campo);
  const faixa = tipo === 'number' ? `; de ${num(lim.min)} a ${num(lim.max)}` : '';
  return el('label', { className: 'campo' },
    el('span', { textContent: rotulo }),
    entrada,
    el('span', { className: 'dica', textContent: `${dica} (padrão ${typeof padrao === 'number' ? num(padrao) : padrao}${faixa})` }));
}

function preencherOpcoes(origem) {
  $('cfg-concorrencia').value = origem.concorrencia;
  for (const entrada of $('cfg-avancado').querySelectorAll('[data-campo]')) entrada.value = obter(origem, entrada.dataset.campo);
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
    const valor = entrada.type === 'number' ? Number(entrada.value) : entrada.value;
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
