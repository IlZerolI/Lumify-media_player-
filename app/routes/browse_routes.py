import os

from flask import Blueprint, jsonify, request

from app.services import file_browser as fb

browse_bp = Blueprint("browse", __name__, url_prefix="/api/browse")


@browse_bp.route("", methods=["GET"])
def browse():
    path = request.args.get("path")
    try:
        data = fb.list_dir(path)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(data)


@browse_bp.route("/import", methods=["POST"])
def import_paths():
    data = request.get_json(silent=True) or {}
    paths = data.get("paths", [])
    imported = fb.import_paths(paths)
    return jsonify({"imported": imported, "count": len(imported)}), 201
