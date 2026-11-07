#!/bin/sh
set -e
mkdir -p /root/.ssh
cp /key/id_relay /root/.ssh/id_relay
chmod 600 /root/.ssh/id_relay
cat > /root/.ssh/config <<CONF
Host *
  StrictHostKeyChecking accept-new
  UserKnownHostsFile /root/.ssh/known_hosts
  ServerAliveInterval 30
  ServerAliveCountMax 3
  ExitOnForwardFailure yes
  ConnectTimeout 15
  PreferredAuthentications publickey
  PasswordAuthentication no
CONF
chmod 600 /root/.ssh/config
echo "relay: подключаюсь к $RELAY_HOST"
exec ssh -N -D 0.0.0.0:1080 -i /root/.ssh/id_relay "root@$RELAY_HOST"
