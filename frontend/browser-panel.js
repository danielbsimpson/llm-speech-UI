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

const panel     = document.getElementById('browser-panel');
const overlay   = document.getElementById('browser-overlay');
const frame     = document.getElementById('browser-frame');
const urlBar    = document.getElementById('browser-url-bar');
const fallback  = document.getElementById('browser-fallback');
const extLink   = document.getElementById('browser-external-link');
const iframeBox = document.getElementById('browser-iframe-container');

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

  // "open https://example.com" — full URL with scheme
  const fullUrl = t.match(/(?:open|go to|navigate to|show me|load)\s+(https?:\/\/\S+)/i);
  if (fullUrl) {
    const url = fullUrl[1];
    return { url, label: url.replace(/^https?:\/\//, '') };
  }

  // "open example.com" — bare domain (requires at least one dot and a recognisable TLD)
  const bareDomain = t.match(/(?:open|go to|navigate to|show me|load)\s+([\w-]+(?:\.[\w-]+)+\.\w{2,}(?:\/\S*)?)/i);
  if (bareDomain) {
    const url = `https://${bareDomain[1]}`;
    return { url, label: bareDomain[1] };
  }

  // "search for X" — DuckDuckGo fallback (iframe-friendly); must start with "search"
  const searchMatch = t.match(/^search(?:\s+for)?\s+(.+)/i);
  if (searchMatch) {
    const query = searchMatch[1].trim();
    return {
      url:   `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
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
  panel.classList.add('hidden');
  overlay.classList.add('hidden');
  frame.src = 'about:blank';
  _showIframe();
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _resolveUrl(raw) {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function _isKnownBlocked(url) {
  return KNOWN_BLOCKED_DOMAINS.some(domain => url.includes(domain));
}

function _showPanel() {
  panel.classList.remove('hidden');
  overlay.classList.remove('hidden');
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
overlay.addEventListener('click', closeBrowserPanel);

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
