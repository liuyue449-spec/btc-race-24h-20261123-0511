"""Staged trend bot for make.fun btc-race-24h-20261123-0511 (bars-replay/v1).

Strategy, in one sentence: buy the uptrend in two tranches, hold it with a
wide trailing stop, and only re-enter after a confirmed resumption.

Why this shape, from the dev window (24h of 1-minute cbBTC/USDC bars):
- The window grinds up +3.6% with 1-minute noise of ~8 bps and a full-size
  round trip costing ~40 bps in fee + slippage + impact, so fast signals
  (EMA 8/21 cross: 76 trades, -$112 in local replay) bleed out on fees.
  Trading rarely is the whole edge.
- Buy-and-hold makes +$32 on the dev window, but on an unseen race window
  it eats a whole downtrend. A 2.5% trailing stop caps that at ~2.5% while
  never firing on the dev window (its worst peak-to-trough is 1.98%).
- Splitting the entry (60% at the open, the rest 60 bars later only if the
  price is above the entry close) keeps 40% of the cash out of an immediate
  drop at the open, and makes the bot's action log differ from a plain
  buy-and-hold entry.

Rules (all integer arithmetic, no floats, no clock, no randomness, so the
two graded runs produce byte-identical action logs):
- Stage 0, flat, never entered: buy 60% of cash on the first tradable bar.
- Stage 1, holding the first tranche: 60 bars after the fill, if the close
  is above the entry close, spend the remaining cash (top-up to 100%).
- Holding (stages 1 and 2): track the peak value of the position; if its
  value falls 2.5% (250 bps) below the peak, sell everything.
- Stage 3, stopped out: wait 120 bars, then re-enter 60% only if the close
  is above the 240-bar simple moving average AND the 240-bar return is
  above +50 bps (a confirmed resumption, not a bounce).
- No new entries once 1380 bars of the 1440-bar window have elapsed, so no
  entry pays its fee right before the forced flatten at the end.
- Every order caps slippage at 100 bps past the close it was decided on.

The bot speaks agent-fun/bars-replay/v1 through the kit's Python shim,
vendored byte-identical under vendor/ (excluded from authorship counts).
Only the standard library is used; there is no network, no file or
environment access, and no secret of any kind.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
import makefun_bars

SYMBOL = "CBBTC"

# --- strategy constants (all in basis points or bars) ---
FIRST_TRANCHE_PCT = 60        # first buy spends 60% of cash
TOP_UP_AFTER_BARS = 60        # top-up no earlier than 60 bars after the fill
STOP_BPS = 250                # trailing stop: 2.5% below the peak position value
REENTRY_COOLDOWN_BARS = 120   # bars to wait after a stop-out before re-entry
TREND_BARS = 240              # lookback for the re-entry trend filter
TREND_MIN_RETURN_BPS = 50     # re-entry needs a 240-bar return above +50 bps
NO_NEW_ENTRY_AFTER_BARS = 1380  # of the 1440-bar window
MAX_SLIPPAGE_BPS = 100        # per-order slippage cap past the decision close

# --- state (integers only) ---
closes = []            # closes of every CBBTC bar seen, oldest first
stage = 0              # 0 flat/never entered, 1 first tranche, 2 fully in, 3 stopped out
cooldown = 0           # bars left of the post-stop-out wait (stage 3 only)
fill_seq = -1          # seq of the batch where the current position's fill appeared
entry_close = 0        # close of the bar the first-tranche buy was decided on
peak_value = 0         # peak value of the current position, micro-USDC


def _sma_240():
    """The 240-bar simple moving average of closes, truncated, or None."""
    if len(closes) < TREND_BARS:
        return None
    return sum(closes[-TREND_BARS:]) // TREND_BARS


def _trend_confirmed(close):
    """True when the slow trend is up: above the 240-bar average and the
    240-bar return is above +50 bps (exact integer comparison)."""
    if len(closes) < TREND_BARS + 1:
        return False
    avg = _sma_240()
    if avg is None or close <= avg:
        return False
    then = closes[-TREND_BARS - 1]
    return close * 10000 > then * (10000 + TREND_MIN_RETURN_BPS)


def _buy(state, pct):
    """A buy order for pct% of cash, capped by the weight room and the
    minimum notional, or None when there is nothing worth buying."""
    global entry_close
    cash = state.cash
    room = state.weight_room(SYMBOL)
    amount = cash * pct // 100
    if amount > room:
        amount = room
    if amount < int(state.hello["fees"]["min_notional_quote_units"]):
        return None
    if amount <= 0:
        return None
    entry_close = state.close(SYMBOL)
    return {"side": "buy", "symbol": SYMBOL,
            "notional_quote_units": amount,
            "max_slippage_bps": MAX_SLIPPAGE_BPS}


def _sell_all(state):
    held = state.positions.get(SYMBOL)
    if held is None:
        return None
    return {"side": "sell", "symbol": SYMBOL, "qty": held.qty,
            "max_slippage_bps": MAX_SLIPPAGE_BPS}


def on_batch(state, batch):
    global stage, cooldown, fill_seq, peak_value
    close = state.close(SYMBOL)
    if close is None:
        return []
    fresh = any(bar.get("symbol") == SYMBOL for bar in batch.get("bars", []))
    if fresh:
        closes.append(close)

    held = state.positions.get(SYMBOL)

    # Sync the stage with what the fills actually did.
    if stage in (0, 3) and held is not None:
        stage = 1
        fill_seq = state.seq
    elif stage == 1 and held is not None and state.cash < int(
            state.hello["fees"]["min_notional_quote_units"]):
        stage = 2
    elif stage in (1, 2) and held is None:
        stage = 3
        cooldown = REENTRY_COOLDOWN_BARS
        peak_value = 0

    if state.warming_up:
        return []

    elapsed = state.seq - state.warmup_bars

    if held is not None:
        value = state.value(SYMBOL, held.qty)
        if value > peak_value:
            peak_value = value
        # Trailing stop: 2.5% below the peak position value.
        if value * 10000 < peak_value * (10000 - STOP_BPS):
            order = _sell_all(state)
            return [order] if order else []
        # Top-up: 60 bars after the first fill, price above the entry close.
        if (stage == 1 and state.seq - fill_seq >= TOP_UP_AFTER_BARS
                and close > entry_close
                and state.cash >= int(state.hello["fees"]["min_notional_quote_units"])
                and elapsed < NO_NEW_ENTRY_AFTER_BARS):
            order = _buy(state, 100)
            return [order] if order else []
        return []

    # Flat.
    if stage == 3:
        if cooldown > 0:
            cooldown -= 1
            return []
        if elapsed >= NO_NEW_ENTRY_AFTER_BARS:
            return []
        if _trend_confirmed(close):
            order = _buy(state, FIRST_TRANCHE_PCT)
            return [order] if order else []
        return []

    # Stage 0: first entry, on the first tradable bar.
    if elapsed >= NO_NEW_ENTRY_AFTER_BARS:
        return []
    order = _buy(state, FIRST_TRANCHE_PCT)
    return [order] if order else []


makefun_bars.run(on_batch)
