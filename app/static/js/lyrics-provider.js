const LyricsProvider = {
  async fetchYouTubeLRC(videoId, title, artist, duration) {
    try {
      const res = await fetch("/api/lyrics/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_id: videoId, title, artist, duration }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.lines) ? data.lines : [];
    } catch (e) {
      return [];
    }
  },
};

function parseLRC(text) {
  const lines = (text || "").split(/\r?\n/);
  const out = [];
  const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of lines) {
    const matches = [...raw.matchAll(re)];
    if (!matches.length) continue;
    const content = raw.replace(re, "").trim();
    for (const m of matches) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const ms = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
      out.push({ time: min * 60 + sec + ms / 1000, text: content });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}
