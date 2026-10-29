# TSE Auditor — Design

Data: 2026-10-29
Status: aprovado pelo usuário (brainstorming), aguardando plano de implementação

## Objetivo

Aplicação Node.js que baixa os arquivos oficiais das urnas publicados pelo TSE (BU, RDV, log, assinaturas), verifica a integridade, extrai os dados e cruza tudo para identificar seções eleitorais **destoantes**, sempre acompanhadas das evidências e das explicações técnicas candidatas. A ferramenta nunca emite veredito de fraude: ela gera uma lista ranqueada e documentada que pode embasar um pedido formal de apuração.

Primeiro alvo: eleição presidencial de 2026, 1º e 2º turnos, Brasil inteiro (27 UFs + exterior "ZZ"), analisada estado por estado. Precisa funcionar para outros anos sem mudar código.

## Restrições

- **Fontes:** apenas fontes oficiais do TSE (`resultados.tse.jus.br`, `dadosabertos.tse.jus.br`, documentação técnica do TSE).
- **Armazenamento:** HD externo em `/media/guilherme/Novo volume` (o caminho tem espaço, então sempre usar aspas). É NTFS, com ~466 GB livres (esvaziado pelo usuário em 29/10/2026); mesmo assim, o projeto não mexe em nada fora da sua pasta. Tudo do projeto fica em `<HD>/tse2026/` (ou `<HD>/tse<ano>/`).
- **Volume medido:** AC (pleitos 3220 + 3221) ocupou 884 MB em 4.540 seções (~202 KB por seção/turno; log ~125 KB, .vsc ~63 KB, RDV ~9 KB, BU ~6 KB). Projeção para o Brasil nos dois turnos: ~190 GB. Confirmado em 29/10/2026.
- **Ambiente:** Node 22. Sem 7z nem duckdb no sistema; usar `7zip-bin` e `@duckdb/node-api` (binários embutidos via npm).
- **Servidor do TSE:** respeitar os limites de requisição.

## Códigos das eleições de 2026

Fonte: `https://resultados.tse.jus.br/oficial/comum/config/ele-c.json`

| Turno | Data | Pleito (arquivos de urna) | Eleição presidencial |
|---|---|---|---|
| 1º | 04/10/2026 | 3220 | 6257 |
| 2º | 25/10/2026 | 3221 | 6258 |

Os arquivos de urna são por **pleito**: o log do 1º turno contém a sessão inteira (todos os cargos). Os votos analisados são de presidente; os sinais de comportamento usam a sessão completa.

## Multi-ano

- Nada fica fixo no código: as eleições são descobertas pelo `ele-c.json`.
  - CLI: `eleicoes` lista as eleições; `coletar --pleito 3220,3221 --cargo presidente`.
- Os decodificadores de BU, RDV e log são versionados por formato, e a versão é escolhida pelo conteúdo do arquivo. As especificações ASN.1 vêm da documentação oficial do TSE de cada ano.
- A chave de seção é `UF + município + zona + seção`, o que permite comparar turnos e anos.

## Pipeline

### 1. Coleta

1. Para cada UF e pleito: baixa a configuração (municípios, zonas, seções).
2. Para cada seção: baixa o índice de arquivos (nomes e hashes).
3. Baixa todos os arquivos. Urnas substituídas (contingência) têm vários conjuntos, e todos são mantidos.

O formato exato das URLs de 2026 deve ser confirmado no primeiro teste. Referência de 2022: `.../arquivo-urna/<pleito>/config/<uf>/...` e `.../arquivo-urna/<pleito>/dados/<uf>/<mun>/<zona>/<secao>/<hash>/<arquivo>`.

Regras:
- **Retomável:** `manifest.sqlite` guarda cada arquivo (URL, hash do TSE, tamanho, status, data). Ao reiniciar, baixa apenas o que falta ou falhou.
- **Hash:** confere com o hash do TSE; se não bater, baixa de novo; se persistir, marca como erro.
- **Educado com o servidor:** 4 conexões por padrão (configurável), espera progressiva em 429/5xx, User-Agent identificado.
- **Empacotamento por município:** `.zip` sem compressão, porque NTFS sofre com milhões de arquivos pequenos. O conteúdo fica byte a byte idêntico ao original.
- **Espaço:** projeção depois do primeiro estado; pausa automática se o espaço livre ficar abaixo de 20 GB.
- **HD desconectado:** para com uma mensagem clara, sem corromper o manifest.
- **Ordem:** UF por UF, os dois turnos juntos.

Layout no HD:
```
<HD>/tse2026/
├── manifest.sqlite
├── raw/<UF>/<pleito>/<municipio>.zip
├── parquet/<UF>/
└── reports/<UF>.html
```

### 2. Verificação e extração

- Valida o hash e a assinatura digital de cada arquivo. O que falhar não entra na análise e é reportado.
- Decodifica BU e RDV (ASN.1) e o log (descompactação 7z + parse das linhas).
- Gera Parquet por UF:
  - `secoes`: aptos, comparecimento, abstenção, modelo da urna, flag de substituição, flag de seção agregada;
  - `votos`: votos por candidato/branco/nulo, com a origem (BU ou RDV);
  - `eventos_log`: horário, tipo de evento, urna e campos relevantes.

### 3. Cruzamentos

Cada cruzamento é um módulo isolado e testável que produz achados com pontuação e explicações candidatas.

1. BU × RDV × log: contagens por cargo.
2. Limites: comparecimento ≤ aptos; votos ≤ comparecimento.
3. 1º × 2º turno: o ganho de cada candidato precisa caber nos votos disponíveis na seção (eliminados, brancos/nulos, abstenção revertida, adversário).
4. Comparação com vizinhos: mesmo local de votação e mesma zona.
5. Sinais de voto pelo mesário:
   - taxa de liberação sem biometria, comparada com a taxa de biometria cadastrada da seção, com as vizinhas e com o 1º turno;
   - concentração de liberações manuais no fim do dia;
   - ritmo e regularidade dos intervalos entre votos e tempo na cabine;
   - queda de abstenção entre turnos junto com aumento de liberação manual.
6. Horários fora do expediente; eventos de teste ou carga misturados à votação.
7. Soma dos BUs × total oficial por UF.

Explicações candidatas que precisam ser verificadas e descontadas: urna de contingência (log dividido), seção agregada, voto em trânsito, leitor biométrico com defeito (falhas desde a manhã), eleitores sem biometria cadastrada, idosos com digitais desgastadas, fila real às 17h, desvio no relógio da urna, diferenças de formato entre modelos de urna.

Saída: seções ranqueadas por grau de destoância, com os sinais, as explicações candidatas e links para os arquivos originais. Nunca "fraude".

### 4. Painel web local (`http://localhost:3000`)

- **Visão geral:** UFs com status (aguardando, baixando, verificando, extraído, analisado), progresso, velocidade, espaço usado e projetado, erros. Atualização ao vivo (SSE).
- **Por UF:** ranking de seções destoantes, filtros por sinal, gráficos de 1º × 2º turno.
- **Por seção:** números dos dois turnos, linha do tempo do log (votos no eixo do horário, biometria × liberação manual), resultado de cada cruzamento, acesso aos arquivos oficiais.
- **Controle:** iniciar ou pausar a coleta por UF.

### 5. Testes e erros

- Fixtures com arquivos reais de algumas seções.
- Toda falha (download, assinatura, decodificação) fica registrada no manifest e aparece no painel. Uma seção sem dados é exibida como "sem dados", nunca como "ok".

## Ordem de implementação sugerida

1. Descoberta de eleições + coleta + manifest + painel de progresso (para começar o download o quanto antes).
2. Verificação e extração.
3. Cruzamentos.
4. Telas de análise no painel.

## Fora de escopo

- Qualquer fonte não oficial.
- Identificação de eleitores (o log não contém essa informação e o sigilo do voto deve ser preservado).
