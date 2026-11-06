FROM python:3.12-slim
RUN pip install --no-cache-dir "moysklad-mcp-ru==0.2.0" "uvicorn>=0.30" \
 && useradd -m -u 10001 app && mkdir -p /data && chown app /data
COPY run.py /app/run.py
USER app
ENV MOYSKLAD_MCP_HOME=/data PYTHONUNBUFFERED=1
CMD ["python", "/app/run.py"]
