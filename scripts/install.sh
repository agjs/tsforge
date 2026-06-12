#!/usr/bin/env bash
# Install tsforge CLI — https://tsforge.dev
#
# Usage:
#   curl -fsSL https://tsforge.dev/install.sh | bash
#
# Environment:
#   TSFORGE_REF=main|v0.1.0     git ref when installing from GitHub (default: main)
#   TSFORGE_LIB=~/.local/share/tsforge   clone location for git install
#   TSFORGE_REPO=https://github.com/agjs/tsforge.git
#   BUN_INSTALL=~/.bun          Bun install root (installed automatically if missing)

set -euo pipefail

TSFORGE_REPO="${TSFORGE_REPO:-https://github.com/agjs/tsforge.git}"
TSFORGE_REF="${TSFORGE_REF:-main}"
TSFORGE_LIB="${TSFORGE_LIB:-${HOME}/.local/share/tsforge}"

info() {
  printf '==> %s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return 0
  fi

  info "Bun not found. Installing Bun (tsforge requires Bun >= 1.3.14)..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-${HOME}/.bun}"
  export PATH="${BUN_INSTALL}/bin:${PATH}"

  if ! command -v bun >/dev/null 2>&1; then
    echo "error: Bun install finished but bun is not on PATH." >&2
    echo "Add ${BUN_INSTALL}/bin to your PATH and re-run this script." >&2
    exit 1
  fi
}

install_from_npm() {
  info "Trying npm registry (bun install -g tsforge)..."
  if bun install -g tsforge@latest; then
    info "Installed tsforge from npm."
    print_done
    return 0
  fi
  return 1
}

install_from_git() {
  info "Installing tsforge from ${TSFORGE_REPO} (${TSFORGE_REF})..."

  mkdir -p "$(dirname "${TSFORGE_LIB}")"

  if [ -d "${TSFORGE_LIB}/.git" ]; then
    git -C "${TSFORGE_LIB}" fetch --depth 1 origin "${TSFORGE_REF}"
    git -C "${TSFORGE_LIB}" reset --hard FETCH_HEAD
  else
    rm -rf "${TSFORGE_LIB}"
    git clone --depth 1 --branch "${TSFORGE_REF}" "${TSFORGE_REPO}" "${TSFORGE_LIB}"
  fi

  (
    cd "${TSFORGE_LIB}/packages/core"
    bun install
    bun link --global
  )

  info "Linked tsforge globally from ${TSFORGE_LIB}/packages/core"
}

print_done() {
  cat <<EOF

tsforge is installed.

  tsforge --help          show flags
  tsforge                   interactive session

Configure your model in ~/.tsforge/models.json — see:
  https://tsforge.dev/quickstart/

If \`tsforge\` is not found, add Bun's global bin dir to PATH:

  export PATH="\$(bun pm bin -g):\${PATH}"

EOF
}

main() {
  ensure_bun

  if [ "${TSFORGE_INSTALL:-auto}" = "npm" ]; then
    install_from_npm
    exit 0
  fi

  if [ "${TSFORGE_INSTALL:-auto}" = "git" ]; then
    install_from_git
    print_done
    exit 0
  fi

  # auto: prefer npm when the package is published; fall back to git
  if install_from_npm; then
    exit 0
  fi

  warn "npm install failed or tsforge is not published yet; installing from GitHub."
  install_from_git
  print_done
}

main "$@"
