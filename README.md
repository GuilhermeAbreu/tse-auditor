# TSE Auditor

Ferramenta Node.js para auditar os arquivos oficiais das urnas do TSE (BU, RDV, log) e apontar seções destoantes, sempre com evidências e explicações técnicas candidatas. Nunca emite veredito de fraude.

- Design: `docs/specs/2026-10-29-tse-auditor-design.md`.
- Planos e divergências da implementação: `docs/planos/`.
- Rodar: `node src/cli.ts painel` (http://localhost:3000; configuração pelo painel, salva em `~/.config/tse-auditor/config.json`). Linha de comando: `node src/cli.ts eleicoes | coletar | painel | extrair | analisar`.
- Testes: `npm test`; tipos: `npm run tipos` (TypeScript estrito, sem build: o Node 22 roda os `.ts` direto).
- Dados: HD externo em `"/media/guilherme/Novo volume"` (o caminho tem espaço). Só a pasta `tse<ano>/` é usada; o restante do disco não é tocado.
- Fontes: apenas oficiais do TSE. Especificações oficiais em `docs/tse/`.
