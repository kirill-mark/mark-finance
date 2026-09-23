#!/bin/sh
# Собирает index.html (самостоятельная страница) из src/app.html.
# src/app.html — исходник: он же публикуется как артефакт на claude.ai.
set -e
cd "$(dirname "$0")"
SRC=src/app.html
{
  printf '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  awk '{print} /<\/style>/{exit}' "$SRC"
  printf '</head>\n<body>\n'
  awk 'f{print} /<\/style>/{f=1}' "$SRC"
  printf '</body>\n</html>\n'
} > index.html
echo "index.html собран"
