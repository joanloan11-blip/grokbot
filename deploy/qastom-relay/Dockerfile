# LLM-relay: SSH-туннель с SOCKS5 на steerflow-vps.
# Нужен, потому что внешний HTTP-прокси обрывает тела больше ~30 КБ,
# а прямой доступ к api.openai.com из России закрыт.
FROM alpine:3.20

RUN apk add --no-cache openssh-client

COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD nc -z 127.0.0.1 1080 || exit 1

ENTRYPOINT ["/entrypoint.sh"]
