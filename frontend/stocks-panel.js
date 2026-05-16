// frontend/stocks-panel.js
// Market panel: trigger detection, data fetch, filter tabs, ticker grid, LLM context export.

const BACKEND_BASE_MKT = 'http://localhost:8000';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const mktPanel      = document.getElementById('mkt-panel');
const mktStatus     = document.getElementById('mkt-status');
const mktGrid       = document.getElementById('mkt-grid');
const mktFetched    = document.getElementById('mkt-fetched');
const mktRefreshBtn = document.getElementById('mkt-refresh-btn');
const mktTabBtns    = document.querySelectorAll('.mkt-tab');
const ftrMktStatus  = document.getElementById('ftr-mkt-status');

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
  mktRefreshBtn.disabled    = true;
  await fetch(`${BACKEND_BASE_MKT}/stocks/cache`, { method: 'DELETE' }).catch(() => {});
  await openMarketPanel(_activeFilter, /* silent */ true);
  mktRefreshBtn.textContent = '↻ REFRESH';
  mktRefreshBtn.disabled    = false;
});

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Check a transcript for a market / stocks / crypto trigger.
 * Returns 'stocks', 'crypto', or 'all' if matched; null if no match.
 *
 * Activation phrases (examples):
 *   "display stocks"           → 'stocks'
 *   "market update"            → 'all'
 *   "how are stocks doing"     → 'stocks'
 *   "show me crypto"           → 'crypto'
 *   "Bitcoin price"            → 'crypto'
 *   "check NVIDIA"             → 'stocks'
 */
export function detectMarketTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  // Crypto-specific
  const cryptoPatterns = [
    /\b(?:show|check|what(?:'s| is)|display|get)\b.{0,20}\bcrypto\b/,
    /\bcrypto(?:\s+(?:prices?|update|market|portfolio))?\b/,
    /\b(?:bitcoin|ethereum|btc|eth|solana|sol)\b.{0,15}\bprice\b/,
    /\bprice\s+of\s+(?:bitcoin|ethereum|btc|eth|solana)\b/,
  ];
  if (cryptoPatterns.some(p => p.test(t))) return 'crypto';

  // Stocks / equities / general market — requires a qualifying context word
  // so bare "stock" in normal conversation doesn't fire the panel.
  const stockPatterns = [
    // Explicit command verb + stocks/market/equities
    /\b(?:display|show|check|pull up|open|get)\b.{0,25}\b(?:stocks?|market|equities)\b/,
    // "what's the market / what are stocks doing"
    /\bwhat(?:'s| is)\b.{0,20}\b(?:market|stocks?)\b/,
    // stock/market + qualifying noun (briefing, prices, update, etc.)
    /\b(?:stocks?|market)\s+(?:briefing|prices?|update|summary|overview|report|watchlist|data|check|watch)\b/,
    // how are/is the stocks/market
    /\bhow\s+(?:are|is)\s+(?:the\s+)?(?:markets?|stocks?)\b/,
    // market open/close/up/down/today
    /\bmarkets?\s+(?:today|now|open|close|up|down)\b/,
    // portfolio with a qualifier (not bare "portfolio")
    /\bportfolio\s+(?:briefing|update|summary|check|report|overview)\b/,
    // specific well-known equity tickers
    /\b(?:nvda|nvidia|aapl|apple|msft|microsoft|spy|qqq|tsla|tesla|amzn|amazon|goog|meta|amd)\b/,
  ];
  if (stockPatterns.some(p => p.test(t))) return 'stocks';

  // General financial
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
 * @param {string}  [filter='all']   — pre-select tab: 'all', 'equity', 'crypto', 'index'
 * @param {boolean} [silent=false]   — suppress scroll (used by refresh button)
 * Returns llm_context string for LLM injection, or null on failure.
 */
export async function openMarketPanel(filter = 'all', silent = false) {
  _activeFilter = filter;

  let data;
  try {
    const res = await fetch(`${BACKEND_BASE_MKT}/stocks`);
    if (!res.ok) throw new Error(`Stocks API ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('[stocks-panel] fetch failed:', err);
    return null;
  }

  _mktData = data;

  // Activate the matching filter tab
  mktTabBtns.forEach(b => {
    const match = b.dataset.filter === filter
      || (filter === 'stocks'  && b.dataset.filter === 'equity')
      || (filter === 'all'     && b.dataset.filter === 'all');
    b.classList.toggle('active', match);
  });

  _renderPanel(data);
  mktPanel.classList.remove('hidden');

  return data.llm_context;
}

export function closeMarketPanel() {
  mktPanel.classList.add('hidden');
  _mktData = null;
}

// ── Render ────────────────────────────────────────────────────────────────────

function _renderPanel(data) {
  const { market_open, fetched_at } = data;

  // Market status badge (header + footer)
  mktStatus.textContent  = market_open ? 'MARKET OPEN' : 'MARKET CLOSED';
  mktStatus.dataset.open = String(market_open);

  if (ftrMktStatus) {
    ftrMktStatus.textContent    = market_open ? 'OPEN' : 'CLOSED';
    // Reuse existing ftr-dev colour classes: GPU=green, CPU=amber
    ftrMktStatus.dataset.dev    = market_open ? 'GPU' : 'CPU';
  }

  // Fetched timestamp
  const d = new Date(fetched_at);
  mktFetched.textContent = `UPDATED ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

  _renderGrid(data.tickers);
}

function _renderGrid(tickers) {
  mktGrid.innerHTML = '';

  const filtered = _activeFilter === 'all'
    ? tickers
    : tickers.filter(t => {
        if (_activeFilter === 'equity') return ['equity', 'etf'].includes(t.type);
        if (_activeFilter === 'crypto') return t.type === 'crypto';
        if (_activeFilter === 'index')  return t.type === 'index';
        return true;
      });

  if (!filtered.length) {
    mktGrid.innerHTML = '<div class="mkt-empty">No tickers for this filter.</div>';
    return;
  }

  // Stagger entrance animation — mirrors newsCardIn pattern from news panel
  filtered.forEach((t, i) => {
    const card = _makeTickerCard(t);
    card.style.setProperty('--card-delay', `${i * 50}ms`);
    mktGrid.appendChild(card);
  });
}

function _makeTickerCard(t) {
  const displaySymbol = t.symbol
    .replace('-USD', '').replace('-USDT', '').replace('=X', '').replace('^', '');

  const card = document.createElement('div');
  card.className = 'mkt-card';
  card.innerHTML = `
    <div class="mkt-card-header">
      <span class="mkt-card-symbol">${_esc(displaySymbol)}</span>
      <span class="mkt-card-type">${_esc(t.type)}</span>
    </div>
    <div class="mkt-card-price">${_esc(t.price_fmt)}</div>
    <div class="mkt-card-change" data-direction="${_esc(t.change.direction)}">
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
  return (str || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
