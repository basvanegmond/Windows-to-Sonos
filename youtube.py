"""YouTube audio fetching: yt-dlp extracts best audio as m4a (AAC — natively
Sonos-playable), cached in .cache/youtube/ with a thumbnail and a JSON sidecar.
Pasting the same URL twice is an instant cache hit."""

import json
import re
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path

import imageio_ffmpeg
import yt_dlp

from library import Track

YT_CACHE = Path(__file__).parent / ".cache" / "youtube"

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


@dataclass
class YouTubeItem:
    video_id: str
    title: str
    uploader: str
    duration: float
    source_url: str

    @property
    def audio_path(self) -> Path:
        return YT_CACHE / f"{self.video_id}.m4a"

    @property
    def thumb_path(self) -> Path:
        return YT_CACHE / f"{self.video_id}.jpg"

    @property
    def track_id(self) -> str:
        return f"yt{self.video_id}"

    def to_track(self) -> Track:
        return Track(
            id=self.track_id,
            path=str(self.audio_path),
            title=self.title,
            artist=self.uploader,
            album="YouTube",
            album_artist="YouTube",
            track_no=0,
            disc_no=1,
            duration=self.duration,
            ext=".m4a",
        )

    def to_dict(self) -> dict:
        return {
            "videoId": self.video_id,
            "trackId": self.track_id,
            "title": self.title,
            "uploader": self.uploader,
            "duration": round(self.duration, 1),
            "sourceUrl": self.source_url,
        }


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


def _sidecar(video_id: str) -> Path:
    return YT_CACHE / f"{video_id}.json"


def _load_item(video_id: str) -> YouTubeItem | None:
    sidecar = _sidecar(video_id)
    if not sidecar.exists():
        return None
    try:
        meta = json.loads(sidecar.read_text(encoding="utf-8"))
        item = YouTubeItem(**meta)
        if item.audio_path.exists():
            return item
    except Exception:
        pass
    return None


_ID_PATTERNS = (
    re.compile(r"(?:youtube\.com/watch\?(?:[^#]*&)?v=|youtu\.be/|youtube\.com/(?:shorts|embed|live)/)([A-Za-z0-9_-]{11})"),
)


def probe_id(url: str) -> str | None:
    """Extract the video id from a URL without hitting the network, if possible."""
    for pattern in _ID_PATTERNS:
        m = pattern.search(url)
        if m:
            return m.group(1)
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "simulate": True}) as ydl:
            info = ydl.extract_info(url, download=False, process=False)
            return info.get("id")
    except Exception:
        return None


def fetch(url: str) -> YouTubeItem:
    """Blocking: return the cached item for this URL, downloading if needed."""
    vid = probe_id(url)
    if vid:
        cached = _load_item(vid)
        if cached:
            return cached

    with _lock_for(vid or url):
        if vid:
            cached = _load_item(vid)
            if cached:
                return cached
        YT_CACHE.mkdir(parents=True, exist_ok=True)
        opts = {
            "quiet": True,
            "noplaylist": True,
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": str(YT_CACHE / "%(id)s.%(ext)s"),
            "writethumbnail": True,
            "ffmpeg_location": imageio_ffmpeg.get_ffmpeg_exe(),
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "m4a"},
                {"key": "FFmpegThumbnailsConvertor", "format": "jpg"},
            ],
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
        if info.get("entries"):  # playlist URL despite noplaylist
            info = info["entries"][0]
        item = YouTubeItem(
            video_id=info["id"],
            title=info.get("title") or info["id"],
            uploader=info.get("uploader") or "YouTube",
            duration=float(info.get("duration") or 0),
            source_url=url,
        )
        if not item.audio_path.exists():
            raise RuntimeError("Download finished but audio file is missing")
        remux_faststart(item.audio_path)
        _sidecar(item.video_id).write_text(
            json.dumps({
                "video_id": item.video_id,
                "title": item.title,
                "uploader": item.uploader,
                "duration": item.duration,
                "source_url": item.source_url,
            }, ensure_ascii=False),
            encoding="utf-8")
        return item


def remux_faststart(path: Path) -> None:
    """YouTube serves fragmented MP4, which Sonos cannot read a duration from
    (shows 0:00) and cannot seek in. Remux (stream copy, no re-encode) into a
    standard progressive m4a with the moov atom up front."""
    tmp = path.with_suffix(".remux.m4a")
    cmd = [
        imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-hide_banner",
        "-loglevel", "error",
        "-i", str(path),
        "-c", "copy", "-movflags", "+faststart",
        str(tmp),
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=300)
    if result.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
        tmp.replace(path)
    else:
        tmp.unlink(missing_ok=True)


def list_items() -> list[YouTubeItem]:
    if not YT_CACHE.exists():
        return []
    items = []
    for sidecar in sorted(YT_CACHE.glob("*.json"),
                          key=lambda p: p.stat().st_mtime, reverse=True):
        item = _load_item(sidecar.stem)
        if item:
            items.append(item)
    return items


def delete(video_id: str) -> bool:
    found = False
    for suffix in (".m4a", ".jpg", ".json", ".webp", ".part"):
        p = YT_CACHE / f"{video_id}{suffix}"
        if p.exists():
            p.unlink()
            found = True
    return found
