# Stocks & Crypto Tracker — Implementation Guide

Adds a voice-triggered market panel that activates on phrases like *"display stocks"* or *"check
crypto"*, fetches live price data for a user-configured watchlist using `yfinance` (Yahoo Finance —
free, no API key, no account), renders a HUD-style ticker grid inside the S.T.A.R.L.I.N.G. UI,
and injects a structured market summary into the LLM context so Starling can deliver a spoken
briefing on current portfolio positions.

---

## Overview

```
Microphone → Whisper STT → [intercept transcript] → /stocks (FastAPI)
                                    ↓                      ↓
                           open market panel         yfinance (Yahoo Finance)
                                    ↓                      ↓
                           render ticker grid ← prices JSON
                                    ↓
                           sendToOllama() with market context injected
                                    ↓
                           Kokoro TTS spoken briefing
```

Both stocks and crypto are handled by the same backend endpoint and frontend panel — Yahoo Finance
serves both equity tickers (`AAPL`, `NVDA`) and crypto pairs (`BTC-USD`, `ETH-USD`) through the
same `yfinance` interface.

---

## Architecture Decisions

| Decision | Choice | Reason |
|---|---|---|
| Market data source | `yfinance` (Yahoo Finance) | Completely free, no API key, no account; covers equities, ETFs, indices, crypto, and forex |
| Crypto support | Native via `yfinance` (e.g. `BTC-USD`) | No separate crypto API needed |
| Watchlist config | `STOCKS_WATCHLIST` and `CRYPTO_WATCHLIST` in `.env` | User adds/removes tickers without touching code |
| Price data fetched | Last close + current / real-time quote, % change, 5-day mini-trend | Enough for a meaningful spoken summary without overloading context |
| Caching | 5-minute in-memory cache | Yahoo Finance rate-limits aggressive polling; 5 min is fresh enough for a personal briefing |
| Market hours awareness | `is_market_open` flag in response | LLM is told whether markets are live or showing prior close, preventing "prices are wrong" confusion |
| Backend vs. frontend fetch | Backend (`stocks.py`) | Keeps `yfinance` server-side; no CORS issues; centralises caching |

---

## Step 1 — Add `.env` Variables

In `.env` (and `.env.example`), add:

```
# ── Stocks & Crypto ──────────────────────────────────────────────────────────
# Comma-separated Yahoo Finance ticker symbols.
# Equities / ETFs / Indices: AAPL, NVDA, MSFT, SPY, QQQ, ^GSPC (S&P 500)
# Crypto pairs: BTC-USD, ETH-USD, SOL-USD
# Forex: EURUSD=X, GBPUSD=X
STOCKS_WATCHLIST=NVDA,AAPL,MSFT,SPY,QQQ
CRYPTO_WATCHLIST=BTC-USD,ETH-USD

# Cache duration in seconds (default 5 minutes)
STOCKS_CACHE_SECONDS=300

# Currency symbol displayed in the UI (default $)
STOCKS_CURRENCY_SYMBOL=$
```

---

## Step 2 — Install Python Dependency

```powershell
.venv\Scripts\Activate.ps1
pip install yfinance
```

Add to `requirements.txt`:

```
yfinance>=0.2.54
```

`yfinance` pulls in `pandas`, `requests`, and `multitasking` automatically. These are already
common in data science environments; if any are absent they will be installed as dependencies.

---

## Step 3 — Create `backend/stocks.py`

Create a new file `backend/stocks.py`. This file owns all market data logic: ticker fetching,
formatting, market-hours detection, caching, and the FastAPI router.

```python
"""
backend/stocks.py
Market data fetching via yfinance (Yahoo Finance — free, no API key).
Covers equities, ETFs, indices, crypto pairs, and forex.
Exposes GET /stocks.
"""

import os
import time
from datetime import datetime, timezone, date
from zoneinfo import ZoneInfo

import yfinance as yf
from fastapi import APIRouter

router = APIRouter()

# ── Config ────────────────────────────────────────────────────────────────────
_STOCKS_ENV     = os.getenv("STOCKS_WATCHLIST", "NVDA,AAPL,MSFT,SPY,QQQ")
_CRYPTO_ENV     = os.getenv("CRYPTO_WATCHLIST", "BTC-USD,ETH-USD")
_CACHE_SECONDS  = int(os.getenv("STOCKS_CACHE_SECONDS", "300"))
_CURRENCY_SYM   = os.getenv("STOCKS_CURRENCY_SYMBOL", "$")

# ── In-memory cache ───────────────────────────────────────────────────────────
_cache: dict = {}

# ── Market hours detection ────────────────────────────────────────────────────
_NYSE_TZ = ZoneInfo("America/New_York")


def _is_us_market_open() -> bool:
    """Return True if the NYSE regular session is currently open (Mon-Fri, 09:30-16:00 ET)."""
    now = datetime.now(_NYSE_TZ)
    if now.weekday() >= 5:           # Saturday or Sunday
        return False
    market_open  = now.replace(hour=9,  minute=30, second=0, microsecond=0)
    market_close = now.replace(hour=16, minute=0,  second=0, microsecond=0)
    return market_open <= now <= market_close


# ── Formatting helpers ────────────────────────────────────────────────────────

def _fmt_price(val: float | None, sym: str = "$") -> str:
    if val is None:
        return "—"
    if val >= 1_000:
        return f"{sym}{val:,.2f}"
    if val >= 1:
        return f"{sym}{val:.2f}"
    return f"{sym}{val:.4f}"   # small-cap crypto like SHIB


def _fmt_change(chg: float | None, pct: float | None) -> dict:
    if chg is None or pct is None:
        return {"value": "—", "pct": "—", "direction": "flat"}
    direction = "up" if pct > 0 else "down" if pct < 0 else "flat"
    return {
        "value":     f"{'+' if chg >= 0 else ''}{_fmt_price(abs(chg), '')}{'' if chg >= 0 else ''}",
        "pct":       f"{'+' if pct >= 0 else ''}{pct:.2f}%",
        "direction": direction,
    }


def _fmt_large(val: float | None) -> str:
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
    """Fetch current quote data for a single ticker. Returns None on failure."""
    try:
        t    = yf.Ticker(symbol)
        info = t.fast_info   # lightweight — does not download full history

        price = info.last_price
        prev  = info.previous_close

        if price is None:
            return None

        chg = (price - prev) if prev else None
        pct = ((price - prev) / prev * 100) if prev else None

        # Short name falls back gracefully
        name = (
            getattr(info, "display_name", None)
            or symbol.replace("-USD", "").replace("=X", "").replace("^", "")
        )

        # 52-week range — may be None for very new listings
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
    except Exception:
        return None


def _build_llm_context(tickers: list[dict], market_open: bool) -> str:
    """
    Build a compact plain-prose market summary for LLM injection.
    Covers: overall session tone, notable movers, crypto snapshot.
    """
    now_et = datetime.now(_NYSE_TZ)
    session_label = (
        "Markets are currently open."
        if market_open else
        f"Markets are closed. Showing last close prices ({now_et.strftime('%A, %B %-d')})."
    )

    equities = [t for t in tickers if t["type"] in ("equity", "index", "etf")]
    cryptos  = [t for t in tickers if t["type"] == "crypto"]

    lines = [f"[MARKET DATA — {now_et.strftime('%-I:%M %p ET, %A %B %-d')}]", session_label]

    if equities:
        lines.append("Equities and indices:")
        for t in equities:
            lines.append(
                f"  {t['symbol']}: {t['price_fmt']}  {t['change']['pct']} "
                f"({t['change']['direction']})"
            )

    if cryptos:
        lines.append("Crypto:")
        for t in cryptos:
            lines.append(
                f"  {t['symbol'].replace('-USD','')}: {t['price_fmt']}  {t['change']['pct']} "
                f"({t['change']['direction']})"
            )

    # Notable movers (> 2% move in either direction)
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
    Cached for STOCKS_CACHE_SECONDS.
    """
    cache_key = "stocks_default"
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_SECONDS:
        return cached["data"]

    import asyncio
    from functools import partial

    symbols = (
        [s.strip() for s in _STOCKS_ENV.split(",") if s.strip()] +
        [s.strip() for s in _CRYPTO_ENV.split(",") if s.strip()]
    )

    # Run yfinance calls in a thread pool — yfinance is synchronous
    loop = asyncio.get_event_loop()
    tasks = [loop.run_in_executor(None, _fetch_ticker, sym) for sym in symbols]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    tickers = [r for r in results if isinstance(r, dict) and r is not None]
    failed  = [symbols[i] for i, r in enumerate(results) if not isinstance(r, dict)]

    market_open = _is_us_market_open()

    data = {
        "tickers":     tickers,
        "failed":      failed,
        "total":       len(tickers),
        "market_open": market_open,
        "llm_context": _build_llm_context(tickers, market_open),
        "fetched_at":  datetime.now(timezone.utc).isoformat(),
        "currency_sym": _CURRENCY_SYM,
    }

    _cache[cache_key] = {"ts": time.time(), "data": data}
    return data


@router.delete("/stocks/cache")
async def bust_stocks_cache():
    """Force-clear the stocks cache for an immediate re-fetch."""
    _cache.clear()
    return {"status": "cleared"}
```

---

## Step 4 — Register the Router in `backend/main.py`

In `backend/main.py`, alongside the other router imports:

```python
from stocks import router as stocks_router
app.include_router(stocks_router)
```

---

## Step 5 — Add the Market Panel HTML

In `frontend/index.html`, inside `.starling` alongside the other panels:

```html
<!-- Market Panel — hidden until stocks / crypto mode is active -->
<div class="mkt-panel hidden" id="mkt-panel">
  <div class="mkt-header">
    <div class="mkt-title">MARKET WATCH</div>
    <div class="mkt-status" id="mkt-status">—</div>
  </div>

  <!-- Filter tabs: ALL | STOCKS | CRYPTO -->
  <div class="mkt-tabs">
    <button class="mkt-tab active" data-filter="all">ALL</button>
    <button class="mkt-tab" data-filter="equity">STOCKS</button>
    <button class="mkt-tab" data-filter="crypto">CRYPTO</button>
    <button class="mkt-tab" data-filter="index">INDICES</button>
  </div>

  <!-- Ticker grid — populated dynamically -->
  <div class="mkt-grid" id="mkt-grid"></div>

  <div class="mkt-footer">
    <button class="mkt-refresh-btn" id="mkt-refresh-btn">↻ REFRESH</button>
    <span class="mkt-fetched" id="mkt-fetched">—</span>
  </div>
</div>
```

---

## Step 6 — Add the CSS

Append to `frontend/style.css`:

```css
/* ── Market Panel ─────────────────────────────────────────────────────────────── */

.mkt-panel {
  width: 100%;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 16px 20px 14px;
  margin-top: 12px;
  animation: weatherFadeIn 0.35s ease;   /* reuses keyframe from weather panel */
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mkt-panel.hidden {
  display: none;
}

.mkt-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  padding-bottom: 8px;
}

.mkt-title {
  font-family: 'Share Tech Mono', monospace;
  font-size: clamp(0.75rem, 1.4vw, 0.95rem);
  color: #e0e0e0;
  letter-spacing: 0.14em;
}

.mkt-status {
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  font-family: 'Share Tech Mono', monospace;
}

.mkt-status[data-open="true"]  { color: #88ffaa; }   /* green — market open  */
.mkt-status[data-open="false"] { color: #ff8888; }   /* red   — market closed */

/* Filter tabs */
.mkt-tabs {
  display: flex;
  gap: 6px;
}

.mkt-tab {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 5px;
  color: #777;
  cursor: pointer;
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.6rem;
  letter-spacing: 0.1em;
  padding: 3px 9px;
  transition: background 0.15s, color 0.15s;
}

.mkt-tab:hover  { background: rgba(255,255,255,0.08); color: #ccc; }
.mkt-tab.active { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.2); color: #e0e0e0; }

/* Ticker grid — responsive: 2 cols on narrow, 3+ cols on wide */
.mkt-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}

.mkt-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 7px;
  transition: background 0.12s;
}

.mkt-card:hover { background: rgba(255, 255, 255, 0.05); }

.mkt-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 4px;
}

.mkt-card-symbol {
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.78rem;
  color: #e0e0e0;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.mkt-card-type {
  font-size: 0.52rem;
  color: #555;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding-top: 2px;
}

.mkt-card-price {
  font-family: 'Share Tech Mono', monospace;
  font-size: clamp(0.9rem, 2vw, 1.15rem);
  color: #ffffff;
  line-height: 1;
}

.mkt-card-change {
  font-size: 0.72rem;
  font-family: 'Share Tech Mono', monospace;
}

/* Colour the % change by direction */
.mkt-card-change[data-direction="up"]   { color: #88ffaa; }
.mkt-card-change[data-direction="down"] { color: #ff8888; }
.mkt-card-change[data-direction="flat"] { color: #888;    }

.mkt-card-name {
  font-size: 0.62rem;
  color: #555;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mkt-card-52w {
  font-size: 0.6rem;
  color: #444;
  margin-top: 2px;
}

/* Footer */
.mkt-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  padding-top: 8px;
}

.mkt-refresh-btn {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 5px;
  color: #777;
  cursor: pointer;
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  padding: 4px 10px;
  transition: background 0.15s, color 0.15s;
}

.mkt-refresh-btn:hover { background: rgba(255,255,255,0.08); color: #bbb; }

.mkt-fetched {
  font-size: 0.58rem;
  color: #444;
  letter-spacing: 0.08em;
}
```

---

## Step 7 — Create `frontend/stocks-panel.js`

```javascript
// frontend/stocks-panel.js
// Market panel: trigger detection, data fetch, render, and LLM context export.

const BACKEND_BASE_MKT = 'http://localhost:8000';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const mktPanel      = document.getElementById('mkt-panel');
const mktStatus     = document.getElementById('mkt-status');
const mktGrid       = document.getElementById('mkt-grid');
const mktFetched    = document.getElementById('mkt-fetched');
const mktRefreshBtn = document.getElementById('mkt-refresh-btn');
const mktTabBtns    = document.querySelectorAll('.mkt-tab');

// ── State ─────────────────────────────────────────────────────────────────────
let _mktData      = null;
let _activeFilter = 'all';

// ── Filter tab wiring ─────────────────────────────────────────────────────────
mktTabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!_mktData) return;
    _activeFilter = btn.dataset.filter;
    mktTabBtns.forEach(b => b.classList.toggle('active', b === btn));
    _renderGrid(_mktData.tickers);
  });
});

// ── Refresh button ────────────────────────────────────────────────────────────
mktRefreshBtn?.addEventListener('click', async () => {
  mktRefreshBtn.textContent = '↻ FETCHING…';
  mktRefreshBtn.disabled = true;
  await fetch(`${BACKEND_BASE_MKT}/stocks/cache`, { method: 'DELETE' }).catch(() => {});
  await openMarketPanel(true);
  mktRefreshBtn.textContent = '↻ REFRESH';
  mktRefreshBtn.disabled = false;
});

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Check a Whisper transcript for a market / stocks / crypto trigger.
 * Returns 'stocks', 'crypto', or 'all' if matched; null if no match.
 *
 * Activation phrases:
 *   "display stocks"         → 'all'
 *   "check stocks"           → 'all'
 *   "market update"          → 'all'
 *   "how are stocks doing"   → 'all'
 *   "show me crypto"         → 'crypto'
 *   "Bitcoin price"          → 'crypto'
 *   "check NVIDIA"           → 'stocks'  (specific ticker mention)
 */
export function detectMarketTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  // Crypto-specific
  const cryptoPatterns = [
    /\b(?:show|check|what(?:'s| is)|display|get)\b.{0,20}\bcrypto\b/,
    /\bcrypto(?:\s+(?:prices?|update|market|portfolio))?\b/,
    /\b(?:bitcoin|ethereum|btc|eth|solana|sol)\b.{0,20}\bprice\b/,
    /\bprice\s+of\s+(?:bitcoin|ethereum|btc|eth|solana)\b/,
  ];
  if (cryptoPatterns.some(p => p.test(t))) return 'crypto';

  // Stocks / general market
  const stockPatterns = [
    /\b(?:display|show|check|pull up|open|what(?:'s| is))\b.{0,20}\bstocks?\b/,
    /\bstock(?:\s+(?:prices?|market|update|portfolio|watchlist))?\b/,
    /\bmarket\s+(?:update|summary|overview|report|check)\b/,
    /\bhow\s+(?:are|is)\s+(?:the\s+)?(?:markets?|stocks?)\b/,
    /\bmarket(?:s)?\s+(?:today|now|open|close|up|down)\b/,
    /\bportfolio\b/,
    /\b(?:NVDA|AAPL|MSFT|SPY|QQQ|TSLA|AMZN|GOOG|META|AMD)\b/,  // specific tickers
  ];
  if (stockPatterns.some(p => p.test(t))) return 'stocks';

  // Combined / ambiguous
  const generalPatterns = [
    /\bfinancial\s+(?:update|report|summary|briefing)\b/,
    /\bwhat(?:'s| is)\s+(?:the\s+)?market\b/,
  ];
  if (generalPatterns.some(p => p.test(t))) return 'all';

  return null;
}

// ── Panel open / close ────────────────────────────────────────────────────────

/**
 * Fetch market data and open the panel.
 * @param {boolean} [silent=false] — skip scroll animation (used by refresh button)
 * @param {string}  [filter='all'] — pre-select a filter tab ('all', 'equity', 'crypto')
 * Returns the llm_context string for LLM injection, or null on failure.
 */
export async function openMarketPanel(silent = false, filter = 'all') {
  let data;
  try {
    const res = await fetch(`${BACKEND_BASE_MKT}/stocks`);
    if (!res.ok) throw new Error(`Stocks API ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('[stocks-panel] fetch failed:', err);
    return null;
  }

  _mktData      = data;
  _activeFilter = filter;

  // Set active tab
  mktTabBtns.forEach(b => {
    b.classList.toggle(
      'active',
      b.dataset.filter === filter || (filter === 'stocks' && b.dataset.filter === 'equity')
    );
  });

  _renderPanel(data);
  mktPanel.classList.remove('hidden');
  if (!silent) mktPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  return data.llm_context;
}

export function closeMarketPanel() {
  mktPanel.classList.add('hidden');
  _mktData = null;
}

// ── Render ─────────────────────────────────────────────────────────────────────

function _renderPanel(data) {
  const { market_open, fetched_at, total } = data;

  // Market status badge
  mktStatus.textContent       = market_open ? 'MARKET OPEN' : 'MARKET CLOSED';
  mktStatus.dataset.open      = String(market_open);

  // Fetched timestamp
  const fetchedDate = new Date(fetched_at);
  mktFetched.textContent = `UPDATED ${fetchedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

  _renderGrid(data.tickers);
}

function _renderGrid(tickers) {
  mktGrid.innerHTML = '';

  // Apply active filter
  const filtered = _activeFilter === 'all'
    ? tickers
    : tickers.filter(t => {
        if (_activeFilter === 'equity')  return ['equity', 'etf'].includes(t.type);
        if (_activeFilter === 'crypto')  return t.type === 'crypto';
        if (_activeFilter === 'index')   return t.type === 'index';
        return true;
      });

  if (!filtered.length) {
    mktGrid.innerHTML = '<div style="font-size:0.7rem;color:#444;padding:4px 0;grid-column:1/-1;">No tickers for this filter.</div>';
    return;
  }

  filtered.forEach(t => mktGrid.appendChild(_makeTickerCard(t)));
}

function _makeTickerCard(t) {
  const card = document.createElement('div');
  card.className = 'mkt-card';
  card.innerHTML = `
    <div class="mkt-card-header">
      <span class="mkt-card-symbol">${_esc(t.symbol.replace('-USD','').replace('=X','').replace('^',''))}</span>
      <span class="mkt-card-type">${_esc(t.type)}</span>
    </div>
    <div class="mkt-card-price">${_esc(t.price_fmt)}</div>
    <div class="mkt-card-change" data-direction="${t.change.direction}">
      ${_esc(t.change.pct)}
    </div>
    <div class="mkt-card-name">${_esc(t.name)}</div>
    ${(t.week52_low !== '—' && t.week52_high !== '—')
      ? `<div class="mkt-card-52w">52W: ${_esc(t.week52_low)} – ${_esc(t.week52_high)}</div>`
      : ''}
  `;
  return card;
}

function _esc(str) {
  return (str || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

---

## Step 8 — Wire into `app.js`

### 8a — Import the module

```javascript
import { detectMarketTrigger, openMarketPanel, closeMarketPanel } from './stocks-panel.js';
```

### 8b — Add the intercept block in `mediaRecorder.onstop`

Add the market intercept after the news intercept (or after the last existing intercept block):

```javascript
        // ── Market / stocks / crypto intercept ───────────────────────────
        const _mktTrigger = detectMarketTrigger(transcript);
        if (_mktTrigger) {
          setState('thinking');
          appendMessage('user', transcript);
          // Map trigger type to panel filter tab
          const filterMap = { stocks: 'equity', crypto: 'crypto', all: 'all' };
          const mktContext = await openMarketPanel(false, filterMap[_mktTrigger] ?? 'all');
          if (mktContext) {
            // Build a context-sensitive prompt based on what the user asked for
            const focusHint = _mktTrigger === 'crypto'
              ? 'Focus primarily on the crypto positions in the briefing.'
              : _mktTrigger === 'stocks'
              ? 'Focus primarily on the equity and index positions.'
              : 'Cover both stocks and crypto briefly.';
            await sendToOllama(
              `Give a concise spoken market briefing. ${focusHint} ` +
              'Lead with whether the market is open or closed and the overall direction. ' +
              'Call out any notable movers of two percent or more. ' +
              'Phrase prices naturally — say "one hundred and forty dollars" not "$140.00". ' +
              'Keep it to three or four sentences total.',
              {
                ephemeralMessages: [
                  { role: 'system', content: SYSTEM_PROMPT },
                  { role: 'system', content: mktContext },
                ],
              }
            );
          } else {
            await sendToOllama('Inform the user that market data could not be retrieved right now. One sentence.');
          }
          fetchSystemStatus();
          return;
        }
        // ─────────────────────────────────────────────────────────────────
```

### 8c — Mirror in `handleSend`

Add the identical block inside `handleSend()` following the same pattern as the other intercepts.

### 8d — Module type note

Same as `WEATHER.md` Step 7d — use ES module `import` (requires `type="module"` on the script
tag) or copy the functions inline into `app.js`.

---

## Step 9 — Optional: Individual Ticker Voice Lookups

The trigger detection already matches specific well-known tickers (`NVDA`, `AAPL`, etc.) in the
transcript. To extend this to any arbitrary ticker the user speaks:

```javascript
// In detectMarketTrigger, add at the end before the final `return null`:
const tickerMatch = transcript.match(/\bprice\s+of\s+([A-Z]{1,5})\b/i)
                 || transcript.match(/\b([A-Z]{2,5})\s+(?:stock|price|share)\b/i);
if (tickerMatch) return tickerMatch[1].toUpperCase();  // returns the ticker symbol
```

Then in the `app.js` intercept, detect when `_mktTrigger` is a ticker string rather than
`'all' | 'stocks' | 'crypto'` and pass it as a query parameter:

```javascript
// In openMarketPanel (stocks-panel.js), add a `ticker` param:
export async function openMarketPanel(silent = false, filter = 'all', ticker = null) {
  const url = ticker
    ? `${BACKEND_BASE_MKT}/stocks?ticker=${encodeURIComponent(ticker)}`
    : `${BACKEND_BASE_MKT}/stocks`;
  // ...
}
```

Add a `GET /stocks?ticker=` path in `stocks.py`:

```python
@router.get("/stocks")
async def get_stocks(ticker: Optional[str] = None):
    if ticker:
        result = _fetch_ticker(ticker.upper())
        if not result:
            raise HTTPException(status_code=404, detail=f"Ticker not found: {ticker}")
        return {
            "tickers": [result], "failed": [], "total": 1,
            "market_open": _is_us_market_open(),
            "llm_context": _build_llm_context([result], _is_us_market_open()),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "currency_sym": _CURRENCY_SYM,
        }
    # ... existing logic
```

---

## Step 10 — Optional: Market Footer Badge

Match the footer badge pattern from the other panels. In `index.html`:

```html
<div class="ftr-item">MKT <span id="ftr-mkt-status" class="ftr-dev">—</span></div>
```

In `stocks-panel.js`, after a successful fetch:
```javascript
const ftrMkt = document.getElementById('ftr-mkt-status');
if (ftrMkt) {
  ftrMkt.textContent    = data.market_open ? 'OPEN' : 'CLOSED';
  ftrMkt.dataset.dev    = data.market_open ? 'GPU' : 'CPU';  // reuse GPU=green / CPU=amber colours
}
```

---

## File Change Summary

| File | Change |
|---|---|
| `.env` / `.env.example` | Add `STOCKS_WATCHLIST`, `CRYPTO_WATCHLIST`, `STOCKS_CACHE_SECONDS`, `STOCKS_CURRENCY_SYMBOL` |
| `requirements.txt` | Add `yfinance>=0.2.54` |
| `backend/stocks.py` | **New file** — ticker fetch, market-hours detection, context builder, FastAPI router |
| `backend/main.py` | Import and register `stocks_router` |
| `frontend/index.html` | Add market panel HTML; optionally add footer badge |
| `frontend/style.css` | Append market panel CSS block |
| `frontend/stocks-panel.js` | **New file** — trigger detection, fetch wrapper, filter tabs, render logic |
| `frontend/app.js` | Import module (or inline); add intercept block in `mediaRecorder.onstop` and `handleSend` |

---

## Limitations to Be Aware Of

**Yahoo Finance TOS** — `yfinance` is an unofficial scraper of Yahoo Finance data. It is widely
used for personal and research purposes but is technically against Yahoo's TOS for commercial
redistribution. For a local personal tool running entirely on your own machine, this is standard
practice in the data science community. Do not expose the `/stocks` endpoint publicly.

**`yfinance` rate limits** — Yahoo Finance silently throttles requests at high frequency. The
5-minute cache (`STOCKS_CACHE_SECONDS=300`) ensures only one call per ticker per 5 minutes.
The `fast_info` attribute is used instead of `history()` because it makes a single lightweight
HTTP request per ticker rather than downloading OHLCV history.

**After-hours prices** — `fast_info.last_price` returns the most recent trade price, which
includes pre-market and after-hours if Yahoo surfaces it. The `is_market_open` flag in the
response tells the LLM whether this is a live price or the prior session's close, preventing
confusing spoken statements like "NVDA is up 3% today" when markets are closed.

**`yfinance` and `pandas` startup time** — The first import of `yfinance` at server startup takes
~300–500 ms due to `pandas` loading. This is a one-time cost when Uvicorn starts; it does not
affect subsequent request latency.

**Crypto weekend prices** — Crypto trades 24/7 so `is_market_open` is only meaningful for equity
tickers. The LLM context marks the session label as closed on weekends for equities while crypto
prices are always live — the `_build_llm_context` function reflects this distinction implicitly
since crypto changes will appear as non-zero on weekends.

**`tzdata` on Windows** — `zoneinfo.ZoneInfo("America/New_York")` requires the `tzdata` package
on Windows. Add to `requirements.txt` if not already present:
```
tzdata>=2024.1
```
