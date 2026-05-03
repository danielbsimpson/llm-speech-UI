#!/usr/bin/env bash
# scripts/setup.sh — One-shot install for JARVIS Local AI
set -euo pipefail

echo "==> Checking Python..."
python3 --version

echo "==> Creating virtual environment..."
python3 -m venv .venv
source .venv/bin/activate

echo "==> Installing Python dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

echo "==> Copying .env.example to .env (if not present)..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    Created .env — edit it to set your model and config."
fi

echo ""
echo "Setup complete!"
echo "  Activate venv:      source .venv/bin/activate"
echo "  Start backend:      uvicorn backend.main:app --reload --port 8000"
echo "  Open frontend:      open frontend/index.html  (or use live-server)"
