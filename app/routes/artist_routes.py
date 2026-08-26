from flask import Blueprint, render_template, jsonify, request

from app.controllers import song_controller

artists_bp = Blueprint("artists", __name__)


@artists_bp.route("/artists")
def index():
    artists = song_controller.fetch_artists()
    return render_template("artists/index.html", artists=artists)


@artists_bp.route("/artists/<path:artist_name>")
def detail(artist_name):
    data = song_controller.fetch_artist(artist_name)
    return render_template("artists/detail.html", artist=data["artist"], songs=data["songs"])


@artists_bp.route("/api/artists")
def api_artists():
    return jsonify(song_controller.fetch_artists())


@artists_bp.route("/api/artists/<path:artist_name>")
def api_artist(artist_name):
    return jsonify(song_controller.fetch_artist(artist_name))
