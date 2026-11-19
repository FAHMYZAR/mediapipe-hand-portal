"""Tracking: hand detection server.

Reads HOST and PORT from the environment (the bridge injects both).
Run: venv/bin/python server.py
"""

import os

from app.server_app import create_app


def main():
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "3122"))
    app = create_app()
    print(f"tracking listening on {host}:{port} mode=client", flush=True)
    app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    main()
