from flask import Blueprint, render_template, request

from app.controllers import song_controller

library_bp = Blueprint("library", __name__, url_prefix="/library")


@library_bp.route("")
def index():
    songs = song_controller.fetch_playlist()
    return render_template("library/index.html", songs=songs)
