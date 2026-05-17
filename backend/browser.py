"""browser.py — Page-text extraction endpoint for the in-UI browser panel.

GET /api/browser/page-text?url=<encoded-url>
Returns clean text scraped from the page, suitable for LLM context injection.
Runs server-side to avoid iframe cross-origin restrictions.
"""

import re
from html.parser import HTMLParser

import httpx
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


_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/124.0.0.0 Safari/537.36'
    ),
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
}


@router.get('/browser/page-text')
async def fetch_page_text(url: str):
    """Fetch a URL server-side and return clean page text for LLM context."""
    if not url.startswith(('http://', 'https://')):
        return {'text': None, 'error': 'Invalid URL scheme'}

    try:
        async with httpx.AsyncClient(
            timeout=12,
            follow_redirects=True,
            headers=_HEADERS,
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()

        text = _extract_text(resp.text)
        return {'text': text or None, 'url': str(resp.url)}

    except httpx.TimeoutException:
        return {'text': None, 'error': 'Request timed out'}
    except httpx.HTTPStatusError as exc:
        return {'text': None, 'error': f'HTTP {exc.response.status_code}'}
    except Exception as exc:  # noqa: BLE001
        return {'text': None, 'error': str(exc)}
