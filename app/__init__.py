from flask import Flask

from app.database.database import init_db
from app.routes import (
    api_bp,
    artists_bp,
    albums_bp,
    browse_bp,
    dashboard_bp,
    library_bp,
    playlists_bp,
    player_bp,
    visualizer_bp,
)


def create_app():
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 150 * 1024 * 1024
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    with app.app_context():
        init_db()

    app.register_blueprint(dashboard_bp)
    app.register_blueprint(library_bp)
    app.register_blueprint(playlists_bp)
    app.register_blueprint(player_bp)
    app.register_blueprint(api_bp)
    app.register_blueprint(browse_bp)
    app.register_blueprint(artists_bp)
    app.register_blueprint(albums_bp)
    app.register_blueprint(visualizer_bp)

    return app