"""Windows-to-Sonos: local web player that streams your music folders
directly to Sonos speakers over UPnP/HTTP. Run:  python app.py"""

import json
import os
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import youtube
from library import Library, Track
from sonos_ctl import SonosController
from transcoder import ensure_transcoded, needs_transcode, prewarm

BASE_DIR = Path(__file__).parent
CONFIG_PATH = BASE_DIR / "config.json"

config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
library = Library(config["music_folders"])
sonos = SonosController(config["speakers"], config["port"])

# YouTube tracks live outside the folder library, keyed by track id ("yt<video_id>").
yt_tracks: dict[str, Track] = {
    item.track_id: item.to_track() for item in youtube.list_items()
}


def resolve_track(track_id: str) -> Track | None:
    return library.tracks.get(track_id) or yt_tracks.get(track_id)

app = FastAPI(title="Windows to Sonos")


# ---------- request models ----------

class PlayRequest(BaseModel):
    ip: str
    trackIds: list[str]
    startIndex: int = 0


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


class QueueJumpRequest(BaseModel):
    ip: str
    index: int


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
    }

    if range_header:
        try:
            spec = range_header.replace("bytes=", "").split("-")
            start = int(spec[0]) if spec[0] else 0
            end = int(spec[1]) if len(spec) > 1 and spec[1] else file_size - 1
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
        raise HTTPException(502, f"YouTube fetch failed: {exc}") from exc
    yt_tracks[item.track_id] = item.to_track()
    if req.ip:
        pair = [(yt_tracks[item.track_id], f"yt-{item.video_id}")]
        if req.addToQueue:
            _sonos_call(sonos.add_to_queue, req.ip, pair)
        else:
            _sonos_call(sonos.play_tracks, req.ip, pair, 0)
    return {"ok": True, "item": item.to_dict()}


@app.get("/api/youtube")
def youtube_list():
    return {"items": [i.to_dict() for i in youtube.list_items()]}


@app.delete("/api/youtube/{video_id}")
def youtube_delete(video_id: str):
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
    _sonos_call(sonos.play_tracks, req.ip, tracks, req.startIndex)
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
        return sonos.state(ip)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)


# ---------- frontend ----------

app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")


if __name__ == "__main__":
    print("Scanning music library...")
    library.scan()
    print(f"  {len(library.tracks)} tracks in {len(library.albums)} albums")
    # Advertise 127.0.0.1, not localhost: on Windows "localhost" resolves to
    # IPv6 ::1 first and stalls ~2s per request against this IPv4-only server.
    print(f"Serving on http://{sonos.server_ip}:{config['port']}  "
          f"(open http://127.0.0.1:{config['port']} in your browser)")
    uvicorn.run(app, host="0.0.0.0", port=config["port"], log_level="warning")
