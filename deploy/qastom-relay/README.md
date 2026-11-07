# LLM-relay (qastom → steerflow-vps)

SOCKS5 через SSH-туннель. Нужен, потому что внешний HTTP-прокси обрывал тела
запросов больше ~30 КБ, а прямой доступ к api.openai.com из России закрыт.

- Контейнер `mayak-llm-relay` живёт только в сети `mayak_default`, портов наружу
  не публикует; приложение ходит в него как `socks5://llm-relay:1080`.
- Ключ `/home/rus/.ssh/mayak-relay` смонтирован только на чтение; на сервере
  tunnel он ограничен `from="217.197.114.108,217.197.114.115"`, без pty.
- Перезапуск: `docker compose -p mayak-relay up -d --build` из этого каталога.
