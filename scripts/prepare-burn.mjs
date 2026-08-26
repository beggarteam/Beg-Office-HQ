// Read-only step: for the most recent cycle that hasn't been burned yet,
// get a live quote from Jupiter for swapping its budgeted burn amount of
// SOL into the target coin, and write the result to data/pending-burn.json
// for you to review. This script NEVER touches the treasury private key
// and never sends a transaction — it only prices a swap that hasn't
// happened yet, so it's safe to run on a schedule.
//
// Approving the burn is a separate, manual step: once you like the numbers
// here, go to the Actions tab and run "Execute burn (manual approval)" by
// hand. That workflow re-checks the price right before spending anything.
//
// Run every 5 minutes by .github/workflows/cycle-engine.yml, right after
// run-cycle-check.mjs so a freshly-ended cycle gets quoted immediately.
 
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRpcClient, LAMPORTS_PER_SOL } from "./lib/rpc.mjs";
import { getQuote, priceImpactPercent } from "./lib/jupiter.mjs";
 
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
 
const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) {
  console.error("Missing HELIUS_API_KEY environment variable.");
  process.exit(1);
}
const { rpc } = makeRpcClient(`https://mainnet.helius-rpc.com/?api-key=${API_KEY}`);
 
async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf8"));
  } catch {
    return fallback;
  }
}
 
async function getMintDecimals(mint) {
  const info = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const decimals = info?.value?.data?.parsed?.info?.decimals;
  return typeof decimals === "number" ? decimals : 6; // sane fallback for most SPL memecoins
}
 
async function main() {
  const config = await readJson("config.json", null);
  const cycles = await readJson("cycles.json", []);
  if (!config || !Array.isArray(cycles) || cycles.length === 0) {
    console.log("No cycles recorded yet — nothing to prepare a burn for.");
    return;
  }
 
  // Only ever consider the single most recent cycle — never scan back
  // through history. Scanning backward for "any cycle without a burn tx"
  // would "resurrect" an old cycle that intentionally never gets burned
  // (e.g. a test cycle marked excludeFromRewards) once the real latest
  // cycle has already been burned and no new cycle has started yet.
  const target = cycles[cycles.length - 1];
  if (!target || target.burnTxSignature || target.excludeFromRewards) {
    console.log("No un-burned cycle pending — nothing to prepare a burn for.");
    await writeFile(
      path.join(DATA_DIR, "pending-burn.json"),
      JSON.stringify({ status: "none" }, null, 2)
    );
    return;
  }
 
  const existing = await readJson("pending-burn.json", null);
  // Once a swap has actually happened for this cycle (buyTxSignature set,
  // regardless of exact status), treasury funds have already moved —
  // never re-quote or overwrite that state, or execute-burn.mjs could be
  // fooled into buying a second time on its next approval run.
  if (existing && existing.cycleId === target.cycleId && (existing.status === "executed" || existing.buyTxSignature)) {
    console.log(
      `Cycle "${target.cycleId}" already has a swap recorded (status: ${existing.status}) — leaving pending-burn.json alone.`
    );
    return;
  }
 
  const burnLamports = Math.floor((target.burnAmountSol || 0) * LAMPORTS_PER_SOL);
  if (burnLamports <= 0) {
    console.log(`Cycle "${target.cycleId}" has no burn amount recorded — skipping.`);
    return;
  }
 
  const slippageBps = config.burnSlippageBps ?? 300; // 3% default
  const maxImpactPct = config.burnMaxPriceImpactPct ?? 15;
 
  console.log(
    `Quoting burn for cycle "${target.cycleId}" (${target.ticker}): ` +
    `${(burnLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL -> ${target.ca}`
  );
 
  const base = {
    cycleId: target.cycleId,
    ticker: target.ticker,
    ca: target.ca,
    burnLamports,
    burnAmountSol: burnLamports / LAMPORTS_PER_SOL,
    slippageBps,
    quotedAt: new Date().toISOString(),
    buyTxSignature: null,
    burnTxSignature: null,
  };
 
  let quote;
  try {
    quote = await getQuote({ outputMint: target.ca, amountLamports: burnLamports, slippageBps });
  } catch (e) {
    // The request itself failed (DNS, connection, timeout, Jupiter down) —
    // this is NOT the same thing as "no route," and shouldn't be reported
    // as one. Leave the previous pending-burn.json state alone if there
    // was one, so a transient blip doesn't wipe out a good prior quote.
    console.error(`Quote request failed (not a "no route" response): ${e.message}`);
    await writeFile(
      path.join(DATA_DIR, "pending-burn.json"),
      JSON.stringify({
        ...base,
        status: "quote-error",
        message: `Couldn't reach Jupiter to get a quote: ${e.message}. Will retry on the next run.`,
      }, null, 2)
    );
    return;
  }
 
  if (!quote) {
    console.log("No swap route found for this coin yet (Jupiter can't price it). Needs manual attention.");
    await writeFile(
      path.join(DATA_DIR, "pending-burn.json"),
      JSON.stringify({
        ...base,
        status: "no-route",
        message:
          "Jupiter couldn't find a swap route for this CA. It may still be on a pump.fun bonding curve " +
          "and not migrated to a DEX yet, or the CA is wrong. You'll need to buy + burn this one manually.",
      }, null, 2)
    );
    return;
  }
 
  const impactPct = priceImpactPercent(quote);
  const decimals = await getMintDecimals(target.ca);
  const outAmountUi = Number(quote.outAmount) / 10 ** decimals;
 
  if (impactPct > maxImpactPct) {
    console.log(`Price impact ${impactPct.toFixed(2)}% exceeds max of ${maxImpactPct}% — flagging for manual review.`);
    await writeFile(
      path.join(DATA_DIR, "pending-burn.json"),
      JSON.stringify({
        ...base,
        status: "price-impact-too-high",
        expectedOutAmount: outAmountUi,
        priceImpactPct: impactPct,
        message:
          `Estimated price impact is ${impactPct.toFixed(2)}%, above your configured max of ${maxImpactPct}%. ` +
          "Liquidity may be too thin for this size right now. Wait and let this re-quote, lower the amount, " +
          "or raise burnMaxPriceImpactPct in data/config.json if you're comfortable with the impact.",
      }, null, 2)
    );
    return;
  }
 
  console.log(
    `Quote ready: ${(burnLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL -> ~${outAmountUi.toLocaleString()} ` +
    `${target.ticker} (${impactPct.toFixed(2)}% impact). Awaiting your approval.`
  );
 
  await writeFile(
    path.join(DATA_DIR, "pending-burn.json"),
    JSON.stringify({
      ...base,
      status: "awaiting-approval",
      expectedOutAmount: outAmountUi,
      priceImpactPct: impactPct,
      message: "Ready to burn. Review the numbers, then run \"Execute burn (manual approval)\" from the Actions tab.",
    }, null, 2)
  );
}
 
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
 
