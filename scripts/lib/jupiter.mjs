// Thin wrapper around Jupiter's public swap API (https://jup.ag), which
// aggregates Raydium, Orca, and most other Solana DEXs behind one HTTP
// endpoint. Used to price and build the "buy the target coin with treasury
// SOL" leg of the burn. Jupiter only routes through pools it has indexed —
// a brand-new coin still on pump.fun's bonding curve (not yet migrated to
// a DEX) will come back as "no route," which prepare-burn.mjs treats as
// "needs manual attention," not an error.

export const SOL_MINT = "So11111111111111111111111111111111111111112";

const QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const SWAP_URL = "https://quote-api.jup.ag/v6/swap";

// amountLamports: how much SOL (in lamports) to spend.
// Returns the raw Jupiter quote object, or null if no route exists.
export async function getQuote({ outputMint, amountLamports, slippageBps }) {
  const url =
    `${QUOTE_URL}?inputMint=${SOL_MINT}&outputMint=${outputMint}` +
    `&amount=${amountLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
  const res = await fetch(url);
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
// Returns { swapTransaction } — a base64-encoded versioned transaction
// ready to be deserialized, signed, and sent.
export async function getSwapTransaction({ quote, userPublicKey }) {
  const res = await fetch(SWAP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
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
