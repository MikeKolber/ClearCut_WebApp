"""Shared fixtures for the backend test suite.

The Flask app reads its configuration from environment variables at
import time, so CC_DATA_DIR is pointed at a throwaway directory
*before* `app` is imported. Every test then runs against an isolated
data root — nothing touches the repo's real presets or sessions.
"""

import os
import sys
import tempfile
from pathlib import Path

import pytest

_TMP_DATA = tempfile.mkdtemp(prefix="cc-test-data-")
os.environ["CC_DATA_DIR"] = _TMP_DATA
os.environ.pop("CC_COOKIE_SECURE", None)   # dev mode — no fail-fast
os.environ.pop("CC_USERNAME", None)        # default admin / admin
os.environ.pop("CC_PASSWORD_HASH", None)
os.environ.pop("CC_R2_BUCKET", None)       # local-disk engine tests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as app_module  # noqa: E402

# Mutating requests must carry the CSRF header (see _enforce_auth).
CSRF = {"X-CC-Request": "1"}


@pytest.fixture()
def client():
    app_module.app.config["TESTING"] = True
    return app_module.app.test_client()


def login(client):
    """Log in with the dev default credentials; the auth cookie is kept
    in the client's cookie jar for subsequent requests."""
    resp = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "admin"},
        headers=CSRF,
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp


def session_sid(client):
    """Extract the session id from the client's auth cookie."""
    cookie = client.get_cookie(app_module._AUTH_COOKIE_NAME)
    assert cookie is not None
    data = app_module._validate_token(cookie.value)
    assert data is not None
    return data["sid"]


@pytest.fixture()
def auth_client(client):
    login(client)
    return client


@pytest.fixture()
def second_client():
    """A second, independently logged-in client (its own session id)."""
    c = app_module.app.test_client()
    login(c)
    return c
