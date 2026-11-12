import sqlite3

import pytest

from app.store import PAGE_SIZE, Store, SyncError


def change(id="a", t=1, device="phone", data=None, deleted=False, tbl="students"):
    return {"tbl": tbl, "id": id, "updated_at": t, "device": device,
            "data": data if data is not None else {"firstName": "Erika"}, "deleted": deleted}


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "c.db")
    yield s
    s.close()


def test_push_then_pull_returns_it(store):
    r = store.sync(0, [change()])
    assert r["accepted"] == 1 and r["rev"] == 1 and not r["more"]
    assert r["changes"][0]["data"] == {"firstName": "Erika"}


def test_later_write_wins_and_earlier_is_ignored(store):
    store.sync(0, [change(t=10, data={"v": "new"})])
    r = store.sync(1, [change(t=5, device="mac", data={"v": "old"})])
    assert r["accepted"] == 0
    assert store.export()["students"][0]["v"] == "new"


def test_equal_timestamps_break_ties_by_device(store):
    store.sync(0, [change(t=10, device="aaa", data={"v": "a"})])
    store.sync(0, [change(t=10, device="zzz", data={"v": "z"})])
    store.sync(0, [change(t=10, device="mmm", data={"v": "m"})])
    assert store.export()["students"][0]["v"] == "z"


def test_resending_the_same_change_is_a_no_op(store):
    store.sync(0, [change(t=3)])
    r = store.sync(1, [change(t=3)])
    assert r["accepted"] == 0 and r["changes"] == [] and r["rev"] == 1


def test_deletions_travel_and_leave_the_export(store):
    store.sync(0, [change(t=1)])
    r = store.sync(1, [change(t=2, data={}, deleted=True)])
    assert r["changes"][0]["deleted"] is True
    assert store.export()["students"] == []


def test_two_devices_converge(store):
    # The phone marks offline; the Mac edits meanwhile; both sync.
    mac = store.sync(0, [change("s1", t=100, device="mac", data={"n": "mac"})])
    phone = store.sync(0, [change("e1", t=50, device="phone", tbl="entries", data={"kind": "plus"}),
                           change("s1", t=90, device="phone", data={"n": "phone"})])
    assert {c["id"] for c in phone["changes"]} == {"s1", "e1"}
    s1 = next(c for c in phone["changes"] if c["id"] == "s1")
    assert s1["data"] == {"n": "mac"}   # the phone learns it lost
    back = store.sync(mac["rev"], [])
    assert [c["id"] for c in back["changes"]] == ["e1"]


def test_pulls_are_paged(store):
    store.sync(0, [change(str(i), t=1) for i in range(PAGE_SIZE + 5)])
    first = store.sync(0, [])
    assert first["more"] and len(first["changes"]) == PAGE_SIZE
    second = store.sync(first["rev"], [])
    assert not second["more"] and len(second["changes"]) == 5


@pytest.mark.parametrize("bad", [
    {**change(), "tbl": "users"},
    {**change(), "id": ""},
    {**change(), "updated_at": "1"},
    {**change(), "updated_at": True},
    {**change(), "data": [1]},
    {**change(), "deleted": "no"},
    {**change(), "device": ""},
    {**change(), "updated_at": -1},
    {**change(), "id": "x" * 201},
    {**change(), "data": {"photo": "x" * 700_000}},
    "nope",
])
def test_rejects_malformed_changes(store, bad):
    r = store.sync(0, [bad])
    assert len(r["rejected"]) == 1 and r["rejected"][0]["reason"]
    assert store.current_rev() == 0


def test_one_bad_record_does_not_block_the_others(store):
    # A too-large record from a device must not stop that device syncing at all.
    r = store.sync(0, [change("good1"), change("big", data={"photo": "x" * 700_000}), change("good2")])
    assert r["accepted"] == 2
    assert [x["id"] for x in r["rejected"]] == ["big"] and "too large" in r["rejected"][0]["reason"]
    assert {c["id"] for c in r["changes"]} == {"good1", "good2"}


def test_store_id_is_stable_across_reopen(tmp_path):
    a = Store(tmp_path / "c.db")
    sid = a.store_id
    a.close()
    b = Store(tmp_path / "c.db")
    assert b.store_id == sid
    b.close()


@pytest.mark.parametrize("tbl", ["categories", "submissions", "scores", "settings"])
def test_grading_and_settings_records_sync(store, tbl):
    r = store.sync(0, [change(id="x", tbl=tbl, data={"courseId": "c"})])
    assert r["accepted"] == 1 and store.export()[tbl] == [{"id": "x", "courseId": "c"}]


def test_startup_backup_leaves_out_the_photos(store, tmp_path):
    photo = "data:image/jpeg;base64," + "A" * 50_000
    store.sync(0, [change(id="s1", data={"firstName": "Erika", "photo": photo}),
                   change(id="s2", data={"firstName": "Max", "photo": None}),
                   change(id="e1", tbl="entries", data={"kind": "plus"}),
                   change(id="gone", t=2, data={}, deleted=True)])
    path = store.backup_without_photos(tmp_path / "startup")
    assert path.name.startswith("classbook-") and path.suffix == ".db"
    copy = Store(path)
    try:
        students = {s["id"]: s for s in copy.export()["students"]}
        assert students["s1"] == {"id": "s1", "firstName": "Erika", "photo": None}
        assert students["s2"]["firstName"] == "Max"
        assert copy.export()["entries"] == [{"id": "e1", "kind": "plus"}]
        assert copy.store_id != store.store_id                    # a database of its own: restored, devices resend everything
        assert copy.sync(0, [])["rev"] == store.current_rev()      # deletions (tombstones) kept too
    finally:
        copy.close()
    assert path.stat().st_size < 40_000                            # the photo's 50 kB are given back
    assert store.get("students", "s1")["photo"] == photo           # the live database still has it


def test_startup_backups_get_unique_names_and_are_never_deleted(store, tmp_path):
    d = tmp_path / "backups"
    paths = [store.backup_without_photos(d) for _ in range(5)]
    assert len({p.name for p in paths}) == 5                       # several in one second: still all there
    assert sorted(p.name for p in d.glob("classbook-*.db")) == sorted(p.name for p in paths)
    assert [p.name for p in paths] == sorted(p.name for p in paths)   # and in order by name


def test_the_app_makes_one_at_every_start(tmp_path):
    from app.main import create_app
    for _ in range(2):
        app = create_app(tmp_path / "data")
        assert app.state.startup_backup.exists()
        app.state.store.close()
    assert len(list((tmp_path / "data" / "backups").glob("classbook-*.db"))) == 2


def test_unreferenced_files_go_to_the_trash_not_away(store, tmp_path):
    from app import files
    root = tmp_path / "files"
    (root / "y" / "c" / "t").mkdir(parents=True)
    (root / "y" / "c" / "t" / "keep.png").write_bytes(b"k")
    (root / "y" / "c" / "t" / "orphan.png").write_bytes(b"o")
    store.sync(0, [change(id="f1", tbl="files", data={"path": "y/c/t/keep.png"})])
    assert files.tidy(store, root) == 1
    assert (root / "y/c/t/keep.png").exists() and not (root / "y/c/t/orphan.png").exists()
    assert (root / ".trash/y/c/t/orphan.png").read_bytes() == b"o"              # still there, just moved
    assert files.tidy(store, root) == 0                                         # the trash itself is left alone
