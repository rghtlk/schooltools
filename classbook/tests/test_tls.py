from cryptography import x509

from app import tls


def test_leaf_is_signed_by_the_ca_and_covers_the_hosts(tmp_path):
    hosts = ["localhost", "127.0.0.1", "mac.local", "192.168.1.4"]
    info = tls.ensure_certs(tmp_path, hosts)
    ca = x509.load_pem_x509_certificate(info["ca"].read_bytes())
    leaf = x509.load_pem_x509_certificate(info["cert"].read_bytes())
    leaf.verify_directly_issued_by(ca)
    assert ca.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
    san = {str(g.value) for g in leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value}
    assert set(hosts) <= san
    assert (leaf.not_valid_after_utc - leaf.not_valid_before_utc).days <= 825
    assert info["key"].stat().st_mode & 0o077 == 0
    assert (tmp_path / "ca-key.pem").stat().st_mode & 0o077 == 0


def test_new_address_remakes_the_leaf_but_keeps_the_ca(tmp_path):
    first = tls.ensure_certs(tmp_path, ["localhost", "192.168.1.4"])
    ca_before = first["ca"].read_bytes()
    leaf_before = first["cert"].read_bytes()
    assert tls.ensure_certs(tmp_path, ["localhost", "192.168.1.4"])["cert"].read_bytes() == leaf_before
    second = tls.ensure_certs(tmp_path, ["localhost", "172.20.10.2"])
    assert second["cert"].read_bytes() != leaf_before
    assert second["ca"].read_bytes() == ca_before
    assert second["ca_fingerprint"] == first["ca_fingerprint"]


def test_ca_served_once_it_exists(tmp_path):
    from fastapi.testclient import TestClient
    from app.main import create_app
    tls.ensure_certs(tmp_path / "data" / "certs", ["localhost"])
    with TestClient(create_app(tmp_path / "data"), base_url="http://127.0.0.1") as c:
        r = c.get("/classbook-ca.crt")
    assert r.status_code == 200 and r.headers["content-type"] == "application/x-x509-ca-cert"
    assert b"BEGIN CERTIFICATE" in r.content


def test_an_airdrop_copy_of_the_ca_is_kept_next_to_it(tmp_path):
    info = tls.ensure_certs(tmp_path, ["localhost"])
    der = (tmp_path / tls.AIRDROP_NAME).read_bytes()
    pem = x509.load_pem_x509_certificate(info["ca"].read_bytes())
    assert x509.load_der_x509_certificate(der) == pem
    (tmp_path / tls.AIRDROP_NAME).unlink()
    tls.ensure_certs(tmp_path, ["localhost"])          # an existing CA: the copy comes back
    assert (tmp_path / tls.AIRDROP_NAME).read_bytes() == der


def test_show_in_finder_only_from_the_mac(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from app import main
    calls = []
    monkeypatch.setattr(main, "reveal_in_finder", lambda path: calls.append(["open", "-R", str(path)]))
    tls.ensure_certs(tmp_path / "data" / "certs", ["localhost"])
    app = main.create_app(tmp_path / "data")
    auth = {"Authorization": f"Bearer {app.state.code}"}
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 5000)) as c:
        assert c.post("/api/reveal-ca", headers=auth).status_code == 200
    assert calls and calls[0][:2] == ["open", "-R"] and calls[0][2].endswith(tls.AIRDROP_NAME)
    with TestClient(app, base_url="http://192.168.1.20", client=("192.168.1.50", 5000)) as c:
        assert c.post("/api/reveal-ca", headers=auth).status_code == 403
    assert len(calls) == 1
