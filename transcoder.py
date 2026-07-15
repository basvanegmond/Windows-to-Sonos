"""On-demand transcoding of hi-res tracks to Sonos-compatible 24/48 FLAC.

Sonos accepts FLAC up to 24-bit/48kHz over local HTTP streaming. Anything
above that (24/96 FLAC, 32-bit WAV, ...) is silently rejected — the speaker
just stays STOPPED. Tracks that exceed the limit are downsampled once with
the bundled ffmpeg and cached next to the app in .cache/transcode/.
"""

import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import imageio_ffmpeg

from library import Track

CACHE_DIR = Path(__file__).parent / ".cache" / "transcode"

MAX_SAMPLE_RATE = 48000
MAX_BIT_DEPTH = 24

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=2)


def needs_transcode(track: Track) -> bool:
    if track.sample_rate and track.sample_rate > MAX_SAMPLE_RATE:
        return True
    if track.bit_depth and track.bit_depth > MAX_BIT_DEPTH:
        return True
    return False


def cache_path(track: Track) -> Path:
    return CACHE_DIR / f"{track.id}.flac"


def _lock_for(track_id: str) -> threading.Lock:
    with _locks_guard:
        if track_id not in _locks:
            _locks[track_id] = threading.Lock()
        return _locks[track_id]


def ensure_transcoded(track: Track) -> Path:
    """Blocking: return the cached 24/48 FLAC, transcoding it if needed."""
    out = cache_path(track)
    if out.exists() and out.stat().st_size > 0:
        return out
    with _lock_for(track.id):
        if out.exists() and out.stat().st_size > 0:
            return out
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".part")
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        # 88.2 stays in the 44.1 family; everything else lands on 48 kHz.
        target_rate = 44100 if (track.sample_rate or 0) % 44100 == 0 else 48000
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", track.path,
            "-map", "0:a:0", "-map_metadata", "0",
            "-ar", str(target_rate),
            "-sample_fmt", "s32",
            "-c:a", "flac",
            "-f", "flac", str(tmp),
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=300)
        if result.returncode != 0 or not tmp.exists():
            tmp.unlink(missing_ok=True)
            raise RuntimeError(
                f"ffmpeg failed for {track.path}: "
                f"{result.stderr.decode(errors='replace')[:400]}")
        tmp.replace(out)
        return out


def prewarm(tracks: list[Track]) -> None:
    """Fire-and-forget: transcode upcoming queue items in the background."""
    for track in tracks:
        if needs_transcode(track) and not cache_path(track).exists():
            _pool.submit(_safe_transcode, track)


def _safe_transcode(track: Track) -> None:
    try:
        ensure_transcoded(track)
    except Exception:
        pass
