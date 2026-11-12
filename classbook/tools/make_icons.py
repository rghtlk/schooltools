"""Draw the app icons (a plus and a minus on blue) without any imaging library.

    python tools/make_icons.py
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "static" / "icons"
BG, FG = (42, 75, 155), (255, 255, 255)
SS = 3   # supersampling, for smooth edges


def colour(x, y):
    """The colour at (x, y), both in 0..1."""
    t = 0.052   # stroke half-width
    plus = (abs(x - 0.42) < t and abs(y - 0.42) < 0.18) or (abs(y - 0.42) < t and abs(x - 0.42) < 0.18)
    minus = abs(y - 0.70) < t and abs(x - 0.64) < 0.12
    return FG if plus or minus else BG


def png(size):
    rows = []
    n = size * SS
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = colour((px * SS + sx + 0.5) / n, (py * SS + sy + 0.5) / n)
                    if c:
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            k = SS * SS
            a = acc[3] // k
            row += bytes([acc[0] * 255 // max(acc[3], 1), acc[1] * 255 // max(acc[3], 1),
                          acc[2] * 255 // max(acc[3], 1), a]) if a else bytes(4)
        rows.append(bytes(row))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


OUT.mkdir(parents=True, exist_ok=True)
# iOS rounds the corners itself and wants no transparency; the manifest icons are full-bleed too (maskable).
(OUT / "apple-touch-icon.png").write_bytes(png(180))
(OUT / "icon-192.png").write_bytes(png(192))
(OUT / "icon-512.png").write_bytes(png(512))
print("icons written to", OUT)
