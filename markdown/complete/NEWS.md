# News Briefing — Implementation Guide

Adds a voice-triggered news panel that activates on phrases like *"news briefing"* or *"what's in
the news"*, fetches live headlines from configurable RSS feeds with no API key or account required,
renders a HUD-style headline list inside the S.T.A.R.L.I.N.G. UI, and injects a structured
summary of the top stories into the LLM context so Starling can deliver a spoken briefing in
natural prose.

---

## Overview

```
Microphone → Whisper STT → [intercept transcript] → /news (FastAPI)
                                    ↓                      ↓
                           open news panel          RSS feeds (free, no key)
                                    ↓                      ↓
                           render headline cards ← headlines JSON
                                    ↓
                           sendToOllama() with headlines context injected
                                    ↓
                           Kokoro TTS spoken briefing
```

The intercept follows the same pattern used throughout the app — the transcript is checked for a
news trigger phrase before `sendToOllama()` is ever called. RSS feeds are parsed server-side to
avoid CORS issues and to allow caching.

---

## Architecture Decisions

| Decision | Choice | Reason |
|---|---|---|
| News source | RSS feeds via `feedparser` | Completely free, no API key, no account; all major outlets publish RSS; works offline-first |
| Feed selection | Configurable list in `.env` + sensible defaults | User can swap in any feed URL without code changes |
| Optional upgrade | NewsAPI (free tier) | 100 req/day free tier; structured JSON with source metadata; add as opt-in if user wants it |
| Backend vs. frontend fetch | Backend (`news.py`) | CORS headers differ per outlet; server-side fetch normalises everything |
| Caching | 15-minute in-memory cache per feed group | News doesn't change second-to-second; avoids hitting feeds repeatedly |
| Headline count | Top 5 per feed, max 20 total | Keeps LLM context token-efficient and TTS briefing under 60 seconds |

---

## Default RSS Feeds

The following feeds work out of the box with no account or key. Swap any of them in `.env` for
feeds that match your interests.

| Feed Name | URL |
|---|---|
| BBC News (Top Stories) | `https://feeds.bbci.co.uk/news/rss.xml` |
| Reuters (Top News) | `https://feeds.reuters.com/reuters/topNews` |
| AP News (Top Headlines) | `https://rsshub.app/apnews/topics/apf-topnews` |
| NPR News | `https://feeds.npr.org/1001/rss.xml` |
| Ars Technica | `https://feeds.arstechnica.com/arstechnica/index` |
| Hacker News (Top) | `https://hnrss.org/frontpage` |

> **Note on AP News:** AP's native RSS was retired. The `rsshub.app` proxy re-exposes it as a
> standard feed. If you prefer not to use a third-party proxy, substitute NPR or Reuters.

---

## Step 1 — Add `.env` Variables

In `.env` (and `.env.example`), add:

```
# ── News Briefing ─────────────────────────────────────────────────────────────
# Comma-separated list of RSS feed URLs. Each feed contributes up to NEWS_PER_FEED headlines.
NEWS_FEEDS=https://feeds.bbci.co.uk/news/rss.xml,https://feeds.reuters.com/reuters/topNews,https://feeds.npr.org/1001/rss.xml

# How many headlines to pull from each feed (default 5)
NEWS_PER_FEED=5

# How many total headlines to pass to the LLM as context (default 10)
NEWS_LLM_LIMIT=10

# Cache duration in seconds (default 15 minutes)
NEWS_CACHE_SECONDS=900

# Optional: NewsAPI key (https://newsapi.org — free tier, 100 req/day)
# Leave blank to use RSS-only mode.
NEWS_API_KEY=
NEWS_API_COUNTRY=us
NEWS_API_CATEGORY=general
```

---

## Step 2 — Install Python Dependency

`feedparser` is the only new dependency:

```powershell
.venv\Scripts\Activate.ps1
pip install feedparser
```

Add to `requirements.txt`:

```
feedparser>=6.0.11
```

`httpx` is already listed from the weather implementation and is reused here for the optional
NewsAPI call.

---

## Step 3 — Create `backend/news.py`

Create a new file `backend/news.py`. This file owns all news logic: RSS parsing, optional NewsAPI
fetch, deduplication, caching, and the FastAPI router.

```python
"""
backend/news.py
News headline fetching via RSS (no API key required) with an optional
NewsAPI upgrade path. Exposes GET /news.
"""

import os
import time
import hashlib
from datetime import datetime, timezone
from typing import Optional

import feedparser
from fastapi import APIRouter

router = APIRouter()

# ── Config ────────────────────────────────────────────────────────────────────
_FEEDS_ENV      = os.getenv("NEWS_FEEDS", "https://feeds.bbci.co.uk/news/rss.xml,https://feeds.reuters.com/reuters/topNews,https://feeds.npr.org/1001/rss.xml")
_PER_FEED       = int(os.getenv("NEWS_PER_FEED", "5"))
_LLM_LIMIT      = int(os.getenv("NEWS_LLM_LIMIT", "10"))
_CACHE_SECONDS  = int(os.getenv("NEWS_CACHE_SECONDS", "900"))
_NEWSAPI_KEY    = os.getenv("NEWS_API_KEY", "").strip()
_NEWSAPI_CTRY   = os.getenv("NEWS_API_COUNTRY", "us")
_NEWSAPI_CAT    = os.getenv("NEWS_API_CATEGORY", "general")

# ── In-memory cache ───────────────────────────────────────────────────────────
_cache: dict = {}


# ── RSS fetch ─────────────────────────────────────────────────────────────────

def _source_name_from_url(url: str) -> str:
    """Derive a short human-readable source label from a feed URL."""
    replacements = {
        "bbci.co.uk":      "BBC News",
        "reuters.com":     "Reuters",
        "npr.org":         "NPR",
        "apnews":          "AP News",
        "arstechnica.com": "Ars Technica",
        "hnrss.org":       "Hacker News",
        "theguardian.com": "The Guardian",
        "nytimes.com":     "New York Times",
        "wsj.com":         "Wall Street Journal",
        "techcrunch.com":  "TechCrunch",
        "wired.com":       "WIRED",
    }
    for key, label in replacements.items():
        if key in url:
            return label
    # Fallback: extract domain
    try:
        from urllib.parse import urlparse
        return urlparse(url).netloc.replace("www.", "").replace("feeds.", "")
    except Exception:
        return "Unknown"


def _parse_feed(url: str) -> list[dict]:
    """Fetch and parse a single RSS feed. Returns up to _PER_FEED items."""
    try:
        feed = feedparser.parse(url, request_headers={"User-Agent": "STARLING/1.0"})
    except Exception:
        return []

    source = feed.feed.get("title", _source_name_from_url(url))
    items  = []

    for entry in feed.entries[:_PER_FEED]:
        title   = entry.get("title", "").strip()
        summary = entry.get("summary", entry.get("description", "")).strip()
        link    = entry.get("link", "")

        # Strip HTML tags from summary (feedparser may include inline HTML)
        if "<" in summary:
            import re
            summary = re.sub(r"<[^>]+>", " ", summary).strip()
            summary = re.sub(r"\s{2,}", " ", summary)

        # Truncate long summaries — keep context token-efficient
        if len(summary) > 280:
            summary = summary[:280].rsplit(" ", 1)[0] + "…"

        pub_raw = entry.get("published", entry.get("updated", ""))
        try:
            from email.utils import parsedate_to_datetime
            pub_dt = parsedate_to_datetime(pub_raw)
            pub    = pub_dt.strftime("%H:%M") if pub_dt.date() == datetime.now(timezone.utc).date() else pub_dt.strftime("%b %-d")
        except Exception:
            pub = ""

        # Stable dedup key: hash of title (ignores minor punctuation variations)
        dedup_key = hashlib.md5(title.lower().encode()).hexdigest()[:8]

        items.append({
            "id":      dedup_key,
            "title":   title,
            "summary": summary,
            "source":  source,
            "link":    link,
            "pub":     pub,
        })

    return items


def _fetch_newsapi() -> list[dict]:
    """Optional: fetch top headlines from NewsAPI. Returns [] if key is blank."""
    if not _NEWSAPI_KEY:
        return []
    import httpx
    try:
        url = "https://newsapi.org/v2/top-headlines"
        params = {
            "apiKey":   _NEWSAPI_KEY,
            "country":  _NEWSAPI_CTRY,
            "category": _NEWSAPI_CAT,
            "pageSize": _PER_FEED * 2,
        }
        resp = httpx.get(url, params=params, timeout=10.0)
        resp.raise_for_status()
        articles = resp.json().get("articles", [])
        items = []
        for a in articles:
            title   = (a.get("title") or "").split(" - ")[0].strip()  # strip "- Source Name" suffix
            summary = (a.get("description") or "").strip()
            if len(summary) > 280:
                summary = summary[:280].rsplit(" ", 1)[0] + "…"
            source  = a.get("source", {}).get("name", "NewsAPI")
            dedup_key = hashlib.md5(title.lower().encode()).hexdigest()[:8]
            items.append({
                "id":      dedup_key,
                "title":   title,
                "summary": summary,
                "source":  source,
                "link":    a.get("url", ""),
                "pub":     "",
            })
        return items
    except Exception:
        return []


def _build_llm_context(headlines: list[dict]) -> str:
    """
    Build a compact plain-prose summary of the top headlines for LLM injection.
    Keeps it well under 1 000 tokens even with long summaries.
    """
    now = datetime.now(timezone.utc).strftime("%A, %B %-d at %-I:%M %p UTC")
    lines = [f"[NEWS BRIEFING — {now}]"]
    for i, h in enumerate(headlines[:_LLM_LIMIT], 1):
        line = f"{i}. {h['title']} ({h['source']})"
        if h["summary"] and h["summary"].lower() != h["title"].lower():
            line += f" — {h['summary']}"
        lines.append(line)
    return "\n".join(lines)


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/news")
async def get_news():
    """
    Fetch and return a deduplicated list of top headlines from all configured
    RSS feeds (+ optional NewsAPI). Cached for NEWS_CACHE_SECONDS.
    """
    cache_key = "news_default"
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_SECONDS:
        return cached["data"]

    feed_urls = [u.strip() for u in _FEEDS_ENV.split(",") if u.strip()]

    # Fetch all feeds (synchronously — feedparser is sync; no async overhead needed
    # since the results are cached and news fetches are infrequent)
    all_items: list[dict] = []
    seen_ids: set = set()

    for url in feed_urls:
        for item in _parse_feed(url):
            if item["id"] not in seen_ids:
                seen_ids.add(item["id"])
                all_items.append(item)

    # Merge NewsAPI headlines (if key set), deduplicating by title hash
    for item in _fetch_newsapi():
        if item["id"] not in seen_ids:
            seen_ids.add(item["id"])
            all_items.append(item)

    # Group by source for the frontend panel
    by_source: dict[str, list] = {}
    for item in all_items:
        by_source.setdefault(item["source"], []).append(item)

    data = {
        "headlines":   all_items,
        "by_source":   by_source,
        "total":       len(all_items),
        "llm_context": _build_llm_context(all_items),
        "fetched_at":  datetime.now(timezone.utc).isoformat(),
        "sources":     list(by_source.keys()),
    }

    _cache[cache_key] = {"ts": time.time(), "data": data}
    return data


@router.delete("/news/cache")
async def bust_news_cache():
    """Force-clear the news cache — triggers a fresh fetch on the next request."""
    _cache.clear()
    return {"status": "cleared"}
```

---

## Step 4 — Register the Router in `backend/main.py`

In `backend/main.py`, alongside the other router imports:

```python
from news import router as news_router
app.include_router(news_router)
```

---

## Step 5 — Add the News Panel HTML

In `frontend/index.html`, add the news panel markup inside `.starling`, placed alongside the
weather and calendar panels (just before `.bottom-bar`):

```html
<!-- News Panel — hidden until news briefing mode is active -->
<div class="news-panel hidden" id="news-panel">
  <div class="news-header">
    <div class="news-title">NEWS BRIEFING</div>
    <div class="news-meta" id="news-meta">—</div>
  </div>

  <!-- Source filter tabs — populated dynamically -->
  <div class="news-tabs" id="news-tabs"></div>

  <!-- Headline list — swaps content when a tab is selected -->
  <div class="news-list" id="news-list"></div>

  <div class="news-footer">
    <button class="news-refresh-btn" id="news-refresh-btn">↻ REFRESH</button>
    <span class="news-fetched" id="news-fetched">—</span>
  </div>
</div>
```

---

## Step 6 — Add the CSS

Append to `frontend/style.css`:

```css
/* ── News Panel ──────────────────────────────────────────────────────────────── */

.news-panel {
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

.news-panel.hidden {
  display: none;
}

.news-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  padding-bottom: 8px;
}

.news-title {
  font-family: 'Share Tech Mono', monospace;
  font-size: clamp(0.75rem, 1.4vw, 0.95rem);
  color: #e0e0e0;
  letter-spacing: 0.14em;
}

.news-meta {
  font-size: 0.6rem;
  color: #555;
  letter-spacing: 0.08em;
}

/* Source filter tabs */
.news-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.news-tab {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 5px;
  color: #888;
  cursor: pointer;
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.6rem;
  letter-spacing: 0.1em;
  padding: 3px 9px;
  text-transform: uppercase;
  transition: background 0.15s, color 0.15s;
}

.news-tab:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #ccc;
}

.news-tab.active {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
  color: #e0e0e0;
}

/* Headline list */
.news-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 340px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.1) transparent;
}

.news-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 6px;
  border-left: 2px solid rgba(255, 255, 255, 0.07);
  cursor: default;
  transition: background 0.12s;
}

.news-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.news-item-meta {
  display: flex;
  gap: 8px;
  align-items: center;
}

.news-item-source {
  font-size: 0.58rem;
  color: #555;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.news-item-pub {
  font-size: 0.58rem;
  color: #444;
}

.news-item-title {
  font-size: 0.8rem;
  color: #ddd;
  line-height: 1.35;
}

.news-item-summary {
  font-size: 0.68rem;
  color: #666;
  line-height: 1.4;
}

/* Footer */
.news-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  padding-top: 8px;
}

.news-refresh-btn {
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

.news-refresh-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #bbb;
}

.news-fetched {
  font-size: 0.58rem;
  color: #444;
  letter-spacing: 0.08em;
}
```

---

## Step 7 — Create `frontend/news-panel.js`

```javascript
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
let _newsData    = null;   // last fetched payload
let _activeTab   = 'all'; // currently selected source tab

// ── Refresh button ────────────────────────────────────────────────────────────
newsRefreshBtn?.addEventListener('click', async () => {
  newsRefreshBtn.textContent = '↻ FETCHING…';
  newsRefreshBtn.disabled = true;
  // Bust cache then re-fetch
  await fetch(`${BACKEND_BASE_NEWS}/news/cache`, { method: 'DELETE' }).catch(() => {});
  await openNewsPanel(true);
  newsRefreshBtn.textContent = '↻ REFRESH';
  newsRefreshBtn.disabled = false;
});

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Check a Whisper transcript for a news briefing trigger.
 * Returns true if matched, null otherwise.
 *
 * Activation phrases:
 *   "news briefing"
 *   "morning briefing"
 *   "what's in the news"
 *   "latest news"
 *   "news update"
 *   "top stories"
 *   "what's happening"
 *   "catch me up"
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
 * Fetch news and open the panel.
 * @param {boolean} [silent=false] — if true, skips the open animation (used by refresh button)
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
  if (!silent) newsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  return data.llm_context;
}

export function closeNewsPanel() {
  newsPanel.classList.add('hidden');
  _newsData = null;
}

// ── Render ─────────────────────────────────────────────────────────────────────

function _renderPanel(data) {
  const { headlines, by_source, sources, total, fetched_at } = data;

  // Meta
  newsMeta.textContent = `${total} HEADLINES`;
  const fetchedDate = new Date(fetched_at);
  newsFetched.textContent = `UPDATED ${fetchedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

  // Source tabs — "ALL" first, then one per source
  newsTabs.innerHTML = '';
  const allTab = _makeTab('ALL', 'all');
  allTab.classList.add('active');
  newsTabs.appendChild(allTab);
  sources.forEach(src => newsTabs.appendChild(_makeTab(src, src)));

  // Initial render: all headlines
  _renderList(headlines);
}

function _makeTab(label, key) {
  const btn = document.createElement('button');
  btn.className = 'news-tab';
  btn.textContent = label.length > 14 ? label.slice(0, 12) + '…' : label;
  btn.dataset.key = key;
  btn.addEventListener('click', () => {
    if (!_newsData) return;
    _activeTab = key;
    // Update active state
    newsTabs.querySelectorAll('.news-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    // Re-render list
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
  const card = document.createElement('div');
  card.className = 'news-item';
  card.innerHTML = `
    <div class="news-item-meta">
      <span class="news-item-source">${_esc(item.source)}</span>
      ${item.pub ? `<span class="news-item-pub">${_esc(item.pub)}</span>` : ''}
    </div>
    <div class="news-item-title">${_esc(item.title)}</div>
    ${item.summary ? `<div class="news-item-summary">${_esc(item.summary)}</div>` : ''}
  `;
  // Clicking a card opens the article URL in a new tab
  if (item.link) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => window.open(item.link, '_blank', 'noopener,noreferrer'));
  }
  return card;
}

function _esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

---

## Step 8 — Wire into `app.js`

### 8a — Import the module

```javascript
import { detectNewsTrigger, openNewsPanel, closeNewsPanel } from './news-panel.js';
```

### 8b — Add the intercept block in `mediaRecorder.onstop`

Add the news intercept after the calendar intercept (or after the presentation mode block if
neither weather nor calendar is implemented yet):

```javascript
        // ── News briefing intercept ───────────────────────────────────────
        if (detectNewsTrigger(transcript)) {
          setState('thinking');
          appendMessage('user', transcript);
          const newsContext = await openNewsPanel();
          if (newsContext) {
            await sendToOllama(
              'Deliver a concise spoken news briefing based on the headlines provided. ' +
              'Pick the four or five most significant stories and summarise each in one sentence. ' +
              'Group related stories naturally if they appear. ' +
              'Keep the whole briefing under sixty seconds when spoken aloud. ' +
              'Do not read source names aloud unless they add important context.',
              {
                ephemeralMessages: [
                  { role: 'system', content: SYSTEM_PROMPT },
                  { role: 'system', content: newsContext },
                ],
              }
            );
          } else {
            await sendToOllama('Inform the user that the news feeds could not be reached right now. One sentence.');
          }
          fetchSystemStatus();
          return;
        }
        // ─────────────────────────────────────────────────────────────────
```

### 8c — Mirror in `handleSend`

Add the identical block inside `handleSend()` following the same pattern as the other intercepts
already there.

### 8d — Module type note

Applies here exactly as described in `WEATHER.md` Step 7d — use either ES module `import` (change
`<script>` to `type="module"`) or copy the functions inline into `app.js`.

---

## Step 9 — Optional: Personalised Feed Configuration

The news panel becomes significantly more useful when the feed list in `.env` reflects the user's
actual interests. Some useful additions:

```
# Technology
https://feeds.arstechnica.com/arstechnica/index
https://hnrss.org/frontpage
https://feeds.wired.com/wired/index
https://techcrunch.com/feed/

# Finance / Business
https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml
https://www.ft.com/rss/home/us

# Sports
https://www.espn.com/espn/rss/news

# Science
https://www.sciencedaily.com/rss/all.xml
https://www.nasa.gov/rss/dyn/breaking_news.rss
```

All of the above are free, public RSS feeds requiring no authentication.

---

## Step 10 — Optional: NewsAPI Upgrade

If you want article thumbnails, better metadata, or category filtering (e.g. technology-only
headlines), sign up for a free NewsAPI key at [newsapi.org](https://newsapi.org). The free tier
allows 100 requests per day.

Set in `.env`:
```
NEWS_API_KEY=your_key_here
NEWS_API_CATEGORY=technology   # general | business | technology | science | health | sports
```

The backend will merge NewsAPI results with RSS results automatically, deduplicating by title hash
so the same story doesn't appear twice.

---

## File Change Summary

| File | Change |
|---|---|
| `.env` / `.env.example` | Add `NEWS_FEEDS`, `NEWS_PER_FEED`, `NEWS_LLM_LIMIT`, `NEWS_CACHE_SECONDS`, `NEWS_API_KEY`, `NEWS_API_COUNTRY`, `NEWS_API_CATEGORY` |
| `requirements.txt` | Add `feedparser>=6.0.11` |
| `backend/news.py` | **New file** — RSS parsing, NewsAPI merge, deduplication, caching, FastAPI router |
| `backend/main.py` | Import and register `news_router` |
| `frontend/index.html` | Add news panel HTML |
| `frontend/style.css` | Append news panel CSS block |
| `frontend/news-panel.js` | **New file** — trigger detection, fetch wrapper, tab filter, render logic |
| `frontend/app.js` | Import module (or inline); add intercept block in `mediaRecorder.onstop` and `handleSend` |

---

## Limitations to Be Aware Of

**RSS feed stability** — Feed URLs occasionally change when outlets restructure their sites. The
`NEWS_FEEDS` env var makes swapping a broken URL a one-line change with no code modification.
If a feed returns no items (network error, moved URL), it is silently skipped and the remaining
feeds still populate the panel.

**`feedparser` blocking** — `feedparser.parse()` is synchronous. For the typical 2–5 feed
configuration this is imperceptible (< 1 s total). If you configure 10+ feeds, consider running
each parse call in `asyncio.get_event_loop().run_in_executor(None, ...)` to avoid briefly blocking
the FastAPI event loop — the same pattern used in `calendar_routes.py` for the CalDAV backend.

**Headline freshness** — The 15-minute cache means headlines are at most 15 minutes stale. For
a personal morning briefing this is ideal. The **↻ REFRESH** button in the panel footer allows
a forced fetch at any time, and the *"refresh news"* / *"update news"* voice phrases can be wired
to call `DELETE /news/cache` before `openNewsPanel()` — the same pattern shown for calendar.

**LLM context token cost** — The default `NEWS_LLM_LIMIT=10` with summaries truncated to 280
characters produces roughly 600–800 tokens of context. This is well within the context window of
any model in the stack summary (all have ≥ 32 768 token contexts). Increase `NEWS_LLM_LIMIT` for
longer briefings, or decrease it if you want a very tight two-story summary.
