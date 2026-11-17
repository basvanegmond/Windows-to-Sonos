---
paths:
  - "*.py"
---

# Python and API rules

## Conventions
- Type hints on function signatures, small focused modules, no framework magic.
- No secrets in the repository. Local settings live in `config.json`, which is git-ignored; the tracked template is `config.example.json`.

## REST layer (`app.py`)
- Handlers are plain `def` functions, so FastAPI runs them in its worker thread pool and they may block on a speaker call.
- Request bodies are pydantic models declared at the top of `app.py`.
- Wrap every speaker call in `_sonos_call`: it logs the failure and answers HTTP 502 with `Sonos error: ...`.
- Indexes in the API are 0-based.
- Before any play call, make the speakers match the UI's selection with `_apply_selection`.
- Address files by id (`resolve_track`, `_tracks_with_album`). Never accept a file path from a client.
- Check a YouTube video id against `[A-Za-z0-9_-]{11}` before it touches the cache.

## Sonos (`sonos_ctl.py`)
- Decide grouping from `_topology()`, never from `dev.group`. SoCo caches the topology for 5 s and refills it before the speakers have caught up.
- Send queue items with DIDL-Lite metadata and an absolute art URL. Never pass `original_track_number=None`: SoCo writes the string "None" and the queue can no longer be read.
- SoCo has no per-device timeout. Use `soco.config.REQUEST_TIMEOUT`, set at the top of the file.
- Files above 24-bit or 48 kHz must go through `transcoder.py`. Sonos refuses them silently.
- Never put `localhost` in an address a speaker or the page will use. Use `127.0.0.1` or the detected server address.
- `pythonw.exe` has no stdout. Keep `_ensure_streams()` at the start of `__main__`.
