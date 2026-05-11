require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const HASH_TOKEN = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const KYBER_BASE = "https://aggregator-api.kyberswap.com/ethereum/api/v1";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

function need(name) {
  const v = process.env[name];
  if (!v) { throw new Error(`env ${name} required`); }
  return v;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  const logFile = process.env.SWAP_LOG || "./logs/swap.log";
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line + "\n");
  } catch {}
}

async function httpJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 200)}`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`); }
}

async function getRoute({ amountIn }) {
  const qs = new URLSearchParams({
    tokenIn: HASH_TOKEN,
    tokenOut: ETH_SENTINEL,
    amountIn: amountIn.toString(),
    saveGas: "0",
    gasInclude: "true",
  }).toString();
  return httpJson(`${KYBER_BASE}/routes?${qs}`, {
    headers: { "x-client-id": "hash256-auto" },
  });
}

async function buildRoute({ routeSummary, sender, slippageBps }) {
  return httpJson(`${KYBER_BASE}/route/build`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": "hash256-auto",
    },
    body: JSON.stringify({
      routeSummary,
      sender,
      recipient: sender,
      slippageTolerance: slippageBps,
      deadline: Math.floor(Date.now() / 1000) + 1200,
      source: "hash256-auto",
    }),
  });
}

async function ensureApproval({ token, owner, spender, amount, signer }) {
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) return null;
  log(`approving HASH to router ${spender}`);
  const tx = await token.approve(spender, ethers.MaxUint256);
  log(`approve tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  log(`approve confirmed block ${receipt.blockNumber}`);
  return receipt;
}

async function swapHashToEth({ amountWei, dryRun = false } = {}) {
  const rpcUrl = need("RPC_URL");
  const privateKey = need("PRIVATE_KEY");
  const slippageBps = parseInt(process.env.SELL_SLIPPAGE_BPS || "200", 10);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const hash = new ethers.Contract(HASH_TOKEN, ERC20_ABI, wallet);

  const balance = await hash.balanceOf(wallet.address);
  const target = amountWei ?? balance;

  if (target === 0n) {
    log("no HASH to swap");
    return { skipped: true, reason: "zero balance" };
  }
  if (target > balance) {
    throw new Error(`requested ${target} > balance ${balance}`);
  }

  log(`routing: ${ethers.formatUnits(target, 18)} HASH -> ETH`);
  const routeRes = await getRoute({ amountIn: target });
  if (routeRes.code !== 0 || !routeRes.data?.routeSummary) {
    throw new Error(`route failed: ${JSON.stringify(routeRes).slice(0, 300)}`);
  }

  const summary = routeRes.data.routeSummary;
  const amountOut = BigInt(summary.amountOut);
  const gasUsd = summary.gasUsd;
  log(`route found: out=${ethers.formatEther(amountOut)} ETH, gas≈$${gasUsd}`);

  if (dryRun) {
    return {
      dryRun: true,
      amountIn: target.toString(),
      amountOut: amountOut.toString(),
      gasUsd,
      routerAddress: routeRes.data.routerAddress,
    };
  }

  const built = await buildRoute({
    routeSummary: summary,
    sender: wallet.address,
    slippageBps,
  });
  if (built.code !== 0 || !built.data?.data) {
    throw new Error(`build failed: ${JSON.stringify(built).slice(0, 300)}`);
  }

  const router = built.data.routerAddress;
  const callData = built.data.data;
  const value = BigInt(built.data.transactionValue || "0");

  await ensureApproval({
    token: hash,
    owner: wallet.address,
    spender: router,
    amount: target,
    signer: wallet,
  });

  const feeData = await provider.getFeeData();
  const priorityFee = ethers.parseUnits(
    process.env.PRIORITY_FEE_GWEI || "2",
    "gwei"
  );
  const maxFeePerGas = (feeData.gasPrice ?? ethers.parseUnits("10", "gwei")) * 2n + priorityFee;

  log(`sending swap tx to ${router}`);
  const tx = await wallet.sendTransaction({
    to: router,
    data: callData,
    value,
    gasLimit: 500_000n,
    maxFeePerGas,
    maxPriorityFeePerGas: priorityFee,
  });
  log(`swap tx sent: ${tx.hash}`);

  const receipt = await tx.wait();
  if (receipt.status === 1) {
    log(`swap SUCCESS block ${receipt.blockNumber}, expected ${ethers.formatEther(amountOut)} ETH`);
    return {
      ok: true,
      txHash: tx.hash,
      amountIn: target.toString(),
      amountOut: amountOut.toString(),
    };
  }
  log(`swap REVERTED: ${tx.hash}`);
  return { ok: false, txHash: tx.hash };
}

module.exports = { swapHashToEth };

if (require.main === module) {
  swapHashToEth()
    .then((r) => { log(`result: ${JSON.stringify(r)}`); process.exit(0); })
    .catch((e) => { log(`ERROR: ${e.message}`); process.exit(1); });
}
