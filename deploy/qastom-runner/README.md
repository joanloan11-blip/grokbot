# Песочница QASTOM AGENT

- `runner` — выполняет команды агентов (`shell`, `run_code`) в их рабочих папках.
  Каждый пользователь работает от своего uid, папки других недоступны (700),
  фоновые процессы убиваются после команды, ulimit на процессы и размер файлов.
  Сеть только внутренняя (`mayak_runner`, internal).
- `egress` — tinyproxy, единственный выход в интернет: npm, PyPI, GitHub (`egress/filter`).

Приложение ходит в runner по `RUNNER_URL` с заголовком `x-runner-token` (`RUNNER_TOKEN` в `.env`).
