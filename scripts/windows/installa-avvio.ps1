# AI Bridge su Windows: avvio automatico all'accensione, anche senza che nessuno abbia fatto l'accesso.
# Uso: apri PowerShell COME AMMINISTRATORE, entra nella cartella del progetto ed esegui:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\installa-avvio.ps1
# Per toglierlo:  ... installa-avvio.ps1 -Togli
param([switch]$Togli)
$ErrorActionPreference = 'Stop'
$nome = 'AIBridge'

if ($Togli) {
  Unregister-ScheduledTask -TaskName $nome -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host 'Avvio automatico rimosso.'
  exit 0
}

$cartella = (Get-Location).Path
if (-not (Test-Path (Join-Path $cartella 'package.json'))) { throw 'Lancia lo script dentro la cartella del progetto (dove c''e'' package.json).' }
if (-not (Test-Path (Join-Path $cartella 'dist\apps\server\src\web.js'))) { throw 'Prima esegui: npm install   e poi: npm run build' }
$node = (Get-Command node -ErrorAction Stop).Source
try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:3000/api/public | Out-Null; throw 'Il server e'' gia'' acceso a mano: chiudilo (Ctrl+C) e rilancia.' } catch [System.Net.WebException] { }

# Il PC non deve mai andare in stop (lo schermo si puo' spegnere).
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /change monitor-timeout-ac 10 | Out-Null

$log = Join-Path $cartella 'ai-bridge.log'
$comando = "/c `"`"$node`" --disable-warning=ExperimentalWarning dist\apps\server\src\web.js >> `"$log`" 2>&1`""
$azione = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $comando -WorkingDirectory $cartella
$trigger = New-ScheduledTaskTrigger -AtStartup
# S4U = parte all'accensione come TE, senza chiedere la password e senza bisogno di aver fatto l'accesso.
$principale = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$impostazioni = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $nome -Action $azione -Trigger $trigger -Principal $principale -Settings $impostazioni -Force | Out-Null
Start-ScheduledTask -TaskName $nome
Start-Sleep -Seconds 4
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 http://127.0.0.1:3000/api/public | Out-Null
  Write-Host 'Fatto: AI Bridge e'' acceso e partira'' da solo a ogni accensione.'
} catch {
  Write-Host 'Non risponde. Ultime righe del registro:'
  if (Test-Path $log) { Get-Content $log -Tail 15 }
  exit 1
}
