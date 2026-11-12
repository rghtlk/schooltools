import io
import re
import shutil
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from quizmaster.latex import Converter, build_exam, image_size, with_answers
from quizmaster.moodle_xml import (
    SUPPORTED_TYPES,
    export_moodle_xml,
    join_category_path,
    new_question,
    parse_moodle_xml,
    split_category_path,
)

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = sorted((ROOT / "tests" / "data").glob("*.xml"))  # Moodle exports used as fixtures
HAS_TEX = bool(shutil.which("pdflatex") or shutil.which("tectonic"))


def first_sample():
    """The first Moodle XML fixture; quiz data is not part of the repo, so skip without one."""
    if not SAMPLES:
        pytest.skip("no Moodle XML sample in tests/data/ (quiz data is not committed)")
    return SAMPLES[0]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("QUIZMASTER_DB", str(tmp_path / "test.db"))
    from quizmaster.app import app

    return TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000))


def import_sample(client, **data):
    sample = first_sample()
    res = client.post("/api/import", files=[("files", (sample.name, sample.read_bytes(), "text/xml"))], data=data)
    assert res.status_code == 200, res.text
    return res.json()


# ------------------------------------------------------------------ Moodle XML


@pytest.mark.parametrize("sample", SAMPLES, ids=lambda p: p.name)
def test_sample_round_trip(sample):
    groups = parse_moodle_xml(sample.read_bytes())
    questions = [q for g in groups for q in g["questions"]]
    assert questions
    again = parse_moodle_xml(export_moodle_xml(questions, groups[0]["category"]))
    assert again[0]["category"] == groups[0]["category"]
    assert again[0]["questions"] == questions


@pytest.mark.parametrize("qtype", list(SUPPORTED_TYPES))
def test_new_question_round_trip(qtype):
    q = new_question(qtype)
    q["name"] = "Q"
    q["questiontext"] = '<p>Look: <img src="@@PLUGINFILE@@/a%20b.png"></p>'
    q["files"] = {"a b.png": "iVBORw0KGgo="}
    q["tags"] = ["x"]
    if qtype == "ddimageortext":
        q["background"] = {"name": "bg.png", "data": "iVBORw0KGgo="}
        q["drags"] = [{"no": 1, "text": "A & B", "draggroup": 1, "infinite": True}]
        q["drops"] = [{"no": 1, "text": "", "choice": 1, "xleft": 10, "ytop": 20}]
    parsed = parse_moodle_xml(export_moodle_xml([q], "$course$/top/T"))[0]["questions"][0]
    assert parsed == q


def test_unknown_type_is_preserved():
    xml = """<?xml version="1.0"?><quiz><question type="calculated"><name><text>C</text></name>
    <questiontext format="html"><text>{a} + {b}?</text></questiontext><synchronize>0</synchronize></question></quiz>"""
    q = parse_moodle_xml(xml)[0]["questions"][0]
    assert q["type"] == "calculated" and "raw" in q
    assert "<synchronize>0</synchronize>" in export_moodle_xml([q])


def test_category_paths():
    assert split_category_path("$course$/top/A//B/C") == ["A/B", "C"]
    assert split_category_path("$course$/top") == []
    assert join_category_path(["A/B", "C"]) == "$course$/top/A//B/C"


# ------------------------------------------------------------------ catalog & quizzes


def test_import_builds_hierarchy_and_quiz(client):
    res = import_sample(client, create_quiz="true")
    assert res["questions"] == 28 and len(res["quizzes"]) == 1
    cats = {c["name"]: c for c in client.get("/api/categories").json()}
    top, sub = cats["NSCS Lernzielkontrollen LT 2025-2026"], cats["C1M01 Networking Today"]
    assert top["parent_id"] is None and sub["parent_id"] == top["id"] and sub["question_count"] == 28
    quiz = client.get(f"/api/quizzes/{res['quizzes'][0]}").json()
    assert quiz["name"] == "C1M01 Networking Today" and len(quiz["items"]) == 28
    # importing again reuses the categories
    import_sample(client)
    assert len(client.get("/api/categories").json()) == 2
    assert len(client.get("/api/questions").json()) == 56


def test_quiz_references_catalog_questions(client):
    import_sample(client)
    cat = client.post("/api/categories", json={"name": "Extra"}).json()["id"]
    quiz = client.post("/api/quizzes", json={"name": "Test"}).json()
    q = client.post("/api/questions", json=new_question("truefalse") | {"category_id": cat, "name": "TF", "questiontext": "<p>x</p>", "quiz_id": quiz["id"]}).json()
    ids = [s["id"] for s in client.get("/api/questions").json()][:3]
    r = client.post(f"/api/quizzes/{quiz['id']}/items", json={"question_ids": ids + [q["id"]]}).json()
    assert r["added"] == 3  # q was already added on creation
    items = r["quiz"]["items"]
    assert [it["question"]["id"] for it in items] == [q["id"], *ids]

    # editing the catalog question is visible in the quiz
    q["correct"] = False
    q["name"] = "Changed"
    client.put(f"/api/questions/{q['id']}", json=q)
    quiz_qs = client.get(f"/api/quizzes/{quiz['id']}/questions").json()
    assert quiz_qs[0]["name"] == "Changed" and quiz_qs[0]["correct"] is False

    # points override, reorder, remove
    client.put(f"/api/quizzes/{quiz['id']}/items/{items[0]['item_id']}", json={"points": 3})
    reordered = client.post(f"/api/quizzes/{quiz['id']}/reorder", json={"item_ids": [it["item_id"] for it in items][::-1]}).json()
    assert reordered["items"][-1]["points"] == 3
    assert client.get(f"/api/quizzes/{quiz['id']}/questions").json()[-1]["defaultgrade"] == 3
    after = client.post(f"/api/quizzes/{quiz['id']}/items/remove", json={"item_ids": [items[1]["item_id"]]}).json()
    assert len(after["items"]) == 3
    assert client.get(f"/api/questions/{ids[0]}").status_code == 200  # still in catalog

    # deleting from the catalog removes it from quizzes
    client.post("/api/questions/bulk", json={"action": "delete", "ids": [q["id"]]})
    assert len(client.get(f"/api/quizzes/{quiz['id']}").json()["items"]) == 2

    xml = client.get(f"/api/quizzes/{quiz['id']}/export.xml?mode=catalog")
    groups = parse_moodle_xml(xml.content)
    assert groups[0]["category"].endswith("C1M01 Networking Today")


def test_category_operations(client):
    a = client.post("/api/categories", json={"name": "A"}).json()["id"]
    b = client.post("/api/categories", json={"name": "B", "parent_id": a}).json()["id"]
    assert client.put(f"/api/categories/{a}", json={"parent_id": b}).status_code == 400  # cycle
    q = client.post("/api/questions", json=new_question("shortanswer") | {"category_id": b, "questiontext": "<p>q</p>"}).json()
    client.delete(f"/api/categories/{b}")
    assert client.get(f"/api/questions/{q['id']}").json()["category_id"] == a
    assert client.delete(f"/api/categories/{a}").status_code == 400  # top level with questions
    xml = client.get(f"/api/export.xml?category_id={a}").content
    assert parse_moodle_xml(xml)[0]["category"] == "$course$/top/A"


def test_rejects_non_local_requests(tmp_path, monkeypatch):
    monkeypatch.setenv("QUIZMASTER_DB", str(tmp_path / "test.db"))
    from quizmaster.app import app

    remote = TestClient(app, base_url="http://127.0.0.1:8000", client=("192.168.1.20", 50000))
    assert remote.get("/api/health").status_code == 403
    rebinding = TestClient(app, base_url="http://evil.example:8000", client=("127.0.0.1", 50000))
    assert rebinding.get("/api/health").status_code == 403
    local = TestClient(app, base_url="http://localhost:8000", client=("127.0.0.1", 50000))
    assert local.get("/api/health").status_code == 200


def test_bad_import(client):
    res = client.post("/api/import", files=[("files", ("x.xml", b"<nope", "text/xml"))])
    assert res.status_code == 400


# ------------------------------------------------------------------ LaTeX


def test_html_to_latex():
    c = Converter({}, {})
    out = c.convert("<p>A &amp; B: 100% <b>bold</b> x_1 \\(a^2\\)</p><ul><li>one</li><li>two</li></ul>")
    assert r"A \& B: 100\% \textbf{bold} x\_1 \(a^2\)" in out
    assert r"\begin{itemize}" in out and r"\item one" in out


def test_image_size():
    png = bytes.fromhex("89504e470d0a1a0a0000000d49484452") + (640).to_bytes(4, "big") + (480).to_bytes(4, "big")
    assert image_size(png) == (640, 480)


def test_exam_source_covers_all_types():
    questions = parse_moodle_xml(first_sample().read_bytes())[0]["questions"]
    tex, images = build_exam({"id": 1, "name": "Quiz"}, questions, {})
    assert tex.count(r"\question[") == len(questions)
    for env in (r"\begin{checkboxes}", r"\answerline[", r"\begin{oneparchoices}", r"\begin{tikzpicture}", r"\CorrectChoice"):
        assert env in tex
    assert len(images) == 2


@pytest.mark.skipif(not HAS_TEX, reason="no LaTeX installation")
def test_pdf_export(client):
    quiz_id = import_sample(client, create_quiz="true")["quizzes"][0]
    for answers in (0, 1):
        res = client.get(f"/api/quizzes/{quiz_id}/exam.pdf?answers={answers}")
        assert res.status_code == 200, res.text[:2000]
        assert res.content[:4] == b"%PDF"
    z = zipfile.ZipFile(io.BytesIO(client.get(f"/api/quizzes/{quiz_id}/exam.zip").content))
    assert {"exam.tex", "exam-answers.tex"} <= set(z.namelist())


# ------------------------------------------------------------------ gapselect, cloze, essay

GAPSELECT_XML = """<?xml version="1.0"?><quiz><question type="gapselect"><name><text>G</text></name>
<questiontext format="html"><text><![CDATA[<p>The [[1]] sat on the [[2]].</p>]]></text></questiontext>
<generalfeedback format="html"><text></text></generalfeedback><defaultgrade>2</defaultgrade><penalty>0.3333333</penalty>
<hidden>0</hidden><idnumber></idnumber><shuffleanswers>1</shuffleanswers>
<correctfeedback format="html"><text>ok</text></correctfeedback><partiallycorrectfeedback format="html"><text>p</text></partiallycorrectfeedback>
<incorrectfeedback format="html"><text>no</text></incorrectfeedback><shownumcorrect/>
<selectoption><text>cat</text><group>1</group></selectoption><selectoption><text>mat</text><group>2</group></selectoption>
<selectoption><text>dog</text><group>1</group></selectoption></question>
<question type="cloze"><name><text>C</text></name>
<questiontext format="html"><text><![CDATA[<p>A {2:SHORTANSWER:=Unshielded Twisted-Pair~%50%UTP} has {1:NUMERICAL:=4:0} pairs {1:MCV:=yes~no}.</p>]]></text></questiontext>
<generalfeedback format="html"><text></text></generalfeedback><penalty>0.3333333</penalty><hidden>0</hidden><idnumber></idnumber></question>
<question type="essay"><name><text>E</text></name><questiontext format="html"><text>Explain.</text></questiontext>
<generalfeedback format="html"><text></text></generalfeedback><defaultgrade>3</defaultgrade><penalty>0</penalty><hidden>0</hidden><idnumber></idnumber>
<responseformat>plain</responseformat><responserequired>1</responserequired><responsefieldlines>15</responsefieldlines>
<minwordlimit>10</minwordlimit><maxwordlimit>0</maxwordlimit><attachments>0</attachments><attachmentsrequired>0</attachmentsrequired>
<maxbytes>0</maxbytes><filetypeslist></filetypeslist><graderinfo format="html"><text><![CDATA[<p>Model answer</p>]]></text></graderinfo>
<responsetemplate format="html"><text></text></responsetemplate></question></quiz>"""


def test_new_types_parse_and_round_trip():
    gs, cz, es = parse_moodle_xml(GAPSELECT_XML)[0]["questions"]
    assert gs["type"] == "gapselect" and [o["group"] for o in gs["options"]] == [1, 2, 1] and gs["shuffleanswers"]
    assert cz["type"] == "cloze" and cz["defaultgrade"] == 4.0  # sum of gap weights
    assert es["responseformat"] == "plain" and es["responsefieldlines"] == 15 and es["minwordlimit"] == 10
    assert es["graderinfo"] == "<p>Model answer</p>"
    out = export_moodle_xml([gs, cz, es])
    assert "<defaultgrade>" not in out.split('type="cloze"')[1].split("</question>")[0]  # like Moodle
    assert parse_moodle_xml(out)[0]["questions"] == [gs, cz, es]


def test_cloze_parser():
    from quizmaster.cloze import parse_gaps, total_weight

    gaps = parse_gaps(r"{2:MCV:=Yes \} really#good~%50%Maybe~No#bad} {:NM:=3.14:0.01} {1:SAC:=Case}")
    assert [g["kind"] for g in gaps] == ["radio_v", "numerical", "shortanswer"]
    assert gaps[0]["answers"][0] == {"text": "Yes } really", "fraction": 100.0, "feedback": "good"}
    assert gaps[0]["answers"][1]["fraction"] == 50.0
    assert gaps[1]["weight"] == 1 and gaps[1]["answers"][0]["tolerance"] == "0.01"
    assert gaps[2]["case_sensitive"]
    assert total_weight("{2:SA:=a} {3:SA:=b}") == 5


def test_new_types_in_exam():
    questions = parse_moodle_xml(GAPSELECT_XML)[0]["questions"]
    tex, _ = build_exam({"id": 1, "name": "Q"}, questions, {})
    body = tex.split(r"\begin{document}")[1]
    assert body.count(r"\qmgap{") == 4                      # 2 gapselect + 2 cloze text/number gaps
    assert r"\qmright{yes}" in tex and r"\qmwrong{no}" in tex
    assert r"\begin{solutionorlines}[12cm]" in tex and "Model answer" in tex
    assert r"\question[4]" in tex                           # cloze mark
    assert "{2:SHORTANSWER" not in tex


def test_drag_and_drop_wording_in_exam():
    questions = [q for q in parse_moodle_xml(first_sample().read_bytes())[0]["questions"] if q["type"] == "ddimageortext"]
    tex, _ = build_exam({"id": 1, "name": "Q"}, questions, {"language": "en"})
    assert "Drag" not in tex and "Assign the correct terms to the pictures." in tex


def test_exam_shuffles_choices_by_default():
    questions = [q for q in parse_moodle_xml(first_sample().read_bytes())[0]["questions"] if q["type"] == "multichoiceset"]
    stored = [[a["text"] for a in q["answers"]] for q in questions]

    def printed(settings):
        tex, _ = build_exam({"id": 3, "name": "Q"}, questions, settings)
        blocks = re.findall(r"\\begin\{(?:onepar)?checkboxes\}(.*?)\\end\{(?:onepar)?checkboxes\}", tex, re.S)
        return [[re.sub(r"^\s*\\(Correct)?[Cc]hoice\s*", "", line) for line in b.strip().splitlines()] for b in blocks]

    shuffled = printed({})
    assert shuffled != [[Converter({}, {}).convert(t, inline=True) for t in s] for s in stored]
    assert shuffled == printed({})  # deterministic: exam and answer key list the choices in the same order
    questions[0]["shuffleanswers"] = False
    assert printed({})[0] == [Converter({}, {}).convert(t, inline=True) for t in stored[0]]


def test_exam_language_and_points_options():
    questions = parse_moodle_xml(first_sample().read_bytes())[0]["questions"][:5]
    with_points, _ = build_exam({"id": 1, "name": "Q"}, questions, {"gradetable": "h"})
    assert r"\question[1]" in with_points and r"\gradetable" in with_points
    no_points, _ = build_exam({"id": 1, "name": "Q"}, questions, {"gradetable": "h", "show_points": False})
    assert r"\question[" not in no_points and r"\gradetable" not in no_points and "right=2cm" in no_points
    de, _ = build_exam({"id": 1, "name": "Q"}, questions, {"language": "de"})
    assert "Ordne den Bildern" in de and "[ngerman]{babel}" in de


@pytest.mark.skipif(not HAS_TEX, reason="no LaTeX installation")
def test_pdf_export_overrides(client):
    quiz_id = import_sample(client, create_quiz="true")["quizzes"][0]
    res = client.get(f"/api/quizzes/{quiz_id}/exam.zip?language=de&show_points=false")
    tex = zipfile.ZipFile(io.BytesIO(res.content)).read("exam.tex").decode()
    assert "[ngerman]{babel}" in tex and r"\question[" not in tex
    assert client.get(f"/api/quizzes/{quiz_id}/exam.pdf?language=de&show_points=false").content[:4] == b"%PDF"


@pytest.mark.skipif(not HAS_TEX, reason="no LaTeX installation")
def test_pdf_of_empty_quiz(client):
    quiz = client.post("/api/quizzes", json={"name": "Empty"}).json()
    assert client.get(f"/api/quizzes/{quiz['id']}/exam.pdf").content[:4] == b"%PDF"


def test_archive_and_unarchive_quiz(client):
    quiz = client.post("/api/quizzes", json={"name": "Old exam"}).json()
    client.put(f"/api/quizzes/{quiz['id']}", json={"settings": {"latex": {"language": "de"}}})
    assert client.post(f"/api/quizzes/{quiz['id']}/archive", json={"archived": True}).json()["archived"] is True
    listed = {z["id"]: z for z in client.get("/api/quizzes").json()}
    assert listed[quiz["id"]]["archived"] is True
    # saving PDF settings keeps the quiz archived, and keeps the settings
    client.put(f"/api/quizzes/{quiz['id']}", json={"settings": {"latex": {"language": "en"}}})
    got = client.get(f"/api/quizzes/{quiz['id']}").json()
    assert got["archived"] is True and got["settings"]["latex"]["language"] == "en"
    # a copy of an archived quiz starts out active
    copy = client.post(f"/api/quizzes/{quiz['id']}/duplicate").json()
    assert copy["archived"] is False
    # unarchive
    assert client.post(f"/api/quizzes/{quiz['id']}/archive", json={"archived": False}).json()["archived"] is False
    assert client.get(f"/api/quizzes/{quiz['id']}").json()["settings"] == {"latex": {"language": "en"}}


def test_usage_counts_include_archived_quizzes(client):
    import_sample(client)
    qid = client.get("/api/questions").json()[0]["id"]
    a = client.post("/api/quizzes", json={"name": "A", "question_ids": [qid]}).json()
    b = client.post("/api/quizzes", json={"name": "B", "question_ids": [qid]}).json()
    client.post(f"/api/quizzes/{b['id']}/archive", json={"archived": True})
    summary = next(s for s in client.get("/api/questions").json() if s["id"] == qid)
    assert summary["quiz_count"] == 2 and summary["archived_count"] == 1
    item = client.get(f"/api/quizzes/{a['id']}").json()["items"][0]["question"]
    assert item["quiz_count"] == 2 and item["archived_count"] == 1
    used_in = client.post("/api/questions/full", json={"ids": [qid]}).json()[0]["quizzes"]
    assert {(z["name"], z["archived"]) for z in used_in} == {("A", False), ("B", True)}


def test_static_files_are_revalidated(client):
    res = client.get("/static/app.js")
    assert res.status_code == 200 and res.headers["cache-control"] == "no-cache"
    assert client.get("/static/app.js", headers={"If-None-Match": res.headers["etag"]}).status_code == 304


def test_html_tables_to_latex():
    c = Converter({}, {})
    small = c.convert("<table><thead><tr><th>Layer</th><th>PDU</th></tr></thead><tbody><tr><td>4</td><td>Segment &amp; more</td></tr></tbody></table>")
    assert r"\begin{tabular}[t]{|l|l|}\firsthline" in small
    assert r"\textbf{Layer} & \textbf{PDU} \\\hline" in small and r"4 & Segment \& more \\\hline" in small
    wide = c.convert("<table><caption>Cap</caption><tr><td>" + "long text " * 12 + "</td><td>x</td></tr></table>")
    assert r"\textit{Cap}" in wide and r"p{\dimexpr" in wide
    spans = c.convert('<table><tr><th rowspan="2">A</th><th colspan="2">B</th></tr><tr><td>c</td><td>d</td></tr><tr><td>e</td><td>f</td><td>g</td></tr></table>')
    assert r"\multicolumn{2}{l|}{\textbf{B}}" in spans   # colspan
    assert r"\cline{2-3}" in spans                         # no rule through the rowspan cell
    assert spans.count("&") == 1 + 2 + 2 and "\n& c & d \\\\" in spans  # empty cell under the rowspan


def test_tables_in_question_types_compile():
    html_table = '<table><tr><th>Port</th><th>Protocol</th></tr><tr><td>80</td><td>{1:SHORTANSWER:=HTTP}</td></tr></table>'
    cloze = new_question("cloze") | {"name": "c", "questiontext": html_table}
    mc = new_question("multichoice") | {"name": "m", "questiontext": "<p>Pick</p>", "answers": [
        {"text": "<table><tr><td>a</td><td>b</td></tr></table>", "fraction": 100, "feedback": ""},
        {"text": "<p>none</p>", "fraction": 0, "feedback": ""}]}
    tex, _ = build_exam({"id": 1, "name": "T"}, [cloze, mc], {})
    assert tex.count(r"\begin{tabular}[t]") == 2 and r"\qmgap{" in tex.split(r"\begin{document}")[1]
    if HAS_TEX:
        from quizmaster.latex import compile_pdf
        assert compile_pdf(tex, {})[:4] == b"%PDF"


@pytest.mark.parametrize("html", [
    "<p>Question?</p><div><br></div><div><br></div><table><tr><td>a</td></tr></table>",   # editor blank lines
    "<p><br></p><p>Text</p><p><br></p>",
    "<p><br>Leading break</p>",
    "<p>Trailing break<br></p>",
    "<p>a<br><br><br>b</p>",
    "<ul><li><br>item</li></ul>",
    "<div><div><br></div></div>",
])
def test_line_breaks_never_break_latex(html):
    from quizmaster.latex import compile_pdf
    out = Converter({}, {}).convert(html)
    assert not re.search(r"(^|\n\n)\s*\\newline", out) and not re.search(r"\\newline\s*(\n\n|$)", out)
    mc = new_question("multichoice") | {"name": "m", "questiontext": html, "answers": [
        {"text": html, "fraction": 100, "feedback": ""}, {"text": "<p>x</p>", "fraction": 0, "feedback": ""}]}
    if HAS_TEX:
        tex, _ = build_exam({"id": 1, "name": "T"}, [mc], {})
        assert compile_pdf(with_answers(tex), {})[:4] == b"%PDF"


# ------------------------------------------------------------------ sections


def test_quiz_sections(client):
    import_sample(client)
    ids = [s["id"] for s in client.get("/api/questions").json()][:3]
    quiz = client.post("/api/quizzes", json={"name": "S", "question_ids": ids}).json()
    first, second = quiz["items"][0]["item_id"], quiz["items"][1]["item_id"]

    r = client.post(f"/api/quizzes/{quiz['id']}/sections", json={"name": "Part A", "before_item_id": first}).json()
    a = r["item_id"]
    r = client.post(f"/api/quizzes/{quiz['id']}/sections", json={"name": "Part B", "before_item_id": second}).json()
    b = r["item_id"]
    r = client.post(f"/api/quizzes/{quiz['id']}/sections", json={"name": "Hidden", "visible": False}).json()
    quiz = r["quiz"]
    # sections do not count as questions
    assert len(quiz["items"]) == 3 and [s["name"] for s in quiz["sections"]] == ["Part A", "Part B", "Hidden"]
    order = sorted([(x["position"], x["item_id"]) for x in quiz["items"] + quiz["sections"]])
    assert [i for _, i in order] == [a, first, b, second, quiz["items"][2]["item_id"], r["item_id"]]
    listed = next(z for z in client.get("/api/quizzes").json() if z["id"] == quiz["id"])
    assert listed["question_count"] == 3

    quiz = client.put(f"/api/quizzes/{quiz['id']}/items/{b}", json={"name": "Part B2", "visible": False}).json()
    assert {s["name"]: s["visible"] for s in quiz["sections"]}["Part B2"] is False
    quiz = client.put(f"/api/quizzes/{quiz['id']}/items/{b}", json={"visible": True}).json()
    assert {s["name"]: s["visible"] for s in quiz["sections"]}["Part B2"] is True

    # LaTeX: visible sections only, at the right place; numbering continues across environments
    tex = client.get(f"/api/quizzes/{quiz['id']}/exam.zip")
    src = zipfile.ZipFile(io.BytesIO(tex.content)).read("exam.tex").decode()
    body = src[src.index(r"\begin{document}"):]
    assert body.index(r"\qmsection{Part A}") < body.index(r"\begin{questions}") < body.index(r"\qmsection{Part B2}")
    assert "Hidden" not in body and body.count(r"\question") == 3

    # duplicate keeps the sections; reorder and remove work with section ids
    dup = client.post(f"/api/quizzes/{quiz['id']}/duplicate").json()
    assert [s["name"] for s in dup["sections"]] == ["Part A", "Part B2", "Hidden"]
    quiz = client.post(f"/api/quizzes/{quiz['id']}/items/remove", json={"item_ids": [a]}).json()
    assert [s["name"] for s in quiz["sections"]] == ["Part B2", "Hidden"] and len(quiz["items"]) == 3
    # Moodle export ignores sections
    assert len(parse_moodle_xml(client.get(f"/api/quizzes/{quiz['id']}/export.xml").content)[0]["questions"]) == 3


def test_migrates_old_quiz_items(tmp_path, monkeypatch):
    import sqlite3

    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, name TEXT NOT NULL,
                                 info TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, data TEXT NOT NULL,
                                summary TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE TABLE quizzes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
                              settings TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE TABLE quiz_items (id INTEGER PRIMARY KEY AUTOINCREMENT,
                                 quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
                                 question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
                                 position INTEGER NOT NULL, points REAL);
        INSERT INTO categories (name) VALUES ('C');
        INSERT INTO questions (category_id, data, summary, created, updated)
            VALUES (1, '{"type": "essay", "name": "E"}', '{"type": "essay", "name": "E", "defaultgrade": 2}', 'x', 'x');
        INSERT INTO quizzes (name, created, updated) VALUES ('Q', 'x', 'x');
        INSERT INTO quiz_items (quiz_id, question_id, position, points) VALUES (1, 1, 0, 5);
    """)
    conn.commit()
    conn.close()
    monkeypatch.setenv("QUIZMASTER_DB", str(path))
    from quizmaster import db

    quiz = db.get_quiz(1)
    assert quiz["items"][0]["points"] == 5 and quiz["sections"] == []
    db.add_section(1, "Intro", True, quiz["items"][0]["item_id"])
    assert [s["name"] for s in db.get_quiz(1)["sections"]] == ["Intro"]
    db.delete_questions([1])  # cascade still works after the table rebuild
    assert db.get_quiz(1)["items"] == []


@pytest.mark.skipif(not HAS_TEX, reason="no TeX installation")
def test_sections_pdf_compiles(client):
    import_sample(client)
    ids = [s["id"] for s in client.get("/api/questions").json()][:4]
    quiz = client.post("/api/quizzes", json={"name": "S", "question_ids": ids}).json()
    client.post(f"/api/quizzes/{quiz['id']}/sections", json={"name": "Teil 1 & Grundlagen", "before_item_id": quiz["items"][0]["item_id"]})
    client.post(f"/api/quizzes/{quiz['id']}/sections", json={"name": "Teil 2", "before_item_id": quiz["items"][2]["item_id"]})
    r = client.get(f"/api/quizzes/{quiz['id']}/exam.pdf?answers=1")
    assert r.status_code == 200, r.text[-2000:]


def test_insert_questions_at_position(client):
    import_sample(client)
    ids = [s["id"] for s in client.get("/api/questions").json()][:5]
    quiz = client.post("/api/quizzes", json={"name": "P", "question_ids": ids[:2]}).json()
    first, second = (it["item_id"] for it in quiz["items"])
    sec = client.post(f"/api/quizzes/{quiz['id']}/sections", json={"name": "B", "before_item_id": second}).json()["item_id"]

    def order(z):
        return [x.get("question", {}).get("id", "S") for x in sorted(z["items"] + z["sections"], key=lambda x: (x["position"], x["item_id"]))]

    # from the catalog: before a section
    z = client.post(f"/api/quizzes/{quiz['id']}/items", json={"question_ids": [ids[2], ids[3]], "before_item_id": sec}).json()["quiz"]
    assert order(z) == [ids[0], ids[2], ids[3], "S", ids[1]]
    # a new question: before the first item
    cat = client.post("/api/categories", json={"name": "X"}).json()["id"]
    q = client.post("/api/questions", json=new_question("essay") | {"category_id": cat, "questiontext": "<p>e</p>",
                                                                  "quiz_id": quiz["id"], "before_item_id": first}).json()
    assert order(client.get(f"/api/quizzes/{quiz['id']}").json()) == [q["id"], ids[0], ids[2], ids[3], "S", ids[1]]
    # no position: at the end
    z = client.post(f"/api/quizzes/{quiz['id']}/items", json={"question_ids": [ids[4]]}).json()["quiz"]
    assert order(z)[-1] == ids[4]


def test_multichoice_layout_is_chosen_per_question():
    def mc(layout=None, single=True):
        q = new_question("multichoice") | {"name": "m", "questiontext": "<p>Pick</p>", "single": single, "answers": [
            {"text": f"<p>{t}</p>", "fraction": 100 if i == 0 else 0, "feedback": ""} for i, t in enumerate(["TCP", "UDP", "IP"])]}
        return q | ({"choice_layout": layout} if layout else {})

    tex, _ = build_exam({"id": 1, "name": "T"}, [mc(), mc("lines"), mc("inline"), mc("inline", single=False)], {})
    body = tex.split(r"\begin{document}")[1]
    assert body.count(r"\begin{choices}") == 2
    assert body.count(r"\begin{oneparchoices}") == 1 and body.count(r"\begin{oneparcheckboxes}") == 1
