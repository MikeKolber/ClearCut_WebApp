"""Authentication, CSRF, and information-exposure tests."""

from conftest import CSRF, login


def test_protected_route_requires_auth(client):
    resp = client.get("/api/trajectory/presets")
    assert resp.status_code == 401


def test_login_rejected_without_csrf_header(client):
    resp = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "admin"},
    )
    assert resp.status_code == 403
    assert "CSRF" in resp.get_json()["error"]


def test_login_wrong_password(client):
    resp = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "wrong"},
        headers=CSRF,
    )
    assert resp.status_code == 401


def test_login_success_sets_cookie_and_whoami_works(client):
    login(client)
    resp = client.get("/api/auth/whoami")
    assert resp.status_code == 200
    assert resp.get_json()["username"] == "admin"


def test_mutating_request_rejected_without_csrf_header(auth_client):
    resp = auth_client.post("/api/pbs/calculate", json={})
    assert resp.status_code == 403


def test_get_requests_do_not_need_csrf_header(auth_client):
    resp = auth_client.get("/api/trajectory/presets")
    assert resp.status_code == 200


def test_logout_clears_session(auth_client):
    resp = auth_client.post("/api/auth/logout", headers=CSRF)
    assert resp.status_code == 200
    resp = auth_client.get("/api/trajectory/presets")
    assert resp.status_code == 401


def test_anonymous_ping_is_minimal(client):
    body = client.get("/api/ping").get_json()
    assert body["status"] == "ok"
    assert "engines" not in body   # diagnostics only for authed callers


def test_authenticated_ping_includes_diagnostics(auth_client):
    body = auth_client.get("/api/ping").get_json()
    assert "engines" in body


def test_root_index_is_minimal(client):
    body = client.get("/").get_json()
    assert "endpoints" not in body


def test_pbs_error_has_no_traceback(auth_client):
    resp = auth_client.post(
        "/api/pbs/calculate",
        json={"num_stages": 1, "stage_data": {"1": {"engine": {"model_key": "bogus"}}}},
        headers=CSRF,
    )
    body = resp.get_json()
    assert "traceback" not in body
