#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 machine for the single-machine pilot.
# Run as root:   bash server-setup.sh
# Safe to run twice. It installs Docker and the Postgres client (for backups), opens
# only the ports the product needs, and creates /opt/workspace-video.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo bash server-setup.sh)" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl ufw postgresql-client unattended-upgrades

if ! command -v docker >/dev/null; then
  # Docker's own install script (https://get.docker.com); review it first if you prefer.
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
fi

# Firewall: default deny in, then only what the product uses.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'ssh'
ufw allow 80/tcp comment 'http (certificate + redirect)'
ufw allow 443/tcp comment 'https'
ufw allow 443/udp comment 'http3'
ufw allow 7881/tcp comment 'livekit media over tcp'
ufw allow 50000:60000/udp comment 'livekit media over udp'
ufw --force enable

# The database is reached by the containers and by the deploy script's backup under
# the same name.
grep -q 'host.docker.internal' /etc/hosts || echo '127.0.0.1 host.docker.internal' >> /etc/hosts

mkdir -p /opt/workspace-video/backups
chmod 700 /opt/workspace-video/backups

echo
echo "Done. Next: copy deploy/ to /opt/workspace-video, create .env (chmod 600), and deploy."
ufw status verbose
