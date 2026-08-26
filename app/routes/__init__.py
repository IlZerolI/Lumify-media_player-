from .api_routes import api_bp
from .artist_routes import artists_bp
from .album_routes import albums_bp
from .browse_routes import browse_bp
from .dashboard_routes import dashboard_bp
from .library_routes import library_bp
from .playlist_routes import playlists_bp
from .player_routes import player_bp
from .visualizer_routes import visualizer_bp

__all__ = [
    "api_bp",
    "artists_bp",
    "albums_bp",
    "browse_bp",
    "dashboard_bp",
    "library_bp",
    "playlists_bp",
    "player_bp",
    "visualizer_bp",
]
