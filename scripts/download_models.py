#!/usr/bin/env python3
"""
Download Kokoro TTS v1.0 model files into the models/ directory.

Usage:
    python scripts/download_models.py

Files downloaded (~330 MB total):
    models/kokoro-v1.0.onnx   (~300 MB)
    models/voices-v1.0.bin    (~  30 MB)
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

MODELS_DIR = Path(__file__).parent.parent / "models"

FILES = {
    "kokoro-v1.0.onnx": (
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/"
        "model-files-v1.0/kokoro-v1.0.onnx"
    ),
    "voices-v1.0.bin": (
        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/"
        "model-files-v1.0/voices-v1.0.bin"
    ),
}


def _progress(filename: str):
    """Return a urllib reporthook that prints a simple progress bar."""
    def hook(block_num: int, block_size: int, total_size: int):
        downloaded = block_num * block_size
        if total_size > 0:
            pct = min(100, downloaded * 100 // total_size)
            mb = downloaded / 1_048_576
            total_mb = total_size / 1_048_576
            bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
            print(f"\r  [{bar}] {pct:3d}%  {mb:.1f}/{total_mb:.1f} MB", end="", flush=True)
        else:
            mb = downloaded / 1_048_576
            print(f"\r  {mb:.1f} MB downloaded…", end="", flush=True)
    return hook


def main():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    for filename, url in FILES.items():
        dest = MODELS_DIR / filename
        if dest.exists():
            print(f"✓  {filename} already exists — skipping.")
            continue

        print(f"↓  Downloading {filename}…")
        try:
            urllib.request.urlretrieve(url, dest, reporthook=_progress(filename))
            print()  # newline after progress bar
            size_mb = dest.stat().st_size / 1_048_576
            print(f"✓  Saved {filename} ({size_mb:.1f} MB)")
        except Exception as exc:
            print(f"\n✗  Failed to download {filename}: {exc}", file=sys.stderr)
            dest.unlink(missing_ok=True)
            sys.exit(1)

    print("\nAll model files ready. You can now start the backend:")
    print("  uvicorn backend.main:app --reload --port 8000")


if __name__ == "__main__":
    main()
