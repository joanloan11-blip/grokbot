"""moysklad-mcp-ru по Streamable HTTP для Маяка: только внутри сети mayak_mcp, с Bearer-токеном.

Запись в МойСклад выключена: MOYSKLAD_ALLOW_WRITE не задан.
"""
import hmac
import os

import uvicorn
from starlette.responses import PlainTextResponse

from moysklad_mcp.server import mcp

TOKEN = os.environ["MCP_BEARER"]

# FastMCP включает защиту от DNS-rebinding для 127.0.0.1; здесь хост — имя контейнера.
try:
    from mcp.server.transport_security import TransportSecuritySettings

    mcp.settings.transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=False
    )
except ImportError:
    pass

inner = mcp.streamable_http_app()


async def app(scope, receive, send):
    if scope["type"] == "http":
        if scope.get("path") == "/healthz":
            await PlainTextResponse("ok")(scope, receive, send)
            return
        header = dict(scope["headers"]).get(b"authorization", b"").decode()
        if not hmac.compare_digest(header, f"Bearer {TOKEN}"):
            await PlainTextResponse("unauthorized", 401)(scope, receive, send)
            return
    await inner(scope, receive, send)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning")
