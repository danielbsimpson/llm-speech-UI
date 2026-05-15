"""
backend/news.py
News headline fetching via RSS (no API key required).
Exposes GET /news and DELETE /news/cache.
"""

import hashlib
import os
import re
import time
from datetime import datetime, timezone

import feedparser
from fastapi import APIRouter

router = APIRouter()

# ── Config ────────────────────────────────────────────────────────────────────
_FEEDS_ENV     = os.getenv(
    "NEWS_FEEDS",
    "https://feeds.bbci.co.uk/news/rss.xml,"
    "https://feeds.reuters.com/reuters/topNews,"
    "https://feeds.npr.org/1001/rss.xml",
)
_PER_FEED      = int(os.getenv("NEWS_PER_FEED", "5"))
_LLM_LIMIT     = int(os.getenv("NEWS_LLM_LIMIT", "10"))
_CACHE_SECONDS = int(os.getenv("NEWS_CACHE_SECONDS", "900"))

# ── In-memory cache ───────────────────────────────────────────────────────────
_cache: dict = {}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _source_name_from_url(url: str) -> str:
    """Derive a short human-readable source label from a feed URL."""
    labels = {
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
    for key, label in labels.items():
        if key in url:
            return label
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
    items: list[dict] = []

    for entry in feed.entries[:_PER_FEED]:
        title   = entry.get("title", "").strip()
        summary = entry.get("summary", entry.get("description", "")).strip()
        link    = entry.get("link", "")

        # Strip inline HTML from summary
        if "<" in summary:
            summary = re.sub(r"<[^>]+>", " ", summary).strip()
            summary = re.sub(r"\s{2,}", " ", summary)

        if len(summary) > 280:
            summary = summary[:280].rsplit(" ", 1)[0] + "\u2026"

        pub_raw = entry.get("published", entry.get("updated", ""))
        pub = ""
        try:
            from email.utils import parsedate_to_datetime
            pub_dt = parsedate_to_datetime(pub_raw)
            today  = datetime.now(timezone.utc).date()
            pub    = pub_dt.strftime("%H:%M") if pub_dt.date() == today else pub_dt.strftime("%b %-d")
        except Exception:
            pass

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


def _build_llm_context(headlines: list[dict]) -> str:
    """Build a compact plain-prose summary of the top headlines for LLM injection."""
    now   = datetime.now(timezone.utc).strftime("%A, %B %d at %I:%M %p UTC")
    lines = [f"[NEWS BRIEFING \u2014 {now}]"]
    for i, h in enumerate(headlines[:_LLM_LIMIT], 1):
        line = f"{i}. {h['title']} ({h['source']})"
        if h["summary"] and h["summary"].lower() != h["title"].lower():
            line += f" \u2014 {h['summary']}"
        lines.append(line)
    return "\n".join(lines)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/news")
async def get_news():
    """
    Return a deduplicated list of top headlines from all configured RSS feeds.
    Cached for NEWS_CACHE_SECONDS (default 15 minutes).
    """
    cache_key = "news_default"
    cached = _cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_SECONDS:
        return cached["data"]

    feed_urls = [u.strip() for u in _FEEDS_ENV.split(",") if u.strip()]

    all_items: list[dict] = []
    seen_ids: set = set()

    for url in feed_urls:
        for item in _parse_feed(url):
            if item["id"] not in seen_ids:
                seen_ids.add(item["id"])
                all_items.append(item)

    # Group by source for the frontend tab filter
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
    """Force-clear the news cache so the next GET /news fetches live data."""
    _cache.clear()
    return {"status": "cleared"}
