// Reads the WALLETS object straight out of index.html — the single source
// of truth you already edit when you add a beggar's wallet.

import { readFile } from "node:fs/promises";

export async function loadWalletsFromIndexHtml(indexHtmlPath) {
  const html = await readFile(indexHtmlPath, "utf8");
  const match = html.match(/const\s+WALLETS\s*=\s*(\{[\s\S]*?\n\s*\})\s*;/);
  if (!match) {
    throw new Error("Could not find `const WALLETS = { ... };` in index.html");
  }
  // Safe: this is our own repo's own file, evaluated in our own CI job.
  const wallets = new Function(`return (${match[1]});`)();
  return Object.entries(wallets).filter(
    ([, addr]) => typeof addr === "string" && addr.trim().length > 0
  ); // [[handle, address], ...]
}
