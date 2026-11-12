"""Planning on the server: hours from the synced records, the documents, files."""
import datetime as dt
import shutil
import time

import pytest

from app import planning

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
T = [int(time.time() * 1000)]   # like a device: wall-clock milliseconds


def put(client, auth, tbl, rid, data, deleted=False):
    T[0] = max(T[0] + 1, int(time.time() * 1000))
    r = client.post("/api/sync", headers=auth, json={"since": 0, "changes": [
        {"tbl": tbl, "id": rid, "data": data, "updated_at": T[0], "device": "test", "deleted": deleted}]})
    assert r.status_code == 200, r.text
    return r


@pytest.fixture
def course(client, auth):
    """Sep 2026: Tuesdays 2 h + Thursdays 1 h; 15 Sep free; 17 Sep cancelled."""
    put(client, auth, "classes", "cl", {"name": "3A", "rows": 5, "cols": 6})
    put(client, auth, "years", "y", {"name": "2026/27", "start": "2026-09-01", "end": "2026-09-30"})
    put(client, auth, "holidays", "h", {"yearId": "y", "label": "Day off", "start": "2026-09-15", "end": "2026-09-15"})
    put(client, auth, "courses", "c", {"classId": "cl", "name": "Mathematik", "yearId": "y", "teacher": "Muster",
                                       "room": "E12", "color": "#2a4b9b", "notes": "About $x$",
                                       "slots": [{"weekday": 3, "hours": 1, "start": "10:00"},
                                                 {"weekday": 1, "hours": 2, "start": "08:00"}]})
    put(client, auth, "cancellations", "x", {"courseId": "c", "date": "2026-09-17", "reason": "Excursion"})
    put(client, auth, "extras", "e", {"courseId": "c", "date": "2026-09-19", "hours": 1, "start": "", "reason": "Make-up"})
    put(client, auth, "topics", "t1", {"courseId": "c", "title": "Fractions", "body": "$$\\frac{a}{b}$$",
                                        "anchorDate": "2026-09-01", "anchorHour": 2, "position": 1})
    put(client, auth, "topics", "t2", {"courseId": "c", "title": "Recap", "body": "",
                                        "anchorDate": "2026-09-01", "anchorHour": 2, "position": 2})
    put(client, auth, "topics", "t3", {"courseId": "c", "title": "Lost hour", "body": "",
                                        "anchorDate": "2026-09-15", "anchorHour": 1, "position": 3})
    put(client, auth, "topics", "t4", {"courseId": "c", "title": "In the pool", "body": "",
                                        "anchorDate": None, "anchorHour": None, "position": 4})
    return "c"


def test_hours_follow_slots_free_days_cancellations_and_extras(app, course):
    plan = planning.load(app.state.store, course)
    days = sorted({u.date.isoformat() for u in plan.units})
    # Tue 1, Thu 3, Tue 8, Thu 10, (Tue 15 free), (Thu 17 cancelled), Sat 19 extra, Tue 22, Thu 24, Tue 29
    assert days == ["2026-09-01", "2026-09-03", "2026-09-08", "2026-09-10", "2026-09-19",
                    "2026-09-22", "2026-09-24", "2026-09-29"]
    tuesday = [u for u in plan.units if u.date == dt.date(2026, 9, 1)]
    assert [(u.hour_in_day, u.start_time) for u in tuesday] == [(1, "08:00"), (2, "08:00")]
    extra = next(u for u in plan.units if u.source == "extra")
    assert extra.note == "Make-up"


def test_several_topics_per_hour_and_orphans_fall_back_to_the_pool(app, course):
    plan = planning.load(app.state.store, course)
    (index, on_hour), = plan.topics.items()
    assert (plan.units[index].date, plan.units[index].hour_in_day) == (dt.date(2026, 9, 1), 2)   # on the right hour
    assert [t["title"] for t in on_hour] == ["Fractions", "Recap"]
    assert [t["title"] for t in plan.pool] == ["Lost hour", "In the pool"]
    s = plan.summary()
    assert s["units_planned"] == 1 and s["unplaced"] == 2 and s["topics"] == 4


def test_a_course_without_a_year_has_no_hours(client, auth, app):
    put(client, auth, "courses", "c0", {"classId": "cl", "name": "Solo", "slots": [{"weekday": 0, "hours": 1}]})
    plan = planning.load(app.state.store, "c0")
    assert plan.units == [] and plan.year is None


def test_syllabus_day_sheet_and_script(client, auth, course):
    r = client.get(f"/plan/{course}/syllabus", headers=auth)
    assert r.status_code == 200 and "Fractions" in r.text and "3A" in r.text and "In the pool" in r.text
    compact = client.get(f"/plan/{course}/syllabus?mode=planning", headers=auth).text
    assert "not yet assigned" in compact
    day = client.get(f"/plan/{course}/day/2026-09-01", headers=auth)
    assert day.status_code == 200 and "Hour 2" in day.text and "Recap" in day.text
    assert "/plan/c/day/2026-09-03" in day.text        # next teaching day
    assert client.get(f"/plan/{course}/day/2026-09-15", headers=auth).status_code == 404
    tex = client.get(f"/plan/{course}/script.tex", headers=auth)
    assert tex.status_code == 200 and "\\section{Fractions \\textperiodcentered{} Recap}" in tex.text
    assert client.get(f"/plan/{course}/script.zip", headers=auth).content[:2] == b"PK"


def test_documents_need_the_code_but_accept_the_cookie(client, auth, course):
    client.cookies.clear()
    assert client.get(f"/plan/{course}/syllabus").status_code == 401
    client.post("/api/check", headers=auth)            # the app's own call sets the cookie
    assert client.get(f"/plan/{course}/syllabus").status_code == 200


def test_the_cookie_never_authorises_a_change(client, auth, course):
    client.post("/api/check", headers=auth)
    assert client.post("/api/sync", json={"since": 0, "changes": []}).status_code == 401
    assert client.post("/api/render", json={"text": "x"}).status_code == 401


def test_render_matches_the_documents(client, auth):
    html = client.post("/api/render", headers=auth, json={"text": "**b** and $x^2$"}).json()["html"]
    assert "<strong>b</strong>" in html and "arithmatex" in html


def test_upload_serve_and_tidy_files(client, auth, app, course, tmp_path):
    r = client.post("/api/files", headers=auth, data={"topicId": "t1"}, files={"file": ("shot one.png", PNG, "image/png")})
    assert r.status_code == 201, r.text
    f = r.json()
    assert f["path"] == "2026-27/mathematik-3a/fractions/shot-one.png" and f["url"] == f"/files/{f['path']}"
    assert client.get(f["url"], headers=auth).content == PNG
    # the record reached the store, so it syncs to the phone
    assert any(x["id"] == f["id"] for x in app.state.store.records("files"))
    # a second upload with the same name never overwrites the first
    again = client.post("/api/files", headers=auth, data={"topicId": "t1"}, files={"file": ("shot one.png", PNG, "image/png")}).json()
    assert again["filename"] == "shot-one-1.png"
    # the script bundles it as a figure
    put(client, auth, "topics", "t1", {"courseId": "c", "title": "Fractions", "body": f"![a]({f['url']})",
                                        "anchorDate": "2026-09-01", "anchorHour": 2, "position": 1})
    assert "figures/shot-one.png" in client.get("/plan/c/script.tex", headers=auth).text
    # deleting the record (on any device) removes the bytes on the next sync
    put(client, auth, "files", f["id"], {}, deleted=True)
    assert client.get(f["url"], headers=auth).status_code == 404
    assert client.get(again["url"], headers=auth).status_code == 200


@pytest.mark.parametrize("name,data,msg", [
    ("x.svg", b"<svg/>", "not supported"),
    ("x.png", b"GIF89a....", "does not look like a valid PNG"),
    ("x.png", b"", "empty"),
])
def test_bad_uploads_are_refused(client, auth, course, name, data, msg):
    r = client.post("/api/files", headers=auth, data={"topicId": "t1"}, files={"file": (name, data, "application/octet-stream")})
    assert r.status_code == 400 and msg in r.json()["detail"]


def test_upload_for_an_unsynced_topic_says_so(client, auth, course):
    r = client.post("/api/files", headers=auth, data={"topicId": "nope"}, files={"file": ("a.png", PNG, "image/png")})
    assert r.status_code == 409


def test_file_paths_cannot_escape(client, auth, course):
    # encoded, so the client sends them as they are and the /files route itself must refuse
    for path in ["/files/%2e%2e/classbook.db", "/files/..%2Fclassbook.db", "/files/%2e%2e/pairing-code", "/files//etc/passwd"]:
        assert client.get(path, headers=auth).status_code == 404, path


@pytest.mark.skipif(not shutil.which("pdflatex"), reason="no TeX installed")
def test_script_pdf_compiles(client, auth, course):
    r = client.get(f"/plan/{course}/script.pdf", headers=auth)
    assert r.status_code == 200 and r.content.startswith(b"%PDF")


def test_syllabus_and_day_pdf(client, auth, course):
    pytest.importorskip("playwright")
    r = client.get(f"/plan/{course}/syllabus.pdf", headers=auth)
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    r = client.get(f"/plan/{course}/day/2026-09-01/pdf", headers=auth)
    assert r.status_code == 200 and r.content.startswith(b"%PDF")


@pytest.mark.parametrize("evil, gone", [
    ("<img src=x onerror=\"alert(1)\">", "onerror"),
    ("<script>alert(1)</script>", "<script"),
    ("[click](javascript:alert(1))", "javascript:"),
    ("<iframe src=\"file:///etc/passwd\"></iframe>", "<iframe"),
    ("<a href=\"#\" onclick=\"x()\">a</a>", "onclick"),
])
def test_notes_are_sanitised(client, auth, evil, gone):
    """Notes may come from an imported file: nothing in them may run."""
    html = client.post("/api/render", headers=auth, json={"text": evil}).json()["html"]
    assert gone not in html.lower()


def test_sanitising_keeps_what_notes_need(client, auth):
    text = "**bold** $x^2$ ![fig](/files/a/b.png) [link](https://example.org)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done"
    html = client.post("/api/render", headers=auth, json={"text": text}).json()["html"]
    for needed in ["<strong>bold</strong>", "arithmatex", 'src="/files/a/b.png"', 'href="https://example.org"', "<table>", "<td>1</td>", "checkbox"]:
        assert needed in html, needed


def test_syllabus_escapes_topic_titles(client, auth, course):
    put(client, auth, "topics", "t1", {"courseId": "c", "title": "<img src=x onerror=alert(1)>", "body": "notes",
                                        "anchorDate": "2026-09-01", "anchorHour": 2, "position": 1})
    page = client.get(f"/plan/{course}/syllabus", headers=auth).text
    assert "<img src=x onerror" not in page and "&lt;img src=x onerror" in page


def test_extra_session_on_a_teaching_day_continues_the_numbering(client, auth, app, course):
    # Tue 1 Sep has hours 1-2; an extra hour that day must be hour 3, not a second hour 1
    put(client, auth, "extras", "e2", {"courseId": "c", "date": "2026-09-01", "hours": 1, "start": "13:00", "reason": "Lab"})
    plan = planning.load(app.state.store, course)
    tuesday = [(u.hour_in_day, u.source) for u in plan.units if u.date == dt.date(2026, 9, 1)]
    assert tuesday == [(1, "regular"), (2, "regular"), (3, "extra")]
    assert len({(u.date, u.hour_in_day) for u in plan.units}) == len(plan.units)   # every hour its own key


def test_loose_values_round_like_the_browser():
    assert planning._int("2.5", 0, 0, 6) == 3 and planning._int(1.5) == 2 and planning._int("3.0", 0, 0, 6) == 3
    assert planning._int("x", 7) == 7
