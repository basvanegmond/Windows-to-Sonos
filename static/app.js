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
  currentAlbumId: null,    // album of the playing track (for art + accent)
  seekDrag: false,
};

const albumOfTrack = new Map(); // trackId -> albumId
const trackById = new Map();    // trackId -> track dict
const ytDurations = new Map();  // yt trackId -> known duration (Sonos reports 0:00 for these)

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
        try { await api("/api/volume", { ip: sp.ip, volume: Number(slider.value) }); }
        catch (e) { toast(e.message, true); }
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
  if (!requireSpeaker()) return;
  try {
    await api("/api/play", { ip: coordinator(), trackIds, startIndex });
    if (shuffle) {
      await api("/api/playmode", { ip: coordinator(), shuffle: true, repeat: state.playback?.repeat ?? false });
    }
    toast(`Playing on ${targetNames()}`);
    pollState(true);
    refreshQueue();
  } catch (e) { toast(e.message, true); }
}

async function addToQueue(trackIds) {
  if (!requireSpeaker()) return;
  try {
    await api("/api/queue/add", { ip: coordinator(), trackIds });
    toast(`Added ${trackIds.length} track${trackIds.length > 1 ? "s" : ""} to queue`);
    refreshQueue();
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
  const ip = coordinator();
  if (!ip) { renderPlayerBar(null); return; }
  const before = state.playback;
  try {
    const st = await api(`/api/state?ip=${encodeURIComponent(ip)}`);
    state.playback = st.error ? null : st;
  } catch { state.playback = null; }
  renderPlayerBar(state.playback);
  highlightPlaying();
  // Re-render the queue whenever the playing track advances, so the
  // position marker follows playback instead of freezing at song 1.
  const trackChanged =
    before?.trackId !== state.playback?.trackId ||
    before?.queuePosition !== state.playback?.queuePosition;
  if (immediate || trackChanged) refreshQueue();
  updateMiniPlayer(state.playback);
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
}

/* ---------- queue drawer ---------- */

async function refreshQueue() {
  if (!state.queueOpen || !coordinator()) return;
  try {
    const res = await api(`/api/queue?ip=${encodeURIComponent(coordinator())}`);
    renderQueue(res.items);
  } catch { /* leave as-is */ }
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
    el.innerHTML = `
      <span class="queue-idx mono">${i + 1}</span>
      <div class="queue-meta">
        <div class="queue-title">${esc(item.title)}</div>
        <div class="queue-artist">${esc(item.artist)}</div>
      </div>
    `;
    el.addEventListener("click", async () => {
      try {
        await api("/api/queue/jump", { ip: coordinator(), index: i });
        pollState(true);
      } catch (e) { toast(e.message, true); }
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
    try {
      await api("/api/playmode", {
        ip: coordinator(),
        shuffle: !(state.playback?.shuffle),
        repeat: state.playback?.repeat ?? false,
      });
      pollState();
    } catch (e) { toast(e.message, true); }
  });
  $("btn-repeat").addEventListener("click", async () => {
    if (!requireSpeaker()) return;
    try {
      await api("/api/playmode", {
        ip: coordinator(),
        shuffle: state.playback?.shuffle ?? false,
        repeat: !(state.playback?.repeat),
      });
      pollState();
    } catch (e) { toast(e.message, true); }
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
    renderContent();
  });

  wireYouTube();
  wireMiniPlayer();

  const drawer = $("queue-drawer");
  $("queue-toggle").addEventListener("click", () => {
    state.queueOpen = !state.queueOpen;
    drawer.classList.toggle("open", state.queueOpen);
    if (state.queueOpen) refreshQueue();
  });
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
      toast("Mini player needs Chrome or Edge (Document Picture-in-Picture)", true);
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
    const res = await api("/api/youtube", { url, ip: coordinator(), addToQueue });
    ytDurations.set(res.item.trackId, res.item.duration);
    setYtStatus("");
    input.value = "";
    toast(addToQueue
      ? `Queued: ${res.item.title}`
      : `Playing: ${res.item.title}`);
    refreshYtList();
    pollState(true);
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
    el.innerHTML = `
      <img class="yt-thumb" src="/art/yt-${esc(item.videoId)}" alt="" onerror="this.style.visibility='hidden'">
      <div class="yt-meta">
        <div class="yt-item-title">${esc(item.title)}</div>
        <div class="yt-item-sub">${esc(item.uploader)} &middot; ${fmtTime(item.duration)}</div>
      </div>
      <div class="yt-actions">
        <button class="icon-btn" title="Play" data-act="play">${PLAY_SVG}</button>
        <button class="icon-btn" title="Add to queue" data-act="queue">${ADD_SVG}</button>
        <button class="icon-btn" title="Remove from cache" data-act="del">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    `;
    el.querySelector('[data-act="play"]').addEventListener("click", () => playTracks([item.trackId]));
    el.querySelector('[data-act="queue"]').addEventListener("click", () => addToQueue([item.trackId]));
    el.querySelector('[data-act="del"]').addEventListener("click", async () => {
      try {
        await api(`/api/youtube/${encodeURIComponent(item.videoId)}`, undefined, "DELETE");
        refreshYtList();
      } catch (e) { toast(e.message, true); }
    });
    list.appendChild(el);
  }
}

/* ---------- boot ---------- */

async function loadLibrary() {
  state.library = await api("/api/library");
  albumOfTrack.clear();
  trackById.clear();
  for (const album of state.library.albums) {
    for (const t of album.tracks) {
      albumOfTrack.set(t.id, album.id);
      trackById.set(t.id, t);
    }
  }
  renderContent();
}

async function loadSpeakers() {
  try {
    const res = await api("/api/speakers");
    state.speakers = res.speakers;
    $("server-info").textContent = `serving ${res.serverIp}`;
    renderSpeakers();
  } catch (e) {
    toast("Could not load speakers: " + e.message, true);
  }
}

async function boot() {
  wireControls();
  await Promise.all([loadLibrary(), loadSpeakers(), loadYtDurations()]);
  // Auto-select the first reachable speaker so play works immediately.
  const first = state.speakers.find((s) => s.reachable);
  if (first && !state.selected.length) {
    state.selected = [first.ip];
    renderSpeakers();
  }
  pollState(true);
  setInterval(pollState, 1000);
  setInterval(loadSpeakers, 15000);
}

boot();
