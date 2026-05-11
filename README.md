# HASH256 Auto Miner untuk Vast.ai

Full automation: miner + auto-sell HASH→ETH + guardian (gas/price/loss stop).

**Dua mode eksekusi:**
- 🧪 **DRY-RUN** (`npm run bench`) — hashrate benchmark tanpa wallet, tanpa ETH. Cocok buat test infrastructure + kalibrasi GPU.
- 🚀 **PRODUCTION** (`npm start`) — full miner + auto-sell. Butuh wallet burner + 0.015 ETH.

## Kenapa butuh ETH di production mode?

HASH256 arsitekturnya on-chain PoW Ethereum:
- GPU lo bisa compute keccak256 tanpa wallet (gratis)
- Tapi setelah nemu solusi, miner HARUS submit `contract.mine(nonce)` ke Ethereum mainnet
- Setiap `mine()` call = transaction = **butuh ETH untuk gas (~$2.34/TX)**
- Bukan pilihan — whitepaper confirms, kontrak ABI confirms (ga ada sponsored / meta-tx variant)

Di browser miner hash256.org lo "ga perlu ETH" karena:
- Browser ~2 MH/s, difficulty sekarang 2^44
- Expected time nemu 1 solusi di browser: **~100 hari**
- Lo cuma run 5-30 menit = **ga pernah nemu = ga pernah submit = ga pernah bayar gas**
- Di GPU 4x RTX 5090, lo bakal nemu solusi tiap ~6 menit = 10 TX/jam = **pasti butuh ETH**

## Arsitektur

```
orchestrator.js
  ├─ spawn child: hash256-mine/miner.js (OpenCL miner)
  └─ loop setiap SWAP_POLL_SEC:
       ├─ baca basefee, HASH price, ETH price
       ├─ cek stop conditions (basefee/price/runtime/loss)
       ├─ kalau HASH balance >= SELL_MIN_HASH → swap ke ETH via KyberSwap
       └─ log ke ./logs/*.log
```

Kalau kondisi STOP kena, orchestrator kill miner + auto-swap sisa HASH + exit clean.

## Stop conditions (auto-exit)

| Trigger | Default | Env var |
|---|---|---|
| Basefee > X gwei | 3 | `MAX_BASEFEE_GWEI` |
| HASH price < $X | 0.08 | `MIN_HASH_USD` |
| Runtime > X menit | 480 (8h) | `MAX_RUNTIME_MIN` |
| Loss > $X | 40 | `STOP_ON_LOSS_USD` |

## 1. Setup di Vast.ai

### Pilih instance

- Rekomendasi berdasarkan diskusi: **4x RTX 5090** ($1.607/hr) atau **1x H100 SXM France** ($1.472/hr)
- Template: **Nvidia CUDA (Ubuntu 22.04)** atau image dengan `nvidia-smi` working
- Disk: minimum 20 GB (cukup buat Node + miner)
- Buka SSH port; lo bakal jalanin via terminal

### SSH + bootstrap

```bash
ssh root@<vast-host> -p <port>

# upload file dari laptop lo via scp (di laptop):
# scp -P <port> -r /path/to/hash256-vast-auto/ root@<vast-host>:/root/

cd /root/hash256-vast-auto
chmod +x setup.sh
./setup.sh
```

Script `setup.sh` akan:
1. Install Node 20, build tools, OpenCL headers, clinfo, jq
2. Register NVIDIA OpenCL ICD (agar GPU kedetect)
3. Verify `clinfo -l` menampilkan GPU lo
4. Clone + build `mrfunntastiic/hash256-mine` (OpenCL miner binary)
5. Setup `package.json` + install `ethers` + `dotenv`

Kalau `clinfo -l` kosong setelah setup → FATAL. Biasanya driver mismatch; pilih instance lain.

## 2A. DRY-RUN: Hashrate benchmark (NO WALLET, NO ETH)

**Lakukan ini DULU sebelum fund wallet.** 60 detik, gratis, validate semua:

```bash
cd ~/hash256
npm run bench
```

Output bakal kasih lo:
- Hashrate real GPU lo dalam GH/s
- Projection: waktu per solution di difficulty sekarang
- ROI projection @ HASH=$0.22: berapa $/jam untuk win rate 25%/50%/70%/100%
- Decision guidance: lanjut production atau ganti instance

Contoh output:
```
[...] Hashrate avg: 12.847 GH/s
[...] Expected time per solution (solo): 22.83 min
[...] Solutions per hour (solo): 2.63
[...] Win 50%: revenue=$28.93/hr  gas=$6.15/hr  net=$22.78/hr
```

Kalau hashrate < expected (misal 4x 5090 cuma 20 GH/s padahal estimasi 50 GH/s):
- Cek `nvidia-smi` → ada semua GPU ter-detect?
- Cek OpenCL: miner cuma pake 1 GPU default (single-device). Multi-GPU butuh spawn parallel instances. Lihat section "Multi-GPU scaling" di bawah.

## 2B. PRODUCTION: Isi `.env` (butuh ETH)

```bash
cp .env.example .env
nano .env
```

WAJIB: `PRIVATE_KEY` harus wallet **BURNER**. Jangan pernah pakai wallet utama.

```env
RPC_URL=https://ethereum-rpc.publicnode.com
PRIVATE_KEY=0xBURNER_PRIVATE_KEY
PRIORITY_FEE_GWEI=2
GPU_BATCH_SIZE=67108864

AUTO_SELL=true
SELL_MIN_HASH=50           # swap HASH ke ETH tiap akumulasi 50 HASH
SELL_SLIPPAGE_BPS=200      # 2% slippage
SWAP_POLL_SEC=60           # guardian tick interval

MAX_BASEFEE_GWEI=3         # stop kalau gas > 3 gwei
MIN_HASH_USD=0.08          # stop kalau HASH price < $0.08
MAX_RUNTIME_MIN=480        # stop after 8 jam
STOP_ON_LOSS_USD=40        # stop kalau rugi > $40 USD
```

### Top up burner wallet

Kirim ~**0.015 ETH** (~$52) ke burner wallet. Ini buat:
- Gas miner submit TX (`mine()`): ~0.0007 ETH per submit
- Gas approve HASH (one-time, ~0.001 ETH)
- Gas swap HASH→ETH (~0.002 ETH per swap)

## 3. Test swap (penting, jalankan SEBELUM production)

```bash
npm run test-swap
```

Output:
- Tampilkan ETH + HASH balance
- Kalau HASH balance > 1: dry-run route via KyberSwap, tampilkan rate
- Tanpa `--execute`: cuma simulasi
- Dengan `--execute`: eksekusi real swap 1 HASH → ETH

**Test dulu dengan `--execute` sebelum production** buat validate approval flow + router address correct:

```bash
npm run test-swap -- --execute
```

Verify di Etherscan: TX sukses, balance HASH berkurang 1, balance ETH nambah sedikit.

## 4. Launch production

```bash
mkdir -p logs
npm start 2>&1 | tee logs/run.log
```

Atau biar tetap jalan setelah SSH disconnect, pakai `tmux`:

```bash
apt-get install -y tmux
tmux new -s hash
npm start 2>&1 | tee logs/run.log
# detach: Ctrl-B lalu D
# reattach: tmux attach -t hash
```

## 5. Monitor

```bash
tail -f logs/guardian.log
tail -f logs/miner.log
tail -f logs/swap.log
```

Orchestrator log tiap menit: elapsed, basefee, HASH price, approx PnL, balance.

### Contoh log sukses

```
[...] [main] spawning miner: node miner.js --backend opencl
[...] opencl 8.2 GH/s | 8389152b hashes
[...] FOUND via opencl
[...] TX sent: 0xabcd...
[...] Success block: 25070123
[...] [main] tick elapsed=5.2m basefee=0.134gw hash=$0.2134 pnl≈$12.45 hashBal=100.0
[...] [main] autosell trigger: 100 HASH >= 50
[...] routing: 100.0 HASH -> ETH
[...] swap tx sent: 0xefgh...
[...] swap SUCCESS block 25070140, expected 0.0061 ETH
```

## 6. Manual stop

```bash
# kalau running di foreground: Ctrl-C
# tmux: tmux attach -t hash → Ctrl-C
# force: pkill -f orchestrator
```

Orchestrator handle SIGINT clean: kill miner → final swap sisa HASH → exit.

## Troubleshooting

**`clinfo -l` kosong** → OpenCL ga nemu GPU. Restart instance atau pilih host lain.

**`OpenCL miner belum dibuild`** → re-run `sh scripts/build-opencl.sh` di `~/hash256/hash256-mine/`.

**`insufficient funds`** di miner log → ETH wallet kering. Top up lagi.

**`execution reverted InsufficientWork`** → lo kalah race. Normal; guardian akan track ratio. Kalau > 70% revert, naikin `PRIORITY_FEE_GWEI` jadi 3-5.

**Swap gagal `route failed`** → KyberSwap belum route HASH. Cek Uniswap pool manually, atau coba 1inch/OKX aggregator (butuh modif `swap.js`).

**Guardian shutdown `basefee > 3 gwei`** → gas Ethereum naik. Normal, tunggu turun dulu sebelum restart.

**Bench nunjukin hashrate cuma 1 GPU padahal rent 4x** → Default miner single-device. Lihat "Multi-GPU scaling" di bawah.

## Multi-GPU scaling

Miner binary (`hash256-opencl`) default cuma pake 1 OpenCL device (GPU pertama yang ke-detect). Buat rent 4x 5090 atau 2x 4090 maksimalin utilisasi, ada 2 opsi:

### Opsi 1: Spawn multiple miner instance (simplest)

Tiap GPU = 1 process. Butuh env `CUDA_VISIBLE_DEVICES` per instance:

```bash
CUDA_VISIBLE_DEVICES=0 node ~/hash256/hash256-mine/miner.js --backend opencl &
CUDA_VISIBLE_DEVICES=1 node ~/hash256/hash256-mine/miner.js --backend opencl &
CUDA_VISIBLE_DEVICES=2 node ~/hash256/hash256-mine/miner.js --backend opencl &
CUDA_VISIBLE_DEVICES=3 node ~/hash256/hash256-mine/miner.js --backend opencl &
wait
```

⚠️ Tapi semua pake wallet yang sama = challenge yang sama = all 4 solve same problem = cuma 1 yang bakal submit successfully, 3 lainnya wasted compute.

### Opsi 2: Multi-wallet, multi-instance (recommended untuk 4x GPU)

Generate 4 burner wallet, tiap GPU pake wallet berbeda:

```bash
# butuh modifikasi orchestrator.js buat handle multi-wallet
# ini advanced feature; buat sekarang, better rent 1x 5090 dulu
# dan scale horizontal kalau strategy terbukti profitable
```

### Rekomendasi realistic

- **1x H100 SXM** = simplest, 1 wallet, ga ada issue scaling
- **1x RTX 5090** = cheap entry, 1 wallet, easy
- **2x/4x RTX 5090/4090** = lo butuh setup multi-wallet (complex), atau accept cuma 1 GPU yang kepake (wasted)

Untuk test awal: **pilih single-GPU instance**. Kalau profit terbukti, baru plan multi-instance deployment di shift berikutnya.

## Ekonomi (rekap)

Dengan 4x RTX 5090 + HASH $0.22 + gas 0.13 gwei:

| Win rate | Net/jam | 8h profit |
|---|---|---|
| 80% | +$112 | **+$900** |
| 50% | +$65 | +$520 |
| 25% | +$20 | +$160 |
| 10% (BE) | $0 | $0 |

Expected value realistic: **+$200-600 per 8h shift**.

## Safety

- Private key DI .env doang, jangan commit
- Burner wallet wajib, jangan main wallet utama
- `.gitignore` tambahin `.env` dan `logs/`
- Stop-loss $40 default; adjust `STOP_ON_LOSS_USD` kalau mau lebih agresif
- Pool liquidity cuma $200K: sekali swap > $10k bisa hit slippage > 5%. `SELL_MIN_HASH=50` = ~$11 per swap, aman.

## Roadmap opsional

- [ ] Monitor TX success/revert rate real-time → kalau > 70% revert, auto-naikin priority fee
- [ ] Multi-RPC rotate (publicnode + llamarpc + alchemy)
- [ ] Flashbots bundle untuk lebih kompetitif
- [ ] Discord/Telegram webhook alert
