#!/usr/bin/env bash
# root-setup.sh — ОДНОРАЗОВАЯ настройка (запускать один раз с sudo на qastom):
#     sudo bash ~/maintenance/root-setup.sh
#
# Что делает (идемпотентно, повторный запуск безопасен):
#   1) ограничивает журнал systemd: SystemMaxUse=500M, SystemMaxFileSize=50M;
#   2) делает разовый vacuum журнала до 300 МБ;
#   3) разрешает пользователю rus запускать БЕЗ ПАРОЛЯ только одну команду —
#      `journalctl --vacuum-size=*` — чтобы ежедневная уборка могла подрезать журнал.
#
# Ничего из приложений не перезапускается; docker не трогается.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Нужен root: sudo bash $0" >&2
  exit 1
fi

echo "== 1. Ограничение журнала systemd =="
install -d -m 755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/99-size-cap.conf <<'EOF'
[Journal]
# Ограничение, чтобы журнал не разрастался и не занимал весь диск.
SystemMaxUse=500M
SystemMaxFileSize=50M
EOF
systemctl restart systemd-journald
echo "   journald перезапущен, лимит 500 МБ"

echo "== 2. Vacuum журнала до 300 МБ =="
journalctl --vacuum-size=300M
journalctl --disk-usage

echo "== 3. Разрешение на vacuum без пароля (только этот фиксированный скрипт) =="
# sudo не допускает wildcard в аргументах команды, поэтому разрешаем вызов
# отдельного root-скрипта с зашитым размером журнала.
cat > /usr/local/sbin/journal-vacuum <<'EOF'
#!/bin/sh
# Разрешено пользователю rus через sudo (см. /etc/sudoers.d/disk-cleanup).
# Подрезает журнал systemd до 300 МБ. Аргументы не принимаются.
exec /usr/bin/journalctl --vacuum-size=300M
EOF
chown root:root /usr/local/sbin/journal-vacuum
chmod 755 /usr/local/sbin/journal-vacuum
cat > /etc/sudoers.d/disk-cleanup <<'EOF'
# Автоматическая уборка диска (disk-cleanup.sh): только vacuum журнала.
rus ALL=(root) NOPASSWD: /usr/local/sbin/journal-vacuum
EOF
chmod 440 /etc/sudoers.d/disk-cleanup
visudo -cf /etc/sudoers.d/disk-cleanup
echo "   /usr/local/sbin/journal-vacuum + /etc/sudoers.d/disk-cleanup установлены"

echo "== Готово =="
df -h /
