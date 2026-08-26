# Approve-before-execute burn

This adds the buy + burn step, split into two stages so treasury funds only
ever move after you click a button.

**Stage 1 - prepare-burn.mjs** runs automatically every 5 minutes as part
of the existing cycle engine, right after the payout check. It never
touches the treasury private key and never sends a transaction. For the
most recent cycle that hasn't been burned yet, it asks Jupiter (a Solana
swap aggregator that routes across Raydium, Orca, and most other DEXs) for
a live price quote on swapping the budgeted burn amount of SOL into the
target coin, and writes the result to `data/pending-burn.json`. That's the
only file it touches.

**Stage 2 - execute-burn.mjs** is the only step that spends anything, and
it only ever runs when you manually click "Run workflow" on "Execute burn
(manual approval)" in the Actions tab. It re-checks the price right before
spending (in case time has passed since the quote), builds and sends the
swap, waits for it to confirm, then burns the full amount of the coin the
treasury just received. If it fails partway (say, the swap goes through but
the burn transaction times out), running it again resumes from the burn
step instead of buying a second time.

## 1. New config, already set with sane defaults

`data/config.json` now has two new keys:

```json
"burnSlippageBps": 300,
"burnMaxPriceImpactPct": 15
```

`burnSlippageBps` (300 = 3%) is how much the price is allowed to move
between quoting and the swap actually landing on-chain, standard for a
memecoin swap. `burnMaxPriceImpactPct` (15%) is a hard ceiling: if buying
that much SOL worth of the coin would move its own price by more than that
(a sign the pool is too thin for the size), both stages refuse to proceed
and flag it for you to look at instead of buying at a terrible price.
Loosen or tighten either number to taste.

## 2. Nothing new to set up in GitHub

The burn step reuses the same two secrets you already added
(`HELIUS_API_KEY` and `TREASURY_PRIVATE_KEY`) and the same treasury wallet
from `data/config.json`. There's no new account, key, or service to
configure, just two new script files and two workflow changes.

## 3. What you'll actually see, cycle to cycle

Once a cycle ends and gets paid out (same as before, no change there),
within 5 minutes `pending-burn.json` gets a quote and a `burn-approval`
banner appears on the site itself, right under the cycle panel, showing
something like:

0.126 SOL -> ~48,200 $TICKER · 2.1% price impact
Review it, then approve from the GitHub Actions tab to execute.


If Jupiter can't find a route yet (common for a coin that just launched and
hasn't migrated off pump.fun's bonding curve), or the price impact is above
your ceiling, the banner stays hidden and `pending-burn.json` will say
`"no-route"` or `"price-impact-too-high"` instead, that's your cue to
either wait a bit for more liquidity, handle that one manually, or adjust
`burnMaxPriceImpactPct`.

## 4. Approving

When the numbers look right: repo -> Actions tab -> "Execute burn (manual
approval)" -> Run workflow. That's the entire approval step. It'll take a
minute or two to swap, confirm, burn, confirm again, and commit the result.
Both the buy and burn transaction signatures get written into
`data/cycles.json` for that cycle automatically, and both then show up as
links on the Cycle Log page, no manual pasting needed anymore.

## 5. If something goes wrong mid-run

Check the failed run's log in the Actions tab, it prints exactly which step
it got to. If the swap succeeded but the burn didn't, `pending-burn.json`
will show `"swap-done-burn-pending"`, just click "Run workflow" again, it
picks up at the burn step rather than buying twice. If it says
`"executed"` already, it means a previous run finished; running it again is
safe, it'll refuse and exit without doing anything.
