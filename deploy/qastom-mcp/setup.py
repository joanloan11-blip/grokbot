#!/usr/bin/env python3
"""Собирает docker-compose.yml для MCP Маяка и токены доступа.

Секреты лежат в avito/secrets/<кабинет>.env (Client_id, Client_secret, Profile_id)
и moysklad/home/cabinets.json. Токены доступа генерируются один раз.
Ничего секретного не печатает.
"""
import json
import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BROWSER_IMAGE = (
    "mcr.microsoft.com/playwright/mcp@sha256:"
    "690763cbb437ee7233f538a953bb5390bf03791eb5c965b471e59d17a6132fcb"
)  # 0.0.83
AVITO_TOOLS = ",".join([
    # чаты
    "messenger_get_chats_v2", "messenger_get_chat_by_id_v2", "messenger_get_messages_v3",
    "messenger_post_send_message", "messenger_chat_read",
    # объявления и статистика
    "items_get_items_info", "items_get_item_info", "items_post_item_stats_shallow",
    "items_post_item_analytics", "items_post_calls_stats", "items_post_account_spendings",
    "stock_get_stocks_info", "autoload_get_last_completed_report_v3",
    "promotion_get_services_by_items_v1",
    # аккаунт и деньги (только чтение)
    "user_get_user_info_self", "user_get_user_balance", "user_post_operations_history",
    "cpa_balance_info_v3", "tariffs_get_tariff_info",
    # отзывы, звонки, заказы
    "reviews_get_reviews_v1", "reviews_get_ratings_info_v1", "reviews_create_review_answer_v1",
    "calltracking_get_calls", "orders_get_orders",
    # подтверждения и диагностика
    "meta_confirm_action", "meta_cancel_action", "meta_list_pending_actions",
    "meta_health", "meta_auth_status",
])


def token_file(path: Path, key: str) -> str:
    if not path.exists():
        path.write_text(f"{key}={secrets.token_hex(32)}\n")
        os.chmod(path, 0o600)
    return path.read_text().split("=", 1)[1].strip()


def main() -> None:
    secret_dir = ROOT / "avito" / "secrets"
    accounts = sorted(
        p.stem for p in secret_dir.glob("*.env") if not p.stem.endswith(".auth")
    )
    tokens = {"moysklad": token_file(ROOT / "moysklad" / "auth.env", "MCP_BEARER")}
    lines = [
        "# Сгенерировано setup.py. MCP-серверы Маяка: наружу не открыты, только сеть mayak_mcp.",
        "name: mayak-mcp",
        "networks:",
        "  mcp:",
        "    name: mayak_mcp",
        "  browser:",
        "    name: mayak_browser",
        "services:",
        # Браузер для агентов: headless Chromium (Playwright MCP). Отдельная сеть —
        # из него не видно МойСклад и Авито с их токенами.
        "  browser:",
        f"    image: {BROWSER_IMAGE}",
        "    restart: unless-stopped",
        "    command: [--port, '8931', --host, 0.0.0.0, --allowed-hosts, '*', --isolated,",
        "              --image-responses, omit, --idle-timeout, '600000', --viewport-size, 1366x900,",
        "              --output-dir, /tmp/out, --output-max-size, '50000000']",
        "    networks: [browser]",
        "    mem_limit: 1g",
        "    shm_size: 512m",
        "  moysklad:",
        "    image: mayak-moysklad-mcp",
        "    pull_policy: never",
        "    restart: unless-stopped",
        "    env_file: [moysklad/auth.env]",
        f'    user: "{os.getuid()}:{os.getgid()}"',
        "    volumes: [./moysklad/home:/data]",
        "    networks: [mcp]",
        "    mem_limit: 256m",
    ]
    for account in accounts:
        name = f"avito-{account}"
        tokens[name] = token_file(
            secret_dir / f"{account}.auth.env", "AVITO_MCP_HTTP_AUTH_TOKEN"
        )
        lines += [
            f"  {name}:",
            "    image: mayak-avito-mcp",
            "    pull_policy: never",
            "    restart: unless-stopped",
            f"    env_file: [avito/secrets/{account}.env, avito/secrets/{account}.auth.env]",
            "    environment:",
            "      AVITO_MCP_TRANSPORT: http",
            "      AVITO_MCP_HTTP_HOST: 0.0.0.0",
            '      AVITO_MCP_HTTP_PORT: "3000"',
            "      AVITO_MCP_HTTP_AUTH: bearer",
            f"      AVITO_MCP_HTTP_PUBLIC_URL: http://{name}:3000",
            "      AVITO_MCP_MODE: full_access",
            f"      AVITO_MCP_ALLOW_TOOLS: {AVITO_TOOLS}",
            "      LOG_LEVEL: warn",
            f"    volumes: [{name}-state:/home/node/.local/state]",
            "    networks: [mcp]",
            "    mem_limit: 256m",
        ]
    lines.append("volumes:")
    lines += [f"  avito-{a}-state:" for a in accounts]
    (ROOT / "docker-compose.yml").write_text("\n".join(lines) + "\n")
    # Для регистрации в Маяке (файл 600, читает только register).
    servers = {
        "moysklad": {"url": "http://moysklad:8000/mcp", "token": tokens["moysklad"]},
        "browser": {"url": "http://browser:8931/mcp", "token": ""},
    }
    for account in accounts:
        name = f"avito-{account}"
        servers[name] = {"url": f"http://{name}:3000/mcp", "token": tokens[name]}
    out = ROOT / "servers.json"
    out.write_text(json.dumps(servers))
    os.chmod(out, 0o600)
    print("accounts:", ", ".join(accounts))


if __name__ == "__main__":
    main()
