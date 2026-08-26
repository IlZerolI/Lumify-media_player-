from app.services import song_service
from app.services import source_service


def fetch_playlist():
    songs = song_service.list_songs()
    return [s.to_dict() for s in songs]


def fetch_song(song_id):
    song = song_service.get_song(song_id)
    return song.to_dict() if song else None


def import_files(files):
    imported = []
    for f in files:
        if not f or not f.filename:
            continue
        result = song_service.add_file_song(f)
        if isinstance(result, dict) and "error" in result:
            imported.append({"file": f.filename, "status": "duplicate", "id": result.get("id")})
        elif isinstance(result, int):
            imported.append({"file": f.filename, "status": "imported", "id": result})
        else:
            imported.append({"file": f.filename, "status": "error", "error": "import_failed"})
    return imported


def import_link(url, force_local=False):
    result = song_service.detect_and_import_link(url, force_local=force_local)
    if "error" in result:
        return result
    return {"id": result["id"], "local": result.get("local", False)}


def delete_song(song_id):
    return song_service.remove_song(song_id)


def rename_song(song_id, name):
    return song_service.rename_song(song_id, name)


def save_order(order_ids):
    song_service.reorder(order_ids)
    return True


def toggle_favorite(song_id):
    return song_service.toggle_favorite(song_id)


def increment_play(song_id):
    song_service.increment_play(song_id)


def fetch_favorites():
    return [s.to_dict() for s in song_service.get_favorites()]


def fetch_recent():
    return [s.to_dict() for s in song_service.get_recent()]


def fetch_most_played():
    return [s.to_dict() for s in song_service.get_most_played()]


def update_song(song_id, data):
    return song_service.update_song(song_id, data)


def fetch_artists():
    return song_service.get_artists()


def fetch_albums():
    return song_service.get_albums()


def fetch_artist(artist_name):
    return {
        "artist": artist_name,
        "songs": [s.to_dict() for s in song_service.get_artist_songs(artist_name)],
    }


def fetch_album(album_name, artist_name=None):
    return {
        "album": album_name,
        "artist": artist_name,
        "songs": [s.to_dict() for s in song_service.get_album_songs(album_name, artist_name)],
    }
