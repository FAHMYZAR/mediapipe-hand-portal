"""Flask app factory for the hand-tracking server.

Detection runs in the browser now (MediaPipe Hands classic: hands.js
plus wasm, served locally from static/vendor/hands/). This server
only serves static files and answers /api/health.
"""

import mimetypes
import os

from flask import Flask, jsonify, send_from_directory

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")

STATIC_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
HANDS_JS = os.path.join(STATIC_DIR, "vendor", "hands", "hands.js")


def create_app():
    """Build the Flask app: static files plus health only."""
    app = Flask(__name__, static_folder="../static", static_url_path="/static")

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/api/health")
    def health():
        return jsonify({
            "ok": True,
            "app": "tracking",
            "model": "mediapipe-hands-classic",
            "mode": "client",
            "model_loaded": os.path.exists(HANDS_JS),
        })

    return app
