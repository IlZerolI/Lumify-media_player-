import json
import re
import urllib.parse
import urllib.request

# ----------------------------------------------------------------------------
# Source detection & provider parsing.
# ----------------------------------------------------------------------------

YOUTUBE_ID_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|v/)|youtu\.be/)"
    r"([A-Za-z0-9_-]{11})"
)
URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def looks_like_url(text):
    return bool(text) and bool(URL_RE.match(text.strip()))


def detect_source(text):
    """Return 'LOCAL', 'YOUTUBE' or 'UNSUPPORTED_URL'."""
    if not text or not looks_like_url(text):
        return "LOCAL"
    t = text.lower()
    if "youtube.com" in t or "youtu.be" in t:
        return "YOUTUBE"
    return "UNSUPPORTED_URL"


def parse_youtube(url):
    m = YOUTUBE_ID_RE.search(url)
    return m.group(1) if m else None


def _oembed(endpoint):
    try:
        req = urllib.request.Request(
            endpoint, headers={"User-Agent": "Mozilla/5.0 (Lumify)"}
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def youtube_metadata(url):
    """Best-effort metadata from YouTube's public oEmbed endpoint."""
    quoted = urllib.parse.quote(url, safe="")
    data = _oembed("https://www.youtube.com/oembed?url=" + quoted + "&format=json")
    if not data:
        return {}
    return {
        "title": data.get("title"),
        "artist": data.get("author_name"),
        "thumbnail_url": data.get("thumbnail_url"),
        "media_type": "VIDEO",
    }
