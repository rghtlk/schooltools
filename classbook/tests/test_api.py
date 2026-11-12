import pytest
from fastapi.testclient import TestClient

from app.main import Gate, host_allowed, normalise


def test_static_app_is_served_without_a_code(client):
    r = client.get("/")
    assert r.status_code == 200 and "Classbook" in r.text
    assert client.get("/sw.js").headers["cache-control"] == "no-cache"
    assert client.get("/manifest.webmanifest").status_code == 200


def test_api_needs_the_code(client, auth):
    assert client.post("/api/sync", json={"since": 0, "changes": []}).status_code == 401
    assert client.post("/api/sync", json={"since": 0, "changes": []}, headers=auth).status_code == 200


def test_code_is_accepted_without_dashes_and_in_lowercase(client, app):
    loose = normalise(app.state.code).lower()
    assert client.post("/api/check", headers={"Authorization": f"Bearer {loose}"}).status_code == 200


def test_sync_roundtrip(client, auth):
    change = {"tbl": "classes", "id": "c1", "updated_at": 1, "device": "d",
              "data": {"name": "3A", "rows": 5, "cols": 6}, "deleted": False}
    r = client.post("/api/sync", json={"since": 0, "changes": [change]}, headers=auth).json()
    assert r["accepted"] == 1 and r["changes"][0]["data"]["name"] == "3A" and r["store_id"]
    assert client.get("/api/export", headers=auth).json()["classes"][0]["name"] == "3A"


def test_bad_sync_body_is_422(client, auth):
    assert client.post("/api/sync", json={"since": -1}, headers=auth).status_code == 422
    # a bad record inside a good request: turned away on its own, the rest goes on
    bad = {"since": 0, "changes": [{"tbl": "nope"}]}
    r = client.post("/api/sync", json=bad, headers=auth)
    assert r.status_code == 200 and r.json()["rejected"][0]["reason"]


def test_local_pairing_only_from_loopback(app):
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 5000)) as c:
        assert c.get("/api/pair/local").json()["code"] == app.state.code
    with TestClient(app, base_url="http://192.168.1.20", client=("192.168.1.50", 5000)) as c:
        assert c.get("/api/pair/local").status_code == 403


def test_unknown_host_names_are_refused(app):
    with TestClient(app, base_url="http://evil.example.com") as c:
        assert c.get("/api/pair/local").status_code == 421


def test_host_allowed():
    from app.main import own_local_name
    for ok in ["127.0.0.1:8000", "localhost:8000", f"{own_local_name()}:8443",
               "192.168.1.4:8443", "[::1]:8000", "172.20.10.2"]:
        assert host_allowed(ok), ok
    # any other .local name could be answered with 127.0.0.1 by someone on the network
    for bad in ["evil.com", "127.0.0.1.nip.io:8000", "attacker.localhost.evil.com", "", "evil.local:8000"]:
        assert not host_allowed(bad), bad


def test_repeated_wrong_codes_lock_out(client):
    wrong = {"Authorization": "Bearer AAAA-AAAA-AA"}
    codes = [client.post("/api/check", headers=wrong).status_code for _ in range(7)]
    assert codes[:4] == [401] * 4 and 429 in codes


def test_gate_forgets_failures_after_success(app):
    gate = Gate(app.state.code)
    gate.failures["1.2.3.4"] = (3, 0.0)

    class R:
        client = type("C", (), {"host": "1.2.3.4"})()
        headers = {"authorization": f"Bearer {app.state.code}"}

    gate.check(R())
    assert "1.2.3.4" not in gate.failures


def test_pairing_code_is_kept_private(tmp_path, app):
    path = next(p for p in (tmp_path / "data").iterdir() if p.name == "pairing-code")
    assert path.stat().st_mode & 0o077 == 0


def test_ca_download_404_before_certs_exist(client):
    assert client.get("/classbook-ca.crt").status_code == 404


@pytest.mark.parametrize("method, path", [
    ("get", "/api/export"), ("get", "/api/info"), ("get", "/api/latex-available"), ("post", "/api/reveal-ca"),
    ("post", "/api/render"), ("post", "/api/check"), ("post", "/api/sync"),
    ("get", "/files/anything.png"), ("get", "/plan/c/syllabus"), ("get", "/plan/c/syllabus.pdf"),
    ("get", "/plan/c/day/2026-09-01"), ("get", "/plan/c/script.tex"),
])
def test_every_protected_route_needs_the_code(client, method, path):
    client.cookies.clear()
    assert getattr(client, method)(path).status_code == 401, path


def test_file_upload_never_accepts_the_cookie(client, auth):
    client.post("/api/check", headers=auth)          # sets the cookie
    r = client.post("/api/files", data={"topicId": "t"}, files={"file": ("a.png", b"\x89PNG\r\n\x1a\n0", "image/png")})
    assert r.status_code == 401


def test_this_computer_is_never_locked_out(app):
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 5000)) as c:
        wrong = {"Authorization": "Bearer AAAA-AAAA-AA"}
        for _ in range(8):
            assert c.post("/api/check", headers=wrong).status_code == 401      # never 429
        assert c.post("/api/check", headers={"Authorization": f"Bearer {app.state.code}"}).status_code == 200


def test_a_missing_code_is_not_counted_as_a_guess(app):
    with TestClient(app, base_url="http://192.168.1.20", client=("192.168.1.50", 5000)) as c:
        for _ in range(8):
            assert c.post("/api/check").status_code == 401                    # no code at all: never 429
        assert c.post("/api/check", headers={"Authorization": f"Bearer {app.state.code}"}).status_code == 200


def test_an_empty_pairing_code_file_is_replaced(tmp_path):
    from app.main import load_code, normalise
    (tmp_path / "pairing-code").write_text("\n")
    code = load_code(tmp_path)
    assert len(normalise(code)) == 10 and (tmp_path / "pairing-code").read_text().strip() == code
    assert load_code(tmp_path) == code                                        # and then kept
