// Minimal JSON-RPC client for Solana, shared by the treasury/whale/cycle
// scripts. Retries on rate limits and transient errors.

export function makeRpcClient(rpcUrl) {
  let id = 0;

  async function rpc(method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await fetch(rpcUrl, {
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

  return { rpc };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export const LAMPORTS_PER_SOL = 1_000_000_000;

// Every confirmed signature for `address` newer than `untilSignature`,
// oldest-first (so accumulation happens in chronological order).
export async function fetchNewSignatures(rpc, address, untilSignature) {
  const collected = [];
  let before;
  const PAGE_SIZE = 1000;
  for (;;) {
    const page = await rpc("getSignaturesForAddress", [
      address,
      { limit: PAGE_SIZE, before, until: untilSignature || undefined },
    ]);
    if (!page || page.length === 0) break;
    collected.push(...page);
    if (page.length < PAGE_SIZE) break;
    before = page[page.length - 1].signature;
  }
  return collected.filter((s) => !s.err).reverse().map((s) => s.signature);
}
