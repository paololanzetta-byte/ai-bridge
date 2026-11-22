#!/bin/sh
# Fa partire AI Bridge da solo quando accendi il Mac (e lo riavvia se si ferma).
# Uso (dentro la cartella del progetto):  sh scripts/avvio-automatico.sh
# Per toglierlo:                           sh scripts/avvio-automatico.sh togli
set -e
LABEL="com.aibridge.web"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/ai-bridge.log"
DOMAIN="gui/$(id -u)"

if [ "$1" = "togli" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Avvio automatico rimosso."
  exit 0
fi

DIR="$(pwd)"
[ -f "$DIR/package.json" ] || { echo "Errore: lancia lo script dentro la cartella ai-bridge-web."; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Errore: Node non trovato."; exit 1; }
[ -f "$DIR/dist/apps/server/src/web.js" ] || { echo "Prima esegui una volta: npm run web (poi Ctrl+C)."; exit 1; }
if curl -s -o /dev/null --max-time 2 http://127.0.0.1:3000/api/public; then
  echo "Il server è già acceso a mano: premi Ctrl+C dov'è aperto e rilancia questo script."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array>
<string>$NODE</string><string>--disable-warning=ExperimentalWarning</string><string>dist/apps/server/src/web.js</string>
</array>
<key>WorkingDirectory</key><string>$DIR</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$LOG</string>
<key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PLISTEOF

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
sleep 3
if curl -s -o /dev/null --max-time 3 http://127.0.0.1:3000/api/public; then
  echo "Fatto: AI Bridge è acceso e partirà da solo a ogni accensione."
else
  echo "Non risponde. Ultime righe del registro:"; tail -n 15 "$LOG" 2>/dev/null || true
  exit 1
fi
