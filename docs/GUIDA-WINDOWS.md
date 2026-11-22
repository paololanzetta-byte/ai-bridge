# AI Bridge su un PC Windows sempre acceso (server di casa)

**Stato: NON provato su un PC Windows vero.** Lo script e i passi sono scritti con cura ma al primo avvio potrebbero servire aggiustamenti.

## Prima dell'arrivo
- Cavo di rete (Ethernet) dal PC al router; cavo DisplayPort (o adattatore DisplayPort-HDMI), tastiera e mouse solo per la prima configurazione.
- Account Tailscale (lo stesso del Mac e dell'iPhone).

## 1. Windows
1. Collega tutto, accendi, completa la configurazione guidata di Windows e fai tutti gli aggiornamenti (Impostazioni → Windows Update).
2. Impostazioni → Sistema → Alimentazione: "Sospensione" mai (quando e' collegato alla corrente).
3. Nel BIOS (tasto indicato all'accensione, spesso F2 o Canc), cerca "Restore on AC Power Loss" / "After Power Failure" e mettilo su **Power On**: dopo un blackout si riaccende da solo.

## 2. Programmi
1. Installa **Node.js LTS** (nodejs.org, versione 22 o piu' recente). Chiudi e riapri PowerShell, poi `node -v` deve mostrare 22 o piu'.
2. Installa **Tailscale** (tailscale.com/download), accedi con lo stesso account.
3. Scarica il programma (PowerShell, non Amministratore):
   ```
   cd $HOME\Documents
   Invoke-WebRequest https://codeload.github.com/paololanzetta-byte/ai-bridge/zip/refs/heads/main -OutFile ai-bridge.zip
   Expand-Archive ai-bridge.zip .
   Rename-Item ai-bridge-main ai-bridge-web
   cd ai-bridge-web
   npm install
   npm run build
   ```
4. Crea il file `.env` (blocco note) con la chiave di Claude, come sul Mac (vedi `.env.example`). La chiave la scrivi tu, mai in chat.
5. Accesso a ChatGPT (con lo schermo collegato, e' il browser di questo PC): `npm run login:chatgpt`.

## 3. Prova e avvio automatico
1. `npm run web` e apri http://127.0.0.1:3000 per controllare. Chiudi con Ctrl+C.
2. PowerShell **come Amministratore**, nella cartella del progetto:
   `powershell -ExecutionPolicy Bypass -File scripts\windows\installa-avvio.ps1`
   Deve dire "Fatto". Il registro e' `ai-bridge.log`. Togliere: stesso comando con `-Togli`.
3. Riavvia il PC e controlla da un altro dispositivo (punto 4) che parta da solo.

## 4. Telefono e Mac
1. Su questo PC (PowerShell Amministratore): `tailscale serve --bg 3000`. Mostra un indirizzo `https://...ts.net`, raggiungibile solo dai tuoi dispositivi. Prima attiva i certificati HTTPS nel pannello di amministrazione di Tailscale.
2. Dall'iPhone: apri l'indirizzo in Safari → Condividi → Aggiungi a Home.
3. Controllo del PC dal Mac senza schermo: Impostazioni → Sistema → Desktop remoto: attiva; poi dal Mac usa l'app Microsoft "Windows App" con il nome Tailscale del PC.

## Aggiornare
Riscarica lo zip in una cartella nuova, copia `.env` e `data`, `npm install`, `npm run build`, poi in PowerShell Amministratore: `Stop-ScheduledTask AIBridge; Start-ScheduledTask AIBridge`.
