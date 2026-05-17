// frontend/browser-panel.js
// Handles the in-UI browser panel: trigger detection, rendering, and toolbar controls.

const KNOWN_BLOCKED_DOMAINS = [
  'google.com', 'youtube.com', 'twitter.com', 'x.com',
  'reddit.com', 'facebook.com', 'instagram.com', 'linkedin.com',
  'amazon.com', 'netflix.com',
];

// ── State ─────────────────────────────────────────────────────────────────────

let _isOpen = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const starlingEl = document.querySelector('.starling');
const panel      = document.getElementById('browser-panel');
const frame      = document.getElementById('browser-frame');
const urlBar     = document.getElementById('browser-url-bar');
const fallback   = document.getElementById('browser-fallback');
const extLink    = document.getElementById('browser-external-link');
const iframeBox  = document.getElementById('browser-iframe-container');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns whether the browser panel is currently visible.
 */
export function isBrowserPanelOpen() {
  return _isOpen;
}

/**
 * Given a raw Whisper transcript, check for a browser trigger phrase.
 * Returns { url, label } if matched, otherwise null.
 *   url   — resolved URL to navigate to
 *   label — natural-language description used in the LLM spoken acknowledgment
 */
export function detectBrowserTrigger(transcript) {
  const t = transcript.trim();

  // "look up X on Wikipedia" / "search Wikipedia for X" / "wikipedia for/about X"
  const wikiMatch = t.match(/(?:search|look up|open|find)\s+(.+?)\s+on\s+wikipedia/i)
                 || t.match(/(?:search|look up)\s+wikipedia\s+for\s+(.+)/i)
                 || t.match(/wikipedia\s+(?:for|on|about)\s+(.+)/i);
  if (wikiMatch) {
    const topic = wikiMatch[1].trim();
    return {
      url:   `https://en.wikipedia.org/wiki/${encodeURIComponent(topic)}`,
      label: `the Wikipedia article on "${topic}"`,
    };
  }

  // "open browser https://example.com" or "open browser example.com"
  const openBrowserFull = t.match(/open\s+browser\s+(https?:\/\/\S+)/i);
  if (openBrowserFull) {
    const url = openBrowserFull[1];
    return { url, label: url.replace(/^https?:\/\//, '') };
  }
  const openBrowserDomain = t.match(/open\s+browser\s+([\w-]+(?:\.[\w-]+)+\.\w{2,}(?:\/\S*)?)/i);
  if (openBrowserDomain) {
    const url = `https://${openBrowserDomain[1]}`;
    return { url, label: openBrowserDomain[1] };
  }

  // "browser search for X" / "browser search X" — DuckDuckGo plain-HTML endpoint (iframe-friendly)
  const searchMatch = t.match(/browser\s+search(?:\s+for)?\s+(.+)/i);
  if (searchMatch) {
    const query = searchMatch[1].trim();
    return {
      url:   `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      label: `a DuckDuckGo search for "${query}"`,
    };
  }

  return null;
}

/**
 * Returns true if the transcript contains an explicit request to close the browser panel.
 */
export function detectBrowserClose(transcript) {
  const t = transcript.trim().toLowerCase();
  return /\b(?:close|exit|dismiss|hide|shut)\s+(?:the\s+)?browser\b/.test(t);
}

/**
 * Open the browser panel and navigate to the given URL.
 */
export function openBrowserPanel(url) {
  _isOpen = true;
  _showPanel();
  _navigateTo(_resolveUrl(url));
}

/**
 * Close the panel and reset state.
 */
export function closeBrowserPanel() {
  if (!_isOpen) return;
  _isOpen = false;
  starlingEl.classList.remove('browser-mode');
  frame.src = 'about:blank';
  _showIframe();
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _resolveUrl(raw) {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function _isKnownBlocked(url) {
  // DuckDuckGo's plain-HTML search endpoint is embeddable; only block the main site
  if (/^https:\/\/html\.duckduckgo\.com\/html\//.test(url)) return false;
  return KNOWN_BLOCKED_DOMAINS.some(domain => url.includes(domain));
}

function _showPanel() {
  starlingEl.classList.add('browser-mode');
}

function _showIframe() {
  iframeBox.classList.remove('hidden');
  fallback.classList.add('hidden');
}

function _showFallback(url) {
  iframeBox.classList.add('hidden');
  fallback.classList.remove('hidden');
  extLink.href        = url;
  extLink.textContent = `Open ${url.replace(/^https?:\/\//, '')} in new tab \u2197`;
}

function _navigateTo(url) {
  urlBar.value = url;
  extLink.href = url;

  if (_isKnownBlocked(url)) {
    _showFallback(url);
    return;
  }

  _showIframe();
  frame.src     = url;
  // Catches same-origin network failures; cross-origin X-Frame-Options blocks are silent.
  frame.onerror = () => _showFallback(url);
}

// ── Toolbar event listeners ───────────────────────────────────────────────────

document.getElementById('browser-close').addEventListener('click', closeBrowserPanel);

document.getElementById('browser-refresh').addEventListener('click', () => {
  if (frame.src && frame.src !== 'about:blank') frame.src = frame.src;
});

document.getElementById('browser-back').addEventListener('click', () => {
  frame.contentWindow?.history.back();
});

document.getElementById('browser-forward').addEventListener('click', () => {
  frame.contentWindow?.history.forward();
});

document.getElementById('browser-go').addEventListener('click', () => {
  _navigateTo(_resolveUrl(urlBar.value.trim()));
});

urlBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') _navigateTo(_resolveUrl(urlBar.value.trim()));
});

