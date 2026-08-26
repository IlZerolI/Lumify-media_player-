import json
import os
from datetime import datetime

from app.database.database import get_connection, DB_PATH


def _now():
    return datetime.utcnow().isoformat()


def list_playlists():
    conn = get_connection()
    rows = conn.execute("SELECT id, name, description, created_at, updated_at FROM playlists ORDER BY updated_at DESC").fetchall()
    conn.close()
    return [dict(row) for row in rows]


def get_playlist(playlist_id):
    conn = get_connection()
    row = conn.execute("SELECT id, name, description, created_at, updated_at FROM playlists WHERE id = ?", (playlist_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_playlist_songs(playlist_id):
    conn = get_connection()
    rows = conn.execute(
        "SELECT ps.position, s.id, s.name, s.type, s.file_path, s.duration, s.size, s.source_type, s.media_type, s.artist, s.album, s.artwork_path "
        "FROM playlist_songs ps "
        "JOIN songs s ON s.id = ps.song_id "
        "WHERE ps.playlist_id = ? "
        "ORDER BY ps.position ASC",
        (playlist_id,)
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def create_playlist(name, song_ids=None, description=None):
    if not name:
        return None
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("INSERT INTO playlists (name, description, updated_at) VALUES (?, ?, ?)", (name, description or "", _now()))
    playlist_id = cur.lastrowid
    if song_ids:
        for idx, song_id in enumerate(song_ids):
            cur.execute("INSERT INTO playlist_songs (playlist_id, song_id, position, created_at) VALUES (?, ?, ?, ?)", (playlist_id, song_id, idx, _now()))
    conn.commit()
    conn.close()
    return playlist_id


def update_playlist(playlist_id, name=None, description=None):
    if not playlist_id:
        return False
    conn = get_connection()
    cur = conn.cursor()
    if name is not None:
        cur.execute("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?", (name, _now(), playlist_id))
    if description is not None:
        cur.execute("UPDATE playlists SET description = ?, updated_at = ? WHERE id = ?", (description, _now(), playlist_id))
    conn.commit()
    conn.close()
    return True


def delete_playlist(playlist_id):
    if not playlist_id:
        return False
    conn = get_connection()
    conn.execute("DELETE FROM playlist_songs WHERE playlist_id = ?", (playlist_id,))
    conn.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
    conn.commit()
    conn.close()
    return True


def add_songs_to_playlist(playlist_id, song_ids):
    if not playlist_id or not song_ids:
        return False
    conn = get_connection()
    cur = conn.cursor()
    max_pos = cur.execute("SELECT MAX(position) FROM playlist_songs WHERE playlist_id = ?", (playlist_id,)).fetchone()[0] or -1
    for idx, song_id in enumerate(song_ids):
        cur.execute("INSERT INTO playlist_songs (playlist_id, song_id, position, created_at) VALUES (?, ?, ?, ?)", (playlist_id, song_id, max_pos + 1 + idx, _now()))
    cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (_now(), playlist_id))
    conn.commit()
    conn.close()
    return True


def remove_song_from_playlist(playlist_id, song_id):
    if not playlist_id or not song_id:
        return False
    conn = get_connection()
    conn.execute("DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?", (playlist_id, song_id))
    conn.commit()
    conn.close()
    return True


def reorder_playlist(playlist_id, song_ids):
    if not playlist_id:
        return False
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM playlist_songs WHERE playlist_id = ?", (playlist_id,))
    for idx, song_id in enumerate(song_ids):
        cur.execute("INSERT INTO playlist_songs (playlist_id, song_id, position, created_at) VALUES (?, ?, ?, ?)", (playlist_id, song_id, idx, _now()))
    cur.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", (_now(), playlist_id))
    conn.commit()
    conn.close()
    return True
