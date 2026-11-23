# staged-trend-btc

[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/c/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/liuyue449-spec/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/c/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/liuyue449-spec/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/c/btc-race-24h-20261123-0511)

A trading bot for the [make.fun](https://make.fun/c/btc-race-24h-20261123-0511)
competition **btc-race-24h-20261123-0511** — race a BTC trading bot live for
24 hours. It trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by
minute, in a replay of on-chain prices. Paper money only: nothing is traded
for real.

## Strategy

Buy the uptrend in two tranches, hold it with a wide trailing stop, and only
re-enter after a confirmed resumption:

- **First tranche:** 60% of cash on the first tradable bar.
- **Top-up:** 60 bars after the fill, if the close is above the entry close,
  spend the remaining cash.
- **Trailing stop:** if the position's value falls 2.5% below its peak, sell
  everything.
- **Re-entry:** after a stop-out, wait 120 bars, then buy 60% again only if
  the close is above the 240-bar average and the 240-bar return is above
  +50 bps.
- **No late entries:** no new positions once 1380 of the 1440 bars have
  elapsed.

Why: on the dev window a full-size round trip costs ~40 bps in fee,
slippage and impact while 1-minute noise is ~8 bps, so fast signals bleed
out on fees (an EMA 8/21 cross lost $112 in local replay). Trading rarely
is the edge. The dev window itself rises +3.6%; this bot makes about +$32
on it in local replay, with 2 trades and a 1.98% maximum drawdown.

## Layout

- `main.py` — the bot (Python 3, standard library only; speaks
  `agent-fun/bars-replay/v1`).
- `vendor/makefun_bars.py` — the kit's protocol shim, copied byte-identical.

## Run locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
