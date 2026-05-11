#!/usr/bin/env bash
set -eu

echo "╔══════════════════════════════════════════════════╗"
echo "║   HASH256 setup — diagnostic + install           ║"
echo "╚══════════════════════════════════════════════════╝"

if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; else SUDO=""; fi

echo ""
echo "─── [0/6] Pre-flight diagnostic ───"

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "❌ nvidia-smi not found. Kemungkinan image yang lo pilih BUKAN NVIDIA CUDA image."
  echo "   Fix: destroy instance ini, pilih template dengan image:"
  echo "        nvidia/cuda:12.2.2-base-ubuntu22.04"
  echo "        atau vastai/pytorch:latest"
  exit 1
fi

echo "✓ nvidia-smi available"
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader | head -8
echo ""

DRIVER_VERSION=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | cut -d'.' -f1)
if [ "$DRIVER_VERSION" -lt 525 ]; then
  echo "⚠️  WARNING: driver version $DRIVER_VERSION < 525. OpenCL ICD mungkin bermasalah."
  echo "   Lanjut bisa, tapi kalau gagal di step [5/6], destroy dan pilih host dengan driver lebih baru."
fi

echo ""
echo "─── [1/6] Install apt packages ───"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq curl git build-essential ocl-icd-opencl-dev clinfo jq ca-certificates

echo "✓ apt packages installed"

echo ""
echo "─── [2/6] Install Node.js 20 ───"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - >/dev/null 2>&1
  $SUDO apt-get install -y -qq nodejs
fi
echo "✓ node $(node --version) / npm $(npm --version)"

echo ""
echo "─── [3/6] Register NVIDIA OpenCL ICD ───"
$SUDO mkdir -p /etc/OpenCL/vendors
echo 'libnvidia-opencl.so.1' | $SUDO tee /etc/OpenCL/vendors/nvidia.icd >/dev/null

echo ""
echo "─── [4/6] Verify OpenCL can enumerate GPU ───"
if ! clinfo -l 2>&1 | grep -qi nvidia; then
  echo "❌ OpenCL ga nemu NVIDIA GPU."
  echo ""
  echo "Diagnostic output:"
  clinfo -l 2>&1 || true
  echo ""
  echo "--- ICD files registered ---"
  ls -la /etc/OpenCL/vendors/ 2>&1 || true
  echo ""
  echo "--- Available NVIDIA OpenCL libs ---"
  find / -name 'libnvidia-opencl*' 2>/dev/null | head -5 || true
  echo ""
  echo "Troubleshoot:"
  echo "  1. Kalau 'no platforms' → driver container ga nge-mount /usr/lib/x86_64-linux-gnu/libnvidia-opencl.so.1"
  echo "     Destroy + pilih host dengan driver NVIDIA proper di bare-metal."
  echo "  2. Kalau 'no devices found' → restart container via Vast.ai UI, atau destroy dan pilih host lain."
  exit 1
fi
echo "✓ OpenCL sees GPU:"
clinfo -l | grep -i "device\|platform" | head -10

WORK_DIR="${WORK_DIR:-$HOME/hash256}"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

echo ""
echo "─── [5/6] Clone & build miner ───"
if [ ! -d "hash256-mine/.git" ]; then
  rm -rf hash256-mine
  git clone --depth 1 https://github.com/mrfunntastiic/hash256-mine.git
fi

cd hash256-mine
npm install --no-audit --no-fund --silent

if ! sh scripts/build-opencl.sh 2>&1; then
  echo "❌ OpenCL miner compile failed."
  echo "   Ini biasanya karena missing -lOpenCL linker."
  echo "   Cek:"
  ls /usr/lib/x86_64-linux-gnu/libOpenCL* 2>&1 || echo "   libOpenCL ga ada"
  exit 1
fi

test -x bin/hash256-opencl || { echo "❌ miner binary ga ada setelah build"; exit 1; }
echo "✓ miner binary built: $(file bin/hash256-opencl | cut -d: -f2)"

cd "$WORK_DIR"

echo ""
echo "─── [6/6] Install orchestrator deps ───"
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
fi
npm install --no-audit --no-fund --silent
echo "✓ orchestrator deps ready"

cat <<EOF

╔══════════════════════════════════════════════════╗
║   ✅ SETUP COMPLETE                              ║
╚══════════════════════════════════════════════════╝

NEXT STEP (pick one):

  📊 OPSI A: DRY-RUN (gratis, no wallet)
     cd $WORK_DIR
     npm run bench
     # Ukur hashrate real GPU + projected ROI

  💰 OPSI B: PRODUCTION (butuh ETH + wallet)
     cd $WORK_DIR
     cp .env.example .env
     nano .env              # isi PRIVATE_KEY burner
     npm start              # miner + auto-sell + guardian

RECOMMEND: OPSI A DULU. Bench data nentuin lo lanjut atau stop.
EOF
