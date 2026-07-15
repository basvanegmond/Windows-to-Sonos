"""Music library scanner: walks configured folders, reads tags via mutagen,
groups tracks into albums, and exposes embedded/folder album art."""

import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path

from mutagen import File as MutagenFile
from mutagen.flac import FLAC
from mutagen.id3 import ID3
from mutagen.mp4 import MP4

AUDIO_EXTS = {".flac", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".wav"}

MIME_BY_EXT = {
    ".flac": "audio/flac",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".wav": "audio/wav",
}

COVER_NAMES = ("cover.jpg", "cover.png", "folder.jpg", "folder.png",
               "front.jpg", "album.jpg", "albumart.jpg")


def _track_id(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8", "surrogatepass")).hexdigest()[:16]


@dataclass
class Track:
    id: str
    path: str
    title: str
    artist: str
    album: str
    album_artist: str
    track_no: int
    disc_no: int
    duration: float
    ext: str
    bit_depth: int | None = None
    sample_rate: int | None = None

    @property
    def mime(self) -> str:
        return MIME_BY_EXT.get(self.ext, "application/octet-stream")

    def to_dict(self) -> dict:
        quality = None
        if self.sample_rate:
            if self.bit_depth:
                quality = f"{self.bit_depth}/{self.sample_rate / 1000:g}"
            else:
                quality = f"{self.sample_rate / 1000:g} kHz"
        return {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "albumArtist": self.album_artist,
            "trackNo": self.track_no,
            "discNo": self.disc_no,
            "duration": round(self.duration, 1),
            "format": self.ext.lstrip(".").upper(),
            "quality": quality,
        }


@dataclass
class Album:
    id: str
    title: str
    artist: str
    tracks: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "trackCount": len(self.tracks),
            "duration": round(sum(t.duration for t in self.tracks), 1),
            "tracks": [t.to_dict() for t in sorted(
                self.tracks, key=lambda t: (t.disc_no, t.track_no, t.title))],
        }


def _first(tags, *keys, default=""):
    for k in keys:
        v = tags.get(k)
        if v:
            return str(v[0]) if isinstance(v, list) else str(v)
    return default


def _int_of(value, default=0):
    try:
        s = str(value).split("/")[0]
        return int(s) if s else default
    except (ValueError, TypeError):
        return default


def _read_track(path: Path) -> Track | None:
    audio = MutagenFile(str(path), easy=True)
    if audio is None:
        return None
    tags = audio.tags or {}
    info = audio.info
    title = _first(tags, "title") or path.stem
    artist = _first(tags, "artist", default="Unknown Artist")
    album = _first(tags, "album") or path.parent.name
    album_artist = _first(tags, "albumartist") or artist
    return Track(
        id=_track_id(str(path)),
        path=str(path),
        title=title,
        artist=artist,
        album=album,
        album_artist=album_artist,
        track_no=_int_of(_first(tags, "tracknumber")),
        disc_no=_int_of(_first(tags, "discnumber"), default=1),
        duration=getattr(info, "length", 0.0) or 0.0,
        ext=path.suffix.lower(),
        bit_depth=getattr(info, "bits_per_sample", None),
        sample_rate=getattr(info, "sample_rate", None),
    )


def extract_art(track_path: str) -> tuple[bytes, str] | None:
    """Return (image_bytes, mime) from embedded tags or a cover file in the folder."""
    path = Path(track_path)
    ext = path.suffix.lower()
    try:
        if ext == ".flac":
            flac = FLAC(str(path))
            if flac.pictures:
                pic = flac.pictures[0]
                return pic.data, pic.mime or "image/jpeg"
        elif ext == ".mp3":
            id3 = ID3(str(path))
            apics = id3.getall("APIC")
            if apics:
                return apics[0].data, apics[0].mime or "image/jpeg"
        elif ext in (".m4a", ".aac"):
            mp4 = MP4(str(path))
            covers = mp4.tags.get("covr") if mp4.tags else None
            if covers:
                data = bytes(covers[0])
                mime = "image/png" if data[:8].startswith(b"\x89PNG") else "image/jpeg"
                return data, mime
    except Exception:
        pass
    for name in COVER_NAMES:
        cover = path.parent / name
        if cover.exists():
            mime = "image/png" if cover.suffix.lower() == ".png" else "image/jpeg"
            return cover.read_bytes(), mime
    return None


class Library:
    def __init__(self, folders: list[str]):
        self.folders = folders
        self.tracks: dict[str, Track] = {}
        self.albums: dict[str, Album] = {}

    def scan(self) -> None:
        tracks: dict[str, Track] = {}
        for folder in self.folders:
            root = Path(folder)
            if not root.exists():
                continue
            for dirpath, _dirnames, filenames in os.walk(root):
                for fn in filenames:
                    p = Path(dirpath) / fn
                    if p.suffix.lower() not in AUDIO_EXTS:
                        continue
                    try:
                        t = _read_track(p)
                    except Exception:
                        t = None
                    if t:
                        tracks[t.id] = t

        albums: dict[str, Album] = {}
        for t in tracks.values():
            key = hashlib.sha1(f"{t.album_artist}\x00{t.album}".lower()
                               .encode("utf-8", "surrogatepass")).hexdigest()[:16]
            if key not in albums:
                albums[key] = Album(id=key, title=t.album, artist=t.album_artist)
            albums[key].tracks.append(t)

        self.tracks = tracks
        self.albums = albums

    def album_art(self, album_id: str) -> tuple[bytes, str] | None:
        album = self.albums.get(album_id)
        if not album or not album.tracks:
            return None
        return extract_art(album.tracks[0].path)

    def to_dict(self) -> dict:
        albums = sorted(self.albums.values(), key=lambda a: (a.artist.lower(), a.title.lower()))
        return {
            "albums": [a.to_dict() for a in albums],
            "trackCount": len(self.tracks),
        }
