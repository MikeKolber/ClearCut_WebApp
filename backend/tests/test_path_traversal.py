"""Path-traversal guards on every endpoint that touches user-named files."""

from conftest import CSRF


def test_load_saved_blocks_traversal(auth_client):
    resp = auth_client.post(
        "/api/trajectory/load-saved",
        json={"filename": "../../../etc/passwd"},
        headers=CSRF,
    )
    assert resp.status_code in (400, 403, 404)
    assert resp.status_code != 200


def test_compare_data_blocks_traversal(auth_client):
    resp = auth_client.get(
        "/api/trajectory/compare/data?file=../../backend/app.py"
    )
    assert resp.status_code in (400, 403, 404)


def test_debris_file_blocks_traversal(auth_client):
    resp = auth_client.get(
        "/api/debris/output/nonexistent/file?path=../../current.json"
    )
    assert resp.status_code in (400, 403, 404)


def test_preset_save_sanitizes_name(auth_client):
    import app as app_module

    resp = auth_client.post(
        "/api/trajectory/presets",
        json={"name": "../../evil", "payload": {"a": 1}},
        headers=CSRF,
    )
    assert resp.status_code == 200
    saved = resp.get_json()["saved_name"]
    # Path separators must be gone; the whitelist keeps dots, which is
    # fine — what matters is the file can only land flat inside the
    # presets dir, never a level above it.
    assert "/" not in saved and "\\" not in saved
    target = (app_module._TRAJ_PRESETS_DIR / f"{saved}.json").resolve()
    assert target.parent == app_module._TRAJ_PRESETS_DIR.resolve()
    assert target.exists()
