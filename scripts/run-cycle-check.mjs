// Checks whether the active cycle's timer has run out and, if so, pays out
// distributePercent (equal shares to every wallet in WALLETS) from the
// treasury hot wallet, records the cycle in data/cycles.json, and marks the
// cycle "distributed." burnPercent is NOT swapped/burned automatically —
// that step stays manual for now — this script only records the intended
// burn amount so you can fill in the tx hash once you've done it.
//
// Run every 5 minutes by .github/workflows/cycle-engine.yml, right after
// update-whales.mjs so the cycle log captures a fresh whale board.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { loadWalletsFromIndexHtml } from "./lib/wallets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const INDEX_HTML = path.join(ROOT, "index.html");

const LAMPORTS_PER_SOL = 1_000_000_000;

const API_KEY = process.env.HELIUS_API_KEY;
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;
if (!API_KEY) {
  console.error("Missing HELIUS_API_KEY environment variable.");
  process.exit(1);
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const connection = new Connection(RPC_URL, "confirmed");

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const config = await readJson("config.json", null);
  const cycle = await readJson("cycle.json", null);

  if (!config || !cycle) {
    console.error("Missing data/config.json or data/cycle.json.");
    process.exit(1);
  }

  if (cycle.status !== "active") {
    console.log(`Cycle status is "${cycle.status}" — nothing to do.`);
    return;
  }

  const now = new Date();
  const endsAt = new Date(cycle.endsAt);
  if (now < endsAt) {
    console.log(`Cycle still running — ${Math.round((endsAt - now) / 60000)} min left.`);
    return;
  }

  console.log(`Cycle "${cycle.cycleId}" (${cycle.ticker}) has ended. Running payout...`);

  if (!PRIVATE_KEY) {
    console.error(
      "Cycle has ended but TREASURY_PRIVATE_KEY is not set — cannot distribute automatically. " +
      "Add the secret, or distribute manually and update data/cycle.json + data/cycles.json by hand."
    );
    process.exit(1);
  }

  const treasuryWallet = config.treasuryWallet;
  const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  if (treasuryKeypair.publicKey.toBase58() !== treasuryWallet) {
    console.error(
      "TREASURY_PRIVATE_KEY does not match data/config.json's treasuryWallet address — refusing to send funds."
    );
    process.exit(1);
  }

  const balanceLamports = await connection.getBalance(treasuryKeypair.publicKey);
  const reserveLamports = Math.round(config.treasuryReserveSol * LAMPORTS_PER_SOL);
  const availableLamports = Math.max(0, balanceLamports - reserveLamports);

  const distributeLamports = Math.floor((availableLamports * config.distributePercent) / 100);
  const burnLamports = Math.floor((availableLamports * config.burnPercent) / 100);

  const beggars = await loadWalletsFromIndexHtml(INDEX_HTML);
  console.log(`${beggars.length} beggar(s) with a wallet on file.`);

  const perBeggarLamports = beggars.length > 0 ? Math.floor(distributeLamports / beggars.length) : 0;
  const distributionResults = [];

  if (beggars.length === 0) {
    console.log("No beggar wallets on file — skipping payout, treasury funds stay put.");
  } else if (perBeggarLamports <= 0) {
    console.log("Distribution share per beggar rounds to 0 lamports — skipping payout.");
  } else {
    for (const [handle, address] of beggars) {
      try {
        const toPubkey = new PublicKey(address);
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: treasuryKeypair.publicKey,
            toPubkey,
            lamports: perBeggarLamports,
          })
        );
        const signature = await sendAndConfirmTransaction(connection, tx, [treasuryKeypair]);
        console.log(`  paid @${handle}: ${signature}`);
        distributionResults.push({ handle, address, lamports: perBeggarLamports, signature, ok: true });
      } catch (e) {
        console.error(`  FAILED paying @${handle} (${address}): ${e.message}`);
        distributionResults.push({ handle, address, lamports: perBeggarLamports, error: e.message, ok: false });
      }
    }
  }

  const actuallyDistributedLamports = distributionResults
    .filter((r) => r.ok)
    .reduce((sum, r) => sum + r.lamports, 0);

  const whales = await readJson("whales.json", { whales: [] });

  const cycles = await readJson("cycles.json", []);
  cycles.push({
    cycleId: cycle.cycleId,
    ticker: cycle.ticker,
    ca: cycle.ca,
    startedAt: cycle.startedAt,
    endedAt: now.toISOString(),
    treasuryAtEndSol: balanceLamports / LAMPORTS_PER_SOL,
    burnAmountSol: burnLamports / LAMPORTS_PER_SOL,
    burnTxSignature: null, // fill in by hand once you've done the manual buy + burn
    distributedAmountSol: actuallyDistributedLamports / LAMPORTS_PER_SOL,
    perBeggarSol: perBeggarLamports / LAMPORTS_PER_SOL,
    distribution: distributionResults,
    topWhales: whales.whales || [],
  });
  await writeFile(path.join(DATA_DIR, "cycles.json"), JSON.stringify(cycles, null, 2));

  await writeFile(
    path.join(DATA_DIR, "cycle.json"),
    JSON.stringify({ ...cycle, status: "distributed" }, null, 2)
  );

  console.log("Cycle closed out and logged. Set up the next cycle whenever you're ready.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
