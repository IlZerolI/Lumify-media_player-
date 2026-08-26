from flask import Blueprint, render_template

from app.controllers import song_controller

player_bp = Blueprint("player", __name__, url_prefix="/player")


@player_bp.route("")
def index():
    songs = song_controller.fetch_playlist()
    return render_template("player/index.html", songs=songs)
