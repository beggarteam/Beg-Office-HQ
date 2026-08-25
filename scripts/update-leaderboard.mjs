// Computes lifetime SOL received per beggar and writes data/leaderboard.json.
//
// Reads the WALLETS object straight out of index.html (the same object you
// already edit when you add a wallet) — nothing extra to keep in sync.
//
// Run locally with:  HELIUS_API_KEY=xxxx node scripts/update-leaderboard.mjs
// In CI it's run on a schedule by .github/workflows/update-leaderboard.yml,
// which supplies HELIUS_API_KEY from a repo secret.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const INDEX_HTML = path.join(ROOT, "index.html");
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "leaderboard-state.json");
const OUTPUT_FILE = path.join(DATA_DIR, "leaderboard.json");

const API_KEY = process.env.HELIUS_API_KEY;
if (!API_KEY) {
  console.error("Missing HELIUS_API_KEY environment variable.");
  process.exit(1);
}
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

const LAMPORTS_PER_SOL = 1_000_000_000;
const SIG_PAGE_SIZE = 1000; // Solana RPC max per call

// ---------- 1. pull WALLETS out of index.html ----------

async function loadWallets() {
  const html = await readFile(INDEX_HTML, "utf8");
  const match = html.match(/const\s+WALLETS\s*=\s*(\{[\s\S]*?\n\s*\})\s*;/);
  if (!match) {
    throw new Error("Could not find a `const WALLETS = { ... };` block in index.html");
  }
  // Safe to eval here: this is our own file, in our own repo, run in our own
  // CI — not third-party/user-supplied input.
  const wallets = new Function(`return (${match[1]});`)();
  const entries = Object.entries(wallets).filter(([, addr]) => typeof addr === "string" && addr.trim());
  console.log(`Found ${entries.length} wallet(s) in index.html:`, entries.map(([h]) => h).join(", ") || "(none)");
  return entries; // [[handle, address], ...]
}

// ---------- 2. RPC helpers ----------

let rpcId = 0;
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (res.status === 429) {
      await sleep(500 * attempt);
      continue;
    }
    const json = await res.json();
    if (json.error) {
      // Transient errors are worth a retry; anything else, surface it.
      if (attempt < 5 && /timeout|rate|slot/i.test(json.error.message || "")) {
        await sleep(500 * attempt);
        continue;
      }
      throw new Error(`RPC ${method} failed: ${JSON.stringify(json.error)}`);
    }
    return json.result;
  }
  throw new Error(`RPC ${method} failed after retries`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fetch every confirmed signature for `address` newer than `untilSignature`
// (or all of them, on a wallet's first run). Newest-first from the RPC;
// we return them oldest-first so lamport totals accumulate in order.
async function fetchNewSignatures(address, untilSignature) {
  const collected = [];
  let before;
  for (;;) {
    const page = await rpc("getSignaturesForAddress", [
      address,
      { limit: SIG_PAGE_SIZE, before, until: untilSignature || undefined },
    ]);
    if (!page || page.length === 0) break;
    collected.push(...page);
    if (page.length < SIG_PAGE_SIZE) break;
    before = page[page.length - 1].signature;
  }
  return collected.filter((s) => !s.err).reverse().map((s) => s.signature);
}

// Sum every positive balance change for `address` across the given signatures.
async function sumReceived(address, signatures) {
  let lamports = 0n;
  const CONCURRENCY = 5;
  let idx = 0;

  async function worker() {
    while (idx < signatures.length) {
      const sig = signatures[idx++];
      const tx = await rpc("getTransaction", [
        sig,
        { maxSupportedTransactionVersion: 0, encoding: "json" },
      ]);
      if (!tx || !tx.meta) continue;
      const keys = tx.transaction.message.accountKeys.map((k) =>
        typeof k === "string" ? k : k.pubkey
      );
      const accIdx = keys.indexOf(address);
      if (accIdx === -1) continue;
      const delta = BigInt(tx.meta.postBalances[accIdx]) - BigInt(tx.meta.preBalances[accIdx]);
      if (delta > 0n) lamports += delta;
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, signatures.length) }, worker));
  return lamports;
}

// ---------- 3. main ----------

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  let state = {};
  try {
    state = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    /* first run, no state yet */
  }

  const wallets = await loadWallets();
  const results = [];

  for (const [handle, address] of wallets) {
    const prior = state[address] || { lastSignature: null, lamportsReceived: "0" };
    console.log(`\n@${handle} (${address})`);

    let newSignatures;
    try {
      newSignatures = await fetchNewSignatures(address, prior.lastSignature);
    } catch (e) {
      console.error(`  skipped — signature fetch failed: ${e.message}`);
      results.push({
        handle,
        wallet: address,
        solReceived: Number(BigInt(prior.lamportsReceived)) / LAMPORTS_PER_SOL,
        stale: true,
      });
      continue;
    }
    console.log(`  ${newSignatures.length} new transaction(s) since last run`);

    let newLamports = 0n;
    if (newSignatures.length > 0) {
      newLamports = await sumReceived(address, newSignatures);
    }

    const totalLamports = BigInt(prior.lamportsReceived) + newLamports;
    state[address] = {
      lastSignature: newSignatures.length > 0 ? newSignatures[newSignatures.length - 1] : prior.lastSignature,
      lamportsReceived: totalLamports.toString(),
    };

    results.push({
      handle,
      wallet: address,
      solReceived: Number(totalLamports) / LAMPORTS_PER_SOL,
    });
  }

  results.sort((a, b) => b.solReceived - a.solReceived);
  results.forEach((r, i) => (r.rank = i + 1));

  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  await writeFile(
    OUTPUT_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), entries: results }, null, 2)
  );

  console.log(`\nWrote ${results.length} entries to data/leaderboard.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
