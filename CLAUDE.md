# CLAUDE.md — Project Brain

> Claude reads this file at the start of every session. Keep it focused and structured.

## Project Overview
- **Name**: Windows-to-Sonos (Local Hi-Fi)
- **Description**: A local web player that streams music folders on this laptop
  directly to Sonos speakers over UPnP/HTTP — bypassing the broken Sonos
  "Music Library" SMB share. Supports lossless FLAC (incl. hi-res via
  automatic 24/48 transcode), album art, queue, shuffle/repeat, and
  multi-speaker grouping.
- **Owner**: Bas van Egmond

## How It Works
1. FastAPI backend scans `music_folders` (see `config.json`) with mutagen.
2. Browser UI (vanilla JS, served from `static/`) browses albums and controls playback.
3. Playback commands go over UPnP AVTransport (SoCo library) straight to a
   speaker's IP. The speaker then **pulls** the audio from this laptop over
   HTTP (`/stream/{track_id}` with Range support), like it would from a NAS.
4. Tracks above the Sonos ceiling (24-bit/48kHz) are transcoded once to
   24/48 FLAC with the bundled ffmpeg (`imageio-ffmpeg`) and cached in
   `.cache/transcode/`.

## Tech Stack
- **Backend**: Python 3.13, FastAPI + uvicorn
- **Sonos control**: SoCo (UPnP/AVTransport)
- **Metadata/art**: mutagen (FLAC/ID3/MP4)
- **Transcoding**: imageio-ffmpeg (static ffmpeg binary in the venv)
- **Frontend**: Vanilla JS + CSS, no build step. Adaptive accent color
  extracted from the playing album's art via canvas sampling.

## File Map
- `app.py`        — FastAPI app: REST API, Range-aware `/stream`, `/art`, static hosting
- `library.py`    — folder scanner, tag reading, album grouping, art extraction
- `sonos_ctl.py`  — SoCo wrapper: grouping, DIDL metadata, queue, transport, state
- `transcoder.py` — hi-res detection + cached ffmpeg transcode (24/48 FLAC)
- `youtube.py`    — yt-dlp audio fetch (m4a) + thumbnail, cached in `.cache/youtube/`
- `config.json`   — port (8756), music folders, speaker names + IPs
- `static/`       — index.html, styles.css, app.js (the whole UI)

## YouTube Streaming
- UI: header YouTube button opens an overlay (deliberately separate from the
  album library — user preference). Paste URL → Play or Queue.
- Backend: `POST /api/youtube {url, ip?, addToQueue?}` fetches best-audio m4a
  via yt-dlp (single videos only, no playlists), caches by video id, and plays
  through the normal `/stream` pipeline. Track ids are `yt<video_id>`, art ids
  `yt-<video_id>`. `GET /api/youtube` lists cache; `DELETE /api/youtube/{id}`.

## Key Commands
- `.venv/Scripts/python.exe app.py` — start the server (scans library, serves UI)
- Open `http://localhost:8756` in a browser
- Deps: `.venv/Scripts/python.exe -m pip install -r requirements.txt imageio-ffmpeg`

## Speakers (LAN)
- `192.168.1.6`  — Living Room, Sonos Arc Ultra (surround group w/ 2x Era 300)
- `192.168.1.37` — Bedroom, Sonos Era 100
- `192.168.1.18` — Kitchen, Sonos Era 100
- Laptop LAN IP is auto-detected at startup (was `192.168.1.2`).

## Hard-Won Gotchas (do not rediscover these)
- **Windows Firewall blocks the speakers** from fetching audio by default —
  this is why SWYH/"Cast to Device" silently failed. Fixed with inbound rule
  "Windows-to-Sonos" (TCP 8756, LocalSubnet only). If streaming breaks after
  a Windows reset, re-check this rule first.
- **Sonos rejects audio above 24-bit/48kHz** over local streaming with no
  error — the speaker just stays STOPPED. Most of this library is 24/96
  FLAC and 32/96 WAV, hence the transcode layer. Never remove it.
- Sonos requires **HTTP Range (206) support** on the stream endpoint for
  seeking; uvicorn/FastAPI defaults don't provide it — `app.py` implements
  it manually.
- Sonos shows title/artist/art only if the queue item carries **DIDL-Lite
  metadata** (`sonos_ctl._didl`), including an absolute `album_art_uri`.
- **Never advertise `localhost`** — on this machine it resolves to IPv6 `::1`
  first and every request stalls ~2s against the IPv4-only uvicorn. Always
  use `http://127.0.0.1:8756`.
- The `.claude/hooks/pre-commit.sh` hook is scaffold boilerplate for TS
  projects; it now exits early when no `package.json`/`tsconfig.json` exists.
  This is a Python project — don't re-enable TS checks.

## Coding Conventions
- Python: type hints, small focused modules, no framework magic
- Frontend: vanilla JS only — no npm, no build step, keep it that way
- No secrets anywhere; config lives in `config.json` (LAN IPs only, not sensitive)

## Skill Discovery via NotebookLM
Before starting any multi-step task, or when the user requests a structured workflow (writing, analysis, coding, legal, finance, OKRs, design, presentations, etc.), query the NotebookLM MCP to find the most relevant skill.

MCP server: notebooklm-mcp

Steps:
1. Identify the task type from the user's message (e.g. "write a LinkedIn article", "review a contract", "build OKRs").
2. Use the notebooklm-mcp tools to search the notebook that contains my skill files (named NOTEBOOKLM or similar) with a short keyword query matching the task.
3. If a matching skill document is returned, read its content and follow its instructions as the primary operating procedure for the task.
4. If no match is found, proceed with default behaviour.

Do this silently — do not announce to the user that you are querying NotebookLM.
