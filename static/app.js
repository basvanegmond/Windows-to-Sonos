/* Windows to Sonos — client. Vanilla JS, no build step. */

"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  library: { albums: [], trackCount: 0 },
  speakers: [],
  selected: [],            // selected speaker IPs, [0] = coordinator
  view: "albums",          // albums | tracks | album:<id>
  search: "",
  playback: null,          // /api/state payload
  queueOpen: false,
  queueItems: [],          // cached queue — updated after play and on track change
  currentAlbumId: null,    // album of the playing track (for art + accent)
  seekDrag: false,
};

const albumOfTrack = new Map(); // trackId -> albumId
const trackById = new Map();    // trackId -> track dict
const ytDurations = new Map();  // yt trackId -> known duration (Sonos reports 0:00 for these)

let _pollBusy = false;

// Sonos cannot read a duration from some streams (e.g. YouTube audio);
// fall back to the duration yt-dlp gave us.
function effectiveDuration(pb) {
  if (!pb) return 0;
  return pb.duration || ytDurations.get(pb.trackId) || 0;
}

/* ---------- API ---------- */

async function api(path, body, method) {
  const opts = body
    ? { method: method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : (method ? { method } : undefined);
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).detail || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  return res.json();
}

function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2600);
}

const coordinator = () => state.selected[0] || null;

function requireSpeaker() {
  if (!coordinator()) {
    toast("Select a speaker first", true);
    return false;
  }
  return true;
}

/* ---------- accent extraction from album art ---------- */

function applyAccentFrom(imgUrl) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const canvas = $("art-canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 48, 48);
    let data;
    try { data = ctx.getImageData(0, 0, 48, 48).data; } catch { return; }
    let best = null, bestScore = -1;
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const lum = (r + g + b) / 765;
      const score = sat * (1 - Math.abs(lum - 0.55));
      if (score > bestScore) { bestScore = score; best = [r, g, b]; }
    }
    if (!best) return;
    let [r, g, b] = best;
    // Lift toward readability on dark surfaces.
    const boost = (v) => Math.round(Math.min(255, 90 + v * 0.72));
    r = boost(r); g = boost(g); b = boost(b);
    const root = document.documentElement.style;
    root.setProperty("--accent", `rgb(${r}, ${g}, ${b})`);
    root.setProperty("--accent-soft", `rgba(${r}, ${g}, ${b}, 0.14)`);
  };
  img.src = imgUrl;
}

function resetAccent() {
  const root = document.documentElement.style;
  root.removeProperty("--accent");
  root.removeProperty("--accent-soft");
}

/* ---------- rendering: speakers ---------- */

const VOL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>`;

function renderSpeakers() {
  const list = $("speaker-list");
  list.innerHTML = "";
  for (const sp of state.speakers) {
    const el = document.createElement("div");
    el.className = "speaker" +
      (state.selected.includes(sp.ip) ? " selected" : "") +
      (sp.reachable ? "" : " unreachable");
    el.innerHTML = `
      <div class="speaker-row">
        <span class="speaker-dot"></span>
        <span class="speaker-name">${esc(sp.name)}</span>
        <span class="speaker-ip mono">${esc(sp.ip)}</span>
      </div>
      ${sp.reachable ? `
      <div class="vol-row">
        ${VOL_ICON}
        <input type="range" class="vol-slider" min="0" max="100" value="${sp.volume ?? 0}">
        <span class="vol-val mono">${sp.volume ?? 0}</span>
      </div>` : `<div class="vol-row"><span class="vol-val mono" style="width:auto">offline</span></div>`}
    `;
    if (sp.reachable) {
      el.querySelector(".speaker-row").addEventListener("click", () => toggleSpeaker(sp.ip));
      const slider = el.querySelector(".vol-slider");
      slider.addEventListener("input", () => {
        el.querySelector(".vol-val").textContent = slider.value;
      });
      slider.addEventListener("change", async () => {
        try {
          await api("/api/volume", { ip: sp.ip, volume: Number(slider.value) });
          sp.volume = Number(slider.value);
          renderSpeakers();
        } catch (e) { toast(e.message, true); }
      });
      slider.addEventListener("click", (e) => e.stopPropagation());
    }
    list.appendChild(el);
  }
  const target = $("target-label");
  if (state.selected.length) {
    const names = state.speakers
      .filter((s) => state.selected.includes(s.ip))
      .map((s) => s.name);
    target.textContent = names.join(" + ");
    target.classList.add("live");
  } else {
    target.textContent = "no speaker";
    target.classList.remove("live");
  }
}

async function toggleSpeaker(ip) {
  const idx = state.selected.indexOf(ip);
  if (idx >= 0) state.selected.splice(idx, 1);
  else state.selected.push(ip);
  renderSpeakers();
  if (state.selected.length) {
    try {
      const res = await api("/api/speakers/group", { ips: state.selected });
      // Keep coordinator first.
      state.selected = [res.coordinatorIp,
        ...state.selected.filter((i) => i !== res.coordinatorIp)];
    } catch (e) { toast(e.message, true); }
  }
  localStorage.setItem("selectedSpeakers", JSON.stringify(state.selected));
  renderSpeakers();
  pollState(true);
}

/* ---------- rendering: library ---------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const NO_ART = `<div class="no-art"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg></div>`;
const PLAY_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="8 5 19 12 8 19"/></svg>`;
const ADD_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

function matchesSearch(album) {
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return album.title.toLowerCase().includes(q) ||
    album.artist.toLowerCase().includes(q) ||
    album.tracks.some((t) => t.title.toLowerCase().includes(q));
}

function renderContent() {
  const content = $("content");
  if (state.view.startsWith("album:")) {
    renderAlbumDetail(content, state.view.slice(6));
    return;
  }
  if (state.view === "tracks") {
    renderAllTracks(content);
    return;
  }
  if (state.view === "yt-favs") {
    renderYtFavourites(content);
    return;
  }
  if (state.view === "radio") {
    renderRadio(content);
    return;
  }
  renderAlbumGrid(content);
}

function renderAlbumGrid(content) {
  $("view-title").textContent = "Albums";
  const albums = state.library.albums.filter(matchesSearch);
  if (!albums.length) {
    content.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>
      <p>${state.search ? "Nothing matches your search." : "No music found.<br>Check the folders in config.json, then Rescan."}</p>
    </div>`;
    return;
  }
  const grid = document.createElement("div");
  grid.className = "album-grid";
  albums.forEach((album, i) => {
    const card = document.createElement("div");
    card.className = "album-card";
    card.style.setProperty("--i", Math.min(i, 20));
    card.innerHTML = `
      <div class="album-cover">
        ${NO_ART}
        <img loading="lazy" src="/art/${album.id}" alt=""
             onerror="this.remove()" onload="this.previousElementSibling?.classList?.contains('no-art') && this.previousElementSibling.remove()">
        <button class="cover-play" title="Play album">${PLAY_SVG}</button>
      </div>
      <span class="album-title">${esc(album.title)}</span>
      <span class="album-artist">${esc(album.artist)}</span>
    `;
    card.querySelector(".cover-play").addEventListener("click", (e) => {
      e.stopPropagation();
      playAlbum(album);
    });
    card.addEventListener("click", () => {
      state.view = `album:${album.id}`;
      renderContent();
    });
    grid.appendChild(card);
  });
  content.innerHTML = "";
  content.appendChild(grid);
}

function renderAlbumDetail(content, albumId) {
  const album = state.library.albums.find((a) => a.id === albumId);
  if (!album) { state.view = "albums"; renderContent(); return; }
  $("view-title").textContent = "Albums";
  const el = document.createElement("div");
  el.className = "album-detail";
  el.innerHTML = `
    <button class="back-btn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="15 18 9 12 15 6"/></svg>
      Back to albums
    </button>
    <div class="detail-head">
      <div class="detail-cover">${NO_ART}<img src="/art/${album.id}" alt="" onerror="this.remove()" onload="this.previousElementSibling?.classList?.contains('no-art') && this.previousElementSibling.remove()"></div>
      <div class="detail-meta">
        <div class="kicker mono">ALBUM</div>
        <h2>${esc(album.title)}</h2>
        <div class="sub">${esc(album.artist)}</div>
        <div class="stats mono">${album.trackCount} tracks &middot; ${fmtTime(album.duration)}</div>
        <div class="detail-actions">
          <button class="btn btn-primary" id="d-play">${PLAY_SVG} Play</button>
          <button class="btn btn-ghost" id="d-shuffle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/></svg>
            Shuffle
          </button>
          <button class="btn btn-ghost" id="d-queue">${ADD_SVG} Add to queue</button>
        </div>
      </div>
    </div>
    <div class="track-list"></div>
  `;
  el.querySelector(".back-btn").addEventListener("click", () => {
    state.view = "albums";
    renderContent();
  });
  el.querySelector("#d-play").addEventListener("click", () => playAlbum(album));
  el.querySelector("#d-shuffle").addEventListener("click", () => playAlbum(album, { shuffle: true }));
  el.querySelector("#d-queue").addEventListener("click", () => addToQueue(album.tracks.map((t) => t.id)));

  const list = el.querySelector(".track-list");
  album.tracks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "track-row";
    row.dataset.trackId = t.id;
    row.innerHTML = `
      <span class="track-no mono">${t.trackNo || i + 1}</span>
      <div class="track-main">
        <div class="track-name">${esc(t.title)}</div>
        <div class="track-sub">${esc(t.artist)}</div>
      </div>
      <span class="track-fmt mono">${esc(t.format)}${t.quality ? " " + esc(t.quality) : ""}</span>
      <span class="track-len mono">${fmtTime(t.duration)}</span>
    `;
    row.addEventListener("click", () => playAlbum(album, { startIndex: i }));
    list.appendChild(row);
  });
  content.innerHTML = "";
  content.appendChild(el);
  highlightPlaying();
}

function renderAllTracks(content) {
  $("view-title").textContent = "All Tracks";
  const q = state.search.toLowerCase();
  const rows = [];
  for (const album of state.library.albums) {
    for (const t of album.tracks) {
      if (q && !(t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) ||
                 album.title.toLowerCase().includes(q))) continue;
      rows.push({ t, album });
    }
  }
  rows.sort((a, b) => a.t.artist.localeCompare(b.t.artist) || a.t.title.localeCompare(b.t.title));
  if (!rows.length) {
    content.innerHTML = `<div class="empty-state"><p>No matching tracks.</p></div>`;
    return;
  }
  const list = document.createElement("div");
  list.className = "track-list";
  rows.forEach(({ t, album }, i) => {
    const row = document.createElement("div");
    row.className = "track-row";
    row.dataset.trackId = t.id;
    row.innerHTML = `
      <span class="track-no mono">${i + 1}</span>
      <div class="track-main">
        <div class="track-name">${esc(t.title)}</div>
        <div class="track-sub">${esc(t.artist)} &middot; ${esc(album.title)}</div>
      </div>
      <span class="track-fmt mono">${esc(t.format)}</span>
      <span class="track-len mono">${fmtTime(t.duration)}</span>
    `;
    row.addEventListener("click", () => {
      const ids = rows.map((r) => r.t.id);
      playTracks(ids, i);
    });
    list.appendChild(row);
  });
  content.innerHTML = "";
  content.appendChild(list);
  highlightPlaying();
}

function highlightPlaying() {
  const playingId = state.playback?.trackId;
  document.querySelectorAll(".track-row").forEach((row) => {
    row.classList.toggle("playing", !!playingId && row.dataset.trackId === playingId);
  });
}

/* ---------- playback actions ---------- */

async function playAlbum(album, { startIndex = 0, shuffle = false } = {}) {
  const ids = album.tracks.map((t) => t.id);
  await playTracks(ids, startIndex, shuffle);
}

async function playTracks(trackIds, startIndex = 0, shuffle = false) {
  if (!coordinator()) { toast("No speaker selected", true); return; }
  // Preserve the current shuffle mode unless this call explicitly requests one.
  // This means the global shuffle button stays respected when playing a new album.
  const effectiveShuffle = shuffle || (state.playback?.shuffle ?? false);
  try {
    await api("/api/play", {
      ip: coordinator(),
      trackIds,
      startIndex,
      groupIps: state.selected,
      playMode: effectiveShuffle ? "SHUFFLE_NOREPEAT" : "NORMAL",
    });
    pollState(true);
    setTimeout(() => pollState(true), 800);
    setTimeout(() => refreshQueue(true), 400);  // pre-fill cache even if drawer is closed
  } catch (e) { toast(e.message, true); }
}

async function addToQueue(trackIds) {
  if (!requireSpeaker()) return;
  try {
    await api("/api/queue/add", { ip: coordinator(), trackIds });
    toast(`Added ${trackIds.length} track${trackIds.length > 1 ? "s" : ""} to queue`);
    refreshQueue(true);   // force: the drawer is usually closed, and without
                          // this the cached queue stays stale until reopened
  } catch (e) { toast(e.message, true); }
}

function targetNames() {
  return state.speakers
    .filter((s) => state.selected.includes(s.ip))
    .map((s) => s.name)
    .join(" + ") || "speaker";
}

/* ---------- player bar ---------- */

async function pollState(immediate = false) {
  if (_pollBusy && !immediate) return;
  _pollBusy = true;
  try {
    const ip = coordinator();
    if (!ip) { renderPlayerBar(null); return; }
    const before = state.playback;
    try {
      const st = await api(`/api/state?ip=${encodeURIComponent(ip)}`);
      state.playback = st.error ? null : st;
    } catch { state.playback = null; }
    renderPlayerBar(state.playback);
    highlightPlaying();
    updateMiniPlayer(state.playback);
    // Re-render the queue whenever the playing track advances, so the
    // position marker follows playback instead of freezing at song 1.
    const trackChanged =
      before?.trackId !== state.playback?.trackId ||
      before?.queuePosition !== state.playback?.queuePosition;
    if (immediate || trackChanged) refreshQueue();
  } finally {
    _pollBusy = false;
  }
}

function renderPlayerBar(pb) {
  const playing = pb && pb.transportState === "PLAYING";
  $("icon-play").style.display = playing ? "none" : "";
  $("icon-pause").style.display = playing ? "" : "none";

  if (pb && pb.title) {
    document.title = pb.artist ? `${pb.title} — ${pb.artist}` : pb.title;
    $("player-title").textContent = pb.title;
    $("player-artist").textContent = [pb.artist, pb.album].filter(Boolean).join(" — ");
    const track = pb.trackId ? trackById.get(pb.trackId) : null;
    $("player-quality").textContent = track
      ? `${track.format}${track.quality ? " · " + track.quality : ""}`
      : "";
    if (!state.seekDrag) {
      const dur = effectiveDuration(pb);
      $("time-now").textContent = fmtTime(pb.position);
      $("time-total").textContent = fmtTime(dur);
      const pct = dur > 0 ? (pb.position / dur) * 100 : 0;
      $("seek-fill").style.width = `${pct}%`;
    }
    $("btn-shuffle").classList.toggle("on", pb.shuffle);
    $("btn-repeat").classList.toggle("on", pb.repeat);

    // Album art + adaptive accent. YouTube tracks ("yt<id>") map to "yt-<id>" art.
    let albumId = pb.trackId ? albumOfTrack.get(pb.trackId) : null;
    if (!albumId && pb.trackId && pb.trackId.startsWith("yt")) {
      albumId = "yt-" + pb.trackId.slice(2);
    }
    if (albumId && albumId !== state.currentAlbumId) {
      state.currentAlbumId = albumId;
      const url = `/art/${albumId}`;
      $("player-art").innerHTML = `<img src="${url}" alt="" onerror="this.remove()">`;
      applyAccentFrom(url);
    }
  } else {
    document.title = "Local Hi-Fi";
    $("player-title").textContent = "Nothing playing";
    $("player-artist").textContent = coordinator()
      ? "Play something from your library"
      : "Select a speaker, then play something";
    $("player-quality").textContent = "";
    $("seek-fill").style.width = "0%";
    $("time-now").textContent = "0:00";
    $("time-total").textContent = "0:00";
    if (state.currentAlbumId) {
      state.currentAlbumId = null;
      $("player-art").innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>`;
      resetAccent();
    }
  }
  updateFullscreenArt(pb);
}

/* ---------- queue drawer ---------- */

async function refreshQueue(force = false) {
  if (!force && !state.queueOpen) return;
  if (!coordinator()) return;
  try {
    const res = await api(`/api/queue?ip=${encodeURIComponent(coordinator())}`);
    state.queueItems = res.items;
    if (state.queueOpen) renderQueue(state.queueItems);
  } catch { /* leave as-is */ }
}

async function removeFromQueue(index) {
  if (!coordinator()) return;
  const previous = state.queueItems;
  state.queueItems = previous.filter((_, i) => i !== index);
  renderQueue(state.queueItems);          // optimistic: the drawer feels instant
  try {
    await api("/api/queue/remove", { ip: coordinator(), index });
    refreshQueue(true);
  } catch (e) {
    state.queueItems = previous;          // put it back if the speaker refused
    renderQueue(state.queueItems);
    toast(e.message, true);
  }
}

async function moveInQueue(from, to) {
  if (!coordinator()) return;
  const previous = state.queueItems;
  const reordered = [...previous];
  reordered.splice(to, 0, reordered.splice(from, 1)[0]);
  state.queueItems = reordered;
  renderQueue(state.queueItems);
  try {
    await api("/api/queue/move", { ip: coordinator(), fromIndex: from, toIndex: to });
    refreshQueue(true);
  } catch (e) {
    state.queueItems = previous;
    renderQueue(state.queueItems);
    toast(e.message, true);
  }
}

async function clearQueue() {
  if (!coordinator()) return;
  try {
    await api("/api/queue/clear", { ip: coordinator() });
    state.queueItems = [];
    renderQueue(state.queueItems);
    toast("Queue cleared");
    pollState(true);
  } catch (e) { toast(e.message, true); }
}

function renderQueue(items) {
  const list = $("queue-list");
  if (!items.length) {
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><line x1="4" y1="6" x2="14" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="11" y2="18"/><polygon points="17 9 22 12 17 15"/></svg>
      <p>Queue is empty.<br>Play an album or add tracks.</p>
    </div>`;
    return;
  }
  const pos = state.playback?.queuePosition || 0;
  list.innerHTML = "";
  items.forEach((item, i) => {
    const el = document.createElement("div");
    el.className = "queue-item" +
      (i + 1 === pos ? " playing" : "") +
      (pos && i + 1 < pos ? " played" : "");
    el.draggable = true;
    el.dataset.index = String(i);
    el.innerHTML = `
      <span class="queue-grip">${DRAG_SVG}</span>
      <span class="queue-idx mono">${i + 1}</span>
      <div class="queue-meta">
        <div class="queue-title">${esc(item.title)}</div>
        <div class="queue-artist">${esc(item.artist)}</div>
      </div>
      <button class="queue-remove" title="Remove from queue">${TRASH_SVG}</button>
    `;
    el.addEventListener("click", async () => {
      try {
        await api("/api/queue/jump", { ip: coordinator(), index: i });
        pollState(true);
      } catch (e) { toast(e.message, true); }
    });
    el.querySelector(".queue-remove").addEventListener("click", async (e) => {
      e.stopPropagation();          // the row itself jumps to the track
      await removeFromQueue(i);
    });

    // Drag to reorder. Indices are the ones the speaker uses, so the list is
    // reordered locally for immediate feedback and then re-read from the
    // speaker, which stays the source of truth.
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      list.querySelectorAll(".drop-target").forEach((n) => n.classList.remove("drop-target"));
    });
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("drop-target");
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (Number.isNaN(from) || from === i) return;
      await moveInQueue(from, i);
    });

    list.appendChild(el);
  });
  // Keep the current track in view as the album advances.
  const current = list.querySelector(".queue-item.playing");
  if (current) current.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* ---------- wiring ---------- */

function wireControls() {
  $("btn-play").addEventListener("click", async () => {
    if (!requireSpeaker()) return;
    const playing = state.playback?.transportState === "PLAYING";
    try {
      await api("/api/transport", { ip: coordinator(), action: playing ? "pause" : "play" });
      pollState();
    } catch (e) { toast(e.message, true); }
  });
  $("btn-next").addEventListener("click", () => transportAction("next"));
  $("btn-prev").addEventListener("click", () => transportAction("prev"));

  $("btn-shuffle").addEventListener("click", async () => {
    if (!requireSpeaker()) return;
    const newShuffle = !(state.playback?.shuffle);
    $("btn-shuffle").classList.toggle("on", newShuffle);
    try {
      await api("/api/playmode", {
        ip: coordinator(),
        shuffle: newShuffle,
        repeat: state.playback?.repeat ?? false,
      });
      pollState();
    } catch (e) {
      $("btn-shuffle").classList.toggle("on", !newShuffle);
      toast(e.message, true);
    }
  });
  $("btn-repeat").addEventListener("click", async () => {
    if (!requireSpeaker()) return;
    const newRepeat = !(state.playback?.repeat);
    $("btn-repeat").classList.toggle("on", newRepeat);
    try {
      await api("/api/playmode", {
        ip: coordinator(),
        shuffle: state.playback?.shuffle ?? false,
        repeat: newRepeat,
      });
      pollState();
    } catch (e) {
      $("btn-repeat").classList.toggle("on", !newRepeat);
      toast(e.message, true);
    }
  });

  $("seek-bar").addEventListener("click", async (e) => {
    const pb = state.playback;
    const dur = effectiveDuration(pb);
    if (!pb || !dur || !requireSpeaker()) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const target = Math.round(frac * dur);
    $("seek-fill").style.width = `${frac * 100}%`;
    try {
      await api("/api/seek", { ip: coordinator(), seconds: target });
      pollState();
    } catch (err) { toast(err.message, true); }
  });

  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.view = btn.dataset.view;
      renderContent();
    });
  });

  $("rescan-btn").addEventListener("click", async () => {
    toast("Rescanning library…");
    try {
      const res = await api("/api/library/rescan", {});
      await loadLibrary();
      toast(`Library updated: ${res.trackCount} tracks`);
    } catch (e) { toast(e.message, true); }
  });

  $("search").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    if (state.view !== "yt-favs" && state.view !== "radio") renderContent();
  });

  wireYouTube();
  wireMiniPlayer();
  wireFullscreenArt();
  wireVolumeOverlay();

  const drawer = $("queue-drawer");
  $("queue-toggle").addEventListener("click", () => {
    state.queueOpen = !state.queueOpen;
    drawer.classList.toggle("open", state.queueOpen);
    if (state.queueOpen) {
      renderQueue(state.queueItems);   // show cached items immediately
      refreshQueue();                  // then refresh from speaker in background
    }
  });
  $("queue-clear").addEventListener("click", clearQueue);
  $("queue-close").addEventListener("click", () => {
    state.queueOpen = false;
    drawer.classList.remove("open");
  });
}

async function transportAction(action) {
  if (!requireSpeaker()) return;
  try {
    await api("/api/transport", { ip: coordinator(), action });
    setTimeout(() => pollState(true), 400);
  } catch (e) { toast(e.message, true); }
}

/* ---------- mini player (Document Picture-in-Picture) ---------- */

let pipWin = null;

const PIP_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root { --accent: #d9a05b; }
  body {
    font-family: "Outfit", system-ui, sans-serif;
    background: #0c0c0e; color: #ececf1;
    height: 100vh; display: flex; align-items: center;
    gap: 12px; padding: 10px 14px; overflow: hidden;
    user-select: none;
  }
  .m-art {
    width: 58px; height: 58px; border-radius: 9px; object-fit: cover;
    background: #1a1a1f; border: 1px solid #26262c; flex-shrink: 0;
  }
  .m-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .m-title {
    font-size: 13px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .m-artist {
    font-size: 11px; color: #8b8b96;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .m-bar { height: 3px; border-radius: 2px; background: #26262c; }
  .m-fill { height: 100%; width: 0%; border-radius: 2px; background: var(--accent); transition: width 0.5s linear; }
  .m-controls { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .m-controls button {
    background: none; border: none; color: #ececf1; cursor: pointer;
    width: 32px; height: 32px; border-radius: 8px;
    display: grid; place-items: center;
  }
  .m-controls button:hover { background: #1a1a1f; }
  .m-controls button:active { transform: scale(0.92); }
  .m-controls svg { width: 15px; height: 15px; }
  .m-play { background: #ececf1 !important; color: #0c0c0e !important; border-radius: 50% !important; }
  .m-play:hover { background: var(--accent) !important; }
`;

const PIP_HTML = `
  <img class="m-art" id="m-art" alt="">
  <div class="m-main">
    <div class="m-title" id="m-title">Nothing playing</div>
    <div class="m-artist" id="m-artist"></div>
    <div class="m-bar"><div class="m-fill" id="m-fill"></div></div>
  </div>
  <div class="m-controls">
    <button id="m-prev" title="Previous"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4"/><rect x="5" y="4" width="2" height="16"/></svg></button>
    <button id="m-play-btn" class="m-play" title="Play / Pause">
      <svg viewBox="0 0 24 24" fill="currentColor" id="m-icon-play"><polygon points="8 5 19 12 8 19"/></svg>
      <svg viewBox="0 0 24 24" fill="currentColor" id="m-icon-pause" style="display:none"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
    </button>
    <button id="m-next" title="Next"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20"/><rect x="17" y="4" width="2" height="16"/></svg></button>
  </div>
`;

function wireMiniPlayer() {
  $("mini-toggle").addEventListener("click", async () => {
    if (pipWin) { pipWin.close(); return; }
    if (!("documentPictureInPicture" in window)) {
      if (!window.isSecureContext)
        toast("Mini player: open via http://127.0.0.1:8756 — LAN IP is not a secure context", true);
      else
        toast("Mini player needs Chrome 116+ or Edge — update your browser", true);
      return;
    }
    try {
      pipWin = await documentPictureInPicture.requestWindow({ width: 400, height: 92 });
    } catch (e) {
      toast("Could not open mini player: " + e.message, true);
      return;
    }
    const doc = pipWin.document;
    const style = doc.createElement("style");
    style.textContent = PIP_CSS;
    doc.head.appendChild(style);
    doc.title = "Local Hi-Fi";
    doc.body.innerHTML = PIP_HTML;
    doc.getElementById("m-prev").addEventListener("click", () => transportAction("prev"));
    doc.getElementById("m-next").addEventListener("click", () => transportAction("next"));
    doc.getElementById("m-play-btn").addEventListener("click", () => $("btn-play").click());
    pipWin.addEventListener("pagehide", () => { pipWin = null; });
    updateMiniPlayer(state.playback);
  });
}

function updateMiniPlayer(pb) {
  if (!pipWin) return;
  const doc = pipWin.document;
  const get = (id) => doc.getElementById(id);
  if (!get("m-title")) return;
  const playing = pb && pb.transportState === "PLAYING";
  get("m-icon-play").style.display = playing ? "none" : "";
  get("m-icon-pause").style.display = playing ? "" : "none";
  // Follow the main window's adaptive accent.
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent");
  if (accent) doc.documentElement.style.setProperty("--accent", accent.trim());
  if (pb && pb.title) {
    get("m-title").textContent = pb.title;
    get("m-artist").textContent = pb.artist || "";
    const dur = effectiveDuration(pb);
    const pct = dur > 0 ? (pb.position / dur) * 100 : 0;
    get("m-fill").style.width = `${pct}%`;
    let albumId = pb.trackId ? albumOfTrack.get(pb.trackId) : null;
    if (!albumId && pb.trackId && pb.trackId.startsWith("yt")) {
      albumId = "yt-" + pb.trackId.slice(2);
    }
    const art = get("m-art");
    const src = albumId ? `/art/${albumId}` : "";
    if (src && !art.src.endsWith(src)) art.src = src;
  } else {
    get("m-title").textContent = "Nothing playing";
    get("m-artist").textContent = "";
    get("m-fill").style.width = "0%";
  }
}

/* ---------- fullscreen art overlay ---------- */

function wireFullscreenArt() {
  const backdrop = $("afs-backdrop");
  if (!backdrop) return;
  const open = () => {
    const pb = state.playback;
    if (!pb?.title) return;
    updateFullscreenArt(pb);
    backdrop.hidden = false;
  };
  const close = () => { backdrop.hidden = true; };
  $("player-art").style.cursor = "pointer";
  $("player-art").addEventListener("click", open);
  $("afs-close").addEventListener("click", (e) => { e.stopPropagation(); close(); });
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !backdrop.hidden) close(); });
}

function updateFullscreenArt(pb) {
  const backdrop = $("afs-backdrop");
  if (!backdrop || backdrop.hidden) return;
  let albumId = pb?.trackId ? albumOfTrack.get(pb.trackId) : null;
  if (!albumId && pb?.trackId?.startsWith("yt")) albumId = "yt-" + pb.trackId.slice(2);
  backdrop.style.backgroundImage = albumId ? `url(/art/${albumId})` : "none";
  $("afs-title").textContent  = pb?.title  || "";
  $("afs-artist").textContent = pb?.artist || "";
  $("afs-album").textContent  = pb?.album  || "";
}

/* ---------- volume / speaker overlay ---------- */

function wireVolumeOverlay() {
  const backdrop = $("vol-backdrop");
  const open = () => { renderVolumeOverlay(); backdrop.hidden = false; };
  const close = () => { backdrop.hidden = true; };

  $("vol-toggle").addEventListener("click", open);
  $("speakers-expand").addEventListener("click", open);
  $("vol-panel-close").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !backdrop.hidden) close(); });
}

function renderVolumeOverlay() {
  const cardsEl = $("vol-speaker-cards");
  cardsEl.innerHTML = "";

  for (const sp of state.speakers) {
    const isSelected = state.selected.includes(sp.ip);
    const vol = sp.volume ?? 0;
    const safeId = "vv-" + sp.ip.replace(/\./g, "-");

    const card = document.createElement("div");
    card.className = "vol-sp-card" +
      (isSelected ? " selected" : "") +
      (sp.reachable ? "" : " unreachable");

    card.innerHTML = `
      <div class="vol-sp-card-head">
        <div class="vol-sp-check" aria-label="Select speaker">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="2 7 5.5 10.5 12 3"/>
          </svg>
        </div>
        <span class="vol-sp-name">${esc(sp.name)}</span>
        <span class="vol-sp-vol mono" id="${safeId}">${sp.reachable ? vol : "offline"}</span>
      </div>
      ${sp.reachable ? `
      <div class="vol-slider-controls">
        <button class="vol-step-btn" data-dir="-1" title="Volume down">−</button>
        <input type="range" class="vol-big-slider" min="0" max="100" value="${vol}">
        <button class="vol-step-btn" data-dir="1" title="Volume up">+</button>
      </div>` : ""}
    `;

    if (sp.reachable) {
      const valEl = card.querySelector(`#${safeId}`);
      const slider = card.querySelector(".vol-big-slider");

      // clicking the card head (checkbox area / name) toggles speaker selection
      card.querySelector(".vol-sp-card-head").addEventListener("click", async () => {
        await toggleSpeaker(sp.ip);
        renderVolumeOverlay();
      });

      const applyVol = async (v) => {
        v = Math.max(0, Math.min(100, v));
        sp.volume = v;
        slider.value = v;
        valEl.textContent = v;
        try { await api("/api/volume", { ip: sp.ip, volume: v }); }
        catch (e) { toast(e.message, true); }
        renderSpeakers();
      };

      slider.addEventListener("input", () => { valEl.textContent = slider.value; });
      slider.addEventListener("change", () => applyVol(Number(slider.value)));
      card.querySelectorAll(".vol-step-btn").forEach((btn) => {
        btn.addEventListener("click", () => applyVol((sp.volume ?? 0) + Number(btn.dataset.dir)));
      });

      // stop slider / button clicks from bubbling to card-head click
      card.querySelector(".vol-slider-controls").addEventListener("click", (e) => e.stopPropagation());
    }

    cardsEl.appendChild(card);
  }
}

/* ---------- youtube favourites view ---------- */

const HEART_OUTLINE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
const HEART_FILLED = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;

const TAG_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`;
const DRAG_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;

async function renderYtFavourites(content) {
  $("view-title").textContent = "YT Favourites";
  content.innerHTML = "";

  let items = [];
  try {
    items = (await api("/api/youtube/favourites")).items;
  } catch (e) {
    if (state.view !== "yt-favs") return;
    content.innerHTML = `<div class="empty-state"><p>Could not load: ${esc(e.message)}</p></div>`;
    return;
  }
  if (state.view !== "yt-favs") return;

  if (!items.length) {
    content.innerHTML = `<div class="empty-state">
      ${HEART_OUTLINE}
      <p>No favourites yet.<br>Open the YouTube overlay and click ♥ on a video to save it here.</p>
    </div>`;
    return;
  }

  let activeTag = null;

  function buildTagPills(tags, videoId, metaEl) {
    const pillRow = document.createElement("div");
    pillRow.className = "yt-tag-pills";
    (tags || []).forEach(t => {
      const pill = document.createElement("span");
      pill.className = "yt-tag-pill";
      pill.textContent = t;
      pillRow.appendChild(pill);
    });
    return pillRow;
  }

  function renderRows() {
    const filtered = activeTag ? items.filter(it => (it.tags || []).includes(activeTag)) : items;
    list.innerHTML = "";
    filtered.forEach((item, filteredIdx) => {
      const realIdx = items.indexOf(item);
      const el = document.createElement("div");
      el.className = "yt-fav-row";
      el.draggable = false; // only enable from handle mousedown

      const handle = document.createElement("span");
      handle.className = "yt-drag-handle";
      handle.title = "Drag to reorder";
      handle.innerHTML = DRAG_SVG;
      handle.addEventListener("mousedown", () => { el.draggable = true; });
      handle.addEventListener("mouseup", () => { el.draggable = false; });

      const thumb = document.createElement("img");
      thumb.className = "yt-fav-thumb";
      thumb.src = `/art/yt-${esc(item.videoId)}`;
      thumb.alt = "";
      thumb.onerror = () => { thumb.style.visibility = "hidden"; };

      const meta = document.createElement("div");
      meta.className = "yt-fav-meta";
      meta.innerHTML = `
        <div class="yt-fav-title">${esc(item.title)}</div>
        <div class="yt-fav-sub mono">${esc(item.uploader)} &middot; ${fmtTime(item.duration)}</div>
      `;
      meta.appendChild(buildTagPills(item.tags, item.videoId, meta));

      const actions = document.createElement("div");
      actions.className = "yt-fav-actions";

      const playBtn = document.createElement("button");
      playBtn.className = "btn btn-primary btn-sm";
      playBtn.innerHTML = `${PLAY_SVG} Play`;
      playBtn.addEventListener("click", () => playTracks([item.trackId]));

      const queueBtn = document.createElement("button");
      queueBtn.className = "icon-btn";
      queueBtn.title = "Add to queue";
      queueBtn.innerHTML = ADD_SVG;
      queueBtn.addEventListener("click", () => addToQueue([item.trackId]));

      const tagBtn = document.createElement("button");
      tagBtn.className = "icon-btn";
      tagBtn.title = "Edit tags";
      tagBtn.innerHTML = TAG_SVG;
      tagBtn.addEventListener("click", () => {
        const existing = meta.querySelector(".yt-tag-edit-row");
        if (existing) { existing.remove(); return; }
        const editRow = document.createElement("div");
        editRow.className = "yt-tag-edit-row";
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "yt-tag-input";
        inp.placeholder = "e.g. chill, morning";
        inp.value = (item.tags || []).join(", ");
        const confirm = async () => {
          const newTags = inp.value.split(",").map(t => t.trim()).filter(Boolean);
          editRow.remove();
          try {
            await api(`/api/youtube/${encodeURIComponent(item.videoId)}/tags`, { tags: newTags }, "PUT");
            item.tags = newTags;
            // refresh pill row
            const oldPills = meta.querySelector(".yt-tag-pills");
            if (oldPills) oldPills.remove();
            meta.appendChild(buildTagPills(newTags, item.videoId, meta));
            rebuildFilterBar();
          } catch (e) { toast(e.message, true); }
        };
        inp.addEventListener("keydown", e => { if (e.key === "Enter") confirm(); if (e.key === "Escape") editRow.remove(); });
        inp.addEventListener("blur", () => { setTimeout(() => { if (document.contains(inp)) confirm(); }, 150); });
        editRow.appendChild(inp);
        meta.appendChild(editRow);
        inp.focus();
      });

      const unfavBtn = document.createElement("button");
      unfavBtn.className = "icon-btn fav-btn on";
      unfavBtn.title = "Remove from favourites";
      unfavBtn.innerHTML = HEART_FILLED;
      unfavBtn.addEventListener("click", async () => {
        try {
          await api(`/api/youtube/${encodeURIComponent(item.videoId)}/favourite`, undefined, "DELETE");
          toast("Removed from favourites");
          items = items.filter(i => i.videoId !== item.videoId);
          renderRows();
          rebuildFilterBar();
        } catch (e) { toast(e.message, true); }
      });

      actions.append(playBtn, queueBtn, tagBtn, unfavBtn);
      el.append(handle, thumb, meta, actions);

      // drag-and-drop
      el.addEventListener("dragstart", e => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(realIdx));
        el.classList.add("dragging");
      });
      el.addEventListener("dragend", () => {
        el.draggable = false;
        el.classList.remove("dragging");
      });
      el.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
      el.addEventListener("drop", e => {
        e.preventDefault();
        const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
        const toIdx = realIdx;
        if (fromIdx === toIdx) return;
        const moved = items.splice(fromIdx, 1)[0];
        items.splice(toIdx, 0, moved);
        renderRows();
        api("/api/youtube/favourites/order", { video_ids: items.map(i => i.videoId) }, "PUT")
          .catch(err => toast("Reorder failed: " + err.message, true));
      });

      list.appendChild(el);
    });

    if (!list.children.length) {
      list.innerHTML = `<div class="empty-state"><p>No items match the selected tag.</p></div>`;
    }
  }

  function rebuildFilterBar() {
    const allTags = [...new Set(items.flatMap(i => i.tags || []))];
    filterBar.innerHTML = "";
    if (!allTags.length) { filterBar.style.display = "none"; return; }
    filterBar.style.display = "";
    const clearBtn = document.createElement("button");
    clearBtn.className = "yt-tag-filter-btn" + (activeTag === null ? " active" : "");
    clearBtn.textContent = "All";
    clearBtn.addEventListener("click", () => { activeTag = null; rebuildFilterBar(); renderRows(); });
    filterBar.appendChild(clearBtn);
    allTags.forEach(tag => {
      const btn = document.createElement("button");
      btn.className = "yt-tag-filter-btn" + (activeTag === tag ? " active" : "");
      btn.textContent = tag;
      btn.addEventListener("click", () => { activeTag = tag; rebuildFilterBar(); renderRows(); });
      filterBar.appendChild(btn);
    });
  }

  const filterBar = document.createElement("div");
  filterBar.className = "yt-tag-filter-bar";
  const list = document.createElement("div");
  list.className = "yt-fav-list";

  rebuildFilterBar();
  renderRows();

  content.append(filterBar, list);
}

/* ---------- radio view ---------- */

const RADIO_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/></svg>`;
const EDIT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

const _BRAND_GRADIENTS = {
  qmusic:          "linear-gradient(135deg, hsl(2, 94%, 48%), hsl(356, 96%, 36%))",
  sublime:         "linear-gradient(135deg, hsl(161, 36%, 28%), hsl(155, 46%, 18%))",
  radio538:        "linear-gradient(135deg, hsl(276, 95%, 50%), hsl(280, 100%, 38%))",
  skyradio:        "linear-gradient(135deg, hsl(210, 86%, 42%), hsl(214, 92%, 29%))",
  "skyradio-xmas": "linear-gradient(135deg, hsl(4, 88%, 44%), hsl(0, 92%, 33%))",
};

function stationGradient(id, name) {
  if (_BRAND_GRADIENTS[id]) return _BRAND_GRADIENTS[id];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0x7fffffff;
  const hue = h % 360;
  return `linear-gradient(135deg, hsl(${hue}, 52%, 36%), hsl(${(hue + 28) % 360}, 58%, 26%))`;
}

function stationInitials(name) {
  const s = name.replace(/^(radio|the)\s+/i, "").trim();
  const w = (s.match(/[A-Za-z0-9]+/) || [s])[0];
  return w.slice(0, 3).toUpperCase();
}

async function renderRadio(content) {
  $("view-title").textContent = "Radio";
  content.innerHTML = "";

  let editingId = null;

  // Add button
  const addBtn = document.createElement("button");
  addBtn.className = "btn btn-ghost radio-add-btn";
  addBtn.innerHTML = `${ADD_SVG} Add Station`;

  // Inline form (hidden by default)
  const form = document.createElement("div");
  form.className = "radio-form";
  form.hidden = true;
  form.innerHTML = `
    <input type="text" class="radio-input" placeholder="Station name" autocomplete="off">
    <input type="url" class="radio-input radio-url-input" placeholder="Stream URL (.mp3 / .aac / .m3u)" autocomplete="off" spellcheck="false">
    <button class="btn btn-primary btn-sm">Save</button>
    <button class="btn btn-ghost btn-sm">Cancel</button>
  `;

  content.appendChild(addBtn);
  content.appendChild(form);

  const nameInput = form.querySelectorAll("input")[0];
  const urlInput = form.querySelectorAll("input")[1];
  const saveBtn = form.querySelector(".btn-primary");
  const cancelBtn = form.querySelector(".btn-ghost");

  function openForm(station = null) {
    editingId = station ? station.id : null;
    nameInput.value = station ? station.name : "";
    urlInput.value = station ? station.url : "";
    addBtn.hidden = true;
    form.hidden = false;
    nameInput.focus();
  }

  function closeForm() {
    form.hidden = true;
    addBtn.hidden = false;
    editingId = null;
  }

  addBtn.addEventListener("click", () => openForm());
  cancelBtn.addEventListener("click", closeForm);
  [nameInput, urlInput].forEach((inp) => {
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") saveBtn.click(); });
  });

  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const url = urlInput.value.trim();
    if (!name || !url) { toast("Station name and URL are required", true); return; }
    try {
      if (editingId) {
        await api(`/api/radio/${encodeURIComponent(editingId)}`, { name, url }, "PUT");
        toast(`Updated: ${name}`);
      } else {
        await api("/api/radio", { name, url });
        toast(`Added: ${name}`);
      }
      renderRadio($("content"));
    } catch (e) { toast(e.message, true); }
  });

  // Fetch stations
  let stations = [];
  try {
    stations = (await api("/api/radio")).stations;
  } catch (e) {
    if (state.view !== "radio") return;
    const err = document.createElement("div");
    err.className = "empty-state";
    err.innerHTML = `<p>Could not load stations: ${esc(e.message)}</p>`;
    content.appendChild(err);
    return;
  }
  if (state.view !== "radio") return;

  if (!stations.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `${RADIO_SVG}<p>No stations yet.<br>Click "Add Station" above to add an internet radio stream.</p>`;
    content.appendChild(empty);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "radio-grid";

  stations.forEach((station, i) => {
    const card = document.createElement("div");
    card.className = "radio-card";
    card.style.setProperty("--i", Math.min(i, 20));
    const initials = stationInitials(station.name);
    card.innerHTML = `
      <div class="radio-cover" style="background: ${stationGradient(station.id, station.name)}">
        <svg class="radio-cover-waves" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/>
          <circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/>
          <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>
        </svg>
        <span class="radio-initials">${esc(initials)}</span>
        <button class="cover-play" title="Play ${esc(station.name)}">${PLAY_SVG}</button>
        <div class="radio-card-menu">
          <button class="radio-menu-btn" title="Edit">${EDIT_SVG}</button>
          <button class="radio-menu-btn" title="Delete">${TRASH_SVG}</button>
        </div>
      </div>
      <span class="album-title">${esc(station.name)}</span>
    `;
    const playStation = async (e) => {
      e.stopPropagation();
      if (!requireSpeaker()) return;
      try {
        await api(`/api/radio/${encodeURIComponent(station.id)}/play`, { ip: coordinator(), groupIps: state.selected });
        toast(`Playing: ${station.name}`);
        pollState(true);
      } catch (err) { toast(err.message, true); }
    };
    card.querySelector(".cover-play").addEventListener("click", playStation);
    card.addEventListener("click", playStation);
    const [editBtn, delBtn] = card.querySelectorAll(".radio-menu-btn");
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openForm(station);
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await api(`/api/radio/${encodeURIComponent(station.id)}`, undefined, "DELETE");
        renderRadio($("content"));
      } catch (err) { toast(err.message, true); }
    });
    card.querySelector(".radio-card-menu").addEventListener("click", (e) => e.stopPropagation());
    grid.appendChild(card);
  });
  content.appendChild(grid);
}

/* ---------- youtube overlay ---------- */

const SPINNER = `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>`;

function wireYouTube() {
  const backdrop = $("yt-backdrop");
  const open = () => {
    backdrop.hidden = false;
    $("yt-url").focus();
    refreshYtList();
  };
  const close = () => { backdrop.hidden = true; };
  $("yt-toggle").addEventListener("click", open);
  $("yt-close").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !backdrop.hidden) close();
  });

  $("yt-play").addEventListener("click", () => submitYt(false));
  $("yt-queue-add").addEventListener("click", () => submitYt(true));
  $("yt-fav-add").addEventListener("click", () => submitYtFav());
  $("yt-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitYt(false);
  });
}

async function submitYt(addToQueue) {
  const input = $("yt-url");
  const url = input.value.trim();
  if (!url) { setYtStatus("Paste a YouTube URL first", true); return; }
  if (!requireSpeaker()) return;
  const btn = addToQueue ? $("yt-queue-add") : $("yt-play");
  const original = btn.innerHTML;
  btn.innerHTML = `${SPINNER} Fetching`;
  btn.disabled = true;
  setYtStatus("Fetching audio — first time takes a few seconds…");
  try {
    const res = await api("/api/youtube", { url, ip: coordinator(), addToQueue, groupIps: state.selected });
    ytDurations.set(res.item.trackId, res.item.duration);
    setYtStatus("");
    input.value = "";
    toast(addToQueue
      ? `Queued: ${res.item.title}`
      : `Playing: ${res.item.title}`);
    refreshYtList();
    setTimeout(() => pollState(true), 800);
    // YouTube plays and queue-adds go through the same Sonos queue as albums,
    // so the drawer has to be refreshed here too - it was not, which made a
    // queued video look like it had never been added.
    setTimeout(() => refreshQueue(true), 800);
  } catch (e) {
    setYtStatus(e.message, true);
  } finally {
    btn.innerHTML = original;
    btn.disabled = false;
  }
}

async function submitYtFav() {
  const input = $("yt-url");
  const url = input.value.trim();
  if (!url) { setYtStatus("Paste a YouTube URL first", true); return; }
  const btn = $("yt-fav-add");
  const original = btn.innerHTML;
  btn.innerHTML = `${SPINNER} Fetching`;
  btn.disabled = true;
  setYtStatus("Fetching metadata — this may take a few seconds…");
  try {
    // Fetch the video (no speaker needed — omit ip so backend only downloads).
    const res = await api("/api/youtube/fetch", { url });
    ytDurations.set(res.item.trackId, res.item.duration);
    // Mark as favourite.
    await api(`/api/youtube/${encodeURIComponent(res.item.videoId)}/favourite`, null, "POST");
    setYtStatus("");
    input.value = "";
    toast(`Added to favourites: ${res.item.title}`);
    refreshYtList();
  } catch (e) {
    setYtStatus(e.message, true);
  } finally {
    btn.innerHTML = original;
    btn.disabled = false;
  }
}

function setYtStatus(msg, isError = false) {
  const el = $("yt-status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

async function loadYtDurations() {
  try {
    for (const item of (await api("/api/youtube")).items) {
      ytDurations.set(item.trackId, item.duration);
    }
  } catch { /* non-fatal */ }
}

async function refreshYtList() {
  let items = [];
  try { items = (await api("/api/youtube")).items; } catch { return; }
  for (const item of items) ytDurations.set(item.trackId, item.duration);
  const list = $("yt-list");
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><p>Nothing fetched yet.<br>Paste a URL above to stream its audio.</p></div>`;
    return;
  }
  list.innerHTML = "";
  for (const item of items) {
    const el = document.createElement("div");
    el.className = "yt-item";
    const isFav = !!item.isFavourite;
    el.innerHTML = `
      <img class="yt-thumb" src="/art/yt-${esc(item.videoId)}" alt="" onerror="this.style.visibility='hidden'">
      <div class="yt-meta">
        <div class="yt-item-title">${esc(item.title)}</div>
        <div class="yt-item-sub">${esc(item.uploader)} &middot; ${fmtTime(item.duration)}</div>
      </div>
      <div class="yt-actions">
        <button class="icon-btn" title="Play" data-act="play">${PLAY_SVG}</button>
        <button class="icon-btn" title="Add to queue" data-act="queue">${ADD_SVG}</button>
        <button class="icon-btn fav-btn${isFav ? " on" : ""}" title="${isFav ? "Remove from" : "Add to"} favourites" data-act="fav">${isFav ? HEART_FILLED : HEART_OUTLINE}</button>
        <button class="icon-btn" title="Remove from cache" data-act="del">${TRASH_SVG}</button>
      </div>
    `;
    el.querySelector('[data-act="play"]').addEventListener("click", () => playTracks([item.trackId]));
    el.querySelector('[data-act="queue"]').addEventListener("click", () => addToQueue([item.trackId]));
    el.querySelector('[data-act="fav"]').addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const nowFav = btn.classList.contains("on");
      try {
        if (nowFav) {
          await api(`/api/youtube/${encodeURIComponent(item.videoId)}/favourite`, undefined, "DELETE");
          btn.classList.remove("on");
          btn.title = "Add to favourites";
          btn.innerHTML = HEART_OUTLINE;
        } else {
          await api(`/api/youtube/${encodeURIComponent(item.videoId)}/favourite`, null, "POST");
          btn.classList.add("on");
          btn.title = "Remove from favourites";
          btn.innerHTML = HEART_FILLED;
        }
      } catch (e) { toast(e.message, true); }
    });
    el.querySelector('[data-act="del"]').addEventListener("click", async () => {
      try {
        await api(`/api/youtube/${encodeURIComponent(item.videoId)}`, undefined, "DELETE");
        ytDurations.delete(`yt${item.videoId}`);
        refreshYtList();
      } catch (e) { toast(e.message, true); }
    });
    list.appendChild(el);
  }
}

/* ---------- boot ---------- */

async function loadLibrary() {
  try {
    state.library = await api("/api/library");
    albumOfTrack.clear(); trackById.clear();
    for (const album of state.library.albums) {
      for (const t of album.tracks) {
        albumOfTrack.set(t.id, album.id);
        trackById.set(t.id, t);
      }
    }
    renderContent();
  } catch (e) {
    toast("Library unavailable — retrying…", true);
    setTimeout(() => loadLibrary(), 5000);
  }
}

async function loadSpeakers() {
  try {
    const res = await api("/api/speakers");
    state.speakers = res.speakers;
    $("server-info").textContent = `serving ${res.serverIp}`;
    // Restore saved selection on first load (state.selected is empty only at boot time).
    if (!state.selected.length) {
      const saved = JSON.parse(localStorage.getItem("selectedSpeakers") || "[]");
      state.selected = saved.filter(ip => state.speakers.find(s => s.ip === ip && s.reachable));
    }
    // Drop any selected IPs that are now unreachable
    state.selected = state.selected.filter(ip => {
      const sp = state.speakers.find(s => s.ip === ip);
      return sp && sp.reachable;
    });
    renderSpeakers();
    if (!$("vol-backdrop").hidden) renderVolumeOverlay();
  } catch (e) {
    toast("Could not load speakers: " + e.message, true);
  }
}

async function boot() {
  wireControls();
  await Promise.allSettled([loadLibrary(), loadSpeakers(), loadYtDurations()]);
  // Auto-select the first reachable speaker so play works immediately.
  const first = state.speakers.find((s) => s.reachable);
  if (first && !state.selected.length) {
    state.selected = [first.ip];
    renderSpeakers();
  }
  pollState(true);
  let _pollTimer = setInterval(pollState, 1000);
  let _speakerTimer = setInterval(loadSpeakers, 15000);
}

boot();
