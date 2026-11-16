"""Sonos control via SoCo: speaker registry, grouping, queueing local tracks
with DIDL metadata (so speakers display title/artist/art), and transport."""

import logging
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import soco
import soco.config
from soco.data_structures import DidlMusicTrack, DidlResource

from library import Track
from transcoder import needs_transcode

# (connect, read) seconds for every UPnP request. SoCo's default is 20 s, and
# it has no per-device setting: the old `dev.timeout = 2` only created an
# unused attribute, so one switched-off speaker stalled /api/speakers, the
# state poll and the page's first load for 20 s per call. A LAN speaker
# answers in well under a second; 2 s to connect is already generous.
soco.config.REQUEST_TIMEOUT = (2.0, 8.0)

# How long to wait for Sonos to report a grouping change before giving up.
_SETTLE_SECONDS = 3.0
_SETTLE_STEP = 0.25


def _probe_duration(path: str) -> float:
    """Read actual duration from a media file via mutagen. Returns 0.0 on failure."""
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(path)
        if audio and audio.info and audio.info.length > 0:
            return float(audio.info.length)
    except Exception:
        pass
    return 0.0


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
        self._server_ip = "127.0.0.1"
        self._server_ip_checked = 0.0
        self._group_lock = threading.Lock()   # one grouping change at a time
        self._topology_via: str | None = None  # last speaker that answered
        self._state_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sonos-state")

    @property
    def server_ip(self) -> str:
        """The LAN address the speakers should pull audio from, re-detected as
        the network changes.

        This used to be read once at startup. The server now starts at logon,
        often before Wi-Fi is up, so it could latch onto 127.0.0.1 and hand
        every speaker a stream URL pointing at itself until someone restarted
        it; a new DHCP lease had the same effect. Detection is a routing-table
        lookup (a UDP connect sends no packet), so asking again is free.
        """
        now = time.monotonic()
        if now - self._server_ip_checked > 5.0:
            self._server_ip_checked = now
            if self.configured:
                self._server_ip = _detect_server_ip(self.configured)
        return self._server_ip

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
        # For YouTube tracks the metadata duration from yt-dlp can be slightly
        # off (rounded seconds) or missing (0). Probe the actual file so Sonos
        # knows the exact length — without this it may stop the track early or
        # not advance to the next queue item.
        duration = track.duration
        if track.id.startswith("yt"):
            probed = _probe_duration(track.path)
            if probed > 0:
                duration = probed + 1.0   # avoid premature stop from sub-second rounding
        res = DidlResource(
            uri=uri,
            protocol_info=f"http-get:*:{mime}:*",
            duration=self._hms(duration) if duration else None,
        )
        # Only pass original_track_number when there is one. Passing None makes
        # SoCo serialise the literal string "None" into the DIDL; Sonos stores
        # it and hands it straight back, and reading the queue then dies on
        # int("None"). YouTube tracks have track_no 0, which is how a single
        # queued video made the entire queue unreadable.
        extra = {"original_track_number": track.track_no} if track.track_no else {}
        return DidlMusicTrack(
            title=track.title,
            parent_id="-1",
            item_id=f"local-{track.id}",
            creator=track.artist,
            album=track.album,
            album_art_uri=self.art_url(album_id),
            resources=[res],
            **extra,
        )


    # ---------- speakers & grouping ----------

    def speaker_states(self) -> list[dict]:
        def _fetch_one(cfg: dict) -> dict:
            try:
                dev = self.device(cfg["ip"])
                vol = dev.volume
                mute = dev.mute
                info = dev.speaker_info
                zone = dev.player_name
                try:
                    group = dev.group
                    coord_ip = group.coordinator.ip_address if group else cfg["ip"]
                except Exception:
                    coord_ip = cfg["ip"]
                return {
                    "name": cfg["name"],
                    "ip": cfg["ip"],
                    "volume": vol,
                    "muted": mute,
                    "model": info.get("model_name", ""),
                    "zone": zone,
                    "reachable": True,
                    "coordinatorIp": coord_ip,
                }
            except Exception as exc:
                self._devices.pop(cfg["ip"], None)  # evict stale SoCo object
                return {
                    "name": cfg["name"],
                    "ip": cfg["ip"],
                    "volume": 0,
                    "muted": False,
                    "model": "",
                    "zone": "",
                    "reachable": False,
                    "coordinatorIp": cfg["ip"],
                    "error": str(exc),
                }

        with ThreadPoolExecutor(max_workers=max(1, len(self.configured))) as ex:
            return list(ex.map(_fetch_one, self.configured))

    def _topology(self, prefer: str | None = None) -> dict[str, str]:
        """Ask Sonos, right now, who leads whom: {player ip: coordinator ip}.

        SoCo caches the zone topology for 5 seconds, and refills that cache
        straight after a join/unjoin, when the speakers have often not caught
        up yet. Grouping decisions made from it were therefore wrong for the
        next few seconds: a quick deselect-then-reselect saw the speaker as
        still grouped and skipped the join (shown selected, silent), and the
        reverse left a deselected speaker playing. Every grouping decision
        here reads the topology fresh instead.
        """
        order = [prefer, self._topology_via] + [c["ip"] for c in self.configured]
        last_exc: Exception | None = None
        for ip in dict.fromkeys(i for i in order if i):
            try:
                dev = self.device(ip)
                dev.zone_group_state.clear_cache()
                topo = {}
                for group in dev.all_groups:
                    if group.coordinator is None:
                        continue
                    for member in group.members:
                        topo[member.ip_address] = group.coordinator.ip_address
                if topo:
                    self._topology_via = ip
                    return topo
            except Exception as exc:
                last_exc = exc
        raise RuntimeError(f"No speaker answered a topology request ({last_exc})")

    def _settle(self, done, prefer: str) -> dict[str, str]:
        """Poll the topology until done(topo) holds or the wait runs out, and
        return the last topology read. Sonos applies a grouping change a moment
        after acknowledging it."""
        deadline = time.monotonic() + _SETTLE_SECONDS
        topo = self._topology(prefer)
        while not done(topo) and time.monotonic() < deadline:
            time.sleep(_SETTLE_STEP)
            topo = self._topology(prefer)
        return topo

    def _group_matches(self, topo: dict[str, str], lead: str, selected: set[str]) -> bool:
        return all((topo.get(c["ip"]) == lead) == (c["ip"] in selected)
                   for c in self.configured)

    @staticmethod
    def _quiet_stop(dev: soco.SoCo) -> None:
        try:
            dev.stop()
        except Exception:
            pass  # nothing playing, or a source (TV, line-in) that cannot stop

    def _take_over(self, leader: str, new_lead: str) -> None:
        """Make new_lead the coordinator of the group currently led by leader,
        which is no longer wanted in it.

        Deselecting the coordinator used to be the worst case: the remaining
        speaker was unjoined (which leaves it with an empty queue, silent) and
        the old coordinator was not touched at all, so it carried on playing.
        One click produced "deselected but still playing" and "selected but
        silent" at once. Handing coordination over keeps the queue and the
        music on the speakers that are still selected, and drops the old
        coordinator out of the group.
        """
        old, new = self.device(leader), self.device(new_lead)
        try:
            old.avTransport.DelegateGroupCoordinationTo([
                ("InstanceID", 0),
                ("NewCoordinator", new.uid),
                ("RejoinGroup", 0),
            ])
            topo = self._settle(lambda t: t.get(new_lead) == new_lead, new_lead)
            if topo.get(new_lead) == new_lead:
                return
            logging.warning("handing coordination from %s to %s did not take effect",
                            leader, new_lead)
        except Exception as exc:
            # e.g. the group is playing TV or line-in audio, which only the
            # speaker with that input can lead.
            logging.warning("could not hand coordination from %s to %s: %s",
                            leader, new_lead, exc)
        # Fallback: split off. The queue stays behind, but the result is at
        # least consistent with the selection.
        new.unjoin()
        if any(c["ip"] == leader for c in self.configured):
            self._quiet_stop(old)
        self._settle(lambda t: t.get(new_lead) == new_lead, new_lead)

    def form_group(self, ips: list[str], release: list[str] | None = None) -> dict:
        """Make Sonos match the selection, then report what Sonos actually did.

        `ips` are the speakers that should play together; `release` are
        speakers that were just deselected and should fall silent. Returns
        {coordinatorIp, members, failed}: members is read back from the
        speakers after the change, so the UI shows the real group rather than
        the one that was asked for.
        """
        selected = list(dict.fromkeys(ips))
        with self._group_lock:   # overlapping requests would interleave joins
            return self._form_group(selected, [ip for ip in (release or [])
                                               if ip not in selected])

    def _form_group(self, selected: list[str], release: list[str]) -> dict:
        errors: dict[str, str] = {}
        if not selected:
            self._release(release, None, errors)
            return {"coordinatorIp": None, "members": [],
                    "failed": self._failures(errors)}

        lead = selected[0]
        wanted = set(selected)
        topo = self._topology(lead)
        leader = topo.get(lead, lead)
        if leader != lead:
            if leader in wanted:
                # Already grouped under another selected speaker: keep that
                # coordinator. Rebuilding the group around `lead` would stop
                # whatever is playing.
                lead = leader
            else:
                self._take_over(leader, lead)

        coordinator = self.device(lead)
        for _ in range(2):   # second pass retries anything Sonos dropped
            topo = self._topology(lead)
            changed = 0
            for cfg in self.configured:
                ip = cfg["ip"]
                if ip == lead:
                    continue
                in_group = topo.get(ip) == lead
                try:
                    if ip in wanted and not in_group:
                        self.device(ip).join(coordinator)
                        changed += 1
                    elif ip not in wanted and in_group:
                        dev = self.device(ip)
                        dev.unjoin()
                        self._quiet_stop(dev)
                        changed += 1
                    else:
                        errors.pop(ip, None)
                except Exception as exc:
                    errors[ip] = str(exc)
            if not changed:
                break
            topo = self._settle(lambda t: self._group_matches(t, lead, wanted), lead)
            if self._group_matches(topo, lead, wanted):
                errors.clear()
                break

        self._release(release, lead, errors)
        topo = self._topology(lead)
        members = [lead] + [c["ip"] for c in self.configured
                            if c["ip"] != lead and topo.get(c["ip"]) == lead]
        for ip in selected:
            if ip not in members:
                errors.setdefault(ip, "did not join the group")
        for ip in members:
            if ip not in wanted:
                errors.setdefault(ip, "is still in the group")
        return {"coordinatorIp": lead, "members": members,
                "failed": self._failures(errors)}

    def _release(self, release: list[str], lead: str | None,
                 errors: dict[str, str]) -> None:
        """Silence speakers that were deselected and are not part of the
        current group. Deselecting the last speaker used to send nothing at
        all, so it went on playing with nothing selected in the UI."""
        if not release:
            return
        try:
            topo = self._topology(lead)
        except Exception as exc:
            for ip in release:
                errors[ip] = str(exc)
            return
        for ip in release:
            try:
                dev = self.device(ip)
                leader = topo.get(ip, ip)
                if lead is not None and leader == lead:
                    continue           # still grouped: reported by the caller
                if leader != ip:
                    dev.unjoin()       # follower of some other group
                self._quiet_stop(dev)
            except Exception as exc:
                errors[ip] = str(exc)

    def _failures(self, errors: dict[str, str]) -> list[dict]:
        names = {c["ip"]: c["name"] for c in self.configured}
        return [{"ip": ip, "name": names.get(ip, ip), "error": err}
                for ip, err in errors.items()]

    def coordinator_of(self, ip: str) -> soco.SoCo:
        dev = self.device(ip)
        try:
            group = dev.group
            if group and group.coordinator is not None:
                return self.device(group.coordinator.ip_address)
        except Exception:
            pass  # topology unavailable: address the speaker itself
        return dev

    # ---------- queue & playback ----------

    def play_tracks(self, ip: str, tracks: list[tuple[Track, str]],
                    start_index: int = 0, play_mode: str = "NORMAL") -> None:
        """Replace the Sonos queue with tracks [(track, album_id)] and play."""
        dev = self.coordinator_of(ip)
        dev.clear_queue()
        for track, album_id in tracks:
            dev.add_to_queue(self._didl(track, album_id))
        dev.play_mode = play_mode   # let exceptions propagate — callers handle 502
        dev.play_from_queue(start_index)

    def add_to_queue(self, ip: str, tracks: list[tuple[Track, str]],
                     play_next: bool = False) -> None:
        dev = self.coordinator_of(ip)
        insert_at = None
        if play_next:
            try:
                info = dev.get_current_track_info()
                insert_at = int(info.get("playlist_position") or 0) + 1
            except Exception:
                pass  # degrade gracefully: append to end
        for i, (track, album_id) in enumerate(tracks):
            kwargs = {"position": insert_at + i} if insert_at is not None else {}
            dev.add_to_queue(self._didl(track, album_id), **kwargs)

    def remove_from_queue(self, ip: str, index: int) -> None:
        """Drop one track. `index` is 0-based, matching the list the UI renders."""
        self.coordinator_of(ip).remove_from_queue(index)

    def move_in_queue(self, ip: str, from_index: int, to_index: int) -> None:
        """Move one track within the queue, both indices 0-based.

        ReorderTracksInQueue is 1-based, and InsertBefore is read against the
        numbering *before* the move: dragging an item downwards therefore needs
        one extra position, because its own slot is still occupied when the
        speaker evaluates the target.
        """
        if from_index == to_index:
            return
        insert_before = to_index + 1 if to_index < from_index else to_index + 2
        self.coordinator_of(ip).avTransport.ReorderTracksInQueue([
            ("InstanceID", 0),
            ("StartingIndex", from_index + 1),
            ("NumberOfTracks", 1),
            ("InsertBefore", insert_before),
            ("UpdateID", 0),
        ])

    def clear_queue(self, ip: str) -> None:
        self.coordinator_of(ip).clear_queue()

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

    def state_with_timeout(self, ip: str, timeout: float = 4.0) -> dict:
        """Run state() on a shared pool so a slow speaker cannot hold a request
        thread past `timeout`. Raises TimeoutError on overrun.

        This used to create an executor in a `with` block, whose exit waits
        for the submitted call to finish: the timeout fired and then the
        request blocked anyway, for as long as the speaker took.
        """
        return self._state_pool.submit(self.state, ip).result(timeout=timeout)

    def play_radio(self, ip: str, url: str, title: str) -> None:
        """Play an internet radio stream URI directly (bypasses the track queue)."""
        dev = self.coordinator_of(ip)
        dev.play_uri(uri=url, title=title, force_radio=True)

    # DIDL-Lite namespaces, for reading the queue without SoCo's strict parser.
    _DIDL_NS = "{urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/}"
    _DC_NS = "{http://purl.org/dc/elements/1.1/}"
    _UPNP_NS = "{urn:schemas-upnp-org:metadata-1-0/upnp/}"

    def _queue_via_browse(self, dev, limit: int = 500) -> list[dict]:
        """Read the queue straight from ContentDirectory and pull out the four
        fields the UI needs.

        SoCo's get_queue() builds a full DIDL object per item and raises on any
        field it cannot coerce, so one malformed value loses the whole queue.
        The drawer only shows a title, an artist and an album, none of which
        need that strictness. Reading the XML directly also means queues that
        already contain items written by the old buggy code stay readable.
        """
        import xml.etree.ElementTree as ET
        result = dev.contentDirectory.Browse([
            ("ObjectID", "Q:0"),
            ("BrowseFlag", "BrowseDirectChildren"),
            ("Filter", "*"),
            ("StartingIndex", 0),
            ("RequestedCount", limit),
            ("SortCriteria", ""),
        ])
        rows = []
        for item in ET.fromstring(result["Result"]).findall(f"{self._DIDL_NS}item"):
            res = item.find(f"{self._DIDL_NS}res")
            rows.append({
                "title": item.findtext(f"{self._DC_NS}title") or "",
                "artist": item.findtext(f"{self._DC_NS}creator") or "",
                "album": item.findtext(f"{self._UPNP_NS}album") or "",
                "uri": (res.text or "") if res is not None else "",
            })
        return rows

    def _queue_via_soco(self, dev, limit: int = 500) -> list[dict]:
        """Fallback reader: SoCo item by item, so one unparseable entry costs
        its own row rather than the whole queue. Positions are preserved, since
        /api/queue/jump indexes into them."""
        import logging as _log
        try:
            total = min(int(dev.queue_size), limit)
        except Exception as exc:
            _log.warning("queue_size unavailable (%s); reading until the queue ends", exc)
            total = limit

        rows: list[dict] = []
        for i in range(total):
            try:
                chunk = list(dev.get_queue(start=i, max_items=1))
            except Exception as exc:
                _log.warning("queue item %d is unparseable, keeping its slot: %s", i, exc)
                rows.append({"title": "Unreadable item", "artist": "", "album": "", "uri": ""})
                continue
            if not chunk:
                break
            item = chunk[0]
            uri = ""
            if item.resources:
                uri = item.resources[0].uri or ""
            rows.append({
                "title": getattr(item, "title", ""),
                "artist": getattr(item, "creator", ""),
                "album": getattr(item, "album", ""),
                "uri": uri,
            })
        return rows

    def queue(self, ip: str) -> list[dict]:
        import logging as _log
        dev = self.coordinator_of(ip)
        try:
            rows = self._queue_via_browse(dev)
        except Exception as exc:
            _log.warning("raw queue browse failed (%s); falling back to SoCo", exc)
            try:
                rows = self._queue_via_soco(dev)
            except Exception as exc2:
                _log.warning("SoCo queue read failed too for %s: %s", ip, exc2)
                return []

        marker = f":{self.server_port}/stream/"
        items = []
        for row in rows:
            uri = row.pop("uri", "")
            track_id = uri.split(marker, 1)[1].split(".")[0] if marker in uri else None
            items.append({**row, "trackId": track_id})
        return items
