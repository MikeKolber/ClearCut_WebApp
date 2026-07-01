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

    _LIST_TTL_S = 30.0           # tiny in-memory cache for landing-page polls
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
            config=Config(signature_version="s3v4"),
        )
        self._cache_dir = Path(tempfile.gettempdir()) / self._CACHE_DIRNAME
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        self._list_cache_t: float = 0.0
        self._list_cache_v: list[dict] = []

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

    # ── interface ──────────────────────────────────────────────────────

    def list_tests(self) -> list[dict]:
        """The whole bucket is presented as ONE virtual test. We still
        scan every object to give the sidebar an accurate file count."""
        now = time.time()
        if now - self._list_cache_t < self._LIST_TTL_S:
            return list(self._list_cache_v)

        tdms_count = 0
        video_count = 0
        any_found = False
        for obj in self._list_all_objects(self._prefix):
            rel = self._strip_prefix(obj["Key"])
            if not rel or rel.endswith("/"):
                continue
            any_found = True
            ext = Path(rel).suffix.lower()
            if ext == _TDMS_EXTENSION:
                tdms_count += 1
            elif ext in VIDEO_EXTENSIONS:
                video_count += 1

        if not any_found:
            out: list[dict] = []
        else:
            out = [{
                "name": self._VIRTUAL_TEST_NAME,
                "tdms_count": tdms_count,
                "video_count": video_count,
            }]

        self._list_cache_t = now
        self._list_cache_v = out
        return list(out)

    def list_test_files(self, test_name: str) -> dict | None:
        """List every TDMS + video anywhere under the bucket prefix.
        The `name` field on each entry is the full relative path
        (e.g. `TDMS/Results_2026_05_28_11_50_51.tdms`) so downstream
        endpoints can round-trip it back into an R2 key."""
        if test_name != self._VIRTUAL_TEST_NAME:
            return None

        tdms_files: list[dict] = []
        video_files: list[dict] = []
        any_found = False

        for obj in self._list_all_objects(self._prefix):
            rel = self._strip_prefix(obj["Key"])
            if not rel or rel.endswith("/"):
                continue
            any_found = True
            entry = {
                "name": rel,
                "size_bytes": obj.get("Size", 0),
                "mtime": (
                    obj["LastModified"].timestamp()
                    if obj.get("LastModified") else 0.0
                ),
            }
            ext = Path(rel).suffix.lower()
            if ext == _TDMS_EXTENSION:
                tdms_files.append(entry)
            elif ext in VIDEO_EXTENSIONS:
                video_files.append(entry)

        if not any_found:
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
