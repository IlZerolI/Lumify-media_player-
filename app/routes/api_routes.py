import os

from flask import (
    Blueprint,
    jsonify,
    render_template,
    request,
)

from app.controllers import song_controller
from app.services import playlist_service

api_bp = Blueprint("api", __name__, url_prefix="/api")

ERROR_MESSAGES = {
    "empty_url": "Please paste a media link.",
    "unsupported": "This media source is not supported.",
    "invalid_youtube": "The YouTube URL is invalid.",
    "invalid_spotify": "The Spotify URL is invalid.",
    "duplicate": "This media is already in your LUMIFY library.",
}


@api_bp.route("/songs", methods=["GET"])
def get_songs():
    return jsonify(song_controller.fetch_playlist())


@api_bp.route("/songs/import", methods=["POST"])
def import_songs():
    url = request.form.get("url") or (request.get_json(silent=True) or {}).get("url")
    if url:
        force_local = request.form.get("local") in ("1", "true", "yes")
        result = song_controller.import_link(url, force_local=force_local)
        if "error" in result:
            return jsonify({"error": ERROR_MESSAGES.get(result["error"], "Unable to import this media.")}), 400
        payload = {"imported": [result["id"]]}
        if result.get("local"):
            payload["local"] = True
        return jsonify(payload), 201

    files = request.files.getlist("files")
    if not files or not any(f and f.filename for f in files):
        return jsonify({"error": "No file was selected."}), 400
    results = song_controller.import_files(files)
    imported_ids = [r["id"] for r in results if r.get("status") == "imported"]
    duplicate_ids = [r["id"] for r in results if r.get("status") == "duplicate"]
    errors = [r for r in results if r.get("status") == "error"]
    status_code = 201 if imported_ids else 200
    return jsonify({
        "imported": imported_ids,
        "duplicates": duplicate_ids,
        "errors": errors,
        "results": results,
    }), status_code


@api_bp.route("/songs/<int:song_id>", methods=["DELETE"])
def delete_song(song_id):
    ok = song_controller.delete_song(song_id)
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"deleted": song_id})


@api_bp.route("/songs/<int:song_id>", methods=["PATCH"])
def rename_song(song_id):
    data = request.get_json(silent=True) or {}
    name = data.get("name")
    ok = song_controller.rename_song(song_id, name)
    if not ok:
        return jsonify({"error": "invalid"}), 400
    return jsonify({"id": song_id, "name": name})


@api_bp.route("/songs/<int:song_id>/metadata", methods=["PATCH"])
def update_song_metadata(song_id):
    data = request.get_json(silent=True) or {}
    ok = song_controller.update_song(song_id, data)
    if not ok:
        return jsonify({"error": "invalid"}), 400
    return jsonify({"id": song_id, "updated": True})


@api_bp.route("/songs/<int:song_id>/artwork", methods=["POST"])
def upload_song_artwork(song_id):
    file = request.files.get("artwork")
    if not file:
        return jsonify({"error": "no file"}), 400
    from app.services import song_service
    import os, uuid
    artwork_folder = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "static", "media", "artworks")
    )
    os.makedirs(artwork_folder, exist_ok=True)
    ext = os.path.splitext(file.filename or "")[1].lower() or ".jpg"
    artwork_name = f"{uuid.uuid4().hex}{ext}"
    file.save(os.path.join(artwork_folder, artwork_name))
    song_service.update_song(song_id, {"artwork_path": artwork_name})
    return jsonify({"id": song_id, "artwork_path": artwork_name})


@api_bp.route("/order", methods=["POST"])
def set_order():
    data = request.get_json(silent=True) or {}
    order = data.get("order")
    if not isinstance(order, list):
        return jsonify({"error": "order must be a list of ids"}), 400
    song_controller.save_order([int(x) for x in order])
    return jsonify({"ok": True})


@api_bp.route("/songs/<int:song_id>/favorite", methods=["POST"])
def toggle_favorite(song_id):
    val = song_controller.toggle_favorite(song_id)
    if val is None:
        return jsonify({"error": "not found"}), 404
    return jsonify({"id": song_id, "is_favorite": bool(val)})


@api_bp.route("/songs/favorites", methods=["GET"])
def get_favorites():
    return jsonify(song_controller.fetch_favorites())


@api_bp.route("/songs/recent", methods=["GET"])
def get_recent():
    return jsonify(song_controller.fetch_recent())


@api_bp.route("/songs/most-played", methods=["GET"])
def get_most_played():
    return jsonify(song_controller.fetch_most_played())


@api_bp.route("/songs/<int:song_id>/play", methods=["POST"])
def record_play(song_id):
    song_controller.increment_play(song_id)
    return jsonify({"ok": True})


@api_bp.route("/artists", methods=["GET"])
def get_artists():
    return jsonify(song_controller.fetch_artists())


@api_bp.route("/albums", methods=["GET"])
def get_albums():
    return jsonify(song_controller.fetch_albums())


@api_bp.route("/artists/<path:artist_name>", methods=["GET"])
def get_artist(artist_name):
    return jsonify(song_controller.fetch_artist(artist_name))


@api_bp.route("/albums/<path:album_name>", methods=["GET"])
def get_album(album_name):
    artist_name = request.args.get("artist")
    return jsonify(song_controller.fetch_album(album_name, artist_name))


# ------------------------- Playlists -------------------------

@api_bp.route("/playlists", methods=["GET"])
def list_playlists():
    return jsonify(playlist_service.list_playlists())


@api_bp.route("/playlists", methods=["POST"])
def create_playlist():
    data = request.get_json(silent=True) or {}
    name = data.get("name")
    song_ids = data.get("song_ids") or []
    description = data.get("description")
    playlist_id = playlist_service.create_playlist(name, song_ids=song_ids, description=description)
    if not playlist_id:
        return jsonify({"error": "name required"}), 400
    return jsonify({"id": playlist_id}), 201


@api_bp.route("/playlists/<int:playlist_id>", methods=["GET"])
def get_playlist(playlist_id):
    pl = playlist_service.get_playlist(play_id)
    if not pl:
        return jsonify({"error": "not found"}), 404
    songs = playlist_service.get_playlist_songs(playlist_id)
    return jsonify({"playlist": pl, "songs": songs})


@api_bp.route("/playlists/<int:playlist_id>", methods=["PATCH"])
def update_playlist(playlist_id):
    data = request.get_json(silent=True) or {}
    ok = playlist_service.update_playlist(playlist_id, name=data.get("name"), description=data.get("description"))
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@api_bp.route("/playlists/<int:playlist_id>", methods=["DELETE"])
def delete_playlist(playlist_id):
    ok = playlist_service.delete_playlist(playlist_id)
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@api_bp.route("/playlists/<int:playlist_id>/songs", methods=["POST"])
def add_playlist_songs(playlist_id):
    data = request.get_json(silent=True) or {}
    song_ids = data.get("song_ids") or []
    ok = playlist_service.add_songs_to_playlist(playlist_id, song_ids)
    if not ok:
        return jsonify({"error": "playlist not found"}), 404
    return jsonify({"ok": True})


@api_bp.route("/playlists/<int:playlist_id>/songs/<int:song_id>", methods=["DELETE"])
def remove_playlist_song(playlist_id, song_id):
    ok = playlist_service.remove_song_from_playlist(playlist_id, song_id)
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@api_bp.route("/playlists/<int:playlist_id>/reorder", methods=["POST"])
def reorder_playlist(playlist_id):
    data = request.get_json(silent=True) or {}
    song_ids = data.get("song_ids") or []
    ok = playlist_service.reorder_playlist(playlist_id, song_ids)
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})
