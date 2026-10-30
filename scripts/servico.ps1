# Instala e controla o TSE Auditor em segundo plano no Windows (Agendador de Tarefas), com atalho no Menu Iniciar.
# A tarefa sobe no logon sem janela, reinicia o painel se ele cair e segue coletando com o navegador fechado.
# Se a coleta começa sozinha é uma escolha feita no painel; sem a pasta de dados (HD desconectado), o painel espera.
#
# uso: npm run servico -- instalar | remover | iniciar | parar | reiniciar | status | logs | abrir
param([Parameter(Position = 0)][string]$Comando = '')

$ErrorActionPreference = 'Stop'
$Tarefa = 'TSE Auditor'
$Raiz = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path $Raiz 'src\cli.ts'
$Porta = if ($env:TSE_PORTA) { [int]$env:TSE_PORTA } else { 3005 }
$Url = "http://localhost:$Porta"
$PastaApp = Join-Path $env:LOCALAPPDATA 'tse-auditor'
$Log = Join-Path $PastaApp 'tse-auditor.log'
$ArqNode = Join-Path $PastaApp 'node.txt'
$Atalho = Join-Path ([Environment]::GetFolderPath('Programs')) 'TSE Auditor.lnk'
$Shell = (Get-Process -Id $PID).Path # powershell.exe ou pwsh.exe que está rodando este script
$Usuario = "$env:USERDOMAIN\$env:USERNAME"

function Get-Instalado { return [bool](Get-ScheduledTask -TaskName $Tarefa -ErrorAction SilentlyContinue) }

function Test-Porta {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $Porta); return $true } catch { return $false } finally { $c.Close() }
}

function Wait-Porta([bool]$Aberta, [int]$Segundos) {
  for ($i = 0; $i -lt $Segundos * 2; $i++) {
    if ((Test-Porta) -eq $Aberta) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Argumentos([string]$Cmd) { return "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" $Cmd" }

function Instalar {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw 'node não encontrado no PATH (instale o Node.js 22.18 ou superior)' }
  if ((Test-Porta) -and -not (Get-Instalado)) {
    throw "a porta $Porta já está em uso (painel aberto num terminal?). Feche-o com Ctrl+C e rode de novo."
  }
  New-Item -ItemType Directory -Force -Path $PastaApp | Out-Null
  Set-Content -Path $ArqNode -Value $node -Encoding UTF8
  $acao = New-ScheduledTaskAction -Execute $Shell -Argument (Argumentos 'executar') -WorkingDirectory $Raiz
  $gatilho = New-ScheduledTaskTrigger -AtLogOn -User $Usuario
  $ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $quem = New-ScheduledTaskPrincipal -UserId $Usuario -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $Tarefa -Action $acao -Trigger $gatilho -Settings $ajustes -Principal $quem `
    -Description "TSE Auditor: coleta e painel ($Url)" -Force | Out-Null

  $w = New-Object -ComObject WScript.Shell
  $l = $w.CreateShortcut($Atalho)
  $l.TargetPath = $Shell
  $l.Arguments = Argumentos 'abrir'
  $l.WorkingDirectory = $Raiz
  $l.IconLocation = Join-Path $Raiz 'assets\tse-auditor.ico'
  $l.Description = 'Coleta e auditoria dos arquivos de urna do TSE'
  $l.Save()

  Start-ScheduledTask -TaskName $Tarefa
  Write-Host "instalado: a tarefa sobe no logon e o painel fica em $Url"
  Write-Host "atalho `"TSE Auditor`" no Menu Iniciar; logs: npm run servico -- logs"
}

# Roda o painel e o reinicia se ele cair (saída diferente de 0); a parada limpa (código 0) encerra o laço.
function Executar {
  $node = (Get-Content -Path $ArqNode -Raw).Trim()
  $argsNode = @("`"$Cli`"", 'painel', '--servico', '--porta', "$Porta", '--log', "`"$Log`"")
  while ($true) {
    $p = Start-Process -FilePath $node -ArgumentList $argsNode -WorkingDirectory $Raiz -WindowStyle Hidden -Wait -PassThru
    if ($p.ExitCode -eq 0) { break }
    Add-Content -Path $Log -Value "$(Get-Date -Format s) painel saiu com código $($p.ExitCode); reiniciando em 15 s" -Encoding UTF8
    Start-Sleep -Seconds 15
  }
}

# Parada limpa: pede ao painel que termine as seções em andamento e grave o manifesto (como o Ctrl+C).
function Parar {
  if (Test-Porta) {
    try {
      Invoke-WebRequest -Uri "$Url/api/encerrar" -Method Post -Headers @{ 'x-tse-auditor' = '1' } -UseBasicParsing | Out-Null
    } catch {
      Write-Host "aviso: o painel não respondeu ao pedido de encerramento ($($_.Exception.Message))"
    }
    if (-not (Wait-Porta $false 120)) {
      Write-Host 'o painel não encerrou em 2 minutos; forçando a saída'
      Get-NetTCPConnection -LocalPort $Porta -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
  }
  if (Get-Instalado) { Stop-ScheduledTask -TaskName $Tarefa -ErrorAction SilentlyContinue }
  Write-Host 'parado'
}

function Iniciar {
  if (-not (Get-Instalado)) { throw 'não instalado: npm run servico -- instalar' }
  if (-not (Test-Porta)) { Start-ScheduledTask -TaskName $Tarefa }
}

function Remover {
  Parar
  if (Get-Instalado) { Unregister-ScheduledTask -TaskName $Tarefa -Confirm:$false }
  Remove-Item -Path $Atalho -ErrorAction SilentlyContinue
  Write-Host "removido (dados e configuração ficam como estão; logs em $PastaApp)"
}

function Status {
  if (-not (Get-Instalado)) { Write-Host 'não instalado'; return }
  $t = Get-ScheduledTask -TaskName $Tarefa
  $info = Get-ScheduledTaskInfo -TaskName $Tarefa
  Write-Host "tarefa: $($t.State) · última execução: $($info.LastRunTime)"
  Write-Host ("painel: " + $(if (Test-Porta) { "respondendo em $Url" } else { 'fora do ar' }))
  Write-Host "log: $Log"
}

function Abrir {
  Iniciar
  if (-not (Wait-Porta $true 30)) { Write-Host "o painel ainda não respondeu; veja: npm run servico -- logs" }
  Start-Process $Url
}

switch ($Comando) {
  'instalar' { Instalar }
  'remover' { Remover }
  'iniciar' { Iniciar }
  'parar' { Parar }
  'reiniciar' { Parar; Iniciar }
  'status' { Status }
  'logs' { if (Test-Path $Log) { Get-Content -Path $Log -Tail 100 -Wait -Encoding UTF8 } else { Write-Host "ainda sem log: $Log" } }
  'abrir' { Abrir }
  'executar' { Executar }
  default { Write-Host 'uso: npm run servico -- instalar | remover | iniciar | parar | reiniciar | status | logs | abrir'; exit 1 }
}
