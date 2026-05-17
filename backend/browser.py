"""browser.py — Page-text extraction endpoint for the in-UI browser panel.

GET /api/browser/page-text?url=<encoded-url>
Returns clean text scraped from the page, suitable for LLM context injection.
Runs server-side to avoid iframe cross-origin restrictions.
"""

import asyncio
import re
from html.parser import HTMLParser
from urllib.parse import unquote

import httpx
import requests as _requests
from fastapi import APIRouter

router = APIRouter()

# Tags whose entire subtree (including nested content) is discarded
_SKIP_TAGS = frozenset({
    'script', 'style', 'noscript', 'head', 'nav', 'footer', 'header',
    'aside', 'iframe', 'svg', 'form', 'button', 'select', 'option',
    'template', 'canvas',
})

# Limit extracted text to keep prompts manageable (~3 k tokens)
_MAX_CHARS = 12_000


class _TextExtractor(HTMLParser):
    """Strips all HTML tags, retaining only visible text content."""

    def __init__(self):
        super().__init__()
        self._depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self._depth += 1

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS:
            self._depth = max(0, self._depth - 1)

    def handle_data(self, data):
        if self._depth == 0:
            text = data.strip()
            if text:
                self.parts.append(text)


def _extract_text(html: str) -> str:
    ex = _TextExtractor()
    ex.feed(html)
    raw = ' '.join(ex.parts)
    clean = re.sub(r'\s+', ' ', raw).strip()
    if len(clean) > _MAX_CHARS:
        clean = clean[:_MAX_CHARS] + ' \u2026[truncated]'
    return clean


_BROWSER_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/125.0.0.0 Safari/537.36'
    ),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
}

# Wikipedia API User-Agent must identify the tool per WMF policy.
_WIKI_UA = 'STARLING-VoiceUI/1.0 (personal-assistant; non-commercial)'

_WIKI_RE = re.compile(
    r'^https?://(?P<lang>[a-z]{2,3})\.wikipedia\.org/wiki/(?P<title>[^?#]+)',
    re.IGNORECASE,
)


async def _fetch_wikipedia(lang: str, title: str) -> str:
    """Use the MediaWiki API to fetch plain-text article content.

    Runs synchronous `requests` in a thread because httpx is blocked by
    Wikipedia's bot policy while urllib3/requests is accepted.
    """
    def _sync() -> str:
        resp = _requests.get(
            f'https://{lang}.wikipedia.org/w/api.php',
            params={
                'action':        'query',
                'prop':          'extracts',
                'titles':        unquote(title).replace('_', ' '),
                'format':        'json',
                'formatversion': '2',
                'explaintext':   '1',
                'exintro':       '0',
                'exlimit':       '1',
            },
            headers={'User-Agent': _WIKI_UA},
            timeout=15,
        )
        resp.raise_for_status()
        data  = resp.json()
        pages = data.get('query', {}).get('pages', [])
        return pages[0].get('extract', '') if pages else ''

    return await asyncio.get_event_loop().run_in_executor(None, _sync)


@router.get('/browser/page-text')
async def fetch_page_text(url: str):
    """Fetch a URL server-side and return clean page text for LLM context."""
    if not url.startswith(('http://', 'https://')):
        return {'text': None, 'error': 'Invalid URL scheme'}

    try:
        async with httpx.AsyncClient(
            timeout=15,
            follow_redirects=True,
        ) as client:
            wiki = _WIKI_RE.match(url)
            if wiki:
                raw = await _fetch_wikipedia(wiki.group('lang'), wiki.group('title'))
                final_url = url
            else:
                resp = await client.get(url, headers=_BROWSER_HEADERS)
                resp.raise_for_status()
                raw       = _extract_text(resp.text)
                final_url = str(resp.url)

        if len(raw) > _MAX_CHARS:
            raw = raw[:_MAX_CHARS] + ' …[truncated]'
        return {'text': raw.strip() or None, 'url': final_url}

    except httpx.TimeoutException:
        return {'text': None, 'error': 'Request timed out'}
    except httpx.HTTPStatusError as exc:
        return {'text': None, 'error': f'HTTP {exc.response.status_code}'}
    except Exception as exc:  # noqa: BLE001
        return {'text': None, 'error': str(exc)}
