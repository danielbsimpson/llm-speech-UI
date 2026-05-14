# Gmail Inbox — Implementation Guide

Adds a voice-triggered Gmail panel that fetches unread messages from the user's inbox, displays
them as a structured card list, delivers a spoken LLM briefing ("You have 5 unread emails from
Sarah, GitHub, and Amazon"), and lets the user open any message for a full-text summary — all by
voice or click.

---

## Overview

```
"View my emails"
        ↓
[intercept transcript] → GET /gmail/unread  (FastAPI → Gmail API)
        ↓
Render email card list in panel
        ↓
sendToOllama() with inbox summary injected
        ↓
Kokoro TTS: "You have N unread emails. [sender list]…"


"Summarize that email" / "Open email from [sender]"
        ↓
GET /gmail/message/{id}  → full body fetched
        ↓
sendToOllama() with full email text → spoken summary
        ↓
Panel shows full email text with open/delete actions
```

---

## Architecture Decisions

| Decision | Choice | Reason |
|---|---|---|
| Auth | Google OAuth2 installed-app flow | Same flow as the Calendar guide — reuses the same `credentials/` folder and token file; no redirect URI needed |
| Scope | `gmail.readonly` + `gmail.modify` | `readonly` to fetch/display; `modify` to allow trash (delete) via voice — use `gmail.readonly` only if delete is not needed |
| Message fetch limit | 20 unread (configurable) | Keeps the spoken briefing short; user can ask for more |
| Body format | Prefer plain text, fall back to HTML→text strip | Avoids injecting raw HTML into the LLM context |
| Summarisation | Ephemeral LLM call with full body | Body is passed as ephemeral context — never stored in `conversationHistory` |
| Delete action | Move to Trash (`messages.trash`) | Non-destructive — mail stays in Trash for 30 days |
| Caching | 2-minute in-memory cache for unread list | Prevents repeated API calls; invalidated after any delete action |
| Backend only | Yes — frontend never sees OAuth tokens | All Gmail API calls go through FastAPI; frontend only talks to `localhost:8000` |

---

## Part 1 — Google Cloud Setup

### Step 1 — Enable Gmail API and Create Credentials

> **If you already followed the CALENDAR.md setup and created a Google Cloud project with OAuth
> credentials, you can reuse the same `credentials/google_calendar_credentials.json` file.**
> Just add the Gmail scope in Step 1c and re-run the auth script.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/).
2. Open your existing project (or create a new one, e.g. `starling-local`).
3. Navigate to **APIs & Services → Library**, search for **Gmail API**, and click **Enable**.
4. Navigate to **APIs & Services → OAuth consent screen**:
   - Add scope: `https://www.googleapis.com/auth/gmail.readonly`
   - Add scope: `https://www.googleapis.com/auth/gmail.modify` (for trash/delete support)
   - If your app was previously in testing mode, your existing test user still applies.
5. Navigate to **APIs & Services → Credentials → [your Desktop OAuth client] → Download JSON**.
   - Save as `credentials/google_gmail_credentials.json`.
   - Add `credentials/` to `.gitignore` if not already there.

### Step 2 — Add `.env` Variables

In `.env` and `.env.example`:

```
# ── Gmail ─────────────────────────────────────────────────────────────────────
GMAIL_CREDENTIALS_FILE=credentials/google_gmail_credentials.json
GMAIL_TOKEN_FILE=credentials/google_gmail_token.json
GMAIL_MAX_UNREAD=20          # max messages fetched per request
GMAIL_CACHE_SECONDS=120      # seconds to cache the unread list
```

### Step 3 — Install Python Dependencies

```powershell
.venv\Scripts\Activate.ps1
pip install google-api-python-client google-auth-httplib2 google-auth-oauthlib
```

(Same packages as the Calendar integration — no new dependencies if Calendar is already set up.)

### Step 4 — Create the Auth Script

Save as `scripts/auth_gmail.py` and run it once to generate the token file:

```python
"""
scripts/auth_gmail.py
Run once to authorise STARLING to access Gmail.
Saves a refresh token to GMAIL_TOKEN_FILE so the server never needs a browser again.

Usage:
    python scripts/auth_gmail.py
"""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

CREDS_FILE = Path(os.getenv("GMAIL_CREDENTIALS_FILE", "credentials/google_gmail_credentials.json"))
TOKEN_FILE  = Path(os.getenv("GMAIL_TOKEN_FILE",       "credentials/google_gmail_token.json"))

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",   # remove if delete is not needed
]

from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials

if TOKEN_FILE.exists():
    print(f"Token already exists at {TOKEN_FILE}. Delete it to re-authorise.")
else:
    flow = InstalledAppFlow.from_client_secrets_file(str(CREDS_FILE), SCOPES)
    creds = flow.run_local_server(port=0)
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(creds.to_json())
    print(f"Token saved to {TOKEN_FILE}")
```

Run it:

```powershell
python scripts/auth_gmail.py
```

A browser window will open. Sign in and grant the requested permissions. The token is saved to
`credentials/google_gmail_token.json` and the server will use it automatically from then on.

---

## Part 2 — Backend

### Step 5 — Create `backend/gmail_routes.py`

```python
"""
backend/gmail_routes.py
Gmail integration — fetch unread messages, read full body, trash messages.

Endpoints:
  GET  /gmail/unread            — list of unread messages (summary only)
  GET  /gmail/message/{msg_id}  — full message body (plain text)
  POST /gmail/trash/{msg_id}    — move message to Trash
"""

import base64
import email as email_lib
import os
import re
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

router = APIRouter()

# ── Config ─────────────────────────────────────────────────────────────────────
_CREDS_FILE   = Path(os.getenv("GMAIL_CREDENTIALS_FILE", "credentials/google_gmail_credentials.json"))
_TOKEN_FILE   = Path(os.getenv("GMAIL_TOKEN_FILE",       "credentials/google_gmail_token.json"))
_MAX_UNREAD   = int(os.getenv("GMAIL_MAX_UNREAD",  "20"))
_CACHE_SECS   = int(os.getenv("GMAIL_CACHE_SECONDS","120"))

_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
]

# ── In-memory cache ────────────────────────────────────────────────────────────
_cache: dict = {"ts": 0.0, "data": None}


def _invalidate_cache():
    _cache["ts"] = 0.0
    _cache["data"] = None


# ── Auth helper ────────────────────────────────────────────────────────────────

def _get_service():
    """Build an authenticated Gmail API service object, refreshing token if needed."""
    if not _TOKEN_FILE.exists():
        raise HTTPException(
            status_code=503,
            detail="Gmail not authorised. Run scripts/auth_gmail.py first.",
        )

    creds = Credentials.from_authorized_user_file(str(_TOKEN_FILE), _SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        _TOKEN_FILE.write_text(creds.to_json())

    return build("gmail", "v1", credentials=creds, cache_discovery=False)


# ── Text extraction helpers ────────────────────────────────────────────────────

def _decode_base64url(data: str) -> str:
    """Decode a base64url-encoded Gmail message part."""
    padded = data + "=" * (4 - len(data) % 4)
    return base64.urlsafe_b64decode(padded).decode("utf-8", errors="replace")


def _strip_html(html: str) -> str:
    """Very light HTML → plain text strip (no external dependency)."""
    text = re.sub(r"<style[^>]*>.*?</style>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _extract_body(payload: dict, prefer: str = "plain") -> str:
    """
    Recursively extract the body from a Gmail message payload.
    Prefers text/plain; falls back to text/html (stripped).
    """
    mime = payload.get("mimeType", "")

    # Leaf node
    if mime.startswith("text/"):
        data = payload.get("body", {}).get("data", "")
        if data:
            raw = _decode_base64url(data)
            return raw if mime == "text/plain" else _strip_html(raw)

    # Multipart — recurse
    parts = payload.get("parts", [])
    plain_parts = [p for p in parts if p.get("mimeType") == "text/plain"]
    html_parts  = [p for p in parts if p.get("mimeType") == "text/html"]

    for p in (plain_parts or html_parts or parts):
        result = _extract_body(p, prefer)
        if result:
            return result

    return ""


def _parse_header(headers: list[dict], name: str) -> str:
    """Extract a named header value from a list of {name, value} dicts."""
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/gmail/unread")
def get_unread(force_refresh: bool = False):
    """
    Return a list of unread messages from the inbox (summary only — no body).
    Results are cached for GMAIL_CACHE_SECONDS.
    """
    now = time.time()
    if not force_refresh and _cache["data"] and (now - _cache["ts"]) < _CACHE_SECS:
        return _cache["data"]

    svc = _get_service()

    # List unread message IDs
    result = svc.users().messages().list(
        userId="me",
        labelIds=["INBOX", "UNREAD"],
        maxResults=_MAX_UNREAD,
    ).execute()

    messages_meta = result.get("messages", [])
    messages = []

    for m in messages_meta:
        msg = svc.users().messages().get(
            userId="me",
            id=m["id"],
            format="metadata",
            metadataHeaders=["From", "Subject", "Date"],
        ).execute()

        headers = msg.get("payload", {}).get("headers", [])
        snippet = msg.get("snippet", "")

        messages.append({
            "id":      msg["id"],
            "from":    _parse_header(headers, "From"),
            "subject": _parse_header(headers, "Subject"),
            "date":    _parse_header(headers, "Date"),
            "snippet": snippet[:200],
        })

    payload = {
        "unread_count": len(messages),
        "messages":     messages,
        "cached_at":    now,
    }
    _cache["ts"]   = now
    _cache["data"] = payload
    return payload


@router.get("/gmail/message/{msg_id}")
def get_message(msg_id: str):
    """
    Fetch the full plain-text body of a single message.
    Used when the user asks to open or summarise a specific email.
    """
    svc = _get_service()

    try:
        msg = svc.users().messages().get(
            userId="me",
            id=msg_id,
            format="full",
        ).execute()
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    headers  = msg.get("payload", {}).get("headers", [])
    body     = _extract_body(msg.get("payload", {}))

    # Truncate very long emails to avoid blowing the LLM context window
    max_chars = 6000
    truncated = len(body) > max_chars
    if truncated:
        body = body[:max_chars] + "\n\n[… message truncated …]"

    return {
        "id":        msg_id,
        "from":      _parse_header(headers, "From"),
        "to":        _parse_header(headers, "To"),
        "subject":   _parse_header(headers, "Subject"),
        "date":      _parse_header(headers, "Date"),
        "body":      body,
        "truncated": truncated,
    }


@router.post("/gmail/trash/{msg_id}", status_code=200)
def trash_message(msg_id: str):
    """
    Move a message to Trash. Invalidates the unread cache.
    """
    svc = _get_service()
    try:
        svc.users().messages().trash(userId="me", id=msg_id).execute()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    _invalidate_cache()
    return {"status": "trashed", "id": msg_id}
```

### Step 6 — Register in `backend/main.py`

```python
from gmail_routes import router as gmail_router
app.include_router(gmail_router)
```

---

## Part 3 — Frontend

### Step 7 — Add Gmail Panel HTML

In `frontend/index.html`, inside `.starling` alongside the other panels:

```html
<!-- Gmail Panel -->
<div class="gmail-panel hidden" id="gmail-panel">

  <!-- ── Inbox list view ── -->
  <div class="gmail-view" id="gmail-inbox-view">
    <div class="gmail-header">
      <div class="gmail-title">INBOX</div>
      <div class="gmail-header-right">
        <span class="gmail-unread-badge" id="gmail-unread-badge">—</span>
        <button class="gmail-refresh-btn" id="gmail-refresh-btn" title="Refresh">↻</button>
        <button class="gmail-close-btn"   id="gmail-close-btn">✕</button>
      </div>
    </div>
    <div class="gmail-list" id="gmail-list">
      <div class="gmail-loading" id="gmail-loading">LOADING…</div>
    </div>
  </div>

  <!-- ── Single message view ── -->
  <div class="gmail-view hidden" id="gmail-message-view">
    <div class="gmail-header">
      <button class="gmail-back-btn" id="gmail-back-btn">← BACK</button>
      <div class="gmail-header-right">
        <button class="gmail-summarise-btn" id="gmail-summarise-btn">SUMMARISE</button>
        <button class="gmail-trash-btn"     id="gmail-trash-btn">🗑 DELETE</button>
      </div>
    </div>
    <div class="gmail-msg-meta" id="gmail-msg-meta"></div>
    <div class="gmail-msg-body" id="gmail-msg-body"></div>
  </div>

</div>
```

### Step 8 — Add the CSS

Append to `frontend/style.css`:

```css
/* ── Gmail Panel ──────────────────────────────────────────────────────────────── */

.gmail-panel {
  width: 100%;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 14px 20px;
  margin-top: 12px;
  animation: weatherFadeIn 0.3s ease;
}

.gmail-panel.hidden { display: none; }

/* Sub-view toggling */
.gmail-view        { display: flex; flex-direction: column; gap: 10px; }
.gmail-view.hidden { display: none; }

/* Header */
.gmail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  padding-bottom: 8px;
}

.gmail-title {
  font-family: 'Share Tech Mono', monospace;
  font-size: clamp(0.72rem, 1.3vw, 0.9rem);
  color: #e0e0e0;
  letter-spacing: 0.14em;
}

.gmail-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gmail-unread-badge {
  background: rgba(234, 88, 12, 0.15);
  border: 1px solid rgba(234, 88, 12, 0.3);
  border-radius: 4px;
  color: #f97316;
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.62rem;
  letter-spacing: 0.08em;
  padding: 2px 8px;
}

.gmail-refresh-btn,
.gmail-close-btn,
.gmail-back-btn,
.gmail-summarise-btn,
.gmail-trash-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 5px;
  color: #555;
  cursor: pointer;
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.6rem;
  letter-spacing: 0.08em;
  padding: 3px 8px;
  transition: color 0.15s, border-color 0.15s;
}

.gmail-refresh-btn:hover  { color: #aaa; }
.gmail-close-btn:hover    { color: #ff8888; border-color: rgba(255,100,100,0.3); }
.gmail-back-btn:hover     { color: #aaa; }
.gmail-summarise-btn      { color: #7ab8f5; border-color: rgba(122,184,245,0.2); }
.gmail-summarise-btn:hover{ color: #aad4ff; border-color: rgba(122,184,245,0.4); }
.gmail-trash-btn:hover    { color: #ff8888; border-color: rgba(255,100,100,0.3); }

.gmail-loading {
  font-size: 0.65rem;
  color: #444;
  letter-spacing: 0.1em;
  padding: 8px 0;
}

/* Email card list */
.gmail-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 360px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.08) transparent;
}

.gmail-card {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: start;
  gap: 8px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}

.gmail-card:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.1);
}

.gmail-card-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }

.gmail-from {
  font-size: 0.78rem;
  color: #ddd;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gmail-subject {
  font-size: 0.7rem;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gmail-snippet {
  font-size: 0.6rem;
  color: #444;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gmail-card-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}

.gmail-card-trash {
  background: transparent;
  border: none;
  color: #333;
  cursor: pointer;
  font-size: 0.75rem;
  padding: 2px 4px;
  transition: color 0.12s;
}
.gmail-card-trash:hover { color: #ff8888; }

.gmail-card-date {
  font-size: 0.55rem;
  color: #333;
  letter-spacing: 0.04em;
  text-align: right;
}

/* ── Message view ── */
.gmail-msg-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 0;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}

.gmail-msg-meta-row {
  display: flex;
  gap: 8px;
  font-size: 0.65rem;
}

.gmail-msg-meta-label {
  color: #444;
  letter-spacing: 0.06em;
  min-width: 52px;
  flex-shrink: 0;
}

.gmail-msg-meta-value {
  color: #aaa;
  overflow-wrap: anywhere;
}

.gmail-msg-subject {
  font-size: 0.8rem;
  color: #e0e0e0;
  padding: 6px 0 2px;
  line-height: 1.3;
}

.gmail-msg-body {
  font-size: 0.7rem;
  color: #888;
  line-height: 1.6;
  max-height: 360px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.08) transparent;
  padding: 4px 0;
}
```

### Step 9 — Create `frontend/gmail-panel.js`

```javascript
// frontend/gmail-panel.js
// Gmail panel: trigger detection, inbox fetch, message open, summarise, trash.

const BACKEND_BASE_GMAIL = 'http://localhost:8000';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const gmailPanel        = document.getElementById('gmail-panel');
const gmailInboxView    = document.getElementById('gmail-inbox-view');
const gmailMessageView  = document.getElementById('gmail-message-view');
const gmailList         = document.getElementById('gmail-list');
const gmailLoading      = document.getElementById('gmail-loading');
const gmailUnreadBadge  = document.getElementById('gmail-unread-badge');
const gmailRefreshBtn   = document.getElementById('gmail-refresh-btn');
const gmailCloseBtn     = document.getElementById('gmail-close-btn');
const gmailBackBtn      = document.getElementById('gmail-back-btn');
const gmailSummariseBtn = document.getElementById('gmail-summarise-btn');
const gmailTrashBtn     = document.getElementById('gmail-trash-btn');
const gmailMsgMeta      = document.getElementById('gmail-msg-meta');
const gmailMsgBody      = document.getElementById('gmail-msg-body');

// ── State ─────────────────────────────────────────────────────────────────────
let _openMessage  = null;   // the full message object currently shown in message view
let _inboxData    = null;   // most recent inbox response

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Detect an inbox view trigger.
 * Returns { action } or null.
 *
 * Activation phrases:
 *   "view my emails"
 *   "check my email"
 *   "show my inbox"
 *   "do I have any new emails"
 *   "any new mail"
 *   "open my Gmail"
 *   "read my emails"
 */
export function detectGmailTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  // Open a specific email by sender name
  const openMatch = t.match(
    /\b(?:open|read|show)\b.{0,20}\b(?:email|message|mail)\b.{0,20}\b(?:from)\s+(.+)/
  );
  if (openMatch) return { action: 'open_by_sender', sender: openMatch[1].trim() };

  // Summarise the currently open email
  if (/\b(?:summari[sz]e|summarise|sum up|give me a summary of)\b.{0,20}\b(?:that\s+)?(?:email|message|mail)\b/.test(t) ||
      /\bwhat(?:'s| does)\b.{0,15}\b(?:it|this|that|the email)\b.{0,20}\bsay\b/.test(t)) {
    return { action: 'summarise' };
  }

  // Delete / trash the open email
  if (/\b(?:delete|trash|remove|discard)\b.{0,20}\b(?:that\s+)?(?:email|message|mail)\b/.test(t) ||
      /\b(?:delete|trash)\b.{0,20}\b(?:it|this one)\b/.test(t)) {
    return { action: 'trash_open' };
  }

  // Inbox view
  const inboxPatterns = [
    /\b(?:view|check|open|show|read|see|get)\b.{0,20}\b(?:my\s+)?(?:emails?|inbox|gmail|mail)\b/,
    /\bdo\s+i\s+have\b.{0,20}\b(?:new\s+)?(?:emails?|messages?|mail)\b/,
    /\bany\s+(?:new\s+)?(?:emails?|messages?|mail)\b/,
  ];
  if (inboxPatterns.some(p => p.test(t))) return { action: 'inbox' };

  return null;
}

// ── Inbox fetch ───────────────────────────────────────────────────────────────

/**
 * Fetch unread messages and render the inbox panel.
 * Returns { spoken, llmContext } for the caller (app.js) to pass to the LLM.
 */
export async function openInbox(forceRefresh = false) {
  _showPanel();
  _showView('inbox');
  gmailLoading.style.display = 'block';
  gmailList.innerHTML = '';

  let data;
  try {
    const url = `${BACKEND_BASE_GMAIL}/gmail/unread${forceRefresh ? '?force_refresh=true' : ''}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    gmailLoading.textContent = `ERROR: ${err.message}`;
    return { spoken: 'Could not fetch emails. Please check the backend.', llmContext: null };
  }

  _inboxData = data;
  gmailLoading.style.display = 'none';
  gmailUnreadBadge.textContent = `${data.unread_count} UNREAD`;

  _renderInboxList(data.messages);

  if (!data.messages.length) {
    return { spoken: 'Your inbox is clear. No unread messages.', llmContext: null };
  }

  // Build LLM context — sender list + subjects (no bodies at this stage)
  const senderLines = data.messages.slice(0, 15).map((m, i) => {
    const sender  = _extractName(m.from);
    const subject = m.subject || '(no subject)';
    return `${i + 1}. From: ${sender} — Subject: ${subject}`;
  }).join('\n');

  const llmContext =
    `[GMAIL INBOX — ${data.unread_count} unread]\n${senderLines}`;

  return { spoken: null, llmContext };  // null = let LLM build the spoken briefing
}

// ── Open message by sender name ───────────────────────────────────────────────

export async function openBySender(senderQuery) {
  if (!_inboxData) {
    await openInbox();
  }
  const query = senderQuery.toLowerCase();
  const match  = (_inboxData?.messages ?? []).find(m =>
    m.from.toLowerCase().includes(query) ||
    m.subject.toLowerCase().includes(query)
  );
  if (!match) {
    return { spoken: `No unread email from ${senderQuery} found in your inbox.`, llmContext: null };
  }
  return await openMessage(match.id);
}

// ── Open full message ─────────────────────────────────────────────────────────

export async function openMessage(msgId) {
  _showPanel();
  _showView('message');
  gmailMsgBody.textContent = 'Loading…';
  gmailMsgMeta.innerHTML   = '';

  let msg;
  try {
    const res = await fetch(`${BACKEND_BASE_GMAIL}/gmail/message/${msgId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    msg = await res.json();
  } catch (err) {
    gmailMsgBody.textContent = `Error: ${err.message}`;
    return { spoken: 'Could not load that email.', llmContext: null };
  }

  _openMessage = msg;
  _renderMessageView(msg);

  // Build LLM context for an optional immediate briefing
  const llmContext =
    `[EMAIL OPENED]\n` +
    `From: ${msg.from}\nTo: ${msg.to}\nSubject: ${msg.subject}\nDate: ${msg.date}\n\n` +
    `${msg.body}`;

  return { spoken: null, llmContext };
}

// ── Summarise open message ────────────────────────────────────────────────────

export function getOpenMessageContext() {
  if (!_openMessage) return null;
  return (
    `[EMAIL — SUMMARISE REQUEST]\n` +
    `From: ${_openMessage.from}\nSubject: ${_openMessage.subject}\n\n` +
    `${_openMessage.body}`
  );
}

// ── Trash open message ────────────────────────────────────────────────────────

export async function trashOpenMessage() {
  if (!_openMessage) return { spoken: 'No email is currently open.' };
  const id      = _openMessage.id;
  const subject = _openMessage.subject || 'that email';
  try {
    await fetch(`${BACKEND_BASE_GMAIL}/gmail/trash/${id}`, { method: 'POST' });
    // Remove the card from the inbox list (if still rendered)
    document.querySelector(`.gmail-card[data-id="${id}"]`)?.remove();
    // Update badge count
    const remaining = gmailList.querySelectorAll('.gmail-card').length;
    gmailUnreadBadge.textContent = `${remaining} UNREAD`;
  } catch { /* ignore */ }
  _openMessage = null;
  _showView('inbox');
  return { spoken: `Deleted: ${_extractSubjectSpoken(subject)}.` };
}

// ── Render helpers ─────────────────────────────────────────────────────────────

function _renderInboxList(messages) {
  gmailList.innerHTML = '';
  if (!messages.length) {
    gmailList.innerHTML = '<div class="gmail-loading">No unread messages.</div>';
    return;
  }
  messages.forEach(m => {
    const card     = document.createElement('div');
    card.className = 'gmail-card';
    card.dataset.id = m.id;

    const dateStr = _formatDate(m.date);

    card.innerHTML = `
      <div class="gmail-card-body">
        <div class="gmail-from">${_esc(_extractName(m.from))}</div>
        <div class="gmail-subject">${_esc(m.subject || '(no subject)')}</div>
        <div class="gmail-snippet">${_esc(m.snippet)}</div>
      </div>
      <div class="gmail-card-actions">
        <button class="gmail-card-trash" data-id="${_esc(m.id)}" title="Trash">🗑</button>
        <span class="gmail-card-date">${_esc(dateStr)}</span>
      </div>
    `;

    // Open on card click
    card.addEventListener('click', async (e) => {
      if (e.target.closest('.gmail-card-trash')) return;
      await openMessage(m.id);
    });

    // Trash from list
    card.querySelector('.gmail-card-trash').addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = e.currentTarget.dataset.id;
      await fetch(`${BACKEND_BASE_GMAIL}/gmail/trash/${id}`, { method: 'POST' }).catch(() => {});
      card.remove();
      const remaining = gmailList.querySelectorAll('.gmail-card').length;
      gmailUnreadBadge.textContent = `${remaining} UNREAD`;
    });

    gmailList.appendChild(card);
  });
}

function _renderMessageView(msg) {
  const dateStr = _formatDate(msg.date);
  gmailMsgMeta.innerHTML = `
    <div class="gmail-msg-subject">${_esc(msg.subject || '(no subject)')}</div>
    <div class="gmail-msg-meta-row">
      <span class="gmail-msg-meta-label">FROM</span>
      <span class="gmail-msg-meta-value">${_esc(msg.from)}</span>
    </div>
    <div class="gmail-msg-meta-row">
      <span class="gmail-msg-meta-label">TO</span>
      <span class="gmail-msg-meta-value">${_esc(msg.to)}</span>
    </div>
    <div class="gmail-msg-meta-row">
      <span class="gmail-msg-meta-label">DATE</span>
      <span class="gmail-msg-meta-value">${_esc(dateStr)}</span>
    </div>
  `;
  gmailMsgBody.textContent = msg.body || '(no body)';
}

// ── Panel / view helpers ──────────────────────────────────────────────────────

function _showPanel() {
  gmailPanel.classList.remove('hidden');
  gmailPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function _showView(which) {
  gmailInboxView.classList.toggle('hidden',   which !== 'inbox');
  gmailMessageView.classList.toggle('hidden', which !== 'message');
}

// ── Button wiring ─────────────────────────────────────────────────────────────
gmailCloseBtn?.addEventListener('click', () => gmailPanel.classList.add('hidden'));
gmailRefreshBtn?.addEventListener('click', () => openInbox(true));
gmailBackBtn?.addEventListener('click', () => _showView('inbox'));

// Summarise and Trash buttons are wired in Step 10 (app.js) so they can call sendToOllama
export function wireGmailActionButtons(sendToOllamaFn, systemPrompt, appendMessageFn, enqueueSpeakFn, setStateFn) {
  gmailSummariseBtn?.addEventListener('click', async () => {
    const ctx = getOpenMessageContext();
    if (!ctx) return;
    setStateFn('thinking');
    await sendToOllamaFn(
      'Please summarise this email concisely in 3-5 sentences. ' +
      'State who it is from, what they want or are communicating, and any action required.',
      { ephemeralMessages: [
          { role: 'system', content: systemPrompt },
          { role: 'system', content: ctx },
      ]},
    );
  });

  gmailTrashBtn?.addEventListener('click', async () => {
    const { spoken } = await trashOpenMessage();
    if (spoken) {
      const { txt } = appendMessageFn('assistant', spoken);
      enqueueSpeakFn(spoken, () => { txt.textContent = spoken; });
    }
  });
}

// ── Utility helpers ───────────────────────────────────────────────────────────

/** Extract a human-readable name from a "Display Name <email@address>" header. */
function _extractName(from = '') {
  const m = from.match(/^([^<]+)</);
  if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  return from.split('@')[0];   // fallback: local part of email address
}

/** Shorten a subject line for TTS (strip RE:/FWD: prefixes, truncate). */
function _extractSubjectSpoken(subject = '') {
  return subject.replace(/^(?:re|fwd?|fw):\s*/i, '').slice(0, 80);
}

function _formatDate(dateStr = '') {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return dateStr; }
}

function _esc(s) {
  return (s || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

### Step 10 — Wire into `app.js`

#### 10a — Import

```javascript
import {
  detectGmailTrigger,
  openInbox,
  openBySender,
  openMessage,
  getOpenMessageContext,
  trashOpenMessage,
  wireGmailActionButtons,
} from './gmail-panel.js';
```

#### 10b — Wire action buttons once on page load

Add this **once**, near the bottom of the top-level initialisation block (after all DOM is ready):

```javascript
wireGmailActionButtons(sendToOllama, SYSTEM_PROMPT, appendMessage, enqueueSpeak, setState);
```

#### 10c — Add Gmail intercepts in `mediaRecorder.onstop`

Place after all existing feature intercepts, before the final `sendToOllama` call:

```javascript
        // ── Gmail trigger ─────────────────────────────────────────────────
        const _gmailTrigger = detectGmailTrigger(transcript);
        if (_gmailTrigger) {
          setState('thinking');
          appendMessage('user', transcript);

          if (_gmailTrigger.action === 'inbox') {
            const { spoken, llmContext } = await openInbox();
            if (llmContext) {
              await sendToOllama(
                'Deliver a concise spoken inbox briefing. ' +
                'State the total number of unread emails, then briefly mention ' +
                'who the first few are from and the subject where notable. ' +
                'Keep it under 4 sentences.',
                { ephemeralMessages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'system', content: llmContext },
                ]},
              );
            } else if (spoken) {
              const { txt } = appendMessage('assistant', spoken);
              enqueueSpeak(spoken, () => { txt.textContent = spoken; });
              setState('idle');
            }

          } else if (_gmailTrigger.action === 'open_by_sender') {
            const { spoken, llmContext } = await openBySender(_gmailTrigger.sender);
            if (llmContext) {
              await sendToOllama(
                'Briefly tell me who this email is from and summarise the subject ' +
                'in one sentence. Do not read the full body.',
                { ephemeralMessages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'system', content: llmContext },
                ]},
              );
            } else if (spoken) {
              const { txt } = appendMessage('assistant', spoken);
              enqueueSpeak(spoken, () => { txt.textContent = spoken; });
              setState('idle');
            }

          } else if (_gmailTrigger.action === 'summarise') {
            const ctx = getOpenMessageContext();
            if (!ctx) {
              const spoken = 'No email is currently open. Say "view my emails" first.';
              const { txt } = appendMessage('assistant', spoken);
              enqueueSpeak(spoken, () => { txt.textContent = spoken; });
              setState('idle');
            } else {
              await sendToOllama(
                'Summarise this email concisely in 3-5 sentences. ' +
                'State who it is from, what they are communicating, and any action required.',
                { ephemeralMessages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'system', content: ctx },
                ]},
              );
            }

          } else if (_gmailTrigger.action === 'trash_open') {
            const { spoken } = await trashOpenMessage();
            const { txt } = appendMessage('assistant', spoken);
            enqueueSpeak(spoken, () => { txt.textContent = spoken; });
            setState('idle');
          }

          fetchSystemStatus();
          return;
        }
        // ─────────────────────────────────────────────────────────────────
```

#### 10d — Mirror in `handleSend`

Add the same `detectGmailTrigger` block inside `handleSend()` with identical logic. Replace
`transcript` with `text` (the variable name in `handleSend`).

#### 10e — Add to clear handler

```javascript
clearBtn.addEventListener('click', () => {
  clearAudioQueue();
  exitPresMode();
  exitJournalMode();
  exitIdeasMode();
  gmailPanel?.classList.add('hidden');   // ← add this
  // ... rest of existing clear logic
});
```

---

## Step 11 — Full Intercept Order Reference

```
1.  journalMode active           — journal segment accumulation  ← MUST be first
2.  ideasMode active             — single-press idea capture
3.  _matchesExitPhrase           — dossier exit
4.  _parseTrigger                — dossier open
5.  detectJournalStartTrigger    — enter journal dictation mode
6.  detectJournalReadTrigger     — journal read / search / delete
7.  detectIdeaCaptureTrigger     — enter ideas capture mode
8.  detectIdeaReadTrigger        — ideas list / search / discard / clear
9.  detectTimerTrigger           — timer set / cancel / status
10. detectTimeTrigger            — time / date query
11. detectWeatherTrigger         — weather
12. detectCalendarTrigger        — calendar
13. detectNewsTrigger            — news briefing
14. detectMarketTrigger          — stocks / crypto
15. detectGmailTrigger           — Gmail inbox / open / summarise / trash
16. appendMessage + sendToOllama — normal LLM path (catch-all)
```

---

## Example Interaction Flows

### Inbox briefing
```
User:     "View my emails."
Panel:    Gmail inbox appears with unread cards
Starling: "You have 7 unread emails. Two are from GitHub — pull request notifications.
           One is from Sarah about the project meeting on Friday, and there's an order
           confirmation from Amazon."
```

### Opening by sender
```
User:     "Open the email from Sarah."
Panel:    Message view shows Sarah's email
Starling: "Sarah's email is about the project meeting. She's asking to reschedule to Thursday."
```

### Summarising the open email
```
User:     "Summarize that email."
Starling: "Sarah sent this email on Tuesday asking to reschedule the Friday project meeting
           to Thursday at 2pm due to a conflict. She's requesting your confirmation.
           No attachments. Action required: reply with your availability."
```

### Deleting by voice
```
User:     "Delete that email."
Starling: "Deleted: project meeting reschedule."
Panel:    Returns to inbox view; card removed
```

### Deleting from the card list
```
User clicks the 🗑 icon on any card.
Card is removed immediately; unread count decrements.
```

---

## File Change Summary

| File | Change |
|---|---|
| `.env` / `.env.example` | Add `GMAIL_CREDENTIALS_FILE`, `GMAIL_TOKEN_FILE`, `GMAIL_MAX_UNREAD`, `GMAIL_CACHE_SECONDS` |
| `credentials/google_gmail_credentials.json` | Downloaded from Google Cloud Console — add `credentials/` to `.gitignore` |
| `credentials/google_gmail_token.json` | Auto-created by `auth_gmail.py` — add to `.gitignore` |
| `scripts/auth_gmail.py` | **New file** — one-time OAuth authorisation script |
| `backend/gmail_routes.py` | **New file** — unread list, full message, trash endpoints |
| `backend/main.py` | Import and register `gmail_router` |
| `frontend/index.html` | Add Gmail panel HTML (inbox view + message view) |
| `frontend/style.css` | Append Gmail panel CSS block |
| `frontend/gmail-panel.js` | **New file** — trigger detection, fetch, render, summarise, trash |
| `frontend/app.js` | Import module; `wireGmailActionButtons()` call on init; Gmail intercept in onstop + handleSend; close panel in clear handler |

---

## Limitations and Edge Cases

**First-run auth** — The backend will return HTTP 503 with a clear error message if
`google_gmail_token.json` does not exist. Run `python scripts/auth_gmail.py` once before
starting the server. The token auto-refreshes silently from then on.

**OAuth scope change** — If you initially ran the auth script with `gmail.readonly` only and
later want to add trash (delete) support, delete `credentials/google_gmail_token.json` and
re-run `auth_gmail.py`. The new consent screen will request the additional scope.

**Large email bodies** — Bodies are truncated to 6000 characters in `get_message()` before
being returned to the frontend and injected into the LLM context. This prevents the LLM context
window from being overwhelmed by long newsletters or threads. The `truncated: true` field in the
response can be used to show a notice in the UI.

**HTML-only emails** — Newsletters and marketing emails often have no plain-text part. The
`_strip_html()` helper removes tags and condenses whitespace. The result may be rough for
heavily templated emails, but will be readable and summarisable by the LLM.

**Thread vs. single message** — The Gmail API's `messages.list` returns individual message IDs,
not threads. If a conversation has 10 replies, each reply appears as a separate card. For a
cleaner experience, switch to `threads.list` instead of `messages.list` in `get_unread()` —
same API, returns `threadId` instead of `messageId`. The rest of the code is identical.

**Google Workspace accounts** — If the Gmail account is a Google Workspace (G Suite) account
rather than a personal Gmail, an admin may need to approve the OAuth app. For personal use this
does not apply.

**Rate limits** — The Gmail API allows 1 billion quota units per day for personal projects; each
`messages.get` costs 5 units. Fetching 20 messages costs 100 units — far below any practical
limit. The 2-minute cache further reduces API calls.
