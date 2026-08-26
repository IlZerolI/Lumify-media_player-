CREATE TABLE IF NOT EXISTS songs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL DEFAULT 'synth',   -- 'synth' | 'file' | 'youtube' | 'spotify'
    file_path     TEXT,                             -- relative path inside static/media for type='file'
    base          REAL,                             -- synth base frequency (Hz)
    pattern       TEXT,                             -- synth pattern, JSON array of semitone offsets
    duration      REAL,                             -- length in seconds
    size          REAL,                             -- file size in bytes (imported tracks)
    next_id       INTEGER,                          -- linked-list pointer to the next node
    source_type   TEXT DEFAULT 'LOCAL',             -- 'LOCAL' | 'YOUTUBE' | 'SPOTIFY'
    media_type    TEXT DEFAULT 'MUSIC',             -- 'MUSIC' | 'VIDEO'
    source_url    TEXT,                             -- original external URL (YouTube/Spotify)
    source_id     TEXT,                             -- provider resource id (video id / track id)
    thumbnail_url TEXT,                             -- remote thumbnail/cover art
    artist        TEXT,
    album         TEXT,
    genre         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT,
    FOREIGN KEY (next_id) REFERENCES songs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlist_songs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    song_id     INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_songs_next ON songs(next_id);
CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist ON playlist_songs(playlist_id, position);
