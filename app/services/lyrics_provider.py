import re
from urllib.request import Request, urlopen
from urllib.parse import urlencode
import json

YOUTUBE_LRC_ENDPOINT = "https://lrclib.net/api/get"
YOUTUBE_SEARCH_ENDPOINT = "https://lrclib.net/api/search"


def _clean(s):
    return re.sub(r"\([^)]*\)|\[[^\]]*\]", "", s).strip()


def _time_to_sec(t):
    t = t.strip()
    m = re.match(r"(\d+):(\d{2})(?:[.:](\d{1,3}))?", t)
    if not m:
        return None
    min_ = int(m.group(1))
    sec = int(m.group(2))
    ms = m.group(3)
    ms_sec = int((ms or "0").ljust(3, "0")) / 1000
    return min_ * 60 + sec + ms_sec


def parse_lrc(text):
    lines = (text or "").splitlines()
    out = []
    time_re = re.compile(r"\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]")
    for raw in lines:
        times = time_re.findall(raw)
        content = time_re.sub("", raw).strip()
        for t in times:
            sec = _time_to_sec(t)
            if sec is None:
                continue
            out.append({"time": sec, "text": content})
    out.sort(key=lambda x: x["time"])
    return out


def _api_get(url):
    req = Request(url, headers={"User-Agent": "LUMIFY/1.0", "Accept": "application/json"})
    try:
        with urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


async def fetch_youtube_lrc(video_id, title=None, artist=None, duration=None):
    try:
        query = ""
        if title or artist:
            parts = []
            if artist:
                parts.append(artist.strip())
            if title:
                parts.append(title.strip())
            query = " ".join(parts)

        if query:
            params = {
                "track_name": _clean(title) if title else "",
                "artist_name": _clean(artist) if artist else "",
                "album_name": "",
                "duration": int(duration) if duration else None,
            }
            query_string = {k: v for k, v in params.items() if v is not None}
            url = YOUTUBE_LRC_ENDPOINT + "?" + urlencode(query_string)
            data = _api_get(url)
            if isinstance(data, dict):
                synced = data.get("syncedLyrics") or data.get("lrc") or ""
                if synced:
                    return parse_lrc(synced)
            if isinstance(data, list) and data:
                synced = data[0].get("syncedLyrics") or data[0].get("lrc") or ""
                if synced:
                    return parse_lrc(synced)

        if query:
            search_url = YOUTUBE_SEARCH_ENDPOINT + "?" + urlencode({"q": query})
            data = _api_get(search_url)
            if isinstance(data, list) and data:
                for item in data:
                    synced = item.get("syncedLyrics") or item.get("lrc") or ""
                    if synced:
                        return parse_lrc(synced)
    except Exception:
        pass
    return []
