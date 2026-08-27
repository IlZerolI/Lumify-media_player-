import hashlib
import json
import os
import shutil
import uuid

from app.database.database import get_connection, get_head, set_head
from app.models.song import Song
from app.services import source_service

MEDIA_FOLDER = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "static", "media")
)
ARTWORK_FOLDER = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "static", "media", "artworks")
)

VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".mov", ".avi"}
AUDIO_EXTS = {".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".opus", ".wma", ".webm"}
ALLOWED_EXTENSIONS = AUDIO_EXTS | VIDEO_EXTS


def _file_hash(path, chunk_size=1024 * 1024):
    """Return MD5 hash for duplicate detection. Reads first + last chunks for speed."""
    h = hashlib.md5()
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            h.update(f.read(chunk_size))
            if size > chunk_size * 2:
                f.seek(-chunk_size, 2)
                h.update(f.read(chunk_size))
        return h.hexdigest()
    except Exception:
        return None


def _clean_title(text):
    """Make a filename-like string into a readable title."""
    text = os.path.splitext(text)[0]
    text = text.replace("-", " ").replace("_", " ")
    text = " ".join(text.split())
    return text.strip() or "Unknown Title"


def _traverse(head):
    """Walk the linked list starting at `head`, returning song rows in order."""
    out = []
    seen = set()
    cur = head
    conn = get_connection()
    try:
        while cur is not None and cur not in seen:
            seen.add(cur)
            row = conn.execute("SELECT * FROM songs WHERE id = ?", (cur,)).fetchone()
            if not row:
                break
            out.append(row)
            cur = row["next_id"]
    finally:
        conn.close()
    return out


def list_songs():
    conn = get_connection()
    try:
        head = get_head(conn)
        if head is None:
            row = conn.execute("SELECT id FROM songs ORDER BY id LIMIT 1").fetchone()
            if row:
                head = row["id"]
                set_head(conn, head)
                conn.commit()
    finally:
        conn.close()
    return [Song(r) for r in _traverse(head)]


def get_song(song_id):
    conn = get_connection()
    row = conn.execute("SELECT * FROM songs WHERE id = ?", (song_id,)).fetchone()
    conn.close()
    return Song(row) if row else None


def _tail_id(conn, head):
    cur = head
    seen = set()
    last = head
    while cur is not None and cur not in seen:
        seen.add(cur)
        last = cur
        row = conn.execute("SELECT next_id FROM songs WHERE id = ?", (cur,)).fetchone()
        cur = row["next_id"] if row else None
    return last


def _probe_duration(path):
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(path)
        if audio is not None and audio.info is not None:
            return round(float(audio.info.length), 1)
    except Exception:
        pass
    return None


def _extract_metadata(file_path):
    """Best-effort metadata extraction from a local media file."""
    meta = {
        "artist": None,
        "album": None,
        "album_artist": None,
        "genre": None,
        "year": None,
        "track_number": None,
        "artwork_path": None,
    }
    try:
        from mutagen import File as MutagenFile
        from mutagen.id3 import ID3
        audio = MutagenFile(file_path)
        if audio is None:
            return meta
        tags = audio.tags or {}
        try:
            id3 = ID3(file_path)
            for key in ["TPE1", "TPE2", "TALB", "TIT1", "TCON", "TYER", "TRCK"]:
                frame = id3.get(key)
                if frame:
                    meta[key] = str(frame)
        except Exception:
            pass
        if hasattr(tags, "get"):
            artist = tags.get("artist") or tags.get("TPE1")
            if artist:
                meta["artist"] = str(artist[0]) if isinstance(artist, list) else str(artist)
            album = tags.get("album") or tags.get("TALB")
            if album:
                meta["album"] = str(album[0]) if isinstance(album, list) else str(album)
            album_artist = tags.get("albumartist") or tags.get("TPE2")
            if album_artist:
                meta["album_artist"] = str(album_artist[0]) if isinstance(album_artist, list) else str(album_artist)
            genre = tags.get("genre") or tags.get("TCON")
            if genre:
                meta["genre"] = str(genre[0]) if isinstance(genre, list) else str(genre)
            year = tags.get("date") or tags.get("TYER")
            if year:
                try:
                    meta["year"] = int(str(year[0])[:4]) if isinstance(year, list) else int(str(year)[:4])
                except (ValueError, TypeError):
                    pass
            track = tags.get("tracknumber") or tags.get("TRCK")
            if track:
                try:
                    meta["track_number"] = int(str(track[0]).split("/")[0]) if isinstance(track, list) else int(str(track).split("/")[0])
                except (ValueError, TypeError):
                    pass
    except Exception:
        pass
    try:
        artwork_name = _save_artwork(file_path)
        if artwork_name:
            meta["artwork_path"] = artwork_name
    except Exception:
        pass
    return meta


def _save_artwork(file_path):
    """Extract embedded artwork if present and save to artwork folder."""
    try:
        from mutagen import File as MutagenFile
        from mutagen.id3 import ID3
        audio = MutagenFile(file_path)
        if audio is None:
            return None
        artwork_data = None
        try:
            id3 = ID3(file_path)
            for frame in id3.values():
                if frame.FrameID == "APIC":
                    artwork_data = frame.data
                    break
        except Exception:
            pass
        if artwork_data is None and hasattr(audio, "pictures") and audio.pictures:
            artwork_data = audio.pictures[0].data
        if artwork_data is None:
            return None
        os.makedirs(ARTWORK_FOLDER, exist_ok=True)
        ext = "jpg"
        if artwork_data[:4] == b"\x89PNG":
            ext = "png"
        elif artwork_data[:3] == b"GIF":
            ext = "gif"
        artwork_name = f"{uuid.uuid4().hex}.{ext}"
        with open(os.path.join(ARTWORK_FOLDER, artwork_name), "wb") as f:
            f.write(artwork_data)
        return artwork_name
    except Exception:
        return None


def add_file_song(file_storage, name=None):
    os.makedirs(MEDIA_FOLDER, exist_ok=True)
    original = file_storage.filename or "track.mp3"
    ext = os.path.splitext(original)[1]
    if ext.lower() not in ALLOWED_EXTENSIONS:
        raise ValueError("unsupported")
    safe_name = f"{uuid.uuid4().hex}{ext}"
    dest = os.path.join(MEDIA_FOLDER, safe_name)
    file_storage.save(dest)
    duration = _probe_duration(dest)
    size = os.path.getsize(dest)
    display = name or _clean_title(os.path.basename(original))
    file_hash = _file_hash(dest)
    if file_hash:
        existing = _find_by_hash(file_hash)
        if existing:
            try:
                os.remove(dest)
            except OSError:
                pass
            return {"error": "duplicate", "id": existing["id"]}
    meta = _extract_metadata(dest)
    return _create_file_song(display, safe_name, duration, size, meta, file_hash=file_hash)


def add_file_from_path(abs_path, display=None):
    if not os.path.isfile(abs_path):
        raise ValueError("missing")
    ext = os.path.splitext(abs_path)[1]
    if ext.lower() not in ALLOWED_EXTENSIONS:
        raise ValueError("unsupported")
    safe_name = f"{uuid.uuid4().hex}{ext}"
    dest = os.path.join(MEDIA_FOLDER, safe_name)
    shutil.copy2(abs_path, dest)
    duration = _probe_duration(dest)
    size = os.path.getsize(dest)
    display = display or _clean_title(os.path.basename(abs_path))
    file_hash = _file_hash(dest)
    if file_hash:
        existing = _find_by_hash(file_hash)
        if existing:
            try:
                os.remove(dest)
            except OSError:
                pass
            return {"error": "duplicate", "id": existing["id"]}
    meta = _extract_metadata(dest)
    return _create_file_song(display, safe_name, duration, size, meta, file_hash=file_hash)


def _find_by_hash(file_hash):
    if not file_hash:
        return None
    conn = get_connection()
    row = conn.execute("SELECT id FROM songs WHERE file_hash = ?", (file_hash,)).fetchone()
    conn.close()
    return dict(row) if row else None


def _create_file_song(display, safe_name, duration, size, meta=None, file_hash=None):
    meta = meta or {}
    ext = os.path.splitext(safe_name)[1].lower()
    media_type = "VIDEO" if ext in VIDEO_EXTS else "MUSIC"
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO songs "
        "(name, type, file_path, duration, size, source_type, media_type, "
        "artist, album, album_artist, genre, year, track_number, artwork_path, file_hash) "
        "VALUES (?, 'file', ?, ?, ?, 'LOCAL', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            display,
            safe_name,
            duration,
            size,
            media_type,
            meta.get("artist"),
            meta.get("album"),
            meta.get("album_artist"),
            meta.get("genre"),
            meta.get("year"),
            meta.get("track_number"),
            meta.get("artwork_path"),
            file_hash,
        ),
    )
    new_id = cur.lastrowid
    head = get_head(conn)
    if head is None:
        set_head(conn, new_id)
    else:
        tail = _tail_id(conn, head)
        conn.execute("UPDATE songs SET next_id = ? WHERE id = ?", (new_id, tail))
    conn.commit()
    conn.close()
    return new_id


def remove_song(song_id):
    song = get_song(song_id)
    if not song:
        return False
    if song.type == "file" and song.file_path:
        try:
            os.remove(os.path.join(MEDIA_FOLDER, os.path.basename(song.file_path)))
        except OSError:
            pass
    if song.artwork_path:
        try:
            os.remove(os.path.join(ARTWORK_FOLDER, os.path.basename(song.artwork_path)))
        except OSError:
            pass

    conn = get_connection()
    cur = conn.cursor()
    head = get_head(conn)

    # find predecessor of the node to remove
    prev = None
    node = head
    seen = set()
    while node is not None and node != song_id and node not in seen:
        seen.add(node)
        prev = node
        row = cur.execute("SELECT next_id FROM songs WHERE id = ?", (node,)).fetchone()
        node = row["next_id"] if row else None

    if node == song_id:
        row = cur.execute("SELECT next_id FROM songs WHERE id = ?", (song_id,)).fetchone()
        nxt = row["next_id"] if row else None
        if prev is None:
            set_head(conn, nxt)            # removed the head -> promote successor
        else:
            cur.execute("UPDATE songs SET next_id = ? WHERE id = ?", (nxt, prev))
        cur.execute("DELETE FROM songs WHERE id = ?", (song_id,))
        conn.commit()
    else:
        conn.close()
        return False
    conn.close()
    return True


def reorder(order_ids):
    """Rebuild the linked list from an explicit ordered list of song ids."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("UPDATE songs SET next_id = NULL")
    valid_ids = []
    for sid in order_ids:
        row = cur.execute("SELECT id FROM songs WHERE id = ?", (sid,)).fetchone()
        if row:
            valid_ids.append(sid)
    for i in range(len(valid_ids) - 1):
        cur.execute(
            "UPDATE songs SET next_id = ? WHERE id = ?",
            (valid_ids[i + 1], valid_ids[i]),
        )
    if valid_ids:
        set_head(conn, valid_ids[0])
    conn.commit()
    conn.close()


def rename_song(song_id, name):
    name = (name or "").strip()
    if not name:
        return False
    conn = get_connection()
    res = conn.execute("UPDATE songs SET name = ? WHERE id = ?", (name[:120], song_id))
    conn.commit()
    ok = res.rowcount > 0
    conn.close()
    return ok


def _append_to_chain(conn, cur, new_id):
    head = get_head(conn)
    if head is None:
        set_head(conn, new_id)
    else:
        tail = _tail_id(conn, head)
        conn.execute("UPDATE songs SET next_id = ? WHERE id = ?", (new_id, tail))
    conn.commit()


def add_external(source_type, url, source_id, media_type, meta, resource_type=None):
    """Create a record for a YouTube/Spotify item. Returns a dict with id or error."""
    conn = get_connection()
    cur = conn.cursor()
    if source_id:
        row = cur.execute(
            "SELECT id FROM songs WHERE source_type = ? AND source_id = ?",
            (source_type, source_id),
        ).fetchone()
        if row:
            conn.close()
            return {"error": "duplicate", "id": row["id"]}
    name = (meta.get("title") or source_id or url)[:120]
    artist = (meta.get("artist") or "")[:120]
    thumbnail = meta.get("thumbnail_url")
    record_type = resource_type or source_type.lower()
    cur.execute(
        "INSERT INTO songs "
        "(name, type, source_type, media_type, source_url, source_id, thumbnail_url, artist, duration) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (name, record_type, source_type, media_type, url, source_id, thumbnail, artist, None),
    )
    new_id = cur.lastrowid
    _append_to_chain(conn, cur, new_id)
    conn.close()
    return {"id": new_id}


def detect_and_import_link(url, force_local=False):
    """Validate, detect source, parse, fetch metadata and persist a link import."""
    url = (url or "").strip()
    if not url:
        return {"error": "empty_url"}
    src = source_service.detect_source(url)
    if src == "YOUTUBE":
        video_id = source_service.parse_youtube(url)
        if not video_id:
            return {"error": "invalid_youtube"}
        local = _try_youtube_local(url, video_id)
        if local is not None:
            return local
        meta = source_service.youtube_metadata(url)
        return add_external("YOUTUBE", url, video_id, meta.get("media_type", "VIDEO"), meta)
    return {"error": "unsupported"}


def _try_youtube_local(url, video_id):
    """Attempt to download YouTube audio and import as a local file.

    Returns the new song dict on success, None if download fails or should fall back.
    """
    try:
        from app.services.youtube_downloader import download_audio
    except Exception:
        return None

    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id FROM songs WHERE source_id = ?", (video_id,)
        ).fetchone()
        if row:
            return {"error": "duplicate", "id": row["id"]}
    finally:
        conn.close()

    try:
        info = download_audio(url)
    except Exception:
        return None

    file_path = info.get("file_path")
    if not file_path or not os.path.exists(file_path):
        return None

    file_hash = _file_hash(file_path)
    if file_hash:
        existing = _find_by_hash(file_hash)
        if existing:
            try:
                os.remove(file_path)
            except OSError:
                pass
            return {"error": "duplicate", "id": existing["id"]}

    ext = os.path.splitext(file_path)[1].lower()
    safe_name = os.path.basename(file_path)
    duration = info.get("duration") or _probe_duration(file_path)
    size = os.path.getsize(file_path)
    display = info.get("title") or _clean_title(safe_name)

    artwork_path = None
    thumbnail_url = info.get("thumbnail_url")
    if thumbnail_url:
        try:
            artwork_path = _save_thumbnail(thumbnail_url)
        except Exception:
            artwork_path = None

    meta = {
        "artist": info.get("artist"),
        "album": info.get("album"),
        "artwork_path": artwork_path,
    }
 
    media_type = "MUSIC"
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO songs "
        "(name, type, file_path, duration, size, source_type, media_type, "
        "source_url, source_id, thumbnail_url, artist, album, artwork_path, file_hash) "
         "VALUES (?, 'file', ?, ?, ?, 'LOCAL', ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            display,
            safe_name,
            duration,
            size,
            media_type,
            url,
            video_id,
            thumbnail_url,
            meta.get("artist"),
            meta.get("album"),
            artwork_path,
            file_hash,
        ),
    )
    new_id = cur.lastrowid
    head = get_head(conn)
    if head is None:
        set_head(conn, new_id)
    else:
        tail = _tail_id(conn, head)
        conn.execute("UPDATE songs SET next_id = ? WHERE id = ?", (new_id, tail))
    conn.commit()
    conn.close()
    return {"id": new_id, "local": True}


def _save_thumbnail(url):
    """Download thumbnail and save to artwork folder."""
    if not url:
        return None
    try:
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Lumify)"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
        os.makedirs(ARTWORK_FOLDER, exist_ok=True)
        ext = "jpg"
        if data[:4] == b"\x89PNG":
            ext = "png"
        elif data[:3] == b"GIF":
            ext = "gif"
        name = f"{uuid.uuid4().hex}.{ext}"
        with open(os.path.join(ARTWORK_FOLDER, name), "wb") as f:
            f.write(data)
        return name
    except Exception:
        return None


def toggle_favorite(song_id):
    conn = get_connection()
    row = conn.execute("SELECT is_favorite FROM songs WHERE id = ?", (song_id,)).fetchone()
    if not row:
        conn.close()
        return None
    new_val = 1 if not row["is_favorite"] else 0
    conn.execute("UPDATE songs SET is_favorite = ? WHERE id = ?", (new_val, song_id))
    conn.commit()
    conn.close()
    return new_val


def increment_play(song_id):
    conn = get_connection()
    conn.execute(
        "UPDATE songs SET play_count = COALESCE(play_count, 0) + 1, last_played = datetime('now') WHERE id = ?",
        (song_id,),
    )
    conn.commit()
    conn.close()


def get_favorites(limit=100):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM songs WHERE is_favorite = 1 ORDER BY updated_at DESC, id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [Song(r) for r in rows]


def get_recent(limit=20):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM songs WHERE last_played IS NOT NULL ORDER BY last_played DESC, id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [Song(r) for r in rows]


def get_most_played(limit=20):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM songs WHERE play_count > 0 ORDER BY play_count DESC, id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [Song(r) for r in rows]


def update_song(song_id, data):
    """Update metadata fields for a song. Only updates provided fields."""
    if not data:
        return False
    allowed = {
        "name", "artist", "album", "album_artist", "genre", "year", "track_number", "artwork_path",
        "thumbnail_url", "source_url", "source_id", "media_type", "source_type",
    }
    fields = []
    values = []
    for key, value in data.items():
        if key not in allowed:
            continue
        fields.append(f"{key} = ?")
        values.append(value)
    if not fields:
        return False
    values.append(song_id)
    conn = get_connection()
    conn.execute("UPDATE songs SET " + ", ".join(fields) + " WHERE id = ?", values)
    conn.commit()
    conn.close()
    return True


def get_artists(limit=100):
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT
            COALESCE(NULLIF(artist, ''), 'Unknown Artist') AS artist,
            COUNT(*) AS song_count,
            COUNT(DISTINCT album) AS album_count,
            SUM(play_count) AS total_plays
        FROM songs
        WHERE artist IS NOT NULL AND TRIM(artist) != ''
        GROUP BY artist
        ORDER BY total_plays DESC, song_count DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_albums(limit=100):
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT
            COALESCE(NULLIF(album, ''), 'Unknown Album') AS album,
            COALESCE(NULLIF(artist, ''), 'Unknown Artist') AS artist,
            COUNT(*) AS song_count,
            SUM(play_count) AS total_plays,
            MIN(year) AS year,
            MAX(artwork_path) AS artwork_path
        FROM songs
        WHERE album IS NOT NULL AND TRIM(album) != ''
        GROUP BY album, artist
        ORDER BY total_plays DESC, song_count DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_artist_songs(artist_name):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM songs WHERE artist = ? ORDER BY track_number IS NULL, track_number, id",
        (artist_name,),
    ).fetchall()
    conn.close()
    return [Song(r) for r in rows]


def get_album_songs(album_name, artist_name=None):
    conn = get_connection()
    if artist_name:
        rows = conn.execute(
            "SELECT * FROM songs WHERE album = ? AND artist = ? ORDER BY track_number IS NULL, track_number, id",
            (album_name, artist_name),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM songs WHERE album = ? ORDER BY track_number IS NULL, track_number, id",
            (album_name,),
        ).fetchall()
    conn.close()
    return [Song(r) for r in rows]
