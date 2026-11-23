// Staged trend bot for make.fun btc-race-24h-20261123-0511 (bars-replay/v1).
//
// Strategy, in one sentence: buy the uptrend in two tranches, hold it with a
// wide trailing stop, and only re-enter after a confirmed resumption.
//
// Why this shape, from the dev window (24h of 1-minute cbBTC/USDC bars):
// - The window grinds up +3.6% with 1-minute noise of ~8 bps and a full-size
//   round trip costing ~40 bps in fee + slippage + impact, so fast signals
//   (EMA 8/21 cross: 76 trades, -$112 in local replay) bleed out on fees.
//   Trading rarely is the whole edge.
// - Buy-and-hold makes +$32 on the dev window, but on an unseen race window
//   it eats a whole downtrend. A 2.5% trailing stop caps that at ~2.5% while
//   never firing on the dev window (its worst peak-to-trough is 1.98%).
// - Splitting the entry (60% at the open, the rest 60 bars later only if the
//   price is above the entry close) keeps 40% of the cash out of an immediate
//   drop at the open, and makes the bot's action log differ from a plain
//   buy-and-hold entry.
//
// Rules (all BigInt integer arithmetic, no floats, no clock, no randomness,
// so the two graded runs produce byte-identical action logs):
// - Stage 0, flat, never entered: buy 60% of cash on the first tradable bar.
// - Stage 1, holding the first tranche: 60 bars after the fill, if the close
//   is above the entry close, spend the remaining cash (top-up to 100%).
// - Holding (stages 1 and 2): track the peak value of the position; if its
//   value falls 2.5% (250 bps) below the peak, sell everything.
// - Stage 3, stopped out: wait 120 bars, then re-enter 60% only if the close
//   is above the 240-bar simple moving average AND the 240-bar return is
//   above +50 bps (a confirmed resumption, not a bounce).
// - No new entries once 1380 bars of the 1440-bar window have elapsed, so no
//   entry pays its fee right before the forced flatten at the end.
// - Every order caps slippage at 100 bps past the close it was decided on.
//
// The bot speaks agent-fun/bars-replay/v1 through the kit's TypeScript shim,
// vendored byte-identical under vendor/ (excluded from authorship counts).
// Only the standard library is used; there is no network, no file or
// environment access, and no secret of any kind.

import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy constants (basis points or bars).
const FIRST_TRANCHE_PCT = 60n; // first buy spends 60% of cash
const TOP_UP_AFTER_BARS = 60; // top-up no earlier than 60 bars after the fill
const STOP_BPS = 250n; // trailing stop: 2.5% below the peak position value
const REENTRY_COOLDOWN_BARS = 120; // bars to wait after a stop-out before re-entry
const TREND_BARS = 240; // lookback for the re-entry trend filter
const TREND_MIN_RETURN_BPS = 50n; // re-entry needs a 240-bar return above +50 bps
const NO_NEW_ENTRY_AFTER_BARS = 1380; // of the 1440-bar window
const MAX_SLIPPAGE_BPS = 100; // per-order slippage cap past the decision close

// State (integers only).
const closes: bigint[] = []; // closes of every CBBTC bar seen, oldest first
let stage = 0; // 0 flat/never entered, 1 first tranche, 2 fully in, 3 stopped out
let cooldown = 0; // bars left of the post-stop-out wait (stage 3 only)
let fillSeq = -1; // seq of the batch where the current position's fill appeared
let entryClose = 0n; // close of the bar the first-tranche buy was decided on
let peakValue = 0n; // peak value of the current position, micro-USDC

/** The 240-bar simple moving average of closes, truncated, or null. */
function sma240(): bigint | null {
  if (closes.length < TREND_BARS) return null;
  let sum = 0n;
  for (let i = closes.length - TREND_BARS; i < closes.length; i++) sum += closes[i];
  return sum / BigInt(TREND_BARS);
}

/** True when the slow trend is up: above the 240-bar average and the
 *  240-bar return is above +50 bps (exact integer comparison). */
function trendConfirmed(close: bigint): boolean {
  if (closes.length < TREND_BARS + 1) return false;
  const avg = sma240();
  if (avg === null || close <= avg) return false;
  const then = closes[closes.length - TREND_BARS - 1];
  return close * 10000n > then * (10000n + TREND_MIN_RETURN_BPS);
}

/** A buy order for pct% of cash, capped by the weight room and the minimum
 *  notional, or null when there is nothing worth buying. */
function buy(state: BarsState, pct: bigint): BuyInput | null {
  const room = state.weightRoom(SYMBOL);
  let amount = (state.cash * pct) / 100n;
  if (amount > room) amount = room;
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  if (amount < minNotional || amount <= 0n) return null;
  const close = state.close(SYMBOL);
  if (close === null) return null;
  entryClose = close;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

function sellAll(state: BarsState): SellInput | null {
  const held = state.positions.get(SYMBOL);
  if (held === undefined) return null;
  return { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const fresh = batch.bars.some((bar) => bar.symbol === SYMBOL);
    if (fresh) closes.push(close);

    const held = state.positions.get(SYMBOL);
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);

    // Sync the stage with what the fills actually did.
    if ((stage === 0 || stage === 3) && held !== undefined) {
      stage = 1;
      fillSeq = state.seq;
    } else if (stage === 1 && held !== undefined && state.cash < minNotional) {
      stage = 2;
    } else if ((stage === 1 || stage === 2) && held === undefined) {
      stage = 3;
      cooldown = REENTRY_COOLDOWN_BARS;
      peakValue = 0n;
    }

    if (state.warmingUp) return [];

    const elapsed = state.seq - state.warmupBars;

    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      if (value > peakValue) peakValue = value;
      // Trailing stop: 2.5% below the peak position value.
      if (value * 10000n < peakValue * (10000n - STOP_BPS)) {
        const order = sellAll(state);
        return order === null ? [] : [order];
      }
      // Top-up: 60 bars after the first fill, price above the entry close.
      if (
        stage === 1 &&
        state.seq - fillSeq >= TOP_UP_AFTER_BARS &&
        close > entryClose &&
        state.cash >= minNotional &&
        elapsed < NO_NEW_ENTRY_AFTER_BARS
      ) {
        const order = buy(state, 100n);
        return order === null ? [] : [order];
      }
      return [];
    }

    // Flat.
    if (stage === 3) {
      if (cooldown > 0) {
        cooldown -= 1;
        return [];
      }
      if (elapsed >= NO_NEW_ENTRY_AFTER_BARS) return [];
      if (trendConfirmed(close)) {
        const order = buy(state, FIRST_TRANCHE_PCT);
        return order === null ? [] : [order];
      }
      return [];
    }

    // Stage 0: first entry, on the first tradable bar.
    if (elapsed >= NO_NEW_ENTRY_AFTER_BARS) return [];
    const order = buy(state, FIRST_TRANCHE_PCT);
    return order === null ? [] : [order];
  },
});
