#!/usr/bin/env bash
set -euo pipefail

# Cortex installer
# Usage: curl -fsSL https://github.com/shetty4l/cortex/releases/latest/download/install.sh | bash

SERVICE_NAME="cortex"
REPO="shetty4l/cortex"
INSTALL_BASE="${HOME}/srv/cortex"
DATA_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/cortex"

# --- source shared install functions from @shetty4l/core ---

INSTALL_LIB_URL="https://raw.githubusercontent.com/shetty4l/core/main/scripts/install-lib.sh"

install_lib=$(mktemp)
if ! curl -fsSL -o "$install_lib" "$INSTALL_LIB_URL"; then
  printf '\033[1;31m==>\033[0m %s\n' "Failed to download install-lib.sh from ${INSTALL_LIB_URL}" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$install_lib"
rm -f "$install_lib"

# --- Cortex-specific: data directory ---

setup_data_dir() {
  mkdir -p "$DATA_DIR"

  local config_file="${DATA_DIR}/config.json"
  if [ ! -f "$config_file" ]; then
    cat > "$config_file" <<'CONFIG'
{
  "port": 7751
}
CONFIG
    ok "Default config written to ${config_file}"
  else
    ok "Existing config preserved: ${config_file}"
  fi
}

# --- Cortex-specific: status ---

print_status() {
  local install_dir="${INSTALL_BASE}/latest"
  echo ""
  echo "=========================================="
  ok "Cortex installed successfully!"
  echo "=========================================="
  echo ""
  echo "  Version:    ${RELEASE_TAG}"
  echo "  Install:    ${install_dir}"
  echo "  CLI:        ${BIN_DIR}/cortex"
  echo "  Config:     ${DATA_DIR}/config.json"
  echo ""
  echo "  Start the server:"
  echo "    cortex start"
  echo ""
  echo "  Check health:"
  echo "    cortex health"
  echo ""
}

# --- main ---

main() {
  info "Cortex installer"
  echo ""

  check_prereqs
  fetch_latest_release
  download_and_extract
  update_symlink
  prune_versions
  setup_data_dir
  install_cli
  print_status
}

main "$@"
