from flask import Blueprint, render_template

from app.controllers import song_controller

dashboard_bp = Blueprint("dashboard", __name__)


@dashboard_bp.app_template_filter("fmt_dur")
def fmt_dur(seconds):
    if not seconds:
        return "—"
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}:{s:02d}"


@dashboard_bp.route("/")
def index():
    songs = song_controller.fetch_playlist()
    local = [s for s in songs if (s.get("source_type") or "LOCAL") == "LOCAL"]
    youtube = [s for s in songs if s.get("source_type") == "YOUTUBE"]
    spotify = [s for s in songs if s.get("source_type") == "SPOTIFY"]
    total = sum(s.get("duration") or 0 for s in songs)
    minutes = int(total // 60)
    seconds = int(total % 60)
    stats = {
        "total": len(songs),
        "local": len(local),
        "youtube": len(youtube),
        "spotify": len(spotify),
        "duration": f"{minutes}:{seconds:02d}",
    }
    recent = song_controller.fetch_recent()
    most_played = song_controller.fetch_most_played()
    return render_template(
        "dashboard/index.html",
        songs=songs,
        stats=stats,
        recent=recent,
        most_played=most_played,
    )
