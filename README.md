# LUMIFY

A premium, self-hosted media player web application with a built-in ambient audio synthesizer. LUMIFY supports local files, YouTube, and Spotify imports, and offers real-time audio visualization, queue management, and a themable interface.

![Python](https://img.shields.io/badge/python-3.10%2B-blue)
![Flask](https://img.shields.io/badge/Flask-3.0-black)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Table of Contents

- [Why LUMIFY?](#why-lumify)
- [Architecture Overview](#architecture-overview)
- [Key Algorithms & Design Decisions](#key-algorithms--design-decisions)
  - [1. Linked List Playlist Model](#1-linked-list-playlist-model)
  - [2. Chunked MD5 Duplicate Detection](#2-chunked-md5-duplicate-detection)
  - [3. Offline Synthesis Rendering](#3-offline-synthesis-rendering)
  - [4. Web Audio API Equalizer](#4-web-audio-api-equalizer)
  - [5. Safe SQLite Migrations](#5-safe-sqlite-migrations)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Deployment (Docker)](#deployment-docker)
- [Features](#features)
- [Contributing](#contributing)

---

## Why LUMIFY?

Most media players are either heavy desktop apps or streaming-frontend clones. LUMIFY fills a different niche:

- **Ambient-first design** — ships with a built-in procedural audio synthesizer that generates playable, seekable ambient tracks from a compact node-chain definition.
- **Privacy-respecting** — local files stay local. YouTube/Spotify imports are stored as lightweight references; you can optionally download them to your server.
- **Zero frontend build step** — the UI is vanilla JS + CSS, served directly by Flask. No Webpack, no npm install, no transpilation.
- **Compact state model** — the playlist, queue, and playback state are all serializable and recoverable without a complex Redux/Vuex layer.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    Browser (Client)                  │
│  ┌──────────────┐  ┌─────────────────────────────┐  │
│  │  app.js      │  │  style.css                  │  │
│  │  - Player    │  │  - CSS variables / themes    │  │
│  │  - Queue     │  │  - Responsive layout         │  │
│  │  - EQ        │  │                             │  │
│  │  - Mini UI   │  │                             │  │
│  └──────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
                         │  HTTP / JSON
                         ▼
┌─────────────────────────────────────────────────────┐
│                  Flask (Server)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │  Blueprints  │  │  Services    │  │  Models   │ │
│  │  (routes)    │→ │  (logic)     │→ │  (Song)   │ │
│  └──────────────┘  └──────────────┘  └───────────┘ │
│                         │                           │
│                  ┌──────────────┐                   │
│                  │  SQLite      │                   │
│                  │  (media.db)  │                   │
│                  └──────────────┘                   │
└─────────────────────────────────────────────────────┘
```

The backend follows a **Controller → Service → Model** pattern:
- **Routes / Blueprints** handle HTTP concerns (request parsing, response codes).
- **Controllers** are thin orchestration layers that call into services.
- **Services** contain the business logic (importing, ordering, metadata extraction).
- **Models** are lightweight data wrappers around SQLite rows.

The frontend is a single-page experience bootstrapped by Jinja templates. State lives in a global `state` object in `app.js`; the queue is persisted to `localStorage`, and the current song is recovered on reload.

---

## Key Algorithms & Design Decisions

### 1. Linked List Playlist Model

**Where:** `app/database/schema.sql`, `app/services/song_service.py` (`_traverse`, `_tail_id`, `reorder`, `remove_song`)

Instead of storing playlist order in a separate `position` column, LUMIFY uses a **singly-linked list** inside the `songs` table:

```sql
CREATE TABLE songs (
    ...
    next_id INTEGER REFERENCES songs(id) ON DELETE SET NULL
);
```

A `settings` row holds `head_id`, the entry point to the chain.

**Why a linked list?**

| Consideration | Linked List (`next_id`) | Array / Position Column |
|---|---|---|
| **Appending** | O(1) — just update the tail's `next_id` | O(n) — must shift positions |
| **Removal** | O(n) traversal, but pointer fixup is trivial | O(n) scan + renumber |
| **Ordering semantics** | Matches the "node chain" metaphor of the synth engine | More conventional, but less interesting |
| **Rebuilding order** | `UPDATE songs SET next_id = NULL` + re-link | `UPDATE songs SET position = ?` |
| **Schema simplicity** | No extra junction table needed for the *default* order | Requires a separate `playlist_songs` table |

The default playlist is conceptually a single chain. Because we already needed `next_id` for the synth engine's visual "node chain" metaphor, extending it to drive playback order was a natural fit.

**Traversal algorithm** (`_traverse`):
```python
def _traverse(head):
    out = []
    seen = set()
    cur = head
    while cur is not None and cur not in seen:
        seen.add(cur)
        row = conn.execute("SELECT * FROM songs WHERE id = ?", (cur,)).fetchone()
        if not row:
            break
        out.append(row)
        cur = row["next_id"]
    return out
```

The `seen` set guards against cycles if the linked list becomes corrupted.

**Rebuilding order** (`reorder`):
```python
def reorder(order_ids):
    cur.execute("UPDATE songs SET next_id = NULL")
    valid_ids = [sid for sid in order_ids if exists(sid)]
    for i in range(len(valid_ids) - 1):
        cur.execute("UPDATE songs SET next_id = ? WHERE id = ?",
                    (valid_ids[i + 1], valid_ids[i]))
    set_head(conn, valid_ids[0])
```

This is an **O(n)** operation that atomically clears and rewires the chain.

### 2. Chunked MD5 Duplicate Detection

**Where:** `app/services/song_service.py` (`_file_hash`, `_find_by_hash`)

When a user imports a file, LUMIFY needs to detect duplicates without reading the entire file into memory twice.

```python
def _file_hash(path, chunk_size=1024 * 1024):
    h = hashlib.md5()
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        h.update(f.read(chunk_size))           # First 1 MB
        if size > chunk_size * 2:
            f.seek(-chunk_size, 2)
            h.update(f.read(chunk_size))       # Last 1 MB
    return h.hexdigest()
```

**Why chunked MD5?**

- **Speed** — reading 2 MB instead of 500 MB+ for a full album.
- **Collision resistance** — two files sharing the same head and tail is extremely unlikely unless they are byte-for-byte identical. If you want stronger guarantees, swap `md5` for `blake2b` or `sha256`; the chunking strategy is identical.
- **No external dependencies** — `hashlib` is in the standard library.

### 3. Offline Synthesis Rendering

**Where:** `app/static/js/app.js` (`renderSynth`)

LUMIFY's synth tracks are defined by a `base` frequency and a `pattern` array of semitone offsets. To make them seekable and pausable like normal audio files, they are **pre-rendered into an `AudioBuffer`** using `OfflineAudioContext`:

```javascript
async function renderSynth(song) {
    const sr = 44100;
    const dur = Math.max(4, song.duration || 30);
    const off = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);
    // Schedule oscillators, gain envelopes, filters...
    const buf = await off.startRendering();
    bufferCache[song.id] = buf;
    return buf;
}
```

**Why OfflineAudioContext?**

- **Seekability** — an `AudioBuffer` has a known duration and can be sliced at any offset. A live oscillator graph cannot.
- **Pause/resume** — the buffer plays through an `AudioBufferSourceNode`; pausing just stops the node and records the offset.
- **Determinism** — the same seed (`base` + `pattern`) always produces the same buffer, so caching is safe.
- **No audio glitches** — offline rendering happens before playback, avoiding the dropouts common with live oscillator graphs under load.

### 4. Web Audio API Equalizer

**Where:** `app/static/js/app.js` (`applyEQ`, `ensureAudio`)

The EQ is a chain of three `BiquadFilterNode`s in series:

| Band | Filter Type | Frequency | Purpose |
|---|---|---|---|
| Bass | `lowshelf` | 200 Hz | Warmth / sub boost |
| Mid | `peaking` | 1 kHz | Vocal / instrument clarity |
| Treble | `highshelf` | 3.5 kHz | Air / sparkle |

Filters are inserted into the audio graph between the source and the `AnalyserNode`, so visualization and EQ share the same processed signal.

### 5. Safe SQLite Migrations

**Where:** `app/database/database.py` (`_migrate_columns`, `init_db`)

LUMIFY uses SQLite, which does not support `ALTER TABLE ... DROP COLUMN`. Adding columns requires care:

```python
def _migrate_columns(conn):
    columns = [
        ("source_type", "TEXT DEFAULT 'LOCAL'"),
        ("media_type", "TEXT DEFAULT 'MUSIC'"),
        ...
    ]
    for col, definition in columns:
        try:
            conn.execute(f"ALTER TABLE songs ADD COLUMN {col} {definition}")
        except sqlite3.OperationalError:
            pass
```

**Why this approach?**

- **Non-destructive** — existing rows are never deleted or rewritten. New columns simply appear with defaults.
- **Idempotent** — re-running the migration on a newer DB silently skips columns that already exist.
- **No migration framework** — for a single-developer project, a hand-rolled migration function is simpler than Alembic/Flyway, and the schema is small enough that schema diffing is trivial.

---

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Backend** | Flask 3.x | Lightweight, perfect for a single-app media server. Blueprints keep routes organized without over-engineering. |
| **Database** | SQLite | Zero-config, file-based, ideal for personal/media-server workloads. Migrations are trivial. |
| **Audio Analysis** | Mutagen 1.47 | Pure Python ID3/MP4 tag reader. No external binaries. |
| **Link Import** | yt-dlp | Actively maintained fork of youtube-dl. Supports YouTube, Spotify, and hundreds of other sites. |
| **Frontend** | Vanilla JS + CSS | No build step, no npm install, no transpilation. CSS variables enable runtime theming. |
| **Audio Engine** | Web Audio API | Native browser API for synthesis, EQ, and analysis. No plugins, no WebAssembly. |
| **Visualization** | Canvas 2D | The analyzer draws directly to a `<canvas>` using frequency bin data. No charting library needed. |

---

## Project Structure

```
media_player/
├── run.py                    # Entry point
├── requirements.txt          # Python dependencies
├── Dockerfile                # Container build
├── docker-compose.yml        # Orchestration
├── .gitignore
├── .dockerignore
├── README.md
└── app/
    ├── __init__.py           # Flask app factory
    ├── models/
    │   └── song.py           # Song data model (row → dict)
    ├── services/
    │   ├── song_service.py   # Core logic: import, order, linked list, metadata
    │   ├── playlist_service.py # Saved playlists (CRUD)
    │   ├── source_service.py  # YouTube/Spotify URL parsing & metadata
    │   ├── file_browser.py    # Local directory scanning
    │   └── youtube_downloader.py  # yt-dlp wrapper
    ├── controllers/
    │   └── song_controller.py  # Route-to-service glue
    ├── database/
    │   ├── database.py         # Connection, migrations, init_db
    │   └── schema.sql          # DDL
    ├── routes/
    │   ├── api_routes.py       # JSON API
    │   ├── player_routes.py    # Player page
    │   ├── library_routes.py   # Library page
    │   ├── dashboard_routes.py # Home page
    │   ├── playlist_routes.py  # Playlists page
    │   ├── artist_routes.py    # Artist pages
    │   ├── album_routes.py     # Album pages
    │   ├── browse_routes.py    # Browse page
    │   └── visualizer_routes.py # Audio visualizer page
    └── templates/
        ├── base.html           # Layout shell (sidebar, mini-player, theme modal)
        ├── player/index.html
        ├── library/index.html
        ├── playlists/index.html
        ├── artists/index.html
        ├── albums/index.html
        └── visualizer/index.html
    └── static/
        ├── css/style.css       # Global styles, theme tokens
        ├── js/app.js           # Core frontend: player, queue, EQ, synth, theme
        ├── icons/              # Favicon, UI icons
        └── media/              # User-uploaded songs & artwork (gitignored)
```

---

## Getting Started

### Prerequisites

- Python 3.10+
- (Optional) `ffmpeg` if you plan to use YouTube download or video transcoding

### Installation

```bash
# Clone the repo
git clone https://github.com/<your-username>/lumify.git
cd lumify

# Create and activate virtual environment
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run
python run.py
```

Open `http://127.0.0.1:5000` in your browser.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `FLASK_DEBUG` | `0` | Set to `1` to enable Flask debug mode |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `5000` | Port number |

---

## Deployment (Docker)

```bash
docker compose up --build
```

The compose file mounts two host directories as volumes:
1. `./media_player.db` — persistent SQLite database.
2. `./app/static/media` — user-uploaded songs and artwork.

This means your media survives container restarts and rebuilds.

---

## Features

- **Playback:** Play, pause, next, previous, shuffle, repeat (off / all / one), seek, volume.
- **Queue:** Drag-and-drop reorder, play next, remove, clear, save as playlist.
- **Library:** Import local files, YouTube links, Spotify links. Auto-extract metadata and artwork.
- **Playlists:** Create, rename, delete, reorder, add/remove songs. Persisted in SQLite.
- **Visualizer:** Real-time frequency visualization on a canvas.
- **Equalizer:** 3-band Web Audio API EQ (bass, mid, treble).
- **Synthesizer:** Built-in ambient audio engine with 8 default tracks. Each track is a procedural `AudioBuffer` rendered from a base frequency and semitone pattern.
- **Theming:** Runtime accent color, dark/light mode, compact player, artwork size. Persisted in `localStorage`.
- **Mini Player:** Global bottom-left player that persists across page navigation.

---

## Contributing

1. Fork the repo and create a feature branch.
2. Keep the backend thin — logic belongs in `services/`.
3. Do not introduce a frontend build pipeline. If you need a new component, add it to `app.js` and `style.css`.
4. Run `python run.py` and verify the player, queue, and visualizer pages before submitting.

---

## License

MIT
