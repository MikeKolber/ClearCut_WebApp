"""Two logged-in sessions must never see each other's data or runs.

These tests pin the Phase-1 multi-user fixes: per-session raw cache,
session-scoped rocket structure, and session-bound run registries.
"""

import io
import json
import time

import app as app_module
from conftest import CSRF, session_sid


def _upload_csv(client, height_values):
    rows = "\n".join(f"{i},{v}" for i, v in enumerate(height_values))
    body = f"time_s,height_m\n{rows}\n".encode()
    resp = client.post(
        "/api/trajectory/load",
        data={"file": (io.BytesIO(body), "test.csv")},
        content_type="multipart/form-data",
        headers=CSRF,
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)


def test_raw_output_is_session_scoped(auth_client, second_client):
    _upload_csv(auth_client, [111, 222, 333])
    _upload_csv(second_client, [999, 888, 777])

    a = auth_client.get("/api/trajectory/output/raw?limit=5").get_json()
    b = second_client.get("/api/trajectory/output/raw?limit=5").get_json()

    a_heights = [row[1] for row in a["rows"]]
    b_heights = [row[1] for row in b["rows"]]
    assert a_heights == [111, 222, 333]
    assert b_heights == [999, 888, 777]


def test_raw_cache_keyed_per_session(auth_client, second_client):
    _upload_csv(auth_client, [1, 2])
    _upload_csv(second_client, [3, 4])
    sid_a = session_sid(auth_client)
    sid_b = session_sid(second_client)

    df_a = app_module._load_full_trajectory_df(sid_a)
    df_b = app_module._load_full_trajectory_df(sid_b)
    assert list(df_a["height_m"]) == [1, 2]
    assert list(df_b["height_m"]) == [3, 4]


def test_rocket_structure_is_session_scoped(auth_client, second_client):
    sid_a = session_sid(auth_client)
    out_dir = app_module._session_output_dir(sid_a)
    (out_dir / "rocket_data.json").write_text(json.dumps({"stage1_length": 12.5}))

    resp_a = auth_client.get("/api/trajectory/rocket-structure")
    assert resp_a.status_code == 200
    assert resp_a.get_json()["data"]["stage1_length"] == 12.5

    resp_b = second_client.get("/api/trajectory/rocket-structure")
    assert resp_b.status_code == 404


def _fake_run(sid, status="running"):
    return {
        "proc": None,
        "sid": sid,
        "status": status,
        "progress": 0.5,
        "phase": "Simulating",
        "log_lines": [],
        "error_msg": "",
        "elapsed_s": 1.0,
        "start_time": time.perf_counter(),
        "config_path": "x",
    }


def test_second_concurrent_run_in_same_session_is_rejected(auth_client):
    sid = session_sid(auth_client)
    with app_module._runs_lock:
        app_module._active_runs["fake-run-1"] = _fake_run(sid)
    try:
        resp = auth_client.post("/api/trajectory/run", json={}, headers=CSRF)
        assert resp.status_code == 409
        assert resp.get_json()["run_id"] == "fake-run-1"
    finally:
        with app_module._runs_lock:
            app_module._active_runs.pop("fake-run-1", None)


def test_run_poll_and_cancel_are_session_bound(auth_client, second_client):
    sid_a = session_sid(auth_client)
    with app_module._runs_lock:
        app_module._active_runs["fake-run-2"] = _fake_run(sid_a)
    try:
        # Owner can poll.
        assert auth_client.get("/api/trajectory/run/fake-run-2").status_code == 200
        # Another session gets 404 for both poll and cancel.
        assert second_client.get("/api/trajectory/run/fake-run-2").status_code == 404
        assert second_client.post(
            "/api/trajectory/run/fake-run-2/cancel", headers=CSRF
        ).status_code == 404
    finally:
        with app_module._runs_lock:
            app_module._active_runs.pop("fake-run-2", None)


def test_trajectory_output_etag_roundtrip(auth_client):
    """Repeat visits to the Plot page revalidate via ETag → 304, which
    skips the CSV parse + JSON serialisation entirely."""
    _upload_csv(auth_client, [10, 20, 30])

    first = auth_client.get("/api/trajectory/output")
    assert first.status_code == 200
    etag = first.headers.get("ETag")
    assert etag

    again = auth_client.get(
        "/api/trajectory/output", headers={"If-None-Match": etag}
    )
    assert again.status_code == 304

    # Changing the file (new upload → new mtime) must invalidate.
    _upload_csv(auth_client, [40, 50, 60])
    changed = auth_client.get(
        "/api/trajectory/output", headers={"If-None-Match": etag}
    )
    assert changed.status_code == 200
    assert changed.headers.get("ETag") != etag


def test_prune_finished_runs_ttl():
    registry = {
        "old": {"status": "success", "finished_at": time.time() - 7200},
        "new": {"status": "success", "finished_at": time.time()},
        "live": {"status": "running"},
    }
    import threading
    app_module._prune_finished_runs(registry, threading.Lock())
    assert "old" not in registry
    assert "new" in registry
    assert "live" in registry
