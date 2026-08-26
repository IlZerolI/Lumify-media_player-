from flask import Blueprint, render_template, jsonify, request

from app.controllers import song_controller

albums_bp = Blueprint("albums", __name__)


@albums_bp.route("/albums")
def index():
    albums = song_controller.fetch_albums()
    return render_template("albums/index.html", albums=albums)


@albums_bp.route("/albums/<path:album_name>")
def detail(album_name):
    artist_name = request.args.get("artist")
    data = song_controller.fetch_album(album_name, artist_name)
    return render_template(
        "albums/detail.html",
        album=data["album"],
        artist=data["artist"],
        songs=data["songs"],
    )


@albums_bp.route("/api/albums")
def api_albums():
    return jsonify(song_controller.fetch_albums())


@albums_bp.route("/api/albums/<path:album_name>")
def api_album(album_name):
    artist_name = request.args.get("artist")
    return jsonify(song_controller.fetch_album(album_name, artist_name))
