window.Sonify = (function () {
  "use strict";

  /* ============================ State ============================ */
  const state = {
    songs: [],
    curId: null,      // id of the currently selected song (not an index)
    playing: false,
    mode: null,        // 'buffer' (synth) | 'file' (imported)
    volume: 0.8,
    repeat: "off",     // off | all | one
    shuffle: false,
    pausedAt: 0,
    startTime: 0,
    _wasPlaying: false,
    activeEl: null,   // current HTMLMediaElement (audio or video) when playing local media
    playlist: null,   // LinkedList of nodes (source of truth for order/traversal)
    queue: [],        // ordered list of song ids for "Up Next"
    queueIdx: -1,     // index in queue of the currently playing item, -1 if not from queue
  };

  /* ===================== Linked-list playlist ===================== */
  // Each song is a node linked to the next; the tail wraps back to the head
  // so traversal loops the whole playlist until stopped/paused.
  function PlaylistNode(song) { this.song = song; this.id = song.id; this.next = null; }
  class Playlist {
    constructor(songs) { this.head = null; this.tail = null; this.size = 0; this.map = new Map(); this.build(songs); }
    build(songs) {
      this.head = this.tail = null; this.size = 0; this.map.clear();
      (songs || []).forEach((s) => this.append(s));
    }
    append(song) {
      const n = new PlaylistNode(song);
      this.map.set(n.id, n);
      if (!this.head) this.head = this.tail = n;
      else { this.tail.next = n; this.tail = n; }
      this.size++;
      return n;
    }
    nodeById(id) { return this.map.get(id); }
    next(id, wrap = true) { const n = this.map.get(id); return (n && n.next) ? n.next : (wrap ? this.head : null); }
    prev(id, wrap = true) {
      if (!this.head) return null;
      let cur = this.head, prev = null;
      while (cur) { if (cur.id === id) break; prev = cur; cur = cur.next; }
      if (prev) return prev;
      return wrap ? this.tail : null;
    }
  }
  function rebuildPlaylist() { state.playlist = new Playlist(state.songs); }

  /* ============================ Audio ============================ */
  let audioCtx = null;
  let masterGain = null;
  let analyser = null;
  let eqData = null;
  let mediaSource = null;
  let bufferSource = null;
  const bufferCache = {};            // id -> AudioBuffer
  const audioEl = new Audio();
  audioEl.preload = "metadata";
  let videoEl = null;   // lazily-created <video> for local video media
  let ytPlayer = null;  // active YouTube IFrame Player instance (when playing a YOUTUBE item)
  let ytApiPromise = null;
  let ytReqId = 0;      // monotonically increasing id; invalidates stale/in-flight player creations
  let eqBassFilter = null;
  let eqMidFilter = null;
  let eqTrebleFilter = null;
  let eqInput = null;

  let rafId = null;
  let playToken = 0;
  let lastPosSave = 0;

  // now-playing DOM refs (player page)
  let nodesEl, npTitle, npMeta, npBadge, fill, tCur, tDur, progress,
      playBtn, eqCanvas, eqCtx;

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function loadPersist() {
    try {
      const p = JSON.parse(localStorage.getItem("nodeplayer") || "{}");
      if (typeof p.volume === "number") state.volume = p.volume;
      if (p.repeat) state.repeat = p.repeat;
      if (typeof p.shuffle === "boolean") state.shuffle = p.shuffle;
      if (typeof p.curId === "number") state.curId = p.curId;
      else if (typeof p.cur === "number" && state.songs[p.cur]) state.curId = state.songs[p.cur].id;
      state.pausedAt = (typeof p.pausedAt === "number") ? p.pausedAt : 0;
      state._wasPlaying = !!p.playing;
    } catch (e) { /* ignore */ }
  }
  function savePersist() {
    try {
      localStorage.setItem("nodeplayer", JSON.stringify({
        volume: state.volume, repeat: state.repeat,
        shuffle: state.shuffle, curId: state.curId,
        playing: state.playing, pausedAt: state.pausedAt,
      }));
    } catch (e) { /* ignore */ }
  }

  let lastRecorded = { songId: null, token: null };
  async function recordPlayback(songId, token) {
    if (lastRecorded.songId === songId && lastRecorded.token === token) return;
    lastRecorded = { songId, token };
    try {
      await fetch("/api/songs/" + songId + "/play", { method: "POST" });
      const song = state.songs.find((s) => s.id === songId);
      if (song) {
        song.play_count = (song.play_count || 0) + 1;
        song.last_played = new Date().toISOString();
      }
    } catch (e) { /* ignore */ }
  }

  function loadQueue() {
    try {
      const q = JSON.parse(localStorage.getItem("lumifyQueue") || "{}");
      if (Array.isArray(q.ids)) state.queue = q.ids.filter((id) => state.songs.some((s) => s.id === id));
      else state.queue = [];
      state.queueIdx = (typeof q.idx === "number") ? q.idx : -1;
      if (state.queueIdx >= state.queue.length) state.queueIdx = state.queue.length - 1;
      if (state.queueIdx < -1) state.queueIdx = -1;
    } catch (e) {
      state.queue = [];
      state.queueIdx = -1;
    }
  }
  function saveQueue() {
    try {
      localStorage.setItem("lumifyQueue", JSON.stringify({ ids: state.queue, idx: state.queueIdx }));
    } catch (e) { /* ignore */ }
  }
  function enqueue(songId) {
    if (!state.songs.some((s) => s.id === songId)) return;
    state.queue.push(songId);
    saveQueue();
    renderQueue();
  }
  function enqueueNext(songId) {
    if (!state.songs.some((s) => s.id === songId)) return;
    if (state.queueIdx >= 0 && state.queueIdx < state.queue.length - 1) {
      state.queue.splice(state.queueIdx + 1, 0, songId);
    } else if (state.queueIdx >= 0 && state.queueIdx === state.queue.length - 1) {
      state.queue.push(songId);
    } else {
      state.queue.unshift(songId);
      state.queueIdx = 0;
    }
    saveQueue();
    renderQueue();
  }
  function playNowQueue(songId) {
    if (!state.songs.some((s) => s.id === songId)) return;
    state.queue = [songId];
    state.queueIdx = 0;
    saveQueue();
    goToId(songId);
    renderQueue();
  }
  async function toggleFavorite(songId, btn) {
    if (!state.songs.some((s) => s.id === songId)) return;
    try {
      const res = await fetch("/api/songs/" + songId + "/favorite", { method: "POST" });
      if (!res.ok) return;
      const d = await res.json();
      const song = state.songs.find((s) => s.id === songId);
      if (song) song.is_favorite = d.is_favorite;
      if (btn) {
        btn.textContent = d.is_favorite ? "♥" : "♡";
        btn.classList.toggle("active", d.is_favorite);
      }
    } catch (e) { /* ignore */ }
  }

  function openEditModal(songId) {
    const song = state.songs.find((s) => s.id === songId);
    if (!song) return;
    document.getElementById("editSongId").textContent = songId;
    document.getElementById("editTitle").value = song.name || "";
    document.getElementById("editArtist").value = song.artist || "";
    document.getElementById("editAlbum").value = song.album || "";
    document.getElementById("editAlbumArtist").value = song.album_artist || "";
    document.getElementById("editGenre").value = song.genre || "";
    document.getElementById("editYear").value = song.year || "";
    document.getElementById("editTrackNumber").value = song.track_number || "";
    const preview = document.getElementById("editArtworkPreview");
    if (song.artwork_url) {
      preview.src = song.artwork_url;
      preview.style.display = "";
    } else {
      preview.style.display = "none";
    }
    document.getElementById("editModal").classList.add("show");
  }

  function closeEditModal() {
    document.getElementById("editModal").classList.remove("show");
  }

  async function saveEditModal() {
    const songId = parseInt(document.getElementById("editSongId").textContent, 10);
    const data = {
      name: document.getElementById("editTitle").value.trim(),
      artist: document.getElementById("editArtist").value.trim() || null,
      album: document.getElementById("editAlbum").value.trim() || null,
      album_artist: document.getElementById("editAlbumArtist").value.trim() || null,
      genre: document.getElementById("editGenre").value.trim() || null,
      year: document.getElementById("editYear").value ? parseInt(document.getElementById("editYear").value, 10) : null,
      track_number: document.getElementById("editTrackNumber").value ? parseInt(document.getElementById("editTrackNumber").value, 10) : null,
    };
    const artworkFile = document.getElementById("editArtwork").files[0];
    if (artworkFile) {
      const fd = new FormData();
      fd.append("artwork", artworkFile);
      const r = await fetch("/api/songs/" + songId + "/artwork", { method: "POST", body: fd });
      if (r.ok) {
        const d = await r.json();
        const song = state.songs.find((s) => s.id === songId);
        if (song) {
          song.artwork_path = d.artwork_path;
          song.artwork_url = "/static/media/artworks/" + d.artwork_path;
        }
      }
    }
    await fetch("/api/songs/" + songId + "/metadata", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const song = state.songs.find((s) => s.id === songId);
    if (song) {
      Object.assign(song, data);
    }
    closeEditModal();
    toast("Saved");
    const listEl = document.getElementById("libNodes");
    if (listEl) renderLib(listEl);
  }
  function removeFromQueue(songId) {
    const idx = state.queue.indexOf(songId);
    if (idx < 0) return;
    state.queue.splice(idx, 1);
    if (state.queue.length === 0) state.queueIdx = -1;
    else if (idx < state.queueIdx) state.queueIdx--;
    else if (idx === state.queueIdx) {
      if (state.queueIdx >= state.queue.length) state.queueIdx = state.queue.length - 1;
      if (state.queueIdx >= 0) playFromQueue();
      else stopPlaybackFull();
    }
    saveQueue();
    renderQueue();
  }
  function clearQueue() {
    state.queue = [];
    state.queueIdx = -1;
    saveQueue();
    renderQueue();
  }
  function playFromQueue() {
    if (state.queueIdx < 0 || state.queueIdx >= state.queue.length) return;
    const id = state.queue[state.queueIdx];
    if (!state.songs.some((s) => s.id === id)) {
      removeFromQueue(id);
      return;
    }
    goToId(id, false);
  }
  function nextFromQueue() {
    if (!state.queue.length) return false;
    if (state.queueIdx < state.queue.length - 1) {
      state.queueIdx++;
      playFromQueue();
      return true;
    }
    if (state.repeat !== "off" && state.queue.length > 0) {
      state.queueIdx = 0;
      playFromQueue();
      return true;
    }
    return false;
  }
  function prevFromQueue() {
    if (!state.queue.length) return false;
    if (state.queueIdx > 0) {
      state.queueIdx--;
      playFromQueue();
      return true;
    }
    if (state.repeat !== "off" && state.queue.length > 0) {
      state.queueIdx = state.queue.length - 1;
      playFromQueue();
      return true;
    }
    return false;
  }

  function renderQueue() {
    const section = document.getElementById("queueSection");
    const list = document.getElementById("queueNodes");
    const countEl = document.getElementById("queueCount");
    if (!section || !list) return;
    if (!state.queue.length) {
      section.style.display = "none";
      return;
    }
    section.style.display = "";
    if (countEl) countEl.textContent = state.queue.length;
    list.innerHTML = "";
    state.queue.forEach((id, i) => {
      const s = state.songs.find((x) => x.id === id);
      if (!s) return;
      const li = document.createElement("li");
      li.className = "node static";
      li.draggable = true;
      li.dataset.id = s.id;
      li.dataset.pos = i;
      const tag = sourceBadges(s);
      const sub = [s.artist, s.album].filter(Boolean).join(" · ");
      const isCurrent = state.curId === s.id && state.playing;
      li.innerHTML =
        '<div class="idx">' + (i + 1) + "</div>" +
        '<div class="ninfo">' +
          '<div class="nname"><span class="nm">' + escapeHtml(s.name) + "</span>" +
            '<span class="eqmini"><i></i><i></i><i></i><i></i></span></div>' +
          '<div class="nlen">' + (s.duration ? fmt(s.duration) : "—") +
            (sub ? " · " + escapeHtml(sub) : "") + " · " + tag + "</div>" +
        "</div>" +
        '<button class="qplay" title="Play now">▶</button>' +
        '<button class="rm" title="Remove">✕</button>';
      if (isCurrent) li.classList.add("playing");
      li.querySelector(".qplay").addEventListener("click", (e) => {
        e.stopPropagation();
        state.queueIdx = i;
        saveQueue();
        playFromQueue();
        renderQueue();
      });
      li.querySelector(".rm").addEventListener("click", (e) => {
        e.stopPropagation();
        removeFromQueue(s.id);
      });
      li.addEventListener("dragstart", (e) => {
        li.classList.add("queue-drag");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
      });
      li.addEventListener("dragend", () => li.classList.remove("queue-drag"));
      li.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        li.classList.add("queue-over");
      });
      li.addEventListener("dragleave", () => li.classList.remove("queue-over"));
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        li.classList.remove("queue-over");
        const fromIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
        const toIdx = i;
        if (isNaN(fromIdx) || fromIdx === toIdx) return;
        const moved = state.queue.splice(fromIdx, 1)[0];
        state.queue.splice(toIdx, 0, moved);
        if (state.queueIdx === fromIdx) state.queueIdx = toIdx;
        else if (fromIdx < state.queueIdx && toIdx >= state.queueIdx) state.queueIdx--;
        else if (fromIdx > state.queueIdx && toIdx <= state.queueIdx) state.queueIdx++;
        saveQueue();
        renderQueue();
      });
      list.appendChild(li);
    });
  }

  function ensureAudio() {
    if (audioCtx) {
      if (audioCtx.state === "suspended") audioCtx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = state.volume;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    eqData = new Uint8Array(analyser.frequencyBinCount);

    eqInput = audioCtx.createBiquadFilter();
    eqInput.type = "allpass";
    eqBassFilter = audioCtx.createBiquadFilter();
    eqBassFilter.type = "lowshelf";
    eqBassFilter.frequency.value = 200;
    eqBassFilter.gain.value = 0;
    eqMidFilter = audioCtx.createBiquadFilter();
    eqMidFilter.type = "peaking";
    eqMidFilter.frequency.value = 1000;
    eqMidFilter.Q.value = 0.7;
    eqMidFilter.gain.value = 0;
    eqTrebleFilter = audioCtx.createBiquadFilter();
    eqTrebleFilter.type = "highshelf";
    eqTrebleFilter.frequency.value = 3500;
    eqTrebleFilter.gain.value = 0;

    eqInput.connect(eqBassFilter);
    eqBassFilter.connect(eqMidFilter);
    eqMidFilter.connect(eqTrebleFilter);
    eqTrebleFilter.connect(masterGain);
    masterGain.connect(analyser);
    analyser.connect(audioCtx.destination);

    mediaSource = audioCtx.createMediaElementSource(audioEl);
    mediaSource.connect(eqInput);

    if (!audioEl._endedBound) {
      audioEl._endedBound = true;
      audioEl.addEventListener("ended", () => { if (state.mode === "file") onEnded(); });
    }
    loadEQ();
  }

  function makeImpulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  // Render a synth "song" into a real, seekable AudioBuffer (cached).
  async function renderSynth(song) {
    if (bufferCache[song.id]) return bufferCache[song.id];
    const sr = 44100;
    const dur = Math.max(4, song.duration || 30);
    const off = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);
    const roots = song.pattern || [0, 3, 7, 10, 12];
    const seed = (song.id * 9301 + 49297) % 233280;
    const rng = () => { seed; return ((Math.sin(song.id * 9301 + 49297) * 10000) % 1 + 1) % 1; };

    const reverb = off.createConvolver();
    reverb.buffer = makeImpulse(off, 2.4, 2.4);
    const wet = off.createGain(); wet.gain.value = 0.35 + rng() * 0.2;
    reverb.connect(wet); wet.connect(off.destination);

    const droneType = ["sine", "triangle", "sawtooth"][Math.floor(rng() * 3)];
    const drone = off.createOscillator();
    drone.type = droneType; drone.frequency.value = song.base / 2;
    const dg = off.createGain(); dg.gain.value = 0.12 + rng() * 0.08;
    const lfo = off.createOscillator(); lfo.frequency.value = 0.05 + rng() * 0.1;
    const lg = off.createGain(); lg.gain.value = 0.04 + rng() * 0.06;
    lfo.connect(lg); lg.connect(dg.gain);
    drone.connect(dg); dg.connect(off.destination); dg.connect(reverb);
    drone.start(0); drone.stop(dur); lfo.start(0); lfo.stop(dur);

    const chordGap = 3 + rng() * 2;
    for (let t = 0; t < dur; t += chordGap) {
      const root = roots[Math.floor(t / chordGap) % roots.length];
      const types = ["sine", "triangle", "sawtooth"];
      const order = [0, 1, 2].sort(() => rng() - 0.5);
      order.forEach((idx, i) => {
        const o = off.createOscillator();
        o.type = types[idx];
        o.frequency.value = song.base * Math.pow(2, (root + [0, 7, 12][i]) / 12);
        o.detune.value = (rng() - 0.5) * 12;
        const f = off.createBiquadFilter();
        f.type = "lowpass"; f.frequency.value = 400 + rng() * 600;
        const g = off.createGain(); g.gain.value = 0;
        const seg = Math.min(chordGap, dur - t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.03 + rng() * 0.04, t + 0.8);
        g.gain.linearRampToValueAtTime(0.0001, t + seg);
        o.connect(f); f.connect(g); g.connect(off.destination); g.connect(reverb);
        o.start(t); o.stop(t + seg + 0.1);
      });
    }

    const step = 0.24 + rng() * 0.18;
    let t = 0, i = 0;
    while (t < dur) {
      const semi = roots[i % roots.length];
      const o = off.createOscillator();
      o.type = ["sine", "triangle"][Math.floor(rng() * 2)];
      o.frequency.value = song.base * Math.pow(2, semi / 12);
      const g = off.createGain(); g.gain.value = 0;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15 + rng() * 0.1, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + step * 0.75);
      o.connect(g); g.connect(off.destination); g.connect(reverb);
      o.start(t); o.stop(t + step);
      t += step; i++;
    }

    const buf = await off.startRendering();
    bufferCache[song.id] = buf;
    song.duration = +buf.duration.toFixed(1);
    return buf;
  }

  function stopBufferSource() {
    if (bufferSource) {
      try { bufferSource.stop(); } catch (e) {}
      try { bufferSource.disconnect(); } catch (e) {}
      bufferSource = null;
    }
  }

  /* ========================= Transport ========================= */
  function curIndex() {
    const i = state.songs.findIndex((s) => s.id === state.curId);
    return i < 0 ? 0 : i;
  }

  function playCurrent(offset) {
    const s = state.songs[curIndex()];
    if (!s) return;
    const token = ++playToken;

    destroyEmbed();
    stopBufferSource();
    audioEl.pause();
    if (videoEl) videoEl.pause();

    state.playing = true;
    updatePlayBtn();
    updateNowPlaying();
    highlight();
    applySourceUI(s);

    const src = (s.source_type || "LOCAL");
    if (src === "YOUTUBE") { playYouTube(s, token); return; }
    if (src === "SPOTIFY") { playSpotify(s, token); return; }

    ensureAudio();

    if (s.type === "synth") {
      state.mode = "buffer";
      renderSynth(s).then((buf) => {
        if (token !== playToken || !state.playing) return;
        if (state.songs[curIndex()].id !== s.id) return;
        stopBufferSource();
        const srcNode = audioCtx.createBufferSource();
        srcNode.buffer = buf;
        srcNode.connect(masterGain);
        state.startTime = audioCtx.currentTime - (offset || 0);
        srcNode.start(0, offset || 0);
        bufferSource = srcNode;
        recordPlayback(s.id, token);
      });
      loopDraw();
      return;
    }
    if (s.media_type === "VIDEO") {
      return playVideo(s, offset, token);
    }
    state.mode = "file";
    state.activeEl = audioEl;
    if (!audioEl.src || !audioEl.src.endsWith(s.url)) audioEl.src = s.url;
    audioEl.currentTime = offset || 0;
    const p = audioEl.play();
    if (p && p.catch) p.then(() => { if (token === playToken) recordPlayback(s.id, token); }).catch(() => {});
    loopDraw();
    savePersist();
  }

  function ensureLocalMedia(s) {
    const host = document.getElementById("nowMedia");
    if (!host) return;
    if (s.media_type === "VIDEO") {
      if (!videoEl || videoEl.parentNode !== host) {
        videoEl = document.createElement("video");
        videoEl.className = "eq video";
        videoEl.preload = "metadata";
        videoEl.playsInline = true;
        videoEl.addEventListener("timeupdate", () => {
          if (state.mode !== "video") return;
          const dur = videoEl.duration || s.duration || 1;
          if (fill) fill.style.width = Math.min(100, (videoEl.currentTime / dur) * 100) + "%";
          if (tCur) tCur.textContent = fmt(videoEl.currentTime);
          if (videoEl.duration && tDur) tDur.textContent = fmt(videoEl.duration);
        });
        host.innerHTML = "";
        host.appendChild(videoEl);
      }
    } else if (!document.getElementById("eqCanvas")) {
      host.innerHTML = '<canvas id="eqCanvas" class="eq"></canvas>';
      eqCanvas = document.getElementById("eqCanvas");
      eqCanvas.width = 176; eqCanvas.height = 112;
      eqCtx = eqCanvas.getContext("2d");
    }
  }

  function playVideo(s, offset, token) {
    state.mode = "video";
    ensureLocalMedia(s);
    state.activeEl = videoEl;
    if (!videoEl.src || !videoEl.src.endsWith(s.url)) videoEl.src = s.url;
    videoEl.currentTime = offset || 0;
    const p = videoEl.play();
    if (p && p.catch) p.then(() => { if (token === playToken) recordPlayback(s.id, token); }).catch(() => {});
    loopDraw();
  }

  function ensureYouTubeAPI() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === "function") prev();
        resolve();
      };
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    });
    return ytApiPromise;
  }

  function destroyEmbed() {
    ytReqId++;  // cancel any in-flight YouTube player initialization
    if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch (e) {} }
    ytPlayer = null;
    const host = document.getElementById("nowMedia");
    if (host) host.innerHTML = "";
  }

  function playYouTube(s, token) {
    state.mode = "embed";
    state.activeEl = null;
    const host = document.getElementById("nowMedia");
    if (!host) { console.error("[LUMIFY] nowMedia container not found"); return; }
    if (!s.source_id) { console.error("[LUMIFY] YouTube item missing source_id", s); return; }

    host.innerHTML =
      '<div id="ytHost" class="yt-host"></div>' +
      '<div id="ytError" class="yt-error" style="display:none"></div>';

    const reqId = ++ytReqId;
    ensureYouTubeAPI().then(() => {
      if (reqId !== ytReqId) {
        return;
      }
      if (state.mode !== "embed" || state.curId !== s.id) {
        return;
      }
      if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch (e) {} }
      ytPlayer = null;
      ytPlayer = new YT.Player("ytHost", {
        videoId: s.source_id,
        width: "100%",
        height: "100%",
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1, origin: window.location.origin },
        events: {
          onReady: function () {
            console.log("[LUMIFY] YouTube player ready");
            const box = document.getElementById("ytError");
            if (box) box.style.display = "none";
            if (state.curId !== s.id) return;
            recordPlayback(s.id, token);
          },
          onStateChange: function (e) {
            if (e.data === YT.PlayerState.ENDED) {
              onEnded();
            }
          },
          onError: function (event) {
            const code = event && event.data;
            console.error("[LUMIFY] YouTube error code:", code, "videoId:", s.source_id);
            const box = document.getElementById("ytError");
            if (!box) return;
            box.style.display = "flex";
            if (code === 101 || code === 150) {
              box.textContent =
                "This YouTube video cannot be played inside LUMIFY because embedding is " +
                "disabled or restricted by the content provider.";
            } else {
              box.textContent =
                "This YouTube video could not be played right now (error " + code + ").";
            }
          },
        },
      });
    }).catch((err) => {
      console.error("[LUMIFY] YouTube API failed to load:", err);
    });
  }

  function playSpotify(s, token) {
    state.mode = "embed";
    state.activeEl = null;
    const host = document.getElementById("nowMedia");
    if (host) {
      host.innerHTML = '<iframe class="embed" src="' + s.url + '" ' +
        'allow="autoplay; encrypted-media" allowfullscreen frameborder="0"></iframe>';
    }
    recordPlayback(s.id, token);
  }

  function applySourceUI(s) {
    const embed = (s.source_type === "YOUTUBE" || s.source_type === "SPOTIFY");
    if (playBtn) playBtn.style.display = embed ? "none" : "";
    if (progress) progress.style.display = embed ? "none" : "";
    const timeEl = document.querySelector(".time");
    if (timeEl) timeEl.style.display = embed ? "none" : "";
    const volEl = document.querySelector(".vol");
    if (volEl) volEl.style.display = embed ? "none" : "";
  }

  function pausePlayback() {
    state.playing = false;
    updatePlayBtn();
    highlight();
    if (state.mode === "buffer" && audioCtx) {
      state.pausedAt = audioCtx.currentTime - state.startTime;
      stopBufferSource();
    } else if (state.mode === "video" && videoEl) {
      state.pausedAt = videoEl.currentTime;
      videoEl.pause();
    } else if (state.mode === "file") {
      state.pausedAt = audioEl.currentTime;
      audioEl.pause();
    } else if (state.mode === "embed") {
      state.pausedAt = 0;
      if (ytPlayer && ytPlayer.pauseVideo) {
        try { ytPlayer.pauseVideo(); } catch (e) {}
      }
    }
    if (rafId) cancelAnimationFrame(rafId);
    savePersist();
    saveCurrent();
  }

  function toggle() {
    if (!state.songs.length) return;
    if (state.playing) pausePlayback();
    else playCurrent(state.pausedAt > 0 ? state.pausedAt : 0);
  }

  function goTo(i) {
    if (!state.songs.length) return;
    const idx = (i + state.songs.length) % state.songs.length;
    goToId(state.songs[idx].id, true);
  }

  function goToId(id, clearQueue) {
    if (clearQueue) {
      state.queue = [];
      state.queueIdx = -1;
      saveQueue();
      renderQueue();
    }
    if (!state.songs.length || !state.playlist.nodeById(id)) return;
    state.curId = id;
    state.pausedAt = 0;
    stopBufferSource();
    audioEl.pause();
    if (videoEl) videoEl.pause();
    destroyEmbed();
    playCurrent(0);
    highlight();
    savePersist();
  }

  function selectNode(i) {
    const id = state.songs[i].id;
    if (id === state.curId && state.playing) { pausePlayback(); return; }
    goTo(i);
  }

  function randIndex() {
    if (state.songs.length < 2) return 0;
    const i = curIndex();
    let n;
    do { n = Math.floor(Math.random() * state.songs.length); } while (n === i);
    return n;
  }

  function next() {
    if (!state.songs.length) return;
    if (state.queue.length > 0 && state.queueIdx >= 0) {
      if (nextFromQueue()) return;
    }
    if (state.shuffle) { goTo(randIndex()); return; }
    const nxt = state.playlist.next(state.curId);
    if (nxt && nxt.id !== state.curId) goToId(nxt.id, true);
  }
  function prev() {
    if (!state.songs.length) return;
    if (state.queue.length > 0 && state.queueIdx >= 0) {
      if (prevFromQueue()) return;
    }
    if (state.shuffle) { goTo(randIndex()); return; }
    const prv = state.playlist.prev(state.curId);
    if (prv && prv.id !== state.curId) goToId(prv.id, true);
  }

  function onEnded() {
    if (state.repeat === "one") { state.pausedAt = 0; playCurrent(0); return; }
    if (state.queue.length > 0 && state.queueIdx >= 0) {
      if (nextFromQueue()) return;
    }
    if (state.shuffle) { goTo(randIndex()); return; }
    const nxt = state.playlist.next(state.curId, state.repeat !== "off");
    if (nxt && nxt.id !== state.curId) goToId(nxt.id, true);
    else stopPlaybackFull();
  }

  function stopPlaybackFull() {
    state.playing = false;
    state.pausedAt = 0;
    updatePlayBtn();
    stopBufferSource();
    audioEl.pause();
    if (videoEl) videoEl.pause();
    destroyEmbed();
    if (fill) fill.style.width = "0%";
    if (rafId) cancelAnimationFrame(rafId);
    highlight();
    savePersist();
    saveCurrent();
  }

  /* ============================ Draw ============================ */
  function loopDraw() {
    if (rafId) cancelAnimationFrame(rafId);
    const step = () => {
      if (!state.playing) return;
      if (state.mode === "embed") { rafId = requestAnimationFrame(step); return; }
      let cur = 0, dur = 1;
      if (state.mode === "buffer") {
        cur = audioCtx.currentTime - state.startTime;
        dur = state.songs[curIndex()].duration || 1;
        if (cur >= dur) { onEnded(); return; }
      } else if (state.mode === "file") {
        cur = audioEl.currentTime || 0;
        dur = audioEl.duration || state.songs[curIndex()].duration || 1;
      } else if (state.mode === "video") {
        cur = videoEl.currentTime || 0;
        dur = videoEl.duration || state.songs[curIndex()].duration || 1;
        if (cur >= dur) { onEnded(); return; }
      }
      if (Date.now() - lastPosSave > 3000) {
        lastPosSave = Date.now();
        state.pausedAt = cur;
        savePersist();
      }
      if (fill) fill.style.width = Math.min(100, (cur / dur) * 100) + "%";
      if (tCur) tCur.textContent = fmt(cur);
      if (state.mode === "file" && audioEl.duration && tDur) tDur.textContent = fmt(audioEl.duration);
      if (state.mode === "video" && videoEl.duration && tDur) tDur.textContent = fmt(videoEl.duration);
      drawEQ();
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  function drawEQ() {
    if (!analyser || !eqCtx) return;
    analyser.getByteFrequencyData(eqData);
    const w = eqCanvas.width, h = eqCanvas.height;
    eqCtx.clearRect(0, 0, w, h);
    const bars = 40;
    const step = Math.floor(eqData.length / bars) || 1;
    const bw = w / bars;
    for (let i = 0; i < bars; i++) {
      const v = eqData[i * step] / 255;
      const bh = Math.max(2, v * h * 0.95);
      const grad = eqCtx.createLinearGradient(0, h, 0, h - bh);
      grad.addColorStop(0, "#7c5cff");
      grad.addColorStop(1, "#00e0c6");
      eqCtx.fillStyle = grad;
      eqCtx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
    }
  }

  /* ============================ UI ============================ */
  function updatePlayBtn() {
    if (playBtn) playBtn.textContent = state.playing ? "⏸" : "▶";
    updateMini();
  }

  /* ===================== Mini player (global) ===================== */
  let mpEl, mpArt, mpTitle, mpArtist, mpPlay, mpPrev, mpNext;
  function initMiniPlayer() {
    mpEl = document.getElementById("miniPlayer");
    if (!mpEl) return;
    mpArt = document.getElementById("mpArt");
    mpTitle = document.getElementById("mpTitle");
    mpArtist = document.getElementById("mpArtist");
    mpPlay = document.getElementById("mpPlay");
    mpPrev = document.getElementById("mpPrev");
    mpNext = document.getElementById("mpNext");
    if (mpPlay) mpPlay.addEventListener("click", toggle);
    if (mpPrev) mpPrev.addEventListener("click", prev);
    if (mpNext) mpNext.addEventListener("click", next);
    if (mpArt) mpArt.addEventListener("click", () => { window.location.href = "/player"; });
    updateMini();
  }
  function updateMini() {
    if (!mpEl) return;
    const s = state.songs.find((x) => x.id === state.curId);
    if (!s) { mpEl.style.display = "none"; return; }
    mpEl.style.display = "";
    if (mpTitle) mpTitle.textContent = s.name || "Unknown";
    if (mpArtist) mpArtist.textContent = s.artist || (s.source_type || "LOCAL");
    if (mpArt) {
      const art = s.artwork_url ? s.artwork_url : artworkSvg(s);
      mpArt.style.backgroundImage = "url('" + art + "')";
    }
    if (mpPlay) mpPlay.textContent = state.playing ? "⏸" : "▶";
  }

  function updateNowPlaying() {
    const s = state.songs[curIndex()];
    if (!s) return;
    if (npTitle) npTitle.textContent = s.name;
    const metaBits = [];
    if (s.artist) metaBits.push(s.artist);
    if (s.album) metaBits.push(s.album);
    if (!metaBits.length) {
      const src = (s.source_type || "LOCAL");
      if (s.type === "synth") metaBits.push("generated node · " + s.id);
      else if (src === "YOUTUBE") metaBits.push("YouTube video");
      else if (src === "SPOTIFY") metaBits.push("Spotify track");
      else metaBits.push(s.media_type === "VIDEO" ? "local video" : "local file");
    }
    if (npMeta) npMeta.textContent = metaBits.join(" · ");
    if (npBadge) npBadge.textContent = (s.source_type || "LOCAL");
    if (tDur && (s.source_type === "LOCAL" || s.type === "synth")) tDur.textContent = fmt(s.duration);
    updateMini();
    saveCurrent();
  }

  function highlight() {
    if (!nodesEl) return;
    [...nodesEl.children].forEach((li) =>
      li.classList.toggle("playing", state.playing && Number(li.dataset.id) === state.curId));
    updateMini();
  }

  function buildNode(s, pos, opts) {
    const li = document.createElement("li");
    li.className = "node";
    li.dataset.id = s.id;
    li.dataset.pos = pos;
    li.draggable = !!opts.draggable;
    const tag = sourceBadges(s);
    const sub = [s.artist, s.album].filter(Boolean).join(" · ");
    const heart = s.is_favorite ? "♥" : "♡";
    li.innerHTML =
      (opts.draggable ? '<div class="grip">⠿</div>' : "") +
      '<div class="idx">' + (pos + 1) + "</div>" +
      '<div class="ninfo">' +
        '<div class="nname"><span class="nm">' + escapeHtml(s.name) + "</span>" +
          '<span class="eqmini"><i></i><i></i><i></i><i></i></span></div>' +
        '<div class="nlen">' + (s.duration ? fmt(s.duration) : "—") +
          (sub ? " · " + escapeHtml(sub) : "") + " · " + tag + "</div>" +
      "</div>" +
      '<button class="fav ' + (s.is_favorite ? "active" : "") + '" title="Like">' + heart + "</button>" +
      (opts.queueable ? '<button class="qnext" title="Play Next">⏭</button><button class="qend" title="Add to Queue">+</button>' : "") +
      (opts.removable ? '<button class="rm" title="Remove">✕</button>' : "") +
      (opts.editable ? '<button class="edit" title="Edit information">✎</button>' : "");

    if (opts.playOnClick) li.addEventListener("click", () => selectNode(pos));
    if (opts.removable) li.querySelector(".rm").addEventListener("click", (e) => {
      e.stopPropagation(); removeSong(s.id);
    });
    if (opts.queueable) {
      li.querySelector(".qnext").addEventListener("click", (e) => {
        e.stopPropagation(); enqueueNext(s.id);
      });
      li.querySelector(".qend").addEventListener("click", (e) => {
        e.stopPropagation(); enqueue(s.id);
      });
    }
    const favBtn = li.querySelector(".fav");
    if (favBtn) {
      favBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const res = await fetch("/api/songs/" + s.id + "/favorite", { method: "POST" });
        if (res.ok) {
          const d = await res.json();
          s.is_favorite = d.is_favorite;
          favBtn.textContent = s.is_favorite ? "♥" : "♡";
          favBtn.classList.toggle("active", s.is_favorite);
        }
      });
    }
    if (opts.renameable) enableRename(li.querySelector(".nm"), s);
    if (opts.draggable) addDnD(li);
    return li;
  }

  function renderNodes(container, opts) {
    container.innerHTML = "";
    state.songs.forEach((s, i) => container.appendChild(buildNode(s, i, opts)));
    highlight();
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function sourceBadges(s) {
    const src = (s.source_type || "LOCAL");
    let html = '<span class="tag src-' + src.toLowerCase() + '">' + src.toLowerCase() + "</span>";
    if (src === "LOCAL") {
      html += '<span class="tag">' + ((s.media_type || "MUSIC").toLowerCase()) + "</span>";
    }
    return html;
  }

  function artworkSvg(song) {
    if (song.artwork_url) {
      return song.artwork_url;
    }
    const src = (song.source_type || "LOCAL").toLowerCase();
    const hue = src === "youtube" ? "#ff5c5c" : src === "spotify" ? "#1ed760" : "#f5c842";
    const initials = (song.name || "?").split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${hue}" stop-opacity="0.35"/>
          <stop offset="1" stop-color="#7c5cff" stop-opacity="0.25"/>
        </linearGradient>
      </defs>
      <rect width="320" height="320" fill="url(#g)"/>
      <circle cx="160" cy="140" r="70" fill="${hue}" opacity="0.25"/>
      <text x="160" y="170" text-anchor="middle" fill="#fff" font-family="Segoe UI,system-ui" font-weight="700" font-size="72">${initials}</text>
    </svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }

  function humanSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + " " + u[i];
  }

  function enableRename(span, song) {
    span.style.cursor = "text";
    span.title = "Double-click to rename";
    span.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.className = "rename-input";
      input.value = song.name;
      span.replaceWith(input);
      input.focus(); input.select();
      const commit = async () => {
        const v = input.value.trim();
        if (v && v !== song.name) {
          const r = await fetch("/api/songs/" + song.id, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: v }),
          });
          if (r.ok) song.name = v;
        }
        const ns = document.createElement("span");
        ns.className = "nm"; ns.textContent = song.name;
        input.replaceWith(ns);
        enableRename(ns, song);
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") input.blur();
        if (ev.key === "Escape") { input.value = song.name; input.blur(); }
      });
    });
  }

  /* ---------- drag & drop reorder (FLIP animated) ---------- */
  function addDnD(li) {
    li.addEventListener("dragstart", (e) => {
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", li.dataset.pos);
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      document.querySelectorAll(".node.over").forEach((n) => n.classList.remove("over"));
    });
    li.addEventListener("dragover", (e) => {
      e.preventDefault(); e.dataTransfer.dropEffect = "move"; li.classList.add("over");
    });
    li.addEventListener("dragleave", () => li.classList.remove("over"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      li.classList.remove("over");
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      const to = parseInt(li.dataset.pos, 10);
      if (isNaN(from) || from === to) return;
      reorder(from, to);
    });
  }

  function reorder(from, to) {
    const children = [...nodesEl.children];
    const first = new Map();
    children.forEach((li) => first.set(li, li.getBoundingClientRect()));

    const moved = state.songs.splice(from, 1)[0];
    state.songs.splice(to, 0, moved);

    renderNodes(nodesEl, reorderOpts);

    [...nodesEl.children].forEach((li) => {
      const f = first.get(li); if (!f) return;
      const l = li.getBoundingClientRect();
      const dx = f.left - l.left, dy = f.top - l.top;
      li.style.transform = `translate(${dx}px, ${dy}px)`;
      li.style.transition = "none";
    });
    requestAnimationFrame(() => {
      [...nodesEl.children].forEach((li) => {
        li.style.transition = "transform 0.28s cubic-bezier(.2,.8,.2,1)";
        li.style.transform = "";
      });
    });
    persistOrder();
    rebuildPlaylist();
  }

  let reorderOpts = { draggable: true, removable: true, renameable: true, playOnClick: true, queueable: true, editable: true };

  async function persistOrder() {
    await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: state.songs.map((s) => s.id) }),
    });
  }

  function shuffleOrder() {
    for (let i = state.songs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.songs[i], state.songs[j]] = [state.songs[j], state.songs[i]];
    }
    renderNodes(nodesEl, reorderOpts);
    persistOrder();
    rebuildPlaylist();
  }

  async function removeSong(id) {
    const idx = state.songs.findIndex((s) => s.id === id);
    if (idx < 0) return;
    await fetch("/api/songs/" + id, { method: "DELETE" });
    const wasPlaying = state.playing && state.songs[idx].id === state.curId;
    const qIdx = state.queue.indexOf(id);
    if (qIdx >= 0) {
      state.queue.splice(qIdx, 1);
      if (state.queue.length === 0) state.queueIdx = -1;
      else if (qIdx < state.queueIdx) state.queueIdx--;
      else if (qIdx === state.queueIdx) {
        if (state.queueIdx >= state.queue.length) state.queueIdx = state.queue.length - 1;
      }
      saveQueue();
      renderQueue();
    }
    state.songs.splice(idx, 1);
    if (wasPlaying) stopPlaybackFull();
    else if (!state.songs.some((s) => s.id === state.curId)) {
      state.curId = state.songs.length ? state.songs[Math.min(idx, state.songs.length - 1)].id : null;
    }
    renderNodes(nodesEl, reorderOpts);
    updateNodeCount();
    persistOrder();
    rebuildPlaylist();
    toast("Removed node");
  }

  function updateNodeCount() {
    const el = document.getElementById("nodeCount");
    if (el) el.textContent = state.songs.length;
  }

  /* ============================ Toast ============================ */
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  /* ============================ Load ============================ */
  async function loadSongs() {
    const r = await fetch("/api/songs");
    state.songs = await r.json();
    if (!state.songs.some((s) => s.id === state.curId)) {
      state.curId = state.songs.length ? state.songs[0].id : null;
    }
    loadQueue();
    return state.songs;
  }

  /* ============================ Inits ============================ */
  async function initPlaylist() {
    nodesEl = document.getElementById("plNodes");
    if (!nodesEl) return;
    reorderOpts = { draggable: true, removable: true, renameable: true, playOnClick: false, queueable: true, editable: true };
    await loadSongs();
    rebuildPlaylist();
    renderNodes(nodesEl, reorderOpts);
    updateNodeCount();
    const sb = document.getElementById("shuffleOrderBtn");
    if (sb) sb.addEventListener("click", shuffleOrder);
  }

  async function initPlayer() {
    nodesEl = document.getElementById("plNodes");
    npTitle = document.getElementById("npTitle");
    npMeta = document.getElementById("npMeta");
    npBadge = document.getElementById("npBadge");
    fill = document.getElementById("fill");
    tCur = document.getElementById("tCur");
    tDur = document.getElementById("tDur");
    progress = document.getElementById("progress");
    playBtn = document.getElementById("playBtn");
    eqCanvas = document.getElementById("eqCanvas");
    if (eqCanvas) { eqCanvas.width = 176; eqCanvas.height = 112; eqCtx = eqCanvas.getContext("2d"); }

    loadPersist();
    reorderOpts = { draggable: true, removable: true, renameable: true, playOnClick: true, queueable: true, editable: true };
    await loadSongs();
    rebuildPlaylist();
    renderNodes(nodesEl, reorderOpts);
    updateNodeCount();
    updateNowPlaying();
    const valid = state.songs.some((s) => s.id === state.curId);
    if (!valid) state.curId = state.songs.length ? state.songs[0].id : null;
    renderQueue();

    const clearQ = document.getElementById("clearQueueBtn");
    if (clearQ) clearQ.addEventListener("click", clearQueue);

    if (playBtn) playBtn.addEventListener("click", toggle);
    const prevBtnEl = document.getElementById("prevBtn");
    if (prevBtnEl) prevBtnEl.addEventListener("click", prev);
    const nextBtnEl = document.getElementById("nextBtn");
    if (nextBtnEl) nextBtnEl.addEventListener("click", next);

    const rep = document.getElementById("repeatBtn");
    if (rep) {
      const repLabels = { off: "off", all: "all", one: "1" };
      const syncRep = () => {
        rep.querySelector(".lbl").textContent = repLabels[state.repeat];
        rep.classList.toggle("active", state.repeat !== "off");
      };
      rep.addEventListener("click", () => {
        state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
        syncRep(); savePersist();
      });
      syncRep();
    }

    const shm = document.getElementById("shuffleModeBtn");
    if (shm) {
      const syncShm = () => {
        shm.querySelector(".lbl").textContent = state.shuffle ? "on" : "off";
        shm.classList.toggle("active", state.shuffle);
      };
      shm.addEventListener("click", () => { state.shuffle = !state.shuffle; syncShm(); savePersist(); });
      syncShm();
    }

    const sb = document.getElementById("shuffleOrderBtn");
    if (sb) sb.addEventListener("click", shuffleOrder);

    const vol = document.getElementById("volSlider");
    if (vol) {
      vol.value = state.volume;
      vol.addEventListener("input", () => {
        state.volume = parseFloat(vol.value);
        if (masterGain) masterGain.gain.value = state.volume;
        if (audioEl) audioEl.volume = state.volume;
        if (videoEl) videoEl.volume = state.volume;
        savePersist();
      });
    }

    if (progress) progress.addEventListener("click", (e) => {
      const r = progress.getBoundingClientRect();
      const ratio = (e.clientX - r.left) / r.width;
      const s = state.songs[curIndex()];
      if (state.mode === "video" && videoEl.duration) videoEl.currentTime = ratio * videoEl.duration;
      else if (state.mode === "file" && audioEl.duration) audioEl.currentTime = ratio * audioEl.duration;
      else if (state.mode === "buffer") {
        state.startTime = audioCtx.currentTime - ratio * s.duration;
      }
    });

    const sleepBtn = document.getElementById("sleepBtn");
    if (sleepBtn) {
      const opts = [0, 15, 30, 60];
      let sleepIdx = 0;
      let sleepTimer = null;
      const sync = () => {
        const mins = opts[sleepIdx];
        sleepBtn.querySelector(".lbl").textContent = mins ? mins + "m" : "off";
        sleepBtn.classList.toggle("active", !!mins);
      };
      sleepBtn.addEventListener("click", () => {
        sleepIdx = (sleepIdx + 1) % opts.length;
        if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
        const mins = opts[sleepIdx];
        if (mins) {
          sleepTimer = setTimeout(() => {
            stopPlaybackFull();
            toast("Sleep timer: stopped");
            sleepIdx = 0; sync();
          }, mins * 60 * 1000);
          toast("Sleep timer: " + mins + " min");
        }
        sync();
      });
      sync();
    }

    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.code === "Space") { e.preventDefault(); toggle(); }
      else if (e.code === "ArrowRight") next();
      else if (e.code === "ArrowLeft") prev();
    });
  }

  /* ============================ Library ============================ */
  let libAll = [];
  let libFilter = "all";
  let libQuery = "";
  let libView = localStorage.getItem("lumifyView") || "list"; // list | grid | rail
  let libEmptyMsg = "No media matches.";

  async function initLibrary() {
    const listEl = document.getElementById("libNodes");
    if (!listEl) return;

    // Sidebar "Your Music" curated views (?view=liked|recent|most_played)
    const params = new URLSearchParams(location.search);
    const view = params.get("view");
    const VIEW_MAP = {
      liked:       { url: "/api/songs/favorites",   title: "Liked Songs",     sub: "Songs you've marked as favorites.",            empty: "No liked songs yet. Tap the heart on any track to add it here." },
      recent:      { url: "/api/songs/recent",      title: "Recently Played", sub: "The tracks you've played most recently.",      empty: "Nothing played yet. Press play on a track to see it here." },
      most_played: { url: "/api/songs/most-played", title: "Most Played",     sub: "Your most-played tracks, ranked.",            empty: "No plays recorded yet." },
    };
    const special = VIEW_MAP[view];

    if (special) {
      const h1 = document.querySelector(".topbar h1");
      const sub = document.querySelector(".topbar .sub");
      if (h1) h1.textContent = special.title;
      if (sub) sub.textContent = special.sub;
      libEmptyMsg = special.empty;
      // Import UI and source tabs aren't relevant to these curated views.
      ["#importZone", ".link-import", "#filterTabs"].forEach((sel) => {
        const el = document.querySelector(sel);
        if (el) el.style.display = "none";
      });
      libFilter = "all";
    } else {
      libEmptyMsg = "No media matches.";
      const filter = params.get("filter");
      if (filter) {
        const tab = document.querySelector('#filterTabs .tab[data-f="' + filter + '"]');
        if (tab) {
          document.querySelectorAll("#filterTabs .tab").forEach((x) => x.classList.remove("active"));
          tab.classList.add("active");
          libFilter = filter;
        }
      }
    }

    try {
      const r = await fetch(special ? special.url : "/api/songs");
      libAll = await r.json();
      renderLib(listEl);
    } catch (e) {
      console.error("[LUMIFY] initLibrary error", e);
    }

    const search = document.getElementById("searchInput");
    if (search) search.addEventListener("input", () => {
      libQuery = search.value.toLowerCase(); renderLib(listEl);
    });
    document.querySelectorAll("#filterTabs .tab").forEach((t) =>
      t.addEventListener("click", () => {
        document.querySelectorAll("#filterTabs .tab").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        libFilter = t.dataset.f;
        renderLib(listEl);
      }));

    const viewListBtn = document.getElementById("viewListBtn");
    const viewGridBtn = document.getElementById("viewGridBtn");
    if (viewListBtn && viewGridBtn) {
      const syncView = () => {
        viewListBtn.classList.toggle("active", libView === "list");
        viewGridBtn.classList.toggle("active", libView === "grid");
        listEl.classList.toggle("grid-view", libView === "grid");
        localStorage.setItem("lumifyView", libView);
      };
      viewListBtn.addEventListener("click", () => { libView = "list"; syncView(); renderLib(listEl); });
      viewGridBtn.addEventListener("click", () => { libView = "grid"; syncView(); renderLib(listEl); });
      syncView();
    }

    initImport(listEl);
    initFileBrowser(listEl);
    initLinkImport(listEl);

    const editClose = document.getElementById("editClose");
    const editCancel = document.getElementById("editCancelBtn");
    const editSave = document.getElementById("editSaveBtn");
    if (editClose) editClose.addEventListener("click", closeEditModal);
    if (editCancel) editCancel.addEventListener("click", closeEditModal);
    if (editSave) editSave.addEventListener("click", saveEditModal);
  }
  function initLinkImport(listEl) {
    const linkBtn = document.getElementById("linkImportBtn");
    const linkInput = document.getElementById("linkInput");
    const localCheck = document.getElementById("youtubeLocalCheck");
    if (!linkBtn || !linkInput) return;

    const doLink = async () => {
      const url = linkInput.value.trim();
      if (!url) { toast("Paste a media link first."); return; }
      linkBtn.disabled = true;
      const original = linkBtn.textContent;
      linkBtn.textContent = "Importing…";
      try {
        const form = new URLSearchParams();
        form.set("url", url);
        if (localCheck && localCheck.checked) form.set("local", "1");
        const res = await fetch("/api/songs/import", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        const d = await res.json();
        if (!res.ok) {
          toast(d.error || "Unable to import this media.");
        } else if (d.local) {
          toast("YouTube audio downloaded and added to your library.");
        } else {
          toast("Added to your LUMIFY library.");
        }
        linkInput.value = "";
        await refreshLib(listEl);
      } catch (e) {
        toast("Import failed. Check the link and your connection.");
      } finally {
        linkBtn.disabled = false;
        linkBtn.textContent = original;
      }
    };

    linkBtn.addEventListener("click", doLink);
    linkInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doLink(); });
  }
  function initFileBrowser(listEl) {
    const btn = document.getElementById("browseBtn");
    const modal = document.getElementById("browseModal");
    if (!btn || !modal) return;
    const pathEl = document.getElementById("browsePath");
    const listEl2 = document.getElementById("browseList");
    const selEl = document.getElementById("browseSel");
    const closeBtn = document.getElementById("browseClose");
    const importBtn = document.getElementById("browseImport");
    const importFolderBtn = document.getElementById("browseImportFolder");

    let currentPath = null;
    let selected = [];      // array of file paths
    let currentDir = null;  // for "import folder"

    async function load(path) {
      const url = "/api/browse" + (path ? "?path=" + encodeURIComponent(path) : "");
      const res = await fetch(url);
      const data = await res.json();
      currentPath = data.path;
      currentDir = data.path;
      pathEl.textContent = data.is_roots ? "Choose a location:" : data.path;
      listEl2.innerHTML = "";
      if (!data.is_roots && data.parent) {
        const up = document.createElement("div");
        up.className = "brow-item brow-up";
        up.innerHTML = '<span class="ic">↰</span><span class="nm">.. (up)</span>';
        up.addEventListener("click", () => load(data.parent));
        listEl2.appendChild(up);
      }
      if (data.is_roots) {
        data.roots.forEach((rt) => {
          const it = document.createElement("div");
          it.className = "brow-item dir";
          it.innerHTML = '<span class="ic">📁</span><span class="nm">' + escapeHtml(rt.name) + "</span>";
          it.addEventListener("click", () => load(rt.path));
          listEl2.appendChild(it);
        });
        return;
      }
      data.items.forEach((it) => {
        const row = document.createElement("div");
        row.className = "brow-item " + it.type;
        const sz = it.type === "file" && it.size ? humanSize(it.size) : "";
        row.innerHTML = '<span class="ic">' + (it.type === "dir" ? "📁" : "🎵") + "</span>" +
          '<span class="nm">' + escapeHtml(it.name) + "</span>" +
          (sz ? '<span class="sz">' + sz + "</span>" : "");
        if (it.type === "dir") {
          row.addEventListener("click", () => load(it.path));
        } else {
          row.addEventListener("click", () => {
            const i = selected.indexOf(it.path);
            if (i >= 0) { selected.splice(i, 1); row.classList.remove("sel"); }
            else { selected.push(it.path); row.classList.add("sel"); }
            selEl.textContent = selected.length + " selected";
          });
        }
        listEl2.appendChild(row);
      });
    }

    function open() { selected = []; selEl.textContent = "0 selected"; modal.classList.add("show"); load(null); }
    function close() { modal.classList.remove("show"); }

    btn.addEventListener("click", open);
    closeBtn.addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

    importBtn.addEventListener("click", async () => {
      if (!selected.length) { toast("Select files first"); return; }
      const res = await fetch("/api/browse/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: selected }),
      });
      const d = await res.json();
      toast("Imported " + d.count + " track(s)");
      close();
      await refreshLib(listEl);
    });

    importFolderBtn.addEventListener("click", async () => {
      if (!currentDir) { toast("Open a folder first"); return; }
      const res = await fetch("/api/browse?path=" + encodeURIComponent(currentDir));
      const d = await res.json();
      const files = d.items.filter((x) => x.type === "file").map((x) => x.path);
      if (!files.length) { toast("No audio in this folder"); return; }
      const r2 = await fetch("/api/browse/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: files }),
      });
      const d2 = await r2.json();
      toast("Imported " + d2.count + " track(s) from folder");
      close();
      await refreshLib(listEl);
    });
  }

  async function refreshLib(listEl) {
    const r = await fetch("/api/songs");
    libAll = await r.json();
    renderLib(listEl);
  }

  function libFiltered() {
    return libAll.filter((s) => {
      const src = (s.source_type || "LOCAL");
      const mt = (s.media_type || "MUSIC");
      if (libFilter === "music") { if (mt !== "MUSIC") return false; }
      else if (libFilter === "videos") { if (mt !== "VIDEO") return false; }
      else if (libFilter === "local") { if (src !== "LOCAL") return false; }
      else if (libFilter === "youtube") { if (src !== "YOUTUBE") return false; }
      else if (libFilter === "spotify") { if (src !== "SPOTIFY") return false; }
      else if (libFilter === "liked") { if (!s.is_favorite) return false; }
      if (libQuery) {
        const hay = (s.name + " " + (s.artist || "") + " " + (s.album || "")).toLowerCase();
        if (!hay.includes(libQuery)) return false;
      }
      return true;
    });
  }

  function renderLib(listEl) {
    listEl.innerHTML = "";
    const items = libFiltered();
    if (!items.length) {
      listEl.className = "nodes";
      listEl.innerHTML = '<li class="node static" style="justify-content:center;color:var(--muted)">' + escapeHtml(libEmptyMsg) + '</li>';
      return;
    }
    if (libView === "grid") {
      listEl.style.display = "grid";
      listEl.style.gridTemplateColumns = "repeat(auto-fill, minmax(160px, 1fr))";
      listEl.style.gap = "14px";
      items.forEach((s, i) => {
        const card = document.createElement("div");
        card.className = "media-card";
        card.dataset.id = s.id;
        const tag = sourceBadges(s);
        const sub = [s.artist, s.album].filter(Boolean).join(" · ");
        const heart = s.is_favorite ? "♥" : "♡";
        const artSrc = artworkSvg(s);
        card.innerHTML =
          '<div class="art">' +
            '<img src="' + artSrc + '" alt="" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">' +
            '<div class="play-overlay"><button class="play-btn">▶</button></div>' +
          '</div>' +
          '<div class="meta">' +
            '<div class="title">' + escapeHtml(s.name) + '</div>' +
            '<div class="sub">' + escapeHtml(sub || (s.source_type || 'LOCAL')) + '</div>' +
          '</div>' +
          '<div class="actions">' +
            '<button class="fav ' + (s.is_favorite ? "active" : "") + '" title="Like">' + heart + '</button>' +
            '<button class="edit" title="Edit information">✎</button>' +
            '<button class="qend" title="Add to queue">+</button>' +
          '</div>';
        card.querySelector(".play-btn").addEventListener("click", (e) => {
          e.stopPropagation(); playNowQueue(s.id);
        });
        card.querySelector(".fav").addEventListener("click", async (e) => {
          e.stopPropagation(); await toggleFavorite(s.id, e.currentTarget);
        });
        card.querySelector(".edit").addEventListener("click", (e) => {
          e.stopPropagation(); openEditModal(s.id);
        });
        card.querySelector(".qend").addEventListener("click", (e) => {
          e.stopPropagation(); enqueue(s.id); toast("Added to queue");
        });
        listEl.appendChild(card);
      });
      return;
    }
    listEl.style.display = "";
    listEl.style.gridTemplateColumns = "";
    items.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = "node static";
      li.dataset.id = s.id;
      const tag = sourceBadges(s);
      const sub = [s.artist, s.album].filter(Boolean).join(" · ");
      const heart = s.is_favorite ? "♥" : "♡";
      li.innerHTML =
        '<div class="idx">' + (i + 1) + "</div>" +
        '<div class="ninfo">' +
          '<div class="nname"><span class="nm">' + escapeHtml(s.name) + "</span></div>" +
          '<div class="nlen">' + (s.duration ? fmt(s.duration) : "—") +
            (s.size ? " · " + humanSize(s.size) : "") +
            (sub ? " · " + escapeHtml(sub) : "") + " · " + tag + "</div>" +
        "</div>" +
        '<button class="qplay" title="Play now">▶</button>' +
      '<button class="fav ' + (s.is_favorite ? "active" : "") + '" title="Like">' + heart + "</button>" +
      '<button class="edit" title="Edit information">✎</button>' +
      '<button class="qnext" title="Play Next">⏭</button>' +
      '<button class="qend" title="Add to Queue">+</button>' +
      '<button class="rm" title="Remove">✕</button>';
      li.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        playNowQueue(s.id);
      });
      enableRename(li.querySelector(".nm"), s);
      li.querySelector(".rm").addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch("/api/songs/" + s.id, { method: "DELETE" });
        libAll = libAll.filter((x) => x.id !== s.id);
        renderLib(listEl);
        toast("Removed node");
      });
      li.querySelector(".qplay").addEventListener("click", (e) => {
        e.stopPropagation();
        playNowQueue(s.id);
      });
      li.querySelector(".qnext").addEventListener("click", (e) => {
        e.stopPropagation();
        enqueueNext(s.id);
        toast("Play next");
      });
      li.querySelector(".qend").addEventListener("click", (e) => {
        e.stopPropagation();
        enqueue(s.id);
        toast("Added to queue");
      });
    const favBtn = li.querySelector(".fav");
    if (favBtn) {
      favBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await toggleFavorite(s.id, e.currentTarget);
      });
    }
    const editBtn = li.querySelector(".edit");
    if (editBtn) {
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditModal(s.id);
      });
    }
      listEl.appendChild(li);
    });
  }

  function initImport(listEl) {
    if (_importInitialized) return;
    _importInitialized = true;
    const zone = document.getElementById("importZone");
    const input = document.getElementById("fileInput");
    const overlay = document.createElement("div");
    overlay.className = "drop-overlay";
    overlay.textContent = "⬇  Drop audio to import";
    document.body.appendChild(overlay);

    const panel = document.getElementById("importPanel");
    const importList = document.getElementById("importList");
    const importCount = document.getElementById("importCount");
    const importStatus = document.getElementById("importStatus");
    const doImportBtn = document.getElementById("doImportBtn");
    const clearImportBtn = document.getElementById("clearImportBtn");
    const cancelImportBtn = document.getElementById("cancelImportBtn");
    const results = document.getElementById("importResults");
    const resultsList = document.getElementById("resultsList");
    const closeResultsBtn = document.getElementById("closeResultsBtn");
    const viewLibraryBtn = document.getElementById("viewLibraryBtn");

    let pendingFiles = [];

    function syncPanel() {
      if (!panel || !importList) return;
      panel.style.display = pendingFiles.length ? "" : "none";
      if (importCount) importCount.textContent = pendingFiles.length;
      importList.innerHTML = "";
      pendingFiles.forEach((f, i) => {
        const li = document.createElement("li");
        li.innerHTML = '<span class="name">' + escapeHtml(f.name) + "</span>" +
          '<span class="status">ready</span>';
        importList.appendChild(li);
      });
      if (importStatus) importStatus.textContent = pendingFiles.length ? pendingFiles.length + " file(s) ready" : "";
    }

    function showResultSummary(items) {
      if (!results || !resultsList) return;
      results.style.display = "";
      resultsList.innerHTML = "";
      const ok = items.filter((x) => x.status === "imported");
      const dup = items.filter((x) => x.status === "duplicate");
      const err = items.filter((x) => x.status === "error");
      if (ok.length) {
        const head = document.createElement("li");
        head.innerHTML = '<strong style="color:var(--accent2)">✓ Imported ' + ok.length + '</strong>';
        resultsList.appendChild(head);
      }
      if (dup.length) {
        const head = document.createElement("li");
        head.innerHTML = '<strong style="color:var(--accent)">⚠ Duplicates skipped: ' + dup.length + '</strong>';
        resultsList.appendChild(head);
      }
      if (err.length) {
        const head = document.createElement("li");
        head.innerHTML = '<strong style="color:var(--accent3)">✕ Failed: ' + err.length + '</strong>';
        resultsList.appendChild(head);
      }
      items.forEach((r) => {
        const li = document.createElement("li");
        li.innerHTML = '<span class="name">' + escapeHtml(r.file) + "</span>" +
          '<span class="status ' + (r.status === "imported" ? "ok" : r.status === "duplicate" ? "dup" : "err") + '">' + r.status + "</span>";
        resultsList.appendChild(li);
      });
    }

    if (doImportBtn) {
      doImportBtn.addEventListener("click", async () => {
        if (!pendingFiles.length) return;
        doImportBtn.disabled = true;
        const fd = new FormData();
        pendingFiles.forEach((f) => fd.append("files", f));
        try {
          const r = await fetch("/api/songs/import", { method: "POST", body: fd });
          const data = await r.json().catch(() => ({}));
          if (r.ok) {
            toast("Import complete");
            const items = data.results || data.imported.map((id) => ({ file: "track", status: "imported", id }));
            showResultSummary(items);
            pendingFiles = [];
            syncPanel();
            await refreshLib(listEl);
          } else {
            toast(data.error || "Import failed");
          }
        } catch (e) {
          toast("Import failed");
        } finally {
          doImportBtn.disabled = false;
        }
      });
    }
    if (clearImportBtn) clearImportBtn.addEventListener("click", () => { pendingFiles = []; syncPanel(); });
    if (cancelImportBtn) cancelImportBtn.addEventListener("click", () => { pendingFiles = []; syncPanel(); });
    if (closeResultsBtn) closeResultsBtn.addEventListener("click", () => { if (results) results.style.display = "none"; });
    if (viewLibraryBtn) viewLibraryBtn.addEventListener("click", () => { if (results) results.style.display = "none"; });

    let dragDepth = 0;
    const show = () => overlay.classList.add("show");
    const hide = () => overlay.classList.remove("show");
    window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; show(); });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", (e) => { dragDepth--; if (dragDepth <= 0) hide(); });
    window.addEventListener("drop", (e) => {
      e.preventDefault(); dragDepth = 0; hide();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        pendingFiles = [...e.dataTransfer.files];
        syncPanel();
      }
    });

    if (zone && input) {
      zone.addEventListener("click", () => input.click());
      input.addEventListener("change", () => {
        if (input.files && input.files.length) {
          pendingFiles = [...input.files];
          syncPanel();
        }
      });
      ["dragover", "dragenter"].forEach((ev) =>
        zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("drag"); }));
      ["dragleave", "drop"].forEach((ev) =>
        zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("drag"); }));
      zone.addEventListener("drop", (e) => {
        if (e.dataTransfer.files) {
          pendingFiles = [...e.dataTransfer.files];
          syncPanel();
        }
      });
    }
  }

  /* ===================== Cross-page continuity ===================== */
  const EQ_PRESETS = {
    "Flat": { bass: 0, mid: 0, treble: 0 },
    "Bass Boost": { bass: 10, mid: 0, treble: -2 },
    "Rock": { bass: 4, mid: 2, treble: 5 },
    "Pop": { bass: -1, mid: 3, treble: 4 },
    "Classical": { bass: 3, mid: -1, treble: 3 },
  };
  let eqPreset = "Flat";
  function applyEQ(presetName) {
    eqPreset = presetName;
    let p = EQ_PRESETS[presetName];
    if (!p && presetName === "Custom") {
      try {
        const saved = JSON.parse(localStorage.getItem("lumifyEq") || "{}");
        p = { bass: saved.bass ?? 0, mid: saved.mid ?? 0, treble: saved.treble ?? 0 };
      } catch (e) {
        p = { bass: 0, mid: 0, treble: 0 };
      }
    }
    if (!p) p = EQ_PRESETS["Flat"];
    if (eqBassFilter) eqBassFilter.gain.value = p.bass;
    if (eqMidFilter) eqMidFilter.gain.value = p.mid;
    if (eqTrebleFilter) eqTrebleFilter.gain.value = p.treble;
    try { localStorage.setItem("lumifyEq", JSON.stringify({ preset: presetName, bass: p.bass, mid: p.mid, treble: p.treble })); } catch (e) {}
  }
  function _hasAnalyser() {
    return !!(analyser && state.mode === "file");
  }
  function _getAnalyserData() {
    if (!analyser) return new Uint8Array(0);
    const arr = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(arr);
    return arr;
  }
  function loadEQ() {
    try {
      const saved = JSON.parse(localStorage.getItem("lumifyEq") || "null");
      if (saved && saved.preset) applyEQ(saved.preset);
    } catch (e) { applyEQ("Flat"); }
  }

  function saveCurrent() {
    try {
      const s = state.songs.find((x) => x.id === state.curId);
      if (!s) { localStorage.removeItem("lumifyCurrent"); return; }
      localStorage.setItem("lumifyCurrent", JSON.stringify({
        id: s.id, name: s.name, type: s.type, url: s.url,
        source_type: s.source_type, media_type: s.media_type,
        duration: s.duration, artist: s.artist, album: s.album,
        artwork_url: s.artwork_url,
      }));
    } catch (e) { /* ignore */ }
  }
  async function initGlobal() {
    if (window.__lumifyGlobalInit) return;
    window.__lumifyGlobalInit = true;
    loadPersist();
    loadQueue();
    loadEQ();

    const persistNow = () => {
      if (state.mode === "file" && audioEl) state.pausedAt = audioEl.currentTime;
      else if (state.mode === "video" && videoEl) state.pausedAt = videoEl.currentTime;
      savePersist();
    };
    window.addEventListener("pagehide", persistNow);
    window.addEventListener("beforeunload", persistNow);

    let cached = null;
    try { cached = JSON.parse(localStorage.getItem("lumifyCurrent") || "null"); } catch (e) { /* ignore */ }
    const canResumeNow = cached && cached.id === state.curId && state._wasPlaying && cached.type !== "synth";

    if (canResumeNow) {
      state.songs = [cached];
      rebuildPlaylist();
      initMiniPlayer();
      const onPlayer = location.pathname === "/player";
      const needsPlayer = (cached.media_type === "VIDEO" || cached.source_type === "YOUTUBE" || cached.source_type === "SPOTIFY");
      if (needsPlayer && !onPlayer) {
        window.location.href = "/player";
        return;
      }
      state.playing = true;
      updatePlayBtn();
      try { playCurrent(state.pausedAt || 0); } catch (e) {}
    } else {
      initMiniPlayer();
    }

    try {
      const r = await fetch("/api/songs");
      const all = await r.json();
      const wasResumed = canResumeNow;
      state.songs = all;
      rebuildPlaylist();
      if (wasResumed) {
        const still = state.songs.find((x) => x.id === state.curId);
        if (still) updateMini();
      }
    } catch (e) { /* ignore */ }
  }
  function autoGlobal() { initGlobal(); }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoGlobal);
  } else {
    autoGlobal();
  }

  /* ===================== AJAX Navigation ===================== */
  let _navReady = false;
  let _importInitialized = false;
  async function navigateTo(url, pushState = true) {
    if (!_navReady || url === window.location.href) return;

    try {
      const response = await fetch(url, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
      if (!response.ok) throw new Error('Navigation failed');

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const newH1 = doc.querySelector('.topbar h1');
      const newSub = doc.querySelector('.topbar .sub');
      const currentH1 = document.querySelector('.topbar h1');
      const currentSub = document.querySelector('.topbar .sub');
      if (newH1 && currentH1) currentH1.textContent = newH1.textContent;
      if (newSub && currentSub) currentSub.textContent = newSub.textContent;

      const newTitle = doc.querySelector('title');
      if (newTitle) document.title = newTitle.textContent;

      const newContent = doc.querySelector('section.content');
      const currentContent = document.querySelector('section.content');
      if (newContent && currentContent) {
        currentContent.innerHTML = newContent.innerHTML;
      }

      if (pushState) {
        history.pushState({}, '', url);
      }

      const scripts = doc.querySelectorAll('script');
      scripts.forEach(oldScript => {
        if (oldScript.src) return;
        const newScript = document.createElement('script');
        newScript.textContent = oldScript.textContent;
        document.body.appendChild(newScript);
      });

      updateActiveNav(url);
      const main = document.querySelector('main');
      if (main) main.scrollTop = 0;
    } catch (e) {
      console.error('Navigation failed, falling back to full reload:', e);
      window.location.href = url;
    }
  }

  function updateActiveNav(url) {
    document.querySelectorAll('.sidebar nav a').forEach(a => {
      a.classList.remove('active');
      const href = a.getAttribute('href') || '';
      const aPath = href.split('?')[0];
      const urlPath = url.split('?')[0];
      if (aPath === urlPath || (urlPath.startsWith(aPath + '/') && (aPath === '/artists' || aPath === '/albums'))) {
        a.classList.add('active');
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const link = e.target.closest('a');
    if (!link) return;
    if (link.target && link.target !== '_self') return;
    if (link.href && link.origin !== window.location.origin) return;
    if (link.href.includes('#')) return;
    if (link.getAttribute('download')) return;

    e.preventDefault();
    navigateTo(link.href);
  });

  window.addEventListener('popstate', () => {
    navigateTo(window.location.href, false);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { _navReady = true; });
  } else {
    _navReady = true;
  }

  /* ===================== Theme ===================== */
  const THEME_KEY = "lumifyTheme";
  const THEME_ACCENTS = {
    purple: "",
    blue: "theme-blue",
    green: "theme-green",
    red: "theme-red",
    orange: "theme-orange",
    pink: "theme-pink",
  };
  function applyTheme(theme) {
    const root = document.documentElement;
    const body = document.body;
    Object.values(THEME_ACCENTS).forEach((cls) => { if (cls) root.classList.remove(cls); });
    body.classList.remove("mode-light", "player-compact", "artwork-small", "artwork-medium", "artwork-large");
    if (!theme) theme = {};
    const accent = THEME_ACCENTS[theme.accent] || "";
    if (accent) root.classList.add(accent);
    if (theme.mode === "light") body.classList.add("mode-light");
    if (theme.compact === "compact") body.classList.add("player-compact");
    if (theme.artwork === "small") body.classList.add("artwork-small");
    else if (theme.artwork === "large") body.classList.add("artwork-large");
    else body.classList.add("artwork-medium");
  }
  function saveTheme(theme) {
    try { localStorage.setItem(THEME_KEY, JSON.stringify(theme)); } catch (e) {}
  }
  function loadTheme() {
    try {
      const raw = localStorage.getItem(THEME_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function initTheme() {
    const theme = loadTheme();
    applyTheme(theme);

    const modal = document.getElementById("themeModal");
    const openBtn = document.getElementById("themeSettingsBtn");
    const closeBtn = document.getElementById("themeClose");
    const saveBtn = document.getElementById("themeSaveBtn");
    const resetBtn = document.getElementById("themeResetBtn");
    if (!modal) return;

    const accentSel = document.getElementById("themeAccent");
    const modeSel = document.getElementById("themeMode");
    const compactSel = document.getElementById("themeCompact");
    const artworkSel = document.getElementById("themeArtwork");

    function syncFields() {
      if (accentSel) accentSel.value = theme.accent || "purple";
      if (modeSel) modeSel.value = theme.mode || "dark";
      if (compactSel) compactSel.value = theme.compact || "default";
      if (artworkSel) artworkSel.value = theme.artwork || "medium";
    }
    syncFields();

    function openModal() { modal.classList.add("show"); syncFields(); }
    function closeModal() { modal.classList.remove("show"); }
    if (openBtn) {
      openBtn.addEventListener("click", (e) => { e.preventDefault(); openModal(); });
    }
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        const next = {
          accent: accentSel ? accentSel.value : "purple",
          mode: modeSel ? modeSel.value : "dark",
          compact: compactSel ? compactSel.value : "default",
          artwork: artworkSel ? artworkSel.value : "medium",
        };
        saveTheme(next);
        applyTheme(next);
        closeModal();
      });
    }
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        const def = { accent: "purple", mode: "dark", compact: "default", artwork: "medium" };
        saveTheme(def);
        applyTheme(def);
        syncFields();
      });
    }
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  }

  /* ============================ Export ============================ */
  initTheme();
  return {
    initLibrary, initPlaylist, initPlayer,
    toggleFavorite, playNowQueue, enqueue, enqueueNext, removeFromQueue, clearQueue, toast,
    applyEQ, _hasAnalyser, _getAnalyserData, initTheme,
  };
})();
