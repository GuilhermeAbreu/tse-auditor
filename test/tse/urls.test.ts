import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarUrls, nomeConfigSecoes, nomeIndiceSecao } from '../../src/tse/urls.ts';
import { FX } from '../helpers/fakeTse.ts';

const templates = {
  cs: '<base>/<ambiente>/<ciclo>/arquivo-urna/<cd_pleito>/config/<uf>',
  aux: '<base>/<ambiente>/<ciclo>/arquivo-urna/<cd_pleito>/dados/<uf>/<municipio>/<zona>/<secao>',
};
const urls = criarUrls({ base: 'https://resultados.tse.jus.br', ambiente: 'oficial', templates });
const DADOS = 'https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3220/dados/ac/01066/0004/0077';

test('nomes de arquivo com pleito em 6 dígitos', () => {
  assert.equal(nomeConfigSecoes({ pleito: '3220', uf: 'ac' }), 'ac-p003220-cs.json');
  assert.equal(nomeIndiceSecao(FX.secao('3220')), 'p003220-ac-m01066-z0004-s0077-aux.json');
});

test('URL da configuração de seções', () => {
  assert.equal(
    urls.configSecoes({ ciclo: 'ele2026', pleito: '3220', uf: 'ac' }),
    'https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3220/config/ac/ac-p003220-cs.json',
  );
});

test('URLs do índice e dos arquivos da seção', () => {
  const s = { ciclo: 'ele2026', ...FX.secao('3220') };
  assert.equal(urls.indiceSecao(s), `${DADOS}/p003220-ac-m01066-z0004-s0077-aux.json`);
  assert.equal(urls.arquivo(s, FX.hash3220, 'o03220ac0106600040077-bu.dat'), `${DADOS}/${FX.hash3220}/o03220ac0106600040077-bu.dat`);
});

test('template com variável desconhecida falha alto', () => {
  const ruim = criarUrls({ base: 'b', ambiente: 'a', templates: { cs: '<base>/<foo>', aux: '<base>' } });
  assert.throws(() => ruim.configSecoes({ ciclo: 'ele2026', pleito: '1', uf: 'ac' }), /<foo>/);
});

test('valor ausente falha alto', () => {
  assert.throws(() => urls.indiceSecao({ ciclo: 'ele2026', pleito: '3220', uf: 'ac', zona: '0004', secao: '0077' }), /<municipio>/);
});
