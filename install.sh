#!/usr/bin/env bash
# Download the latest Simple Trace .vsix from GitHub Releases and install it
# into VSCode or Cursor, whichever one this terminal belongs to.
#
# Usage:
#   ./install.sh              # install latest release
#   ./install.sh v0.1.0       # install a specific tag
#   EDITOR_CMD=code ./install.sh    # force VSCode (or cursor, code-insiders, ...)
#   REPO=owner/fork ./install.sh   # override the source repo
#
# Or as a one-liner:
#   curl -fsSL https://raw.githubusercontent.com/ryanswann-amd/SimpleTrace/main/install.sh | bash

set -euo pipefail

REPO="${REPO:-ryanswann-amd/SimpleTrace}"
TAG="${1:-latest}"

# pick an editor CLI. EDITOR_CMD wins; otherwise prefer the editor whose
# integrated terminal we are running in, then cursor, then code. A candidate
# only counts if `--version` prints a bare version number, as editor CLIs do.
# That skips stand-ins on PATH that cannot install extensions: Cursor's
# agent-only `cursor` shim (fails) and the standalone VSCode tunnel CLI
# (prints "code 1.x (commit ...)", then refuses --install-extension yet exits 0).
works() {
  command -v "$1" >/dev/null 2>&1 || return 1
  "$1" --version 2>/dev/null | head -n1 | grep -qE '^[0-9]+\.' || return 1
}

host_editor() {
  [[ -n "${VSCODE_IPC_HOOK_CLI:-}" || "${TERM_PROGRAM:-}" == vscode ]] || return 0
  # Cursor also reports TERM_PROGRAM=vscode; tell them apart by install path
  case "${VSCODE_GIT_ASKPASS_NODE:-}${GIT_ASKPASS:-}" in
    *[Cc]ursor*) echo cursor ;;
    *) echo code ;;
  esac
}

# Over Remote-SSH with no editor window attached (e.g. inside tmux) the
# remote-cli wrappers can't reach an editor, but the server binary can still
# install straight into its extensions directory.
server_cli() {
  local p
  for p in ~/.vscode-server/cli/servers/*/server/bin/code-server \
           ~/.vscode-server/bin/*/bin/code-server \
           ~/.cursor-server/bin/linux-x64/*/bin/cursor-server \
           ~/.cursor-server/bin/*/bin/cursor-server; do
    if [[ -x "$p" ]]; then echo "$p"; fi
  done | xargs -r ls -t 2>/dev/null | head -n1 || true
}

EDITOR_CMD="${EDITOR_CMD:-}"
if [[ -z "$EDITOR_CMD" ]]; then
  for c in $(host_editor) cursor code; do
    if works "$c"; then EDITOR_CMD="$c"; break; fi
  done
fi
if [[ -z "$EDITOR_CMD" ]]; then
  EDITOR_CMD="$(server_cli)"
fi
if [[ -z "$EDITOR_CMD" ]]; then
  echo "error: no working 'cursor' or 'code' CLI found. Set EDITOR_CMD." >&2
  exit 1
fi

# resolve the .vsix download URL from the GitHub API
if [[ "$TAG" == "latest" ]]; then
  API="https://api.github.com/repos/$REPO/releases/latest"
else
  API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
fi

echo ">> looking up $TAG release of $REPO ..."
URL="$(curl -fsSL "$API" \
  | grep -o '"browser_download_url": *"[^"]*\.vsix"' \
  | head -n1 \
  | sed 's/.*"browser_download_url": *"\([^"]*\)"/\1/')"

if [[ -z "$URL" ]]; then
  echo "error: no .vsix asset found in $TAG release of $REPO" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
VSIX="$TMP/simple-trace.vsix"

echo ">> downloading $URL"
curl -fsSL "$URL" -o "$VSIX"

echo ">> installing with '$EDITOR_CMD --install-extension'"
"$EDITOR_CMD" --install-extension "$VSIX"

echo ">> done. Reload the window (Developer: Reload Window) to activate."
