// frontend/news-panel.js
// News briefing panel: trigger detection, data fetch, render, and LLM context export.

const BACKEND_BASE_NEWS = 'http://localhost:8000';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const newsPanel      = document.getElementById('news-panel');
const newsMeta       = document.getElementById('news-meta');
const newsTabs       = document.getElementById('news-tabs');
const newsList       = document.getElementById('news-list');
const newsFetched    = document.getElementById('news-fetched');
const newsRefreshBtn = document.getElementById('news-refresh-btn');

// ── State ─────────────────────────────────────────────────────────────────────
let _newsData  = null;   // last fetched payload
let _activeTab = 'all'; // currently selected source tab

// ── Refresh button ────────────────────────────────────────────────────────────
newsRefreshBtn?.addEventListener('click', async () => {
  newsRefreshBtn.textContent = '↻ FETCHING…';
  newsRefreshBtn.disabled    = true;
  await fetch(`${BACKEND_BASE_NEWS}/news/cache`, { method: 'DELETE' }).catch(() => {});
  await openNewsPanel(true);
  newsRefreshBtn.textContent = '↻ REFRESH';
  newsRefreshBtn.disabled    = false;
});

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Returns true if the transcript matches a news briefing trigger, null otherwise.
 */
export function detectNewsTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  const patterns = [
    /\bnews\s+briefing\b/,
    /\bmorning\s+briefing\b/,
    /\b(?:daily|evening|morning)\s+brief\b/,
    /\bwhat(?:'s| is)\s+(?:in\s+)?(?:the\s+)?news\b/,
    /\b(?:latest|breaking|today(?:'s)?)\s+news\b/,
    /\bnews\s+(?:update|report|summary|roundup|headlines?)\b/,
    /\btop\s+(?:stories|headlines?)\b/,
    /\bwhat(?:'s| is)\s+(?:going\s+on|happening)\b/,
    /\bcatch\s+me\s+up\b/,
    /\bbrief\s+me\b/,
    /\bheadlines?\b/,
  ];

  return patterns.some(p => p.test(t)) ? true : null;
}

// ── Panel open / close ────────────────────────────────────────────────────────

/**
 * Fetch headlines and open the news panel.
 * @param {boolean} [silent=false] — skip scroll animation (used by refresh button)
 * Returns the llm_context string for LLM injection, or null on failure.
 */
export async function openNewsPanel(silent = false) {
  let data;
  try {
    const res = await fetch(`${BACKEND_BASE_NEWS}/news`);
    if (!res.ok) throw new Error(`News API ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('[news-panel] fetch failed:', err);
    return null;
  }

  _newsData  = data;
  _activeTab = 'all';
  _renderPanel(data);

  newsPanel.classList.remove('hidden');

  return data.llm_context;
}

export function closeNewsPanel() {
  newsPanel?.classList.add('hidden');
  _newsData = null;
}

// ── Render ─────────────────────────────────────────────────────────────────────

function _renderPanel(data) {
  const { headlines, by_source, sources, total, fetched_at } = data;

  newsMeta.textContent = `${total} HEADLINES`;

  const fetchedDate = new Date(fetched_at);
  newsFetched.textContent = `UPDATED ${fetchedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

  // Source tabs — "ALL" first, then one per source
  newsTabs.innerHTML = '';
  const allTab = _makeTab('ALL', 'all');
  allTab.classList.add('active');
  newsTabs.appendChild(allTab);
  sources.forEach(src => newsTabs.appendChild(_makeTab(src, src)));

  _renderList(headlines);
}

function _makeTab(label, key) {
  const btn       = document.createElement('button');
  btn.className   = 'news-tab';
  btn.textContent = label.length > 14 ? label.slice(0, 12) + '…' : label;
  btn.dataset.key = key;
  btn.addEventListener('click', () => {
    if (!_newsData) return;
    _activeTab = key;
    newsTabs.querySelectorAll('.news-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const items = key === 'all'
      ? _newsData.headlines
      : (_newsData.by_source[key] ?? []);
    _renderList(items);
  });
  return btn;
}

function _renderList(items) {
  newsList.innerHTML = '';
  if (!items.length) {
    newsList.innerHTML = '<div style="font-size:0.7rem;color:#444;padding:4px 0;">No headlines available.</div>';
    return;
  }
  items.forEach(item => newsList.appendChild(_makeHeadlineCard(item)));
}

function _makeHeadlineCard(item) {
  const card     = document.createElement('div');
  card.className = 'news-item';
  card.innerHTML = `
    <div class="news-item-meta">
      <span class="news-item-source">${_esc(item.source)}</span>
      ${item.pub ? `<span class="news-item-pub">${_esc(item.pub)}</span>` : ''}
    </div>
    <div class="news-item-title">${_esc(item.title)}</div>
    ${item.summary ? `<div class="news-item-summary">${_esc(item.summary)}</div>` : ''}
  `;
  if (item.link) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => window.open(item.link, '_blank', 'noopener,noreferrer'));
  }
  return card;
}

function _esc(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
