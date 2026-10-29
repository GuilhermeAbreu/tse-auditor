# TSE Auditor

Ferramenta em Node.js/TypeScript que baixa os **arquivos oficiais das urnas eletrônicas** publicados pelo TSE (boletim de urna, registro digital do voto, log e assinaturas), verifica a integridade de cada arquivo, extrai os dados e cruza tudo para apontar **seções eleitorais destoantes**.

Cada seção apontada vem com as evidências e com as **explicações técnicas candidatas** (urna de reserva, leitor biométrico com defeito, fila no encerramento etc.). A ferramenta **nunca emite veredito de fraude**: ela produz uma lista ranqueada e documentada para orientar uma verificação humana ou um pedido formal de apuração.

Toda a análise é feita por código determinístico: os mesmos arquivos geram sempre o mesmo resultado, sem intervenção manual.

## Sumário

- [Requisitos](#requisitos)
- [Início rápido](#início-rápido)
- [Como funciona](#como-funciona)
- [Painel web](#painel-web)
- [Linha de comando](#linha-de-comando)
- [Configuração](#configuração)
- [Onde ficam os dados](#onde-ficam-os-dados)
- [Integridade dos arquivos](#integridade-dos-arquivos)
- [Sinais e explicações candidatas](#sinais-e-explicações-candidatas)
- [Estrutura do código](#estrutura-do-código)
- [Desenvolvimento](#desenvolvimento)
- [Limitações conhecidas](#limitações-conhecidas)
- [Fontes](#fontes)

## Requisitos

- **Node.js 22.12 ou superior.** O Node executa os arquivos `.ts` diretamente, sem etapa de build.
- **Espaço em disco:** cerca de 202 KB por seção e por turno. As eleições gerais de 2026 nos dois turnos ocupam **~190 GB**. Recomenda-se um HD externo.
- Acesso à internet para `resultados.tse.jus.br`.

## Início rápido

```bash
npm install
node src/cli.ts painel
```

Abra **http://localhost:3000**, escolha os pleitos e as UFs na seção **Configuração** e clique em **Aplicar e iniciar**. A coleta acompanha o progresso ao vivo. Quando uma UF termina, a extração e a análise rodam automaticamente, e o resultado aparece na aba **Análise**.

Para ver quais eleições existem:

```bash
node src/cli.ts eleicoes
```

## Como funciona

O processamento tem quatro etapas, cada uma retomável e independente:

| Etapa | O que faz | Saída |
|---|---|---|
| **1. Coleta** | Descobre as eleições no `ele-c.json` do TSE, baixa a configuração de seções de cada UF, o índice de cada seção e todos os arquivos (inclusive de urnas de contingência). Verifica cada arquivo e empacota por município. | `raw/<UF>/<pleito>/<município>.zip` + `manifest.sqlite` |
| **2. Extração** | Decodifica o BU e o RDV (ASN.1/BER) e o log da urna. Confere automaticamente BU × RDV × log. | `parquet/<UF>/{secoes,votos,eventos_log,falhas}.parquet` |
| **3. Cruzamentos** | Compara cada seção com as vizinhas do mesmo local de votação, com a zona e com ela mesma no outro turno. Gera achados com pontuação e explicações candidatas. | `parquet/<UF>/achados.parquet` |
| **4. Painel** | Mostra o progresso da coleta, o ranking de seções destoantes e o detalhe de cada seção. | `http://localhost:3000` |

Nada é fixo no código para um ano específico: eleições, turnos e caminhos dos arquivos são descobertos a partir do `ele-c.json` do TSE.

## Painel web

`node src/cli.ts painel` abre o painel em `http://localhost:3000` (acessível só a partir da própria máquina).

**Coleta**
- Status por UF (aguardando, baixando, pausada, baixado, baixado com erros), seções concluídas, erros, arquivos não publicados pelo TSE e volume baixado.
- Velocidade, espaço livre no HD e projeção do tamanho total.
- Botões para iniciar e parar a coleta e para pausar ou retomar cada UF.
- Erros agrupados por causa, com as seções de exemplo.

**Configuração**
- Pleitos (agrupados por ano), UFs, número de conexões simultâneas ao TSE.
- Seção **Avançado** com todos os demais parâmetros (veja [Configuração](#configuração)).

**Análise**
- Glossário dos sinais e das explicações candidatas.
- Ranking de seções destoantes por UF, com filtro por sinal.
- Ao clicar numa seção, um painel mostra: por que ela apareceu (em linguagem comum), a comparação entre os turnos (eleitores, forma de habilitação, votos para presidente) e a linha do tempo dos votos ao longo do dia.

## Linha de comando

```text
node src/cli.ts eleicoes
node src/cli.ts coletar  --pleito 3220,3221 [--uf ac,al] [--dados <pasta>] [--concorrencia 4]
node src/cli.ts painel   [--pleito 3220,3221] [--uf ac,al] [--dados <pasta>] [--concorrencia 4] [--porta 3000] [--sem-iniciar]
node src/cli.ts extrair  --uf ac [--pleito 3220,3221] [--dados <pasta>]
node src/cli.ts analisar --uf ac [--dados <pasta>] [--turnos 3220,3221]
```

| Comando | Descrição |
|---|---|
| `eleicoes` | Lista pleitos, eleições e cargos publicados pelo TSE. |
| `coletar` | Coleta sem interface, com uma linha de progresso a cada 10 s. |
| `painel` | Painel web com coleta, configuração e análise. Sem opções, usa a última configuração salva. |
| `extrair` | Decodifica BU, RDV e log de uma UF já coletada e grava os Parquet. |
| `analisar` | Roda os cruzamentos de uma UF extraída. Sem `--turnos`, os turnos vêm do `ele-c.json`. |

`Ctrl+C` encerra com segurança, aguardando as seções em andamento. Um segundo `Ctrl+C` força a saída. Interromper nunca perde o que já foi baixado e verificado.

Exemplo para as eleições gerais de 2026 (1º turno = pleito 3220, 2º turno = pleito 3221):

```bash
node src/cli.ts painel --pleito 3220,3221 --uf sp --concorrencia 8
```

## Configuração

Tudo pode ser ajustado pelo painel; a última configuração aplicada fica em `~/.config/tse-auditor/config.json` (ou no caminho da variável `TSE_CONFIG`). As opções da linha de comando têm prioridade sobre a configuração salva.

| Parâmetro | Padrão | Descrição |
|---|---|---|
| Conexões simultâneas | 4 (1–64) | Requisições paralelas ao TSE. Acima de 16 o painel avisa. |
| Tentativas por requisição | 8 | Em 429, 5xx ou falha de rede, com espera progressiva e aleatória. |
| Espera inicial / máxima | 1 s / 60 s | Intervalo entre tentativas. Um 429 pausa todas as requisições. |
| Timeout por requisição | 120 s | |
| User-Agent | `tse-auditor/0.1 …` | Identificação enviada ao TSE. |
| Rebaixar arquivo que não confere | 3 vezes | Depois disso o arquivo fica marcado com erro. |
| Falhas de rede seguidas | 20 | A coleta para com “sem conexão com o TSE”. |
| Espaço livre mínimo | 20 GB | Abaixo disso a coleta para. |
| Gravação do manifest | 1 s | Intervalo de confirmação das gravações em lote. |
| Atualização do painel | 2 s | |
| Pasta do HD | `/media/guilherme/Novo volume` | Ou variável `TSE_HD`. |
| Analisar ao concluir | ligado | Extrai e analisa a UF assim que a coleta dela termina. |

A fonte de dados (`https://resultados.tse.jus.br`) não é editável pelo painel: só fontes oficiais são aceitas.

## Onde ficam os dados

Tudo fica numa pasta por ano dentro do HD configurado; nada fora dela é tocado.

```text
<HD>/tse2026/
├── manifest.sqlite                    estado da coleta: seções, arquivos, hashes, erros e eventos
├── raw/<UF>/<pleito>/
│   ├── <uf>-p<pleito>-cs.json         configuração oficial de seções da UF
│   └── <município>.zip                arquivos originais, sem compressão, byte a byte iguais aos do TSE
├── parquet/<UF>/
│   ├── secoes.parquet                 aptos, comparecimento, habilitações, urna, horários, inconsistências
│   ├── votos.parquet                  votos por cargo e candidato, com origem BU ou RDV
│   ├── eventos_log.parquet            todos os eventos do log da urna
│   ├── falhas.parquet                 seções que não puderam ser decodificadas
│   └── achados.parquet                sinais com pontuação e explicações candidatas
└── staging/                           temporário durante a coleta
```

Dentro de cada zip: `<zona>/<seção>/<índice>-aux.json` e `<zona>/<seção>/<hash>/<arquivo>`.

## Integridade dos arquivos

Cada arquivo baixado passa por uma cadeia de verificações antes de ser aceito:

1. **ETag do servidor** = MD5 do conteúdo recebido (erros de transmissão).
2. **Hash do diretório** publicado pelo TSE = SHA-256 do arquivo de assinaturas `-vota.vsc`. O TSE codifica esse hash em base64 trocando `/` por `-`.
3. O `.vsc` contém o **SHA-512** do BU, do RDV e do log; cada um precisa constar nele.

Arquivo que não confere é baixado de novo; persistindo, fica registrado como erro. Antes de empacotar, o conteúdo em disco é conferido de novo contra o manifest, para que uma queda de energia ou um HD desconectado não deixe dados corrompidos passarem como válidos.

Na extração, o código ainda confere automaticamente:
- soma das formas de habilitação = comparecimento;
- BU × log (comparecimento e habilitações);
- BU × RDV (votos por eleição, cargo e candidato).

Divergências ficam na coluna `inconsistencias` de `secoes.parquet`.

## Sinais e explicações candidatas

A **pontuação** (0–100) é 10 × a distância estatística robusta da seção em relação à sua referência, limitada a 100. Até ~30 é variação comum; acima de ~50, bem fora do normal. Números pequenos pedem cautela.

| Sinal | Significado |
|---|---|
| Mesário acima do local / da zona | Proporção de eleitores liberados pelo mesário bem acima das seções vizinhas. |
| Mesário subiu entre turnos | Liberação pelo mesário aumentou muito em relação ao outro turno. |
| Mesário na última hora | Liberações pelo mesário concentradas no fim da votação. |
| Abstenção caiu e mesário subiu | As duas coisas ao mesmo tempo entre os turnos. |
| Variação atípica entre turnos | Votos de um candidato a presidente mudaram muito mais que na zona. |
| Ganho acima do disponível | Ganho no 2º turno maior que os votos disponíveis na seção. |
| Voto após pausa no encerramento | Voto depois do encerramento após 30 min ou mais sem votos. |
| Voto antes da abertura · Teste/carga no dia | Eventos fora do horário ou de teste misturados à votação. |
| Comparecimento acima de aptos · Votos acima do comparecimento | Limites aritméticos violados. |

| Explicação candidata | Quando é detectada |
|---|---|
| Fila no encerramento | Votos contínuos até o fim da votação. |
| Leitor biométrico com defeito | Muitas tentativas de digital falhando desde cedo. |
| Eleitores sem biometria | Muitos eleitores habilitados pelo ano de nascimento. |
| Seção agregada | A seção recebeu eleitores de outra. |
| Urna de reserva | A urna foi substituída no dia. |
| Desvio no relógio | Horários da urna incoerentes. |

Uma seção com pontuação alta **e sem nenhuma explicação candidata** é a que mais merece verificação.

## Estrutura do código

```text
src/
├── cli.ts                  comandos
├── tse/                    ele-c.json, URLs, índices de seção, cadeia de integridade
├── net/http.ts             cliente HTTP com limite de conexões, espera progressiva e pausa em 429
├── storage/                manifest SQLite, empacotamento em zip, espaço em disco
├── coleta/                 coletor, controle e opções da coleta, estado do painel
├── extracao/               leitor BER, decodificadores de BU, RDV e log, gravação em Parquet
├── cruzamentos/            limites, turnos, mesário e horários (SQL em DuckDB)
├── painel/                 servidor HTTP, API de análise e página web
└── tipos/                  tipos do domínio e dos formatos do TSE
docs/
├── specs/                  desenho do sistema
├── planos/                 planos de implementação e divergências
└── tse/                    especificações oficiais do TSE (formatos de BU, RDV, assinatura e log)
```

## Desenvolvimento

```bash
npm test          # testes (node:test), com arquivos reais do TSE como fixtures
npm run tipos     # checagem de tipos (TypeScript estrito), inclusive da página do painel
```

As fixtures em `test/fixtures/tse/` reproduzem os caminhos do servidor do TSE e são servidas por um servidor falso nos testes; `scripts/baixar-fixtures.sh` baixa de novo os arquivos reais. Os testes nunca acessam o HD nem a rede.

## Limitações conhecidas

- **Assinatura digital** do `.vsc` (ECDSA P-521 / Ed521) ainda não é verificada criptograficamente; a integridade é garantida pela cadeia de hashes publicada pelo TSE.
- **Formato do BU de 2026** difere da especificação oficial publicada (2022). O significado dos três contadores de habilitação (ano de nascimento, biometria, mesário) foi inferido e é conferido automaticamente em cada extração; dois campos novos por eleição ainda não têm significado conhecido.
- **Imagem do BU (`imgbu`)**: algumas seções a listam no índice sem que o TSE a publique; isso é registrado como “não publicado” e não afeta a análise.
- Seções sem arquivos não são revisitadas automaticamente; reempacotar um município reescreve o zip inteiro.

## Fontes

Somente fontes oficiais do Tribunal Superior Eleitoral:

- Arquivos de urna e configurações: `https://resultados.tse.jus.br`
- Especificação dos formatos de BU, RDV, assinatura e log: documentação técnica do software da urna eletrônica, publicada pelo TSE (cópia em `docs/tse/`).
