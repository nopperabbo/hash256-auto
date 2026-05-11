require("dotenv").config();
const { ethers } = require("ethers");
const { swapHashToEth } = require("./swap");

const HASH_TOKEN = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const rpc = process.env.RPC_URL;
  const pk = process.env.PRIVATE_KEY;
  if (!rpc || !pk) throw new Error("RPC_URL / PRIVATE_KEY missing");

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider);
  console.log("Wallet:", wallet.address);

  const [eth, hash] = await Promise.all([
    provider.getBalance(wallet.address),
    new ethers.Contract(HASH_TOKEN, ERC20_ABI, provider).balanceOf(wallet.address),
  ]);
  console.log("ETH balance:  ", ethers.formatEther(eth));
  console.log("HASH balance: ", ethers.formatUnits(hash, 18));

  if (hash < ethers.parseUnits("1", 18)) {
    console.log("\nNo HASH to test with. Dry-run only.");
    const r = await swapHashToEth({ amountWei: ethers.parseUnits("1", 18), dryRun: true })
      .catch(e => ({ error: e.message }));
    console.log("Dry-run result:", r);
    return;
  }

  console.log("\n=== DRY RUN: swap 1 HASH -> ETH ===");
  const dry = await swapHashToEth({
    amountWei: ethers.parseUnits("1", 18),
    dryRun: true,
  });
  console.log(dry);

  if (process.argv.includes("--execute")) {
    console.log("\n=== EXECUTE REAL SWAP: 1 HASH ===");
    const real = await swapHashToEth({ amountWei: ethers.parseUnits("1", 18) });
    console.log(real);
  } else {
    console.log("\n(tambahkan --execute kalau mau eksekusi beneran)");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
