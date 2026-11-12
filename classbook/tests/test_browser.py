"""The browser half, in a real browser: the app served by the real server,
driven through headless Chromium (Playwright). Skipped where Chromium is not
installed (`pixi run postinstall`).

Covers what only exists in JavaScript: the sync loop, the teaching hours as the
browser computes them (which must equal app/planning.py), the CSV import and
its name matching, the grade computation, and the size check of a restore.
"""
import socket
import threading
import time

import pytest

pytest.importorskip("playwright.sync_api")
import uvicorn  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

from app import planning  # noqa: E402
from app.main import create_app  # noqa: E402


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    app = create_app(tmp_path_factory.mktemp("data"))
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}", app
    srv.should_exit = True
    thread.join(5)
    app.state.store.close()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as exc:   # no Chromium installed
            pytest.skip(f"Chromium not available: {exc}")
        yield b
        b.close()


def open_app(browser, url):
    """A device of its own: a fresh browser context, the app started and paired."""
    ctx = browser.new_context()
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    page.wait_for_function("window.__classbookStarted === true", timeout=15000)
    page.wait_for_function("(async () => { const db = await import('/js/db.js'); return !!(await db.getMeta('code')); })()", timeout=15000)
    return ctx, page, errors


def test_teaching_hours_match_the_server(server, browser):
    url, app = server
    ctx, page, errors = open_app(browser, url)
    course_id = page.evaluate("""async () => {
      const db = await import('/js/db.js');
      const classId = await db.put('classes', { name: 'H', rows: 1, cols: 1 });
      const yearId = await db.put('years', { name: 'Y', start: '2026-09-01', end: '2026-10-31' });
      await db.write([
        { tbl: 'holidays', data: { yearId, label: 'off', start: '2026-09-15', end: '2026-09-17' } },
        { tbl: 'holidays', data: { yearId, label: 'broken', start: 'x' } },              // must be ignored, not crash
      ]);
      const courseId = await db.put('courses', { classId, yearId, name: 'C', slots: [
        { weekday: 3, hours: '1.5', start: '' },                                           // fractional: 2 hours
        { weekday: 1, hours: 2, start: '08:00' }, { weekday: 1, hours: 1, start: '07:00' } ] });
      await db.write([
        { tbl: 'cancellations', data: { courseId, date: '2026-09-24', reason: 'trip' } },
        { tbl: 'extras', data: { courseId, date: '2026-09-08', hours: 2, start: '13:00', reason: 'lab' } },   // on a teaching day
        { tbl: 'extras', data: { courseId, date: '2026-09-19', hours: 1, start: '10:00', reason: 'a' } },
        { tbl: 'extras', data: { courseId, date: '2026-09-19', hours: 1, start: '09:00', reason: 'b' } },
      ]);
      await db.sync();
      return courseId;
    }""")
    js = page.evaluate("""async (id) => { const db = await import('/js/db.js'); const p = await import('/js/plan.js');
      return p.units(db.get('courses', id)).map(u => [u.date, u.hour, u.source, u.start]); }""", course_id)
    py = [[u.date.isoformat(), u.hour_in_day, u.source, u.start_time] for u in planning.load(app.state.store, course_id).units]
    assert js == py
    assert len({(d, h) for d, h, _, _ in js}) == len(js)                 # every hour its own key
    assert ["2026-09-08", 4, "extra", "13:00"] in js                       # after the 3 regular hours that day
    assert not errors
    ctx.close()


def test_csv_parsing_and_name_matching(server, browser):
    url, _ = server
    ctx, page, errors = open_app(browser, url)
    r = page.evaluate("""async () => {
      const g = await import('/js/grades.js');
      const out = {};
      out.sep = g.parseCsv('sep=;\\nVorname;Nachname;"Test, 1"\\nA;B;3,5\\n');
      out.quotesInside = g.parseCsv('Name,Note\\nO"Muster,5\\nX,6\\n').rows;
      out.points = ['9.5', '9,5', '-', '', '0x10', '1e3', ' 7 '].map(v => { const n = g.parsePoints(v); return Number.isNaN(n) ? 'NaN' : n; });
      const m = (a, f) => { const r = g.matchNames([{ id: 's', firstName: a[0], lastName: a[1] }], [{ firstName: f[0], lastName: f[1] }]);
        return r.matches.length ? (r.matches[0].sure ? 'exact' : 'check') : 'none'; };
      out.cases = [m(['Jörg', 'Müsterle'], ['Joerg', 'Muesterle']), m(['Erika', 'Testmaß'], ['Erika', 'Testmass']),
                   m(['Max', 'Beispil'], ['Max', 'Beispiel']), m(['Berta', 'Probe'], ['Probe', 'Berta']),
                   m(['Anna', 'Al Muster'], ['Anna', 'Al Probe']), m(['Tom', 'Tester'], ['Tim', 'Taster'])];
      const d = g.matchNames([{ id: 'a', firstName: 'Max', lastName: 'Muster' }, { id: 'b', firstName: 'Max', lastName: 'Muster' }],
                             [{ firstName: 'Max', lastName: 'Muster' }, { firstName: 'Max', lastName: 'Muster' }]);
      out.duplicates = { names: d.duplicates, anySure: d.matches.some(x => x.sure) };
      return out;
    }""")
    assert r["sep"]["delim"] == ";" and r["sep"]["header"] == ["Vorname", "Nachname", "Test, 1"] and r["sep"]["rows"] == [["A", "B", "3,5"]]
    assert r["quotesInside"] == [['O"Muster', "5"], ["X", "6"]]            # a quote inside a field does not swallow the file
    assert r["points"] == [9.5, 9.5, None, None, "NaN", "NaN", 7]
    assert r["cases"] == ["exact", "exact", "check", "check", "none", "none"]
    assert r["duplicates"]["names"] == ["max muster"] and r["duplicates"]["anySure"] is False
    assert not errors
    ctx.close()


def test_grades_follow_the_rounded_percentage(server, browser):
    url, _ = server
    ctx, page, errors = open_app(browser, url)
    r = page.evaluate("""async () => {
      const db = await import('/js/db.js'); const g = await import('/js/grades.js');
      const classId = await db.put('classes', { name: 'G', rows: 1, cols: 2 });
      const [a, b] = await db.write([{ tbl: 'students', data: { classId, firstName: 'A', lastName: 'A', photo: null, seat: null } },
                                     { tbl: 'students', data: { classId, firstName: 'B', lastName: 'B', photo: null, seat: null } }]);
      const courseId = await db.put('courses', { classId, name: 'C', slots: [] });
      await g.setWeight(db.get('courses', courseId), g.categories(db.get('courses', courseId))[0], 0);   // participation out
      const catId = await db.put('categories', { courseId, name: 'Exams', weight: 1, position: 1 });
      const subId = await db.put('submissions', { courseId, categoryId: catId, name: 'T', maxPoints: 10000, date: '', position: 1 });
      const sub = db.get('submissions', subId);
      await g.setScore(sub, a, 8746);   // 87.46 % — shown as 87.5, so grade 1
      await g.setScore(sub, b, 4999);   // 49.99 % — shown as 50, so grade 4
      return g.computeGrades(db.get('courses', courseId)).rows.map(r => [r.student.firstName, r.final, r.grade]);
    }""")
    assert sorted(r) == [["A", 87.5, 1], ["B", 50, 4]]
    assert not errors
    ctx.close()


def test_absent_does_not_count(server, browser):
    url, _ = server
    ctx, page, errors = open_app(browser, url)
    r = page.evaluate("""async () => {
      const db = await import('/js/db.js'); const g = await import('/js/grades.js');
      const classId = await db.put('classes', { name: 'Abs', rows: 1, cols: 2 });
      const [a] = await db.write([{ tbl: 'students', data: { classId, firstName: 'A', lastName: 'A', photo: null, seat: null } }]);
      const courseId = await db.put('courses', { classId, name: 'C', slots: [] });
      const course = db.get('courses', courseId);
      await g.setWeight(course, g.categories(course)[0], 0);   // participation out
      const catId = await db.put('categories', { courseId, name: 'Tests', weight: 1, position: 1 });
      const t1 = db.get('submissions', await db.put('submissions', { courseId, categoryId: catId, name: 'T1', maxPoints: 10, date: '', position: 1 }));
      const t2 = db.get('submissions', await db.put('submissions', { courseId, categoryId: catId, name: 'T2', maxPoints: 10, date: '', position: 2 }));
      await g.setScore(t1, a, 8);
      await g.setScore(t2, a, 2);
      await g.setAbsentFrom(t2, a, true);   // replaces the 2 points
      const row = g.computeGrades(course).rows[0];
      const out = { final: row.final, absent: [...row.absent], points: g.scoreOf(t2.id, a), flag: g.absentFrom(t2.id, a) };
      await g.setAbsentFrom(t2, a, false);
      out.after = [g.absentFrom(t2.id, a), g.scoreOf(t2.id, a), g.computeGrades(course).rows[0].final];
      out.ids = [t2.id];
      return out;
    }""")
    assert r["final"] == 80 and r["absent"] == r["ids"]               # only T1 counts
    assert r["points"] is None and r["flag"] is True
    assert r["after"] == [False, None, 80]                              # present again: not graded
    assert not errors
    ctx.close()


def test_two_devices_converge_and_sync_waits(server, browser):
    url, _ = server
    ctx_a, a, errs_a = open_app(browser, url)
    ctx_b, b, errs_b = open_app(browser, url)
    sid = a.evaluate("""async () => { const db = await import('/js/db.js');
      const classId = await db.put('classes', { name: 'Sync', rows: 1, cols: 1 });
      const id = await db.put('students', { classId, firstName: 'Old', lastName: 'Name', photo: null, seat: null });
      await db.sync();   // resolves only once the server has it
      return id; }""")
    b.evaluate("async () => { const db = await import('/js/db.js'); await db.sync(); }")
    assert b.evaluate("async (id) => (await import('/js/db.js')).get('students', id).firstName", sid) == "Old"
    # both edit; the later edit wins on both
    b.evaluate("async (id) => { const db = await import('/js/db.js'); await db.patch('students', id, { firstName: 'FromB' }); }", sid)
    a.wait_for_timeout(20)
    a.evaluate("async (id) => { const db = await import('/js/db.js'); await db.patch('students', id, { firstName: 'FromA' }); }", sid)
    for _ in range(2):
        b.evaluate("async () => { await (await import('/js/db.js')).sync(); }")
        a.evaluate("async () => { await (await import('/js/db.js')).sync(); }")
    names = [p.evaluate("async (id) => (await import('/js/db.js')).get('students', id).firstName", sid) for p in (a, b)]
    assert names == ["FromA", "FromA"]
    # one sync at a time: asked twice at once, it is the same run
    assert a.evaluate("async () => { const db = await import('/js/db.js'); const x = db.sync(); const y = db.sync(); const same = x === y; await x; return same; }")
    assert a.evaluate("async () => (await import('/js/db.js')).status.pending") == 0
    assert not errs_a and not errs_b
    ctx_a.close()
    ctx_b.close()


def test_restore_counts_bytes_like_the_server(server, browser):
    url, _ = server
    ctx, page, errors = open_app(browser, url)
    r = page.evaluate("""async () => { const m = await import('/js/model.js');
      const plan = m.planRestore({ students: [
        { id: 'big', firstName: 'ä'.repeat(400000), lastName: 'X' },     // 400 000 characters, 800 000 bytes
        { id: 'ok', firstName: 'Erika', lastName: 'Musterfrau' } ] });
      return { invalid: plan.invalid, add: plan.add.map(x => x.id) }; }""")
    assert r == {"invalid": 1, "add": ["ok"]}
    assert not errors
    ctx.close()


def test_csv_import_marks_missing_students_absent(server, browser, tmp_path):
    url, _ = server
    ctx, page, errors = open_app(browser, url)
    ids = page.evaluate("""async () => {
      const db = await import('/js/db.js');
      const classId = await db.put('classes', { name: 'Imp', rows: 1, cols: 2 });
      const [a, b, c] = await db.write([{ tbl: 'students', data: { classId, firstName: 'Anna', lastName: 'Apfel', photo: null, seat: null } },
                                        { tbl: 'students', data: { classId, firstName: 'Ben', lastName: 'Birne', photo: null, seat: null } },
                                        { tbl: 'students', data: { classId, firstName: 'Cleo', lastName: 'Kirsche', photo: null, seat: null } }]);
      const courseId = await db.put('courses', { classId, name: 'C', slots: [] });
      await db.put('categories', { courseId, name: 'Tests', weight: 1, position: 1 });
      return { courseId, a, b, c };
    }""")
    csv = tmp_path / "t.csv"
    csv.write_text("Vorname;Nachname;Test 1\nAnna;Apfel;7\nCleo;Kirsche;-\nOverall average;;3,5\n", encoding="utf-8")
    page.goto(f"{url}/#/course/{ids['courseId']}/grades")
    page.locator(".import-card input[type=file]").set_input_files(str(csv))
    page.locator(".import-card select").nth(2).select_option(label="Test 1 — 2 values")
    page.get_by_text("In the file, but not found in the class (1)").wait_for()
    dialogs = []
    page.once("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    page.get_by_role("button", name="Ignore “Overall average”…").click()
    assert "Overall average" in dialogs[0]
    page.get_by_text("In the file, but not found in the class (1)").wait_for()   # dismissed: still blocked
    page.once("dialog", lambda d: d.accept())
    page.get_by_role("button", name="Ignore “Overall average”…").click()
    page.get_by_text("Ignored line of the file: Overall average.").wait_for()
    page.get_by_text("In the class, but not found in the file (1)").wait_for()
    page.get_by_role("button", name="Mark Ben Birne absent and continue").click()
    page.locator(".import-card input[type=number]").fill("10")
    page.get_by_role("button", name="Create the submission and import").click()
    page.wait_for_url("**/grades/*")
    r = page.evaluate("""async (ids) => {
      const db = await import('/js/db.js'); const g = await import('/js/grades.js');
      const sub = db.all('submissions', (s) => s.courseId === ids.courseId)[0];
      const st = (id) => [g.scoreOf(sub.id, id), g.absentFrom(sub.id, id), g.missingFrom(sub.id, id)];
      return [st(ids.a), st(ids.b), st(ids.c), g.computeGrades(db.get('courses', ids.courseId)).rows.map((r) => [r.student.firstName, r.final])];
    }""", ids)
    assert r[:3] == [[7, False, False], [None, True, False], [None, False, True]]   # points, absent, missing
    assert sorted(r[3]) == [["Anna", 70], ["Ben", None], ["Cleo", None]]           # neither counts
    assert page.locator(".points-table tr.absent").count() == 1
    assert page.locator(".points-table tr.missing").count() == 1
    assert not errors
    ctx.close()


def test_overview_export_is_raw_data(server, browser):
    url, _ = server
    ctx, page, errors = open_app(browser, url)
    rows = page.evaluate("""async () => {
      const db = await import('/js/db.js'); const g = await import('/js/grades.js');
      const classId = await db.put('classes', { name: 'Ov', rows: 1, cols: 3 });
      const [a, b, gone] = await db.write([
        { tbl: 'students', data: { classId, firstName: 'Erika', lastName: 'Musterfrau', photo: null, seat: null } },
        { tbl: 'students', data: { classId, firstName: 'Max', lastName: 'Mustermann', photo: null, seat: null } },
        { tbl: 'students', data: { classId, firstName: 'Berta', lastName: 'Beispiel', photo: null, seat: null, droppedOut: '2026-09-20' } },
      ]);
      const yearId = await db.put('years', { name: 'Y', start: '2026-09-07', end: '2026-09-20' });
      const courseId = await db.put('courses', { classId, yearId, name: 'C', slots: [{ weekday: 0, hours: 1, start: '08:00' }] });  // Mondays
      const at = Date.now();
      await db.write([
        { tbl: 'entries', data: { courseId, studentId: a, date: '2026-09-07', kind: 'plus', at } },
        { tbl: 'entries', data: { courseId, studentId: a, date: '2026-09-07', kind: 'plus', at: at + 1 } },
        { tbl: 'entries', data: { courseId, studentId: a, date: '2026-09-07', kind: 'minus', text: 'no homework', at: at + 2 } },
        { tbl: 'entries', data: { courseId, studentId: a, date: '2026-09-07', kind: 'comment', text: 'asked; good', at: at + 5 } },
        { tbl: 'entries', data: { courseId, studentId: a, date: '2026-09-07', kind: 'comment', text: '=later', at: at + 6 } },
        { tbl: 'entries', data: { courseId, studentId: b, date: '2026-09-09', kind: 'star', at: at + 3 } },   // not a planned day
        { tbl: 'entries', data: { courseId, studentId: gone, date: '2026-09-07', kind: 'plus', at: at + 4 } },
        { tbl: 'absences', data: { courseId, studentId: b, date: '2026-09-07' } },
      ]);
      const catId = await db.put('categories', { courseId, name: 'Tests', weight: 1, position: 1 });
      const t1 = db.get('submissions', await db.put('submissions', { courseId, categoryId: catId, name: 'T1', maxPoints: 10, date: '2026-09-14', position: 1 }));
      await g.setScore(t1, a, 7.5);
      await g.setAbsentFrom(t1, b, true);
      const course = db.get('courses', courseId);
      const all = { plus: true, star: true, minus: true, absent: true, reasons: true, comments: true, planned: true };
      return { all: g.overviewRows(course, all), defaults: g.overviewRows(course),
               chosen: g.overviewRows(course, { plus: false, minus: false, absent: true, reasons: false, comments: false, planned: false, submissions: [] }), courseId };
    }""")
    head, *body = rows["all"]
    s = ["Plus", "Star", "Minus"]
    dates = ["2026-09-07", "2026-09-09", "2026-09-14"]                     # Mondays planned + the marked Wednesday
    assert head == ["Surname", "First name"] + [f"{d} {x}" for d in dates for x in s + ["Absent", "Reasons", "Comments"]] + ["Tests: T1 (2026-09-14) [max 10]"]
    assert [r[:2] for r in body] == [["Musterfrau", "Erika"], ["Mustermann", "Max"]]   # dropped out: not listed
    assert body[0][2:] == [2, 0, 1, "", "no homework", "asked; good | =later", 0, 0, 0, "", "", "", "", "", "", "", "", "", "7,5"]
    assert body[1][2:] == [0, 0, 0, 1, "", "", 0, 1, 0, "", "", "", "", "", "", "", "", "", "absent"]   # planned, nothing yet: empty
    # By default: no Star and no Absent columns, everything else.
    assert rows["defaults"][0] == ["Surname", "First name"] + [f"{d} {x}" for d in dates for x in ("Plus", "Minus", "Reasons", "Comments")] + [head[-1]]
    assert rows["defaults"][1][2:] == [2, 1, "no homework", "asked; good | =later", 0, 0, "", "", "", "", "", "", "7,5"]
    # Only absences of recorded days, no grades.
    assert rows["chosen"][0] == ["Surname", "First name", "2026-09-07 Absent", "2026-09-09 Absent"]
    assert rows["chosen"][2][2:] == [1, ""]

    # The dialog: defaults ticked as above; unticking the only submission drops its column.
    page.goto(f"{url}/#/course/{rows['courseId']}/summary")
    page.get_by_role("button", name="Export overview (CSV)…").click()
    dialog = page.get_by_role("dialog", name="Export overview")
    assert [dialog.get_by_label(x).is_checked() for x in ("Plus", "Star", "Minus", "Absent", "Reasons", "Comments")] == [True, False, True, False, True, True]
    dialog.get_by_role("button", name="None").click()
    with page.expect_download() as dl:
        dialog.get_by_role("button", name="Export").click()
    text = open(dl.value.path(), encoding="utf-8-sig").read()
    assert text.splitlines()[0] == ";".join(rows["defaults"][0][:-1])
    assert page.get_by_role("dialog").count() == 0
    assert not errors
    ctx.close()
