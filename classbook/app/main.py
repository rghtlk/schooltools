"""The web server: the app's files, and the one endpoint that syncs.

The browser does all the real work. It keeps the whole data set in its own
IndexedDB, draws every screen from that, and talks to this server only to sync
(``POST /api/sync``). That is what lets the phone mark a class with the computer
closed in a bag: nothing on screen waits for the network.

Access
------
The app's files (HTML, JS, CSS, icons) are served to anyone, because they hold
no data and the phone has to be able to load them before it has paired. Every
``/api`` call needs the **pairing code**, which is made on first start and kept
in ``data/pairing-code``. A browser on the computer itself is given the code
automatically; on the phone you type it once.
"""
from __future__ import annotations

import asyncio
import ipaddress
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import exports, tls
from . import files as filestore
from .store import Store, SyncError

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"   # no 0/O, 1/I/L
FREE_TRIES = 5
COOKIE = "classbook"
MAX_LOCKOUT = 15 * 60


def reveal_in_finder(path: Path) -> None:
    """Show ``path`` in the file manager: Finder, Explorer, or the folder on Linux."""
    if sys.platform == "darwin":
        subprocess.run(["open", "-R", str(path)], check=False, timeout=5)
    elif sys.platform == "win32":
        # One string, quoted as Explorer wants it: a list would be quoted as a
        # single argument when the path has spaces, and Explorer then ignores it.
        subprocess.run(f'explorer /select,"{path}"', check=False, timeout=5)
    else:
        subprocess.run(["xdg-open", str(path.parent)], check=False, timeout=5)


def data_dir() -> Path:
    return Path(os.environ.get("CLASSBOOK_DATA", ROOT / "data")).expanduser()


def load_code(directory: Path) -> str:
    """The pairing code, made on first use: 10 characters, 50 bits."""
    path = directory / "pairing-code"
    if path.exists():
        code = path.read_text().strip()
        # An empty or cut-off file (a crash while writing, a hand edit) must not
        # mean "no code": every request without one would then get in.
        if len(normalise(code)) >= 10:
            return code
    directory.mkdir(parents=True, exist_ok=True)
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(10))
    code = f"{raw[:4]}-{raw[4:8]}-{raw[8:]}"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(code + "\n")
    return code


def normalise(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


def is_loopback(host: str | None) -> bool:
    try:
        return host is not None and ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def host_allowed(host_header: str) -> bool:
    """Only names that cannot be pointed at this machine by a web page.

    A site you visit on this computer could otherwise make its own domain resolve to
    127.0.0.1 (DNS rebinding) and read the pairing code as if it were local.
    IP literals, ``localhost`` and this computer's own ``.local`` name are safe
    from that — any other ``.local`` name could be answered by someone else on
    the network (mDNS) with 127.0.0.1.
    """
    host = host_header.strip().lower()
    if host.startswith("["):                    # [::1]:8000
        host = host[1:host.find("]")] if "]" in host else host
    elif host.count(":") == 1:
        host = host.rsplit(":", 1)[0]
    if host == "localhost" or host == own_local_name():
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


_own_name: str | None = None


def own_local_name() -> str:
    global _own_name
    if _own_name is None:
        _own_name = tls.bonjour_name().lower()
    return _own_name


class Gate:
    """Checks the pairing code; slows down whoever keeps getting it wrong."""

    def __init__(self, code: str):
        self.code = normalise(code)
        self.failures: dict[str, tuple[int, float]] = {}   # ip -> (count, locked until)

    def check(self, request: Request, cookie_ok: bool = False) -> None:
        """The code from the Authorization header — or, where ``cookie_ok``
        (GET requests for documents and files, opened in a tab), the cookie."""
        ip = request.client.host if request.client else "?"
        # This computer itself is never locked out: it can read the code anyway
        # (/api/pair/local), and otherwise any web page could lock the teacher's
        # own browser out by firing requests at 127.0.0.1.
        local = is_loopback(ip)
        count, until = self.failures.get(ip, (0, 0.0))
        now = time.monotonic()
        if until > now and not local:
            raise HTTPException(429, f"Too many wrong codes. Try again in {int(until - now) + 1}s.")
        given = request.headers.get("authorization", "")
        given = given[7:] if given.lower().startswith("bearer ") else ""
        if not given and cookie_ok:
            given = request.cookies.get(COOKIE, "")
        if self.code and secrets.compare_digest(normalise(given).encode(), self.code.encode()):
            self.failures.pop(ip, None)
            return
        if local or not given:
            # No code at all is not a guess — just not counted.
            raise HTTPException(401, "Wrong or missing pairing code.")
        count += 1
        lock = min(2 ** (count - FREE_TRIES), MAX_LOCKOUT) if count >= FREE_TRIES else 0
        self.failures[ip] = (count, now + lock)
        raise HTTPException(401, "Wrong or missing pairing code.")


def create_app(directory: Path | None = None, https_port: int | None = None) -> FastAPI:
    directory = directory or data_dir()
    store = Store(directory / "classbook.db")
    code = load_code(directory)
    gate = Gate(code)
    # One copy at every start, without the photos — the only automatic backup.
    startup_backup = store.backup_without_photos(directory / "backups")
    filestore.tidy(store, directory / "files")

    app = FastAPI(title="classbook", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    app.state.code = code
    app.state.startup_backup = startup_backup

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if not host_allowed(request.headers.get("host", "")):
            return JSONResponse({"detail": "Unknown host."}, status_code=421)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        else:
            # Revalidate every time (cheap, by ETag) so an update is never stuck
            # behind the browser's cache; offline, the service worker answers.
            response.headers.setdefault("Cache-Control", "no-cache")
        return response

    async def authorised(request: Request, cookie_ok: bool = False) -> None:
        try:
            gate.check(request, cookie_ok)
        except HTTPException as exc:
            if exc.status_code == 401:
                await asyncio.sleep(0.5)   # makes guessing slow even before the lockout
            raise

    async def authorised_read(request: Request) -> None:
        """For a document or file opened in a tab: the cookie is enough."""
        await authorised(request, cookie_ok=True)

    def remember(request: Request, response: Response) -> None:
        """Give the app's own browser the cookie its document tabs will need.

        SameSite=Strict: another site can never make the browser send it along,
        and it is only ever accepted for reading (GET), never for a change.
        """
        response.set_cookie(COOKIE, gate.code, max_age=365 * 24 * 3600, httponly=True,
                            samesite="strict", secure=request.url.scheme == "https", path="/")

    @app.get("/api/pair/local")
    def pair_local(request: Request) -> dict[str, str]:
        """The pairing code, for a browser on this computer only."""
        if not is_loopback(request.client.host if request.client else None):
            raise HTTPException(403, "Only a browser on this computer itself gets the code this way.")
        return {"code": code}

    @app.post("/api/check")
    async def check(request: Request, response: Response) -> dict[str, Any]:
        await authorised(request)
        remember(request, response)
        return {"ok": True, "rev": store.current_rev()}

    @app.post("/api/sync")
    async def sync(request: Request, response: Response) -> dict[str, Any]:
        await authorised(request)   # the code first — the body is read only after it
        remember(request, response)
        try:
            body = await request.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            raise HTTPException(422, "Expected {since: int, changes: [...]}.")
        since = body.get("since", 0)
        changes = body.get("changes", [])
        if not isinstance(since, int) or since < 0 or not isinstance(changes, list):
            raise HTTPException(422, "Expected {since: int, changes: [...]}.")
        try:
            result = await asyncio.to_thread(store.sync, since, changes)
        except SyncError as exc:
            raise HTTPException(422, str(exc)) from exc
        if any(isinstance(c, dict) and c.get("tbl") == "files" for c in changes):
            await asyncio.to_thread(filestore.tidy, store, directory / "files")
        return result

    @app.get("/api/export")
    async def export(request: Request) -> JSONResponse:
        await authorised(request)
        stamp = time.strftime("%Y-%m-%d")
        return JSONResponse(await asyncio.to_thread(store.export), headers={
            "Content-Disposition": f'attachment; filename="classbook-{stamp}.json"'})

    @app.get("/api/info")
    async def info(request: Request) -> dict[str, Any]:
        await authorised(request)
        ca = directory / "certs" / "ca.pem"
        return {
            "bonjour": tls.bonjour_name(),
            "addresses": tls.lan_addresses(),
            "https_port": https_port,
            "ca_fingerprint": tls.fingerprint(tls.load_cert(ca)) if ca.exists() else None,
            "data_dir": str(directory),
            "airdrop_file": str(directory / "certs" / tls.AIRDROP_NAME),
            "host_os": {"darwin": "mac", "win32": "windows"}.get(sys.platform, "linux"),
        }

    @app.post("/api/reveal-ca")
    async def reveal_ca(request: Request) -> dict[str, bool]:
        """Show the certificate file in the file manager (Finder: ready to AirDrop). This computer only."""
        await authorised(request)
        if not is_loopback(request.client.host if request.client else None):
            raise HTTPException(403, "Only from a browser on this computer itself.")
        path = directory / "certs" / tls.AIRDROP_NAME
        if not path.exists():
            raise HTTPException(404, "No certificate yet: start with ./start.sh first.")
        reveal_in_finder(path)
        return {"ok": True}

    @app.get("/classbook-ca.crt")
    def ca_cert() -> Response:
        """The local CA, for installing on the phone. A certificate is public."""
        ca = directory / "certs" / "ca.pem"
        if not ca.exists():
            raise HTTPException(404, "No certificate yet: start with ./start.sh first.")
        return Response(ca.read_bytes(), media_type="application/x-x509-ca-cert",
                        headers={"Content-Disposition": 'attachment; filename="classbook-ca.crt"'})

    @app.get("/sw.js")
    def service_worker() -> FileResponse:
        # Never cached by the browser, or an update would never reach the phone.
        return FileResponse(STATIC / "sw.js", media_type="text/javascript",
                            headers={"Cache-Control": "no-cache"})

    exports.add_routes(app, store, directory, authorised, authorised_read)
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
    return app
