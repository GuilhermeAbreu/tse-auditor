// "npm run servico -- <comando>": chama o script do sistema. Linux: servico.sh (systemd do usuário);
// Windows: servico.ps1 (Agendador de Tarefas). Comandos: instalar, remover, iniciar, parar, reiniciar, status, logs, abrir.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pasta = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const comandos = {
  linux: ['bash', [path.join(pasta, 'servico.sh'), ...args]],
  win32: ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(pasta, 'servico.ps1'), ...args]],
} as const;
const c = comandos[process.platform as keyof typeof comandos];
if (!c) {
  console.error(`serviço em segundo plano disponível no Linux e no Windows (este sistema: ${process.platform}); use "node src/cli.ts painel"`);
  process.exitCode = 1;
} else {
  const r = spawnSync(c[0], c[1], { stdio: 'inherit' });
  if (r.error) console.error(`não foi possível rodar ${c[0]}: ${r.error.message}`);
  process.exitCode = r.status ?? 1;
}
