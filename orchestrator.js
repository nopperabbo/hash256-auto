require("dotenv").config();
const { spawn } = require("child_process");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { swapHashToEth } = require("./swap");

const HASH_TOKEN = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const GECKO_POOL_URL =
  "https://api.geckoterminal.com/api/v2/networks/eth/pools/0x812db7c84d9ca01b17c1f68837e8b55736593744d19270e9b3e4611d5f521a4e";
const COINGECKO_ETH_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const CFG = {
  minerDir: process.env.MINER_DIR || path.resolve(process.env.HOME || ".", "hash256/hash256-mine"),
  sellMinHash: parseFloat(process.env.SELL_MIN_HASH || "50"),
  autoSell: (process.env.AUTO_SELL || "true") === "true",
  swapPollSec: parseInt(process.env.SWAP_POLL_SEC || "60", 10),
  maxBasefeeGwei: parseFloat(process.env.MAX_BASEFEE_GWEI || "3"),
  minHashUsd: parseFloat(process.env.MIN_HASH_USD || "0.08"),
  maxRuntimeMin: parseInt(process.env.MAX_RUNTIME_MIN || "480", 10),
  stopOnLossUsd: parseFloat(process.env.STOP_ON_LOSS_USD || "40"),
};

const state = {
  startTime: Date.now(),
  startEthBalance: null,
  startHashBalance: null,
  ethUsdAtStart: null,
  minerProc: null,
  shuttingDown: false,
  successMines: 0,
  failedMines: 0,
  totalSwapped: 0n,
  reasons: [],
};

function logTo(file, msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + "\n");
  } catch {}
}
const logMain = (m) => logTo(process.env.GUARD_LOG || "./logs/guardian.log", `[main] ${m}`);
const logMine = (m) => logTo(process.env.MINE_LOG || "./logs/miner.log", m);

async function fetchJson(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } finally { clearTimeout(t); }
}

async function getHashUsd() {
  const j = await fetchJson(GECKO_POOL_URL).catch(() => null);
  const p = parseFloat(j?.data?.attributes?.base_token_price_usd);
  return Number.isFinite(p) ? p : null;
}

async function getEthUsd() {
  const j = await fetchJson(COINGECKO_ETH_URL).catch(() => null);
  const p = j?.ethereum?.usd;
  return Number.isFinite(p) ? p : null;
}

async function getBasefeeGwei(provider) {
  const b = await provider.getBlock("latest");
  return Number(ethers.formatUnits(b.baseFeePerGas || 0n, "gwei"));
}

async function getBalances(provider, wallet, hashContract) {
  const [eth, hash] = await Promise.all([
    provider.getBalance(wallet.address),
    hashContract.balanceOf(wallet.address),
  ]);
  return { eth, hash };
}

function startMiner() {
  const args = ["miner.js", "--backend", "opencl"];
  logMain(`spawning miner: node ${args.join(" ")}`);
  const env = {
    ...process.env,
    RPC_URL: process.env.RPC_URL,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    MINER_BACKEND: "opencl",
    GPU_BATCH_SIZE: process.env.GPU_BATCH_SIZE || "67108864",
    PRIORITY_FEE_GWEI: process.env.PRIORITY_FEE_GWEI || "2",
    KEEP_MINING: "true",
  };
  const proc = spawn("node", args, {
    cwd: CFG.minerDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => {
    const s = d.toString().trim();
    if (!s) return;
    logMine(s);
    if (/TX sent:/i.test(s)) state.successMines += 0;
    if (/Success block/i.test(s)) state.successMines += 1;
    if (/TX failed|execution reverted|InsufficientWork/i.test(s)) state.failedMines += 1;
  });
  proc.stderr.on("data", (d) => logMine(`[err] ${d.toString().trim()}`));
  proc.on("exit", (code) => {
    logMain(`miner exited code=${code}`);
    state.minerProc = null;
    if (!state.shuttingDown) {
      logMain("miner died unexpectedly, triggering shutdown");
      shutdown("miner exited");
    }
  });
  return proc;
}

async function shutdown(reason) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  state.reasons.push(reason);
  logMain(`=== SHUTDOWN: ${reason} ===`);
  if (state.minerProc) {
    try { state.minerProc.kill("SIGINT"); } catch {}
    await new Promise(r => setTimeout(r, 3000));
    if (state.minerProc) { try { state.minerProc.kill("SIGKILL"); } catch {} }
  }
  try {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const hashContract = new ethers.Contract(HASH_TOKEN, ERC20_ABI, provider);
    const bal = await hashContract.balanceOf(wallet.address);
    if (bal > 0n && CFG.autoSell) {
      logMain(`final swap: ${ethers.formatUnits(bal, 18)} HASH`);
      await swapHashToEth({ amountWei: bal }).catch((e) => logMain(`final swap failed: ${e.message}`));
    }
  } catch (e) { logMain(`shutdown cleanup err: ${e.message}`); }
  logMain(`success=${state.successMines} failed=${state.failedMines} reasons=${state.reasons.join("|")}`);
  process.exit(0);
}

async function guardianTick({ provider, wallet, hashContract }) {
  const elapsedMin = (Date.now() - state.startTime) / 60_000;
  if (elapsedMin > CFG.maxRuntimeMin) return shutdown(`max runtime ${CFG.maxRuntimeMin}m reached`);

  const [basefee, hashUsd, ethUsd, bal] = await Promise.all([
    getBasefeeGwei(provider).catch(() => null),
    getHashUsd(),
    getEthUsd(),
    getBalances(provider, wallet, hashContract).catch(() => null),
  ]);

  if (basefee !== null && basefee > CFG.maxBasefeeGwei) {
    return shutdown(`basefee ${basefee.toFixed(3)} gwei > max ${CFG.maxBasefeeGwei}`);
  }
  if (hashUsd !== null && hashUsd < CFG.minHashUsd) {
    return shutdown(`HASH price $${hashUsd.toFixed(4)} < min $${CFG.minHashUsd}`);
  }

  if (bal && ethUsd && state.startEthBalance !== null && state.ethUsdAtStart !== null) {
    const deltaEth = Number(ethers.formatEther(bal.eth - state.startEthBalance));
    const pnlUsd = deltaEth * ethUsd;
    if (pnlUsd < -CFG.stopOnLossUsd) {
      return shutdown(`stop-loss hit: pnl $${pnlUsd.toFixed(2)} < -$${CFG.stopOnLossUsd}`);
    }
    logMain(`tick elapsed=${elapsedMin.toFixed(1)}m basefee=${basefee?.toFixed(3)}gw hash=$${hashUsd?.toFixed(4)} pnl≈$${pnlUsd.toFixed(2)} hashBal=${ethers.formatUnits(bal.hash, 18)}`);
  } else {
    logMain(`tick elapsed=${elapsedMin.toFixed(1)}m basefee=${basefee?.toFixed(3)}gw hash=$${hashUsd?.toFixed(4)}`);
  }

  if (CFG.autoSell && bal) {
    const balHuman = parseFloat(ethers.formatUnits(bal.hash, 18));
    if (balHuman >= CFG.sellMinHash) {
      logMain(`autosell trigger: ${balHuman} HASH >= ${CFG.sellMinHash}`);
      await swapHashToEth({ amountWei: bal.hash })
        .then((r) => { if (r.ok) state.totalSwapped += BigInt(r.amountIn || "0"); })
        .catch((e) => logMain(`swap err: ${e.message}`));
    }
  }
}

async function main() {
  for (const k of ["RPC_URL", "PRIVATE_KEY"]) {
    if (!process.env[k]) { console.error(`missing env ${k}`); process.exit(1); }
  }

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const hashContract = new ethers.Contract(HASH_TOKEN, ERC20_ABI, provider);

  const initBal = await getBalances(provider, wallet, hashContract);
  state.startEthBalance = initBal.eth;
  state.startHashBalance = initBal.hash;
  state.ethUsdAtStart = await getEthUsd();

  logMain(`wallet=${wallet.address}`);
  logMain(`start eth=${ethers.formatEther(initBal.eth)} hash=${ethers.formatUnits(initBal.hash, 18)}`);
  logMain(`eth_usd=${state.ethUsdAtStart} cfg=${JSON.stringify(CFG)}`);

  if (initBal.eth < ethers.parseEther("0.002")) {
    logMain(`WARN: ETH balance < 0.002, gas buat mining bakal habis cepet`);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  state.minerProc = startMiner();

  while (!state.shuttingDown) {
    try { await guardianTick({ provider, wallet, hashContract }); }
    catch (e) { logMain(`guardian err: ${e.message}`); }
    await new Promise(r => setTimeout(r, CFG.swapPollSec * 1000));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
