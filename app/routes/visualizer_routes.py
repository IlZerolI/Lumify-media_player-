from flask import Blueprint, render_template

visualizer_bp = Blueprint("visualizer", __name__)


@visualizer_bp.route("/visualizer")
def index():
    return render_template("visualizer/index.html")
