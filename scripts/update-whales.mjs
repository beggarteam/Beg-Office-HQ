// Scans the treasury wallet's incoming transactions for donations, flags
// any address whose single donation this cycle crosses whaleThresholdSol,
// and ranks the top N by total donated this cycle. Resets automatically
// whenever data/cycle.json's cycleId changes (i.e. a new cycle starts).
//
// Run every 5 minutes by .github/workflows/cycle-engine.yml.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRpcClient, fetchNewSignatures, LAMPORTS_PER_SOL } from "./lib/rpc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "whale-state.json");
const OUTPUT_FILE = path.join(DATA_DIR, "whales.json");

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) {
  console.error("Missing HELIUS_API_KEY environment variable.");
  process.exit(1);
}
const { rpc } = makeRpcClient(`https://mainnet.helius-rpc.com/?api-key=${API_KEY}`);

// For a given transaction, figure out how much the treasury received and
// who most plausibly sent it (the account whose balance dropped by a
// matching amount). This is a heuristic that works well for ordinary
// wallet-to-wallet SOL transfers, which is what a "donation" almost always
// is here; it can misattribute donations routed through an intermediary
// program/aggregator, which is an acceptable gap for this first version.
async function inspectTransaction(signature, treasuryWallet) {
  const tx = await rpc("getTransaction", [
    signature,
    { maxSupportedTransactionVersion: 0, encoding: "json" },
  ]);
  if (!tx || !tx.meta) return null;

  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const treasuryIdx = keys.indexOf(treasuryWallet);
  if (treasuryIdx === -1) return null;

  const treasuryDelta = BigInt(tx.meta.postBalances[treasuryIdx]) - BigInt(tx.meta.preBalances[treasuryIdx]);
  if (treasuryDelta <= 0n) return null; // outgoing or unrelated tx

  let senderIdx = -1;
  let mostNegative = 0n;
  keys.forEach((_, i) => {
    if (i === treasuryIdx) return;
    const delta = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
    if (delta < mostNegative) {
      mostNegative = delta;
      senderIdx = i;
    }
  });

  return {
    sender: senderIdx === -1 ? "unknown" : keys[senderIdx],
    lamports: treasuryDelta,
    blockTime: tx.blockTime || null,
  };
}

async function main() {
  const config = JSON.parse(await readFile(path.join(DATA_DIR, "config.json"), "utf8"));
  const cycle = JSON.parse(await readFile(path.join(DATA_DIR, "cycle.json"), "utf8"));
  const wallet = config.treasuryWallet;

  if (!wallet || wallet === "PUT_TREASURY_WALLET_ADDRESS_HERE") {
    console.log("No treasury wallet configured yet in data/config.json — skipping.");
    return;
  }

  let state = { cycleId: null, lastSignature: null, totals: {}, qualified: [] };
  try {
    state = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    /* first run */
  }

  if (state.cycleId !== cycle.cycleId) {
    console.log(`Cycle changed (${state.cycleId} -> ${cycle.cycleId}) — resetting whale totals.`);
    state = { cycleId: cycle.cycleId, lastSignature: state.lastSignature, totals: {}, qualified: [] };
  }

  const newSignatures = await fetchNewSignatures(rpc, wallet, state.lastSignature);
  console.log(`${newSignatures.length} new treasury transaction(s) to inspect.`);

  const thresholdLamports = BigInt(Math.round(config.whaleThresholdSol * LAMPORTS_PER_SOL));
  const qualified = new Set(state.qualified);

  for (const sig of newSignatures) {
    const info = await inspectTransaction(sig, wallet);
    if (!info || info.sender === "unknown") continue;

    // Only attribute to a cycle's whale board while a cycle is actually
    // running, so trading-fee sweeps or off-cycle deposits don't show up
    // as a beggar-crowned "whale."
    if (cycle.status !== "active") continue;

    const prior = BigInt(state.totals[info.sender] || "0");
    state.totals[info.sender] = (prior + info.lamports).toString();

    if (info.lamports >= thresholdLamports) {
      qualified.add(info.sender);
    }
  }

  state.qualified = Array.from(qualified);
  if (newSignatures.length > 0) {
    state.lastSignature = newSignatures[newSignatures.length - 1];
  }

  const ranked = state.qualified
    .map((address) => ({
      address,
      totalSol: Number(BigInt(state.totals[address] || "0")) / LAMPORTS_PER_SOL,
    }))
    .sort((a, b) => b.totalSol - a.totalSol)
    .slice(0, config.whaleBoardSize)
    .map((w, i) => ({ ...w, rank: i + 1 }));

  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  await writeFile(
    OUTPUT_FILE,
    JSON.stringify({ cycleId: cycle.cycleId, updatedAt: new Date().toISOString(), whales: ranked }, null, 2)
  );

  console.log(`Whale board: ${ranked.length} qualifying address(es).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
