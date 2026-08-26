import json
import re
import urllib.parse
import urllib.request

# ----------------------------------------------------------------------------
# Source detection & provider parsing.
#
# We never download or rip external media. For metadata we use the public
# oEmbed endpoints (YouTube + Spotify both expose one) which require no API
# key and only return title/author/thumbnail. The actual media stays with the
# original provider and is played via an official embed.
# ----------------------------------------------------------------------------

YOUTUBE_ID_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|v/)|youtu\.be/)"
    r"([A-Za-z0-9_-]{11})"
)
SPOTIFY_RE = re.compile(r"open\.spotify\.com/(track|album|playlist|artist|episode|show)/([A-Za-z0-9]+)")
URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def looks_like_url(text):
    return bool(text) and bool(URL_RE.match(text.strip()))


def detect_source(text):
    """Return 'LOCAL', 'YOUTUBE', 'SPOTIFY' or 'UNSUPPORTED_URL'."""
    if not text or not looks_like_url(text):
        return "LOCAL"
    t = text.lower()
    if "youtube.com" in t or "youtu.be" in t:
        return "YOUTUBE"
    if "spotify.com" in t or "spotify.link" in t:
        return "SPOTIFY"
    return "UNSUPPORTED_URL"


def parse_youtube(url):
    m = YOUTUBE_ID_RE.search(url)
    return m.group(1) if m else None


def parse_spotify(url):
    m = SPOTIFY_RE.search(url)
    if not m:
        return None
    return m.group(1), m.group(2)


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


def spotify_metadata(url):
    """Best-effort metadata from Spotify's public oEmbed endpoint."""
    quoted = urllib.parse.quote(url, safe="")
    data = _oembed("https://open.spotify.com/oembed?url=" + quoted)
    if not data:
        return {}
    title = data.get("title", "")
    artist = None
    if " – " in title:
        artist = title.split(" – ", 1)[1]
    elif " - " in title:
        artist = title.split(" - ", 1)[1]
    return {
        "title": title,
        "artist": artist,
        "thumbnail_url": data.get("thumbnail_url"),
        "media_type": "MUSIC",
    }
