require("dotenv").config();
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const MINER_DIR = process.env.MINER_DIR || path.resolve(process.env.HOME || ".", "hash256/hash256-mine");
const BINARY = path.join(MINER_DIR, "bin", "hash256-opencl");
const DUMMY_CHALLENGE = "0x0000000000000000000000000000000000000000000000000000000000000001";
const IMPOSSIBLE_DIFFICULTY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const BATCH_SIZE = process.env.GPU_BATCH_SIZE || "67108864";
const DURATION_SEC = parseInt(process.env.BENCH_DURATION_SEC || "60", 10);

const LOG_FILE = process.env.BENCH_LOG || "./logs/bench.log";

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

async function main() {
  if (!fs.existsSync(BINARY)) {
    console.error(`FATAL: miner binary not found at ${BINARY}`);
    console.error("Run setup.sh first to build it");
    process.exit(1);
  }

  log(`=== DRY-RUN BENCHMARK ===`);
  log(`Binary: ${BINARY}`);
  log(`Batch size: ${BATCH_SIZE}`);
  log(`Duration: ${DURATION_SEC}s`);
  log(`Difficulty: IMPOSSIBLE (will never find solution)`);
  log(`Wallet required: NONE`);
  log(`ETH required: ZERO`);
  log(``);

  const samples = [];
  const startTime = Date.now();
  let totalHashes = 0n;

  const proc = spawn(BINARY, [DUMMY_CHALLENGE, IMPOSSIBLE_DIFFICULTY, BATCH_SIZE], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "progress") {
          const hashes = BigInt(msg.hashes);
          const rate = Number(msg.hashrate);
          samples.push({ t: Date.now() - startTime, hashes, rate });
          totalHashes = hashes;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const rateGH = (rate / 1e9).toFixed(3);
          log(`  t=${elapsed}s hashrate=${rateGH} GH/s totalHashes=${hashes.toString()}`);
        }
      } catch {}
    }
  });

  proc.stderr.on("data", (d) => log(`[stderr] ${d.toString().trim()}`));

  const timer = setTimeout(() => {
    log(`\nduration ${DURATION_SEC}s reached, killing miner`);
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 2000);
  }, DURATION_SEC * 1000);

  proc.on("exit", (code, signal) => {
    clearTimeout(timer);
    log(``);
    log(`=== BENCHMARK RESULTS ===`);
    if (samples.length < 2) {
      log(`INSUFFICIENT SAMPLES (got ${samples.length}). Something wrong.`);
      process.exit(1);
    }
    const warmupEnd = samples.findIndex(s => s.t > 5000);
    const stable = warmupEnd > 0 ? samples.slice(warmupEnd) : samples.slice(1);
    const rates = stable.map(s => s.rate);
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    const min = Math.min(...rates);
    const max = Math.max(...rates);
    log(`Samples: ${samples.length} (${stable.length} post-warmup)`);
    log(`Hashrate avg: ${(avg / 1e9).toFixed(3)} GH/s`);
    log(`Hashrate min: ${(min / 1e9).toFixed(3)} GH/s`);
    log(`Hashrate max: ${(max / 1e9).toFixed(3)} GH/s`);
    log(`Total hashes: ${totalHashes.toString()}`);
    log(``);

    const DIFF_LOG2 = 44;
    const expectedHashes = 2 ** DIFF_LOG2;
    const secPerSol = expectedHashes / avg;
    log(`=== PROJECTION (assuming difficulty 2^44 = current) ===`);
    log(`Expected time per solution (solo, no race): ${formatTime(secPerSol)}`);
    log(`Solutions per hour (solo): ${(3600 / secPerSol).toFixed(2)}`);
    log(``);

    const HASH_USD = 0.22;
    const REWARD_HASH = 100;
    const GAS_USD_PER_TX = 2.34;
    const solsPerHr = 3600 / secPerSol;
    const revPerHr = solsPerHr * REWARD_HASH * HASH_USD;
    const gasPerHr = solsPerHr * GAS_USD_PER_TX;
    log(`=== ECONOMICS (HASH=$${HASH_USD}, gas=$${GAS_USD_PER_TX}/tx) ===`);
    for (const winRate of [1.0, 0.7, 0.5, 0.25]) {
      const net = revPerHr * winRate - gasPerHr;
      log(`  Win ${(winRate * 100).toFixed(0)}%: revenue=$${(revPerHr * winRate).toFixed(2)}/hr  gas=$${gasPerHr.toFixed(2)}/hr  net=$${net.toFixed(2)}/hr`);
    }
    log(``);
    log(`=== NEXT STEPS ===`);
    log(`1. Kalau hashrate di atas matches estimasi lo: OK lanjut`);
    log(`2. Fund wallet burner dengan 0.015 ETH (~$52)`);
    log(`3. Edit .env: set DRY_RUN=false, isi PRIVATE_KEY`);
    log(`4. npm start (production mode)`);
    log(``);
    log(`Exit code: ${code} signal: ${signal}`);
    process.exit(0);
  });

  process.on("SIGINT", () => {
    log(`\nSIGINT received, stopping benchmark`);
    proc.kill("SIGINT");
  });
}

function formatTime(secs) {
  if (!Number.isFinite(secs)) return "∞";
  if (secs < 60) return `${secs.toFixed(1)} sec`;
  if (secs < 3600) return `${(secs / 60).toFixed(2)} min`;
  if (secs < 86400) return `${(secs / 3600).toFixed(2)} hours`;
  return `${(secs / 86400).toFixed(2)} days`;
}

main().catch(e => { console.error(e); process.exit(1); });
