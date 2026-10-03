#!/usr/bin/env sh
# macOS / Linux: abre el panel del servidor de Scan-bar (un botón para encender y apagar).
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Necesitas Node.js 22 o superior: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install || exit 1
exec npm run servidor
