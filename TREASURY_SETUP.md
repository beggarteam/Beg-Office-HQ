# Treasury wallet setup

You chose a dedicated hot wallet: a wallet used only for Proof of Begging,
whose private key is stored as a GitHub secret so the automation can sign
the end-of-cycle payout transactions without you doing anything by hand.

Treat this key the way you'd treat cash in a register, not a savings
account: enough to run the cycle, nothing more, and never reused anywhere
else.

## 1. Create the wallet

Easiest path: create a brand new wallet in Phantom or Solflare (or any
Solana wallet app), specifically for this. Do not reuse a wallet that holds
anything else.

- In Phantom: Settings -> Manage Accounts -> Add / Connect Wallet -> Create
  New Wallet.
- Once created, open that account's settings -> Export Private Key. It'll
  give you a private key in base58 form (a long string of letters and
  numbers, not a list of numbers in brackets). That base58 string is what
  goes into the GitHub secret below.
- Copy the wallet's public address too (the one you'd send SOL to).

## 2. Tell the site which wallet this is

Edit `data/config.json` and set:

```json
"treasuryWallet": "the wallet's public address here"
```

Commit that change. `update-treasury.yml` and `cycle-engine.yml` will start
tracking it on their next run.

## 3. Store the private key as a GitHub secret

In your repo: Settings -> Secrets and variables -> Actions -> New repository
secret.

- Name: `TREASURY_PRIVATE_KEY`
- Value: the base58 private key you exported in step 1

This secret is encrypted at rest and is only ever decrypted inside a
workflow run, it's never exposed in logs or visible to anyone browsing the
repo, including you, once saved.

## 4. Fund it, modestly

Only send this wallet what you need for the upcoming cycle (plus a small
buffer, `data/config.json`'s `treasuryReserveSol` reserves 0.02 SOL by
default to cover its own transaction fees and stay above the rent-exempt
minimum). Trading-fee sweeps from pump.fun and community donations both flow
into this same address, that's expected and is exactly what the treasury
balance widget and whale tracker are watching for.

## 5. Starting and ending a cycle

Starting a cycle: edit `data/cycle.json` by hand:

```json
{
  "cycleId": "2026-08-25",
  "ticker": "$WHATEVER",
  "ca": "the coin's contract address",
  "startedAt": "2026-08-25T00:00:00Z",
  "endsAt": "2026-08-26T00:00:00Z",
  "status": "active"
}
```

`startedAt` / `endsAt` are UTC timestamps, set `endsAt` to however long you
want the cycle to run (24 hours in the example above). Commit it, and the
site's countdown, treasury tracker, and whale board all pick it up
automatically.

When `endsAt` passes, `cycle-engine.yml` (running every 5 minutes) notices,
pays out 33% equally to every wallet currently listed in `WALLETS` in
`index.html`, logs the cycle to `data/cycles.json`, and sets `status` to
`"distributed"`. The 67% earmarked for the burn stays in the treasury
wallet, untouched, since that part is still manual.

## 6. Doing the manual buy + burn, and recording it

Once you've bought and burned the day's coin yourself, open
`data/cycles.json`, find that cycle's entry (it'll be the last one, with
`"burnTxSignature": null`), and fill in the transaction signature:

```json
"burnTxSignature": "your transaction signature here"
```

Commit it. The Cycle Log page will pick it up and show a working link to
the burn transaction.

Then, whenever you're ready for the next cycle, just edit `data/cycle.json`
again with the new coin and a fresh `endsAt`.

## If the key is ever exposed

Move whatever's in the wallet out immediately, generate a brand new wallet,
repeat steps 1 through 3, and delete the old GitHub secret. Because this
wallet only ever holds one cycle's worth of funds, the damage a leak can do
is naturally capped, that's the whole point of keeping it modest.
