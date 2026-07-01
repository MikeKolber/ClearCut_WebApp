"""
Engine-test data storage abstraction.

Two interchangeable backends behind one interface:

  * LocalDiskEngineTestStorage — reads from a folder on the server's
    filesystem. The original behaviour, used for local development.
  * R2EngineTestStorage — reads from a Cloudflare R2 / S3-compatible
    bucket. Used in production on Render so the deployed backend
    doesn't need any of the multi-GB recordings on its own disk.

Backend selection is automatic, based on env vars at import time:

  * If `CC_R2_BUCKET` is set → R2 backend (the rest of the CC_R2_* vars
    must also be present).
  * Otherwise → local disk, anchored at the path passed to
    `get_engine_test_storage()`.

The shape of every method's return value is identical between the two
backends, so the Flask routes don't need to branch on backend type.
"""
from __future__ import annotations

import hashlib
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Iterable

VIDEO_EXTENSIONS = (".mp4", ".avi", ".mov", ".mkv")
_TDMS_EXTENSION = ".tdms"


# ---------------------------------------------------------------------------
# Interface
# ---------------------------------------------------------------------------

class EngineTestStorage:
    """Abstract interface. Concrete subclasses below."""

    @property
    def description(self) -> str:
        """Short human-readable identifier for this backend (shown in
        /api/ping so a deployer can confirm which storage is active)."""
        raise NotImplementedError

    def list_tests(self) -> list[dict]:
        """Return [{'name': str, 'tdms_count': int, 'video_count': int}],
        sorted by name. Empty list if nothing is configured."""
        raise NotImplementedError

    def list_test_files(self, test_name: str) -> dict | None:
        """Return:
            {
              'name': test_name,
              'tdms_files':  [{'name', 'size_bytes', 'mtime'}, ...],
              'video_files': [{'name', 'size_bytes', 'mtime'}, ...],
            }
        ...or None if the test folder isn't found."""
        raise NotImplementedError

    def open_tdms_file(self, test_name: str, file_name: str) -> str | None:
        """Return a *local* filesystem path to the TDMS file:
            * Local backend → the file's actual path on disk.
            * R2 backend    → a cached download under tempdir.
        Returns None if the file isn't found or isn't a .tdms."""
        raise NotImplementedError

    def video_response(self, test_name: str, file_name: str):
        """Return a Flask response for the video request — either:
            * Local backend → `send_file(..., conditional=True)`
            * R2 backend    → 302 redirect to a presigned R2 URL.
        Returns None if the file isn't found, or a (json_resp, status)
        tuple for client errors (wrong extension, bad path, etc.)."""
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Local disk
# ---------------------------------------------------------------------------

class LocalDiskEngineTestStorage(EngineTestStorage):
    def __init__(self, data_dir: Path):
        self._data_dir = data_dir

    @property
    def description(self) -> str:
        return f"local:{self._data_dir}"

    def _resolve_folder(self, test_name: str) -> Path | None:
        if not test_name:
            return None
        candidate = (self._data_dir / test_name).resolve()
        try:
            candidate.relative_to(self._data_dir.resolve())
        except ValueError:
            return None
        return candidate if candidate.is_dir() else None

    @staticmethod
    def _meta(p: Path) -> dict:
        try:
            st = p.stat()
            return {"name": p.name, "size_bytes": st.st_size, "mtime": st.st_mtime}
        except OSError:
            return {"name": p.name, "size_bytes": 0, "mtime": 0}

    def list_tests(self) -> list[dict]:
        if not self._data_dir.is_dir():
            return []
        folders = sorted(
            (p for p in self._data_dir.iterdir()
             if p.is_dir() and not p.name.startswith(".")),
            key=lambda p: p.name,
        )
        out = []
        for folder in folders:
            tdms = list(folder.glob("*.tdms"))
            videos = [
                f for f in folder.iterdir()
                if f.is_file() and f.suffix.lower() in VIDEO_EXTENSIONS
            ]
            out.append({
                "name": folder.name,
                "tdms_count": len(tdms),
                "video_count": len(videos),
            })
        return out

    def list_test_files(self, test_name: str) -> dict | None:
        folder = self._resolve_folder(test_name)
        if folder is None:
            return None
        tdms = sorted(folder.glob("*.tdms"))
        videos = sorted(
            f for f in folder.iterdir()
            if f.is_file() and f.suffix.lower() in VIDEO_EXTENSIONS
        )
        return {
            "name": folder.name,
            "tdms_files":  [self._meta(p) for p in tdms],
            "video_files": [self._meta(p) for p in videos],
        }

    def open_tdms_file(self, test_name: str, file_name: str) -> str | None:
        folder = self._resolve_folder(test_name)
        if folder is None:
            return None
        candidate = (folder / file_name).resolve()
        try:
            candidate.relative_to(folder.resolve())
        except ValueError:
            return None
        if not candidate.is_file():
            return None
        if candidate.suffix.lower() != _TDMS_EXTENSION:
            return None
        return str(candidate)

    def video_response(self, test_name: str, file_name: str):
        # Imported lazily so this module doesn't depend on flask at import time.
        import mimetypes
        from flask import jsonify, send_file

        folder = self._resolve_folder(test_name)
        if folder is None:
            return None
        candidate = (folder / file_name).resolve()
        try:
            candidate.relative_to(folder.resolve())
        except ValueError:
            return jsonify({"error": "invalid file path"}), 400
        if not candidate.is_file():
            return None
        if candidate.suffix.lower() not in VIDEO_EXTENSIONS:
            return jsonify({"error": "expected a video file"}), 400

        mt, _ = mimetypes.guess_type(candidate.name)
        return send_file(
            str(candidate),
            mimetype=mt or "application/octet-stream",
            conditional=True,
            as_attachment=False,
        )


# ---------------------------------------------------------------------------
# Cloudflare R2 (any S3-compatible service works — set CC_R2_ENDPOINT
# accordingly)
# ---------------------------------------------------------------------------

class R2EngineTestStorage(EngineTestStorage):
    """R2-backed storage that presents *the entire bucket* as a single
    virtual "test". All files anywhere under the bucket prefix are
    surfaced as one flat list — TDMS files show up in `tdms_files`,
    video files in `video_files`, and each file's `name` includes its
    subfolder path (e.g. `TDMS/Results_2026_05_28_11_50_51.tdms`).

    Why one virtual test instead of "one folder = one test"? Real-world
    engine-test data isn't always neatly grouped into per-run folders;
    ours is split by file type (TDMS/, HighSpeed/, ...) at the bucket
    root. Aggregating everything under a single browsable "test" lets
    users find all recordings regardless of where they live in the
    bucket. Local-disk mode keeps its per-folder semantics for the
    desktop-style workflow."""

    # Name of the single virtual "test" the frontend sees for R2 mode.
    _VIRTUAL_TEST_NAME = "data"

    # Bumped from 30s to 90s since bucket contents change on the order
    # of hours/days (someone drops in a new test folder), not seconds.
    # 90s trades some staleness after upload for far fewer R2 round-trips
    # during normal browsing.
    _LIST_TTL_S = 90.0
    _CACHE_DIRNAME = "cc_engine_test_cache"
    _PRESIGNED_URL_LIFETIME_S = 3600  # 1 hour

    def __init__(self, *, endpoint: str, access_key_id: str,
                 secret_access_key: str, bucket: str, prefix: str = "",
                 region: str = "auto"):
        # Imported lazily so the module is harmless to import without boto3
        # installed (the local-disk path doesn't need it).
        import boto3
        from botocore.config import Config

        self._bucket = bucket
        self._prefix = prefix.rstrip("/") + "/" if prefix else ""
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name=region,
            # Explicit fast-fail timeouts. Default boto3 would retry
            # up to 5 times at 60 seconds each = 5 minutes hanging
            # on a bad path before surfacing an error. Tighter values
            # keep the Engine Test page snappy even if R2 is temporarily
            # slow, and surface the failure to the user quickly.
            config=Config(
                signature_version="s3v4",
                connect_timeout=5,
                read_timeout=20,
                retries={"max_attempts": 2, "mode": "standard"},
            ),
        )
        self._cache_dir = Path(tempfile.gettempdir()) / self._CACHE_DIRNAME
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        # Shared full-bucket snapshot. Both list_tests and list_test_files
        # derive from this list, so scanning R2 once serves both endpoints.
        self._snapshot_t: float = 0.0
        self._snapshot: list[dict] = []
        self._snapshot_lock = threading.Lock()

        # Pre-warm the cache in a background thread so the first user
        # click on Engine Test doesn't wait a whole R2 round-trip.
        # Silent failure is fine — if the pre-warm dies, the real
        # request will retry and surface the error properly.
        try:
            threading.Thread(
                target=self._safe_prewarm, daemon=True,
                name="r2-engine-test-prewarm",
            ).start()
        except Exception:
            pass

    @property
    def description(self) -> str:
        return f"r2:{self._bucket}/{self._prefix}".rstrip("/")

    # ── helpers ────────────────────────────────────────────────────────

    def _strip_prefix(self, key: str) -> str:
        if self._prefix and key.startswith(self._prefix):
            return key[len(self._prefix):]
        return key

    def _list_all_objects(self, prefix: str) -> Iterable[dict]:
        token = None
        while True:
            kwargs = {"Bucket": self._bucket, "Prefix": prefix}
            if token:
                kwargs["ContinuationToken"] = token
            resp = self._client.list_objects_v2(**kwargs)
            for obj in resp.get("Contents", []):
                yield obj
            if not resp.get("IsTruncated"):
                break
            token = resp.get("NextContinuationToken")

    @staticmethod
    def _is_safe_relpath(name: str) -> bool:
        """Reject empty names, `..` (path escape), and backslashes
        (would confuse Windows-style clients). Slashes ARE allowed —
        S3 keys are a flat string namespace and files inside subfolders
        naturally carry slashes in their display name."""
        if not name:
            return False
        if "\\" in name:
            return False
        if ".." in name.split("/"):
            return False
        # No leading slash (would create a key like "//foo").
        if name.startswith("/"):
            return False
        return True

    def _safe_prewarm(self) -> None:
        """Background thread entry-point that warms the snapshot cache
        at construction time. Logs but doesn't re-raise on failure —
        the real request path will surface any real problems to the
        user (with the tightened timeout so it fails fast, not slow)."""
        import sys as _sys
        try:
            t0 = time.time()
            n = len(self._snapshot_bucket())
            print(
                f"[r2-engine-test] pre-warm ok — {n} files cached in "
                f"{time.time() - t0:.2f}s",
                file=_sys.stderr, flush=True,
            )
        except Exception as exc:
            print(
                f"[r2-engine-test] pre-warm failed: "
                f"{type(exc).__name__}: {exc}",
                file=_sys.stderr, flush=True,
            )

    def _snapshot_bucket(self) -> list[dict]:
        """Full-bucket scan with an LRU-ish TTL cache. Both `list_tests`
        and `list_test_files` read from this so a single R2 round-trip
        serves the whole Engine Test page load. Guarded by a lock so
        two concurrent misses don't stampede R2 with duplicate scans."""
        now = time.time()
        # Fast path: cache still fresh (no lock needed for a stale read).
        if self._snapshot and now - self._snapshot_t < self._LIST_TTL_S:
            return self._snapshot

        # Non-blocking lock acquisition with a hard cap. If another
        # thread is already refreshing the snapshot (e.g. the pre-warm
        # thread is still running its first R2 call), waiting past
        # LIST_TTL_S+read_timeout is a bug — we'd rather return a
        # stale-or-empty snapshot than hang the user's request
        # arbitrarily long.
        acquired = self._snapshot_lock.acquire(timeout=25)
        if not acquired:
            import sys as _sys
            print(
                "[r2-engine-test] snapshot lock timeout — returning "
                f"{'stale' if self._snapshot else 'empty'} cache",
                file=_sys.stderr, flush=True,
            )
            return self._snapshot
        try:
            # Recheck under lock — another thread may have refreshed
            # while we were waiting.
            now = time.time()
            if self._snapshot and now - self._snapshot_t < self._LIST_TTL_S:
                return self._snapshot

            snapshot: list[dict] = []
            for obj in self._list_all_objects(self._prefix):
                rel = self._strip_prefix(obj["Key"])
                if not rel or rel.endswith("/"):
                    continue
                ext = Path(rel).suffix.lower()
                # Skip the aux tdms_index files and anything else we
                # don't surface, so the cached snapshot is exactly what
                # both endpoints will use.
                if ext != _TDMS_EXTENSION and ext not in VIDEO_EXTENSIONS:
                    continue
                snapshot.append({
                    "name": rel,
                    "size_bytes": obj.get("Size", 0),
                    "mtime": (
                        obj["LastModified"].timestamp()
                        if obj.get("LastModified") else 0.0
                    ),
                    "_ext": ext,
                })
            self._snapshot = snapshot
            self._snapshot_t = time.time()
            return snapshot
        finally:
            self._snapshot_lock.release()

    # ── interface ──────────────────────────────────────────────────────

    def list_tests(self) -> list[dict]:
        """The whole bucket is presented as ONE virtual test."""
        snapshot = self._snapshot_bucket()
        if not snapshot:
            return []
        tdms_count = sum(1 for e in snapshot if e["_ext"] == _TDMS_EXTENSION)
        video_count = sum(1 for e in snapshot if e["_ext"] in VIDEO_EXTENSIONS)
        return [{
            "name": self._VIRTUAL_TEST_NAME,
            "tdms_count": tdms_count,
            "video_count": video_count,
        }]

    def list_test_files(self, test_name: str) -> dict | None:
        """List every TDMS + video anywhere under the bucket prefix.
        The `name` field on each entry is the full relative path
        (e.g. `TDMS/Results_2026_05_28_11_50_51.tdms`) so downstream
        endpoints can round-trip it back into an R2 key."""
        if test_name != self._VIRTUAL_TEST_NAME:
            return None
        snapshot = self._snapshot_bucket()
        if not snapshot:
            return None
        tdms_files: list[dict] = []
        video_files: list[dict] = []
        for e in snapshot:
            entry = {k: v for k, v in e.items() if not k.startswith("_")}
            if e["_ext"] == _TDMS_EXTENSION:
                tdms_files.append(entry)
            elif e["_ext"] in VIDEO_EXTENSIONS:
                video_files.append(entry)
        if not tdms_files and not video_files:
            return None
        tdms_files.sort(key=lambda e: e["name"])
        video_files.sort(key=lambda e: e["name"])
        return {
            "name": test_name,
            "tdms_files": tdms_files,
            "video_files": video_files,
        }

    def open_tdms_file(self, test_name: str, file_name: str) -> str | None:
        if test_name != self._VIRTUAL_TEST_NAME:
            return None
        if not self._is_safe_relpath(file_name):
            return None
        if Path(file_name).suffix.lower() != _TDMS_EXTENSION:
            return None
        key = f"{self._prefix}{file_name}"
        try:
            head = self._client.head_object(Bucket=self._bucket, Key=key)
        except Exception:
            return None
        # Cache by ETag so a re-uploaded file gets re-downloaded but stable
        # files are read from disk on every subsequent request.
        etag = head.get("ETag", "").strip('"') or "noetag"
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
        cache_path = self._cache_dir / f"{digest}_{etag}.tdms"
        if not cache_path.exists():
            tmp_path = cache_path.with_suffix(".tmp")
            try:
                self._client.download_file(self._bucket, key, str(tmp_path))
                tmp_path.replace(cache_path)
            except Exception:
                if tmp_path.exists():
                    try:
                        tmp_path.unlink()
                    except OSError:
                        pass
                return None
        return str(cache_path)

    def video_response(self, test_name: str, file_name: str):
        from flask import jsonify, redirect

        if test_name != self._VIRTUAL_TEST_NAME:
            return None
        if not self._is_safe_relpath(file_name):
            return None
        if Path(file_name).suffix.lower() not in VIDEO_EXTENSIONS:
            return jsonify({"error": "expected a video file"}), 400

        key = f"{self._prefix}{file_name}"
        try:
            self._client.head_object(Bucket=self._bucket, Key=key)
        except Exception:
            return None

        url = self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket, "Key": key},
            ExpiresIn=self._PRESIGNED_URL_LIFETIME_S,
        )
        # 302 → browser follows transparently. Range requests work
        # natively against R2's signed URLs, so seeking inside <video>
        # tags is supported without any extra code.
        return redirect(url, code=302)


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def get_engine_test_storage(local_data_dir: Path) -> EngineTestStorage:
    """Pick a backend based on env vars. CC_R2_BUCKET is the trigger; if
    it's empty/unset, you get the local-disk backend anchored at
    `local_data_dir`."""
    bucket = os.environ.get("CC_R2_BUCKET", "").strip()
    if not bucket:
        return LocalDiskEngineTestStorage(local_data_dir)

    endpoint = os.environ.get("CC_R2_ENDPOINT", "").strip()
    access_key = os.environ.get("CC_R2_ACCESS_KEY_ID", "").strip()
    secret = os.environ.get("CC_R2_SECRET_ACCESS_KEY", "").strip()
    prefix = os.environ.get("CC_R2_PREFIX", "").strip()

    missing = [
        n for n, v in [
            ("CC_R2_ENDPOINT", endpoint),
            ("CC_R2_ACCESS_KEY_ID", access_key),
            ("CC_R2_SECRET_ACCESS_KEY", secret),
        ] if not v
    ]
    if missing:
        raise RuntimeError(
            "CC_R2_BUCKET is set but these required env vars are missing: "
            + ", ".join(missing)
        )

    return R2EngineTestStorage(
        endpoint=endpoint,
        access_key_id=access_key,
        secret_access_key=secret,
        bucket=bucket,
        prefix=prefix,
    )
