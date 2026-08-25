// Polls the treasury wallet's SOL balance and writes data/treasury.json.
// Run every 30 minutes by .github/workflows/update-treasury.yml.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRpcClient, LAMPORTS_PER_SOL } from "./lib/rpc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) {
  console.error("Missing HELIUS_API_KEY environment variable.");
  process.exit(1);
}
const { rpc } = makeRpcClient(`https://mainnet.helius-rpc.com/?api-key=${API_KEY}`);

async function main() {
  const config = JSON.parse(await readFile(path.join(DATA_DIR, "config.json"), "utf8"));
  const wallet = config.treasuryWallet;

  if (!wallet || wallet === "PUT_TREASURY_WALLET_ADDRESS_HERE") {
    console.log("No treasury wallet configured yet in data/config.json — skipping.");
    return;
  }

  const result = await rpc("getBalance", [wallet]);
  const balanceSol = result.value / LAMPORTS_PER_SOL;

  await writeFile(
    path.join(DATA_DIR, "treasury.json"),
    JSON.stringify({ updatedAt: new Date().toISOString(), wallet, balanceSol }, null, 2)
  );

  console.log(`Treasury balance: ${balanceSol} SOL`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
