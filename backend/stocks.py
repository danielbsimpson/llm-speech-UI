"""
backend/stocks.py
Market data fetching via yfinance (Yahoo Finance — free, no API key).
Covers equities, ETFs, indices, crypto pairs, and forex.
Exposes GET /stocks and DELETE /stocks/cache.
"""

import asyncio
import os
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import yfinance as yf
from fastapi import APIRouter

router = APIRouter()

# ── Config ────────────────────────────────────────────────────────────────────
_STOCKS_ENV    = os.getenv("STOCKS_WATCHLIST",    "NVDA,AAPL,MSFT,SPY,QQQ")
_CRYPTO_ENV    = os.getenv("CRYPTO_WATCHLIST",    "BTC-USD,ETH-USD")
_CACHE_SECONDS = int(os.getenv("STOCKS_CACHE_SECONDS", "300"))
_CURRENCY_SYM  = os.getenv("STOCKS_CURRENCY_SYMBOL", "$")

# ── In-memory cache ───────────────────────────────────────────────────────────
_cache: dict = {}

# ── Market hours (NYSE) ───────────────────────────────────────────────────────
_NYSE_TZ = ZoneInfo("America/New_York")


def _is_us_market_open() -> bool:
    """Return True if the NYSE regular session is currently open (Mon-Fri 09:30-16:00 ET)."""
    now          = datetime.now(_NYSE_TZ)
    if now.weekday() >= 5:
        return False
    market_open  = now.replace(hour=9,  minute=30, second=0, microsecond=0)
    market_close = now.replace(hour=16, minute=0,  second=0, microsecond=0)
    return market_open <= now <= market_close


# ── Formatting helpers ────────────────────────────────────────────────────────

def _fmt_price(val, sym: str = "$") -> str:
    if val is None:
        return "—"
    if val >= 1_000:
        return f"{sym}{val:,.2f}"
    if val >= 1:
        return f"{sym}{val:.2f}"
    return f"{sym}{val:.4f}"   # small-denomination crypto


def _fmt_change(chg, pct) -> dict:
    if chg is None or pct is None:
        return {"value": "—", "pct": "—", "direction": "flat"}
    direction = "up" if pct > 0 else "down" if pct < 0 else "flat"
    sign      = "+" if chg >= 0 else ""
    return {
        "value":     f"{sign}{_fmt_price(abs(chg), '')}",
        "pct":       f"{'+' if pct >= 0 else ''}{pct:.2f}%",
        "direction": direction,
    }


def _fmt_large(val) -> str:
    """Format large numbers (market cap, volume) as T / B / M."""
    if val is None:
        return "—"
    if val >= 1e12:
        return f"{val / 1e12:.2f}T"
    if val >= 1e9:
        return f"{val / 1e9:.2f}B"
    if val >= 1e6:
        return f"{val / 1e6:.2f}M"
    return f"{val:,.0f}"


def _ticker_type(symbol: str) -> str:
    s = symbol.upper()
    if s.endswith("-USD") or s.endswith("-USDT") or s.endswith("-BTC"):
        return "crypto"
    if s.endswith("=X"):
        return "forex"
    if s.startswith("^"):
        return "index"
    return "equity"


# ── Data fetch ────────────────────────────────────────────────────────────────

def _fetch_ticker(symbol: str) -> dict | None:
    """Fetch current quote for a single ticker. Returns None on any failure."""
    try:
        t    = yf.Ticker(symbol)
        info = t.fast_info   # lightweight — no full OHLCV history download

        price = info.last_price
        prev  = info.previous_close

        if price is None:
            return None

        chg = (price - prev) if prev else None
        pct = ((price - prev) / prev * 100) if prev else None

        name = (
            getattr(info, "display_name", None)
            or symbol.replace("-USD", "").replace("=X", "").replace("^", "")
        )

        week52_low  = getattr(info, "year_low",  None)
        week52_high = getattr(info, "year_high", None)

        return {
            "symbol":      symbol,
            "name":        name,
            "type":        _ticker_type(symbol),
            "price":       price,
            "price_fmt":   _fmt_price(price, _CURRENCY_SYM),
            "prev_close":  prev,
            "change":      _fmt_change(chg, pct),
            "pct_raw":     round(pct, 2) if pct is not None else None,
            "week52_low":  _fmt_price(week52_low,  _CURRENCY_SYM),
            "week52_high": _fmt_price(week52_high, _CURRENCY_SYM),
            "volume":      _fmt_large(getattr(info, "three_month_average_volume", None)),
            "market_cap":  _fmt_large(getattr(info, "market_cap", None)),
            "currency":    getattr(info, "currency", "USD"),
        }
    except Exception as exc:
        print(f"[stocks] failed to fetch {symbol}: {exc}")
        return None


def _build_llm_context(tickers: list, market_open: bool) -> str:
    """
    Build a compact plain-prose market summary for LLM injection.
    """
    now_et = datetime.now(_NYSE_TZ)
    # Windows-safe time formatting (avoid %-d / %-I which are Linux-only)
    hour_str = str(now_et.hour % 12 or 12)
    ampm     = "AM" if now_et.hour < 12 else "PM"
    day_name = now_et.strftime("%A")
    month    = now_et.strftime("%B")
    day      = str(now_et.day)

    session_label = (
        f"Markets are currently open ({hour_str}:{now_et.strftime('%M')} {ampm} ET)."
        if market_open else
        f"Markets are closed. Showing last close prices ({day_name}, {month} {day})."
    )

    equities = [t for t in tickers if t["type"] in ("equity", "index", "etf")]
    cryptos  = [t for t in tickers if t["type"] == "crypto"]

    lines = [
        f"[MARKET DATA — {hour_str}:{now_et.strftime('%M')} {ampm} ET, {day_name} {month} {day}]",
        session_label,
    ]

    if equities:
        lines.append("Equities and indices:")
        for t in equities:
            lines.append(
                f"  {t['symbol']}: {t['price_fmt']}  {t['change']['pct']} ({t['change']['direction']})"
            )

    if cryptos:
        lines.append("Crypto:")
        for t in cryptos:
            label = t["symbol"].replace("-USD", "").replace("-USDT", "")
            lines.append(
                f"  {label}: {t['price_fmt']}  {t['change']['pct']} ({t['change']['direction']})"
            )

    # Notable movers (>= 2% in either direction)
    movers = sorted(
        [t for t in tickers if t["pct_raw"] is not None and abs(t["pct_raw"]) >= 2.0],
        key=lambda x: abs(x["pct_raw"]),
        reverse=True,
    )
    if movers:
        mover_strs = [
            f"{t['symbol']} {'+' if t['pct_raw'] > 0 else ''}{t['pct_raw']:.1f}%"
            for t in movers[:4]
        ]
        lines.append(f"Notable movers: {', '.join(mover_strs)}.")

    return "\n".join(lines)


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/stocks")
async def get_stocks():
    """
    Return live price data for the configured stocks and crypto watchlist.
    Tickers are fetched in parallel; results are cached for STOCKS_CACHE_SECONDS.
    """
    cache_key = "stocks_default"
    cached    = _cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_SECONDS:
        return cached["data"]

    symbols = (
        [s.strip() for s in _STOCKS_ENV.split(",") if s.strip()] +
        [s.strip() for s in _CRYPTO_ENV.split(",")  if s.strip()]
    )

    # yfinance is synchronous — run each ticker in a thread pool
    loop    = asyncio.get_event_loop()
    results = await asyncio.gather(
        *[loop.run_in_executor(None, _fetch_ticker, sym) for sym in symbols],
        return_exceptions=True,
    )

    tickers = [r for r in results if isinstance(r, dict)]
    failed  = [symbols[i] for i, r in enumerate(results) if not isinstance(r, dict)]

    market_open = _is_us_market_open()

    data = {
        "tickers":      tickers,
        "failed":       failed,
        "total":        len(tickers),
        "market_open":  market_open,
        "llm_context":  _build_llm_context(tickers, market_open),
        "fetched_at":   datetime.now(timezone.utc).isoformat(),
        "currency_sym": _CURRENCY_SYM,
    }

    _cache[cache_key] = {"ts": time.time(), "data": data}
    return data


@router.delete("/stocks/cache")
async def bust_stocks_cache():
    """Force-clear the stocks cache so the next GET /stocks fetches live data."""
    _cache.clear()
    return {"status": "cleared"}
