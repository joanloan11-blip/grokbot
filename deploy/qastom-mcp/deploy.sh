#!/usr/bin/env bash
# Поднимает MCP Маяка (МойСклад, Авито) и подключает их и amoCRM к Маяку. Секреты не печатает.
set -euo pipefail
cd "$(dirname "$0")"
chmod 700 avito/secrets moysklad/home; chmod 600 avito/secrets/* moysklad/home/* 2>/dev/null || true
python3 setup.py
docker build -q -t mayak-moysklad-mcp moysklad
docker build -q -t mayak-avito-mcp avito
docker compose up -d --remove-orphans
