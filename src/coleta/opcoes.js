import path from 'node:path';
import { PADRAO } from '../config.js';

// Opções da coleta ajustáveis no painel: padrões, limites e validação.
// Pleitos e UFs são validados no ControleColeta (dependem do ele-c.json).

export const LIMITES = {
  concorrencia: { min: 1, max: 64, alerta: 16 },
  'http.tentativas': { min: 1, max: 20 },
  'http.esperaBaseMs': { min: 100, max: 60_000 },
  'http.esperaMaxMs': { min: 1000, max: 600_000 },
  'http.timeoutMs': { min: 5000, max: 600_000 },
  'http.userAgent': { maxLength: 200 },
  tentativasVerificacao: { min: 1, max: 10 },
  limiteFalhasRede: { min: 1, max: 1000 },
  minLivreGB: { min: 1, max: 1000 },
  intervaloCommitMs: { min: 100, max: 60_000 },
  intervaloPainelMs: { min: 500, max: 60_000 },
};

export function padroes({ hd = PADRAO.hd } = {}) {
  return {
    concorrencia: PADRAO.concorrencia,
    http: {
      tentativas: PADRAO.tentativas,
      esperaBaseMs: PADRAO.esperaBaseMs,
      esperaMaxMs: PADRAO.esperaMaxMs,
      timeoutMs: PADRAO.timeoutMs,
      userAgent: PADRAO.userAgent,
    },
    tentativasVerificacao: PADRAO.tentativasVerificacao,
    limiteFalhasRede: PADRAO.limiteFalhasRede,
    minLivreGB: PADRAO.minLivreGB,
    intervaloCommitMs: PADRAO.intervaloCommitMs,
    intervaloPainelMs: PADRAO.intervaloPainelMs,
    hd,
  };
}

const ROTULO = {
  concorrencia: 'a concorrência',
  'http.tentativas': 'as tentativas por requisição',
  'http.esperaBaseMs': 'a espera inicial',
  'http.esperaMaxMs': 'a espera máxima',
  'http.timeoutMs': 'o tempo limite da requisição',
  tentativasVerificacao: 'as tentativas de verificação',
  limiteFalhasRede: 'o limite de falhas de rede',
  minLivreGB: 'o espaço mínimo livre',
  intervaloCommitMs: 'o intervalo de gravação do manifest',
  intervaloPainelMs: 'o intervalo de atualização do painel',
};

function inteiroNaFaixa(valor, campo) {
  const { min, max } = LIMITES[campo];
  if (!Number.isInteger(valor) || valor < min || valor > max) {
    throw new Error(`${ROTULO[campo]} precisa ser um inteiro de ${min} a ${max}: ${valor}`);
  }
  return valor;
}

// Completa `entrada` com `base` (configuração anterior ou padrões) e valida tudo.
// Lança Error com mensagem em português; devolve um objeto novo, sem campos desconhecidos.
export function normalizarOpcoes(entrada = {}, base = padroes()) {
  const e = entrada ?? {};
  const eHttp = e.http ?? {};
  const de = (valor, anterior) => (valor === undefined || valor === null ? anterior : valor);

  const http = {};
  for (const campo of ['tentativas', 'esperaBaseMs', 'esperaMaxMs', 'timeoutMs']) {
    http[campo] = inteiroNaFaixa(de(eHttp[campo], base.http[campo]), `http.${campo}`);
  }
  if (http.esperaMaxMs < http.esperaBaseMs) {
    throw new Error(`a espera máxima (${http.esperaMaxMs} ms) não pode ser menor que a inicial (${http.esperaBaseMs} ms)`);
  }
  const userAgent = de(eHttp.userAgent, base.http.userAgent);
  if (typeof userAgent !== 'string' || !userAgent.trim()) throw new Error('o User-Agent não pode ficar vazio');
  if (userAgent.length > LIMITES['http.userAgent'].maxLength) {
    throw new Error(`o User-Agent pode ter no máximo ${LIMITES['http.userAgent'].maxLength} caracteres`);
  }
  if (!/^[\x20-\x7e]+$/.test(userAgent)) throw new Error('o User-Agent só pode ter caracteres ASCII visíveis (sem acentos)');
  http.userAgent = userAgent.trim();

  const hd = de(e.hd, base.hd);
  if (typeof hd !== 'string' || !hd.trim() || !path.isAbsolute(hd.trim())) {
    throw new Error(`o caminho do HD precisa ser absoluto: ${JSON.stringify(hd)}`);
  }

  const opcoes = { concorrencia: null, http };
  for (const campo of ['concorrencia', 'tentativasVerificacao', 'limiteFalhasRede', 'minLivreGB', 'intervaloCommitMs', 'intervaloPainelMs']) {
    opcoes[campo] = inteiroNaFaixa(de(e[campo], base[campo]), campo);
  }
  opcoes.hd = path.normalize(hd.trim());
  return opcoes;
}
