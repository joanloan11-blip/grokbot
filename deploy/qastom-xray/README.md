# VLESS-туннель для LLM

Обычные HTTP/SOCKS5-прокси за рубеж рвут запросы больше ~16–30 КБ (DPI). Контейнер `xray`
держит VLESS-соединение и отдаёт SOCKS5 `xray:1080` только внутри сети проекта mayak.

1. Ссылка `vless://…` — в `~/xray/vless.txt` (chmod 600, в git не попадает).
2. `python3 make-config.py ~/xray/vless.txt ~/xray/config.json`
3. Сервис `xray` в `docker-compose.qastom.yml`, `LLM_PROXY_URL=socks5://xray:1080` в `.env`.
