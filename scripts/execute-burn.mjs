
// The one step that actually spends treasury funds. This script is NEVER
// run on a schedule — it only runs when you manually click "Run workflow"
// on "Execute burn (manual approval)" in the Actions tab. That click is
// the approval. Everything up to this point (prepare-burn.mjs) was just
// pricing, with no funds at risk.
//
// Safe to re-run: if a previous attempt bought the coin but failed before
// burning it, this picks up from the burn step instead of buying again.
// If a burn already completed, it refuses to do anything.
 
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection, Keypair, PublicKey, Transaction, VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, getAccount, createBurnInstruction,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { LAMPORTS_PER_SOL } from "./lib/rpc.mjs";
import { getQuote, getSwapTransaction, priceImpactPercent } from "./lib/jupiter.mjs";
 
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
 
const API_KEY = process.env.HELIUS_API_KEY;
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;
if (!API_KEY) { console.error("Missing HELIUS_API_KEY environment variable."); process.exit(1); }
if (!PRIVATE_KEY) { console.error("Missing TREASURY_PRIVATE_KEY environment variable."); process.exit(1); }
 
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const connection = new Connection(RPC_URL, "confirmed");
 
async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf8"));
  } catch {
    return fallback;
  }
}
async function writeJson(file, data) {
  await writeFile(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
 
// Meme coins increasingly launch under Token-2022, not the classic SPL
// Token program. The associated token account address (and the burn
// instruction) differ depending on which one actually owns the mint, so
// we ask the chain instead of assuming.
async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint account ${mint.toBase58()} not found on-chain.`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mint.toBase58()} is owned by an unrecognized program (${info.owner.toBase58()}).`);
}
 
// RPC read-after-write can lag a beat right after a transaction confirms —
// retry a few times before concluding the account genuinely isn't there.
async function getAccountWithRetry(connection, address, programId, attempts = 5) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await getAccount(connection, address, "confirmed", programId);
    } catch (e) {
      lastErr = e;
      if (i < attempts) await sleep(1500);
    }
  }
  throw lastErr;
}
 
async function main() {
  const config = await readJson("config.json", null);
  const pending = await readJson("pending-burn.json", null);
 
  if (!config) { console.error("Missing data/config.json."); process.exit(1); }
  if (!pending || !pending.cycleId) {
    console.error("No pending burn on file. Run \"prepare-burn\" first (it runs automatically every 5 min).");
    process.exit(1);
  }
  if (pending.status === "executed") {
    console.error(`Cycle "${pending.cycleId}" was already burned. burnTxSignature: ${pending.burnTxSignature}`);
    process.exit(1);
  }
  if (pending.status !== "awaiting-approval" && pending.status !== "swap-done-burn-pending") {
    console.error(
      `Cycle "${pending.cycleId}" isn't ready: status is "${pending.status}" (${pending.message || "no detail"}). ` +
      "Resolve that first (e.g. wait for a better quote or fix the CA), then let prepare-burn re-quote it."
    );
    process.exit(1);
  }
 
  const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  if (treasuryKeypair.publicKey.toBase58() !== config.treasuryWallet) {
    console.error("TREASURY_PRIVATE_KEY does not match config.json's treasuryWallet — refusing to send funds.");
    process.exit(1);
  }
 
  const mint = new PublicKey(pending.ca);
  let buyTxSignature = pending.buyTxSignature || null;
 
  if (pending.status === "awaiting-approval") {
    const maxImpactPct = config.burnMaxPriceImpactPct ?? 15;
    console.log(`Re-checking price for cycle "${pending.cycleId}" right before spending anything...`);
    const freshQuote = await getQuote({
      outputMint: pending.ca,
      amountLamports: pending.burnLamports,
      slippageBps: pending.slippageBps,
    });
    if (!freshQuote) {
      console.error("No swap route available right now (was available earlier). Try again shortly.");
      process.exit(1);
    }
    const impactPct = priceImpactPercent(freshQuote);
    if (impactPct > maxImpactPct) {
      console.error(`Fresh price impact is ${impactPct.toFixed(2)}%, above your max of ${maxImpactPct}%. Aborting — nothing spent.`);
      process.exit(1);
    }
    console.log(`Fresh quote OK (${impactPct.toFixed(2)}% impact). Building swap transaction...`);
 
    const { swapTransaction, lastValidBlockHeight } = await getSwapTransaction({
      quote: freshQuote,
      userPublicKey: treasuryKeypair.publicKey.toBase58(),
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([treasuryKeypair]);
    const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    console.log(`Swap sent: ${signature} — confirming...`);
    let confirmed = false;
    try {
      await connection.confirmTransaction(
        { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
        "confirmed"
      );
      confirmed = true;
    } catch (e) {
      // The client-side wait can time out (e.g. block-height-exceeded)
      // even when the transaction actually landed — the RPC just didn't
      // tell us in time. Ask the chain directly before assuming failure.
      console.warn(`confirmTransaction didn't resolve cleanly (${e.message}). Checking the real on-chain status...`);
    }
    if (!confirmed) {
      const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      const landed =
        status?.value &&
        !status.value.err &&
        (status.value.confirmationStatus === "confirmed" || status.value.confirmationStatus === "finalized");
      if (!landed) {
        console.error(
          `Swap transaction ${signature} did not land (status: ${JSON.stringify(status?.value)}). ` +
          "Nothing was bought — safe to re-run this workflow to try again."
        );
        process.exit(1);
      }
      console.log(`Swap actually confirmed on-chain (${signature}) despite the client-side wait timing out. Continuing.`);
    }
    console.log("Swap confirmed. Treasury now holds the target coin.");
    buyTxSignature = signature;
 
    // Checkpoint immediately so a crash before the burn doesn't cause a
    // re-run to buy a second time.
    await writeJson("pending-burn.json", {
      ...pending,
      status: "swap-done-burn-pending",
      buyTxSignature,
      message: "Swap done, burn not yet confirmed. Re-run this workflow to finish the burn.",
    });
  } else {
    console.log(`Resuming: swap already done in a prior run (${buyTxSignature}). Skipping straight to the burn.`);
  }
 
  const tokenProgramId = await detectTokenProgram(connection, mint);
  console.log(
    tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)
      ? "Mint is a Token-2022 token."
      : "Mint uses the classic SPL Token program."
  );
  const treasuryAta = await getAssociatedTokenAddress(mint, treasuryKeypair.publicKey, false, tokenProgramId);
  const account = await getAccountWithRetry(connection, treasuryAta, tokenProgramId);
  const burnAmount = account.amount; // burn the full balance the treasury is holding of this mint
  if (burnAmount <= 0n) {
    console.error(
      "Treasury's balance of this token is 0 — nothing to burn. Either the swap hasn't landed yet, " +
      "or a prior run already burned it and pending-burn.json is out of date — check cycles.json and Solscan."
    );
    process.exit(1);
  }
  console.log(`Burning ${burnAmount.toString()} base units of ${pending.ticker}...`);
 
  const burnTx = new Transaction().add(
    createBurnInstruction(treasuryAta, mint, treasuryKeypair.publicKey, burnAmount, [], tokenProgramId)
  );
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  burnTx.recentBlockhash = blockhash;
  burnTx.feePayer = treasuryKeypair.publicKey;
  burnTx.sign(treasuryKeypair);
  const burnSignature = await connection.sendRawTransaction(burnTx.serialize());
  console.log(`Burn sent: ${burnSignature} — confirming...`);
  let burnConfirmed = false;
  try {
    await connection.confirmTransaction({ signature: burnSignature, blockhash, lastValidBlockHeight }, "confirmed");
    burnConfirmed = true;
  } catch (e) {
    console.warn(`confirmTransaction didn't resolve cleanly (${e.message}). Checking the real on-chain status...`);
  }
  if (!burnConfirmed) {
    const status = await connection.getSignatureStatus(burnSignature, { searchTransactionHistory: true });
    const landed =
      status?.value &&
      !status.value.err &&
      (status.value.confirmationStatus === "confirmed" || status.value.confirmationStatus === "finalized");
    if (!landed) {
      console.error(
        `Burn transaction ${burnSignature} did not land (status: ${JSON.stringify(status?.value)}). ` +
        "The coin is still sitting in the treasury, unburned — safe to re-run this workflow, it'll pick up at the burn step."
      );
      process.exit(1);
    }
    console.log(`Burn actually confirmed on-chain (${burnSignature}) despite the client-side wait timing out. Continuing.`);
  }
  console.log("Burn confirmed. Coins are gone for good.");
 
  const cycles = await readJson("cycles.json", []);
  const idx = cycles.findIndex((c) => c.cycleId === pending.cycleId);
  if (idx !== -1) {
    cycles[idx].buyTxSignature = buyTxSignature;
    cycles[idx].burnTxSignature = burnSignature;
    await writeJson("cycles.json", cycles);
  } else {
    console.warn(`Couldn't find cycle "${pending.cycleId}" in cycles.json to record the burn tx — add it by hand.`);
  }
 
  await writeJson("pending-burn.json", {
    ...pending,
    status: "executed",
    buyTxSignature,
    burnTxSignature: burnSignature,
    executedAt: new Date().toISOString(),
    message: "Burn complete.",
  });
 
  console.log(`Done. Buy: ${buyTxSignature} | Burn: ${burnSignature}`);
}
 
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
 
