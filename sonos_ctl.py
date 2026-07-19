"""Sonos control via SoCo: speaker registry, grouping, queueing local tracks
with DIDL metadata (so speakers display title/artist/art), and transport."""

import socket
from urllib.parse import quote

import soco
from soco.data_structures import DidlMusicTrack, DidlResource

from library import Track
from transcoder import needs_transcode

PLAY_MODES = {
    (False, False): "NORMAL",
    (True, False): "SHUFFLE_NOREPEAT",
    (False, True): "REPEAT_ALL",
    (True, True): "SHUFFLE",  # Sonos "SHUFFLE" = shuffle + repeat all
}


def lan_ip_towards(speaker_ip: str) -> str:
    """The laptop LAN IP the speakers can reach us on."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((speaker_ip, 1400))
        return s.getsockname()[0]
    finally:
        s.close()


def _detect_server_ip(speakers: list[dict]) -> str:
    """Try every configured speaker until one gives us a routable LAN IP.
    A single unreachable speaker (network switch, VPN, speaker offline) must
    never crash the whole server at startup — fall back to 127.0.0.1 instead
    (streaming to Sonos won't work until the network is back, but the web UI
    and local playback still come up)."""
    for cfg in speakers:
        try:
            return lan_ip_towards(cfg["ip"])
        except OSError:
            continue
    return "127.0.0.1"


class SonosController:
    def __init__(self, speakers: list[dict], server_port: int):
        self.configured = speakers  # [{name, ip}]
        self.server_port = server_port
        self._devices: dict[str, soco.SoCo] = {}
        self.server_ip = _detect_server_ip(speakers) if speakers else "127.0.0.1"

    def device(self, ip: str) -> soco.SoCo:
        if ip not in self._devices:
            self._devices[ip] = soco.SoCo(ip)
        return self._devices[ip]

    # ---------- URLs & metadata ----------

    def stream_url(self, track: Track) -> str:
        ext = ".flac" if needs_transcode(track) else track.ext
        return f"http://{self.server_ip}:{self.server_port}/stream/{track.id}{ext}"

    def art_url(self, album_id: str) -> str:
        return f"http://{self.server_ip}:{self.server_port}/art/{album_id}"

    @staticmethod
    def _hms(seconds: float) -> str:
        s = int(round(seconds))
        return f"{s // 3600}:{(s % 3600) // 60:02d}:{s % 60:02d}"

    def _didl(self, track: Track, album_id: str) -> DidlMusicTrack:
        uri = self.stream_url(track)
        mime = "audio/flac" if needs_transcode(track) else track.mime
        res = DidlResource(
            uri=uri,
            protocol_info=f"http-get:*:{mime}:*",
            duration=self._hms(track.duration) if track.duration else None,
        )
        return DidlMusicTrack(
            title=track.title,
            parent_id="-1",
            item_id=f"local-{track.id}",
            creator=track.artist,
            album=track.album,
            album_art_uri=self.art_url(album_id),
            original_track_number=track.track_no or None,
            resources=[res],
        )

    # ---------- speakers & grouping ----------

    def speaker_states(self) -> list[dict]:
        out = []
        for cfg in self.configured:
            entry = {"name": cfg["name"], "ip": cfg["ip"], "reachable": False}
            try:
                dev = self.device(cfg["ip"])
                entry["volume"] = dev.volume
                entry["muted"] = dev.mute
                entry["model"] = dev.speaker_info.get("model_name", "")
                entry["zone"] = dev.player_name
                coordinator = dev.group.coordinator if dev.group else dev
                entry["coordinatorIp"] = coordinator.ip_address
                entry["reachable"] = True
            except Exception as exc:
                entry["error"] = str(exc)
            out.append(entry)
        return out

    def form_group(self, ips: list[str]) -> soco.SoCo:
        """Make the first IP the coordinator; join the rest; unjoin configured
        speakers that are grouped with the coordinator but not selected."""
        if not ips:
            raise ValueError("No speakers selected")
        coordinator = self.device(ips[0])
        if coordinator.group and coordinator.group.coordinator.ip_address != ips[0]:
            coordinator.unjoin()
        selected = set(ips)
        for cfg in self.configured:
            ip = cfg["ip"]
            if ip == ips[0]:
                continue
            try:
                dev = self.device(ip)
                in_group = (dev.group and
                            dev.group.coordinator.ip_address == coordinator.ip_address)
                if ip in selected and not in_group:
                    dev.join(coordinator)
                elif ip not in selected and in_group:
                    dev.unjoin()
            except Exception:
                pass
        return coordinator

    def coordinator_of(self, ip: str) -> soco.SoCo:
        dev = self.device(ip)
        try:
            group = dev.group
            if group:
                return self.device(group.coordinator.ip_address)
        except Exception:
            pass
        return dev

    # ---------- queue & playback ----------

    def play_tracks(self, ip: str, tracks: list[tuple[Track, str]],
                    start_index: int = 0) -> None:
        """Replace the Sonos queue with tracks [(track, album_id)] and play."""
        dev = self.coordinator_of(ip)
        dev.clear_queue()
        for track, album_id in tracks:
            dev.add_to_queue(self._didl(track, album_id))
        dev.play_from_queue(start_index)

    def add_to_queue(self, ip: str, tracks: list[tuple[Track, str]],
                     play_next: bool = False) -> None:
        dev = self.coordinator_of(ip)
        position = 0
        if play_next:
            try:
                info = dev.get_current_track_info()
                position = int(info.get("playlist_position") or 0) + 1
            except Exception:
                position = 0
        for i, (track, album_id) in enumerate(tracks):
            dev.add_to_queue(self._didl(track, album_id),
                             position=position + i if position else 0)

    def transport(self, ip: str, action: str) -> None:
        dev = self.coordinator_of(ip)
        if action == "play":
            dev.play()
        elif action == "pause":
            dev.pause()
        elif action == "stop":
            dev.stop()
        elif action == "next":
            dev.next()
        elif action == "prev":
            dev.previous()

    def play_from_queue(self, ip: str, index: int) -> None:
        self.coordinator_of(ip).play_from_queue(index)

    def seek(self, ip: str, seconds: int) -> None:
        h, rem = divmod(seconds, 3600)
        m, s = divmod(rem, 60)
        self.coordinator_of(ip).seek(f"{h}:{m:02d}:{s:02d}")

    def set_volume(self, ip: str, volume: int) -> None:
        self.device(ip).volume = max(0, min(100, volume))

    def set_mute(self, ip: str, muted: bool) -> None:
        self.device(ip).mute = muted

    def set_play_mode(self, ip: str, shuffle: bool, repeat: bool) -> None:
        self.coordinator_of(ip).play_mode = PLAY_MODES[(shuffle, repeat)]

    # ---------- state ----------

    @staticmethod
    def _hms_to_seconds(hms: str) -> float:
        try:
            parts = [float(p) for p in hms.split(":")]
            while len(parts) < 3:
                parts.insert(0, 0.0)
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
        except (ValueError, AttributeError):
            return 0.0

    def state(self, ip: str) -> dict:
        dev = self.coordinator_of(ip)
        transport = dev.get_current_transport_info()
        info = dev.get_current_track_info()
        mode = dev.play_mode or "NORMAL"
        uri = info.get("uri") or ""
        track_id = None
        marker = f":{self.server_port}/stream/"
        if marker in uri:
            track_id = uri.split(marker, 1)[1].split(".")[0]
        queue_len = 0
        try:
            queue_len = dev.queue_size
        except Exception:
            pass
        return {
            "coordinatorIp": dev.ip_address,
            "transportState": transport.get("current_transport_state", "STOPPED"),
            "trackId": track_id,
            "title": info.get("title") or "",
            "artist": info.get("artist") or "",
            "album": info.get("album") or "",
            "position": self._hms_to_seconds(info.get("position", "0:00:00")),
            "duration": self._hms_to_seconds(info.get("duration", "0:00:00")),
            "queuePosition": int(info.get("playlist_position") or 0),
            "queueLength": queue_len,
            "shuffle": "SHUFFLE" in mode,
            "repeat": mode in ("REPEAT_ALL", "SHUFFLE", "REPEAT_ONE"),
        }

    def play_radio(self, ip: str, url: str, title: str) -> None:
        """Play an internet radio stream URI directly (bypasses the track queue)."""
        dev = self.coordinator_of(ip)
        dev.play_uri(uri=url, title=title, force_radio=True)

    def queue(self, ip: str) -> list[dict]:
        dev = self.coordinator_of(ip)
        items = []
        try:
            for item in dev.get_queue(max_items=500):
                uri = ""
                if item.resources:
                    uri = item.resources[0].uri or ""
                track_id = None
                marker = f":{self.server_port}/stream/"
                if marker in uri:
                    track_id = uri.split(marker, 1)[1].split(".")[0]
                items.append({
                    "title": getattr(item, "title", ""),
                    "artist": getattr(item, "creator", ""),
                    "album": getattr(item, "album", ""),
                    "trackId": track_id,
                })
        except Exception:
            pass
        return items
