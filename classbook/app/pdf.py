"""HTML -> PDF via the headless Chromium that ships with Playwright."""
from __future__ import annotations

import tempfile
from pathlib import Path

from playwright.async_api import async_playwright


async def html_to_pdf(html: str, landscape: bool = False) -> bytes:
    """Render ``html`` to PDF bytes.

    The document is written to a temp file and opened over ``file://`` so that
    the absolute ``file://`` links to the vendored KaTeX assets resolve (CSS
    ``url()`` references are relative to the stylesheet, so the fonts load too).
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        page_file = Path(tmpdir) / "syllabus.html"
        page_file.write_text(html, encoding="utf-8")

        async with async_playwright() as p:
            browser = await p.chromium.launch()
            try:
                page = await browser.new_page()
                await page.goto(page_file.as_uri(), wait_until="networkidle")
                # Wait for KaTeX auto-render to finish typesetting.
                try:
                    await page.wait_for_function(
                        "window.__mathReady === true", timeout=8000
                    )
                except Exception:
                    pass  # no math on the page, or KaTeX unavailable
                return await page.pdf(
                    format="A4",
                    landscape=landscape,
                    print_background=True,
                    margin={
                        "top": "16mm",
                        "bottom": "16mm",
                        "left": "14mm",
                        "right": "14mm",
                    },
                )
            finally:
                await browser.close()
