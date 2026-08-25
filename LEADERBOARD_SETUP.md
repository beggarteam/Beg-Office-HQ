# SOL Leaderboard — one-time setup

This adds a "top beggars by lifetime SOL received" leaderboard that updates
itself every 6 hours automatically, with no server to run. It reads wallets
straight out of the `WALLETS` object in `index.html` — the same place you
already edit when you add one — so adding a new beggar's wallet is still
just editing that one line, nothing else.

## How it works

1. A small script (`scripts/update-leaderboard.mjs`) reads `WALLETS` from
   `index.html`, asks Solana (via Helius) for each wallet's transaction
   history, and sums up every incoming SOL transfer, ever — that's
   "lifetime received."
2. It remembers where it left off for each wallet, so every run after the
   first only looks at new transactions — it never re-scans a wallet's full
   history from scratch.
3. A GitHub Action (`.github/workflows/update-leaderboard.yml`) runs that
   script every 6 hours (and also right after you push a change to
   `index.html`), and commits the result to `data/leaderboard.json`.
4. The site fetches `data/leaderboard.json` and renders the ranked list —
   any beggar with a wallet just appears, automatically, in the right spot.

## What you need to do, once

1. **Get a free Helius API key** — sign up at helius.dev, create a project,
   copy the API key it gives you.
2. **Add it as a GitHub secret** — in your `beg-office` repo, go to
   Settings → Secrets and variables → Actions → New repository secret.
   Name it exactly `HELIUS_API_KEY` and paste the key as the value.
3. **Add these files to your repo** (same folder as `index.html`):
   - `scripts/update-leaderboard.mjs`
   - `.github/workflows/update-leaderboard.yml`
   - `data/leaderboard.json` (a placeholder — the Action overwrites it)
4. **Commit and push.** The workflow will run automatically on that push
   (because it watches for changes to `index.html`), or you can trigger it
   right away from the Actions tab → "Update SOL leaderboard" → "Run
   workflow", so you don't have to wait.
5. Check the Actions tab for a green checkmark, then reload the site — the
   leaderboard section should populate.

## Adding beggars and wallets going forward

Nothing changes about your existing workflow — paste the X profile URL into
`PROFILES` and the wallet address into `WALLETS`, same as always. The
leaderboard picks it up on the next scheduled run (or immediately, since a
push to `index.html` triggers a run).
