#!/usr/bin/env python3
"""
Launch everything MyTasks needs, with one command:

    python launch.py

Starts (only the pieces that aren't already running):
  - WAMP (Apache + MySQL)      -> via wampmanager.exe
  - whisper.cpp server         -> voice-to-text, port 8081
  - Ollama                     -> local LLM chat fallback, port 11434

Then opens the web app in your default browser. Everything here is
optional except WAMP: if whisper.cpp or Ollama can't be found/started,
the app still works fine (voice/AI-chat features just fail soft, same
as they do at runtime -- see WhisperClient.php / OllamaClient.php).

Edit the paths in CONFIG below if your setup differs from the one this
was written against.
"""

from __future__ import annotations

import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

# --------------------------------------------------------------------------
# CONFIG - adjust if your paths differ.
# --------------------------------------------------------------------------

PROJECT_DIR = Path(__file__).resolve().parent

WAMP_DIR = Path(r"C:\wamp64")
WAMPMANAGER_EXE = WAMP_DIR / "wampmanager.exe"
APACHE_PORT = 80
MYSQL_PORT = 3306

WHISPER_EXE = PROJECT_DIR / "whisper.cpp" / "build" / "bin" / "Release" / "whisper-server.exe"
WHISPER_MODEL = PROJECT_DIR / "whisper.cpp" / "models" / "ggml-medium.bin"
WHISPER_PORT = 8081

OLLAMA_EXE = Path(r"C:\Users\elazh\AppData\Local\Programs\Ollama\ollama app.exe")
OLLAMA_PORT = 11434

WEB_URL = "http://localhost/xxp/mytasks/web/"

STARTUP_TIMEOUT = 60  # seconds to wait for a service to come up
POLL_INTERVAL = 1.0

# --------------------------------------------------------------------------


def port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def wait_for_port(host: str, port: int, timeout_s: float, label: str) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if port_open(host, port):
            print(f"  [ok] {label} is up (port {port})")
            return True
        time.sleep(POLL_INTERVAL)
    print(f"  [!!] {label} did not come up on port {port} within {timeout_s:.0f}s")
    return False


def ensure_wamp() -> bool:
    print("WAMP (Apache + MySQL)")
    if port_open("127.0.0.1", APACHE_PORT) and port_open("127.0.0.1", MYSQL_PORT):
        print(f"  [ok] already running (ports {APACHE_PORT}, {MYSQL_PORT})")
        return True

    if not WAMPMANAGER_EXE.exists():
        print(f"  [!!] wampmanager.exe not found at {WAMPMANAGER_EXE} -- start WAMP manually")
        return False

    print("  starting wampmanager.exe ...")
    subprocess.Popen([str(WAMPMANAGER_EXE)], cwd=str(WAMP_DIR))

    apache_ok = wait_for_port("127.0.0.1", APACHE_PORT, STARTUP_TIMEOUT, "Apache")
    mysql_ok = wait_for_port("127.0.0.1", MYSQL_PORT, STARTUP_TIMEOUT, "MySQL")
    return apache_ok and mysql_ok


def ensure_whisper() -> bool:
    print("whisper.cpp (voice-to-text)")
    if port_open("127.0.0.1", WHISPER_PORT):
        print(f"  [ok] already running (port {WHISPER_PORT})")
        return True

    if not WHISPER_EXE.exists():
        print(f"  [--] whisper-server.exe not found at {WHISPER_EXE} -- skipping (voice input will be unavailable)")
        return False
    if not WHISPER_MODEL.exists():
        print(f"  [--] model not found at {WHISPER_MODEL} -- skipping (voice input will be unavailable)")
        return False

    print("  starting whisper-server.exe ...")
    subprocess.Popen(
        [str(WHISPER_EXE), "-m", str(WHISPER_MODEL), "--port", str(WHISPER_PORT)],
        cwd=str(WHISPER_EXE.parent),
        creationflags=subprocess.CREATE_NEW_CONSOLE,
    )
    return wait_for_port("127.0.0.1", WHISPER_PORT, STARTUP_TIMEOUT, "whisper.cpp")


def ensure_ollama() -> bool:
    print("Ollama (local AI chat fallback)")
    if port_open("127.0.0.1", OLLAMA_PORT):
        print(f"  [ok] already running (port {OLLAMA_PORT})")
        return True

    if not OLLAMA_EXE.exists():
        print(f"  [--] Ollama not found at {OLLAMA_EXE} -- skipping (AI chat fallback will be unavailable)")
        return False

    print("  starting Ollama ...")
    subprocess.Popen([str(OLLAMA_EXE)], cwd=str(OLLAMA_EXE.parent))
    return wait_for_port("127.0.0.1", OLLAMA_PORT, STARTUP_TIMEOUT, "Ollama")


def main() -> int:
    print("=" * 60)
    print("MyTasks launcher")
    print("=" * 60)

    wamp_ok = ensure_wamp()
    print()
    ensure_whisper()
    print()
    ensure_ollama()
    print()

    if not wamp_ok:
        print("WAMP isn't reachable -- can't open the web app. Fix WAMP and re-run.")
        return 1

    print(f"Opening {WEB_URL}")
    webbrowser.open(WEB_URL)

    print()
    print("All set. This window can stay open (whisper.cpp runs in its own")
    print("console window) or be closed -- it isn't needed to keep things running.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
