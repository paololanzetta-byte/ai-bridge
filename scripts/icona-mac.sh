#!/bin/bash
# Mette l'icona giusta dentro l'app "AI Bridge" installata da Chrome (macOS).
# Uso (dalla cartella del progetto):  bash scripts/icona-mac.sh
set -e
cd "$(dirname "$0")/.."
SRC="apps/web/public/icon-macos-1024.png"
APP="$HOME/Applications/Chrome Apps.localized/AI Bridge.app"
[ -f "$SRC" ] || { echo "Manca $SRC: riscarica l'aggiornamento."; exit 1; }
[ -d "$APP" ] || { echo "Non trovo $APP"; exit 1; }
osascript -e 'tell application "AI Bridge" to quit' >/dev/null 2>&1 || true
rm -rf /tmp/ab.iconset && mkdir /tmp/ab.iconset
for p in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x 128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 512:icon_256x256@2x 512:icon_512x512 1024:icon_512x512@2x; do
  s="${p%%:*}"; n="${p#*:}"
  sips -z "$s" "$s" "$SRC" --out "/tmp/ab.iconset/$n.png" >/dev/null
done
iconutil -c icns /tmp/ab.iconset -o /tmp/app.icns
cp /tmp/app.icns "$APP/Contents/Resources/app.icns"
rm -f "$APP/Icon"$'\r'
xattr -cr "$APP"
codesign --force --deep -s - "$APP"
touch "$APP"
killall Dock
echo "Fatto. Riapri AI Bridge."
