import argparse
import socket
import threading
import time
import urllib.request
import webbrowser

import uvicorn


def _free_port(preferred: int, host: str) -> int:
    for port in [preferred, *range(preferred + 1, preferred + 50)]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            # Like uvicorn: a port in TIME_WAIT from a just-stopped server is reusable.
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError("No free port found")


def _open_browser_when_ready(url: str) -> None:
    for _ in range(100):
        try:
            urllib.request.urlopen(url + "api/health", timeout=0.5)
            break
        except Exception:
            time.sleep(0.1)
    webbrowser.open(url)


def main() -> None:
    parser = argparse.ArgumentParser(prog="quizmaster")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--db", default=None, help="Path to the SQLite database file")
    args = parser.parse_args()

    if args.db:
        import os
        os.environ["QUIZMASTER_DB"] = args.db

    # Bind to the loopback interface only: the app is not reachable from the network.
    host = "127.0.0.1"
    port = _free_port(args.port, host)
    url = f"http://{host}:{port}/"
    print(f"Quizmaster running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Thread(target=_open_browser_when_ready, args=(url,), daemon=True).start()
    uvicorn.run("quizmaster.app:app", host=host, port=port, log_level="warning", proxy_headers=False)


if __name__ == "__main__":
    main()
