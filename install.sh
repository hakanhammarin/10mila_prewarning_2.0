#!/usr/bin/env bash
# Install Prewarning as a systemd service on Ubuntu 24.04 LTS.
#
#   sudo ./install.sh
#
# Idempotent: re-running upgrades the deployed code in /opt/prewarning and
# restarts the service. Config in /etc/prewarning/config.yml is preserved.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "install.sh must be run as root (try: sudo $0)" >&2
  exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/opt/prewarning"
CONF_DIR="/etc/prewarning"
LOG_DIR="/var/log/prewarning"
SERVICE_NAME="prewarning"
SERVICE_USER="prewarning"
NODE_MIN_MAJOR=20

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node is not installed. Install Node.js >= ${NODE_MIN_MAJOR} first."
    echo "Example:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "  sudo apt install -y nodejs"
    exit 1
  fi
  local major
  major=$(node -p 'process.versions.node.split(".")[0]')
  if (( major < NODE_MIN_MAJOR )); then
    echo "Node.js ${major} is too old. Need >= ${NODE_MIN_MAJOR}."
    exit 1
  fi
}

ensure_user() {
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
}

ensure_dirs() {
  install -d -m 0755 "$APP_DIR"
  install -d -m 0755 "$CONF_DIR"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$LOG_DIR"
}

copy_app() {
  echo "Copying application to $APP_DIR"
  rsync -a --delete \
    --exclude=".git" \
    --exclude="node_modules" \
    --exclude="config.yml" \
    --exclude="*.log" \
    "$SRC_DIR/" "$APP_DIR/"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
}

install_deps() {
  echo "Installing npm dependencies (production)"
  sudo -u "$SERVICE_USER" -H bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund"
}

install_config() {
  if [[ ! -f "$CONF_DIR/config.yml" ]]; then
    echo "Installing default config to $CONF_DIR/config.yml"
    install -m 0640 -o root -g "$SERVICE_USER" \
      "$SRC_DIR/config.example.yml" "$CONF_DIR/config.yml"
    echo
    echo "  >>> Edit $CONF_DIR/config.yml and fill in your MySQL details."
    echo
  else
    echo "Existing $CONF_DIR/config.yml preserved."
  fi
}

install_unit() {
  echo "Installing systemd unit"
  install -m 0644 "$SRC_DIR/systemd/prewarning.service" \
    "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}.service"
}

start_service() {
  echo "Restarting ${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}.service"
  sleep 1
  systemctl --no-pager status "${SERVICE_NAME}.service" || true
}

require_node
ensure_user
ensure_dirs
copy_app
install_deps
install_config
install_unit
start_service

cat <<EOF

Prewarning installed.

  Status:  systemctl status ${SERVICE_NAME}
  Logs:    journalctl -u ${SERVICE_NAME} -f
  Config:  ${CONF_DIR}/config.yml
  URL:     http://$(hostname -I | awk '{print $1}'):8080/

EOF
