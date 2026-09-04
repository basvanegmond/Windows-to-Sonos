"""Windows-to-Sonos: local web player that streams your music folders
directly to Sonos speakers over UPnP/HTTP. Run:  python app.py"""

import json
import logging
import os
import re
import sys
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import radio as radio_mod
import youtube
from library import Library, Track
from sonos_ctl import SonosController
from transcoder import ensure_transcoded, needs_transcode, prewarm

BASE_DIR = Path(__file__).parent
CONFIG_PATH = BASE_DIR / "config.json"

try:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    library = Library(config["music_folders"])
    sonos = SonosController(config["speakers"], config["port"])
    # YouTube tracks live outside the folder library, keyed by track id ("yt<video_id>").
    yt_tracks: dict[str, Track] = {
        item.track_id: item.to_track() for item in youtube.list_items()
    }
except Exception as _startup_exc:
    import logging as _log, traceback as _tb
    (BASE_DIR / "logs").mkdir(exist_ok=True)
    (BASE_DIR / "logs" / "server.log").write_text(
        f"STARTUP FAILED:\n{_tb.format_exc()}", encoding="utf-8"
    )
    raise


def resolve_track(track_id: str) -> Track | None:
    return library.tracks.get(track_id) or yt_tracks.get(track_id)

app = FastAPI(title="Windows to Sonos")
_STARTED_AT = time.monotonic()


# ---------- request models ----------

class PlayRequest(BaseModel):
    ip: str
    trackIds: list[str]
    startIndex: int = 0
    groupIps: list[str] = []  # all selected IPs; used to re-enforce group before play
    playMode: str | None = None


class QueueAddRequest(BaseModel):
    ip: str
    trackIds: list[str]
    playNext: bool = False


class TransportRequest(BaseModel):
    ip: str
    action: str  # play | pause | stop | next | prev


class SeekRequest(BaseModel):
    ip: str
    seconds: int


class VolumeRequest(BaseModel):
    ip: str
    volume: int


class MuteRequest(BaseModel):
    ip: str
    muted: bool


class PlayModeRequest(BaseModel):
    ip: str
    shuffle: bool
    repeat: bool


class GroupRequest(BaseModel):
    ips: list[str]


class YouTubeRequest(BaseModel):
    url: str
    ip: str | None = None       # if set, play immediately on this speaker
    addToQueue: bool = False    # if set (with ip), enqueue instead of replace
    groupIps: list[str] = []   # all selected IPs; used to re-enforce group before play

class YouTubeFetchRequest(BaseModel):
    url: str


class QueueJumpRequest(BaseModel):
    ip: str
    index: int


class QueueRemoveRequest(BaseModel):
    ip: str
    index: int


class QueueMoveRequest(BaseModel):
    ip: str
    fromIndex: int
    toIndex: int


class QueueClearRequest(BaseModel):
    ip: str


class RadioAddRequest(BaseModel):
    name: str
    url: str


class RadioUpdateRequest(BaseModel):
    name: str
    url: str


class RadioPlayRequest(BaseModel):
    ip: str
    groupIps: list[str] = []


def _tracks_with_album(track_ids: list[str]):
    """Resolve track ids to (Track, album_id) pairs. YouTube tracks use the
    art id "yt-<video_id>" so /art can serve their thumbnail."""
    album_of = {}
    for album_id, album in library.albums.items():
        for t in album.tracks:
            album_of[t.id] = album_id
    out = []
    for tid in track_ids:
        track = library.tracks.get(tid)
        if track:
            out.append((track, album_of.get(tid, "")))
        elif tid in yt_tracks:
            out.append((yt_tracks[tid], f"yt-{tid[2:]}"))
    if not out:
        raise HTTPException(404, "No matching tracks")
    return out


def _sonos_call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Exception as exc:
        raise HTTPException(502, f"Sonos error: {exc}") from exc


# ---------- health ----------

@app.get("/api/health")
def health():
    """Cheap liveness probe: touches no Sonos device, so it answers even when
    every speaker is off. The auto-start keep-alive check polls this."""
    return {
        "ok": True,
        "serverIp": sonos.server_ip,
        "port": config["port"],
        "trackCount": len(library.tracks),
        "uptimeSeconds": round(time.monotonic() - _STARTED_AT, 1),
    }


# ---------- library ----------

@app.get("/api/library")
def get_library():
    return library.to_dict()


@app.post("/api/library/rescan")
def rescan_library():
    library.scan()
    return {"ok": True, "trackCount": len(library.tracks)}


@app.get("/art/{album_id}")
def album_art(album_id: str):
    if album_id.startswith("yt-"):
        thumb = youtube.YT_CACHE / f"{album_id[3:]}.jpg"
        if thumb.exists():
            return Response(content=thumb.read_bytes(), media_type="image/jpeg",
                            headers={"Cache-Control": "max-age=86400"})
        return Response(status_code=404)
    art = library.album_art(album_id)
    if not art:
        return Response(status_code=404)
    data, mime = art
    return Response(content=data, media_type=mime,
                    headers={"Cache-Control": "max-age=86400"})


# ---------- audio streaming (Sonos pulls from here; Range required) ----------

CHUNK = 256 * 1024


@app.get("/stream/{track_ref}")
def stream(track_ref: str, request: Request):
    track_id = track_ref.split(".")[0]
    track = resolve_track(track_id)
    if not track or not os.path.exists(track.path):
        raise HTTPException(404, "Track not found")

    # Hi-res tracks (> 24/48) get served from the transcode cache instead —
    # Sonos silently rejects anything above 24-bit/48kHz.
    if needs_transcode(track):
        try:
            source = str(ensure_transcoded(track))
        except Exception as exc:
            raise HTTPException(500, f"Transcode failed: {exc}") from exc
        mime = "audio/flac"
    else:
        source = track.path
        mime = track.mime

    file_size = os.path.getsize(source)
    range_header = request.headers.get("range")

    common = {
        "Accept-Ranges": "bytes",
        "Content-Type": mime,
        "Content-Disposition": "inline",
    }

    if range_header:
        try:
            spec = range_header.replace("bytes=", "").split("-")
            if spec[0] == "":                          # suffix range: bytes=-N
                suffix_len = int(spec[1])
                start = max(0, file_size - suffix_len)
                end   = file_size - 1
            else:
                start = int(spec[0])
                end   = int(spec[1]) if len(spec) > 1 and spec[1] else file_size - 1
        except ValueError:
            raise HTTPException(416, "Invalid range")
        end = min(end, file_size - 1)
        if start > end:
            raise HTTPException(416, "Invalid range")
        length = end - start + 1

        def ranged():
            with open(source, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        headers = {
            **common,
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(length),
        }
        return StreamingResponse(ranged(), status_code=206, headers=headers,
                                 media_type=mime)

    headers = {**common, "Content-Length": str(file_size)}
    return FileResponse(source, headers=headers, media_type=mime)


# ---------- youtube ----------

@app.post("/api/youtube")
def youtube_fetch(req: YouTubeRequest):
    try:
        item = youtube.fetch(req.url)
    except Exception as exc:
        logging.warning("yt-dlp failed for %s: %s", req.url, exc)
        raise HTTPException(502, f"Could not load: {exc}") from exc
    yt_tracks[item.track_id] = item.to_track()
    if req.ip:
        group_ips = req.groupIps or [req.ip]
        if len(group_ips) > 1:
            _sonos_call(sonos.form_group, group_ips)
        pair = [(yt_tracks[item.track_id], f"yt-{item.video_id}")]
        if req.addToQueue:
            _sonos_call(sonos.add_to_queue, req.ip, pair)
        else:
            _sonos_call(sonos.play_tracks, req.ip, pair, 0)
    return {"ok": True, "item": item.to_dict()}


@app.post("/api/youtube/fetch")
def youtube_fetch_only(req: YouTubeFetchRequest):
    """Fetch/cache a YouTube video without playing it (for pre-adding to favourites)."""
    try:
        item = youtube.fetch(req.url)
    except Exception as exc:
        raise HTTPException(502, f"YouTube fetch failed: {exc}") from exc
    yt_tracks[item.track_id] = item.to_track()
    return {"ok": True, "item": item.to_dict()}


@app.get("/api/youtube/favourites")
def youtube_list_favs():
    return {"items": [{**i.to_dict(), "isFavourite": True} for i in youtube.list_favourites()]}


@app.get("/api/youtube")
def youtube_list():
    favs = youtube.favourites_set()
    return {"items": [{**i.to_dict(), "isFavourite": i.video_id in favs} for i in youtube.list_items()]}


@app.post("/api/youtube/{video_id}/favourite")
def youtube_add_fav(video_id: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise HTTPException(400, "Invalid video ID")
    if f"yt{video_id}" not in yt_tracks:
        raise HTTPException(404, "Video not in cache")
    youtube.add_favourite(video_id)
    return {"ok": True}


@app.delete("/api/youtube/{video_id}/favourite")
def youtube_remove_fav(video_id: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise HTTPException(400, "Invalid video ID")
    youtube.remove_favourite(video_id)
    return {"ok": True}


class FavsOrderRequest(BaseModel):
    video_ids: list[str]


@app.put("/api/youtube/favourites/order")
def youtube_reorder_favs(req: FavsOrderRequest):
    if any(not re.fullmatch(r"[A-Za-z0-9_-]{11}", v) for v in req.video_ids):
        raise HTTPException(400, "Invalid video ID in list")
    youtube.reorder_favourites(req.video_ids)
    return {"ok": True}


class TagsRequest(BaseModel):
    tags: list[str]


@app.put("/api/youtube/{video_id}/tags")
def youtube_update_tags(video_id: str, req: TagsRequest):
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise HTTPException(400, "Invalid video ID")
    cleaned = [t.strip() for t in req.tags if t.strip()]
    try:
        youtube.update_tags(video_id, cleaned)
    except FileNotFoundError:
        raise HTTPException(404, "Video not in cache")
    return {"ok": True}


@app.delete("/api/youtube/{video_id}")
def youtube_delete(video_id: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise HTTPException(400, "Invalid video ID")
    yt_tracks.pop(f"yt{video_id}", None)
    if not youtube.delete(video_id):
        raise HTTPException(404, "Not found")
    return {"ok": True}


# ---------- speakers ----------

@app.get("/api/speakers")
def speakers():
    return {"speakers": sonos.speaker_states(), "serverIp": sonos.server_ip}


@app.post("/api/speakers/group")
def group(req: GroupRequest):
    coordinator = _sonos_call(sonos.form_group, req.ips)
    return {"coordinatorIp": coordinator.ip_address}


# ---------- playback ----------

@app.post("/api/play")
def play(req: PlayRequest):
    # Re-enforce speaker grouping before play so members that drifted (e.g.
    # after a speaker restart) automatically rejoin the coordinator.
    group_ips = req.groupIps or [req.ip]
    if len(group_ips) > 1:
        _sonos_call(sonos.form_group, group_ips)
    tracks = _tracks_with_album(req.trackIds)
    # Transcode the first track synchronously so playback starts reliably,
    # then warm the rest of the queue in the background.
    first = tracks[req.startIndex][0] if req.startIndex < len(tracks) else tracks[0][0]
    if needs_transcode(first):
        try:
            ensure_transcoded(first)
        except Exception as exc:
            raise HTTPException(500, f"Transcode failed: {exc}") from exc
    prewarm([t for t, _ in tracks])
    _sonos_call(sonos.play_tracks, req.ip, tracks, req.startIndex, play_mode=req.playMode or "NORMAL")
    return {"ok": True}


@app.post("/api/queue/add")
def queue_add(req: QueueAddRequest):
    tracks = _tracks_with_album(req.trackIds)
    prewarm([t for t, _ in tracks])
    _sonos_call(sonos.add_to_queue, req.ip, tracks, req.playNext)
    return {"ok": True}


@app.post("/api/queue/jump")
def queue_jump(req: QueueJumpRequest):
    _sonos_call(sonos.play_from_queue, req.ip, req.index)
    return {"ok": True}


@app.post("/api/queue/remove")
def queue_remove(req: QueueRemoveRequest):
    _sonos_call(sonos.remove_from_queue, req.ip, req.index)
    return {"ok": True}


@app.post("/api/queue/move")
def queue_move(req: QueueMoveRequest):
    _sonos_call(sonos.move_in_queue, req.ip, req.fromIndex, req.toIndex)
    return {"ok": True}


@app.post("/api/queue/clear")
def queue_clear(req: QueueClearRequest):
    _sonos_call(sonos.clear_queue, req.ip)
    return {"ok": True}


@app.get("/api/queue")
def get_queue(ip: str):
    return {"items": _sonos_call(sonos.queue, ip)}


@app.post("/api/transport")
def transport(req: TransportRequest):
    if req.action not in ("play", "pause", "stop", "next", "prev"):
        raise HTTPException(400, "Unknown action")
    _sonos_call(sonos.transport, req.ip, req.action)
    return {"ok": True}


@app.post("/api/seek")
def seek(req: SeekRequest):
    _sonos_call(sonos.seek, req.ip, req.seconds)
    return {"ok": True}


@app.post("/api/volume")
def volume(req: VolumeRequest):
    _sonos_call(sonos.set_volume, req.ip, req.volume)
    return {"ok": True}


@app.post("/api/mute")
def mute(req: MuteRequest):
    _sonos_call(sonos.set_mute, req.ip, req.muted)
    return {"ok": True}


@app.post("/api/playmode")
def playmode(req: PlayModeRequest):
    _sonos_call(sonos.set_play_mode, req.ip, req.shuffle, req.repeat)
    return {"ok": True}


@app.get("/api/state")
def state(ip: str):
    try:
        return sonos.state_with_timeout(ip, timeout=4.0)
    except TimeoutError:
        return JSONResponse({"error": "speaker timeout"}, status_code=502)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)


# ---------- radio ----------

@app.get("/api/radio")
def radio_list():
    return {"stations": radio_mod.load()}


@app.post("/api/radio")
def radio_add(req: RadioAddRequest):
    if not req.name.strip() or not req.url.strip():
        raise HTTPException(400, "Name and URL are required")
    station = radio_mod.add(req.name.strip(), req.url.strip())
    return {"ok": True, "station": station}


@app.put("/api/radio/{station_id}")
def radio_update(station_id: str, req: RadioUpdateRequest):
    if not req.name.strip() or not req.url.strip():
        raise HTTPException(400, "Name and URL are required")
    station = radio_mod.update(station_id, req.name.strip(), req.url.strip())
    if not station:
        raise HTTPException(404, "Station not found")
    return {"ok": True, "station": station}


@app.delete("/api/radio/{station_id}")
def radio_remove(station_id: str):
    if not radio_mod.remove(station_id):
        raise HTTPException(404, "Station not found")
    return {"ok": True}


@app.post("/api/radio/{station_id}/play")
def radio_play(station_id: str, req: RadioPlayRequest):
    stations = radio_mod.load()
    station = next((s for s in stations if s["id"] == station_id), None)
    if not station:
        raise HTTPException(404, "Station not found")
    group_ips = req.groupIps or [req.ip]
    if len(group_ips) > 1:
        _sonos_call(sonos.form_group, group_ips)
    _sonos_call(sonos.play_radio, req.ip, station["url"], station["name"])
    return {"ok": True}


# ---------- frontend ----------

app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")


def _ensure_streams() -> None:
    """Give the process real stdout/stderr when launched by pythonw.exe.

    pythonw hands the process no console at all: sys.stdout and sys.stderr are
    both None. uvicorn's default log config calls sys.stdout.isatty() while
    building its formatter, so it dies before serving a single request with

        AttributeError: 'NoneType' object has no attribute 'isatty'
        ValueError: Unable to configure formatter 'default'

    which is invisible unless you go looking, because there is no console to
    print it to. Pointing both streams at logs/server.log fixes the crash and
    leaves a log worth reading. Running under python.exe changes nothing.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    log_dir = BASE_DIR / "logs"
    log_dir.mkdir(exist_ok=True)
    stream = (log_dir / "server.log").open("a", encoding="utf-8", buffering=1)
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream


def _port_in_use(port: int) -> bool:
    """True if something already answers on this port locally. Checked before
    the (slow) library scan so a duplicate launch exits immediately instead of
    dying on bind after 20 seconds of scanning."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


if __name__ == "__main__":
    try:
        _ensure_streams()
        if _port_in_use(config["port"]):
            # Another copy is already serving, e.g. the Scheduled Task started
            # one and this is the 5-minute keep-alive (or a manual launch).
            # Exit 0 and quietly: nothing is wrong, and logs/server.log should
            # not fill up with tracebacks every few minutes.
            print(f"Port {config['port']} is already in use - server is already running.")
            raise SystemExit(0)
        print("Scanning music library...")
        library.scan()
        print(f"  {len(library.tracks)} tracks in {len(library.albums)} albums")
        # Advertise 127.0.0.1, not localhost: on Windows "localhost" resolves to
        # IPv6 ::1 first and stalls ~2s per request against this IPv4-only server.
        print(f"Serving on http://{sonos.server_ip}:{config['port']}  "
              f"(open http://127.0.0.1:{config['port']} in your browser)")
        uvicorn.run(app, host="0.0.0.0", port=config["port"], log_level="warning")
    except Exception:
        # No terminal to read this from once the server runs headless via
        # Task Scheduler, so persist the traceback before exiting non-zero
        # (a non-zero exit is what triggers Task Scheduler's restart policy).
        import datetime
        import traceback
        log_dir = BASE_DIR / "logs"
        log_dir.mkdir(exist_ok=True)
        with (log_dir / "server.log").open("a", encoding="utf-8") as f:
            f.write(f"\n[{datetime.datetime.now().isoformat()}] CRASHED:\n")
            f.write(traceback.format_exc())
        raise
