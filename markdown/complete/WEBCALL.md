# In-UI Browser Panel — Implementation Guide

Adds a floating browser panel that opens instantly when a trigger phrase is detected in the
Whisper transcript, before the LLM pipeline is involved.

---

## Overview

```
Microphone → Whisper STT → [intercept transcript] → open panel immediately
                                    ↓
                           (optional) LLM spoken acknowledgment
```

The key principle: **parse the transcript for intent before sending it to the LLM**. The panel
opens with zero LLM latency.

---

## Step 1 — Add the Browser Panel HTML

In `frontend/index.html`, add the panel markup just before the closing `</body>` tag.

```html
<!-- Browser Panel -->
<div id="browser-panel" class="browser-panel hidden">
  <div class="browser-toolbar">
    <button id="browser-back" title="Back">&#8592;</button>
    <button id="browser-forward" title="Forward">&#8594;</button>
    <button id="browser-refresh" title="Refresh">&#8635;</button>
    <input id="browser-url-bar" type="text" spellcheck="false" />
    <button id="browser-go">Go</button>
    <button id="browser-close" title="Close">&#x2715;</button>
  </div>

  <div id="browser-iframe-container">
    <iframe
      id="browser-frame"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      referrerpolicy="no-referrer"
    ></iframe>
  </div>

  <div id="browser-fallback" class="hidden">
    <p>This site can't be displayed here due to its security policy.</p>
    <a id="browser-external-link" target="_blank" rel="noopener noreferrer">
      Open in new tab &#8599;
    </a>
  </div>
</div>

<!-- Overlay (click outside to close) -->
<div id="browser-overlay" class="browser-overlay hidden"></div>
```

---

## Step 2 — Add the CSS

In `frontend/style.css`, append the following block.

```css
/* ── Browser Panel ─────────────────────────────────────────────────────────── */

.browser-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 900;
}

.browser-panel {
  position: fixed;
  top: 5vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(90vw, 1100px);
  height: 85vh;
  background: #0e0e0e;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  z-index: 901;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.7);
  overflow: hidden;
}

.browser-panel.hidden,
.browser-overlay.hidden {
  display: none;
}

.browser-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  background: #1a1a1a;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.browser-toolbar button {
  background: rgba(255, 255, 255, 0.06);
  border: none;
  border-radius: 6px;
  color: #ccc;
  cursor: pointer;
  font-size: 15px;
  padding: 5px 10px;
  transition: background 0.15s;
}

.browser-toolbar button:hover {
  background: rgba(255, 255, 255, 0.14);
}

#browser-url-bar {
  flex: 1;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #e0e0e0;
  font-size: 13px;
  padding: 5px 10px;
  outline: none;
}

#browser-url-bar:focus {
  border-color: rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.1);
}

#browser-iframe-container {
  flex: 1;
  overflow: hidden;
}

#browser-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}

#browser-fallback {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: #aaa;
  font-size: 15px;
}

#browser-fallback.hidden {
  display: none;
}

#browser-external-link {
  color: #7eb8f7;
  font-size: 15px;
  text-decoration: none;
}

#browser-external-link:hover {
  text-decoration: underline;
}
```

---

## Step 3 — Add the Browser Panel Module

Create a new file `frontend/browser-panel.js`. Keeping this logic separate from `app.js` makes
it easy to maintain and test independently.

```javascript
// frontend/browser-panel.js
// Handles the in-UI browser panel: trigger detection, rendering, and toolbar controls.

const KNOWN_BLOCKED_DOMAINS = [
  'google.com', 'youtube.com', 'twitter.com', 'x.com',
  'reddit.com', 'facebook.com', 'instagram.com', 'linkedin.com',
  'amazon.com', 'netflix.com',
];

// ── DOM refs ────────────────────────────────────────────────────────────────

const panel     = document.getElementById('browser-panel');
const overlay   = document.getElementById('browser-overlay');
const frame     = document.getElementById('browser-frame');
const urlBar    = document.getElementById('browser-url-bar');
const fallback  = document.getElementById('browser-fallback');
const extLink   = document.getElementById('browser-external-link');
const iframeBox = document.getElementById('browser-iframe-container');

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Given a raw Whisper transcript, check for a browser trigger phrase.
 * Returns the resolved URL string if found, otherwise null.
 */
export function detectBrowserTrigger(transcript) {
  const t = transcript.trim();

  // "open https://example.com" — full URL
  const fullUrl = t.match(/(?:open|go to|navigate to|show me|load)\s+(https?:\/\/\S+)/i);
  if (fullUrl) return fullUrl[1];

  // "open example.com" — bare domain
  const bareDomain = t.match(/(?:open|go to|navigate to|show me|load)\s+([\w-]+(?:\.[\w-]+)+\.\w{2,}(?:\/\S*)?)/i);
  if (bareDomain) return `https://${bareDomain[1]}`;

  return null;
}

/**
 * Open the browser panel and navigate to the given URL.
 * Call this as soon as detectBrowserTrigger returns a URL.
 */
export function openBrowserPanel(url) {
  const resolved = resolveUrl(url);

  showPanel();
  navigateTo(resolved);
}

/**
 * Close the panel and reset state.
 */
export function closeBrowserPanel() {
  panel.classList.add('hidden');
  overlay.classList.add('hidden');
  frame.src = 'about:blank';
  showIframe();
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function resolveUrl(raw) {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function isKnownBlocked(url) {
  return KNOWN_BLOCKED_DOMAINS.some(domain => url.includes(domain));
}

function showPanel() {
  panel.classList.remove('hidden');
  overlay.classList.remove('hidden');
}

function showIframe() {
  iframeBox.classList.remove('hidden');
  fallback.classList.add('hidden');
}

function showFallback(url) {
  iframeBox.classList.add('hidden');
  fallback.classList.remove('hidden');
  extLink.href = url;
  extLink.textContent = `Open ${url} in new tab ↗`;
}

function navigateTo(url) {
  urlBar.value = url;
  extLink.href = url;

  if (isKnownBlocked(url)) {
    showFallback(url);
    return;
  }

  showIframe();
  frame.src = url;

  // Fallback: if the iframe fires an error event, show the fallback UI.
  // Note: cross-origin load failures are silent in most browsers; this catches
  // same-origin errors and network failures.
  frame.onerror = () => showFallback(url);
}

// ── Toolbar event listeners ──────────────────────────────────────────────────

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
  navigateTo(resolveUrl(urlBar.value.trim()));
});

urlBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigateTo(resolveUrl(urlBar.value.trim()));
});
```

---

## Step 4 — Wire it into `app.js`

Find the section in `app.js` where you receive the Whisper transcript (the response from
`/transcribe`). It will look something like:

```javascript
// Existing code — somewhere after the fetch to /transcribe
const data = await response.json();
const transcript = data.transcript;

// Then it sends transcript to the LLM...
sendToLLM(transcript);
```

Modify it to intercept before the LLM call:

```javascript
import { detectBrowserTrigger, openBrowserPanel } from './browser-panel.js';

// ...

const data = await response.json();
const transcript = data.transcript;

// ── Browser trigger intercept ────────────────────────────────────────────────
const triggerUrl = detectBrowserTrigger(transcript);

if (triggerUrl) {
  openBrowserPanel(triggerUrl);

  // Optional: send a short prompt so the LLM gives a spoken acknowledgment.
  // Remove this block entirely if you'd prefer silence.
  sendToLLM(`The user asked to open ${triggerUrl}. Acknowledge in one short sentence.`);
  return; // skip normal LLM pipeline
}
// ────────────────────────────────────────────────────────────────────────────

// Normal pipeline continues
sendToLLM(transcript);
```

---

## Step 5 — Import the module in `index.html`

If you're using plain JS (no bundler), add the script tag with `type="module"` so ES module
imports work. In `index.html`:

```html
<!-- Replace your existing app.js script tag with this -->
<script type="module" src="app.js"></script>
```

You do **not** need a separate `<script>` tag for `browser-panel.js` — `app.js` imports it
directly via `import`.

> If you're already using the React/Vite frontend, the import in Step 4 is all you need. Vite
> handles module resolution automatically.

---

## Step 6 — Extend the Trigger Phrases (Optional)

The `detectBrowserTrigger` function in `browser-panel.js` is the single place to add new
patterns. Some useful additions:

```javascript
// "search Wikipedia for X" — returns the Wikipedia article URL
const wikiMatch = t.match(/(?:search|look up|open|find)\s+(?:wikipedia\s+for\s+|on\s+wikipedia\s+)?(.+?)\s+on\s+wikipedia/i)
                || t.match(/wikipedia\s+(?:for|on|about)\s+(.+)/i);
if (wikiMatch) return `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiMatch[1].trim())}`;

// "search for X" — falls back to a DuckDuckGo search (iframe-friendly)
const searchMatch = t.match(/search\s+(?:for\s+)?(.+)/i);
if (searchMatch) return `https://duckduckgo.com/?q=${encodeURIComponent(searchMatch[1].trim())}`;
```

> **Note on DuckDuckGo:** DuckDuckGo does not block iframes, making it a practical general-purpose
> fallback for search. Google does block iframes and should be avoided.

---

## Step 7 — Wikipedia Deep Integration (Roadmap Item)

When you're ready to build the Wikipedia feature properly, you can bypass the iframe entirely and
use Wikipedia's REST API. This gives you the article text for the LLM context window at the same
time as rendering it.

In `browser-panel.js`, detect Wikipedia URLs and route them to a dedicated handler:

```javascript
// In navigateTo(), before setting frame.src:
if (url.includes('wikipedia.org/wiki/')) {
  const title = url.split('/wiki/')[1];
  loadWikipediaArticle(title);
  return;
}
```

```javascript
async function loadWikipediaArticle(title) {
  showIframe(); // or swap to a custom render container

  const [summaryRes, htmlRes] = await Promise.all([
    fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`),
    fetch(`https://en.wikipedia.org/api/rest_v1/page/html/${title}`),
  ]);

  const summary = await summaryRes.json();
  const articleHtml = await htmlRes.text();

  // Render the article in the iframe via srcdoc (no X-Frame-Options restriction)
  frame.srcdoc = `
    <html>
      <head><base href="https://en.wikipedia.org/" /><meta charset="utf-8"></head>
      <body style="font-family: sans-serif; padding: 24px; max-width: 860px; margin: auto;">
        ${articleHtml}
      </body>
    </html>
  `;

  // Return the plain-text extract to inject into the LLM context window
  return summary.extract;
}
```

The return value (`summary.extract`) can be passed to your LLM call as additional context:

```javascript
const articleText = await loadWikipediaArticle(title);
sendToLLM(transcript, { context: `Wikipedia article:\n\n${articleText}` });
```

---

## File Change Summary

| File | Change |
|---|---|
| `frontend/index.html` | Add browser panel + overlay HTML; ensure `<script type="module">` |
| `frontend/style.css` | Append browser panel CSS block |
| `frontend/browser-panel.js` | **New file** — trigger detection, panel logic, toolbar controls |
| `frontend/app.js` | Import module; add intercept block after Whisper transcript is received |

---

## Limitations to Be Aware Of

**Sites that block iframes** — Most major sites (Google, YouTube, Reddit, Twitter/X, etc.) send
`X-Frame-Options: DENY` and will show as blank or error. The `KNOWN_BLOCKED_DOMAINS` list in
`browser-panel.js` catches these upfront and shows the fallback UI with an "open in new tab"
link instead.

**Cross-origin iframe load failures are silent** — Browsers don't expose a reliable error event
for cross-origin iframe blocks. The `frame.onerror` handler catches network failures but not
CSP/X-Frame-Options rejections. The known-domains list is the practical workaround.

**Electron fixes this entirely** — Once you package the app with Electron (already on your
roadmap), swap `<iframe>` for `<webview>`. Electron's webview renders a full Chromium instance
and is not subject to X-Frame-Options, making the browser panel work for any URL.