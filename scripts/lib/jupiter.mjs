
// Thin wrapper around Jupiter's public swap API (https://jup.ag), which
// aggregates Raydium, Orca, and most other Solana DEXs behind one HTTP
// endpoint. Used to price and build the "buy the target coin with treasury
// SOL" leg of the burn. Jupiter only routes through pools it has indexed —
// a brand-new coin still on pump.fun's bonding curve (not yet migrated to
// a DEX) will come back as "no route," which prepare-burn.mjs treats as
// "needs manual attention," not an error.
//
// Endpoints: Jupiter sunset the old quote-api.jup.ag/v6 host on Oct 1,
// 2025. This uses their free replacement, lite-api.jup.ag (1 request/sec,
// no API key). If Jupiter phases that out too, swap these two constants —
// everything else (request/response shape) should stay the same.
 
export const SOL_MINT = "So11111111111111111111111111111111111111112";
 
const QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap";
 
async function fetchWithRetry(url, options, attempts = 2) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(url, options);
    } catch (e) {
      // A thrown error here means the request never got a response at all
      // (DNS failure, connection refused, timeout) — distinct from Jupiter
      // responding with "no route." Retry once in case it's a transient
      // blip, then let the caller see the real error rather than masking
      // it as "no route."
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw new Error(`Network request to ${new URL(url).host} failed: ${lastErr.message}`);
}
 
// amountLamports: how much SOL (in lamports) to spend.
// Returns the raw Jupiter quote object, or null if Jupiter genuinely has
// no route for this pair. Throws (doesn't return null) if the request
// itself couldn't complete — callers should not treat that as "no route."
export async function getQuote({ outputMint, amountLamports, slippageBps }) {
  const url =
    `${QUOTE_URL}?inputMint=${SOL_MINT}&outputMint=${outputMint}` +
    `&amount=${amountLamports}&slippageBps=${slippageBps}`;
  const res = await fetchWithRetry(url);
  if (res.status === 400) return null; // Jupiter's "no route found" response
  if (!res.ok) {
    throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (!json || json.error || !json.outAmount) return null;
  return json;
}
 
// quote: a quote object from getQuote(), still fresh.
// userPublicKey: base58 treasury wallet address.
// Returns { swapTransaction, lastValidBlockHeight } — swapTransaction is a
// base64-encoded versioned transaction ready to be deserialized and signed.
export async function getSwapTransaction({ quote, userPublicKey }) {
  const res = await fetchWithRetry(SWAP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Jupiter swap build failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
 
// Human-readable price impact, e.g. "2.4%". Jupiter returns this as a
// decimal string like "0.024".
export function priceImpactPercent(quote) {
  return Math.abs(Number(quote.priceImpactPct || 0)) * 100;
}
 
