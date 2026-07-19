"""Internet radio station registry. Stored in radio.json next to config.json."""

import json
import uuid
from pathlib import Path

RADIO_PATH = Path(__file__).parent / "radio.json"

_DEFAULTS = [
    {"id": "qmusic", "name": "Qmusic", "url": "https://playerservices.streamtheworld.com/api/livestream-redirect/QMUSIC.mp3"},
    {"id": "sublime", "name": "Sublime", "url": "https://stream.sublime.nl/sublime-6"},
    {"id": "radio538", "name": "Radio 538", "url": "https://playerservices.streamtheworld.com/api/livestream-redirect/RADIO538.mp3"},
    {"id": "skyradio", "name": "Skyradio", "url": "https://playerservices.streamtheworld.com/api/livestream-redirect/SKYRADIO.mp3"},
    {"id": "skyradio-xmas", "name": "Skyradio Christmas", "url": "https://playerservices.streamtheworld.com/api/livestream-redirect/SKYCHRISTMAS.mp3"},
]


def _save(stations: list[dict]) -> None:
    RADIO_PATH.write_text(json.dumps(stations, ensure_ascii=False, indent=2), encoding="utf-8")


def load() -> list[dict]:
    if not RADIO_PATH.exists():
        _save(list(_DEFAULTS))
        return list(_DEFAULTS)
    try:
        return json.loads(RADIO_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []


def add(name: str, url: str) -> dict:
    stations = load()
    station = {"id": uuid.uuid4().hex[:8], "name": name, "url": url}
    stations.append(station)
    _save(stations)
    return station


def update(station_id: str, name: str, url: str) -> dict | None:
    stations = load()
    for s in stations:
        if s["id"] == station_id:
            s["name"] = name
            s["url"] = url
            _save(stations)
            return s
    return None


def remove(station_id: str) -> bool:
    stations = load()
    new = [s for s in stations if s["id"] != station_id]
    if len(new) == len(stations):
        return False
    _save(new)
    return True
