"""Run classbook: one process, two doors onto the same data.

* ``http://127.0.0.1:8000`` — for this computer's own browser. Loopback only, so no
  certificate is needed, and browsers allow a PWA on ``localhost`` without one.
* ``https://<mac>.local:8443`` — for the phone, on the local network, signed
  by the local CA in ``data/certs``.

    python -m app.serve [--port 8000] [--https-port 8443] [--no-https]
"""
from __future__ import annotations

import argparse
import asyncio
import sys

import uvicorn

from . import tls
from .main import create_app, data_dir


def main() -> None:
    parser = argparse.ArgumentParser(prog="classbook")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--https-port", type=int, default=8443)
    parser.add_argument("--no-https", action="store_true",
                        help="this computer only: do not listen on the network at all")
    args = parser.parse_args()
    sys.stdout.reconfigure(line_buffering=True)   # the banner shows up even when piped

    directory = data_dir()
    https = not args.no_https
    certs = tls.ensure_certs(directory / "certs") if https else None
    app = create_app(directory, https_port=args.https_port if https else None)

    servers = [uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", port=args.port, log_level="warning"))]
    if certs:
        servers.append(uvicorn.Server(uvicorn.Config(
            app, host="0.0.0.0", port=args.https_port, log_level="warning",
            ssl_certfile=str(certs["cert"]), ssl_keyfile=str(certs["key"]))))

    print(f"\n  classbook — data in {directory}")
    print(f"  Backup (without photos): {app.state.startup_backup}\n")
    print(f"  On this computer: http://127.0.0.1:{args.port}")
    if certs:
        print(f"  On the phone:  https://{tls.bonjour_name()}:{args.https_port}")
        for addr in tls.lan_addresses():
            print(f"                 https://{addr}:{args.https_port}   (changes with the network)")
        print(f"\n  Pairing code:  {app.state.code}")
        print(f"  CA fingerprint (check it on the phone when you install it):")
        print(f"    {certs['ca_fingerprint']}")
    print("\n  Ctrl+C to stop.\n")

    async def run() -> None:
        await asyncio.gather(*(s.serve() for s in servers))

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    finally:
        app.state.store.close()


if __name__ == "__main__":
    main()
