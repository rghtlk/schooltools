"""HTTPS for the phone, from a certificate authority that exists only on this computer.

The phone keeps working offline because the app is a PWA with a service
worker, and iOS only runs a service worker on a connection it *trusts* —
clicking through a warning about a self-signed certificate is not enough. So
instead of one self-signed certificate this makes two:

* a small **local CA** (``ca.pem``), made once and valid for ten years. You
  install it on the iPhone once and switch on full trust for it;
* a **server certificate** signed by that CA, for this computer's names and current
  addresses. It is remade automatically whenever the computer turns up on a network
  address it does not cover yet (school Wi-Fi, the phone's hotspot) — and
  because the phone trusts the CA, not the leaf, it never notices.

The CA's private key never leaves ``data/certs`` (``chmod 600``). Nothing here
talks to anyone.
"""
from __future__ import annotations

import datetime as dt
import ipaddress
import os
import socket
import subprocess
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

CA_DAYS = 3650
LEAF_DAYS = 397          # Apple rejects TLS certificates valid for longer than 825 days
RENEW_WITHIN_DAYS = 30


def bonjour_name() -> str:
    """This computer's ``.local`` name — the address that survives changing networks.

    On a Mac the Bonjour name; elsewhere the host name with ``.local`` added
    (Windows 10+ and most Linux desktops answer to it — but not every phone
    asks, so the IP addresses are in the certificate too).
    """
    if sys.platform != "darwin":
        host = socket.gethostname().split(".")[0]
        return f"{host}.local"
    try:
        name = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True,
                              text=True, timeout=2).stdout.strip()
        if name:
            return f"{name}.local"
    except (OSError, subprocess.SubprocessError):
        pass
    host = socket.gethostname()
    return host if host.endswith(".local") else f"{host}.local"


def lan_addresses() -> list[str]:
    """The IPv4 addresses of this machine other than loopback."""
    found: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.add(info[4][0])
    except OSError:
        pass
    # Asks the routing table which interface would leave the machine; no packet is sent.
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        found.add(s.getsockname()[0])
    except OSError:
        pass
    finally:
        s.close()
    return sorted(a for a in found if not a.startswith("127."))


def local_names() -> list[str]:
    return sorted({"localhost", "127.0.0.1", bonjour_name(), *lan_addresses()})


def _sans(hosts: list[str]) -> list[x509.GeneralName]:
    out: list[x509.GeneralName] = []
    for host in hosts:
        try:
            out.append(x509.IPAddress(ipaddress.ip_address(host)))
        except ValueError:
            out.append(x509.DNSName(host))
    return out


def fingerprint(cert: x509.Certificate) -> str:
    digest = cert.fingerprint(hashes.SHA256()).hex().upper()
    return ":".join(digest[i:i + 2] for i in range(0, len(digest), 2))


def _write_key(path: Path, key: ec.EllipticCurvePrivateKey) -> None:
    # Created 0600 before any bytes go in: the key never sits in a readable file.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(key.private_bytes(serialization.Encoding.PEM,
                                   serialization.PrivateFormat.PKCS8,
                                   serialization.NoEncryption()))


def load_cert(path: Path) -> x509.Certificate | None:
    try:
        return x509.load_pem_x509_certificate(path.read_bytes())
    except (OSError, ValueError):
        return None


def _key_usage(**on: bool) -> x509.KeyUsage:
    names = ("digital_signature", "content_commitment", "key_encipherment",
             "data_encipherment", "key_agreement", "key_cert_sign", "crl_sign",
             "encipher_only", "decipher_only")
    return x509.KeyUsage(**{n: on.get(n, False) for n in names})


AIRDROP_NAME = "classbook-ca.cer"   # DER: what iOS opens as a profile from AirDrop or Files


def _write_airdrop_copy(directory: Path, cert: x509.Certificate) -> None:
    der = cert.public_bytes(serialization.Encoding.DER)
    path = directory / AIRDROP_NAME
    if not path.exists() or path.read_bytes() != der:
        path.write_bytes(der)


def ensure_ca(directory: Path) -> tuple[x509.Certificate, ec.EllipticCurvePrivateKey]:
    directory.mkdir(parents=True, exist_ok=True)
    cert_path, key_path = directory / "ca.pem", directory / "ca-key.pem"
    cert = load_cert(cert_path)
    if cert is not None and key_path.exists():
        key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
        _write_airdrop_copy(directory, cert)
        return cert, key  # type: ignore[return-value]

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, f"classbook local CA ({bonjour_name()})"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "classbook"),
    ])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=CA_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(_key_usage(key_cert_sign=True, crl_sign=True), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
                       critical=False)
        .sign(key, hashes.SHA256())
    )
    _write_key(key_path, key)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    _write_airdrop_copy(directory, cert)
    return cert, key


def _leaf_still_good(cert: x509.Certificate | None, ca: x509.Certificate,
                     hosts: list[str]) -> bool:
    if cert is None or cert.issuer != ca.subject:
        return False
    if cert.not_valid_after_utc - dt.datetime.now(dt.timezone.utc) < dt.timedelta(
            days=RENEW_WITHIN_DAYS):
        return False
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return False
    # A name missing from the certificate is a hard error on the phone, not a warning.
    return set(hosts) <= {str(g.value) for g in san}


def ensure_certs(directory: Path, hosts: list[str] | None = None) -> dict[str, object]:
    """Make whatever is missing or stale; return the paths and the CA fingerprint."""
    hosts = hosts or local_names()
    ca, ca_key = ensure_ca(directory)
    cert_path, key_path = directory / "server.pem", directory / "server-key.pem"
    if not (key_path.exists() and _leaf_still_good(load_cert(cert_path), ca, hosts)):
        key = ec.generate_private_key(ec.SECP256R1())
        now = dt.datetime.now(dt.timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, bonjour_name())]))
            .issuer_name(ca.subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(now + dt.timedelta(days=LEAF_DAYS))
            .add_extension(x509.SubjectAlternativeName(_sans(hosts)), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(_key_usage(digital_signature=True), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
                           critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(
                ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256())
        )
        _write_key(key_path, key)
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return {"ca": directory / "ca.pem", "cert": cert_path, "key": key_path,
            "ca_fingerprint": fingerprint(ca), "hosts": hosts}
