#!/usr/bin/env bash
set -eu

REPO_URL="${REPO_URL:-https://github.com/nopperabbo/hash256-auto.git}"
WORK_DIR="${WORK_DIR:-$HOME/hash256-auto}"

cat <<'BANNER'
╔══════════════════════════════════════════════════╗
║   HASH256 Auto — one-shot bootstrap              ║
║   miner + auto-sell + guardian                   ║
╚══════════════════════════════════════════════════╝
BANNER

if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; else SUDO=""; fi

$SUDO apt-get update -qq
$SUDO apt-get install -y -qq git curl

if [ -d "$WORK_DIR/.git" ]; then
  echo "[*] existing checkout detected, pulling latest"
  cd "$WORK_DIR" && git pull --ff-only
else
  echo "[*] cloning $REPO_URL"
  git clone --depth 1 "$REPO_URL" "$WORK_DIR"
  cd "$WORK_DIR"
fi

echo "[*] running setup.sh"
bash setup.sh

echo ""
echo "═══════════════════════════════════════════════════"
echo " BOOTSTRAP DONE"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Next (copy-paste):"
echo ""
echo "  cd $WORK_DIR"
echo "  npm run bench            # FREE benchmark, 60s, no wallet"
echo ""
echo "If benchmark OK, lanjut:"
echo ""
echo "  cp .env.example .env"
echo "  nano .env                # paste PRIVATE_KEY"
echo "  npm start                # launch full automation"
echo ""
