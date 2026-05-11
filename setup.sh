#!/usr/bin/env bash
set -eu

echo "=== HASH256 Vast.ai bootstrap ==="

if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; else SUDO=""; fi

$SUDO apt-get update -qq
$SUDO apt-get install -y -qq curl git build-essential ocl-icd-opencl-dev clinfo jq

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - >/dev/null 2>&1
  $SUDO apt-get install -y -qq nodejs
fi

$SUDO mkdir -p /etc/OpenCL/vendors
echo 'libnvidia-opencl.so.1' | $SUDO tee /etc/OpenCL/vendors/nvidia.icd >/dev/null

echo ""
echo "--- Verify OpenCL can see GPU ---"
clinfo -l || { echo "FATAL: OpenCL ga nemu GPU. Restart instance / cek driver."; exit 1; }

WORK_DIR="${WORK_DIR:-$HOME/hash256}"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

if [ ! -d "hash256-mine/.git" ]; then
  rm -rf hash256-mine
  git clone --depth 1 https://github.com/mrfunntastiic/hash256-mine.git
fi

cd hash256-mine
npm install --no-audit --no-fund --silent
sh scripts/build-opencl.sh
test -x bin/hash256-opencl || { echo "FATAL: miner binary ga ke-build"; exit 1; }

cd "$WORK_DIR"

if [ ! -f "package.json" ]; then
  cat > package.json <<'JSON'
{
  "name": "hash256-auto",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node orchestrator.js",
    "bench": "node bench.js",
    "test-swap": "node test-swap.js",
    "swap-once": "node swap.js"
  },
  "dependencies": {
    "dotenv": "^16.4.7",
    "ethers": "^6.13.5"
  }
}
JSON
  npm install --no-audit --no-fund --silent
fi

echo ""
echo "=== Bootstrap selesai ==="
echo ""
echo "=== WORKFLOW ==="
echo ""
echo "OPSI A: DRY-RUN (NO ETH, NO WALLET NEEDED)"
echo "  cd $WORK_DIR"
echo "  npm run bench           # hashrate benchmark 60 detik, no wallet needed"
echo "  # Output kasih lo: real GH/s + projected ROI + decision guidance"
echo ""
echo "OPSI B: PRODUCTION (butuh wallet + ETH)"
echo "  cd $WORK_DIR"
echo "  cp .env.example .env"
echo "  nano .env               # isi PRIVATE_KEY burner"
echo "  npm run test-swap       # validate swap routing (butuh 1+ HASH di wallet)"
echo "  npm start               # launch miner + auto-sell + guardian"
echo ""
echo "RECOMMENDED: run Opsi A dulu buat measure real hashrate GPU lo."
