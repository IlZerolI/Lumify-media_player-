from flask import Blueprint, render_template

from app.controllers import song_controller

playlists_bp = Blueprint("playlists", __name__, url_prefix="/playlists")


@playlists_bp.route("")
def index():
    songs = song_controller.fetch_playlist()
    artists = song_controller.fetch_artists()
    albums = song_controller.fetch_albums()
    return render_template("playlists/index.html", songs=songs, artists=artists, albums=albums)
