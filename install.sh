#!/usr/bin/env bash
# Download the latest Simple Trace .vsix from GitHub Releases and install it
# into Cursor (or VSCode).
#
# Usage:
#   ./install.sh              # install latest release
#   ./install.sh v0.1.0       # install a specific tag
#   EDITOR_CMD=code ./install.sh
#   REPO=owner/fork ./install.sh   # override the source repo
#
# Or as a one-liner:
#   curl -fsSL https://raw.githubusercontent.com/ryanswann-amd/SimpleTrace/main/install.sh | bash

set -euo pipefail

REPO="${REPO:-ryanswann-amd/SimpleTrace}"
TAG="${1:-latest}"

# pick an editor CLI: prefer cursor, then code, unless EDITOR_CMD is set
EDITOR_CMD="${EDITOR_CMD:-}"
if [[ -z "$EDITOR_CMD" ]]; then
  if command -v cursor >/dev/null 2>&1; then EDITOR_CMD=cursor
  elif command -v code >/dev/null 2>&1; then EDITOR_CMD=code
  else
    echo "error: neither 'cursor' nor 'code' found on PATH. Set EDITOR_CMD." >&2
    exit 1
  fi
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
