"""
Clearcut Flask backend.

Thin HTTP adapter over the existing simulation/calculation engines under
`physics_engines/core/`. Calculation code is NEVER changed — it's imported and
called from the routes below.

Endpoints:
  GET  /api/ping                                   health check
  GET  /api/pbs/defaults                           initial parameter values for PBS forms
  POST /api/pbs/calculate                          body: { num_stages, stage_data } -> mass results

  GET  /api/engine/tests                           list test folders + file counts
  GET  /api/engine/tests/<name>                    files in one test folder
  GET  /api/engine/tests/<name>/tdms/<file>        load a single TDMS file's channel data

Run:
  python app.py
or:
  flask --app app run --port 5001 --debug

NOTE: We default to port 5001 because macOS AirPlay Receiver hijacks
port 5000 (Control Center listens on *:5000). You can override with PORT.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

import mimetypes

from flask import Flask, Response, jsonify, request, send_file
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Wire up the calculation engine import paths.
# We add `physics_engines/core/PBS` so we can `import calculator`. The calculator
# module itself adds `RocketMassCalc/` to sys.path on import (so `helpers`
# imports work as a namespace package).
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parent.parent
_PBS_ROOT = _REPO_ROOT / "physics_engines" / "core" / "PBS"
_ENGINE_TESTS_ROOT = _REPO_ROOT / "physics_engines" / "core" / "Engine Tests"
_ENGINE_TESTS_DATA = _ENGINE_TESTS_ROOT / "data"
_TRAJ_ROOT = _REPO_ROOT / "physics_engines" / "core" / "Trajectory Simulation"
_TRAJ_OUTPUT = _TRAJ_ROOT / "output"
_DEBRIS_DATA = _TRAJ_ROOT / "debris_data"

# Decimation cap for plot data. Higher than the desktop's 5000 to give the
# user more confidence that fast features aren't being smoothed away —
# only affects the JSON sent to the browser, the CSV on disk is intact.
_TRAJ_MAX_POINTS = 10000

# Trajectory column metadata — mirror of core/gui/config.py::PLOT_PARAMS,
# plus the time index (which the desktop hard-codes as a fallback).
# `category` drives the channel-color theming on the frontend.
_PLOT_PARAMS = {
    # ── time ──
    "time_s":              {"label": "Time",                 "unit": "s",      "category": "time"},
    # ── position ──
    "height_m":            {"label": "Height",               "unit": "m",      "category": "position"},
    "lat_deg":             {"label": "Latitude",             "unit": "deg",    "category": "position"},
    "lon_deg":             {"label": "Longitude",            "unit": "deg",    "category": "position"},
    "x_ecef_m":            {"label": "X ECEF",               "unit": "m",      "category": "position"},
    "y_ecef_m":            {"label": "Y ECEF",               "unit": "m",      "category": "position"},
    "z_ecef_m":            {"label": "Z ECEF",               "unit": "m",      "category": "position"},
    "distance_m":          {"label": "Distance",             "unit": "m",      "category": "position"},
    "COM_m":               {"label": "Center of Mass",       "unit": "m",      "category": "position"},
    "z_engine_m":          {"label": "Engine Z Position",    "unit": "m",      "category": "position"},
    # ── velocity ──
    "speed_ecef_m_s":      {"label": "Speed (ECEF)",         "unit": "m/s",    "category": "velocity"},
    "vx_ecef_m_s":         {"label": "Vx ECEF",              "unit": "m/s",    "category": "velocity"},
    "vy_ecef_m_s":         {"label": "Vy ECEF",              "unit": "m/s",    "category": "velocity"},
    "vz_ecef_m_s":         {"label": "Vz ECEF",              "unit": "m/s",    "category": "velocity"},
    "vx_body_m_s":         {"label": "Vx Body",              "unit": "m/s",    "category": "velocity"},
    "vy_body_m_s":         {"label": "Vy Body",              "unit": "m/s",    "category": "velocity"},
    "vz_body_m_s":         {"label": "Vz Body",              "unit": "m/s",    "category": "velocity"},
    # ── aerodynamic ──
    "mach":                {"label": "Mach",                 "unit": "",       "category": "aero"},
    "aoa_deg":             {"label": "Angle of Attack",      "unit": "deg",    "category": "aero"},
    "density_kg_m3":       {"label": "Density",              "unit": "kg/m³",  "category": "aero"},
    "speed_of_sound_m_s":  {"label": "Speed of Sound",       "unit": "m/s",    "category": "aero"},
    "lift_x_ecef_N":       {"label": "Lift X ECEF",          "unit": "N",      "category": "aero"},
    "lift_y_ecef_N":       {"label": "Lift Y ECEF",          "unit": "N",      "category": "aero"},
    "lift_z_ecef_N":       {"label": "Lift Z ECEF",          "unit": "N",      "category": "aero"},
    "drag_x_ecef_N":       {"label": "Drag X ECEF",          "unit": "N",      "category": "aero"},
    "drag_y_ecef_N":       {"label": "Drag Y ECEF",          "unit": "N",      "category": "aero"},
    "drag_z_ecef_N":       {"label": "Drag Z ECEF",          "unit": "N",      "category": "aero"},
    # ── mass ──
    "mass_kg":             {"label": "Total Mass",           "unit": "kg",     "category": "mass"},
    "mp1_kg":              {"label": "Propellant S1",        "unit": "kg",     "category": "mass"},
    "mp2_kg":              {"label": "Propellant S2",        "unit": "kg",     "category": "mass"},
    "mp3_kg":              {"label": "Propellant S3",        "unit": "kg",     "category": "mass"},
    "propellant_mass_kg":  {"label": "Propellant Mass",      "unit": "kg",     "category": "mass"},
    # ── thrust ──
    "thrust_N":            {"label": "Thrust",               "unit": "N",      "category": "thrust"},
    "thrust_body_x_N":     {"label": "Thrust Body X",        "unit": "N",      "category": "thrust"},
    # ── inertia ──
    "I_xx_kg_m2":          {"label": "I_xx",                 "unit": "kg·m²",  "category": "inertia"},
    "I_yy_kg_m2":          {"label": "I_yy",                 "unit": "kg·m²",  "category": "inertia"},
    "I_zz_kg_m2":          {"label": "I_zz",                 "unit": "kg·m²",  "category": "inertia"},
}

# Derived/computed channels appended to the column list. They're computed
# numerically from the raw CSV before decimation so the frontend treats
# them like any other channel.
_DERIVED_PARAMS = {
    "q_pa":       {"label": "Dynamic Pressure",   "unit": "Pa", "category": "derived", "computed": True},
    "tw_ratio":   {"label": "Thrust / Weight",    "unit": "",   "category": "derived", "computed": True},
    "axial_g":    {"label": "Axial Acceleration", "unit": "g",  "category": "derived", "computed": True},
    "fpa_deg":    {"label": "Flight Path Angle",  "unit": "deg","category": "derived", "computed": True},
}

if _PBS_ROOT.is_dir() and str(_PBS_ROOT) not in sys.path:
    sys.path.insert(0, str(_PBS_ROOT))

try:
    from calculator import calculate_pbs  # noqa: E402
except Exception as exc:  # pragma: no cover - surfaced via /api/ping
    calculate_pbs = None  # type: ignore[assignment]
    _PBS_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"
else:
    _PBS_IMPORT_ERROR = None


VIDEO_EXTENSIONS = (".mp4", ".avi", ".mov", ".mkv")


app = Flask(__name__)
CORS(app)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/api/ping")
def ping():
    return jsonify(
        {
            "status": "ok",
            "time": _now_iso(),
            "engines": {
                "pbs": "ok" if calculate_pbs else f"unavailable: {_PBS_IMPORT_ERROR}",
                "engine_tests": "ok" if _ENGINE_TESTS_DATA.is_dir() else "data dir missing",
            },
        }
    )


# ---------------------------------------------------------------------------
# PBS — Product Breakdown Structure
# ---------------------------------------------------------------------------

@app.get("/api/pbs/defaults")
def pbs_defaults():
    """Return the initial parameter JSON used by the PBS forms."""
    p = _PBS_ROOT / "RocketMassCalc" / "data" / "initial_parameters.json"
    if not p.exists():
        return jsonify({})
    try:
        return jsonify(json.loads(p.read_text()))
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


def _coerce_stage_keys(stage_data):
    """JSON object keys come back as strings — calculator expects int keys
    for stage indices and the literal string "interstages" for the gaps.
    """
    if not isinstance(stage_data, dict):
        return {}
    out = {}
    for k, v in stage_data.items():
        if k == "interstages":
            out[k] = v
            continue
        try:
            out[int(k)] = v
        except (ValueError, TypeError):
            out[k] = v
    return out


@app.post("/api/pbs/calculate")
def pbs_calculate():
    if calculate_pbs is None:
        return jsonify({"error": f"PBS engine unavailable: {_PBS_IMPORT_ERROR}"}), 503

    payload = request.get_json(silent=True) or {}
    try:
        num_stages = int(payload.get("num_stages", 1))
    except (ValueError, TypeError):
        return jsonify({"error": "num_stages must be an integer"}), 400
    if not 1 <= num_stages <= 4:
        return jsonify({"error": "num_stages must be in [1, 4]"}), 400

    stage_data = _coerce_stage_keys(payload.get("stage_data", {}))

    try:
        result = calculate_pbs(stage_data, num_stages)
    except Exception as exc:
        return (
            jsonify(
                {
                    "error": str(exc),
                    "type": type(exc).__name__,
                    "traceback": traceback.format_exc(limit=8),
                }
            ),
            500,
        )

    if isinstance(result, dict) and "stages" in result:
        result["stages"] = {str(k): v for k, v in result["stages"].items()}

    return jsonify(result)


# ---------------------------------------------------------------------------
# Engine Tests
# ---------------------------------------------------------------------------

def _list_test_folders():
    if not _ENGINE_TESTS_DATA.is_dir():
        return []
    return sorted(
        (p for p in _ENGINE_TESTS_DATA.iterdir()
         if p.is_dir() and not p.name.startswith(".")),
        key=lambda p: p.name,
    )


def _resolve_test_folder(name: str) -> Path | None:
    """Resolve a test folder by name, validating it stays inside the data dir."""
    if not name:
        return None
    candidate = (_ENGINE_TESTS_DATA / name).resolve()
    try:
        candidate.relative_to(_ENGINE_TESTS_DATA.resolve())
    except ValueError:
        return None
    return candidate if candidate.is_dir() else None


def _classify_files(folder: Path) -> tuple[list[Path], list[Path]]:
    tdms = sorted(folder.glob("*.tdms"))
    videos = sorted(
        f for f in folder.iterdir()
        if f.is_file() and f.suffix.lower() in VIDEO_EXTENSIONS
    )
    return tdms, videos


def _file_meta(path: Path) -> dict:
    try:
        st = path.stat()
        return {
            "name": path.name,
            "size_bytes": st.st_size,
            "mtime": st.st_mtime,
        }
    except OSError:
        return {"name": path.name, "size_bytes": 0, "mtime": 0}


@app.get("/api/engine/tests")
def engine_tests_list():
    folders = _list_test_folders()
    out = []
    for folder in folders:
        tdms, videos = _classify_files(folder)
        out.append(
            {
                "name": folder.name,
                "tdms_count": len(tdms),
                "video_count": len(videos),
            }
        )
    return jsonify({"data_dir": str(_ENGINE_TESTS_DATA), "tests": out})


@app.get("/api/engine/tests/<path:name>")
def engine_test_detail(name: str):
    folder = _resolve_test_folder(name)
    if folder is None:
        return jsonify({"error": f"test folder not found: {name}"}), 404
    tdms, videos = _classify_files(folder)
    return jsonify(
        {
            "name": folder.name,
            "tdms_files": [_file_meta(p) for p in tdms],
            "video_files": [_file_meta(p) for p in videos],
        }
    )


_TDMS_CHANNEL_FILTER = ("Voltage", "Current")


@app.get("/api/engine/tests/<path:name>/tdms/<path:file_name>")
def engine_test_tdms(name: str, file_name: str):
    """Load a single TDMS file's 'AI Channels' group and return channel arrays.

    Filters out 'Voltage' / 'Current' channels (matching the desktop GUI).
    """
    folder = _resolve_test_folder(name)
    if folder is None:
        return jsonify({"error": f"test folder not found: {name}"}), 404

    candidate = (folder / file_name).resolve()
    try:
        candidate.relative_to(folder.resolve())
    except ValueError:
        return jsonify({"error": "invalid file path"}), 400
    if not candidate.is_file():
        return jsonify({"error": f"file not found: {file_name}"}), 404
    if candidate.suffix.lower() != ".tdms":
        return jsonify({"error": "expected a .tdms file"}), 400

    try:
        from nptdms import TdmsFile
        import numpy as np
    except ImportError as exc:
        return jsonify({"error": f"nptdms/numpy unavailable: {exc}"}), 503

    t0 = time.perf_counter()
    channels: dict[str, dict] = {}

    try:
        with TdmsFile.open(str(candidate)) as tdms_file:
            try:
                ai_group = tdms_file["AI Channels"]
            except KeyError:
                groups = [g.name for g in tdms_file.groups()]
                return jsonify(
                    {"error": "'AI Channels' group not found",
                     "groups_available": groups}
                ), 422

            for ch in ai_group.channels():
                if any(kw in ch.name for kw in _TDMS_CHANNEL_FILTER):
                    continue
                try:
                    arr = np.asarray(ch[:], dtype=np.float64)
                except Exception:
                    continue
                # NaN/Inf are not JSON-encodable; replace with None.
                arr = np.where(np.isfinite(arr), arr, np.nan)
                clean = arr.tolist()
                clean = [
                    None if (v is None or v != v) else float(v)  # NaN check
                    for v in clean
                ]
                finite = arr[np.isfinite(arr)]
                channels[ch.name] = {
                    "data": clean,
                    "length": len(clean),
                    "min": float(finite.min()) if finite.size else None,
                    "max": float(finite.max()) if finite.size else None,
                    "mean": float(finite.mean()) if finite.size else None,
                }
    except Exception as exc:
        return (
            jsonify(
                {
                    "error": str(exc),
                    "type": type(exc).__name__,
                }
            ),
            500,
        )

    elapsed = time.perf_counter() - t0
    return jsonify(
        {
            "test_name": folder.name,
            "file_name": candidate.name,
            "channel_count": len(channels),
            "load_time_s": round(elapsed, 3),
            "channels": channels,
        }
    )


# ---------------------------------------------------------------------------
# Trajectory Simulation — plot data
# ---------------------------------------------------------------------------

def _compute_derived_channels(df, np):
    """Append the derived channels listed in `_DERIVED_PARAMS` to `df`
    in-place. Each computation is guarded by the columns it needs so a
    truncated/older CSV still loads — the corresponding channel just
    doesn't appear."""
    g0 = 9.80665

    if {"density_kg_m3", "speed_ecef_m_s"}.issubset(df.columns):
        df["q_pa"] = 0.5 * df["density_kg_m3"] * df["speed_ecef_m_s"] ** 2

    if {"thrust_N", "mass_kg"}.issubset(df.columns):
        with np.errstate(divide="ignore", invalid="ignore"):
            tw = df["thrust_N"].to_numpy() / (df["mass_kg"].to_numpy() * g0)
        tw[~np.isfinite(tw)] = np.nan
        df["tw_ratio"] = tw

    if {"speed_ecef_m_s", "time_s"}.issubset(df.columns) and len(df) >= 2:
        t = df["time_s"].to_numpy()
        v = df["speed_ecef_m_s"].to_numpy()
        df["axial_g"] = np.gradient(v, t) / g0

    needed = {"x_ecef_m", "y_ecef_m", "z_ecef_m",
              "vx_ecef_m_s", "vy_ecef_m_s", "vz_ecef_m_s",
              "speed_ecef_m_s"}
    if needed.issubset(df.columns):
        x = df["x_ecef_m"].to_numpy()
        y = df["y_ecef_m"].to_numpy()
        z = df["z_ecef_m"].to_numpy()
        r = np.sqrt(x * x + y * y + z * z)
        with np.errstate(divide="ignore", invalid="ignore"):
            v_radial = (
                df["vx_ecef_m_s"].to_numpy() * x
                + df["vy_ecef_m_s"].to_numpy() * y
                + df["vz_ecef_m_s"].to_numpy() * z
            ) / r
            sin_fpa = np.clip(v_radial / df["speed_ecef_m_s"].to_numpy(), -1, 1)
        df["fpa_deg"] = np.degrees(np.arcsin(sin_fpa))


def _detect_flight_events(df, config, np):
    """Pick out the moments engineers care about — stage cutoffs,
    fairing release, max-Q, apogee — and return them sorted by time.

    Detected on the *full* CSV (before decimation) so the timestamps
    are accurate to the simulator's own resolution."""
    if "time_s" not in df.columns:
        return []
    t_arr = df["time_s"].to_numpy()
    events: list[dict] = []

    # Stage cutoffs: each `mp{n}_kg` first time it drops below 1 % of
    # its initial loaded mass. (Reading "first below threshold" instead
    # of strict zero so unburned-fraction physics doesn't hide the event.)
    for n in (1, 2, 3):
        col = f"mp{n}_kg"
        if col not in df.columns:
            continue
        mp = df[col].to_numpy()
        if not np.any(np.isfinite(mp)):
            continue
        initial = np.nanmax(mp)
        if initial <= 0:
            continue
        threshold = max(initial * 0.01, 1e-6)
        below = np.where(mp <= threshold)[0]
        if below.size == 0:
            continue
        i = int(below[0])
        events.append({
            "t":     float(t_arr[i]),
            "label": f"S{n} cutoff",
            "kind":  "stage_cutoff",
            "stage": n,
        })

    # Fairing release — height crosses the configured threshold.
    if config and "height_m" in df.columns:
        min_alt = (
            (config.get("fairing_release_conditions") or {}).get("min_altitude")
            or 0
        )
        if min_alt > 0:
            h = df["height_m"].to_numpy()
            crossed = np.where(h >= min_alt)[0]
            if crossed.size > 0:
                i = int(crossed[0])
                events.append({
                    "t":     float(t_arr[i]),
                    "label": "Fairing",
                    "kind":  "fairing",
                })

    # Max dynamic pressure
    if {"density_kg_m3", "speed_ecef_m_s"}.issubset(df.columns):
        q = 0.5 * df["density_kg_m3"].to_numpy() * df["speed_ecef_m_s"].to_numpy() ** 2
        finite_mask = np.isfinite(q)
        if finite_mask.any():
            i = int(np.nanargmax(np.where(finite_mask, q, -np.inf)))
            events.append({
                "t":     float(t_arr[i]),
                "label": "Max-Q",
                "kind":  "max_q",
                "value": float(q[i]),
            })

    # Apogee
    if "height_m" in df.columns:
        h = df["height_m"].to_numpy()
        finite_mask = np.isfinite(h)
        if finite_mask.any():
            i = int(np.nanargmax(np.where(finite_mask, h, -np.inf)))
            events.append({
                "t":     float(t_arr[i]),
                "label": "Apogee",
                "kind":  "apogee",
                "value": float(h[i]),
            })

    return sorted(events, key=lambda e: e["t"])


def _load_run_meta(csv_path: Path) -> dict:
    """Surface the run config + CSV freshness for the run-meta header.
    Best-effort: anything missing is just left out of the response."""
    meta: dict = {}
    try:
        meta["finished_at"] = datetime.fromtimestamp(
            csv_path.stat().st_mtime, timezone.utc
        ).isoformat()
    except OSError:
        pass
    cfg_path = _TRAJ_ROOT / "json_files" / "_current.json"
    if cfg_path.exists():
        try:
            with open(cfg_path) as f:
                cfg = json.load(f)
            meta["config"] = {
                k: cfg.get(k)
                for k in (
                    "simulation_time",
                    "no_of_stages",
                    "lat_launch",
                    "lon_launch",
                    "final_payload_mass",
                )
                if k in cfg
            }
            min_alt = (
                (cfg.get("fairing_release_conditions") or {})
                .get("min_altitude")
            )
            if min_alt is not None:
                meta["config"]["fairing_min_altitude"] = min_alt
        except (OSError, json.JSONDecodeError):
            pass
    return meta


@app.get("/api/trajectory/output")
def trajectory_output():
    """Read `output/simulation_output.csv` from the desktop trajectory dir,
    decimate to ≤MAX_POINTS rows (matching the desktop plot page), and
    return the numeric columns with metadata (label, unit, min, max,
    category), plus computed channels (q, T/W, axial-G, FPA), detected
    flight events, and a small run-config summary.

    Returns 200 with `exists: false` when the CSV hasn't been generated
    yet, so the client can show an empty state without treating it as an
    error condition.
    """
    csv_path = _TRAJ_OUTPUT / "simulation_output.csv"
    if not csv_path.exists():
        return jsonify(
            {
                "exists": False,
                "message": "No simulation output yet. Run a trajectory simulation first.",
                "path": str(csv_path),
            }
        )

    try:
        import pandas as pd
        import numpy as np
    except ImportError as exc:
        return jsonify({"error": f"pandas/numpy unavailable: {exc}"}), 503

    t0 = time.perf_counter()
    try:
        df = pd.read_csv(csv_path)
    except Exception as exc:
        return (
            jsonify({"error": str(exc), "type": type(exc).__name__}),
            500,
        )

    # Compute derived channels and detect events on the *full* data so we
    # don't quantize event timestamps or smear out fast features (like
    # max-Q) before measurement.
    _compute_derived_channels(df, np)

    # Load run config now (we want it for both event detection and the
    # response), then look for events.
    cfg_path = _TRAJ_ROOT / "json_files" / "_current.json"
    config: dict = {}
    if cfg_path.exists():
        try:
            with open(cfg_path) as f:
                config = json.load(f)
        except (OSError, json.JSONDecodeError):
            config = {}
    events = _detect_flight_events(df, config, np)

    original_count = int(len(df))
    if original_count > _TRAJ_MAX_POINTS:
        factor = max(1, original_count // _TRAJ_MAX_POINTS)
        df = df.iloc[::factor].reset_index(drop=True)
    decimation_factor = (
        max(1, original_count // len(df)) if len(df) > 0 else 1
    )

    numeric_cols = [
        c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])
    ]

    columns: dict[str, dict] = {}
    for col in numeric_cols:
        arr = df[col].to_numpy(dtype=np.float64)
        # NaN/Inf aren't JSON-encodable — replace with None on the way out.
        arr = np.where(np.isfinite(arr), arr, np.nan)
        finite = arr[np.isfinite(arr)]
        clean = [None if (v != v) else float(v) for v in arr.tolist()]
        meta = _PLOT_PARAMS.get(col) or _DERIVED_PARAMS.get(col) or {}
        columns[col] = {
            "data":     clean,
            "label":    meta.get("label", col),
            "unit":     meta.get("unit", ""),
            "category": meta.get("category", "other"),
            "computed": bool(meta.get("computed", False)),
            "min":      float(finite.min()) if finite.size else None,
            "max":      float(finite.max()) if finite.size else None,
        }

    default_x = (
        "time_s"
        if "time_s" in columns
        else (numeric_cols[0] if numeric_cols else None)
    )
    elapsed = time.perf_counter() - t0

    return jsonify(
        {
            "exists":             True,
            "row_count":          int(len(df)),
            "original_row_count": original_count,
            "decimation_factor":  int(decimation_factor),
            "default_x":          default_x,
            "columns":            columns,
            "events":             events,
            "run_meta":           _load_run_meta(csv_path),
            "load_time_s":        round(elapsed, 3),
        }
    )


# ---------------------------------------------------------------------------
# Trajectory Simulation — run / poll / cancel
# ---------------------------------------------------------------------------
#
# Lightweight subprocess runner mirroring core/gui/subprocess_runner.py.
# Spawns `src/simulation.py` with a JSON config, parses `PROGRESS:<pct>`
# lines on stdout, and exposes the run state via a polling endpoint.
#
# State is held in a process-wide dict keyed by `run_id`. The simulation
# itself runs as a child process so it doesn't block the Flask worker.
# ---------------------------------------------------------------------------

_active_runs: dict[str, dict] = {}
_runs_lock = threading.Lock()
_PHASE_LABELS = ("Initializing", "Simulating", "Saving results")
_LOG_BUFFER_MAX = 400


def _phase_for_progress(p: float) -> str:
    if p < 0.03:
        return _PHASE_LABELS[0]
    if p < 0.93:
        return _PHASE_LABELS[1]
    return _PHASE_LABELS[2]


def _read_simulation_output(run_id: str):
    """Background reader: drain stdout/stderr from the simulation subprocess,
    parse `PROGRESS:` lines, and update the shared state dict."""
    with _runs_lock:
        run = _active_runs.get(run_id)
    if not run:
        return
    proc: subprocess.Popen = run["proc"]

    log_lines: list[str] = []
    stderr_lines: list[str] = []

    def _drain_stderr():
        try:
            for raw in proc.stderr:                       # type: ignore[union-attr]
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip()
                stderr_lines.append(line)
                if len(stderr_lines) > _LOG_BUFFER_MAX:
                    del stderr_lines[: len(stderr_lines) - _LOG_BUFFER_MAX]
        except Exception:
            pass

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    try:
        for raw in proc.stdout:                            # type: ignore[union-attr]
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").rstrip()
            log_lines.append(line)
            if len(log_lines) > _LOG_BUFFER_MAX:
                del log_lines[: len(log_lines) - _LOG_BUFFER_MAX]

            if line.startswith("PROGRESS:"):
                try:
                    pct = float(line.split(":", 1)[1].strip().rstrip("%"))
                except (ValueError, IndexError):
                    pct = None
                if pct is not None:
                    progress = max(0.0, min(pct / 100.0, 1.0))
                    with _runs_lock:
                        if run_id in _active_runs:
                            _active_runs[run_id]["progress"] = progress
                            _active_runs[run_id]["phase"] = _phase_for_progress(progress)

            with _runs_lock:
                if run_id in _active_runs:
                    _active_runs[run_id]["log_lines"] = list(log_lines[-60:])
    except Exception as exc:
        log_lines.append(f"[reader error: {exc}]")

    stderr_thread.join(timeout=2)
    proc.wait()

    with _runs_lock:
        run = _active_runs.get(run_id)
        if not run:
            return
        run["elapsed_s"] = time.perf_counter() - run["start_time"]
        run["log_lines"] = list(log_lines[-60:])
        if run["status"] == "cancelled":
            return
        if proc.returncode == 0:
            run["status"] = "success"
            run["progress"] = 1.0
            run["phase"] = "Complete"
            # Warm the raw-data cache in the background so the user's
            # first /trajectory/raw click doesn't have to wait for the
            # cold CSV read. ~1-3 s of background work that happens
            # while the user is looking at the success cards anyway.
            threading.Thread(
                target=_load_full_trajectory_df, daemon=True
            ).start()
        else:
            run["status"] = "failed"
            tail = stderr_lines[-12:] if stderr_lines else log_lines[-12:]
            run["error_msg"] = (
                "\n".join(tail).strip()
                or f"simulation.py exited with code {proc.returncode}"
            )


_TRAJ_PRESETS_DIR = _TRAJ_ROOT / "json_files" / "presets"
_TRAJ_DEBRIS_PRESETS_DIR = _TRAJ_ROOT / "json_files" / "debris_presets"


@app.get("/api/trajectory/presets")
def trajectory_list_presets():
    """List every preset JSON living in `json_files/presets/`.

    Returns: `{ presets: [{ name, data }, …] }` where `name` is the
    file stem (no `.json`) and `data` is the parsed JSON body. Bad /
    unparseable files are skipped silently.
    """
    out = []
    if _TRAJ_PRESETS_DIR.exists():
        for p in sorted(_TRAJ_PRESETS_DIR.glob("*.json")):
            try:
                with open(p) as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    out.append({"name": p.stem, "data": data})
            except (OSError, ValueError):
                # Corrupt or unreadable preset — drop it from the list
                # rather than failing the whole listing.
                continue
    return jsonify({"presets": out})


@app.post("/api/trajectory/presets")
def trajectory_save_preset():
    """Save a config payload as a new preset on disk.

    Body: `{ name: str, payload: dict, overwrite?: bool }`.
    Returns `{ saved_name }` on success. On a name conflict without
    `overwrite=true` returns 409 with `{ error, exists: true, name }`
    so the frontend can prompt the user before retrying.

    Mirrors the desktop `save_parameters()` logic in
    `traj_pages/page.py`: same name sanitization, same target dir.
    """
    body = request.get_json(silent=True) or {}
    raw_name = (body.get("name") or "").strip()
    if not raw_name:
        return jsonify({"error": "Preset name is required"}), 400
    payload = body.get("payload")
    if not isinstance(payload, dict) or not payload:
        return jsonify({"error": "Preset payload is missing or invalid"}), 400

    # Sanitize — keep alnum, dash, underscore, dot, space; drop anything
    # else (mirrors the desktop's whitelist exactly).
    safe = "".join(
        c if (c.isalnum() or c in "-_. ") else "_" for c in raw_name
    ).strip() or "preset"

    target = _TRAJ_PRESETS_DIR / f"{safe}.json"
    if target.exists() and not body.get("overwrite", False):
        return (
            jsonify({
                "error": f"A preset named '{safe}' already exists",
                "exists": True,
                "name": safe,
            }),
            409,
        )

    try:
        _TRAJ_PRESETS_DIR.mkdir(parents=True, exist_ok=True)
        with open(target, "w") as f:
            json.dump(payload, f, indent=2)
    except OSError as exc:
        return jsonify({"error": f"Could not write preset: {exc}"}), 500

    return jsonify({"saved_name": safe})


# ── Debris analysis presets ────────────────────────────────────────
#
# Same shape and semantics as the trajectory preset endpoints above,
# but writes/reads from `json_files/debris_presets/` so the two preset
# libraries are independent. Frontend talks to these through
# `listDebrisPresets()` / `saveDebrisPreset()` in `services/api.js`.

@app.get("/api/debris/presets")
def debris_list_presets():
    """List every preset JSON in `json_files/debris_presets/`.

    Returns: `{ presets: [{ name, data }, …] }` — same shape as the
    trajectory preset list, so the frontend's preset picker can ingest
    either without branching.
    """
    out = []
    if _TRAJ_DEBRIS_PRESETS_DIR.exists():
        for p in sorted(_TRAJ_DEBRIS_PRESETS_DIR.glob("*.json")):
            try:
                with open(p) as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    out.append({"name": p.stem, "data": data})
            except (OSError, ValueError):
                continue
    return jsonify({"presets": out})


@app.post("/api/debris/presets")
def debris_save_preset():
    """Save a debris param dict as a preset on disk.

    Body: `{ name: str, payload: dict, overwrite?: bool }`.
    Returns `{ saved_name }` on success, or 409 with `{ exists: true,
    name }` on a name conflict without `overwrite=true`. Sanitisation
    rules are identical to the trajectory preset save so the user
    sees one consistent naming policy across both libraries.
    """
    body = request.get_json(silent=True) or {}
    raw_name = (body.get("name") or "").strip()
    if not raw_name:
        return jsonify({"error": "Preset name is required"}), 400
    payload = body.get("payload")
    if not isinstance(payload, dict) or not payload:
        return jsonify({"error": "Preset payload is missing or invalid"}), 400

    safe = "".join(
        c if (c.isalnum() or c in "-_. ") else "_" for c in raw_name
    ).strip() or "preset"

    target = _TRAJ_DEBRIS_PRESETS_DIR / f"{safe}.json"
    if target.exists() and not body.get("overwrite", False):
        return (
            jsonify({
                "error": f"A debris preset named '{safe}' already exists",
                "exists": True,
                "name": safe,
            }),
            409,
        )

    try:
        _TRAJ_DEBRIS_PRESETS_DIR.mkdir(parents=True, exist_ok=True)
        with open(target, "w") as f:
            json.dump(payload, f, indent=2)
    except OSError as exc:
        return jsonify({"error": f"Could not write debris preset: {exc}"}), 500

    return jsonify({"saved_name": safe})


# ── Load existing simulation data (mirrors desktop `_load_simulation`) ──

_TRAJ_PRELOADED_DIR = _TRAJ_ROOT / "Pre-loaded Trajectories"

# ── Compare file cache ──────────────────────────────────────────────
# XLSX files in `Pre-loaded Trajectories/` take 5–15 seconds for
# openpyxl to parse, which is the dominant cost on first paint of
# the Compare page. We solve it with a two-tier cache:
#
#   • L1 — in-memory `{ str(path): (mtime, df) }`. Instant after
#          the first parse; survives only the process lifetime.
#   • L2 — Feather (Arrow IPC) sidecar files in a hidden cache dir
#          next to the source. Reading a Feather is millisecond-
#          fast (mmappable binary), so once a file has been parsed
#          once *ever*, subsequent backend restarts are also fast.
#
# Mtime-based invalidation: if the source XLSX/CSV is rewritten,
# the L1 entry's `mtime` no longer matches and the L2 cache file
# (which encodes the source mtime in its name) is stale.
_COMPARE_CACHE_DIR = _TRAJ_OUTPUT / ".compare_cache"
_COMPARE_DF_CACHE: dict = {}  # str(path) -> (mtime, df)


def _compare_cache_path(source: Path, mtime: float, ext: str) -> Path:
    """Stable-name cache sidecar for `source`. Encoding the mtime
    in the filename means a stale cache file simply doesn't match
    what the lookup expects; we don't need a separate manifest.

    `ext` is the format ('feather' or 'pkl'). We prefer Feather but
    fall back to pickle when pyarrow isn't installed in the backend
    venv — pickle is stdlib so it always works.
    """
    safe = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in source.name)
    return _COMPARE_CACHE_DIR / f"{safe}__{int(mtime)}.{ext}"


def _load_compare_df(path: Path):
    """Return the file at `path` as a pandas DataFrame, cached.

    Cache hierarchy: L1 in-memory → L2 Feather sidecar → source XLSX/CSV.
    Returns None on any error (caller surfaces the failure).
    """
    import pandas as pd

    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None

    key = str(path)

    # L1: in-memory.
    cached = _COMPARE_DF_CACHE.get(key)
    if cached is not None and cached[0] == mtime:
        return cached[1]

    # L2: on-disk sidecar — try Feather first (faster, mmappable),
    # fall back to pickle (stdlib, no extra deps). Mtime encoded in
    # the filename means stale files just don't match the lookup.
    feather_path = _compare_cache_path(path, mtime, "feather")
    pickle_path  = _compare_cache_path(path, mtime, "pkl")
    if feather_path.exists():
        try:
            df = pd.read_feather(feather_path)
            _COMPARE_DF_CACHE[key] = (mtime, df)
            return df
        except Exception:
            try: feather_path.unlink()
            except OSError: pass
    if pickle_path.exists():
        try:
            df = pd.read_pickle(pickle_path)
            _COMPARE_DF_CACHE[key] = (mtime, df)
            return df
        except Exception:
            try: pickle_path.unlink()
            except OSError: pass

    # Cold path: parse the source. ~5–15s for big xlsx.
    try:
        if path.suffix.lower() == ".csv":
            try:
                df = pd.read_csv(path, engine="pyarrow")
            except Exception:
                df = pd.read_csv(path, low_memory=False)
        elif path.suffix.lower() == ".xlsx":
            df = pd.read_excel(path)
        else:
            return None
    except Exception:
        return None

    _COMPARE_DF_CACHE[key] = (mtime, df)

    # Best-effort sidecar write. Try Feather first; if pyarrow isn't
    # installed in the backend venv, fall back to pickle. Either way,
    # subsequent restarts skip the expensive XLSX parse entirely.
    try:
        _COMPARE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        # Drop older cache files for this source — different mtimes
        # would otherwise pile up forever.
        prefix = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in path.name) + "__"
        for old in _COMPARE_CACHE_DIR.glob(f"{prefix}*"):
            if old not in (feather_path, pickle_path):
                try: old.unlink()
                except OSError: pass
        try:
            df.to_feather(feather_path)
        except Exception:
            df.to_pickle(pickle_path)
    except Exception:
        pass

    return df


def _prewarm_compare_cache():
    """Background pre-warm: parse every preloaded file once on startup.

    Runs in a daemon thread so the backend is responsive immediately;
    by the time the user opens the Compare page (typically tens of
    seconds later), most/all files are already in the cache.
    Files with an up-to-date Feather sidecar from a previous run
    short-circuit the parse and just populate L1.
    """
    if not _TRAJ_PRELOADED_DIR.exists():
        return
    candidates = [
        p for p in _TRAJ_PRELOADED_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in {".csv", ".xlsx"} and not p.name.startswith(".")
    ]
    for p in candidates:
        try:
            _load_compare_df(p)
        except Exception:
            continue


# Spawn the pre-warm — daemon so it doesn't block shutdown.
threading.Thread(target=_prewarm_compare_cache, daemon=True).start()


@app.post("/api/trajectory/load")
def trajectory_load_file():
    """Replace `output/simulation_output.csv` with an uploaded CSV/XLSX.

    Mirrors desktop `_load_simulation` in `_actions.py`: read the file,
    validate it has ≥ 2 rows and ≥ 1 numeric column, persist as the new
    simulation output that every other page reads from, drop the stale
    xlsx export, and warm the in-memory cache so the first /raw call
    after this is instant.

    Body: multipart/form-data with a `file` field.
    Returns: `{ rows, name }` on success.
    """
    import pandas as pd

    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify({"error": "No file uploaded"}), 400

    name = Path(f.filename).name
    suffix = Path(name).suffix.lower()
    if suffix not in {".csv", ".xlsx"}:
        return jsonify({
            "error": f"Unsupported file type '{suffix}'. Use .csv or .xlsx",
        }), 400

    try:
        if suffix == ".csv":
            df = pd.read_csv(f)
        else:
            df = pd.read_excel(f)
    except Exception as exc:
        return jsonify({"error": f"Could not read file: {exc}"}), 400

    numeric_cols = [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]
    if not numeric_cols:
        return jsonify({"error": "No numeric columns found in the file"}), 400
    if len(df) < 2:
        return jsonify({"error": "File contains fewer than 2 data rows"}), 400

    out = _TRAJ_OUTPUT / "simulation_output.csv"
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(out, index=False)
    except OSError as exc:
        return jsonify({"error": f"Could not save: {exc}"}), 500

    # Stale xlsx — desktop deletes it so any subsequent Excel export
    # rederives from the just-loaded CSV.
    xlsx_out = _TRAJ_OUTPUT / "simulation_output.xlsx"
    if xlsx_out.exists():
        try: xlsx_out.unlink()
        except OSError: pass

    # Invalidate the in-memory CSV cache and immediately rewarm so the
    # next /raw call avoids a parse round-trip.
    _TRAJ_RAW_CACHE["mtime"] = 0.0
    _TRAJ_RAW_CACHE["df"] = None
    threading.Thread(target=_load_full_trajectory_df, daemon=True).start()

    return jsonify({"rows": int(len(df)), "name": name})


# ── Save current sim into Pre-loaded Trajectories ──────────────────
#
# Companion to `/api/trajectory/load`. Snapshots whatever is currently
# in `output/simulation_output.csv` into the `Pre-loaded Trajectories/`
# folder under a user-supplied name, so it shows up in:
#   - the "Saved Simulations" list inside the Load Simulation modal
#   - the Compare page's reference set
#
# Output format is XLSX (matches what the existing Pre-loaded files use,
# which keeps the Compare page's caching layer fully reusable). Name
# sanitisation + 409-on-conflict mirror Save Preset for UI consistency.

@app.post("/api/trajectory/save-current")
def trajectory_save_current():
    """Snapshot the current simulation_output.csv into Pre-loaded
    Trajectories/<name>.xlsx, where it becomes available to the
    "Load Simulation" picker and the Compare page.

    Body: `{ name: str, overwrite?: bool }`.
    Returns: `{ saved_name }` on success.
            409 + `{ exists: true, name }` on conflict without overwrite.
    """
    import pandas as pd

    src = _TRAJ_OUTPUT / "simulation_output.csv"
    if not src.exists():
        return jsonify({
            "error": (
                "No simulation to save — run or load a trajectory first."
            ),
        }), 404

    body = request.get_json(silent=True) or {}
    raw_name = (body.get("name") or "").strip()
    if not raw_name:
        return jsonify({"error": "A name is required"}), 400

    # Same sanitisation rule as Save Preset — alnum, dash, underscore,
    # dot, space; everything else collapses to underscore. Keeps the
    # filename safe across macOS / Windows / Linux without surprising
    # the user.
    safe = "".join(
        c if (c.isalnum() or c in "-_. ") else "_" for c in raw_name
    ).strip() or "simulation"
    # Strip a trailing `.xlsx` / `.csv` if the user typed one — we
    # always write XLSX for compatibility with the existing Pre-loaded
    # file set, regardless of what they typed.
    for suff in (".xlsx", ".csv"):
        if safe.lower().endswith(suff):
            safe = safe[: -len(suff)]
            break

    target = _TRAJ_PRELOADED_DIR / f"{safe}.xlsx"
    if target.exists() and not body.get("overwrite", False):
        return (
            jsonify({
                "error": f"A saved simulation named '{safe}' already exists",
                "exists": True,
                "name": safe,
            }),
            409,
        )

    try:
        _TRAJ_PRELOADED_DIR.mkdir(parents=True, exist_ok=True)
        df = pd.read_csv(src)
        df.to_excel(target, index=False, engine="openpyxl")
    except Exception as exc:                 # noqa: BLE001 — surface to UI
        return jsonify({"error": f"Could not save: {exc}"}), 500

    # Keep the Compare page's two-tier cache honest about the new file.
    # `_load_compare_df` keys on (path, mtime), so the next compare
    # request will parse fresh; pre-warming here just avoids the user
    # waiting on the first hover.
    try:
        threading.Thread(
            target=_load_compare_df, args=(target,), daemon=True,
        ).start()
    except Exception:                         # noqa: BLE001
        pass

    return jsonify({"saved_name": safe, "filename": target.name})


# ── Load a previously-saved simulation by filename ─────────────────
#
# For files that already live on the server (Pre-loaded Trajectories/
# entries — either shipped with the repo or saved via the endpoint
# above). The file-upload variant at `/load` stays available for
# CSVs/XLSXs the user wants to bring in from outside the app.

@app.post("/api/trajectory/load-saved")
def trajectory_load_saved():
    """Load a `Pre-loaded Trajectories/<filename>` file as the new
    `output/simulation_output.csv`.

    Body: `{ filename: str }` — must be a basename inside
    Pre-loaded Trajectories/, no traversal.
    Returns: `{ rows, name }` on success.
    """
    import pandas as pd

    body = request.get_json(silent=True) or {}
    fname = (body.get("filename") or "").strip()
    if not fname:
        return jsonify({"error": "filename is required"}), 400

    # Resolve + assert the resolved path is inside Pre-loaded Trajectories.
    # Mirrors the path-traversal guard used by the compare endpoints.
    candidate = (_TRAJ_PRELOADED_DIR / fname).resolve()
    try:
        candidate.relative_to(_TRAJ_PRELOADED_DIR.resolve())
    except ValueError:
        return jsonify({"error": "Path traversal blocked"}), 403
    if not candidate.exists() or not candidate.is_file():
        return jsonify({"error": f"No such saved simulation: {fname}"}), 404

    suffix = candidate.suffix.lower()
    if suffix not in {".csv", ".xlsx"}:
        return jsonify({
            "error": f"Unsupported file type '{suffix}'. Use .csv or .xlsx",
        }), 400

    try:
        if suffix == ".csv":
            df = pd.read_csv(candidate)
        else:
            df = pd.read_excel(candidate)
    except Exception as exc:                 # noqa: BLE001
        return jsonify({"error": f"Could not read file: {exc}"}), 400

    numeric_cols = [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]
    if not numeric_cols:
        return jsonify({"error": "No numeric columns in file"}), 400
    if len(df) < 2:
        return jsonify({"error": "File contains fewer than 2 data rows"}), 400

    out = _TRAJ_OUTPUT / "simulation_output.csv"
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(out, index=False)
    except OSError as exc:
        return jsonify({"error": f"Could not save: {exc}"}), 500

    # Same cache-invalidation dance as the file-upload /load endpoint
    # so the Plot/Map/Raw pages reflect the just-loaded data.
    xlsx_out = _TRAJ_OUTPUT / "simulation_output.xlsx"
    if xlsx_out.exists():
        try: xlsx_out.unlink()
        except OSError: pass
    _TRAJ_RAW_CACHE["mtime"] = 0.0
    _TRAJ_RAW_CACHE["df"] = None
    threading.Thread(target=_load_full_trajectory_df, daemon=True).start()

    return jsonify({"rows": int(len(df)), "name": candidate.name})


# ── Rocket structure (3D viewer source data) ────────────────────────

_TRAJ_ROCKET_DATA = _TRAJ_ROOT / "src" / "sketch" / "rocket_data.json"


@app.get("/api/trajectory/rocket-structure")
def trajectory_rocket_structure():
    """Return the dimensional payload that drives the 3D rocket viewer.

    Mirrors what the desktop's `_view_rocket_structure` action reads
    before opening the Three.js viewer: a flat dict of stage / payload
    / fairing geometry (lengths, radii, propellant masses) written by
    `generate_sketch.py` at the end of every successful sim run.

    Returns 404 with a helpful message if no sim has produced the file
    yet — the frontend uses this to show "Run a simulation first"
    instead of an error.
    """
    if not _TRAJ_ROCKET_DATA.exists():
        return jsonify({
            "exists": False,
            "message": (
                "No rocket structure data yet. Run a simulation first — "
                "the geometry is computed and saved during the sim run."
            ),
        }), 404
    try:
        with open(_TRAJ_ROCKET_DATA) as f:
            data = json.load(f)
        if not isinstance(data, dict) or not data:
            raise ValueError("rocket_data.json is empty or not a dict")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return jsonify({"error": f"Could not read rocket_data.json: {exc}"}), 500
    return jsonify({"exists": True, "data": data})


# ── Compare (overlay multiple sim files) ─────────────────────────────

@app.get("/api/trajectory/compare/files")
def trajectory_compare_list_files():
    """List `.csv` / `.xlsx` files in the Pre-loaded Trajectories folder.

    The current sim's `simulation_output.csv` is included first under
    the synthetic name "Current run" so the user can overlay the
    just-finished sim against the reference set. Mirrors desktop
    `_open_compare`'s file scan.
    """
    out = []
    cur = _TRAJ_OUTPUT / "simulation_output.csv"
    if cur.exists():
        out.append({
            "name": "Current run",
            "filename": "__current__",
            "kind": "current",
        })

    if _TRAJ_PRELOADED_DIR.exists():
        preloaded = []
        for p in sorted(_TRAJ_PRELOADED_DIR.iterdir()):
            if p.suffix.lower() in {".csv", ".xlsx"} and not p.name.startswith("."):
                preloaded.append({
                    "name": p.stem,
                    "filename": p.name,
                    "kind": "preloaded",
                })
        preloaded.sort(key=lambda x: x["name"].lower())
        out.extend(preloaded)

    return jsonify({"files": out})


@app.get("/api/trajectory/compare/data")
def trajectory_compare_data():
    """Return decimated data for one named file from the Compare set.

    Query: `?file=<filename>`. Use the synthetic name `__current__`
    to fetch the current sim's `simulation_output.csv`. Same response
    shape as `/api/trajectory/output` so the existing plot helpers
    can ingest it without any branching on source.
    """
    import pandas as pd
    import numpy as np

    file_arg = (request.args.get("file") or "").strip()
    if not file_arg:
        return jsonify({"error": "Missing 'file' query param"}), 400

    if file_arg == "__current__":
        path = _TRAJ_OUTPUT / "simulation_output.csv"
    else:
        # Path-traversal guard: resolve, then verify the resolved path
        # is contained in the Pre-loaded Trajectories directory.
        candidate = (_TRAJ_PRELOADED_DIR / file_arg).resolve()
        try:
            candidate.relative_to(_TRAJ_PRELOADED_DIR.resolve())
        except ValueError:
            return jsonify({"error": "Path traversal blocked"}), 403
        path = candidate

    if not path.exists() or not path.is_file():
        return jsonify({"error": f"File not found: {file_arg}"}), 404

    # Cached parse. First request for a fresh xlsx is slow (5–15s);
    # subsequent requests within the process are instant via L1; even
    # cross-restart is fast because we leave a Feather sidecar.
    df = _load_compare_df(path)
    if df is None:
        return jsonify({"error": f"Could not read: {path.name}"}), 500

    # Decimation — same heuristic as the live sim output endpoint.
    if len(df) > _TRAJ_MAX_POINTS:
        step = max(1, len(df) // _TRAJ_MAX_POINTS)
        df = df.iloc[::step].reset_index(drop=True)

    columns = {}
    for col in df.columns:
        if not pd.api.types.is_numeric_dtype(df[col]):
            continue
        meta = _PLOT_PARAMS.get(col) or {}
        # Replace inf / NaN with None (becomes JSON null) — Plotly
        # handles nulls as gaps, infinities as crash bait.
        series = df[col].astype(float).where(np.isfinite(df[col]), None).tolist()
        columns[col] = {
            "data": series,
            "unit": meta.get("unit", ""),
            "label": meta.get("label", col),
            "category": meta.get("category", "Other"),
        }

    return jsonify({
        "exists": True,
        "row_count": int(len(df)),
        "columns": columns,
    })


@app.post("/api/trajectory/run")
def trajectory_run():
    """Start a simulation run.

    Body JSON: the merged trajectory + stage config (same shape the desktop
    `_validate_and_collect()` produces — gets written to `_current.json`).

    Returns: `{ run_id, status: 'running' }`.
    """
    payload = request.get_json(silent=True) or {}

    # Write the config to _current.json — same path the desktop GUI uses,
    # so the simulation reads the user's just-edited values.
    json_dir = _TRAJ_ROOT / "json_files"
    try:
        json_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return jsonify({"error": f"cannot create json_files dir: {exc}"}), 500
    config_path = json_dir / "_current.json"
    try:
        with open(config_path, "w") as f:
            json.dump(payload, f, indent=2)
    except OSError as exc:
        return jsonify({"error": f"failed to write {config_path.name}: {exc}"}), 500

    sim_script = _TRAJ_ROOT / "src" / "simulation.py"
    if not sim_script.exists():
        return jsonify({"error": f"simulation.py not found: {sim_script}"}), 500

    # Run the subprocess from `src/` so `from functions.… import …` etc. resolves.
    src_dir = str(sim_script.parent)
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"

    try:
        proc = subprocess.Popen(
            [sys.executable, "-u", str(sim_script), str(config_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=src_dir,
            env=env,
            bufsize=1,
        )
    except Exception as exc:
        return jsonify({"error": f"failed to spawn simulation: {exc}"}), 500

    run_id = uuid.uuid4().hex[:12]
    with _runs_lock:
        _active_runs[run_id] = {
            "proc":         proc,
            "status":       "running",
            "progress":     0.0,
            "phase":        _PHASE_LABELS[0],
            "log_lines":    [],
            "error_msg":    "",
            "elapsed_s":    0.0,
            "start_time":   time.perf_counter(),
            "config_path":  str(config_path),
        }

    threading.Thread(
        target=_read_simulation_output, args=(run_id,), daemon=True
    ).start()

    return jsonify({"run_id": run_id, "status": "running"})


@app.get("/api/trajectory/run/<run_id>")
def trajectory_run_status(run_id: str):
    """Poll a run's current state.

    Returns `{ run_id, status, progress, phase, elapsed_s, error_msg, recent_log }`.
    `status` is one of: `running`, `success`, `failed`, `cancelled`.
    """
    with _runs_lock:
        run = _active_runs.get(run_id)
        if not run:
            return jsonify({"error": "run not found", "run_id": run_id}), 404
        if run["status"] == "running":
            run["elapsed_s"] = time.perf_counter() - run["start_time"]
        return jsonify(
            {
                "run_id":     run_id,
                "status":     run["status"],
                "progress":   run["progress"],
                "phase":      run["phase"],
                "elapsed_s":  run["elapsed_s"],
                "error_msg":  run["error_msg"],
                "recent_log": run.get("log_lines", [])[-15:],
            }
        )


@app.post("/api/trajectory/run/<run_id>/cancel")
def trajectory_run_cancel(run_id: str):
    """Cancel a running simulation. Sends SIGTERM, then SIGKILL after a grace
    period if the process hasn't exited."""
    with _runs_lock:
        run = _active_runs.get(run_id)
        if not run:
            return jsonify({"error": "run not found"}), 404
        if run["status"] != "running":
            return jsonify({"status": run["status"]})  # nothing to cancel
        run["status"] = "cancelled"
        proc = run["proc"]

    try:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
    except Exception:
        pass

    return jsonify({"status": "cancelled"})


# ---------------------------------------------------------------------------
# Debris analysis — run / poll / cancel / output
# ---------------------------------------------------------------------------
#
# Mirrors `traj_pages/_actions.py::_run_debris_analysis` from the desktop:
#   1. Sample the trajectory CSV at the requested failure points.
#   2. Write a debris config JSON.
#   3. Spawn `src/debris_calculation/run_csv.py <config> batch` as a
#      subprocess (same env / cwd setup as the desktop).
#   4. The runner writes its progress to `<parent>/progress.json` rather
#      than stdout, so a background thread polls that file to update
#      the API state.
#
# State is held in `_active_debris_runs`, keyed by run_id (uuid).
# ---------------------------------------------------------------------------

_active_debris_runs: dict[str, dict] = {}
_debris_runs_lock = threading.Lock()
_DEBRIS_PHASE_LABELS = (
    "Initializing debris analysis",
    "Propagating debris trajectories",
    "Generating outputs",
)


def _extract_debris_csv(sim_csv_path: Path, out_csv: Path, interval_s: float,
                        custom_times: list[float] | None) -> int:
    """Sample `simulation_output.csv` at failure points and write the per-row
    debris launch CSV (port of `traj_pages.debris_helpers.extract_debris_csv`).

    Returns the number of failure points written.
    """
    import numpy as np
    import pandas as pd

    df = pd.read_csv(sim_csv_path)

    required_cols = {
        "time_s": "time", "height_m": "altitude", "lat_deg": "lat",
        "lon_deg": "lon", "vx_ecef_m_s": "vx", "vy_ecef_m_s": "vy",
        "vz_ecef_m_s": "vz", "mass_kg": "mass",
    }
    for col in required_cols:
        if col not in df.columns:
            raise ValueError(f"simulation_output.csv missing column: {col}")

    t = df["time_s"].values
    if custom_times:
        target_times = np.array(sorted(custom_times), dtype=float)
    elif interval_s > 0:
        target_times = np.arange(t[0], t[-1], interval_s)
    else:
        target_times = t

    indices = np.searchsorted(t, target_times, side="left")
    indices = np.clip(indices, 0, len(t) - 1)
    indices = np.unique(indices)
    df = df.iloc[indices].reset_index(drop=True)

    out_df = pd.DataFrame()
    for src_col, dst_col in required_cols.items():
        if dst_col == "mass":
            out_df[dst_col] = df[src_col] / 1000.0    # kg → tonnes for the run
        else:
            out_df[dst_col] = df[src_col]

    out_csv.parent.mkdir(parents=True, exist_ok=True)
    out_df.to_csv(out_csv, index=False)
    return len(out_df)


def _build_debris_config(params: dict, csv_path: Path, config_out: Path) -> dict:
    """Write the debris-analysis JSON config (port of
    `traj_pages.debris_helpers.build_debris_config`)."""
    config = {
        "base_state": {
            "epoch_tt": params.get("epoch_tt", "2025-01-01T12:00:00.000"),
        },
        "csv_launch_points": str(csv_path),
        "csv_velocity_frame": "ecef",
        "csv_units": {"altitude": "m", "velocity": "m_s", "time": "s"},
        "number_of_debris": int(params.get("number_of_debris", 100)),
        "distributions": {
            "min_mass_kg": float(params.get("min_mass_kg", 0.001)),
            "mass_model": "lognorm",
            "mass_lognorm": {"sigma": float(params.get("mass_sigma", 1.0))},
        },
        "dv_explosion": {
            "alpha":          float(params.get("dv_alpha", 1.6)),
            "dv_min":         float(params.get("dv_min", 1.0)),
            "dv_max":         float(params.get("dv_max", 4000.0)),
            "sigma_log10_dv": float(params.get("dv_sigma", 0.4)),
        },
        "physics": {
            "atmosphere_cutoff_m": float(params.get("atmosphere_cutoff", 100000.0)),
        },
        "dt":     float(params.get("dt", 0.1)),
        "t_max":  float(params.get("t_max", 20000.0)),
        "resume": {"enabled": False},
        "output": {
            "plots":            True,
            "save_debris_csv":  True,
            "save_impacts_csv": True,
            "open_plots":       False,
            "leaflet_map":      {"write": True},
            "overview_map":     {"write": True},
        },
    }
    config_out.parent.mkdir(parents=True, exist_ok=True)
    with open(config_out, "w") as f:
        json.dump(config, f, indent=2)
    return config


def _read_debris_progress(parent_folder: Path | None) -> tuple[float, str]:
    """Read `<parent>/progress.json` if available and return (progress 0..1,
    phase label). Until we know the parent folder, return (0, init label)."""
    if not parent_folder:
        return 0.0, _DEBRIS_PHASE_LABELS[0]
    p = parent_folder / "progress.json"
    if not p.is_file():
        return 0.0, _DEBRIS_PHASE_LABELS[0]
    try:
        with open(p) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return 0.0, _DEBRIS_PHASE_LABELS[0]

    total = max(1, int(((data.get("totals") or {}).get("rows") or 0)))
    counts = data.get("counts") or {}
    done    = int(counts.get("done", 0))
    running = int(counts.get("running", 0))
    failed  = int(counts.get("failed", 0))

    # done counts as 1.0; in-flight rows count as 0.5 so the bar moves
    # smoothly even within a single long row.
    fraction = (done + 0.5 * running + failed) / total
    fraction = max(0.0, min(1.0, fraction))

    if fraction <= 0.02:
        phase = _DEBRIS_PHASE_LABELS[0]
    elif fraction >= 0.98:
        phase = _DEBRIS_PHASE_LABELS[2]
    else:
        phase = _DEBRIS_PHASE_LABELS[1]
    return fraction, phase


def _read_debris_subprocess(run_id: str):
    """Background reader: drain stdout/stderr from the debris subprocess,
    snatch the `Parent folder:` line so we can poll progress.json, and
    update the shared state dict until the process exits."""
    with _debris_runs_lock:
        run = _active_debris_runs.get(run_id)
    if not run:
        return
    proc: subprocess.Popen = run["proc"]

    log_lines: list[str] = []
    stderr_lines: list[str] = []

    def _drain_stderr():
        try:
            for raw in proc.stderr:                       # type: ignore[union-attr]
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip()
                stderr_lines.append(line)
                if len(stderr_lines) > 400:
                    del stderr_lines[: len(stderr_lines) - 400]
        except Exception:
            pass

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    parent_folder: Path | None = None

    def _ticker():
        """Poll progress.json once a second so progress advances even when
        the subprocess is silent on stdout (typical mid-run)."""
        while not run.get("_stop_ticker"):
            time.sleep(0.5)
            with _debris_runs_lock:
                if run_id not in _active_debris_runs:
                    return
                if _active_debris_runs[run_id]["status"] != "running":
                    return
                pf = _active_debris_runs[run_id].get("parent_folder")
            pct, phase = _read_debris_progress(pf)
            with _debris_runs_lock:
                if run_id in _active_debris_runs:
                    _active_debris_runs[run_id]["progress"] = pct
                    _active_debris_runs[run_id]["phase"] = phase

    ticker_thread = threading.Thread(target=_ticker, daemon=True)
    ticker_thread.start()

    try:
        for raw in proc.stdout:                            # type: ignore[union-attr]
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").rstrip()
            log_lines.append(line)
            if len(log_lines) > 400:
                del log_lines[: len(log_lines) - 400]

            if line.startswith("Parent folder:"):
                # `Parent folder:   /abs/path/to/debris_multi_…`
                pf_str = line.split(":", 1)[1].strip()
                if pf_str:
                    try:
                        parent_folder = Path(pf_str)
                    except Exception:
                        parent_folder = None
                    with _debris_runs_lock:
                        if run_id in _active_debris_runs:
                            _active_debris_runs[run_id]["parent_folder"] = (
                                str(parent_folder) if parent_folder else None
                            )

            with _debris_runs_lock:
                if run_id in _active_debris_runs:
                    _active_debris_runs[run_id]["log_lines"] = list(log_lines[-60:])
    except Exception as exc:
        log_lines.append(f"[reader error: {exc}]")

    run["_stop_ticker"] = True
    stderr_thread.join(timeout=2)
    proc.wait()

    with _debris_runs_lock:
        run = _active_debris_runs.get(run_id)
        if not run:
            return
        run["elapsed_s"] = time.perf_counter() - run["start_time"]
        run["log_lines"] = list(log_lines[-60:])
        if run["status"] == "cancelled":
            return

        # If we never captured Parent folder, scrape it from the most
        # recently-modified `debris_multi_*` dir as a fallback.
        if not run.get("parent_folder"):
            try:
                candidates = sorted(
                    _DEBRIS_DATA.glob("debris_multi_*"),
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )
                if candidates and candidates[0].stat().st_mtime > run["start_time_wall"]:
                    run["parent_folder"] = str(candidates[0])
            except OSError:
                pass

        if proc.returncode == 0:
            run["status"] = "success"
            run["progress"] = 1.0
            run["phase"] = "Complete"
        else:
            run["status"] = "failed"
            tail = stderr_lines[-12:] if stderr_lines else log_lines[-12:]
            run["error_msg"] = (
                "\n".join(tail).strip()
                or f"run_csv.py exited with code {proc.returncode}"
            )


@app.post("/api/debris/run")
def debris_run():
    """Start a debris-analysis run.

    Body JSON:
      {
        "mode":         "interval" | "custom",
        "interval_s":   number      (used when mode == 'interval')
        "custom_times": [number,…]  (used when mode == 'custom')
        "params":       { …debris param dict… }  // shape from frontend params.js DEBRIS_PARAMS
      }

    Returns: `{ run_id, status: "running" }`.
    """
    payload = request.get_json(silent=True) or {}
    mode = (payload.get("mode") or "interval").lower()
    params = payload.get("params") or {}

    sim_csv = _TRAJ_OUTPUT / "simulation_output.csv"
    if not sim_csv.exists():
        return jsonify({
            "error": "no simulation output yet — run a trajectory simulation first",
        }), 400

    debris_dir = _TRAJ_ROOT / "json_files" / "json_debris"
    csv_path    = debris_dir / "gui_debris_trajectory.csv"
    config_path = debris_dir / "gui_debris_config.json"

    custom_times = None
    if mode == "custom":
        raw_times = payload.get("custom_times") or []
        try:
            custom_times = sorted({float(t) for t in raw_times})
        except (TypeError, ValueError):
            return jsonify({"error": "custom_times must be a list of numbers"}), 400
        if not custom_times:
            return jsonify({"error": "custom_times list is empty"}), 400

    interval_s = float(params.get("failure_interval_s", 50.0))
    try:
        n_rows = _extract_debris_csv(
            sim_csv, csv_path,
            interval_s=interval_s,
            custom_times=custom_times,
        )
    except Exception as exc:
        return jsonify({"error": f"failed to extract debris launch points: {exc}"}), 500

    if n_rows == 0:
        return jsonify({"error": "no failure points were generated"}), 400

    try:
        _build_debris_config(params, csv_path.resolve(), config_path)
    except Exception as exc:
        return jsonify({"error": f"failed to build debris config: {exc}"}), 500

    run_script = _TRAJ_ROOT / "src" / "debris_calculation" / "run_csv.py"
    if not run_script.exists():
        return jsonify({"error": f"run_csv.py not found: {run_script}"}), 500

    src_dir = str(_TRAJ_ROOT / "src")
    debris_data_dir = _DEBRIS_DATA
    debris_data_dir.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = src_dir + os.pathsep + existing if existing else src_dir

    try:
        proc = subprocess.Popen(
            [sys.executable, "-u", str(run_script), str(config_path), "batch"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(debris_data_dir),
            env=env,
            bufsize=1,
        )
    except Exception as exc:
        return jsonify({"error": f"failed to spawn debris analysis: {exc}"}), 500

    run_id = uuid.uuid4().hex[:12]
    with _debris_runs_lock:
        _active_debris_runs[run_id] = {
            "proc":            proc,
            "status":          "running",
            "progress":        0.0,
            "phase":           _DEBRIS_PHASE_LABELS[0],
            "log_lines":       [],
            "error_msg":       "",
            "elapsed_s":       0.0,
            "start_time":      time.perf_counter(),
            "start_time_wall": time.time(),  # for "newer than start" detection
            "config_path":     str(config_path),
            "parent_folder":   None,
            "n_rows":          n_rows,
            "mode":            mode,
        }

    threading.Thread(
        target=_read_debris_subprocess, args=(run_id,), daemon=True
    ).start()

    return jsonify({"run_id": run_id, "status": "running", "n_rows": n_rows})


@app.get("/api/debris/run/<run_id>")
def debris_run_status(run_id: str):
    """Poll a debris run's current state."""
    with _debris_runs_lock:
        run = _active_debris_runs.get(run_id)
        if not run:
            return jsonify({"error": "run not found", "run_id": run_id}), 404
        if run["status"] == "running":
            run["elapsed_s"] = time.perf_counter() - run["start_time"]
        return jsonify({
            "run_id":        run_id,
            "status":        run["status"],
            "progress":      run["progress"],
            "phase":         run["phase"],
            "elapsed_s":     run["elapsed_s"],
            "error_msg":     run["error_msg"],
            "n_rows":        run.get("n_rows"),
            "parent_folder": run.get("parent_folder"),
            "recent_log":    run.get("log_lines", [])[-15:],
        })


@app.post("/api/debris/run/<run_id>/cancel")
def debris_run_cancel(run_id: str):
    """Cancel a running debris analysis."""
    with _debris_runs_lock:
        run = _active_debris_runs.get(run_id)
        if not run:
            return jsonify({"error": "run not found"}), 404
        if run["status"] != "running":
            return jsonify({"status": run["status"]})
        run["status"] = "cancelled"
        run["_stop_ticker"] = True
        proc = run["proc"]

    try:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
    except Exception:
        pass

    return jsonify({"status": "cancelled"})


@app.get("/api/debris/output")
def debris_output_list():
    """List available debris runs (newest first), with quick metadata.
    Used by the debris results page to pick the latest run on mount."""
    runs = []
    if _DEBRIS_DATA.exists():
        for d in sorted(
            _DEBRIS_DATA.glob("debris_multi_*"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        ):
            if not d.is_dir():
                continue
            try:
                mtime = datetime.fromtimestamp(
                    d.stat().st_mtime, timezone.utc
                ).isoformat()
            except OSError:
                mtime = None

            n_rows: int | None = None
            done: bool = (d / "done").exists() or (d / "index.csv").exists()
            try:
                pj = d / "progress.json"
                if pj.exists():
                    with open(pj) as f:
                        prog = json.load(f)
                    n_rows = int(((prog.get("totals") or {}).get("rows")) or 0) or None
            except (OSError, json.JSONDecodeError):
                pass

            runs.append({
                "id":           d.name,
                "modified_at":  mtime,
                "rows":         n_rows,
                "complete":     done,
                "has_overview": (d / "overview.html").exists(),
            })
    return jsonify({"runs": runs})


@app.get("/api/debris/output/<run_id>")
def debris_output_one(run_id: str):
    """Return the aggregate index + per-row impact dots for one debris run.

    Response shape:
      {
        run_id, parent_folder, generated_at,
        rows: [
          {row, time_s, lat, lon, altitude_m, mean_impact_lat, mean_impact_lon,
           mean_impact_speed, mass_kg, harmful_count, harmful_fraction,
           ellipse: { a_m, b_m, azimuth_deg } | null,
           impacts: [ {lat, lon, speed_mps, mass_kg, ke_j, status, unharmed}, … ]
          },
          …
        ],
        totals: { rows, impacts, harmful, total_mass_kg }
      }
    """
    # Sanitize the run_id — it must be a debris_multi_* folder we own.
    if not run_id.startswith("debris_multi_") or "/" in run_id or ".." in run_id:
        return jsonify({"error": "invalid run id"}), 400
    run_dir = _DEBRIS_DATA / run_id
    if not run_dir.is_dir():
        return jsonify({"error": "run not found", "run_id": run_id}), 404

    try:
        import pandas as pd
    except ImportError as exc:
        return jsonify({"error": f"pandas unavailable: {exc}"}), 503

    # Load the top-level index (metadata for each failure point / row).
    index_json = run_dir / "index.json"
    if not index_json.exists():
        return jsonify({"error": "index.json missing — run may still be in progress"}), 425
    try:
        with open(index_json) as f:
            index = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        return jsonify({"error": f"failed to read index.json: {exc}"}), 500

    rows_out = []
    total_impacts = 0
    total_harmful = 0
    total_mass    = 0.0

    for entry in index:
        row_num = int(entry.get("row") or 0)
        # Per-row impacts are in `row_NNNN_batch/impacts.csv`.
        row_dir = run_dir / f"row_{row_num:04d}_batch"
        impacts: list[dict] = []
        if row_dir.is_dir():
            csv_path = row_dir / "impacts.csv"
            if csv_path.is_file():
                try:
                    df = pd.read_csv(csv_path)
                except Exception:
                    df = None
                if df is not None and len(df) > 0:
                    for _, r in df.iterrows():
                        impacts.append({
                            "lat":        _safe_float(r.get("impact_lat_deg")),
                            "lon":        _safe_float(r.get("impact_lon_deg")),
                            "speed_mps":  _safe_float(r.get("impact_speed_mps")),
                            "mass_kg":    _safe_float(r.get("mass_kg")),
                            "ke_j":       _safe_float(r.get("impact_ke_j")),
                            "status":     str(r.get("impact_status") or "unknown"),
                            "unharmed":   bool(r.get("unharmed")) if "unharmed" in df.columns else None,
                            "downrange_m":     _safe_float(r.get("downrange_m")),
                            "crossrange_m":    _safe_float(r.get("signed_crossrange_m")),
                        })

        ellipse = None
        a = entry.get("ellipse3_a_m")
        b = entry.get("ellipse3_b_m")
        az = entry.get("ellipse3_azimuth_deg")
        if a is not None and b is not None and az is not None:
            ellipse = {
                "a_m":          float(a),
                "b_m":          float(b),
                "azimuth_deg":  float(az),
            }

        harmful = int(entry.get("harmful_count") or 0)
        total_impacts += len(impacts)
        total_harmful += harmful
        total_mass    += float(entry.get("mass_kg") or 0.0)

        rows_out.append({
            "row":                 row_num,
            "time_s":              _safe_float(entry.get("time_s")),
            "epoch_tt":            entry.get("epoch_tt"),
            "lat":                 _safe_float(entry.get("lat")),
            "lon":                 _safe_float(entry.get("lon")),
            "altitude_m":          _safe_float(entry.get("altitude_m")),
            "mean_impact_lat":     _safe_float(entry.get("mean_impact_lat_deg")),
            "mean_impact_lon":     _safe_float(entry.get("mean_impact_lon_deg")),
            "mean_impact_speed":   _safe_float(entry.get("mean_impact_speed_mps")),
            "mean_impact_distance": _safe_float(entry.get("mean_impact_downrange_m")),
            "mass_kg":             _safe_float(entry.get("mass_kg")),
            "harmful_count":       harmful,
            "harmful_fraction":    _safe_float(entry.get("harmful_fraction")),
            "ellipse":             ellipse,
            "impacts":             impacts,
        })

    # Generated-at timestamp from one of the row summary.json files.
    generated_at = None
    try:
        for entry in index:
            sj = entry.get("summary_json")
            if sj and Path(sj).is_file():
                with open(sj) as f:
                    summary = json.load(f)
                generated_at = summary.get("generated_at")
                break
    except (OSError, json.JSONDecodeError):
        pass

    return jsonify({
        "run_id":         run_id,
        "parent_folder":  str(run_dir),
        "generated_at":   generated_at,
        "rows":           rows_out,
        "totals": {
            "rows":           len(rows_out),
            "impacts":        total_impacts,
            "harmful":        total_harmful,
            "total_mass_kg":  total_mass,
        },
    })


def _safe_float(v):
    """JSON-safe float coercion: None / NaN / Inf → None."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f == float("inf") or f == float("-inf"):
        return None
    return f


# ---------------------------------------------------------------------------
# Trajectory raw-data viewer
# ---------------------------------------------------------------------------
#
# /api/trajectory/output/raw?offset=N&limit=M
#     Paginated read of `simulation_output.csv` (no decimation). The full
#     dataframe is cached in process memory keyed by mtime so repeated
#     pages don't re-read the CSV from disk.
#
# /api/trajectory/output/download?format=csv|xlsx
#     CSV streams the on-disk file directly (cheap). XLSX builds a
#     pandas → openpyxl workbook on the fly.
# ---------------------------------------------------------------------------

_TRAJ_RAW_CACHE: dict = {"mtime": 0.0, "df": None}
_TRAJ_RAW_LIMIT_MAX = 25000   # hard cap so a buggy client can't OOM us
_TRAJ_RAW_LIMIT_DEFAULT = 5000


def _load_full_trajectory_df():
    """Return the full simulation_output.csv as a pandas DataFrame, cached
    in process memory and invalidated when the file's mtime changes.

    Uses the pyarrow CSV engine when it's available — typically 3-5×
    faster than the default Python parser for large files, which makes
    the *first* /raw chunk request after a sim feel snappy. Falls back
    silently if pyarrow isn't installed.
    """
    csv_path = _TRAJ_OUTPUT / "simulation_output.csv"
    if not csv_path.exists():
        return None
    try:
        mtime = csv_path.stat().st_mtime
    except OSError:
        return None

    if _TRAJ_RAW_CACHE.get("df") is not None and _TRAJ_RAW_CACHE["mtime"] == mtime:
        return _TRAJ_RAW_CACHE["df"]

    try:
        import pandas as pd
    except ImportError:
        return None

    # Try the fast pyarrow engine first; fall back to the default parser
    # if pyarrow isn't installed or the CSV has anything it can't handle.
    df = None
    try:
        df = pd.read_csv(csv_path, engine="pyarrow")
    except (ImportError, ValueError, Exception):
        try:
            df = pd.read_csv(csv_path, low_memory=False)
        except Exception:
            return None
    if df is None:
        return None

    _TRAJ_RAW_CACHE["mtime"] = mtime
    _TRAJ_RAW_CACHE["df"] = df
    return df


@app.get("/api/trajectory/output/raw")
def trajectory_output_raw():
    """Return a window of the *full* (non-decimated) simulation output.

    Query params:
      offset   row index to start at (default 0)
      limit    max rows to return    (default 5000, cap 25000)

    Response:
      {
        exists, total_rows, offset, limit, returned,
        columns: [name, …],
        columns_meta: { name: { label, unit, category, computed }, … },
        rows: [[v0, v1, …], …],   // 2D array, NaN/Inf serialized as null
      }
    """
    csv_path = _TRAJ_OUTPUT / "simulation_output.csv"
    if not csv_path.exists():
        return jsonify({
            "exists": False,
            "message": "No simulation output yet. Run a trajectory simulation first.",
            "path": str(csv_path),
        })

    try:
        offset = max(0, int(request.args.get("offset", 0)))
    except (TypeError, ValueError):
        offset = 0
    try:
        limit = int(request.args.get("limit", _TRAJ_RAW_LIMIT_DEFAULT))
    except (TypeError, ValueError):
        limit = _TRAJ_RAW_LIMIT_DEFAULT
    limit = max(1, min(_TRAJ_RAW_LIMIT_MAX, limit))

    df = _load_full_trajectory_df()
    if df is None:
        return jsonify({"error": "failed to load simulation_output.csv"}), 500

    try:
        import numpy as np
    except ImportError as exc:
        return jsonify({"error": f"numpy unavailable: {exc}"}), 503

    total = int(len(df))
    cols = [c for c in df.columns if df.dtypes[c].kind in "fiub"]   # numeric-only

    columns_meta: dict[str, dict] = {}
    for c in cols:
        meta = _PLOT_PARAMS.get(c) or _DERIVED_PARAMS.get(c) or {}
        columns_meta[c] = {
            "label":    meta.get("label", c),
            "unit":     meta.get("unit", ""),
            "category": meta.get("category", "other"),
            "computed": bool(meta.get("computed", False)),
        }

    if offset >= total:
        return jsonify({
            "exists":       True,
            "total_rows":   total,
            "offset":       offset,
            "limit":        limit,
            "returned":     0,
            "columns":      cols,
            "columns_meta": columns_meta,
            "rows":         [],
        })

    sl = df.iloc[offset : offset + limit][cols]
    arr = sl.to_numpy(dtype=np.float64, copy=False)
    arr = np.where(np.isfinite(arr), arr, np.nan)

    rows: list[list] = []
    for r in arr:
        rows.append([None if (v != v) else float(v) for v in r])

    return jsonify({
        "exists":       True,
        "total_rows":   total,
        "offset":       offset,
        "limit":        limit,
        "returned":     len(rows),
        "columns":      cols,
        "columns_meta": columns_meta,
        "rows":         rows,
    })


@app.get("/api/trajectory/output/raw/all")
def trajectory_output_raw_all():
    """Return ALL numeric rows from `simulation_output.csv` as binary
    float64 data, with column metadata in response headers. Used by
    the canvas-based high-performance Raw Data viewer.

    Response:
      Content-Type: application/octet-stream
      Headers:
        X-Cc-Rows:    "<int>"        total row count
        X-Cc-Cols:    "<int>"        total column count
        X-Cc-Columns: <JSON>         { names: [...], meta: { col: {...} } }
      Body: row-major float64 buffer (rows × cols × 8 bytes).
            NaN encodes a missing / non-finite value.
    """
    csv_path = _TRAJ_OUTPUT / "simulation_output.csv"
    if not csv_path.exists():
        return jsonify({
            "exists": False,
            "message": "No simulation output yet. Run a trajectory simulation first.",
            "path": str(csv_path),
        })

    df = _load_full_trajectory_df()
    if df is None:
        return jsonify({"error": "failed to load CSV"}), 500

    try:
        import numpy as np
    except ImportError as exc:
        return jsonify({"error": f"numpy unavailable: {exc}"}), 503

    cols = [c for c in df.columns if df.dtypes[c].kind in "fiub"]
    columns_meta: dict[str, dict] = {}
    for c in cols:
        meta = _PLOT_PARAMS.get(c) or _DERIVED_PARAMS.get(c) or {}
        columns_meta[c] = {
            "label":    meta.get("label", c),
            "unit":     meta.get("unit", ""),
            "category": meta.get("category", "other"),
            "computed": bool(meta.get("computed", False)),
        }

    arr = df[cols].to_numpy(dtype=np.float64, copy=False)
    # Replace +/- Inf with NaN — JS Float64Array preserves NaN naturally.
    arr = np.where(np.isfinite(arr), arr, np.nan)
    arr = np.ascontiguousarray(arr)         # ensure row-major C order

    rows, cols_count = arr.shape
    cols_header = json.dumps({"names": cols, "meta": columns_meta})

    return Response(
        arr.tobytes(),
        mimetype="application/octet-stream",
        headers={
            "X-Cc-Rows":    str(rows),
            "X-Cc-Cols":    str(cols_count),
            "X-Cc-Columns": cols_header,
            # Allow the X-Cc-* headers to be read by JS clients (they're
            # not in the CORS-safe-listed set).
            "Access-Control-Expose-Headers":
                "X-Cc-Rows, X-Cc-Cols, X-Cc-Columns",
            # Cache by mtime (the underlying DataFrame cache covers this
            # too, but a one-line ETag avoids the float64 serialization
            # entirely on revisits during the same session).
            "Cache-Control": "no-cache",
        },
    )


@app.get("/api/trajectory/output/download")
def trajectory_output_download():
    """Stream the trajectory output as CSV (direct file) or XLSX
    (built on the fly with pandas + openpyxl).

    Query string: `?format=csv` (default) | `?format=xlsx`
    """
    csv_path = _TRAJ_OUTPUT / "simulation_output.csv"
    if not csv_path.exists():
        return jsonify({"error": "no simulation output yet"}), 404

    fmt = (request.args.get("format") or "csv").strip().lower()

    if fmt == "csv":
        return send_file(
            str(csv_path),
            mimetype="text/csv",
            as_attachment=True,
            download_name="simulation_output.csv",
            conditional=True,
        )

    if fmt == "xlsx":
        df = _load_full_trajectory_df()
        if df is None:
            return jsonify({"error": "failed to load CSV"}), 500
        try:
            import io
            import pandas as pd                # noqa: F401
            buf = io.BytesIO()
            try:
                df.to_excel(buf, index=False, engine="openpyxl",
                            sheet_name="Simulation")
            except (ImportError, ValueError) as exc:
                return jsonify({
                    "error":
                        "XLSX export needs `openpyxl` installed on the "
                        "backend. Install with `pip install openpyxl` "
                        f"and try again. ({exc})"
                }), 503
            buf.seek(0)
            return send_file(
                buf,
                mimetype=(
                    "application/vnd.openxmlformats-officedocument."
                    "spreadsheetml.sheet"
                ),
                as_attachment=True,
                download_name="simulation_output.xlsx",
            )
        except Exception as exc:
            return jsonify({"error": f"failed to build xlsx: {exc}"}), 500

    return jsonify({"error": f"unknown format: {fmt}"}), 400


# ---------------------------------------------------------------------------
# Debris results — file-tree browsing, individual download, full-run zip.
# Used by the "Results Folder" modal that replaces the desktop's
# `_open_debris_folder` (which fired the OS file manager).
# ---------------------------------------------------------------------------

def _validate_debris_run_dir(run_id: str) -> Path | None:
    """Resolve a `debris_multi_…` run folder safely. Returns the Path
    or None if the run id is invalid / missing."""
    if not run_id.startswith("debris_multi_") or "/" in run_id or ".." in run_id:
        return None
    run_dir = (_DEBRIS_DATA / run_id).resolve()
    try:
        run_dir.relative_to(_DEBRIS_DATA.resolve())
    except ValueError:
        return None
    if not run_dir.is_dir():
        return None
    return run_dir


@app.get("/api/debris/output/<run_id>/tree")
def debris_output_tree(run_id: str):
    """List the files inside one debris run folder, grouped by row.

    Response shape:
      {
        run_id, generated_at,
        totals: { rows, impacts, harmful, total_size_bytes },
        top_files: [ { name, path, size, ext } … ],
        rows: [
          {
            row, name, meta: { time_s, lat, lon, altitude_m,
                               impacts, harmful_count, mean_impact_speed_mps },
            files: [ { name, path, size, ext } … ],
          },
          …
        ]
      }
    """
    run_dir = _validate_debris_run_dir(run_id)
    if run_dir is None:
        return jsonify({"error": "run not found", "run_id": run_id}), 404

    # Pull row metadata from index.json so the modal can show stats
    # next to each row's accordion header.
    index_path = run_dir / "index.json"
    row_meta_by_num: dict[int, dict] = {}
    generated_at: str | None = None
    if index_path.exists():
        try:
            with open(index_path) as f:
                index = json.load(f) or []
            for entry in index:
                row_num = int(entry.get("row") or 0)
                row_meta_by_num[row_num] = {
                    "time_s":              _safe_float(entry.get("time_s")),
                    "lat":                 _safe_float(entry.get("lat")),
                    "lon":                 _safe_float(entry.get("lon")),
                    "altitude_m":          _safe_float(entry.get("altitude_m")),
                    "harmful_count":       int(entry.get("harmful_count") or 0),
                    "mean_impact_speed":   _safe_float(entry.get("mean_impact_speed_mps")),
                    "mean_impact_distance": _safe_float(entry.get("mean_impact_downrange_m")),
                }
        except (OSError, json.JSONDecodeError):
            pass

    # CSV → mtime fallback for "generated_at" (matches the trajectory page).
    if generated_at is None:
        for entry in run_dir.glob("row_*_batch/summary.json"):
            try:
                with open(entry) as f:
                    s = json.load(f)
                generated_at = s.get("generated_at")
                if generated_at:
                    break
            except (OSError, json.JSONDecodeError):
                continue
    if generated_at is None:
        try:
            generated_at = datetime.fromtimestamp(
                run_dir.stat().st_mtime, timezone.utc
            ).isoformat()
        except OSError:
            generated_at = None

    def _file_entry(p: Path):
        try:
            size = p.stat().st_size
        except OSError:
            size = 0
        return {
            "name": p.name,
            "path": p.relative_to(run_dir).as_posix(),
            "size": int(size),
            "ext":  p.suffix.lower().lstrip("."),
        }

    # Top-level files (skip subdirectories — those are rendered as their
    # own row blocks below). We also hide `temp/` and similar internal
    # bookkeeping from the listing so the modal isn't noisy.
    HIDDEN_TOP = {"temp", "progress", "done"}
    top_files: list[dict] = []
    for entry in sorted(run_dir.iterdir(), key=lambda p: p.name):
        if entry.is_file() and entry.name not in HIDDEN_TOP:
            top_files.append(_file_entry(entry))

    # Per-row directories.
    rows_out: list[dict] = []
    total_impacts = 0
    total_harmful = 0
    total_size_bytes = sum(f["size"] for f in top_files)
    for row_dir in sorted(run_dir.glob("row_*_batch")):
        if not row_dir.is_dir():
            continue
        try:
            row_num = int(row_dir.name.split("_")[1])
        except (IndexError, ValueError):
            row_num = 0

        files: list[dict] = []
        for f in sorted(row_dir.iterdir()):
            if f.is_file():
                fe = _file_entry(f)
                files.append(fe)
                total_size_bytes += fe["size"]

        meta = dict(row_meta_by_num.get(row_num) or {})

        # Impact count from impacts.csv (rows minus header) — cheap and
        # avoids re-reading the whole file.
        impacts_csv = row_dir / "impacts.csv"
        if impacts_csv.is_file():
            try:
                with open(impacts_csv) as f:
                    line_count = sum(1 for _ in f)
                meta["impacts"] = max(0, line_count - 1)
                total_impacts += meta["impacts"]
            except OSError:
                meta["impacts"] = None

        total_harmful += meta.get("harmful_count") or 0

        rows_out.append({
            "row":   row_num,
            "name":  row_dir.name,
            "meta":  meta,
            "files": files,
        })

    return jsonify({
        "run_id":       run_id,
        "generated_at": generated_at,
        "totals": {
            "rows":             len(rows_out),
            "impacts":          total_impacts,
            "harmful":          total_harmful,
            "total_size_bytes": int(total_size_bytes),
        },
        "top_files": top_files,
        "rows":      rows_out,
    })


@app.get("/api/debris/output/<run_id>/file")
def debris_output_file(run_id: str):
    """Stream a single file from inside one debris run folder.

    Query string: `?path=<relative path inside the run>`

    HTML files are served as `text/html` so they render in a new tab
    (Folium / Leaflet maps work as expected). Everything else gets
    `Content-Disposition: attachment` so the browser saves it.
    """
    run_dir = _validate_debris_run_dir(run_id)
    if run_dir is None:
        return jsonify({"error": "run not found", "run_id": run_id}), 404

    rel = (request.args.get("path") or "").strip()
    if not rel or ".." in rel.split("/"):
        return jsonify({"error": "invalid path"}), 400

    target = (run_dir / rel).resolve()
    try:
        target.relative_to(run_dir.resolve())
    except ValueError:
        return jsonify({"error": "path traversal blocked"}), 400
    if not target.is_file():
        return jsonify({"error": "file not found"}), 404

    suffix = target.suffix.lower()
    inline_types = {".html", ".htm"}
    inline = suffix in inline_types

    mt, _ = mimetypes.guess_type(target.name)
    return send_file(
        str(target),
        mimetype=mt or "application/octet-stream",
        as_attachment=not inline,
        download_name=target.name,
        conditional=True,
    )


@app.get("/api/debris/output/<run_id>/zip")
def debris_output_zip(run_id: str):
    """Stream the entire debris run folder as a ZIP archive. Excludes
    the internal `temp/` directory which only contains intermediate
    bookkeeping the user doesn't need."""
    run_dir = _validate_debris_run_dir(run_id)
    if run_dir is None:
        return jsonify({"error": "run not found", "run_id": run_id}), 404

    import io
    import zipfile

    buf = io.BytesIO()
    try:
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in run_dir.rglob("*"):
                if not path.is_file():
                    continue
                # Skip internal `temp/` directory.
                if "temp" in path.relative_to(run_dir).parts:
                    continue
                arcname = path.relative_to(run_dir).as_posix()
                zf.write(path, arcname)
    except OSError as exc:
        return jsonify({"error": f"failed to build zip: {exc}"}), 500

    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{run_id}.zip",
    )


@app.get("/api/engine/tests/<path:name>/video/<path:file_name>")
def engine_test_video(name: str, file_name: str):
    """Stream a video file from a test folder.

    Flask's `send_file(..., conditional=True)` automatically supports HTTP
    Range requests, which is what `<video>` uses for seeking.
    """
    folder = _resolve_test_folder(name)
    if folder is None:
        return jsonify({"error": f"test folder not found: {name}"}), 404

    candidate = (folder / file_name).resolve()
    try:
        candidate.relative_to(folder.resolve())
    except ValueError:
        return jsonify({"error": "invalid file path"}), 400
    if not candidate.is_file():
        return jsonify({"error": f"file not found: {file_name}"}), 404
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

@app.get("/")
def index():
    return jsonify(
        {
            "name": "clearcut-backend",
            "endpoints": [
                "/api/ping",
                "/api/pbs/defaults",
                "/api/pbs/calculate",
                "/api/engine/tests",
                "/api/engine/tests/<name>",
                "/api/engine/tests/<name>/tdms/<file>",
                "/api/engine/tests/<name>/video/<file>",
                "/api/trajectory/output",
                "/api/trajectory/output/raw?offset=N&limit=M",
                "/api/trajectory/output/raw/all",
                "/api/trajectory/output/download?format=csv|xlsx",
                "/api/trajectory/run",
                "/api/trajectory/run/<run_id>",
                "/api/trajectory/run/<run_id>/cancel",
                "/api/debris/presets",
                "/api/debris/run",
                "/api/debris/run/<run_id>",
                "/api/debris/run/<run_id>/cancel",
                "/api/debris/output",
                "/api/debris/output/<run_id>",
                "/api/debris/output/<run_id>/tree",
                "/api/debris/output/<run_id>/file?path=<rel>",
                "/api/debris/output/<run_id>/zip",
            ],
        }
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    app.run(host="127.0.0.1", port=port, debug=True)
