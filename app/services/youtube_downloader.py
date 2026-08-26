import os
import re
import uuid

import yt_dlp

from app.services import source_service

MEDIA_FOLDER = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "static", "media")
)

YOUTUBE_ID_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|v/)|youtu\.be/)"
    r"([A-Za-z0-9_-]{11})"
)


def parse_video_id(url):
    m = YOUTUBE_ID_RE.search(url)
    return m.group(1) if m else None


def download_audio(url):
    """Download best audio from a YouTube URL into MEDIA_FOLDER.

    Returns dict with keys: file_path, title, artist, thumbnail_url, duration, ext
    """
    os.makedirs(MEDIA_FOLDER, exist_ok=True)
    safe_name = f"{uuid.uuid4().hex}"
    out_tmpl = os.path.join(MEDIA_FOLDER, f"{safe_name}.%(ext)s")

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": out_tmpl,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "extract_flat": False,
    }

    meta = {}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if not info:
            raise ValueError("no_info")
        ext = info.get("ext") or "webm"
        file_path = os.path.join(MEDIA_FOLDER, f"{safe_name}.{ext}")
        meta = {
            "title": info.get("title"),
            "artist": info.get("artist") or info.get("uploader"),
            "album": info.get("album"),
            "thumbnail_url": info.get("thumbnail"),
            "duration": info.get("duration"),
            "ext": ext,
            "file_path": file_path,
            "video_id": info.get("id"),
        }

    if not os.path.exists(meta["file_path"]):
        raise ValueError("file_missing")

    return meta
