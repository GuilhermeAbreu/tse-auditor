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

function render(e) {
  const c = e.coleta;
  $('situacao').textContent = e.manifestErro
    ? `Manifest com erro de gravação (HD desconectado?): ${e.manifestErro}`
    : c.rodando
    ? `Coletando ${c.ufAtual?.toUpperCase() ?? ''} ${c.municipioAtual ?? ''}`
    : `Parada${c.motivoParada ? `: ${c.motivoParada}` : ''}`;
  $('situacao').classList.toggle('erro', Boolean(e.manifestErro));
  $('btn-iniciar').hidden = c.rodando;
  $('btn-parar').hidden = !c.rodando;
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

const fonte = new EventSource('/api/eventos');
fonte.onmessage = (m) => render(JSON.parse(m.data));
fonte.addEventListener('falha', (m) => avisar(`falha ao ler o estado: ${JSON.parse(m.data)}`));
fonte.onerror = () => avisar('sem conexão com o painel; tentando de novo…');
