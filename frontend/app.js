// ── Config ──────────────────────────────────────────────────────────────────
const OLLAMA_BASE = 'http://localhost:11434';
const MODEL = localStorage.getItem('jarvis_model') || 'llama3.1:8b';
const SYSTEM_PROMPT =
  'You are JARVIS, a highly capable AI assistant created to serve. Be concise, precise, and direct. Avoid unnecessary pleasantries.';

// ── State ────────────────────────────────────────────────────────────────────
let conversationHistory = [
  { role: 'system', content: SYSTEM_PROMPT },
];

// ── DOM refs ─────────────────────────────────────────────────────────────────
const chatWindow = document.getElementById('chat-window');
const micBtn = document.getElementById('mic-btn');
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');
const statusEl = document.getElementById('status');

// ── Helpers ──────────────────────────────────────────────────────────────────
function setStatus(msg) {
  statusEl.textContent = msg;
}

function appendMessage(role, content) {
  const div = document.createElement('div');
  div.classList.add('message', role);
  div.textContent = content;
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return div;
}

// ── Ollama streaming chat ─────────────────────────────────────────────────────
async function sendToOllama(userText) {
  conversationHistory.push({ role: 'user', content: userText });

  const assistantDiv = appendMessage('assistant', '');
  setStatus('Thinking...');

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: conversationHistory,
        stream: true,
      }),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          const token = json?.message?.content ?? '';
          fullResponse += token;
          assistantDiv.textContent = fullResponse;
          chatWindow.scrollTop = chatWindow.scrollHeight;
        } catch {
          // partial JSON — skip
        }
      }
    }

    conversationHistory.push({ role: 'assistant', content: fullResponse });
    setStatus(`Model: ${MODEL}`);
    return fullResponse;
  } catch (err) {
    assistantDiv.textContent = `[Error: ${err.message}]`;
    setStatus('Error — is Ollama running?');
    return null;
  }
}

// ── Text-to-Speech (browser) ──────────────────────────────────────────────────
function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = 0.95;
  utt.pitch = 0.85;
  window.speechSynthesis.speak(utt);
}

// ── Send handler ─────────────────────────────────────────────────────────────
async function handleSend() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  appendMessage('user', text);
  const response = await sendToOllama(text);
  if (response) speak(response);
}

sendBtn.addEventListener('click', handleSend);
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

// ── Speech-to-Text (Web Speech API) ─────────────────────────────────────────
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  micBtn.addEventListener('click', () => {
    recognition.start();
    micBtn.classList.add('recording');
    setStatus('Listening...');
  });

  recognition.onresult = async (event) => {
    const transcript = event.results[0][0].transcript;
    micBtn.classList.remove('recording');
    appendMessage('user', transcript);
    const response = await sendToOllama(transcript);
    if (response) speak(response);
  };

  recognition.onerror = (event) => {
    micBtn.classList.remove('recording');
    setStatus(`STT error: ${event.error}`);
  };

  recognition.onend = () => {
    micBtn.classList.remove('recording');
  };
} else {
  micBtn.disabled = true;
  micBtn.textContent = 'Mic unavailable';
  setStatus('Web Speech API not supported — use text input');
}

// ── Init ─────────────────────────────────────────────────────────────────────
setStatus(`Model: ${MODEL} — Ready`);
