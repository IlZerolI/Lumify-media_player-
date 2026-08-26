import json
import os


class Song:
    def __init__(self, row):
        self.id = row["id"]
        self.name = row["name"]
        self.type = row["type"]
        self.file_path = row["file_path"]
        self.base = row["base"]
        self.pattern = json.loads(row["pattern"]) if row["pattern"] else None
        self.duration = row["duration"]
        self.size = row["size"]
        self.next_id = row["next_id"]
        self.created_at = row["created_at"]
        self.source_type = row["source_type"]
        self.media_type = row["media_type"]
        self.source_url = row["source_url"]
        self.source_id = row["source_id"]
        self.thumbnail_url = row["thumbnail_url"]
        self.artist = row["artist"]
        self.album = row["album"]
        self.genre = row["genre"]
        self.updated_at = row["updated_at"]
        self.is_favorite = row["is_favorite"]
        self.play_count = row["play_count"]
        self.last_played = row["last_played"]
        self.album_artist = row["album_artist"]
        self.year = row["year"]
        self.track_number = row["track_number"]
        self.artwork_path = row["artwork_path"]

    def to_dict(self):
        data = {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "duration": self.duration,
            "size": self.size if self.size is not None else None,
            "next_id": self.next_id,
            "source_type": self.source_type or "LOCAL",
            "media_type": self.media_type or "MUSIC",
            "source_url": self.source_url,
            "source_id": self.source_id,
            "thumbnail_url": self.thumbnail_url,
            "artist": self.artist,
            "album": self.album,
            "genre": self.genre,
            "is_favorite": bool(self.is_favorite),
            "play_count": self.play_count or 0,
            "last_played": self.last_played,
            "album_artist": self.album_artist,
            "year": self.year,
            "track_number": self.track_number,
            "artwork_path": self.artwork_path,
        }
        if self.type == "file":
            data["url"] = f"/static/media/{os.path.basename(self.file_path)}" if self.file_path else None
        elif self.type == "synth":
            data["base"] = self.base
            data["pattern"] = self.pattern
        elif self.source_type == "YOUTUBE":
            data["url"] = f"https://www.youtube.com/embed/{self.source_id}"
        elif self.source_type == "SPOTIFY":
            data["url"] = f"https://open.spotify.com/embed/{self.type}/{self.source_id}"
        if self.artwork_path:
            data["artwork_url"] = f"/static/media/artworks/{self.artwork_path}"
        return data

