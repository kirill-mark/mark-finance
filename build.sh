#!/bin/sh
# Собирает index.html (самостоятельное приложение для GitHub Pages / телефона) из src/app.html.
# src/app.html — исходник: он же публикуется как артефакт на claude.ai.
set -e
cd "$(dirname "$0")"
SRC=src/app.html
{
  cat <<'HEAD'
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="manifest" href="manifest.json">
<link rel="icon" href="icons/icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<meta name="theme-color" content="#14392F">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Finance">
HEAD
  awk '{print} /<\/style>/{exit}' "$SRC"
  printf '</head>\n<body>\n'
  awk 'f{print} /<\/style>/{f=1}' "$SRC"
  cat <<'TAIL'
<script>
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
</script>
</body>
</html>
TAIL
} > index.html
echo "index.html собран"
