# Coleta e Painel de Progresso — Plano de Implementação

**Goal:** Baixar, de forma retomável e verificada, todos os arquivos de urna de um ou mais pleitos do TSE para o HD externo, empacotados por município, com um painel web local que mostra o progresso ao vivo e permite pausar/iniciar por UF.

**Architecture:** CLI Node.js (`src/cli.js`) com três comandos: `eleicoes`, `coletar` (sem interface) e `painel` (servidor HTTP + coletor no mesmo processo). O `Coletor` descobre seções pela configuração do TSE, baixa índice e arquivos de cada seção num diretório de staging, verifica a cadeia de integridade (ETag MD5 → sha256 do `.vsc` = hash do diretório → sha512 de BU/RDV/log dentro do `.vsc`), registra tudo num `manifest.sqlite` e, ao fim de cada município, empacota em `.zip` sem compressão. O painel lê um "estado" agregado do manifest e o envia por SSE.

**Tech Stack:** Node 22 (ESM, `node:test`, `fetch` nativo), `better-sqlite3` (manifest), `yazl`/`yauzl` (zip), HTML + JS puro no painel.

**Escopo:** etapa 1 do spec (`docs/specs/2026-10-29-tse-auditor-design.md`). Verificação de assinatura digital, extração (Parquet), cruzamentos e telas de análise ficam para os planos seguintes. O filtro `--cargo` também fica para a análise: os arquivos de urna são por pleito e a coleta baixa todos.

---

## Divergências da implementação (leia antes de usar este plano como referência)

O código em `src/` é a fonte da verdade. Este plano descreve a primeira versão; as revisões de código mudaram vários pontos:

- **Manifest:** gravações numa transação aberta, confirmada a cada 1 s ou 500 escritas (`journal_mode=TRUNCATE`, `synchronous=NORMAL`). Use `descarregar()`/`fechar()` para confirmar. Após um COMMIT com falha (HD sumiu) as escritas passam a lançar o mesmo erro (`manifest.erro`) até reabrir o manifest; as leituras continuam funcionando. Novos métodos: `reabrirMunicipio`, `arquivo`, `arquivosOkDoMunicipio`, `marcarArquivoInconsistente`. `arquivos` e `conjuntos` são `WITHOUT ROWID`.
- **Coletor:** antes de empacotar, `#conferirStaging` confere cada arquivo do staging contra o manifest (tamanho + sha512) e cada linha `ok` contra staging e zip; o que não bate volta para a fila. Índice inválido vira erro da seção. Disjuntor de rede: 20 falhas seguidas sem resposta → `SemConexaoError` para a coleta. Verificação `'nenhuma'` quando não havia ETag nem `.vsc`. O `-aux.json` só vai ao staging se a seção terminou bem ou baixou algo novo (evita reempacotar à toa).
- **Empacotamento:** zip escrito com fsync (arquivo e pasta), checagem de espaço antes, `ZipCorrompidoError` (zip ilegível é posto de lado como `.corrompido-<ts>` e o município é rebaixado uma vez), `listarNomesZip`.
- **HTTP:** 8 tentativas, espera com variação aleatória (jitter) e pausa global de todas as requisições após um 429.
- **Integridade:** o hash do diretório usa base64 em que o TSE troca `/` por `-` (não é base64url); `digestoDoDiretorio` converte antes de decodificar.
- **Painel/CLI:** Host restrito a `127.0.0.1`/`localhost`, POST exige o cabeçalho `x-tse-auditor: 1`; rotas globais `POST /api/coleta/iniciar|parar`; status de UF `aguardando`, `baixando`, `pausando`, `pausada`, `baixado`, `baixado_com_erros`; projeção = bytes ÷ seções concluídas × total, preliminar até max(1000, 1%) das seções; `manifestErro` no estado.
- **Vocabulário de status:** seções `pendente`, `completa`, `erro`, `sem_arquivos`, `agregada`; arquivos `pendente`, `ok`, `erro`; verificação `dir`, `vsc`, `md5`, `nenhuma`.
- **Adiado:** `--cargo` (vai para a análise); abaixo de 20 GB livres a coleta para (não "pausa") e precisa ser reiniciada; seções `sem_arquivos` não são revisitadas; reempacotar reescreve o zip inteiro do município.

## Fatos confirmados no servidor do TSE (29/10/2026)

Estes formatos foram verificados contra `resultados.tse.jus.br` e são a base dos testes.

- `https://resultados.tse.jus.br/oficial/comum/config/ele-c.json` lista os pleitos (`pl[]`: `cd`, `c` = ciclo, `dt`, `e[]` com `cd`, `nm`, `t` = turno, `abr[].cp[]` = cargos) e traz templates de diretório em `arq[]`:
  - `tp: "cs"` → `<base>/<ambiente>/<ciclo>/arquivo-urna/<cd_pleito>/config/<uf>`
  - `tp: "aux"` → `<base>/<ambiente>/<ciclo>/arquivo-urna/<cd_pleito>/dados/<uf>/<municipio>/<zona>/<secao>`
- Config de seções: `<dir cs>/<uf>-p<pleito com 6 dígitos>-cs.json`, ex.: `.../3220/config/ac/ac-p003220-cs.json`. Formato: `abr[0].mu[]` (`cd`, `nm`, `zon[]` → `cd`, `sec[]` → `ns`). Seção agregada tem `nsp` (seção principal) e não tem índice (HTTP 404). A principal tem `nsa: [...]`.
- Índice da seção: `<dir aux>/p003220-ac-m01066-z0004-s0077-aux.json` → `{ st, hashes: [{ hash, st, dr, hr, arq: [{ nm, tp }] }] }`. Tipos vistos: `bu`, `rdv`, `log`, `vota`.
- Arquivo: `<dir aux>/<hash>/<nm>`.
- Integridade:
  - `ETag` = MD5 do conteúdo (aspas incluídas).
  - `hash` do diretório = hex do texto base64 do **sha256 do `-vota.vsc`**. Atenção: o TSE troca `/` por `-` (não é o base64url padrão, em que `-` vale `+`); decodificar com `Buffer.from(x, 'base64')` direto dá o digest errado.
  - O `.vsc` (binário ASN.1) contém o **sha512** de `bu.dat`, `rdv.dat` e `log.jez`.
- Cabeçalhos: `x-ratelimit-limit: 5000`. Tamanho típico: ~190 KB por seção por turno, ou seja, ~200 GB para o Brasil nos dois turnos.
- Pleito 3220 = 1º turno (04/10/2026), 3221 = 2º turno (25/10/2026). SP tem 645 municípios e 103.904 seções (config de 6 MB).

## Estrutura de arquivos

```
package.json, .gitignore, .gitattributes
scripts/baixar-fixtures.sh          baixa do TSE os arquivos reais usados nos testes
src/
  cli.js                            comandos eleicoes | coletar | painel
  config.js                         padrões (HD, URL base, concorrência, UA, espaço mínimo) e pasta do ciclo
  ufs.js                            lista das 27 UFs + ZZ, na ordem de coleta
  formatar.js                       bytes legíveis e linha de progresso do CLI
  net/http.js                       HttpClient: limite de conexões, retentativa com espera progressiva
  tse/eleicoes.js                   lê ele-c.json
  tse/urls.js                       monta URLs a partir dos templates do ele-c.json
  tse/configSecoes.js               lê <uf>-p<pleito>-cs.json
  tse/indiceSecao.js                lê o -aux.json da seção
  tse/integridade.js                MD5 do ETag, .vsc × hash do diretório, sha512 dentro do .vsc
  storage/manifest.js               manifest.sqlite (UFs, municípios, seções, conjuntos, arquivos, eventos)
  storage/disco.js                  espaço livre e detecção de HD desconectado
  storage/empacotar.js              staging → zip sem compressão (mescla com zip existente)
  coleta/coletor.js                 orquestra a coleta
  coleta/estado.js                  agrega manifest + coletor no "estado" do painel
  painel/server.js                  HTTP: estáticos, /api/estado, /api/eventos (SSE), pausar/iniciar
  painel/public/index.html, app.js, estilo.css
test/
  helpers/fakeTse.js                servidor que imita o TSE a partir das fixtures, com falhas injetáveis
  helpers/zip.js                    lê um zip para Map nos testes
  fixtures/tse/oficial/...          espelho dos caminhos do TSE (arquivos reais + configs reduzidas)
  (um *.test.js por módulo, espelhando src/)
```

Layout no HD (pasta `<HD>/tse2026/`):

```
manifest.sqlite
raw/<UF>/<pleito>/<uf>-p<pleito>-cs.json     config oficial da UF
raw/<UF>/<pleito>/<mun>.zip                  <zona>/<secao>/<aux.json> e <zona>/<secao>/<hash>/<arquivo>
staging/<UF>/<pleito>/<mun>/...              temporário, apagado após empacotar
```

Status de seção no manifest: `pendente`, `completa`, `agregada`, `sem_arquivos`, `erro`. Seções `pendente` e `erro` são reprocessadas a cada execução.

---

### Task 1: Esqueleto do projeto

**Files:**
- Create: `package.json`, `.gitignore`, `test/smoke.test.js`

- [ ] **Step 1: Criar `package.json`**

```json
{
  "name": "tse-auditor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.12" },
  "bin": { "tse-auditor": "src/cli.js" },
  "scripts": {
    "test": "node --test \"test/**/*.test.js\""
  },
  "dependencies": {
    "better-sqlite3": "^13.0.3",
    "yauzl": "^3.4.0",
    "yazl": "^3.3.1"
  }
}
```

- [ ] **Step 2: Criar `.gitignore`**

```
node_modules/
*.part
```

- [ ] **Step 3: Instalar dependências**

Run: `npm install`
Expected: `added N packages`, sem erro de compilação do `better-sqlite3` (usa binário pré-compilado).

- [ ] **Step 4: Teste de fumaça**

`test/smoke.test.js`:

```js
import { test } from 'node:test';

test('dependências carregam', async () => {
  await import('better-sqlite3');
  await import('yazl');
  await import('yauzl');
});
```

Run: `npm test`
Expected: `# pass 1`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore test/smoke.test.js
git commit -m "chore: esqueleto do projeto Node"
```

---

### Task 2: Fixtures reais do TSE

**Files:**
- Create: `scripts/baixar-fixtures.sh`, `.gitattributes`
- Create: `test/fixtures/tse/oficial/ele2026/arquivo-urna/3220/config/ac/ac-p003220-cs.json`
- Create: `test/fixtures/tse/oficial/ele2026/arquivo-urna/3221/config/ac/ac-p003221-cs.json`
- Create: `test/fixtures/tse/oficial/ele2026/arquivo-urna/3220/dados/ac/01066/0004/0079/p003220-ac-m01066-z0004-s0079-aux.json`
- Generated: `test/fixtures/tse/oficial/comum/config/ele-c.json` e os arquivos reais da seção AC 01066/0004/0077 nos dois turnos

- [ ] **Step 1: Criar `scripts/baixar-fixtures.sh`**

```bash
#!/usr/bin/env bash
# Baixa do TSE os arquivos reais usados como fixtures:
# ele-c.json e a seção AC / Porto Walter (01066) / zona 0004 / seção 0077, 1º e 2º turnos.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=https://resultados.tse.jus.br/oficial
DEST=test/fixtures/tse/oficial

baixar() {
  mkdir -p "$DEST/$(dirname "$1")"
  curl -sSf --retry 3 -o "$DEST/$1" "$BASE/$1"
}

baixar comum/config/ele-c.json
for P in 3220 3221; do
  DIR=ele2026/arquivo-urna/$P/dados/ac/01066/0004/0077
  AUX=p00$P-ac-m01066-z0004-s0077-aux.json
  baixar "$DIR/$AUX"
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const h of j.hashes) for (const a of h.arq) console.log(h.hash + "/" + a.nm);
  ' "$DEST/$DIR/$AUX" | while read -r ARQ; do baixar "$DIR/$ARQ"; done
done
```

- [ ] **Step 2: Rodar o script**

Run: `chmod +x scripts/baixar-fixtures.sh && scripts/baixar-fixtures.sh && find test/fixtures -type f | sort`
Expected (10 arquivos):

```
test/fixtures/tse/oficial/comum/config/ele-c.json
test/fixtures/tse/oficial/ele2026/arquivo-urna/3220/dados/ac/01066/0004/0077/4a6b704a7350756e6a5a496433337049453538516932486a676159553779785542752d6d765749354f41343d/o03220ac0106600040077-bu.dat
.../3220/.../4a6b70.../o03220ac0106600040077-log.jez
.../3220/.../4a6b70.../o03220ac0106600040077-rdv.dat
.../3220/.../4a6b70.../o03220ac0106600040077-vota.vsc
.../3220/dados/ac/01066/0004/0077/p003220-ac-m01066-z0004-s0077-aux.json
.../3221/dados/ac/01066/0004/0077/50394b614b6e4150306b5a49585533766870625955416c32685761495a53564a426a3371786d767a676c383d/o03221ac0106600040077-{bu.dat,log.jez,rdv.dat,vota.vsc}
.../3221/dados/ac/01066/0004/0077/p003221-ac-m01066-z0004-s0077-aux.json
```

Run: `md5sum test/fixtures/tse/oficial/ele2026/arquivo-urna/3220/dados/ac/01066/0004/0077/*/o03220ac0106600040077-bu.dat`
Expected: `09216d24b6af4b16590337b73d83c408`

- [ ] **Step 3: Configs reduzidas (escritas à mão)**

As configs reais têm centenas de seções; os testes usam versões reduzidas com o mesmo formato. A seção `0078` não tem fixture (o servidor falso responde 404, simulando índice ausente), a `0079` não tem arquivos e a `0270` é agregada à `0077`.

`test/fixtures/tse/oficial/ele2026/arquivo-urna/3220/config/ac/ac-p003220-cs.json`:

```json
{ "dg" : "05/10/2026", "hg" : "02:59:38", "idg" : "2785973", "f" : "o", "cdp" : "3220", "abr" : [
{ "cd" : "ac", "ds" : "ACRE", "mu" : [
{ "cd" : "01066", "nm" : "PORTO WALTER", "zon" : [
{ "cd" : "0004", "sec" : [
{ "ns" : "0077", "nsa" : ["0270"], "da" : "04/10/2026", "ha" : "21:08:17" },
{ "ns" : "0078", "da" : "04/10/2026", "ha" : "21:08:17" },
{ "ns" : "0079", "da" : "04/10/2026", "ha" : "21:08:17" },
{ "ns" : "0270", "nsp" : "0077" } ] } ] } ] } ] }
```

`test/fixtures/tse/oficial/ele2026/arquivo-urna/3221/config/ac/ac-p003221-cs.json`:

```json
{ "dg" : "26/10/2026", "hg" : "02:59:38", "idg" : "4300000", "f" : "o", "cdp" : "3221", "abr" : [
{ "cd" : "ac", "ds" : "ACRE", "mu" : [
{ "cd" : "01066", "nm" : "PORTO WALTER", "zon" : [
{ "cd" : "0004", "sec" : [
{ "ns" : "0077", "nsa" : ["0270"], "da" : "25/10/2026", "ha" : "21:08:17" },
{ "ns" : "0270", "nsp" : "0077" } ] } ] } ] } ] }
```

`test/fixtures/tse/oficial/ele2026/arquivo-urna/3220/dados/ac/01066/0004/0079/p003220-ac-m01066-z0004-s0079-aux.json`:

```json
{ "dg" : "05/10/2026", "hg" : "12:52:50", "idg" : "2879124", "f" : "o", "st" : "Não instalada", "hashes" : [ ] }
```

- [ ] **Step 4: Impedir conversão de fim de linha nas fixtures**

`.gitattributes`:

```
test/fixtures/** -text
```

- [ ] **Step 5: Commit**

```bash
git add scripts/baixar-fixtures.sh .gitattributes test/fixtures
git commit -m "test: fixtures reais do TSE (AC 01066/0004/0077, dois turnos)"
```

---

### Task 3: Cliente HTTP educado

**Files:**
- Create: `src/net/http.js`
- Test: `test/net/http.test.js`

- [ ] **Step 1: Escrever os testes**

`test/net/http.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, HttpError } from '../../src/net/http.js';

function fetchRoteirizado(respostas) {
  const chamadas = [];
  const fetchImpl = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    return new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} });
  };
  return { fetchImpl, chamadas };
}

function semEspera() {
  const esperas = [];
  return { esperas, dormir: async (ms) => { esperas.push(ms); } };
}

test('devolve status, corpo e etag em 200 e envia o User-Agent', async () => {
  const { fetchImpl, chamadas } = fetchRoteirizado([{ status: 200, body: 'ok', headers: { etag: '"abc"' } }]);
  const http = new HttpClient({ fetchImpl, userAgent: 'teste/1' });
  const r = await http.get('http://x/a');
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), 'ok');
  assert.equal(r.etag, '"abc"');
  assert.equal(chamadas[0].opcoes.headers['user-agent'], 'teste/1');
});

test('404 volta sem retentar', async () => {
  const { fetchImpl, chamadas } = fetchRoteirizado([{ status: 404 }]);
  const r = await new HttpClient({ fetchImpl }).get('http://x/a');
  assert.equal(r.status, 404);
  assert.equal(chamadas.length, 1);
});

test('retenta 429 e 5xx com espera progressiva', async () => {
  const { fetchImpl, chamadas } = fetchRoteirizado([{ status: 429 }, { status: 503 }, { status: 200, body: 'ok' }]);
  const { esperas, dormir } = semEspera();
  const r = await new HttpClient({ fetchImpl, dormir, esperaBaseMs: 100 }).get('http://x/a');
  assert.equal(r.status, 200);
  assert.equal(chamadas.length, 3);
  assert.deepEqual(esperas, [100, 200]);
});

test('respeita Retry-After', async () => {
  const { fetchImpl } = fetchRoteirizado([{ status: 429, headers: { 'retry-after': '7' } }, { status: 200 }]);
  const { esperas, dormir } = semEspera();
  await new HttpClient({ fetchImpl, dormir, esperaBaseMs: 100 }).get('http://x/a');
  assert.deepEqual(esperas, [7000]);
});

test('falha de rede também é retentada', async () => {
  const { fetchImpl } = fetchRoteirizado([new TypeError('fetch failed'), { status: 200, body: 'ok' }]);
  const { esperas, dormir } = semEspera();
  const r = await new HttpClient({ fetchImpl, dormir, esperaBaseMs: 100 }).get('http://x/a');
  assert.equal(r.body.toString(), 'ok');
  assert.deepEqual(esperas, [100]);
});

test('desiste depois do número de tentativas', async () => {
  const { fetchImpl } = fetchRoteirizado([{ status: 500 }, { status: 500 }, { status: 500 }]);
  const { esperas, dormir } = semEspera();
  const http = new HttpClient({ fetchImpl, dormir, esperaBaseMs: 100, tentativas: 3 });
  await assert.rejects(http.get('http://x/a'), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 500);
    assert.match(err.message, /HTTP 500 após 3 tentativas/);
    return true;
  });
  assert.deepEqual(esperas, [100, 200]);
});

test('limita as conexões simultâneas', async () => {
  let ativas = 0;
  let maximo = 0;
  const fetchImpl = async () => {
    ativas++;
    maximo = Math.max(maximo, ativas);
    await new Promise((r) => setTimeout(r, 10));
    ativas--;
    return new Response('ok');
  };
  const http = new HttpClient({ fetchImpl, concorrencia: 2 });
  await Promise.all(Array.from({ length: 6 }, (_, i) => http.get(`http://x/${i}`)));
  assert.equal(maximo, 2);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/net/http.test.js`
Expected: FAIL, `Cannot find module '.../src/net/http.js'`

- [ ] **Step 3: Implementar `src/net/http.js`**

```js
export class HttpError extends Error {
  constructor(mensagem, { url, status } = {}) {
    super(mensagem);
    this.url = url;
    this.status = status;
  }
}

const retentavel = (status) => status === 429 || status >= 500;
const dormirPadrao = (ms) => new Promise((r) => setTimeout(r, ms));

// GET com limite de conexões simultâneas e espera progressiva em 429, 5xx e falhas de rede.
// Outros status (inclusive 404) voltam para quem chamou decidir.
export class HttpClient {
  #livres;
  #fila = [];

  constructor({
    concorrencia = 4,
    userAgent = 'tse-auditor',
    tentativas = 6,
    esperaBaseMs = 1000,
    esperaMaxMs = 60_000,
    timeoutMs = 120_000,
    fetchImpl = (...args) => fetch(...args),
    dormir = dormirPadrao,
  } = {}) {
    this.#livres = concorrencia;
    Object.assign(this, { userAgent, tentativas, esperaBaseMs, esperaMaxMs, timeoutMs, fetchImpl, dormir });
  }

  async #adquirir() {
    if (this.#livres > 0) {
      this.#livres--;
      return;
    }
    await new Promise((r) => this.#fila.push(r));
  }

  #liberar() {
    const proximo = this.#fila.shift();
    if (proximo) proximo();
    else this.#livres++;
  }

  async get(url) {
    let ultimoErro;
    for (let tentativa = 1; tentativa <= this.tentativas; tentativa++) {
      let esperaMs = Math.min(this.esperaBaseMs * 2 ** (tentativa - 1), this.esperaMaxMs);
      await this.#adquirir();
      try {
        const resp = await this.fetchImpl(url, {
          headers: { 'user-agent': this.userAgent },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!retentavel(resp.status)) {
          const body = Buffer.from(await resp.arrayBuffer());
          return { status: resp.status, body, etag: resp.headers.get('etag') };
        }
        await resp.arrayBuffer().catch(() => {});
        const retryAfter = Number(resp.headers.get('retry-after'));
        if (retryAfter > 0) esperaMs = Math.min(retryAfter * 1000, this.esperaMaxMs);
        ultimoErro = new HttpError(`HTTP ${resp.status}`, { url, status: resp.status });
      } catch (err) {
        ultimoErro = new HttpError(`falha de rede: ${err.message}`, { url });
      } finally {
        this.#liberar();
      }
      if (tentativa < this.tentativas) await this.dormir(esperaMs);
    }
    throw new HttpError(`${ultimoErro.message} após ${this.tentativas} tentativas: ${url}`, {
      url,
      status: ultimoErro.status,
    });
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/net/http.test.js`
Expected: `# pass 7`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add src/net/http.js test/net/http.test.js
git commit -m "feat: cliente HTTP com limite de conexões e retentativa"
```

---

### Task 4: Servidor falso do TSE para testes

**Files:**
- Create: `test/helpers/fakeTse.js`, `test/helpers/zip.js`
- Test: `test/helpers/fakeTse.test.js`

- [ ] **Step 1: Criar `test/helpers/fakeTse.js`**

```js
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ_FIXTURES = fileURLToPath(new URL('../fixtures/tse', import.meta.url));

// Dados das fixtures reais (seção AC / 01066 / 0004 / 0077).
export const FX = {
  hash3220: '4a6b704a7350756e6a5a496433337049453538516932486a676159553779785542752d6d765749354f41343d',
  hash3221: '50394b614b6e4150306b5a49585533766870625955416c32685761495a53564a426a3371786d767a676c383d',
  dirSecao: (pleito, secao = '0077') => `oficial/ele2026/arquivo-urna/${pleito}/dados/ac/01066/0004/${secao}`,
  secao: (pleito, secao = '0077') => ({ pleito, uf: 'ac', mun: '01066', zona: '0004', secao }),
};

export const lerFixture = (relativo) => readFile(path.join(RAIZ_FIXTURES, relativo));

const md5 = (buf) => createHash('md5').update(buf).digest('hex');

// Imita resultados.tse.jus.br servindo test/fixtures/tse, com ETag = MD5 como o servidor real.
// falhas: { '<sufixo do caminho>': [503, 'corromper', 'corromperComEtag', ...] }, consumidas uma por requisição.
//   número             → responde com esse status
//   'corromper'        → altera o 1º byte e mantém o ETag do original (erro de transmissão)
//   'corromperComEtag' → altera o 1º byte e calcula o ETag sobre o conteúdo alterado (arquivo trocado na origem)
export async function iniciarFakeTse({ falhas = {} } = {}) {
  const pendentes = Object.fromEntries(Object.entries(falhas).map(([k, v]) => [k, [...v]]));
  const requisicoes = [];
  const servidor = http.createServer(async (req, res) => {
    const caminho = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requisicoes.push(caminho);
    const chave = Object.keys(pendentes).find((k) => caminho.endsWith(k) && pendentes[k].length > 0);
    const falha = chave ? pendentes[chave].shift() : undefined;
    if (typeof falha === 'number') {
      res.writeHead(falha);
      res.end();
      return;
    }
    let corpo;
    try {
      corpo = await readFile(path.join(RAIZ_FIXTURES, caminho));
    } catch {
      res.writeHead(404);
      res.end('NoSuchKey');
      return;
    }
    let etag = md5(corpo);
    if (falha === 'corromper' || falha === 'corromperComEtag') {
      corpo = Buffer.from(corpo);
      corpo[0] ^= 0xff;
      if (falha === 'corromperComEtag') etag = md5(corpo);
    }
    res.writeHead(200, { etag: `"${etag}"`, 'content-length': corpo.length });
    res.end(corpo);
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${servidor.address().port}`,
    requisicoes,
    fechar: () => new Promise((r) => { servidor.closeAllConnections(); servidor.close(r); }),
  };
}
```

- [ ] **Step 2: Criar `test/helpers/zip.js`**

```js
import yauzl from 'yauzl';
import { buffer } from 'node:stream/consumers';
import { promisify } from 'node:util';

// Lê um zip inteiro: Map<nome da entrada, { dados: Buffer, metodo: número do método de compressão }>.
export async function lerZip(caminho) {
  const zip = await promisify(yauzl.open)(caminho, { lazyEntries: true, autoClose: false });
  const abrir = promisify(zip.openReadStream.bind(zip));
  const conteudo = new Map();
  await new Promise((ok, falha) => {
    zip.on('entry', async (e) => {
      try {
        conteudo.set(e.fileName, { dados: await buffer(await abrir(e)), metodo: e.compressionMethod });
        zip.readEntry();
      } catch (err) {
        falha(err);
      }
    });
    zip.on('end', ok);
    zip.on('error', falha);
    zip.readEntry();
  });
  zip.close();
  return conteudo;
}
```

- [ ] **Step 3: Testar o servidor falso**

`test/helpers/fakeTse.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { iniciarFakeTse, lerFixture } from './fakeTse.js';

const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const ELE_C = 'oficial/comum/config/ele-c.json';

test('serve fixtures com ETag MD5 e 404 para o resto', async (t) => {
  const fake = await iniciarFakeTse();
  t.after(fake.fechar);
  const r = await fetch(`${fake.base}/${ELE_C}`);
  const corpo = Buffer.from(await r.arrayBuffer());
  assert.deepEqual(corpo, await lerFixture(ELE_C));
  assert.equal(r.headers.get('etag'), `"${md5(corpo)}"`);
  assert.equal((await fetch(`${fake.base}/oficial/nada.json`)).status, 404);
  assert.deepEqual(fake.requisicoes, [`/${ELE_C}`, '/oficial/nada.json']);
});

test('injeta falhas em ordem', async (t) => {
  const fake = await iniciarFakeTse({ falhas: { 'ele-c.json': [503, 'corromper', 'corromperComEtag'] } });
  t.after(fake.fechar);
  const original = await lerFixture(ELE_C);
  assert.equal((await fetch(`${fake.base}/${ELE_C}`)).status, 503);

  const corrompido = await fetch(`${fake.base}/${ELE_C}`);
  const c1 = Buffer.from(await corrompido.arrayBuffer());
  assert.notDeepEqual(c1, original);
  assert.equal(corrompido.headers.get('etag'), `"${md5(original)}"`);

  const trocado = await fetch(`${fake.base}/${ELE_C}`);
  const c2 = Buffer.from(await trocado.arrayBuffer());
  assert.equal(trocado.headers.get('etag'), `"${md5(c2)}"`);

  assert.deepEqual(Buffer.from(await (await fetch(`${fake.base}/${ELE_C}`)).arrayBuffer()), original);
});
```

Run: `node --test test/helpers/fakeTse.test.js`
Expected: `# pass 2`

- [ ] **Step 4: Commit**

```bash
git add test/helpers
git commit -m "test: servidor falso do TSE com falhas injetáveis"
```

---

### Task 5: Descoberta de eleições e URLs

**Files:**
- Create: `src/tse/eleicoes.js`, `src/tse/urls.js`
- Test: `test/tse/eleicoes.test.js`, `test/tse/urls.test.js`

- [ ] **Step 1: Escrever os testes**

`test/tse/eleicoes.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerEleicoes, buscarEleicoes } from '../../src/tse/eleicoes.js';
import { HttpClient } from '../../src/net/http.js';
import { iniciarFakeTse, lerFixture } from '../helpers/fakeTse.js';

test('lerEleicoes extrai templates, pleitos, turnos e cargos', async () => {
  const { templates, pleitos } = lerEleicoes(JSON.parse(await lerFixture('oficial/comum/config/ele-c.json')));
  assert.equal(templates.cs, '<base>/<ambiente>/<ciclo>/arquivo-urna/<cd_pleito>/config/<uf>');
  assert.equal(templates.aux, '<base>/<ambiente>/<ciclo>/arquivo-urna/<cd_pleito>/dados/<uf>/<municipio>/<zona>/<secao>');

  const p1 = pleitos.find((p) => p.cd === '3220');
  assert.equal(p1.ciclo, 'ele2026');
  assert.equal(p1.data, '04/10/2026');
  const presidente1 = p1.eleicoes.find((e) => e.cd === '6257');
  assert.equal(presidente1.turno, 1);
  assert.deepEqual(presidente1.cargos, [{ cd: '1', nome: 'Presidente' }]);

  const presidente2 = pleitos.find((p) => p.cd === '3221').eleicoes.find((e) => e.cd === '6258');
  assert.equal(presidente2.turno, 2);
});

test('lerEleicoes recusa ele-c.json sem os diretórios de arquivo de urna', () => {
  assert.throws(() => lerEleicoes({ arq: [], pl: [] }), /"cs"/);
});

test('buscarEleicoes baixa o ele-c.json do servidor', async (t) => {
  const fake = await iniciarFakeTse();
  t.after(fake.fechar);
  const { pleitos } = await buscarEleicoes(new HttpClient(), { base: fake.base, ambiente: 'oficial' });
  assert.ok(pleitos.some((p) => p.cd === '3221'));
});
```

`test/tse/urls.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarUrls, nomeConfigSecoes, nomeIndiceSecao } from '../../src/tse/urls.js';
import { FX } from '../helpers/fakeTse.js';

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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/tse/eleicoes.test.js test/tse/urls.test.js`
Expected: FAIL, módulos não encontrados.

- [ ] **Step 3: Implementar `src/tse/eleicoes.js`**

```js
// Lê o ele-c.json do TSE: pleitos (o que os arquivos de urna usam), eleições, cargos
// e os templates de diretório de onde ficam config e dados das urnas.
export function lerEleicoes(json) {
  const templates = Object.fromEntries((json.arq ?? []).map((a) => [a.tp, a.dir]));
  for (const tp of ['cs', 'aux']) {
    if (!templates[tp]) throw new Error(`ele-c.json sem o diretório "${tp}"`);
  }
  const pleitos = json.pl.map((p) => ({
    cd: p.cd,
    ciclo: p.c,
    data: p.dt,
    eleicoes: p.e.map((e) => ({
      cd: e.cd,
      nome: e.nm,
      turno: Number(e.t),
      cargos: (e.abr ?? []).flatMap((a) => a.cp ?? []).map((c) => ({ cd: c.cd, nome: c.ds })),
    })),
  }));
  return { templates: { cs: templates.cs, aux: templates.aux }, pleitos };
}

export async function buscarEleicoes(http, { base, ambiente }) {
  const url = `${base}/${ambiente}/comum/config/ele-c.json`;
  const r = await http.get(url);
  if (r.status !== 200) throw new Error(`ele-c.json: HTTP ${r.status} em ${url}`);
  return lerEleicoes(JSON.parse(r.body.toString('utf8')));
}
```

- [ ] **Step 4: Implementar `src/tse/urls.js`**

```js
const p6 = (pleito) => String(pleito).padStart(6, '0');

export const nomeConfigSecoes = ({ pleito, uf }) => `${uf}-p${p6(pleito)}-cs.json`;

export const nomeIndiceSecao = ({ pleito, uf, mun, zona, secao }) =>
  `p${p6(pleito)}-${uf}-m${mun}-z${zona}-s${secao}-aux.json`;

function preencher(template, valores) {
  return template.replace(/<(\w+)>/g, (_, chave) => {
    if (!(chave in valores)) throw new Error(`template sem valor para <${chave}>: ${template}`);
    return valores[chave];
  });
}

// Monta as URLs a partir dos templates do ele-c.json, para não fixar o formato de um ano no código.
export function criarUrls({ base, ambiente, templates }) {
  const dirSecao = ({ ciclo, pleito, uf, mun, zona, secao }) =>
    preencher(templates.aux, { base, ambiente, ciclo, cd_pleito: pleito, uf, municipio: mun, zona, secao });
  return {
    configSecoes: ({ ciclo, pleito, uf }) =>
      `${preencher(templates.cs, { base, ambiente, ciclo, cd_pleito: pleito, uf })}/${nomeConfigSecoes({ pleito, uf })}`,
    indiceSecao: (s) => `${dirSecao(s)}/${nomeIndiceSecao(s)}`,
    arquivo: (s, hash, nome) => `${dirSecao(s)}/${hash}/${nome}`,
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test test/tse/eleicoes.test.js test/tse/urls.test.js`
Expected: `# pass 7`

- [ ] **Step 6: Commit**

```bash
git add src/tse/eleicoes.js src/tse/urls.js test/tse/eleicoes.test.js test/tse/urls.test.js
git commit -m "feat: descoberta de eleições e URLs a partir do ele-c.json"
```

---

### Task 6: Leitura da config de seções e do índice da seção

**Files:**
- Create: `src/tse/configSecoes.js`, `src/tse/indiceSecao.js`
- Test: `test/tse/configSecoes.test.js`, `test/tse/indiceSecao.test.js`

- [ ] **Step 1: Escrever os testes**

`test/tse/configSecoes.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerConfigSecoes } from '../../src/tse/configSecoes.js';
import { lerFixture } from '../helpers/fakeTse.js';

test('lê municípios, zonas e seções, marcando as agregadas', async () => {
  const json = JSON.parse(await lerFixture('oficial/ele2026/arquivo-urna/3220/config/ac/ac-p003220-cs.json'));
  assert.deepEqual(lerConfigSecoes(json), {
    uf: 'ac',
    municipios: [{
      mun: '01066',
      nome: 'PORTO WALTER',
      secoes: [
        { zona: '0004', secao: '0077', principal: null },
        { zona: '0004', secao: '0078', principal: null },
        { zona: '0004', secao: '0079', principal: null },
        { zona: '0004', secao: '0270', principal: '0077' },
      ],
    }],
  });
});

test('recusa config sem "abr"', () => {
  assert.throws(() => lerConfigSecoes({}), /abr/);
});
```

`test/tse/indiceSecao.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerIndiceSecao } from '../../src/tse/indiceSecao.js';
import { FX, lerFixture } from '../helpers/fakeTse.js';

test('lê o índice real de 2026', async () => {
  const json = JSON.parse(await lerFixture(`${FX.dirSecao('3220')}/p003220-ac-m01066-z0004-s0077-aux.json`));
  const indice = lerIndiceSecao(json);
  assert.equal(indice.status, 'Totalizada');
  assert.equal(indice.conjuntos.length, 1);
  const [c] = indice.conjuntos;
  assert.equal(c.hash, FX.hash3220);
  assert.equal(c.status, 'Totalizado');
  assert.equal(c.data, '04/10/2026');
  assert.equal(c.hora, '18:34:08');
  assert.deepEqual(c.arquivos.map((a) => a.tipo).sort(), ['bu', 'log', 'rdv', 'vota']);
  assert.ok(c.arquivos.some((a) => a.nome === 'o03220ac0106600040077-bu.dat'));
});

test('seção sem arquivos', () => {
  assert.deepEqual(lerIndiceSecao({ st: 'Não instalada', hashes: [] }), { status: 'Não instalada', conjuntos: [] });
});

test('formato de 2022 (nmarq) usa a extensão como tipo', () => {
  const indice = lerIndiceSecao({
    st: 'Totalizada',
    hashes: [{ hash: 'ab', st: 'Totalizado', dr: '02/10/2022', hr: '17:00:00', nmarq: ['o00406-0100100010001.bu', 'o00406-0100100010001.logjez'] }],
  });
  assert.deepEqual(indice.conjuntos[0].arquivos, [
    { nome: 'o00406-0100100010001.bu', tipo: 'bu' },
    { nome: 'o00406-0100100010001.logjez', tipo: 'logjez' },
  ]);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/tse/configSecoes.test.js test/tse/indiceSecao.test.js`
Expected: FAIL, módulos não encontrados.

- [ ] **Step 3: Implementar `src/tse/configSecoes.js`**

```js
// Lê <uf>-p<pleito>-cs.json. Seção agregada traz "nsp" (a seção principal) e não tem arquivos próprios.
export function lerConfigSecoes(json) {
  const abr = json.abr?.[0];
  if (!abr) throw new Error('config de seções sem "abr"');
  return {
    uf: abr.cd,
    municipios: abr.mu.map((m) => ({
      mun: m.cd,
      nome: m.nm,
      secoes: m.zon.flatMap((z) => z.sec.map((s) => ({ zona: z.cd, secao: s.ns, principal: s.nsp ?? null }))),
    })),
  };
}
```

- [ ] **Step 4: Implementar `src/tse/indiceSecao.js`**

```js
// Lê o -aux.json da seção. Cada item de "hashes" é um conjunto de arquivos de uma urna;
// urna substituída (contingência) gera mais de um conjunto, e todos são mantidos.
// 2026 usa "arq: [{ nm, tp }]"; 2022 usava "nmarq: [nome]".
export function lerIndiceSecao(json) {
  return {
    status: json.st ?? null,
    conjuntos: (json.hashes ?? []).map((h) => ({
      hash: h.hash,
      status: h.st ?? null,
      data: h.dr ?? null,
      hora: h.hr ?? null,
      arquivos: h.arq
        ? h.arq.map((a) => ({ nome: a.nm, tipo: a.tp }))
        : (h.nmarq ?? []).map((nome) => ({ nome, tipo: nome.split('.').pop() })),
    })),
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test test/tse/configSecoes.test.js test/tse/indiceSecao.test.js`
Expected: `# pass 5`

- [ ] **Step 6: Commit**

```bash
git add src/tse/configSecoes.js src/tse/indiceSecao.js test/tse/configSecoes.test.js test/tse/indiceSecao.test.js
git commit -m "feat: leitura da config de seções e do índice da seção"
```

---

### Task 7: Cadeia de integridade

**Files:**
- Create: `src/tse/integridade.js`
- Test: `test/tse/integridade.test.js`

- [ ] **Step 1: Escrever os testes**

`test/tse/integridade.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md5, md5DoEtag, sha512Hex, vscConfereComDiretorio, vscContemSha512 } from '../../src/tse/integridade.js';
import { FX, lerFixture } from '../helpers/fakeTse.js';

const arquivo = (pleito, hash, sufixo) => lerFixture(`${FX.dirSecao(pleito)}/${hash}/o0${pleito}ac0106600040077-${sufixo}`);

test('sha256 do .vsc confere com o hash do diretório, nos dois turnos', async () => {
  const vsc1 = await arquivo('3220', FX.hash3220, 'vota.vsc');
  const vsc2 = await arquivo('3221', FX.hash3221, 'vota.vsc');
  assert.ok(vscConfereComDiretorio(vsc1, FX.hash3220));
  assert.ok(vscConfereComDiretorio(vsc2, FX.hash3221));
  assert.ok(!vscConfereComDiretorio(vsc1, FX.hash3221));
  assert.ok(!vscConfereComDiretorio(vsc1, 'zz'));
});

test('o .vsc contém o sha512 de bu, rdv e log', async () => {
  const vsc = await arquivo('3220', FX.hash3220, 'vota.vsc');
  for (const sufixo of ['bu.dat', 'rdv.dat', 'log.jez']) {
    assert.ok(vscContemSha512(vsc, await arquivo('3220', FX.hash3220, sufixo)), sufixo);
  }
  const adulterado = Buffer.from(await arquivo('3220', FX.hash3220, 'bu.dat'));
  adulterado[10] ^= 1;
  assert.ok(!vscContemSha512(vsc, adulterado));
});

test('md5 e sha512', async () => {
  const bu = await arquivo('3220', FX.hash3220, 'bu.dat');
  assert.equal(md5(bu), '09216d24b6af4b16590337b73d83c408');
  assert.equal(sha512Hex(Buffer.from('')).slice(0, 16), 'cf83e1357eefb8bd');
});

test('md5DoEtag aceita ETag simples e ignora multipart', () => {
  assert.equal(md5DoEtag('"09216d24b6af4b16590337b73d83c408"'), '09216d24b6af4b16590337b73d83c408');
  assert.equal(md5DoEtag('W/"09216D24B6AF4B16590337B73D83C408"'), '09216d24b6af4b16590337b73d83c408');
  assert.equal(md5DoEtag('"09216d24b6af4b16590337b73d83c408-3"'), null);
  assert.equal(md5DoEtag(null), null);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/tse/integridade.test.js`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 3: Implementar `src/tse/integridade.js`**

```js
import { createHash } from 'node:crypto';

// Cadeia de integridade dos arquivos de urna publicados pelo TSE (confirmada em 2026):
//   hash do diretório = hex(base64(sha256(-vota.vsc)))
//   o .vsc (ASN.1 assinado) contém o sha512 de bu.dat, rdv.dat e log.jez
// A verificação da assinatura do .vsc fica na etapa de verificação, não na coleta.

export const md5 = (buf) => createHash('md5').update(buf).digest('hex');
export const sha512Hex = (buf) => createHash('sha512').update(buf).digest('hex');

export function digestoDoDiretorio(hashDiretorio) {
  const base64 = Buffer.from(hashDiretorio, 'hex').toString('ascii');
  return Buffer.from(base64, 'base64'); // Node aceita também o alfabeto url-safe (-, _)
}

export function vscConfereComDiretorio(vsc, hashDiretorio) {
  const esperado = digestoDoDiretorio(hashDiretorio);
  return esperado.length === 32 && createHash('sha256').update(vsc).digest().equals(esperado);
}

export function vscContemSha512(vsc, conteudo) {
  return vsc.includes(createHash('sha512').update(conteudo).digest());
}

// ETag do armazenamento do TSE é o MD5 do arquivo; ETag de upload multipart ("...-N") não é.
export function md5DoEtag(etag) {
  const m = /^(?:W\/)?"?([0-9a-f]{32})"?$/i.exec(etag ?? '');
  return m ? m[1].toLowerCase() : null;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/tse/integridade.test.js`
Expected: `# pass 4`

- [ ] **Step 5: Commit**

```bash
git add src/tse/integridade.js test/tse/integridade.test.js
git commit -m "feat: cadeia de integridade ETag, .vsc e hash do diretório"
```

---

### Task 8: Manifest SQLite

**Files:**
- Create: `src/ufs.js`, `src/storage/manifest.js`
- Test: `test/storage/manifest.test.js`

- [ ] **Step 1: Criar `src/ufs.js`**

```js
// Ordem de coleta: alfabética, com o exterior (ZZ) no fim. AC é pequeno e serve de primeira medição.
export const UFS = [
  'ac', 'al', 'am', 'ap', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mg', 'ms', 'mt', 'pa',
  'pb', 'pe', 'pi', 'pr', 'rj', 'rn', 'ro', 'rr', 'rs', 'sc', 'se', 'sp', 'to', 'zz',
];
```

- [ ] **Step 2: Escrever os testes**

`test/storage/manifest.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Manifest } from '../../src/storage/manifest.js';

const S77 = { pleito: '3220', uf: 'ac', mun: '01066', zona: '0004', secao: '0077' };
const MUNICIPIOS = [{
  mun: '01066',
  nome: 'PORTO WALTER',
  secoes: [
    { zona: '0004', secao: '0077', principal: null },
    { zona: '0004', secao: '0270', principal: '0077' },
  ],
}];
const CONJUNTOS = [{
  hash: 'h1', status: 'Totalizado', data: '04/10/2026', hora: '18:34:08',
  arquivos: [{ nome: 'a-bu.dat', tipo: 'bu' }, { nome: 'a-vota.vsc', tipo: 'vota' }],
}];

async function novoManifest(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-manifest-'));
  const caminho = path.join(dir, 'manifest.sqlite');
  const m = new Manifest(caminho);
  t.after(() => m.fechar());
  return { m, caminho };
}

test('UFs ficam na ordem de coleta e podem ser pausadas', async (t) => {
  const { m } = await novoManifest(t);
  m.registrarUfs(['zz', 'ac']);
  assert.deepEqual(m.ufs(), [{ uf: 'ac', ordem: 0, pausada: 0 }, { uf: 'zz', ordem: 27, pausada: 0 }]);
  m.definirPausa('zz', true);
  assert.equal(m.ufPausada('zz'), true);
  assert.equal(m.ufPausada('ac'), false);
  m.registrarUfs(['zz']);
  assert.equal(m.ufPausada('zz'), true, 'registrar de novo não desfaz a pausa');
});

test('registrarConfig é idempotente e marca seções agregadas', async (t) => {
  const { m } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  assert.deepEqual(m.municipiosDaUf('ac'), [{ mun: '01066', nome: 'PORTO WALTER' }]);
  assert.deepEqual(m.secoesPendentes('3220', 'ac', '01066'), [S77]);
  const agregada = m.secao({ ...S77, secao: '0270' });
  assert.equal(agregada.status, 'agregada');
  assert.equal(agregada.principal, '0077');
});

test('índice, arquivos e finalização de seção', async (t) => {
  const { m } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  m.registrarIndice(S77, CONJUNTOS, (hash, nome) => `http://x/${hash}/${nome}`);
  m.registrarIndice(S77, CONJUNTOS, (hash, nome) => `http://x/${hash}/${nome}`);

  const arquivos = m.arquivosDaSecao(S77);
  assert.equal(arquivos.length, 2);
  assert.equal(arquivos[0].nome, 'a-bu.dat');
  assert.equal(arquivos[0].status, 'pendente');
  assert.equal(arquivos[0].url, 'http://x/h1/a-bu.dat');

  m.marcarArquivo(S77, 'h1', 'a-bu.dat', { status: 'ok', bytes: 10, md5: 'm', sha512: 's', verificacao: 'vsc' });
  const bu = m.arquivosDaSecao(S77)[0];
  assert.equal(bu.status, 'ok');
  assert.equal(bu.bytes, 10);
  assert.equal(bu.verificacao, 'vsc');
  assert.equal(bu.tentativas, 1);
  assert.ok(bu.baixado_em);

  m.finalizarSecao(S77, { status: 'completa', bytes: 10 });
  assert.deepEqual(m.secoesPendentes('3220', 'ac', '01066'), []);
  assert.equal(m.secao(S77).status, 'completa');

  m.finalizarSecao(S77, { status: 'erro', erro: 'a-bu.dat: falhou' });
  assert.deepEqual(m.secoesPendentes('3220', 'ac', '01066'), [S77], 'seção com erro volta para a fila');
  assert.deepEqual(m.errosRecentes(5).map((e) => [e.secao, e.erro]), [['0077', 'a-bu.dat: falhou']]);
});

test('municípios empacotados', async (t) => {
  const { m } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  assert.equal(m.municipio('3220', 'ac', '01066').empacotado_em, null);
  assert.equal(m.municipio('3221', 'ac', '01066'), undefined);
  m.marcarEmpacotado('3220', 'ac', '01066', 1234);
  const mun = m.municipio('3220', 'ac', '01066');
  assert.equal(mun.zip_bytes, 1234);
  assert.ok(mun.empacotado_em);
});

test('resumo por UF e eventos', async (t) => {
  const { m } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  m.finalizarSecao(S77, { status: 'completa', bytes: 10 });
  const resumo = m.resumoPorUf().sort((a, b) => a.status.localeCompare(b.status));
  assert.deepEqual(resumo, [
    { uf: 'ac', status: 'agregada', n: 1, bytes: 0 },
    { uf: 'ac', status: 'completa', n: 1, bytes: 10 },
  ]);
  m.registrarEvento('erro', 'ac', 'falhou x');
  const [ev] = m.eventos(10);
  assert.equal(ev.nivel, 'erro');
  assert.equal(ev.uf, 'ac');
  assert.equal(ev.msg, 'falhou x');
  assert.ok(ev.ts);
});

test('persiste entre aberturas', async (t) => {
  const { m, caminho } = await novoManifest(t);
  m.registrarConfig('3220', 'ac', MUNICIPIOS);
  m.finalizarSecao(S77, { status: 'completa', bytes: 10 });
  m.fechar();
  const reaberto = new Manifest(caminho);
  t.after(() => reaberto.fechar());
  assert.equal(reaberto.secao(S77).status, 'completa');
});
```

O `t.after(() => m.fechar())` do teste "persiste" chama `fechar` duas vezes; por isso `fechar` precisa ser idempotente.

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test test/storage/manifest.test.js`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 4: Implementar `src/storage/manifest.js`**

```js
import Database from 'better-sqlite3';
import { UFS } from '../ufs.js';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS ufs (
  uf TEXT PRIMARY KEY,
  ordem INTEGER NOT NULL,
  pausada INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS municipios (
  pleito TEXT NOT NULL, uf TEXT NOT NULL, mun TEXT NOT NULL,
  nome TEXT NOT NULL,
  empacotado_em TEXT,
  zip_bytes INTEGER,
  PRIMARY KEY (pleito, uf, mun)
);
CREATE TABLE IF NOT EXISTS secoes (
  pleito TEXT NOT NULL, uf TEXT NOT NULL, mun TEXT NOT NULL, zona TEXT NOT NULL, secao TEXT NOT NULL,
  principal TEXT,
  status TEXT NOT NULL DEFAULT 'pendente',
  bytes INTEGER NOT NULL DEFAULT 0,
  erro TEXT,
  atualizado_em TEXT,
  PRIMARY KEY (pleito, uf, mun, zona, secao)
);
CREATE INDEX IF NOT EXISTS secoes_uf_status ON secoes (uf, status, bytes);
CREATE INDEX IF NOT EXISTS secoes_status_data ON secoes (status, atualizado_em);
CREATE TABLE IF NOT EXISTS conjuntos (
  pleito TEXT NOT NULL, uf TEXT NOT NULL, mun TEXT NOT NULL, zona TEXT NOT NULL, secao TEXT NOT NULL,
  hash TEXT NOT NULL,
  status TEXT, data TEXT, hora TEXT,
  PRIMARY KEY (pleito, uf, mun, zona, secao, hash)
);
CREATE TABLE IF NOT EXISTS arquivos (
  pleito TEXT NOT NULL, uf TEXT NOT NULL, mun TEXT NOT NULL, zona TEXT NOT NULL, secao TEXT NOT NULL,
  hash TEXT NOT NULL, nome TEXT NOT NULL,
  tipo TEXT,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',
  bytes INTEGER, md5 TEXT, sha512 TEXT,
  verificacao TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0,
  erro TEXT,
  baixado_em TEXT,
  PRIMARY KEY (pleito, uf, mun, zona, secao, hash, nome)
);
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  nivel TEXT NOT NULL,
  uf TEXT,
  msg TEXT NOT NULL
);
`;

const ONDE_SECAO = 'pleito = @pleito AND uf = @uf AND mun = @mun AND zona = @zona AND secao = @secao';
const chave = (s) => ({ pleito: s.pleito, uf: s.uf, mun: s.mun, zona: s.zona, secao: s.secao });
const agora = () => new Date().toISOString();

// Estado persistente da coleta. Fica no HD, ao lado dos dados; journal em modo DELETE
// (sem WAL, que depende de memória compartilhada e se dá mal com NTFS) e synchronous FULL,
// para sobreviver a um HD desconectado no meio de uma escrita.
export class Manifest {
  #st;

  constructor(caminho) {
    this.db = new Database(caminho);
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
    this.db.exec(ESQUEMA);
    const p = (sql) => this.db.prepare(sql);
    this.#st = {
      inserirUf: p('INSERT OR IGNORE INTO ufs (uf, ordem) VALUES (?, ?)'),
      ufs: p('SELECT uf, ordem, pausada FROM ufs ORDER BY ordem'),
      definirPausa: p('UPDATE ufs SET pausada = ? WHERE uf = ?'),
      ufPausada: p('SELECT pausada FROM ufs WHERE uf = ?'),
      inserirMunicipio: p('INSERT OR IGNORE INTO municipios (pleito, uf, mun, nome) VALUES (@pleito, @uf, @mun, @nome)'),
      inserirSecao: p(`INSERT OR IGNORE INTO secoes (pleito, uf, mun, zona, secao, principal, status, atualizado_em)
                       VALUES (@pleito, @uf, @mun, @zona, @secao, @principal, @status, @agora)`),
      municipiosDaUf: p('SELECT mun, MIN(nome) AS nome FROM municipios WHERE uf = ? GROUP BY mun ORDER BY mun'),
      municipio: p('SELECT * FROM municipios WHERE pleito = ? AND uf = ? AND mun = ?'),
      secoesPendentes: p(`SELECT pleito, uf, mun, zona, secao FROM secoes
                          WHERE pleito = ? AND uf = ? AND mun = ? AND status IN ('pendente', 'erro')
                          ORDER BY zona, secao`),
      secao: p(`SELECT * FROM secoes WHERE ${ONDE_SECAO}`),
      inserirConjunto: p(`INSERT OR IGNORE INTO conjuntos (pleito, uf, mun, zona, secao, hash, status, data, hora)
                          VALUES (@pleito, @uf, @mun, @zona, @secao, @hash, @status, @data, @hora)`),
      inserirArquivo: p(`INSERT OR IGNORE INTO arquivos (pleito, uf, mun, zona, secao, hash, nome, tipo, url)
                         VALUES (@pleito, @uf, @mun, @zona, @secao, @hash, @nome, @tipo, @url)`),
      arquivosDaSecao: p(`SELECT * FROM arquivos WHERE ${ONDE_SECAO} ORDER BY hash, nome`),
      marcarArquivo: p(`UPDATE arquivos SET status = @status, bytes = @bytes, md5 = @md5, sha512 = @sha512,
                          verificacao = @verificacao, erro = @erro, tentativas = tentativas + 1, baixado_em = @agora
                        WHERE ${ONDE_SECAO} AND hash = @hash AND nome = @nome`),
      finalizarSecao: p(`UPDATE secoes SET status = @status, bytes = @bytes, erro = @erro, atualizado_em = @agora
                         WHERE ${ONDE_SECAO}`),
      marcarEmpacotado: p('UPDATE municipios SET empacotado_em = ?, zip_bytes = ? WHERE pleito = ? AND uf = ? AND mun = ?'),
      registrarEvento: p('INSERT INTO eventos (ts, nivel, uf, msg) VALUES (?, ?, ?, ?)'),
      eventos: p('SELECT ts, nivel, uf, msg FROM eventos ORDER BY id DESC LIMIT ?'),
      resumoPorUf: p('SELECT uf, status, COUNT(*) AS n, SUM(bytes) AS bytes FROM secoes GROUP BY uf, status'),
      errosRecentes: p(`SELECT pleito, uf, mun, zona, secao, erro, atualizado_em FROM secoes
                        WHERE status = 'erro' ORDER BY atualizado_em DESC LIMIT ?`),
    };
  }

  fechar() {
    if (this.db.open) this.db.close();
  }

  registrarUfs(ufs) {
    this.db.transaction(() => {
      for (const uf of ufs) this.#st.inserirUf.run(uf, UFS.indexOf(uf));
    })();
  }

  ufs() {
    return this.#st.ufs.all();
  }

  definirPausa(uf, pausada) {
    this.#st.definirPausa.run(pausada ? 1 : 0, uf);
  }

  ufPausada(uf) {
    return this.#st.ufPausada.get(uf)?.pausada === 1;
  }

  registrarConfig(pleito, uf, municipios) {
    this.db.transaction(() => {
      const ts = agora();
      for (const m of municipios) {
        this.#st.inserirMunicipio.run({ pleito, uf, mun: m.mun, nome: m.nome });
        for (const s of m.secoes) {
          this.#st.inserirSecao.run({
            pleito, uf, mun: m.mun, zona: s.zona, secao: s.secao,
            principal: s.principal,
            status: s.principal ? 'agregada' : 'pendente',
            agora: ts,
          });
        }
      }
    })();
  }

  municipiosDaUf(uf) {
    return this.#st.municipiosDaUf.all(uf);
  }

  municipio(pleito, uf, mun) {
    return this.#st.municipio.get(pleito, uf, mun);
  }

  secoesPendentes(pleito, uf, mun) {
    return this.#st.secoesPendentes.all(pleito, uf, mun);
  }

  secao(s) {
    return this.#st.secao.get(chave(s));
  }

  registrarIndice(s, conjuntos, urlDe) {
    this.db.transaction(() => {
      for (const c of conjuntos) {
        this.#st.inserirConjunto.run({ ...chave(s), hash: c.hash, status: c.status, data: c.data, hora: c.hora });
        for (const a of c.arquivos) {
          this.#st.inserirArquivo.run({ ...chave(s), hash: c.hash, nome: a.nome, tipo: a.tipo, url: urlDe(c.hash, a.nome) });
        }
      }
    })();
  }

  arquivosDaSecao(s) {
    return this.#st.arquivosDaSecao.all(chave(s));
  }

  marcarArquivo(s, hash, nome, { status, bytes = null, md5 = null, sha512 = null, verificacao = null, erro = null }) {
    this.#st.marcarArquivo.run({ ...chave(s), hash, nome, status, bytes, md5, sha512, verificacao, erro, agora: agora() });
  }

  finalizarSecao(s, { status, bytes = 0, erro = null }) {
    this.#st.finalizarSecao.run({ ...chave(s), status, bytes, erro, agora: agora() });
  }

  marcarEmpacotado(pleito, uf, mun, zipBytes) {
    this.#st.marcarEmpacotado.run(agora(), zipBytes, pleito, uf, mun);
  }

  registrarEvento(nivel, uf, msg) {
    this.#st.registrarEvento.run(agora(), nivel, uf, msg);
  }

  eventos(limite) {
    return this.#st.eventos.all(limite);
  }

  resumoPorUf() {
    return this.#st.resumoPorUf.all().map((r) => ({ ...r, bytes: r.bytes ?? 0 }));
  }

  errosRecentes(limite) {
    return this.#st.errosRecentes.all(limite);
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test test/storage/manifest.test.js`
Expected: `# pass 6`

- [ ] **Step 6: Commit**

```bash
git add src/ufs.js src/storage/manifest.js test/storage/manifest.test.js
git commit -m "feat: manifest SQLite da coleta"
```

---

### Task 9: Disco (espaço livre e HD desconectado)

**Files:**
- Create: `src/storage/disco.js`
- Test: `test/storage/disco.test.js`

- [ ] **Step 1: Escrever os testes**

`test/storage/disco.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { VolumeError, bytesLivres, ehErroDeVolume, garantirVolume } from '../../src/storage/disco.js';

test('garantirVolume aceita pasta existente e recusa a ausente com mensagem clara', async () => {
  await garantirVolume(os.tmpdir());
  await assert.rejects(garantirVolume(path.join(os.tmpdir(), 'nao-existe-tse')), (err) => {
    assert.ok(err instanceof VolumeError);
    assert.match(err.message, /HD está conectado/);
    return true;
  });
});

test('bytesLivres devolve um número positivo', async () => {
  assert.ok((await bytesLivres(os.tmpdir())) > 0);
});

test('ehErroDeVolume reconhece erros de dispositivo', () => {
  assert.ok(ehErroDeVolume(new VolumeError('x')));
  assert.ok(ehErroDeVolume(Object.assign(new Error('x'), { code: 'EIO' })));
  assert.ok(ehErroDeVolume(Object.assign(new Error('x'), { code: 'ENOTCONN' })));
  assert.ok(!ehErroDeVolume(Object.assign(new Error('x'), { code: 'ENOENT' })));
  assert.ok(!ehErroDeVolume(new Error('x')));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/storage/disco.test.js`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 3: Implementar `src/storage/disco.js`**

```js
import { stat, statfs } from 'node:fs/promises';

const CODIGOS_DE_VOLUME = new Set(['EIO', 'ENOTCONN', 'ENXIO', 'ENODEV', 'EROFS']);

export class VolumeError extends Error {}

export function ehErroDeVolume(err) {
  return err instanceof VolumeError || CODIGOS_DE_VOLUME.has(err?.code);
}

export async function garantirVolume(pasta) {
  try {
    await stat(pasta);
  } catch (err) {
    throw new VolumeError(`pasta de dados inacessível (${err.code}): ${pasta}. O HD está conectado?`);
  }
}

export async function bytesLivres(pasta) {
  const s = await statfs(pasta);
  return s.bavail * s.bsize;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/storage/disco.test.js`
Expected: `# pass 3`

- [ ] **Step 5: Commit**

```bash
git add src/storage/disco.js test/storage/disco.test.js
git commit -m "feat: espaço livre e detecção de HD desconectado"
```

---

### Task 10: Empacotamento por município

**Files:**
- Create: `src/storage/empacotar.js`
- Test: `test/storage/empacotar.test.js`

- [ ] **Step 1: Escrever os testes**

`test/storage/empacotar.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { empacotarMunicipio } from '../../src/storage/empacotar.js';
import { lerZip } from '../helpers/zip.js';

async function preparar(arquivos) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-zip-'));
  const pastaStaging = path.join(dir, 'staging');
  await gravar(pastaStaging, arquivos);
  return { pastaStaging, caminhoZip: path.join(dir, 'raw', 'AC', '3220', '01066.zip') };
}

async function gravar(pasta, arquivos) {
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    await mkdir(path.dirname(path.join(pasta, nome)), { recursive: true });
    await writeFile(path.join(pasta, nome), conteudo);
  }
}

const texto = (zip) => Object.fromEntries([...zip].map(([nome, e]) => [nome, e.dados.toString()]));

test('empacota sem compressão, ignora .part e apaga o staging', async () => {
  const { pastaStaging, caminhoZip } = await preparar({
    '0004/0077/h1/a-bu.dat': 'conteúdo do bu',
    '0004/0077/p-aux.json': '{"st":"ok"}',
    '0004/0077/h1/b.dat.part': 'incompleto',
  });
  const r = await empacotarMunicipio({ pastaStaging, caminhoZip });
  assert.equal(r.entradas, 2);
  assert.ok(r.bytes > 0);
  const zip = await lerZip(caminhoZip);
  assert.deepEqual(texto(zip), { '0004/0077/h1/a-bu.dat': 'conteúdo do bu', '0004/0077/p-aux.json': '{"st":"ok"}' });
  for (const e of zip.values()) assert.equal(e.metodo, 0, 'método 0 = sem compressão');
  await assert.rejects(access(pastaStaging));
  await assert.rejects(access(`${caminhoZip}.part`));
});

test('reempacotar mescla com o zip existente e substitui o que veio de novo', async () => {
  const { pastaStaging, caminhoZip } = await preparar({ a: '1', b: '2' });
  await empacotarMunicipio({ pastaStaging, caminhoZip });
  await gravar(pastaStaging, { b: 'novo', 'x/c': '3' });
  const r = await empacotarMunicipio({ pastaStaging, caminhoZip });
  assert.equal(r.entradas, 3);
  assert.deepEqual(texto(await lerZip(caminhoZip)), { a: '1', b: 'novo', 'x/c': '3' });
});

test('sem staging e sem zip gera zip vazio', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-zip-'));
  const caminhoZip = path.join(dir, 'vazio.zip');
  const r = await empacotarMunicipio({ pastaStaging: path.join(dir, 'nada'), caminhoZip });
  assert.equal(r.entradas, 0);
  assert.equal((await lerZip(caminhoZip)).size, 0);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/storage/empacotar.test.js`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 3: Implementar `src/storage/empacotar.js`**

```js
import yazl from 'yazl';
import yauzl from 'yauzl';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const abrirZip = promisify(yauzl.open);

async function listarArquivos(pasta) {
  let itens;
  try {
    itens = await readdir(pasta, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return itens
    .filter((d) => d.isFile() && !d.name.endsWith('.part'))
    .map((d) => path.relative(pasta, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
    .sort();
}

async function lerEntradas(caminhoZip) {
  const zip = await abrirZip(caminhoZip, { lazyEntries: true, autoClose: false });
  const entradas = [];
  await new Promise((ok, falha) => {
    zip.on('entry', (e) => {
      entradas.push(e);
      zip.readEntry();
    });
    zip.on('end', ok);
    zip.on('error', falha);
    zip.readEntry();
  });
  return { zip, entradas };
}

async function conferirZip(caminho, esperado) {
  const { zip, entradas } = await lerEntradas(caminho);
  zip.close();
  const problemas = [];
  if (entradas.length !== esperado.size) problemas.push(`${entradas.length} entradas, esperado ${esperado.size}`);
  for (const e of entradas) {
    if (esperado.get(e.fileName) !== e.uncompressedSize) problemas.push(`${e.fileName}: ${e.uncompressedSize} bytes`);
  }
  if (problemas.length) throw new Error(`zip inconsistente ${caminho}: ${problemas.join('; ')}`);
}

// Junta o staging de um município num .zip sem compressão (o NTFS sofre com milhões de arquivos
// pequenos; o conteúdo fica byte a byte igual ao original). Se o zip já existe, as entradas antigas
// são copiadas e as do staging têm prioridade. Escreve em .part, confere, renomeia e apaga o staging.
export async function empacotarMunicipio({ pastaStaging, caminhoZip }) {
  const novos = await listarArquivos(pastaStaging);
  const esperado = new Map();
  for (const nome of novos) esperado.set(nome, (await stat(path.join(pastaStaging, nome))).size);

  let antigo = null;
  try {
    antigo = await lerEntradas(caminhoZip);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await mkdir(path.dirname(caminhoZip), { recursive: true });
  const temporario = `${caminhoZip}.part`;
  const zip = new yazl.ZipFile();
  const saida = createWriteStream(temporario);
  zip.outputStream.pipe(saida);
  try {
    if (antigo) {
      const abrir = promisify(antigo.zip.openReadStream.bind(antigo.zip));
      for (const e of antigo.entradas) {
        if (e.fileName.endsWith('/') || esperado.has(e.fileName)) continue;
        esperado.set(e.fileName, e.uncompressedSize);
        const leitura = await abrir(e);
        zip.addReadStream(leitura, e.fileName, { compress: false, size: e.uncompressedSize, mtime: e.getLastModDate() });
        await finished(leitura);
      }
    }
    for (const nome of novos) zip.addFile(path.join(pastaStaging, nome), nome, { compress: false });
    zip.end();
    await finished(saida);
  } finally {
    antigo?.zip.close();
  }

  await conferirZip(temporario, esperado);
  await rename(temporario, caminhoZip);
  await rm(pastaStaging, { recursive: true, force: true });
  return { entradas: esperado.size, bytes: (await stat(caminhoZip)).size };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/storage/empacotar.test.js`
Expected: `# pass 3`

- [ ] **Step 5: Commit**

```bash
git add src/storage/empacotar.js test/storage/empacotar.test.js
git commit -m "feat: empacotamento por município em zip sem compressão"
```

---

### Task 11: Coletor, parte 1: planejamento

**Files:**
- Create: `src/coleta/coletor.js`
- Test: `test/coleta/coletor.test.js`

- [ ] **Step 1: Escrever os testes (com o helper de montagem usado nas Tasks 12 e 13)**

`test/coleta/coletor.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Coletor } from '../../src/coleta/coletor.js';
import { HttpClient } from '../../src/net/http.js';
import { Manifest } from '../../src/storage/manifest.js';
import { buscarEleicoes } from '../../src/tse/eleicoes.js';
import { criarUrls } from '../../src/tse/urls.js';
import { FX, iniciarFakeTse, lerFixture } from '../helpers/fakeTse.js';
import { lerZip } from '../helpers/zip.js';

const S77 = FX.secao('3220');

async function montar(t, { falhas, bytesLivres, ufs = ['ac'], pleitos = ['3220', '3221'], subpastaDados } = {}) {
  const fake = await iniciarFakeTse({ falhas });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-coletor-'));
  const dados = subpastaDados ? path.join(dir, subpastaDados) : dir;
  const http = new HttpClient({ esperaBaseMs: 1, tentativas: 2, userAgent: 'teste' });
  const { templates } = await buscarEleicoes(http, { base: fake.base, ambiente: 'oficial' });
  const manifest = new Manifest(path.join(dir, 'manifest.sqlite'));
  const coletor = new Coletor({
    manifest,
    http,
    urls: criarUrls({ base: fake.base, ambiente: 'oficial', templates }),
    pastaDados: dados,
    ciclo: 'ele2026',
    pleitos,
    ufs,
    minLivreBytes: 1,
    bytesLivres: bytesLivres ?? (async () => 10 ** 12),
  });
  t.after(async () => {
    await coletor.aguardar();
    manifest.fechar();
    await fake.fechar();
  });
  return { fake, dados, manifest, coletor };
}

test('planejar grava as configs em raw/ e registra as seções', async (t) => {
  const { dados, manifest, coletor } = await montar(t);
  await coletor.planejar();
  assert.deepEqual(
    await readFile(path.join(dados, 'raw/AC/3220/ac-p003220-cs.json')),
    await lerFixture('oficial/ele2026/arquivo-urna/3220/config/ac/ac-p003220-cs.json'),
  );
  assert.deepEqual(manifest.secoesPendentes('3220', 'ac', '01066').map((s) => s.secao), ['0077', '0078', '0079']);
  assert.deepEqual(manifest.secoesPendentes('3221', 'ac', '01066').map((s) => s.secao), ['0077']);
  assert.equal(manifest.secao({ ...S77, secao: '0270' }).status, 'agregada');
  assert.deepEqual(manifest.ufs().map((u) => u.uf), ['ac']);
});

test('planejar registra aviso quando a UF não tem config no pleito', async (t) => {
  const { manifest, coletor } = await montar(t, { ufs: ['ac', 'zz'] });
  await coletor.planejar();
  assert.match(manifest.eventos(1)[0].msg, /ZZ \(HTTP 404\)/);
  assert.equal(manifest.eventos(1)[0].nivel, 'aviso');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/coleta/coletor.test.js`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 3: Implementar `src/coleta/coletor.js` (cabeçalho completo + planejamento)**

Os imports já incluem o que as Tasks 12 e 13 vão usar.

```js
import { EventEmitter } from 'node:events';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lerConfigSecoes } from '../tse/configSecoes.js';
import { lerIndiceSecao } from '../tse/indiceSecao.js';
import { nomeConfigSecoes, nomeIndiceSecao } from '../tse/urls.js';
import { md5, md5DoEtag, sha512Hex, vscConfereComDiretorio, vscContemSha512 } from '../tse/integridade.js';
import { empacotarMunicipio } from '../storage/empacotar.js';
import { bytesLivres as bytesLivresDoDisco, ehErroDeVolume, garantirVolume } from '../storage/disco.js';

const TIPOS_NO_VSC = new Set(['bu', 'rdv', 'log']);
const TENTATIVAS_VERIFICACAO = 3;
const JANELA_VELOCIDADE_MS = 60_000;
const GB = 1024 ** 3;

export class EspacoInsuficienteError extends Error {}

async function gravarAtomico(caminho, conteudo) {
  await mkdir(path.dirname(caminho), { recursive: true });
  await writeFile(`${caminho}.part`, conteudo);
  await rename(`${caminho}.part`, caminho);
}

async function existe(caminho) {
  try {
    await access(caminho);
    return true;
  } catch {
    return false;
  }
}

// Executa fn sobre os itens com no máximo `limite` em paralelo. Na primeira falha os demais
// trabalhadores param de pegar itens; espera todos terminarem e relança o erro.
async function emParalelo(itens, limite, fn) {
  let proximo = 0;
  let falhou = false;
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (!falhou && proximo < itens.length) {
      try {
        await fn(itens[proximo++]);
      } catch (err) {
        falhou = true;
        throw err;
      }
    }
  });
  const resultados = await Promise.allSettled(trabalhadores);
  const rejeitado = resultados.find((r) => r.status === 'rejected');
  if (rejeitado) throw rejeitado.reason;
}

export class Coletor extends EventEmitter {
  #parar = false;
  #planejado = false;
  #execucao = null;
  #amostras = [];

  constructor({
    manifest, http, urls, pastaDados, ciclo, pleitos, ufs, minLivreBytes,
    concorrencia = 4, bytesLivres = bytesLivresDoDisco, agora = Date.now,
  }) {
    super();
    Object.assign(this, { manifest, http, urls, pastaDados, ciclo, pleitos, ufs, minLivreBytes, concorrencia, bytesLivres, agora });
    this.estado = { rodando: false, ufAtual: null, municipioAtual: null, motivoParada: null };
  }

  #pastaRaw(uf) {
    return path.join(this.pastaDados, 'raw', uf.toUpperCase());
  }

  #caminhoZip(pleito, uf, mun) {
    return path.join(this.#pastaRaw(uf), pleito, `${mun}.zip`);
  }

  #pastaStaging(pleito, uf, mun) {
    return path.join(this.pastaDados, 'staging', uf.toUpperCase(), pleito, mun);
  }

  // Baixa a config de seções de cada UF × pleito, guarda o original em raw/ e registra as seções.
  async planejar() {
    this.manifest.registrarUfs(this.ufs);
    for (const uf of this.ufs) {
      for (const pleito of this.pleitos) {
        const url = this.urls.configSecoes({ ciclo: this.ciclo, pleito, uf });
        const r = await this.http.get(url);
        if (r.status === 404) {
          this.manifest.registrarEvento('aviso', uf, `pleito ${pleito} sem configuração de seções para ${uf.toUpperCase()} (HTTP 404)`);
          continue;
        }
        if (r.status !== 200) throw new Error(`configuração de seções ${uf.toUpperCase()}/${pleito}: HTTP ${r.status} (${url})`);
        await gravarAtomico(path.join(this.#pastaRaw(uf), pleito, nomeConfigSecoes({ pleito, uf })), r.body);
        this.manifest.registrarConfig(pleito, uf, lerConfigSecoes(JSON.parse(r.body.toString('utf8'))).municipios);
      }
    }
  }

  aguardar() {
    return this.#execucao ?? Promise.resolve();
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/coleta/coletor.test.js`
Expected: `# pass 2`

- [ ] **Step 5: Commit**

```bash
git add src/coleta/coletor.js test/coleta/coletor.test.js
git commit -m "feat: coletor, planejamento a partir da config de seções"
```

---

### Task 12: Coletor, parte 2: baixar e verificar uma seção

**Files:**
- Modify: `src/coleta/coletor.js` (métodos novos dentro de `class Coletor`, depois de `planejar()`)
- Test: `test/coleta/coletor.test.js` (acrescentar no fim)

- [ ] **Step 1: Acrescentar os testes**

No fim de `test/coleta/coletor.test.js`:

```js
const nomeArquivo = (pleito, sufixo) => `o0${pleito}ac0106600040077-${sufixo}`;
const requisicoesDe = (fake, sufixo) => fake.requisicoes.filter((r) => r.endsWith(sufixo));

test('processarSecao baixa e verifica todos os arquivos', async (t) => {
  const { dados, manifest, coletor } = await montar(t);
  await coletor.planejar();
  await coletor.processarSecao(S77);

  const secao = manifest.secao(S77);
  assert.equal(secao.status, 'completa');
  const arquivos = manifest.arquivosDaSecao(S77);
  assert.deepEqual(
    arquivos.map((a) => [a.tipo, a.status, a.verificacao]).sort(),
    [['bu', 'ok', 'vsc'], ['log', 'ok', 'vsc'], ['rdv', 'ok', 'vsc'], ['vota', 'ok', 'dir']],
  );
  assert.equal(secao.bytes, arquivos.reduce((t, a) => t + a.bytes, 0));

  const staging = path.join(dados, 'staging/AC/3220/01066/0004/0077');
  assert.deepEqual(
    await readFile(path.join(staging, FX.hash3220, nomeArquivo('3220', 'bu.dat'))),
    await lerFixture(`${FX.dirSecao('3220')}/${FX.hash3220}/${nomeArquivo('3220', 'bu.dat')}`),
  );
  await access(path.join(staging, 'p003220-ac-m01066-z0004-s0077-aux.json'));
  assert.ok(coletor.velocidadeBps() > 0);
});

test('seção sem índice no servidor fica com erro', async (t) => {
  const { manifest, coletor } = await montar(t);
  await coletor.planejar();
  await coletor.processarSecao(FX.secao('3220', '0078'));
  const secao = manifest.secao(FX.secao('3220', '0078'));
  assert.equal(secao.status, 'erro');
  assert.equal(secao.erro, 'índice: HTTP 404');
});

test('seção sem arquivos fica como sem_arquivos', async (t) => {
  const { manifest, coletor } = await montar(t);
  await coletor.planejar();
  await coletor.processarSecao(FX.secao('3220', '0079'));
  assert.equal(manifest.secao(FX.secao('3220', '0079')).status, 'sem_arquivos');
});

test('arquivo corrompido em trânsito é baixado de novo', async (t) => {
  const { fake, manifest, coletor } = await montar(t, { falhas: { [nomeArquivo('3220', 'bu.dat')]: ['corromper'] } });
  await coletor.planejar();
  await coletor.processarSecao(S77);
  assert.equal(manifest.secao(S77).status, 'completa');
  assert.equal(requisicoesDe(fake, nomeArquivo('3220', 'bu.dat')).length, 2);
});

test('corrupção persistente marca o arquivo e a seção com erro', async (t) => {
  const falhas = { [nomeArquivo('3220', 'bu.dat')]: ['corromper', 'corromper', 'corromper'] };
  const { fake, manifest, coletor } = await montar(t, { falhas });
  await coletor.planejar();
  await coletor.processarSecao(S77);
  const bu = manifest.arquivosDaSecao(S77).find((a) => a.tipo === 'bu');
  assert.equal(bu.status, 'erro');
  assert.equal(bu.erro, 'md5 não confere com o ETag');
  assert.equal(requisicoesDe(fake, nomeArquivo('3220', 'bu.dat')).length, 3);
  const secao = manifest.secao(S77);
  assert.equal(secao.status, 'erro');
  assert.equal(secao.erro, `${nomeArquivo('3220', 'bu.dat')}: md5 não confere com o ETag`);
});

test('bu cujo sha512 não consta no .vsc é rejeitado', async (t) => {
  const falhas = { [nomeArquivo('3220', 'bu.dat')]: ['corromperComEtag', 'corromperComEtag', 'corromperComEtag'] };
  const { manifest, coletor } = await montar(t, { falhas });
  await coletor.planejar();
  await coletor.processarSecao(S77);
  const bu = manifest.arquivosDaSecao(S77).find((a) => a.tipo === 'bu');
  assert.equal(bu.status, 'erro');
  assert.equal(bu.erro, 'sha512 não consta no .vsc');
});

test('.vsc que não confere com o hash do diretório invalida o conjunto', async (t) => {
  const falhas = { [nomeArquivo('3220', 'vota.vsc')]: ['corromperComEtag', 'corromperComEtag', 'corromperComEtag'] };
  const { fake, manifest, coletor } = await montar(t, { falhas });
  await coletor.planejar();
  await coletor.processarSecao(S77);
  const porTipo = Object.fromEntries(manifest.arquivosDaSecao(S77).map((a) => [a.tipo, a]));
  assert.equal(porTipo.vota.erro, 'sha256 do .vsc não confere com o hash do diretório');
  assert.equal(porTipo.bu.status, 'erro');
  assert.equal(porTipo.bu.erro, '.vsc inválido; arquivo não baixado');
  assert.equal(requisicoesDe(fake, nomeArquivo('3220', 'bu.dat')).length, 0);
  assert.equal(manifest.secao(S77).status, 'erro');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/coleta/coletor.test.js`
Expected: FAIL, `coletor.processarSecao is not a function`

- [ ] **Step 3: Implementar dentro de `class Coletor`, depois de `planejar()`**

```js
  // Baixa o índice da seção e todos os conjuntos de arquivos, verificando cada um.
  // Falhas ficam registradas no manifest; só erros de disco sobem (e param a coleta).
  async processarSecao(s) {
    const falhar = (erro) => this.manifest.finalizarSecao(s, { status: 'erro', erro });
    let r;
    try {
      r = await this.http.get(this.urls.indiceSecao({ ciclo: this.ciclo, ...s }));
    } catch (err) {
      return falhar(`índice: ${err.message}`);
    }
    if (r.status !== 200) return falhar(`índice: HTTP ${r.status}`);
    let indice;
    try {
      indice = lerIndiceSecao(JSON.parse(r.body.toString('utf8')));
    } catch (err) {
      return falhar(`índice ilegível: ${err.message}`);
    }

    const staging = this.#pastaStaging(s.pleito, s.uf, s.mun);
    await gravarAtomico(path.join(staging, s.zona, s.secao, nomeIndiceSecao(s)), r.body);
    if (indice.conjuntos.length === 0) {
      this.manifest.finalizarSecao(s, { status: 'sem_arquivos' });
      return;
    }

    this.manifest.registrarIndice(s, indice.conjuntos, (hash, nome) => this.urls.arquivo({ ciclo: this.ciclo, ...s }, hash, nome));
    for (const { hash } of indice.conjuntos) await this.#baixarConjunto(s, hash, staging);

    const arquivos = this.manifest.arquivosDaSecao(s);
    const bytes = arquivos.reduce((total, a) => total + (a.bytes ?? 0), 0);
    const falha = arquivos.find((a) => a.status !== 'ok');
    this.manifest.finalizarSecao(s, falha
      ? { status: 'erro', bytes, erro: `${falha.nome}: ${falha.erro}` }
      : { status: 'completa', bytes });
  }

  // Primeiro o .vsc (conferido contra o hash do diretório); depois os demais, conferidos pelo sha512 no .vsc.
  // O .vsc é baixado de novo sempre que o conjunto tem pendências, porque pode já estar só no zip.
  async #baixarConjunto(s, hash, staging) {
    const registros = this.manifest.arquivosDaSecao(s).filter((a) => a.hash === hash);
    if (registros.every((a) => a.status === 'ok')) return;
    const pasta = path.join(staging, s.zona, s.secao, hash);

    const regVsc = registros.find((a) => a.nome.endsWith('.vsc'));
    let vsc = null;
    if (regVsc) {
      vsc = await this.#baixarArquivo(s, regVsc, pasta, (buf) => (vscConfereComDiretorio(buf, hash)
        ? { verificacao: 'dir' }
        : { erro: 'sha256 do .vsc não confere com o hash do diretório' }));
    }

    for (const reg of registros) {
      if (reg === regVsc || reg.status === 'ok') continue;
      if (regVsc && !vsc) {
        this.manifest.marcarArquivo(s, reg.hash, reg.nome, { status: 'erro', erro: '.vsc inválido; arquivo não baixado' });
        continue;
      }
      await this.#baixarArquivo(s, reg, pasta, (buf) => {
        if (vsc && vscContemSha512(vsc, buf)) return { verificacao: 'vsc' };
        if (vsc && TIPOS_NO_VSC.has(reg.tipo)) return { erro: 'sha512 não consta no .vsc' };
        return { verificacao: 'md5' };
      });
    }
  }

  // Devolve o conteúdo verificado, ou null depois de registrar o erro.
  // Conteúdo que não confere é baixado de novo até TENTATIVAS_VERIFICACAO vezes.
  async #baixarArquivo(s, reg, pasta, verificar) {
    let erro;
    for (let tentativa = 1; tentativa <= TENTATIVAS_VERIFICACAO; tentativa++) {
      let r;
      try {
        r = await this.http.get(reg.url);
      } catch (err) {
        erro = err.message;
        break;
      }
      if (r.status !== 200) {
        erro = `HTTP ${r.status}`;
        break;
      }
      const md5Real = md5(r.body);
      const md5Servidor = md5DoEtag(r.etag);
      if (md5Servidor && md5Servidor !== md5Real) {
        erro = 'md5 não confere com o ETag';
        continue;
      }
      const v = verificar(r.body);
      if (v.erro) {
        erro = v.erro;
        continue;
      }
      await gravarAtomico(path.join(pasta, reg.nome), r.body);
      this.manifest.marcarArquivo(s, reg.hash, reg.nome, {
        status: 'ok', bytes: r.body.length, md5: md5Real, sha512: sha512Hex(r.body), verificacao: v.verificacao,
      });
      this.#contarBytes(r.body.length);
      return r.body;
    }
    this.manifest.marcarArquivo(s, reg.hash, reg.nome, { status: 'erro', erro });
    return null;
  }

  #contarBytes(n) {
    this.#amostras.push([this.agora(), n]);
    this.#podarAmostras();
  }

  #podarAmostras() {
    const limite = this.agora() - JANELA_VELOCIDADE_MS;
    while (this.#amostras.length && this.#amostras[0][0] < limite) this.#amostras.shift();
  }

  // Média de bytes por segundo no último minuto.
  velocidadeBps() {
    this.#podarAmostras();
    return this.#amostras.reduce((total, [, n]) => total + n, 0) / (JANELA_VELOCIDADE_MS / 1000);
  }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/coleta/coletor.test.js`
Expected: `# pass 9`

- [ ] **Step 5: Commit**

```bash
git add src/coleta/coletor.js test/coleta/coletor.test.js
git commit -m "feat: coletor baixa e verifica os arquivos de cada seção"
```

---

### Task 13: Coletor, parte 3: execução, empacotamento, pausa, espaço e HD

**Files:**
- Modify: `src/coleta/coletor.js` (métodos novos dentro de `class Coletor`, depois de `velocidadeBps()`)
- Test: `test/coleta/coletor.test.js` (acrescentar no fim)

- [ ] **Step 1: Acrescentar os testes**

No fim de `test/coleta/coletor.test.js`:

```js
const requisicoesDeDados = (fake) => fake.requisicoes.filter((r) => r.includes('/dados/'));

test('executar coleta a UF, os dois turnos, e empacota por município', async (t) => {
  const { dados, manifest, coletor } = await montar(t);
  await coletor.executar();
  assert.equal(coletor.estado.motivoParada, 'concluída');
  assert.equal(coletor.estado.rodando, false);

  const zip1 = await lerZip(path.join(dados, 'raw/AC/3220/01066.zip'));
  const bu = `0004/0077/${FX.hash3220}/${nomeArquivo('3220', 'bu.dat')}`;
  assert.deepEqual(zip1.get(bu).dados, await lerFixture(`${FX.dirSecao('3220')}/${FX.hash3220}/${nomeArquivo('3220', 'bu.dat')}`));
  assert.ok(zip1.has('0004/0077/p003220-ac-m01066-z0004-s0077-aux.json'));
  assert.ok(zip1.has('0004/0079/p003220-ac-m01066-z0004-s0079-aux.json'));
  assert.equal(zip1.size, 6, '4 arquivos + 2 índices');

  const zip2 = await lerZip(path.join(dados, 'raw/AC/3221/01066.zip'));
  assert.equal(zip2.size, 5);
  await assert.rejects(access(path.join(dados, 'staging/AC/3220/01066')));
  assert.ok(manifest.municipio('3220', 'ac', '01066').empacotado_em);
  assert.equal(manifest.eventos(1)[0].msg, 'coleta concluída');
});

test('segunda execução só retenta o que falhou', async (t) => {
  const { fake, coletor } = await montar(t);
  await coletor.executar();
  const antes = fake.requisicoes.length;
  await coletor.executar();
  assert.deepEqual(fake.requisicoes.slice(antes), [
    '/oficial/ele2026/arquivo-urna/3220/dados/ac/01066/0004/0078/p003220-ac-m01066-z0004-s0078-aux.json',
  ]);
});

test('arquivo que falhou numa execução entra no zip na seguinte', async (t) => {
  const falhas = { [nomeArquivo('3220', 'bu.dat')]: ['corromper', 'corromper', 'corromper'] };
  const { dados, manifest, coletor } = await montar(t, { falhas });
  const caminhoZip = path.join(dados, 'raw/AC/3220/01066.zip');
  const bu = `0004/0077/${FX.hash3220}/${nomeArquivo('3220', 'bu.dat')}`;

  await coletor.executar();
  assert.equal(manifest.secao(S77).status, 'erro');
  assert.ok(!(await lerZip(caminhoZip)).has(bu));

  await coletor.executar();
  assert.equal(manifest.secao(S77).status, 'completa');
  const zip = await lerZip(caminhoZip);
  assert.ok(zip.has(bu));
  assert.equal(zip.size, 6);
});

test('para por falta de espaço antes de baixar arquivos', async (t) => {
  const { fake, coletor } = await montar(t, { bytesLivres: async () => 0 });
  await coletor.executar();
  assert.match(coletor.estado.motivoParada, /espaço livre abaixo do mínimo/);
  assert.deepEqual(requisicoesDeDados(fake), []);
});

test('UF pausada não é coletada; retomar inicia a coleta', async (t) => {
  const { fake, dados, manifest, coletor } = await montar(t);
  manifest.registrarUfs(['ac']);
  coletor.pausar('ac');
  await coletor.executar();
  assert.equal(coletor.estado.motivoParada, 'concluída');
  assert.deepEqual(requisicoesDeDados(fake), []);

  await coletor.retomar('ac');
  await access(path.join(dados, 'raw/AC/3220/01066.zip'));
});

test('parar interrompe a execução', async (t) => {
  const { fake, coletor } = await montar(t);
  const execucao = coletor.executar();
  coletor.parar();
  await execucao;
  assert.equal(coletor.estado.motivoParada, 'parada solicitada');
  assert.deepEqual(requisicoesDeDados(fake), []);
});

test('HD inacessível interrompe com mensagem clara', async (t) => {
  const { manifest, coletor } = await montar(t, { subpastaDados: 'hd-desconectado' });
  await coletor.executar();
  assert.match(coletor.estado.motivoParada, /^HD inacessível: .*O HD está conectado\?/);
  assert.equal(manifest.eventos(1)[0].nivel, 'erro');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/coleta/coletor.test.js`
Expected: FAIL, `coletor.executar is not a function`

- [ ] **Step 3: Implementar dentro de `class Coletor`, depois de `velocidadeBps()`**

```js
  // Uma execução por vez: chamar de novo enquanto roda devolve a mesma promessa.
  // Nunca rejeita: o motivo da parada fica em estado.motivoParada e nos eventos do manifest.
  executar() {
    this.#execucao ??= this.#executar().finally(() => {
      this.#execucao = null;
    });
    return this.#execucao;
  }

  parar() {
    this.#parar = true;
  }

  pausar(uf) {
    this.manifest.definirPausa(uf, true);
    this.emit('mudou');
  }

  retomar(uf) {
    this.manifest.definirPausa(uf, false);
    this.emit('mudou');
    return this.executar();
  }

  async #executar() {
    this.#parar = false;
    Object.assign(this.estado, { rodando: true, motivoParada: null });
    this.emit('mudou');
    try {
      await garantirVolume(this.pastaDados);
      if (!this.#planejado) {
        await this.planejar();
        this.#planejado = true;
      }
      const tentadas = new Set();
      let uf;
      while (!this.#parar && (uf = this.#proximaUf(tentadas))) {
        tentadas.add(uf);
        await this.#coletarUf(uf);
      }
      this.estado.motivoParada = this.#parar ? 'parada solicitada' : 'concluída';
      this.manifest.registrarEvento('info', null, `coleta ${this.estado.motivoParada}`);
    } catch (err) {
      const volume = ehErroDeVolume(err) || !(await existe(this.pastaDados));
      this.estado.motivoParada = volume ? `HD inacessível: ${err.message}` : err.message;
      try {
        this.manifest.registrarEvento('erro', this.estado.ufAtual, this.estado.motivoParada);
      } catch {
        // o manifest está no mesmo HD; se ele sumiu, não há onde registrar
      }
    } finally {
      Object.assign(this.estado, { rodando: false, ufAtual: null, municipioAtual: null });
      this.emit('mudou');
    }
  }

  // Próxima UF, na ordem de coleta, que não está pausada e ainda não foi tentada nesta execução.
  // Uma UF despausada no meio da execução entra na fila.
  #proximaUf(tentadas) {
    return this.manifest.ufs().find((u) => this.ufs.includes(u.uf) && !u.pausada && !tentadas.has(u.uf))?.uf;
  }

  #deveParar(uf) {
    return this.#parar || this.manifest.ufPausada(uf);
  }

  // Município por município, os dois turnos juntos.
  async #coletarUf(uf) {
    this.estado.ufAtual = uf;
    this.emit('mudou');
    for (const { mun } of this.manifest.municipiosDaUf(uf)) {
      for (const pleito of this.pleitos) {
        if (this.#deveParar(uf)) return;
        await this.#coletarMunicipio(pleito, uf, mun);
      }
    }
  }

  async #coletarMunicipio(pleito, uf, mun) {
    const municipio = this.manifest.municipio(pleito, uf, mun);
    if (!municipio) return;
    this.estado.municipioAtual = `${mun} ${municipio.nome}`;
    const staging = this.#pastaStaging(pleito, uf, mun);
    let interrompido = false;
    await emParalelo(this.manifest.secoesPendentes(pleito, uf, mun), this.concorrencia * 2, async (s) => {
      if (this.#deveParar(uf)) {
        interrompido = true;
        return;
      }
      await this.#garantirEspaco();
      await this.processarSecao(s);
    });
    if (interrompido) return; // o staging fica para a próxima execução; não empacota pela metade
    if (municipio.empacotado_em && !(await existe(staging))) return; // nada novo para o zip
    const { bytes } = await empacotarMunicipio({ pastaStaging: staging, caminhoZip: this.#caminhoZip(pleito, uf, mun) });
    this.manifest.marcarEmpacotado(pleito, uf, mun, bytes);
  }

  async #garantirEspaco() {
    const livres = await this.bytesLivres(this.pastaDados);
    if (livres < this.minLivreBytes) {
      throw new EspacoInsuficienteError(
        `espaço livre abaixo do mínimo (${(livres / GB).toFixed(1)} GB livres, mínimo ${(this.minLivreBytes / GB).toFixed(0)} GB): ` +
        'coleta pausada. Libere espaço e inicie de novo.',
      );
    }
  }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/coleta/coletor.test.js`
Expected: `# pass 16`

- [ ] **Step 5: Rodar a suíte inteira**

Run: `npm test`
Expected: `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add src/coleta/coletor.js test/coleta/coletor.test.js
git commit -m "feat: execução da coleta com empacotamento, pausa, espaço e HD"
```

---

### Task 14: Estado agregado para o painel e formatação

**Files:**
- Create: `src/coleta/estado.js`, `src/formatar.js`
- Test: `test/coleta/estado.test.js`, `test/formatar.test.js`

- [ ] **Step 1: Escrever os testes**

`test/coleta/estado.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { montarEstado, statusDaUf } from '../../src/coleta/estado.js';
import { Manifest } from '../../src/storage/manifest.js';

const secao = (n, principal = null) => ({ zona: '0001', secao: n, principal });
const chave = (uf, mun, n) => ({ pleito: '3220', uf, mun, zona: '0001', secao: n });

test('agrega seções por UF, calcula projeção e status', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-estado-'));
  const manifest = new Manifest(path.join(dir, 'manifest.sqlite'));
  t.after(() => manifest.fechar());
  manifest.registrarUfs(['ac', 'al']);
  manifest.registrarConfig('3220', 'ac', [{ mun: '01066', nome: 'X', secoes: [
    secao('0001'), secao('0002'), secao('0003'), secao('0004', '0001'),
  ] }]);
  manifest.registrarConfig('3220', 'al', [{ mun: '27000', nome: 'Y', secoes: [secao('0001')] }]);
  manifest.finalizarSecao(chave('ac', '01066', '0001'), { status: 'completa', bytes: 1000 });
  manifest.finalizarSecao(chave('ac', '01066', '0002'), { status: 'erro', erro: 'x' });
  manifest.finalizarSecao(chave('ac', '01066', '0003'), { status: 'sem_arquivos' });

  const coletor = {
    estado: { rodando: true, ufAtual: 'al', municipioAtual: '27000 Y', motivoParada: null },
    velocidadeBps: () => 500,
  };
  const e = await montarEstado({ manifest, coletor, pastaDados: dir, bytesLivres: async () => 999 });

  assert.deepEqual(e.ufs.find((u) => u.uf === 'ac'), {
    uf: 'ac', pausada: false, total: 3, concluidas: 2, erros: 1, semArquivos: 1, agregadas: 1, bytes: 1000, status: 'baixado',
  });
  assert.equal(e.ufs.find((u) => u.uf === 'al').status, 'baixando');
  assert.deepEqual(e.totais, { secoes: 4, concluidas: 2, erros: 1, semArquivos: 1, bytes: 1000 });
  assert.deepEqual(e.disco, { livres: 999, projecaoBytes: 1333, projecaoPreliminar: false });
  assert.equal(e.coleta.velocidadeBps, 500);
  assert.equal(e.coleta.ufAtual, 'al');
  assert.deepEqual(e.errosSecoes.map((x) => x.erro), ['x']);
  assert.ok(Array.isArray(e.eventos));
});

test('projeção nula enquanto nenhuma seção terminou; livre nulo se o HD sumiu', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tse-estado-'));
  const manifest = new Manifest(path.join(dir, 'manifest.sqlite'));
  t.after(() => manifest.fechar());
  const coletor = { estado: { rodando: false, ufAtual: null }, velocidadeBps: () => 0 };
  const e = await montarEstado({ manifest, coletor, pastaDados: dir, bytesLivres: async () => { throw new Error('EIO'); } });
  assert.deepEqual(e.disco, { livres: null, projecaoBytes: null, projecaoPreliminar: true });
});

test('statusDaUf', () => {
  const parada = { rodando: false, ufAtual: null };
  assert.equal(statusDaUf({ uf: 'ac', pausada: true, total: 1, concluidas: 0, erros: 0 }, parada), 'pausada');
  assert.equal(statusDaUf({ uf: 'ac', pausada: false, total: 1, concluidas: 0, erros: 0 }, parada), 'aguardando');
  assert.equal(statusDaUf({ uf: 'ac', pausada: false, total: 0, concluidas: 0, erros: 0 }, parada), 'aguardando');
  assert.equal(statusDaUf({ uf: 'ac', pausada: false, total: 2, concluidas: 1, erros: 1 }, parada), 'baixado');
});
```

`test/formatar.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtBytes, linhaDeProgresso } from '../src/formatar.js';

test('fmtBytes', () => {
  assert.equal(fmtBytes(null), '—');
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(5 * 1024 ** 3), '5.0 GB');
});

test('linhaDeProgresso', () => {
  const e = {
    totais: { secoes: 200, concluidas: 90, erros: 10, semArquivos: 0, bytes: 1024 ** 2 },
    coleta: { velocidadeBps: 2048, ufAtual: 'ac', municipioAtual: '01066 PORTO WALTER' },
  };
  assert.equal(linhaDeProgresso(e), '50.0% | 90/200 seções | 10 erros | 1.0 MB | 2.0 KB/s | AC 01066 PORTO WALTER');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/coleta/estado.test.js test/formatar.test.js`
Expected: FAIL, módulos não encontrados.

- [ ] **Step 3: Implementar `src/coleta/estado.js`**

```js
// Status de coleta da UF. Os status das etapas seguintes (verificando, extraído, analisado)
// entram com os planos de verificação e análise.
export function statusDaUf(u, coleta) {
  if (coleta.rodando && coleta.ufAtual === u.uf) return 'baixando';
  if (u.pausada) return 'pausada';
  if (u.total > 0 && u.concluidas + u.erros === u.total) return 'baixado';
  return 'aguardando';
}

// Junta o manifest e o coletor no objeto que o painel e o CLI exibem.
// Seções agregadas não contam no total (não têm arquivos próprios); "sem arquivos" conta como
// concluída para o progresso, mas aparece separada, nunca como "ok".
export async function montarEstado({ manifest, coletor, pastaDados, bytesLivres }) {
  const porUf = new Map(manifest.ufs().map((u) => [u.uf, {
    uf: u.uf, pausada: u.pausada === 1, total: 0, concluidas: 0, erros: 0, semArquivos: 0, agregadas: 0, bytes: 0,
  }]));
  for (const { uf, status, n, bytes } of manifest.resumoPorUf()) {
    const u = porUf.get(uf);
    if (!u) continue;
    if (status === 'agregada') {
      u.agregadas += n;
      continue;
    }
    u.total += n;
    u.bytes += bytes;
    if (status === 'completa' || status === 'sem_arquivos') u.concluidas += n;
    if (status === 'sem_arquivos') u.semArquivos += n;
    if (status === 'erro') u.erros += n;
  }

  const coleta = { ...coletor.estado, velocidadeBps: coletor.velocidadeBps() };
  const ufs = [...porUf.values()].map((u) => ({ ...u, status: statusDaUf(u, coleta) }));
  const soma = (campo) => ufs.reduce((total, u) => total + u[campo], 0);
  const totais = {
    secoes: soma('total'), concluidas: soma('concluidas'), erros: soma('erros'), semArquivos: soma('semArquivos'), bytes: soma('bytes'),
  };
  const tratadas = totais.concluidas + totais.erros;

  let livres = null;
  try {
    livres = await bytesLivres(pastaDados);
  } catch {
    // HD desconectado: o painel mostra "—"
  }

  return {
    geradoEm: new Date().toISOString(),
    coleta,
    totais,
    disco: {
      livres,
      projecaoBytes: tratadas ? Math.round((totais.bytes / tratadas) * totais.secoes) : null,
      projecaoPreliminar: !ufs.some((u) => u.status === 'baixado'),
    },
    ufs,
    errosSecoes: manifest.errosRecentes(20),
    eventos: manifest.eventos(20),
  };
}
```

- [ ] **Step 4: Implementar `src/formatar.js`**

```js
export function fmtBytes(b) {
  if (b == null) return '—';
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < unidades.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i ? 1 : 0)} ${unidades[i]}`;
}

export function linhaDeProgresso(e) {
  const { secoes, concluidas, erros, bytes } = e.totais;
  const pct = secoes ? (((concluidas + erros) / secoes) * 100).toFixed(1) : '0.0';
  const onde = e.coleta.ufAtual ? ` | ${e.coleta.ufAtual.toUpperCase()} ${e.coleta.municipioAtual ?? ''}` : '';
  return `${pct}% | ${concluidas}/${secoes} seções | ${erros} erros | ${fmtBytes(bytes)} | ${fmtBytes(e.coleta.velocidadeBps)}/s${onde}`;
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test test/coleta/estado.test.js test/formatar.test.js`
Expected: `# pass 5`

- [ ] **Step 6: Commit**

```bash
git add src/coleta/estado.js src/formatar.js test/coleta/estado.test.js test/formatar.test.js
git commit -m "feat: estado agregado da coleta e formatação"
```

---

### Task 15: Painel web

**Files:**
- Create: `src/painel/server.js`, `src/painel/public/index.html`, `src/painel/public/app.js`, `src/painel/public/estilo.css`
- Test: `test/painel/server.test.js`

- [ ] **Step 1: Escrever os testes**

`test/painel/server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarPainel } from '../../src/painel/server.js';

async function subir(t, { obterEstado, coletor = { pausar() {}, retomar() {} } }) {
  const servidor = criarPainel({ obterEstado, coletor, intervaloMs: 20 });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { servidor.closeAllConnections(); servidor.close(r); }));
  return `http://127.0.0.1:${servidor.address().port}`;
}

test('serve página, estáticos, estado e controles', async (t) => {
  const chamadas = [];
  const coletor = { pausar: (uf) => chamadas.push(['pausar', uf]), retomar: (uf) => chamadas.push(['retomar', uf]) };
  const base = await subir(t, { obterEstado: async () => ({ teste: 1 }), coletor });

  assert.match(await (await fetch(`${base}/`)).text(), /TSE Auditor/);
  assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${base}/estilo.css`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/estado`)).json(), { teste: 1 });

  assert.equal((await fetch(`${base}/api/uf/ac/pausar`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${base}/api/uf/sp/iniciar`, { method: 'POST' })).status, 200);
  assert.deepEqual(chamadas, [['pausar', 'ac'], ['retomar', 'sp']]);

  assert.equal((await fetch(`${base}/api/uf/ac/pausar`)).status, 404, 'controle só por POST');
  assert.equal((await fetch(`${base}/api/nada`)).status, 404);
});

test('SSE envia o estado periodicamente', async (t) => {
  let n = 0;
  const base = await subir(t, { obterEstado: async () => ({ n: ++n }) });
  const controle = new AbortController();
  const resp = await fetch(`${base}/api/eventos`, { signal: controle.signal });
  assert.equal(resp.headers.get('content-type'), 'text/event-stream');
  const leitor = resp.body.getReader();
  const decodificador = new TextDecoder();
  let texto = '';
  while (!texto.includes('"n":2')) texto += decodificador.decode((await leitor.read()).value);
  assert.match(texto, /^data: \{"n":1\}\n\n/);
  controle.abort();
});

test('erro ao montar o estado vira 500', async (t) => {
  const base = await subir(t, { obterEstado: async () => { throw new Error('quebrou'); } });
  const r = await fetch(`${base}/api/estado`);
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { erro: 'quebrou' });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/painel/server.test.js`
Expected: FAIL, módulo não encontrado.

- [ ] **Step 3: Implementar `src/painel/server.js`**

```js
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const PUBLICO = new URL('./public/', import.meta.url);
const ESTATICOS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/estilo.css': ['estilo.css', 'text/css; charset=utf-8'],
};

function json(res, status, corpo) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(corpo));
}

function sse(req, res, obterEstado, intervaloMs) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let ativo = true;
  let timer;
  const enviar = async () => {
    if (!ativo) return;
    try {
      res.write(`data: ${JSON.stringify(await obterEstado())}\n\n`);
    } catch (err) {
      res.write(`event: falha\ndata: ${JSON.stringify(err.message)}\n\n`);
    }
    if (ativo) timer = setTimeout(enviar, intervaloMs);
  };
  req.on('close', () => {
    ativo = false;
    clearTimeout(timer);
  });
  enviar();
}

// Painel local: página estática, estado em JSON, estado ao vivo por SSE e pausar/iniciar por UF.
export function criarPainel({ obterEstado, coletor, intervaloMs = 2000 }) {
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && ESTATICOS[pathname]) {
        const [arquivo, tipo] = ESTATICOS[pathname];
        res.writeHead(200, { 'content-type': tipo });
        res.end(await readFile(new URL(arquivo, PUBLICO)));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/estado') return json(res, 200, await obterEstado());
      if (req.method === 'GET' && pathname === '/api/eventos') return sse(req, res, obterEstado, intervaloMs);
      const controle = /^\/api\/uf\/([a-z]{2})\/(pausar|iniciar)$/.exec(pathname);
      if (req.method === 'POST' && controle) {
        const [, uf, acao] = controle;
        if (acao === 'pausar') coletor.pausar(uf);
        else coletor.retomar(uf); // a execução roda em segundo plano e nunca rejeita
        return json(res, 200, { ok: true });
      }
      json(res, 404, { erro: 'não encontrado' });
    } catch (err) {
      json(res, 500, { erro: err.message });
    }
  });
}
```

- [ ] **Step 4: Criar `src/painel/public/index.html`**

```html
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TSE Auditor: coleta</title>
  <link rel="stylesheet" href="/estilo.css">
</head>
<body>
  <header>
    <h1>TSE Auditor</h1>
    <p id="situacao">conectando…</p>
  </header>

  <section class="cartoes">
    <div class="cartao"><span>Velocidade</span><strong id="velocidade">—</strong></div>
    <div class="cartao"><span>Baixado</span><strong id="baixado">—</strong></div>
    <div class="cartao"><span>Projeção total</span><strong id="projecao">—</strong></div>
    <div class="cartao"><span>Livre no HD</span><strong id="livre">—</strong></div>
    <div class="cartao"><span>Seções</span><strong id="secoes">—</strong></div>
  </section>

  <table>
    <thead>
      <tr><th>UF</th><th>Status</th><th>Seções</th><th>Progresso</th><th>Erros</th><th>Sem dados</th><th>Baixado</th><th></th></tr>
    </thead>
    <tbody id="ufs"></tbody>
  </table>

  <h2>Seções com erro</h2>
  <ul id="erros"></ul>

  <h2>Eventos</h2>
  <ul id="eventos"></ul>

  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 5: Criar `src/painel/public/app.js`**

```js
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n) => n.toLocaleString('pt-BR');
const ROTULO = { aguardando: 'Aguardando', baixando: 'Baixando', pausada: 'Pausada', baixado: 'Baixado' };

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
    <td><button data-uf="${esc(u.uf)}" data-acao="${acao}">${u.pausada ? 'Iniciar' : 'Pausar'}</button></td>
  </tr>`;
}

function render(e) {
  const c = e.coleta;
  $('situacao').textContent = c.rodando
    ? `Coletando ${c.ufAtual?.toUpperCase() ?? ''} ${c.municipioAtual ?? ''}`
    : `Parada${c.motivoParada ? `: ${c.motivoParada}` : ''}`;
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

document.addEventListener('click', async (ev) => {
  const botao = ev.target.closest('button[data-uf]');
  if (!botao) return;
  botao.disabled = true;
  await fetch(`/api/uf/${botao.dataset.uf}/${botao.dataset.acao}`, { method: 'POST' });
});

const fonte = new EventSource('/api/eventos');
fonte.onmessage = (m) => render(JSON.parse(m.data));
fonte.onerror = () => { $('situacao').textContent = 'sem conexão com o painel; tentando de novo…'; };
```

- [ ] **Step 6: Criar `src/painel/public/estilo.css`**

```css
:root {
  --fundo: #fafafa; --texto: #1f2328; --suave: #656d76; --borda: #d0d7de; --cartao: #fff;
  --erro: #cf222e; --ok: #1a7f37; --ativo: #0969da;
}
@media (prefers-color-scheme: dark) {
  :root { --fundo: #0d1117; --texto: #e6edf3; --suave: #8d96a0; --borda: #30363d; --cartao: #161b22;
          --erro: #ff7b72; --ok: #3fb950; --ativo: #58a6ff; }
}
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1100px; padding: 16px; background: var(--fundo); color: var(--texto);
       font: 14px/1.4 system-ui, sans-serif; }
h1 { margin: 0; font-size: 22px; }
h2 { font-size: 16px; margin-top: 28px; }
#situacao { color: var(--suave); margin: 4px 0 16px; }
.cartoes { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
.cartao { background: var(--cartao); border: 1px solid var(--borda); border-radius: 8px; padding: 12px; }
.cartao span { display: block; color: var(--suave); font-size: 12px; }
.cartao strong { font-size: 18px; font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; background: var(--cartao); font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--borda); }
tr.baixando td:first-child { border-left: 3px solid var(--ativo); }
tr.baixado td:nth-child(2) { color: var(--ok); }
tr.pausada { color: var(--suave); }
.erro, li.erro { color: var(--erro); }
progress { width: 120px; vertical-align: middle; }
ul { padding-left: 18px; }
time { color: var(--suave); margin-right: 6px; }
button { cursor: pointer; }
```

- [ ] **Step 7: Rodar e ver passar**

Run: `node --test test/painel/server.test.js`
Expected: `# pass 3`

- [ ] **Step 8: Commit**

```bash
git add src/painel test/painel
git commit -m "feat: painel web de progresso com SSE e controle por UF"
```

---

### Task 16: CLI

**Files:**
- Create: `src/config.js`, `src/cli.js`
- Test: `test/config.test.js`, `test/cli.test.js`

- [ ] **Step 1: Escrever os testes**

`test/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anoDoCiclo, pastaDados } from '../src/config.js';

test('pasta de dados por ano dentro do HD', () => {
  assert.equal(anoDoCiclo('ele2026'), '2026');
  assert.equal(pastaDados('/media/guilherme/Novo volume', 'ele2026'), '/media/guilherme/Novo volume/tse2026');
  assert.throws(() => anoDoCiclo('xyz'), /ciclo inesperado/);
});
```

`test/cli.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { iniciarFakeTse } from './helpers/fakeTse.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const rodar = promisify(execFile);

async function cli(t, args) {
  const fake = await iniciarFakeTse();
  t.after(fake.fechar);
  return rodar(process.execPath, [CLI, ...args], { env: { ...process.env, TSE_BASE: fake.base, TSE_HD: '/nao/existe' } });
}

test('eleicoes lista os pleitos do ele-c.json', async (t) => {
  const { stdout } = await cli(t, ['eleicoes']);
  assert.match(stdout, /3220\s+ele2026\s+04\/10\/2026/);
  assert.match(stdout, /6257 1º turno .*\(Presidente\)/);
});

test('coletar baixa a UF para a pasta indicada', async (t) => {
  const dados = await mkdtemp(path.join(os.tmpdir(), 'tse-cli-'));
  const { stdout } = await cli(t, ['coletar', '--pleito', '3220,3221', '--uf', 'ac', '--dados', dados]);
  assert.match(stdout, /fim: concluída/);
  await access(path.join(dados, 'raw/AC/3220/01066.zip'));
  await access(path.join(dados, 'raw/AC/3221/01066.zip'));
  await access(path.join(dados, 'manifest.sqlite'));
});

test('coletar recusa pleito inexistente', async (t) => {
  await assert.rejects(cli(t, ['coletar', '--pleito', '9999']), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /pleito 9999 não existe/);
    return true;
  });
});

test('coletar sem --dados recusa HD ausente', async (t) => {
  await assert.rejects(cli(t, ['coletar', '--pleito', '3220', '--uf', 'ac']), (err) => {
    assert.match(err.stderr, /O HD está conectado\?/);
    return true;
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/config.test.js test/cli.test.js`
Expected: FAIL, módulos não encontrados.

- [ ] **Step 3: Implementar `src/config.js`**

```js
import path from 'node:path';

export const PADRAO = {
  hd: process.env.TSE_HD ?? '/media/guilherme/Novo volume',
  base: process.env.TSE_BASE ?? 'https://resultados.tse.jus.br',
  ambiente: 'oficial',
  concorrencia: 4,
  userAgent: 'tse-auditor/0.1 (auditoria independente dos arquivos de urna)',
  minLivreBytes: 20 * 1024 ** 3,
  porta: 3000,
};

export function anoDoCiclo(ciclo) {
  const m = /^ele(\d{4})$/.exec(ciclo);
  if (!m) throw new Error(`ciclo inesperado: ${ciclo}`);
  return m[1];
}

// Tudo do projeto fica em <HD>/tse<ano>/; o resto do disco não é tocado.
export function pastaDados(hd, ciclo) {
  return path.join(hd, `tse${anoDoCiclo(ciclo)}`);
}
```

- [ ] **Step 4: Implementar `src/cli.js`**

```js
#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PADRAO, pastaDados } from './config.js';
import { UFS } from './ufs.js';
import { fmtBytes, linhaDeProgresso } from './formatar.js';
import { HttpClient } from './net/http.js';
import { buscarEleicoes } from './tse/eleicoes.js';
import { criarUrls } from './tse/urls.js';
import { Manifest } from './storage/manifest.js';
import { bytesLivres, garantirVolume } from './storage/disco.js';
import { Coletor } from './coleta/coletor.js';
import { montarEstado } from './coleta/estado.js';
import { criarPainel } from './painel/server.js';

const AJUDA = `uso:
  tse-auditor eleicoes
  tse-auditor coletar --pleito 3220,3221 [--uf ac,al] [--dados <pasta>] [--concorrencia 4]
  tse-auditor painel  --pleito 3220,3221 [--uf ac,al] [--dados <pasta>] [--concorrencia 4] [--porta 3000] [--sem-iniciar]`;

function listarEleicoes({ pleitos }) {
  for (const p of pleitos) {
    console.log(`${p.cd.padEnd(6)} ${p.ciclo}  ${p.data}`);
    for (const e of p.eleicoes) {
      const cargos = e.cargos.map((c) => c.nome).join(', ');
      console.log(`    ${e.cd} ${e.turno}º turno  ${e.nome}${cargos ? ` (${cargos})` : ''}`);
    }
  }
}

async function montarColeta(opcoes, { templates, pleitos: todos }, http, concorrencia) {
  if (!opcoes.pleito) throw new Error('informe --pleito (veja "tse-auditor eleicoes")');
  const pleitos = opcoes.pleito.split(',').map((p) => p.trim());
  const escolhidos = pleitos.map((cd) => {
    const p = todos.find((x) => x.cd === cd);
    if (!p) throw new Error(`pleito ${cd} não existe no ele-c.json`);
    return p;
  });
  const ciclos = [...new Set(escolhidos.map((p) => p.ciclo))];
  if (ciclos.length !== 1) throw new Error(`os pleitos precisam ser do mesmo ciclo: ${ciclos.join(', ')}`);
  const [ciclo] = ciclos;

  const ufs = opcoes.uf ? opcoes.uf.toLowerCase().split(',').map((u) => u.trim()) : UFS;
  for (const uf of ufs) if (!UFS.includes(uf)) throw new Error(`UF desconhecida: ${uf}`);

  if (!opcoes.dados) await garantirVolume(PADRAO.hd);
  const dados = opcoes.dados ?? pastaDados(PADRAO.hd, ciclo);
  await mkdir(dados, { recursive: true });

  const manifest = new Manifest(path.join(dados, 'manifest.sqlite'));
  const coletor = new Coletor({
    manifest,
    http,
    urls: criarUrls({ base: PADRAO.base, ambiente: PADRAO.ambiente, templates }),
    pastaDados: dados,
    ciclo,
    pleitos,
    ufs,
    minLivreBytes: PADRAO.minLivreBytes,
    concorrencia,
  });
  const obterEstado = () => montarEstado({ manifest, coletor, pastaDados: dados, bytesLivres });
  return { manifest, coletor, obterEstado, dados };
}

async function coletar({ manifest, coletor, obterEstado, dados }) {
  console.log(`dados em ${dados}`);
  const relogio = setInterval(async () => console.log(linhaDeProgresso(await obterEstado())), 10_000);
  process.once('SIGINT', () => {
    console.log('parando: aguardando as seções em andamento…');
    coletor.parar();
  });
  await coletor.executar();
  clearInterval(relogio);
  const estado = await obterEstado();
  console.log(linhaDeProgresso(estado));
  if (estado.disco.projecaoBytes != null) {
    console.log(`projeção do total: ${fmtBytes(estado.disco.projecaoBytes)}${estado.disco.projecaoPreliminar ? ' (preliminar)' : ''}`);
  }
  console.log(`fim: ${estado.coleta.motivoParada}`);
  manifest.fechar();
  if (estado.coleta.motivoParada !== 'concluída') process.exitCode = 1;
}

async function painel({ manifest, coletor, obterEstado }, opcoes) {
  const porta = Number(opcoes.porta ?? PADRAO.porta);
  const servidor = criarPainel({ obterEstado, coletor });
  await new Promise((r) => servidor.listen(porta, '127.0.0.1', r));
  console.log(`painel em http://localhost:${porta}`);
  process.once('SIGINT', async () => {
    console.log('encerrando: aguardando as seções em andamento…');
    coletor.parar();
    await coletor.aguardar();
    manifest.fechar();
    process.exit(0);
  });
  if (!opcoes['sem-iniciar']) coletor.executar();
}

async function main(argv) {
  const { values: opcoes, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      pleito: { type: 'string' },
      uf: { type: 'string' },
      dados: { type: 'string' },
      concorrencia: { type: 'string' },
      porta: { type: 'string' },
      'sem-iniciar': { type: 'boolean' },
    },
  });
  const [comando] = positionals;
  if (!['eleicoes', 'coletar', 'painel'].includes(comando)) {
    console.log(AJUDA);
    process.exitCode = 1;
    return;
  }
  const concorrencia = Number(opcoes.concorrencia ?? PADRAO.concorrencia);
  const http = new HttpClient({ concorrencia, userAgent: PADRAO.userAgent });
  const eleicoes = await buscarEleicoes(http, PADRAO);
  if (comando === 'eleicoes') return listarEleicoes(eleicoes);
  const coleta = await montarColeta(opcoes, eleicoes, http, concorrencia);
  if (comando === 'coletar') return coletar(coleta);
  return painel(coleta, opcoes);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`erro: ${err.message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test test/config.test.js test/cli.test.js`
Expected: `# pass 5`

- [ ] **Step 6: Rodar a suíte inteira**

Run: `npm test`
Expected: `# fail 0`

- [ ] **Step 7: Commit**

```bash
git add src/config.js src/cli.js test/config.test.js test/cli.test.js
git commit -m "feat: CLI com comandos eleicoes, coletar e painel"
```

---

### Task 17: Primeira coleta real (AC) e medição do volume

Esta task roda contra o servidor real do TSE e grava no HD. Antes de começar, confirme que o HD está montado e que `"/media/guilherme/Novo volume"` não tem uma pasta `tse2026/` de outra origem.

**Files:**
- Modify: `README.md` (próximo passo e comandos)
- Modify: `docs/specs/2026-10-29-tse-auditor-design.md` (volume medido)

- [ ] **Step 1: Conferir HD e eleições**

Run: `df -h "/media/guilherme/Novo volume" && ls "/media/guilherme/Novo volume" && node src/cli.js eleicoes | grep -A3 -E '^32(20|21) '`
Expected: HD montado com espaço livre; pleitos 3220 e 3221 listados com `6257 1º turno … (Presidente)` e `6258 2º turno … (Presidente)`.

- [ ] **Step 2: Coletar AC pelo painel**

Run (em segundo plano): `node src/cli.js painel --pleito 3220,3221 --uf ac`
Expected: `painel em http://localhost:3000`. Abrir no navegador: AC em "Baixando", velocidade > 0, eventos vazios.

- [ ] **Step 3: Testar pausa e retomada no painel**

Clicar em "Pausar" na linha de AC. Expected: em até ~2 s a situação vira "Parada: concluída" e AC fica "Pausada". Clicar em "Iniciar". Expected: AC volta a "Baixando" e continua de onde parou (as seções já completas não são baixadas de novo).

- [ ] **Step 4: Esperar AC terminar e conferir os dados**

Expected no painel: AC "Baixado", projeção total sem "(preliminar)".

Run:

```bash
ls "/media/guilherme/Novo volume/tse2026/raw/AC/3220" | head
du -sh "/media/guilherme/Novo volume/tse2026/raw/AC"
ls "/media/guilherme/Novo volume/tse2026/staging" 2>/dev/null | wc -l
node -e '
  const D = require("better-sqlite3");
  const db = new D("/media/guilherme/Novo volume/tse2026/manifest.sqlite", { readonly: true });
  console.log(db.prepare("SELECT pleito, status, COUNT(*) n, SUM(bytes) b FROM secoes GROUP BY 1, 2").all());
  console.log(db.prepare("SELECT verificacao, status, COUNT(*) n FROM arquivos GROUP BY 1, 2").all());
'
```

Expected: um `<mun>.zip` por município em cada pleito; staging vazio; seções majoritariamente `completa`; arquivos `bu`/`rdv`/`log` com `verificacao = 'vsc'`, `.vsc` com `'dir'`. Investigar qualquer `erro` antes de seguir.

- [ ] **Step 5: Registrar o volume medido no spec**

No spec, seção "Restrições", trocar a linha "**Volume estimado:** …" por:

```markdown
- **Volume medido:** AC (pleitos 3220 + 3221) ocupou <du -sh de raw/AC> em <N> seções; projeção para o Brasil: <projeção do painel>. Confirmado em <data>.
```

preenchendo os três valores com o que foi medido no Step 4 e no painel.

- [ ] **Step 6: Atualizar `README.md`**

Trocar a linha "Próximo passo: …" por:

```markdown
- Coleta pronta (plano `docs/planos/2026-10-29-coleta-e-painel.md`). Rodar: `node src/cli.js painel --pleito 3220,3221` (painel em http://localhost:3000) ou `node src/cli.js coletar --pleito 3220,3221` sem interface. Testes: `npm test`.
- Próximo passo: plano da etapa 2 (verificação de assinatura e extração para Parquet).
```

- [ ] **Step 7: Commit**

```bash
git add README.md docs/specs/2026-10-29-tse-auditor-design.md
git commit -m "docs: volume medido na primeira coleta (AC) e próximos passos"
```

- [ ] **Step 8: Seguir com o Brasil inteiro**

Com AC validado, parar o painel (Ctrl+C) e iniciar todas as UFs: `node src/cli.js painel --pleito 3220,3221`. AC é pulado (já completo) e a coleta segue UF por UF. Se a projeção passar do espaço livre menos 20 GB, avisar o usuário antes de continuar.
