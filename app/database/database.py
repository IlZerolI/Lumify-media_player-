import json
import os
import sqlite3

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "media_player.db")
DB_PATH = os.path.abspath(DB_PATH)

HEAD_KEY = "head_id"

DEFAULT_SONGS = [
    {"name": "Whispering Static", "base": 110, "pattern": [0, 3, 7, 10, 12], "duration": 32},
    {"name": "Hollow Pulse",      "base": 98,  "pattern": [0, 5, 7, 12, 7],  "duration": 36},
    {"name": "Drowned Cathedral", "base": 82,  "pattern": [0, 7, 12, 15, 19], "duration": 40},
    {"name": "Glass Rain",        "base": 130, "pattern": [0, 2, 4, 7, 11],  "duration": 28},
    {"name": "Last Signal",       "base": 73,  "pattern": [0, 4, 9, 12, 16], "duration": 44},
    {"name": "Ember Waltz",       "base": 146, "pattern": [0, 2, 4, 7, 9],   "duration": 34},
    {"name": "Tidal Choir",       "base": 65,  "pattern": [0, 5, 7, 10, 14], "duration": 38},
    {"name": "Frost Meridian",    "base": 185, "pattern": [0, 3, 6, 10, 14], "duration": 30},
]


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def get_head(conn):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (HEAD_KEY,)).fetchone()
    return int(row["value"]) if row and row["value"] is not None else None


def set_head(conn, song_id):
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        (HEAD_KEY, str(song_id)),
    )


def _migrate_columns(conn):
    """Safely add unified-media and feature columns without destroying existing data."""
    columns = [
        ("source_type", "TEXT DEFAULT 'LOCAL'"),
        ("media_type", "TEXT DEFAULT 'MUSIC'"),
        ("source_url", "TEXT"),
        ("source_id", "TEXT"),
        ("thumbnail_url", "TEXT"),
        ("artist", "TEXT"),
        ("album", "TEXT"),
        ("genre", "TEXT"),
        ("updated_at", "TEXT"),
        ("is_favorite", "INTEGER DEFAULT 0"),
        ("play_count", "INTEGER DEFAULT 0"),
        ("last_played", "TEXT"),
        ("album_artist", "TEXT"),
        ("year", "INTEGER"),
        ("track_number", "INTEGER"),
        ("artwork_path", "TEXT"),
        ("file_hash", "TEXT"),
    ]
    for col, definition in columns:
        try:
            conn.execute(f"ALTER TABLE songs ADD COLUMN {col} {definition}")
        except sqlite3.OperationalError:
            pass

    # Backfill: existing rows are local media.
    conn.execute(
        "UPDATE songs SET source_type = 'LOCAL' WHERE source_type IS NULL OR source_type = ''"
    )
    video_exts = {".mp4", ".webm", ".mkv", ".mov", ".avi"}
    for row in conn.execute("SELECT id, type, file_path FROM songs WHERE type = 'file'").fetchall():
        ext = os.path.splitext(row["file_path"] or "")[1].lower()
        media_type = "VIDEO" if ext in video_exts else "MUSIC"
        conn.execute("UPDATE songs SET media_type = ? WHERE id = ?", (media_type, row["id"]))
    # synth nodes are always music
    conn.execute("UPDATE songs SET media_type = 'MUSIC' WHERE type = 'synth' AND (media_type IS NULL OR media_type = '')")


def init_db():
    conn = get_connection()
    schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
    with open(schema_path, "r", encoding="utf-8") as f:
        conn.executescript(f.read())

    # migrate: add `size` column if an older DB is present
    try:
        conn.execute("ALTER TABLE songs ADD COLUMN size REAL")
    except sqlite3.OperationalError:
        pass

    _migrate_columns(conn)

    cur = conn.cursor()
    count = cur.execute("SELECT COUNT(*) AS c FROM songs").fetchone()["c"]
    if count == 0:
        ids = []
        for s in DEFAULT_SONGS:
            cur.execute(
                "INSERT INTO songs (name, type, base, pattern, duration) "
                "VALUES (?, 'synth', ?, ?, ?)",
                (s["name"], s["base"], json.dumps(s["pattern"]), s["duration"]),
            )
            ids.append(cur.lastrowid)
        # link the nodes into a chain and set the head
        for i in range(len(ids) - 1):
            cur.execute("UPDATE songs SET next_id = ? WHERE id = ?", (ids[i + 1], ids[i]))
        set_head(conn, ids[0])
    conn.commit()
    conn.close()
