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
    }

    meta = {}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if not info:
            raise ValueError("no_info")

    actual = None
    for candidate in os.listdir(MEDIA_FOLDER):
        if candidate.startswith(safe_name + "."):
            actual = os.path.join(MEDIA_FOLDER, candidate)
            break
    if not actual:
        raise ValueError("file_missing")

    ext = os.path.splitext(actual)[1].lower().lstrip(".") or "mp3"
    meta = {
        "title": info.get("title"),
        "artist": info.get("artist") or info.get("uploader"),
        "album": info.get("album"),
        "thumbnail_url": info.get("thumbnail"),
        "duration": info.get("duration"),
        "ext": ext,
        "file_path": actual,
        "video_id": info.get("id"),
    }
    return meta


def search_youtube(query, max_results=10):
    """Search YouTube and return a list of lightweight result dicts.

    Each dict contains: title, video_id, thumbnail, duration, uploader, url
    """
    search_term = f"ytsearch{max_results}:{query}"
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
    }
    results = []
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(search_term, download=False)
        if not info or "entries" not in info:
            return results
        for entry in info["entries"]:
            video_id = entry.get("id")
            title = entry.get("title")
            if not video_id or not title:
                continue
            thumbnail = entry.get("thumbnail") or f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg"
            results.append({
                "title": title,
                "video_id": video_id,
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "thumbnail": thumbnail,
                "duration": entry.get("duration"),
                "uploader": entry.get("uploader") or entry.get("channel"),
            })
    return results
