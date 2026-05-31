import csv
import hashlib
import json
import math
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Tuple

import numpy as np

from Classes.coordinate_transformation import CoordinateTransformation
from debris_calculation.debris_batch import run_debris_batch


def _hash_file(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _fingerprint_config(cfg: dict) -> str:
    # Exclude resume block for fingerprinting to reduce false drift
    data = {k: v for k, v in cfg.items() if k != "resume"}
    try:
        s = json.dumps(data, sort_keys=True, separators=(",", ":"))
    except Exception:
        s = str(data)
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def _atomic_write_json(path: Path, obj: dict):
    """Write JSON atomically with Windows-friendly retries.
    Uses a same-directory temporary file and os.replace with backoff to
    avoid transient PermissionError (file locks by AV/indexers).
    """
    tmp = path.with_suffix(path.suffix + ".tmp")
    # Ensure parent exists
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write content to temp and fsync
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
        try:
            f.flush()
            os.fsync(f.fileno())
        except Exception:
            pass
    # Replace with retries
    import time as _t
    import random as _rnd
    last_err = None
    for attempt in range(10):
        try:
            os.replace(tmp, path)
            last_err = None
            break
        except PermissionError as e:
            last_err = e
        except OSError as e:
            last_err = e
        # jittered backoff: 20–120 ms
        _t.sleep(0.02 + 0.1 * _rnd.random())
    if last_err is not None:
        # Best-effort cleanup of temp
        try:
            os.remove(tmp)
        except Exception:
            pass
        raise last_err


def _parse_units(units_cfg: dict) -> dict:
    units = units_cfg or {}
    alt_u = str(units.get("altitude", "m")).lower()
    vel_u = str(units.get("velocity", "m_s")).lower()
    time_u = str(units.get("time", "s")).lower()
    if alt_u not in ("m", "km"):
        alt_u = "m"
    if vel_u not in ("m_s", "km_s"):
        vel_u = "m_s"
    if time_u not in ("s", "ms"):
        time_u = "s"
    return {"altitude": alt_u, "velocity": vel_u, "time": time_u}


def _to_si_alt(val: float, alt_u: str) -> float:
    return float(val) * (1000.0 if alt_u == "km" else 1.0)


def _to_si_vel(val: float, vel_u: str) -> float:
    return float(val) * (1000.0 if vel_u == "km_s" else 1.0)


def _to_si_time(val: float, time_u: str) -> float:
    return float(val) * (0.001 if time_u == "ms" else 1.0)


def process_row_worker(
    row_index: int,
    row: dict,
    base_cfg: dict,
    mode: str,
    base_N: int,
    base_mass: float,
    mass_sigma: float,
    vel_frame: str,
    parent_dir: str,
    base_epoch_tt: str,
    inner_parallel_ok: bool,
) -> Tuple[int, bool, str]:
    try:
        import shutil
        import numpy as np
        from copy import deepcopy as _dc
        from pathlib import Path
        from scipy.stats import truncnorm as _tn
        # Build per-row config
        row_cfg = _dc(base_cfg)
        row_cfg.setdefault("base_state", {})
        bs = row_cfg["base_state"]
        # Per-row epoch and position
        try:
            import astropy.units as u
            from astropy.time import Time
            t0 = Time(str(base_epoch_tt), scale="tt")
            epoch_row = (t0 + (float(row["time_s"]) * u.s)).tt.isot
        except Exception:
            epoch_row = str(base_epoch_tt)
        bs["epoch_tt"] = epoch_row
        bs["lla0"] = {"lat_deg": row["lat"], "lon_deg": row["lon"], "h_m": row["alt_m"]}
        # Velocity as provided by CSV frame
        if str(vel_frame).lower() == "eci":
            bs["initial_velocity_eci"] = {"vx": row["vx"], "vy": row["vy"], "vz": row["vz"]}
            bs.pop("initial_velocity_ecef", None)
        else:
            bs["initial_velocity_ecef"] = {"vx": row["vx"], "vy": row["vy"], "vz": row["vz"]}
            bs.pop("initial_velocity_eci", None)
        # Set output parent so batch temp folders are created inside multi/"temp" folder
        temp_parent = Path(parent_dir).resolve() / "temp"
        temp_parent.mkdir(parents=True, exist_ok=True)
        row_cfg["output_parent_dir"] = str(temp_parent)
        # Progress file path for debris progress (parent monitors it)
        try:
            row_cfg.setdefault("compute", {})
            prog_dir = Path(parent_dir).resolve() / "progress"
            prog_dir.mkdir(parents=True, exist_ok=True)
            row_cfg["compute"]["progress_file"] = str(prog_dir / f"row_{int(row_index):04d}.json")
        except Exception:
            pass

        # Disable inner parallelism only when not allowed (avoid nested pools)
        row_cfg.setdefault("parallel", {})
        row_cfg.setdefault("parallel_debris", {})
        if not inner_parallel_ok:
            row_cfg["parallel"]["enabled"] = False
            row_cfg["parallel_debris"]["enabled"] = False
        # Per-row seed derivation if base seed exists
        if base_cfg.get("random_seed") is not None:
            try:
                row_cfg["random_seed"] = int(base_cfg.get("random_seed")) + int(row_index)
            except Exception:
                row_cfg["random_seed"] = base_cfg.get("random_seed")
        # Mass scaling and override
        total_mass_kg = float(row.get("mass"))
        # Global minimum mass setting
        try:
            min_mass_kg_cfg = float(
                row_cfg.get("distributions", {}).get(
                    "min_mass_kg", row_cfg.get("min_mass_kg", 0.001)
                )
            )
        except Exception:
            min_mass_kg_cfg = 0.001

        if mode == "single":
            row_cfg["number_of_debris"] = 1
            row_cfg.setdefault("single_debris", {})
            row_cfg["single_debris"]["mass_kg"] = max(float(total_mass_kg), float(min_mass_kg_cfg))
        if mode != "single":
            ratio = total_mass_kg / (base_mass or 1.0)
            n_row = max(1, int(round(base_N * ratio)))
            row_cfg["number_of_debris"] = n_row
            # Mass distribution: exact K = round(target_p*N) under threshold when feasible, else warn
            dist_cfg2 = row_cfg.get("distributions", {})
            ln_cfg = dist_cfg2.get("mass_lognorm", {})
            # Inputs
            try:
                target_p = float(ln_cfg.get("target_p", 0.95))
            except Exception:
                target_p = 0.95
            try:
                if ln_cfg.get("target_x_kg") is not None:
                    target_x_kg = float(ln_cfg.get("target_x_kg"))
                else:
                    gx = ln_cfg.get("target_x_g", 25.0)
                    target_x_kg = float(gx) / 1000.0
            except Exception:
                target_x_kg = 0.025
            try:
                sigma_hint = float(ln_cfg.get("sigma_hint", 1.0))
            except Exception:
                sigma_hint = 1.0
            # Epsilon for threshold stability
            eps = max(1e-12, 1e-9 * float(target_x_kg))
            # Per-row RNG: independent, resume-safe
            rng = None
            base_seed = row_cfg.get("random_seed", base_cfg.get("random_seed"))
            try:
                if base_seed is not None:
                    ss = np.random.SeedSequence([int(base_seed), int(row_index)])
                    rng = np.random.default_rng(ss)
            except Exception:
                rng = None
            if rng is None:
                rng = np.random.default_rng()
            # 1) Sample weights and normalize
            try:
                w = rng.lognormal(mean=0.0, sigma=float(sigma_hint), size=int(n_row))
                sw = float(np.sum(w)) or 1.0
                w = w / sw
            except Exception:
                w = np.full(int(n_row), 1.0 / float(n_row), dtype=float)
            # 2) Determine K and groups
            K = int(round(target_p * n_row))
            K = max(0, min(n_row, K))
            A = n_row - K
            # indices sorted by weight (ascending): smallest are more likely under
            order = np.argsort(w)
            under_idx = order[:K]
            over_idx = order[K:]
            # 3) Feasibility check: need A*(target_x+eps) mass for over base
            min_over_sum = float(A) * (float(target_x_kg) + float(eps))
            feasible = float(total_mass_kg) > min_over_sum if A > 0 else True
            masses_row = None
            warn_msg = None
            if feasible and A >= 0 and K >= 0:
                # 4) Construct masses
                total_mass = float(total_mass_kg)
                reserved_over = min_over_sum
                remaining = total_mass - reserved_over
                if remaining < 0.0:
                    remaining = 0.0
                # Split remaining proportionally between groups
                sum_w_under = float(np.sum(w[under_idx])) if K > 0 else 0.0
                sum_w_over = float(np.sum(w[over_idx])) if A > 0 else 0.0
                denom = sum_w_under + sum_w_over if (sum_w_under + sum_w_over) > 0 else 1.0
                rem_under = remaining * (sum_w_under / denom)
                rem_over = remaining - rem_under
                masses = np.zeros(n_row, dtype=float)
                # Under group provisional
                if K > 0 and sum_w_under > 0.0:
                    masses[under_idx] = rem_under * (w[under_idx] / sum_w_under)
                # Cap under at target_x_kg
                excess = 0.0
                if K > 0:
                    over_cap = masses[under_idx] - float(target_x_kg)
                    over_cap = np.where(over_cap > 0.0, over_cap, 0.0)
                    excess = float(np.sum(over_cap))
                    if excess > 0.0:
                        masses[under_idx] = np.minimum(masses[under_idx], float(target_x_kg))
                # Over group provisional
                if A > 0 and sum_w_over > 0.0:
                    masses[over_idx] = (float(target_x_kg) + float(eps)) + rem_over * (w[over_idx] / sum_w_over)
                elif A > 0:
                    masses[over_idx] = (float(target_x_kg) + float(eps))
                # Redistribute any under excess to over proportionally
                if excess > 0.0 and A > 0:
                    sum_over_now = float(np.sum(masses[over_idx])) or 1.0
                    masses[over_idx] += (excess * (masses[over_idx] / sum_over_now))
                # Tiny floor to keep > 0
                masses = np.where(masses <= 0.0, eps, masses)
                # Final normalization to exact total (scale over group primarily)
                diff = float(total_mass) - float(np.sum(masses))
                if abs(diff) > 1e-9:
                    if A > 0:
                        s_over = float(np.sum(masses[over_idx])) or 1.0
                        masses[over_idx] *= (1.0 + diff / s_over)
                    else:
                        masses *= (float(total_mass) / (float(np.sum(masses)) or 1.0))
                # Enforce under ≤ target_x_kg and over ≥ target_x_kg + eps after scaling
                if K > 0:
                    masses[under_idx] = np.minimum(masses[under_idx], float(target_x_kg))
                if A > 0:
                    masses[over_idx] = np.maximum(masses[over_idx], float(target_x_kg) + float(eps))
                # Enforce global minimum mass
                if K > 0:
                    masses[under_idx] = np.maximum(masses[under_idx], float(min_mass_kg_cfg))
                if A > 0:
                    masses[over_idx] = np.maximum(
                        masses[over_idx], max(float(min_mass_kg_cfg), float(target_x_kg) + float(eps))
                    )
                # Final exact renorm preserving K (adjust only over group)
                s_under = float(np.sum(masses[under_idx])) if K > 0 else 0.0
                s_over = float(np.sum(masses[over_idx])) if A > 0 else 0.0
                if abs((s_under + s_over) - float(total_mass)) > 1e-9:
                    if A > 0 and s_over > 0.0:
                        # Scale over group only to hit total mass
                        lam = (float(total_mass) - s_under) / s_over
                        masses[over_idx] *= lam
                        # Enforce lower bound for over
                        masses[over_idx] = np.maximum(
                            masses[over_idx], float(target_x_kg) + float(eps)
                        )
                        # Balance any overshoot by reducing above-min proportionally
                        s_total = float(np.sum(masses))
                        delta = s_total - float(total_mass)
                        if abs(delta) > 1e-9:
                            if delta > 0.0:
                                reducible = masses[over_idx] - (
                                    float(target_x_kg) + float(eps)
                                )
                                total_reducible = float(np.sum(reducible))
                                if total_reducible > 0.0:
                                    masses[over_idx] -= delta * (
                                        reducible / total_reducible
                                    )
                                    masses[over_idx] = np.maximum(
                                        masses[over_idx],
                                        float(target_x_kg) + float(eps),
                                    )
                                else:
                                    warn_msg = (
                                        (warn_msg + "; ") if warn_msg else ""
                                    ) + "mass renorm infeasible: over group at lower bound"
                            else:
                                # deficit: distribute proportionally within over group
                                s_over_now = float(np.sum(masses[over_idx])) or 1.0
                                masses[over_idx] *= (
                                    (float(total_mass) - s_under) / s_over_now
                                )
                        # Final correction on over group for numerical drift
                        s_under_now = float(np.sum(masses[under_idx])) if K > 0 else 0.0
                        s_over_now = float(np.sum(masses[over_idx])) if A > 0 else 0.0
                        if abs((s_under_now + s_over_now) - float(total_mass)) > 1e-6 and A > 0 and s_over_now > 0.0:
                            masses[over_idx] *= (
                                (float(total_mass) - s_under_now) / s_over_now
                            )
                    else:
                        # A == 0: cannot increase under masses beyond target_x_kg; warn if impossible
                        masses[under_idx] = np.minimum(masses[under_idx], float(target_x_kg))
                        s_total = float(np.sum(masses))
                        if s_total < float(total_mass) - 1e-9:
                            warn_msg = (
                                (warn_msg + "; ") if warn_msg else ""
                            ) + "mass renorm infeasible: A=0 and total_mass > N*target_x"
                masses_row = masses.astype(float)
                # Validate count (should hold exactly)
                C = int(np.sum(masses_row <= float(target_x_kg)))
                if C != K and (A > 0):
                    warn_msg = f"mass share off after construction: C={C}, K={K}"
            else:
                warn_msg = (
                    f"infeasible: need at least {min_over_sum:.6g} kg reserved for over group, have {total_mass_kg:.6g} kg"
                )
                # fall back to simple normalized masses (no guarantee of K)
                masses_row = (w * float(total_mass_kg)).astype(float)
            row_cfg["mass_override_kg"] = [float(x) for x in masses_row]
        # Run row
        from debris_calculation.debris_from_csv import _run_debris_batch_with_dict
        result = _run_debris_batch_with_dict(row_cfg)
        # Move outputs to deterministic row folder
        src = Path(result.get("output_folder"))
        subname = f"row_{row_index:04d}_{'single' if mode=='single' else 'batch'}"
        dst = Path(parent_dir) / subname
        if dst.exists():
            shutil.rmtree(dst)
        shutil.move(str(src), str(dst))
        # Write sampling stats for transparency
        try:
            masses_list = row_cfg.get("mass_override_kg", [total_mass_kg])
            try:
                C_achieved = int(np.sum(np.array(masses_list, dtype=float) <= float(target_x_kg))) if mode != "single" else None
            except Exception:
                C_achieved = None
            # Optional console warning
            if 'warn_msg' in locals() and warn_msg:
                try:
                    print(f"[mass-dist] row {row_index:04d}: {warn_msg}")
                except Exception:
                    pass
            stats = {
                "N": int(row_cfg.get("number_of_debris", 0)),
                "target_p": float(ln_cfg.get("target_p", 0.95)) if mode != "single" else None,
                "target_x_kg": float(target_x_kg) if mode != "single" else None,
                "sigma_hint": float(sigma_hint) if mode != "single" else None,
                "K": int(round(float(target_p) * float(row_cfg.get("number_of_debris", 0)))) if mode != "single" else None,
                "C_achieved": C_achieved,
                "sum_mass": float(np.sum(masses_list)),
                "min_mass": float(np.min(masses_list)),
                "max_mass": float(np.max(masses_list)),
                "eps": float(eps) if mode != "single" else None,
                "warning": warn_msg if ('warn_msg' in locals()) else None,
            }
            with open((dst / "mass_sampling.json"), "w") as msf:
                json.dump(stats, msf, indent=2)
        except Exception:
            pass
        # Mark done
        dm = Path(parent_dir) / "done" / f"row_{row_index:04d}.done"
        dm.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(dm.with_suffix('.tmp'), 'w') as f:
                f.write('OK')
            os.replace(dm.with_suffix('.tmp'), dm)
        except Exception:
            pass
        return row_index, True, ""
    except Exception as e:
        return row_index, False, str(e)


def _convert_velocity_frame(
    lat_deg: float,
    lon_deg: float,
    h_m: float,
    vx: float,
    vy: float,
    vz: float,
    epoch_tt: str,
    src: str,
    dst: str,
):
    """
    Convert a velocity between ECI (GCRS) and ECEF (ITRS) at the provided
    geodetic location and TT epoch. Returns (vx, vy, vz, ok).
    If conversion fails or src/dst are the same, returns input and ok flag.
    """
    src = str(src).lower()
    dst = str(dst).lower()
    if src == dst:
        return float(vx), float(vy), float(vz), True
    try:
        import astropy.units as u
        from astropy.coordinates import (
            GCRS,
            ITRS,
            CartesianDifferential,
            EarthLocation,
        )
        from astropy.time import Time

        t = Time(str(epoch_tt), scale="tt")
        # Build ITRS position from geodetic
        loc = EarthLocation.from_geodetic(lon_deg * u.deg, lat_deg * u.deg, h_m * u.m)
        itrs_pos = ITRS(loc.get_itrs(obstime=t).cartesian, obstime=t)
        if src == "eci" and dst == "ecef":
            # Attach ECI velocity to GCRS and transform to ITRS
            gcrs_pos = itrs_pos.transform_to(GCRS(obstime=t))
            vel = CartesianDifferential(vx * u.m / u.s, vy * u.m / u.s, vz * u.m / u.s)
            gcrs_posvel = GCRS(gcrs_pos.cartesian.with_differentials(vel), obstime=t)
            itrs_posvel = gcrs_posvel.transform_to(ITRS(obstime=t))
            return (
                float(itrs_posvel.velocity.d_x.to_value(u.m / u.s)),
                float(itrs_posvel.velocity.d_y.to_value(u.m / u.s)),
                float(itrs_posvel.velocity.d_z.to_value(u.m / u.s)),
                True,
            )
        elif src == "ecef" and dst == "eci":
            # Attach ECEF velocity to ITRS and transform to GCRS
            vel = CartesianDifferential(vx * u.m / u.s, vy * u.m / u.s, vz * u.m / u.s)
            itrs_posvel = ITRS(itrs_pos.cartesian.with_differentials(vel), obstime=t)
            gcrs_posvel = itrs_posvel.transform_to(GCRS(obstime=t))
            return (
                float(gcrs_posvel.velocity.d_x.to_value(u.m / u.s)),
                float(gcrs_posvel.velocity.d_y.to_value(u.m / u.s)),
                float(gcrs_posvel.velocity.d_z.to_value(u.m / u.s)),
                True,
            )
        else:
            return float(vx), float(vy), float(vz), False
    except Exception:
        return float(vx), float(vy), float(vz), False


def _lla_to_ecef(lat: float, lon: float, h_m: float) -> np.ndarray:
    try:
        import astropy.units as u
        from astropy.coordinates import EarthLocation

        loc = EarthLocation.from_geodetic(lon * u.deg, lat * u.deg, h_m * u.m)
        return np.array(
            [loc.x.to_value(u.m), loc.y.to_value(u.m), loc.z.to_value(u.m)], dtype=float
        )
    except Exception:
        coord = CoordinateTransformation()
        return coord.lla_2_ecef(float(lat), float(lon), float(h_m))


def run_debris_from_csv(config_path: str, mode: str = "single") -> dict:
    """
    Run debris simulations for each row in a CSV of launch points.

    Config (JSON) expectations:
      - base_state.epoch_tt: base epoch in TT (required)
      - csv_launch_points: path to CSV file
      - csv_velocity_frame: "eci" (default) or "ecef"
      - csv_units: { altitude: "m"|"km", velocity: "m_s"|"km_s", time: "s"|"ms" }
      - number_of_debris (for batch mode): taken from config

    CSV must have columns: time, altitude, lat, lon, vx, vy, vz

    Returns summary dict with parent folder and index file paths.
    """
    cfg_path = Path(config_path)
    with open(cfg_path, "r") as f:
        cfg = json.load(f)

    base = cfg.get("base_state", {})
    base_epoch_tt = base.get("epoch_tt", None)
    if not base_epoch_tt:
        raise ValueError("base_state.epoch_tt (TT) is required for CSV-driven runs")

    csv_path = cfg.get("csv_launch_points", None)
    if not csv_path:
        raise ValueError("csv_launch_points is required in config")
    csv_path = Path(csv_path)
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    vel_frame = str(cfg.get("csv_velocity_frame", "eci")).lower()
    if vel_frame not in ("eci", "ecef"):
        vel_frame = "eci"
    units = _parse_units(cfg.get("units", cfg.get("csv_units", {})))

    # Resume options and parent folder selection
    resume_cfg = cfg.get("resume", {})
    resume_enabled = bool(resume_cfg.get("enabled", True))
    resume_force = bool(resume_cfg.get("force", False))
    resume_mode = str(resume_cfg.get("mode", "auto")).lower()
    resume_from = resume_cfg.get("from_dir", None)
    max_retries = int(resume_cfg.get("max_retries", 3))
    # Row-parallel config (clean: read new key only)
    row_par_cfg = cfg.get("parallel_rows", {})

    if resume_enabled and resume_from:
        parent = Path(resume_from)
        if not parent.exists():
            raise FileNotFoundError(f"resume.from_dir not found: {parent}")
        parent.mkdir(parents=True, exist_ok=True)
        is_resume = True
    else:
        ts = datetime.now().strftime("%Y%m%d_%H%M")
        base_name = f"debris_multi_{ts}"
        parent = Path(base_name)
        if parent.exists():
            for i in range(2, 1000):
                candidate = Path(f"{base_name}_{i:02d}")
                if not candidate.exists():
                    parent = candidate
                    break
        parent.mkdir(parents=True, exist_ok=False)
        is_resume = False

    job_path = parent / "job.json"
    progress_path = parent / "progress.json"
    done_dir = parent / "done"
    done_dir.mkdir(parents=True, exist_ok=True)

    # Manifest: CSV/Config fingerprints and resume validation
    csv_abs = Path(csv_path).resolve()
    try:
        csv_hash = _hash_file(csv_abs)
    except Exception:
        csv_hash = ""
    cfg_fpr = _fingerprint_config(cfg)
    if resume_enabled and is_resume and job_path.exists():
        try:
            with open(job_path, "r") as jf:
                job = json.load(jf)
        except Exception:
            job = None
        if job:
            same_csv = (job.get("csv_path") == str(csv_abs)) and (
                job.get("csv_hash") == csv_hash
            )
            same_cfg = job.get("config_fingerprint") == cfg_fpr
            if not (same_csv and same_cfg) and not resume_force:
                raise RuntimeError(
                    "Resume blocked: CSV or config changed. Set resume.force=true to override."
                )
    else:
        # Auto-resume: if enabled and no from_dir, try to find matching recent folder
        if resume_enabled and not is_resume and resume_mode == "auto":
            try:
                candidates = []
                for p in Path(".").iterdir():
                    if p.is_dir() and str(p.name).startswith("debris_multi_"):
                        jp = p / "job.json"
                        if jp.exists():
                            try:
                                with open(jp, "r") as jf:
                                    jd = json.load(jf)
                                same_csv = jd.get("csv_path") == str(
                                    Path(csv_path).resolve()
                                )
                                same_cfg = jd.get("config_fingerprint") == cfg_fpr
                                if same_csv and same_cfg:
                                    candidates.append((p.stat().st_mtime, p))
                            except Exception:
                                pass
                if candidates:
                    candidates.sort(reverse=True)
                    parent = candidates[0][1]
                    is_resume = True
            except Exception:
                pass
        job = {
            "job_id": parent.name,
            "mode": str(mode),
            "csv_path": str(csv_abs),
            "csv_hash": csv_hash,
            "config_fingerprint": cfg_fpr,
            "started_at": datetime.now().isoformat(timespec="seconds"),
        }
        _atomic_write_json(job_path, job)

    # Read CSV rows
    rows = []
    with open(csv_path, "r", newline="") as fcsv:
        # Try to detect delimiter quickly by peeking first line for tab
        sample = fcsv.readline()
        fcsv.seek(0)
        delimiter = "\t" if "\t" in sample else ","
        reader = csv.DictReader(fcsv, delimiter=delimiter)
        required = ["time", "altitude", "lat", "lon", "vx", "vy", "vz"]
        for req in required:
            if req not in reader.fieldnames:
                raise ValueError(f"CSV missing required column: {req}")
        has_mass_col = "mass" in (reader.fieldnames or [])
        if not has_mass_col:
            raise ValueError("CSV must include a 'mass' column (metric tons)")
        for row in reader:
            try:
                t = _to_si_time(float(row["time"]), units["time"])  # seconds
                alt_m = _to_si_alt(float(row["altitude"]), units["altitude"])  # meters
                lat = float(row["lat"])  # deg
                lon = float(row["lon"])  # deg
                vx = _to_si_vel(float(row["vx"]), units["velocity"])  # m/s
                vy = _to_si_vel(float(row["vy"]), units["velocity"])  # m/s
                vz = _to_si_vel(float(row["vz"]), units["velocity"])  # m/s
                mass_val = None
                try:
                    mv = float(row["mass"])  # tons in CSV
                    # Convert tons -> kg (metric ton assumed: 1 ton = 1000 kg)
                    mv_kg = mv * 1000.0
                    # Treat negative/NaN as missing
                    if np.isfinite(mv_kg) and mv_kg >= 0.0:
                        mass_val = mv_kg
                except Exception:
                    mass_val = None
            except Exception as e:
                raise ValueError(f"Failed parsing CSV row {row}: {e}")
            rows.append(
                {
                    "time_s": t,
                    "alt_m": alt_m,
                    "lat": lat,
                    "lon": lon,
                    "vx": vx,
                    "vy": vy,
                    "vz": vz,
                    "mass": mass_val,
                }
            )
    # Validate mass present for all rows
    for i, r in enumerate(rows, start=1):
        if r.get("mass") is None:
            raise ValueError(
                f"CSV mass missing/invalid in row {i}; 'mass' (tons) is required"
            )

    # Prepare done/progress and index outputs
    done_dir = parent / "done"
    done_dir.mkdir(parents=True, exist_ok=True)
    progress_path = parent / "progress.json"
    index_rows = []
    index_json = []

    # Astropy time math for per-row epoch
    try:
        import astropy.units as u
        from astropy.time import Time

        t0 = Time(str(base_epoch_tt), scale="tt")

        def _row_epoch(dt_s: float) -> str:
            return (t0 + (dt_s * u.s)).tt.isot

    except Exception:
        # Fallback: return base epoch string; conversions still work if only ECEF is used
        def _row_epoch(dt_s: float) -> str:
            return str(base_epoch_tt)

    # Initialize or load progress
    progress = {
        "totals": {"rows": len(rows)},
        "counts": {"pending": 0, "running": 0, "done": 0, "failed": 0},
        "status": {},
        "retries": {},
        "notes": [],
    }
    if progress_path.exists():
        try:
            with open(progress_path, "r") as pf:
                progress = json.load(pf)
        except Exception:
            pass
    # Seed statuses if missing
    for idx in range(1, len(rows) + 1):
        key = f"row_{idx:04d}"
        if key not in progress.get("status", {}):
            progress["status"][key] = "pending"
        if key not in progress.get("retries", {}):
            progress["retries"][key] = 0

    # Helper to recompute counts and write progress
    def _save_progress():
        cnts = {"pending": 0, "running": 0, "done": 0, "failed": 0}
        for st in progress["status"].values():
            if st in cnts:
                cnts[st] += 1
        progress["counts"] = cnts
        _atomic_write_json(progress_path, progress)

    _save_progress()

    # Baseline for fragment count scaling
    base_N = int(cfg.get("number_of_debris", 1))
    base_mass_kg = float(rows[0].get("mass"))
    if not (np.isfinite(base_mass_kg) and base_mass_kg > 0.0):
        raise ValueError("First row 'mass' must be positive to scale number_of_debris")

    # Mass split sigma (truncated normal for weights)
    try:
        mass_split_sigma = float(
            cfg.get("distributions", {}).get("mass_split_sigma", 0.3)
        )
    except Exception:
        mass_split_sigma = 0.3

    # Helper: sample positive weights and scale to sum=1
    from scipy.stats import truncnorm

    def _sample_positive_weights(n: int, sigma: float) -> np.ndarray:
        a, b = (0.0 - 1.0) / max(sigma, 1e-12), np.inf
        w = truncnorm.rvs(a, b, loc=1.0, scale=max(sigma, 1e-12), size=n)
        s = float(np.sum(w)) or 1.0
        return w / s

    # Fixed-axis downrange reference (set on first valid row): ECEF unit vector
    fixed_axis_u = None

    # Decide row-level parallel (clean: new key only; with backend + Windows fallback)
    row_par = cfg.get("parallel_rows", {})
    rp_enabled = bool(row_par.get("enabled", False))
    try:
        rp_workers = int(row_par.get("workers", 1))
    except Exception:
        rp_workers = 1
    rp_backend = str(row_par.get("backend", "process")).lower()
    rp_win_ok = bool(row_par.get("windows_process_ok", False))

    # Build list of rows to run (pending/failed only); skip done markers
    tasks = []
    for idx, r in enumerate(rows, start=1):
        row_key = f"row_{idx:04d}"
        done_marker = done_dir / f"{row_key}.done"
        st = progress["status"].get(row_key, "pending")
        retries = int(progress.get("retries", {}).get(row_key, 0))
        if done_marker.exists() or st == "done":
            continue
        if retries >= max_retries:
            progress["status"][row_key] = "failed"
            continue
        tasks.append((idx, r))

    # Determine if inner debris parallelism is OK
    # - OK when row-parallel is disabled (sequential rows), or when there's only 1 pending row
    # - Otherwise, disable to avoid nested executors oversubscribing cores
    inner_parallel_ok = (not rp_enabled) or (len(tasks) <= 1)

    # Execute rows (parallel or sequential)
    if rp_enabled and tasks:
        import sys as _sys
        from concurrent.futures import ProcessPoolExecutor as _PPE
        from concurrent.futures import ThreadPoolExecutor as _TPE
        from concurrent.futures import wait as _wait, FIRST_COMPLETED as _FC
        from time import sleep as _sleep
        # Progress bars
        try:
            from tqdm import tqdm as _tqdm
        except Exception:
            _tqdm = None

        _backend = rp_backend
        if _sys.platform.startswith("win") and _backend == "process" and not rp_win_ok:
            _backend = "thread"

        Exec = _TPE if _backend == "thread" else _PPE
        with Exec(max_workers=max(1, rp_workers)) as ex:
            fut_to_idx = {}
            # mark running statuses
            for idx, r in tasks:
                progress["status"][f"row_{idx:04d}"] = "running"
            _save_progress()
            # Parent bar init (resume-aware)
            parent_bar = None
            try:
                if _tqdm is not None:
                    total_rows = len(rows)
                    done_rows = sum(1 for st in progress["status"].values() if st == "done")
                    parent_bar = _tqdm(total=total_rows, initial=done_rows, desc="Rows", unit="row", dynamic_ncols=True, position=0)
            except Exception:
                parent_bar = None
            # Child bars map
            child_bars = {}
            # Fixed slot positions for child bars: 1..rp_workers
            max_slots = max(1, rp_workers)
            free_slots = list(range(1, max_slots + 1))
            row_to_slot = {}

            def _ensure_child_bar(idx, total_debris):
                if _tqdm is None:
                    return None
                if idx in child_bars:
                    return child_bars[idx]
                # Allocate a fixed position slot for this row
                pos = free_slots.pop(0) if free_slots else (len(child_bars) + 1)
                row_to_slot[idx] = pos
                bar = _tqdm(total=total_debris, desc=f"Row {idx:04d}", unit="deb", leave=False, position=pos, dynamic_ncols=True)
                child_bars[idx] = bar
                return bar

            # Submit all rows
            for idx, r in tasks:
                # create compute.progress_file in expected path for parent polling (already set in worker)
                fut = ex.submit(
                    process_row_worker,
                    idx,
                    r,
                    cfg,
                    mode,
                    base_N,
                    base_mass_kg,
                    mass_split_sigma,
                    vel_frame,
                    str(parent.resolve()),
                    str(base_epoch_tt),
                    bool(inner_parallel_ok),
                )
                fut_to_idx[fut] = idx
            pending = set(fut_to_idx.keys())
            # Poll loop
            while pending:
                # Update child bars from progress files
                try:
                    for fut, idx in list(fut_to_idx.items()):
                        if idx in child_bars and child_bars[idx] is not None:
                            prog_path = Path(parent) / "progress" / f"row_{idx:04d}.json"
                            if prog_path.exists():
                                try:
                                    with open(prog_path, "r") as pf:
                                        pd = json.load(pf)
                                    tot = int(pd.get("total_debris", 0))
                                    done = int(pd.get("done_debris", 0))
                                    bar = _ensure_child_bar(idx, tot if tot > 0 else child_bars[idx].total or 0)
                                    if bar is not None:
                                        if bar.total != tot and tot > 0:
                                            bar.total = tot
                                        bar.n = min(done, bar.total or done)
                                        bar.refresh()
                                except Exception:
                                    pass
                        else:
                            # create if missing with estimated total
                            # estimate debris count from base_N and mass ratios
                            try:
                                rsrc = rows[idx - 1]
                                ratio = float(rsrc.get("mass", 0.0)) / (base_mass_kg or 1.0)
                                est = max(1, int(round(base_N * ratio)))
                            except Exception:
                                est = 1
                            _ensure_child_bar(idx, est)
                except Exception:
                    pass
                # Wait for any completion with timeout
                done_set, pending = _wait(pending, timeout=0.5, return_when=_FC)
                for fut in done_set:
                    idx_ret = fut_to_idx.get(fut, -1)
                    try:
                        iret, ok, err = fut.result()
                    except Exception as e:
                        iret, ok, err = (idx_ret, False, str(e))
                    if idx_ret >= 1:
                        rk = f"row_{idx_ret:04d}"
                        if ok:
                            progress["status"][rk] = "done"
                        else:
                            progress["status"][rk] = "failed"
                            progress.setdefault("errors", {})[rk] = err
                            progress["retries"][rk] = int(progress["retries"].get(rk, 0)) + 1
                        if parent_bar is not None:
                            parent_bar.update(1)
                        # finalize child bar
                        try:
                            if idx_ret in child_bars and child_bars[idx_ret] is not None:
                                bar = child_bars[idx_ret]
                                bar.close()
                                del child_bars[idx_ret]
                                # free the slot
                                try:
                                    free_slots.append(row_to_slot.get(idx_ret, None))
                                    free_slots = [p for p in free_slots if p is not None]
                                    free_slots.sort()
                                    row_to_slot.pop(idx_ret, None)
                                except Exception:
                                    pass
                        except Exception:
                            pass
                        _save_progress()
            # Close parent bar
            try:
                if parent_bar is not None:
                    parent_bar.close()
            except Exception:
                pass
    else:
        # Sequential execution with live progress bars
        try:
            from tqdm import tqdm as _tqdm
        except Exception:
            _tqdm = None

        # Parent bar (resume-aware)
        parent_bar = None
        try:
            if _tqdm is not None:
                total_rows = len(rows)
                done_rows = sum(1 for st in progress["status"].values() if st == "done")
                parent_bar = _tqdm(total=total_rows, initial=done_rows, desc="Rows", unit="row", dynamic_ncols=True, position=0)
        except Exception:
            parent_bar = None

        import threading as _th
        from time import sleep as _sleep

        for idx, r in tasks:
            row_key = f"row_{idx:04d}"
            progress["status"][row_key] = "running"
            _save_progress()

            # Launch worker in a thread so we can poll progress file
            args = (
                idx,
                r,
                cfg,
                mode,
                base_N,
                base_mass_kg,
                mass_split_sigma,
                vel_frame,
                str(parent.resolve()),
                str(base_epoch_tt),
                bool(inner_parallel_ok),
            )
            result_holder = {"res": None}
            def _run():
                result_holder["res"] = process_row_worker(*args)

            t = _th.Thread(target=_run, daemon=True)
            t.start()

            # Child debris bar
            child_bar = None
            try:
                # Estimate total debris until we see a real total
                est_total = 1
                try:
                    ratio = float(r.get("mass", 0.0)) / (base_mass_kg or 1.0)
                    est_total = max(1, int(round(base_N * ratio)))
                except Exception:
                    est_total = 1
                if _tqdm is not None:
                    child_bar = _tqdm(total=est_total, desc=f"Row {idx:04d}", unit="deb", leave=False, dynamic_ncols=True, position=1)
            except Exception:
                child_bar = None

            prog_path = (Path(parent) / "progress" / f"row_{idx:04d}.json").resolve()
            # Poll progress JSON while worker runs
            while t.is_alive():
                try:
                    if prog_path.exists() and child_bar is not None:
                        with open(prog_path, "r") as pf:
                            pd = json.load(pf)
                        tot = int(pd.get("total_debris", 0))
                        done = int(pd.get("done_debris", 0))
                        if tot > 0:
                            if child_bar.total != tot:
                                child_bar.total = tot
                            child_bar.n = min(done, child_bar.total or done)
                            child_bar.refresh()
                except Exception:
                    pass
                _sleep(0.3)

            # Worker finished
            try:
                idx_ret, ok, err = result_holder["res"] if result_holder["res"] is not None else (idx, False, "unknown error")
            except Exception as e:
                idx_ret, ok, err = (idx, False, str(e))

            if ok:
                progress["status"][row_key] = "done"
            else:
                progress["status"][row_key] = "failed"
                progress.setdefault("errors", {})[row_key] = err
                progress["retries"][row_key] = int(progress["retries"].get(row_key, 0)) + 1
            _save_progress()

            # Finalize bars
            try:
                if child_bar is not None:
                    # Snap to full done if we know total
                    if prog_path.exists():
                        try:
                            with open(prog_path, "r") as pf:
                                pd = json.load(pf)
                            tot = int(pd.get("total_debris", 0))
                            done = int(pd.get("done_debris", 0))
                            if tot > 0:
                                child_bar.total = tot
                            child_bar.n = min(done if tot == 0 else child_bar.total, child_bar.total or done)
                        except Exception:
                            pass
                    child_bar.close()
            except Exception:
                pass

            try:
                if parent_bar is not None:
                    parent_bar.update(1)
            except Exception:
                pass

        try:
            if parent_bar is not None:
                parent_bar.close()
        except Exception:
            pass
        # Inline index write removed; final index rebuilt from filesystem

    # Rebuild index from filesystem so overview always includes all rows (resume-safe)
    idx_csv = parent / "index.csv"
    idx_json = parent / "index.json"
    rebuilt = []
    for idx_scan in range(1, len(rows) + 1):
        subname = f"row_{idx_scan:04d}_{'single' if mode=='single' else 'batch'}"
        dst = parent / subname
        if not dst.exists():
            continue
        summary_path = (dst / "summary.json").resolve()
        impacts_path = (dst / "impacts.csv").resolve()
        sampling_path = (dst / "mass_sampling.json").resolve()
        # Defaults for means
        mean_lat = None
        mean_lon = None
        mean_speed = None
        mean_downrange = None
        ellipse3_a = None
        ellipse3_b = None
        ellipse3_az = None
        try:
            with open(summary_path, "r") as sf:
                sdoc = json.load(sf)
            mean_lat = sdoc.get("mean_impact_lat_deg")
            mean_lon = sdoc.get("mean_impact_lon_deg")
            # Mean speed from results
            try:
                res_list = sdoc.get("results", [])
                sp2 = [
                    float(x.get("impact_speed_mps"))
                    for x in res_list
                    if x.get("impact_speed_mps") is not None
                ]
                mean_speed = float(sum(sp2) / len(sp2)) if sp2 else None
            except Exception:
                pass
            levels = sdoc.get("ellipse_levels", [])
            for lvl in levels:
                try:
                    if int(round(float(lvl.get("sigma", 0)))) == 3:
                        ellipse3_a = lvl.get("a_m")
                        ellipse3_b = lvl.get("b_m")
                        ellipse3_az = lvl.get("azimuth_deg")
                        break
                except Exception:
                    continue
            if ellipse3_a is None:
                ellipse3_a = sdoc.get("ellipse_a_m")
                ellipse3_b = sdoc.get("ellipse_b_m")
                ellipse3_az = sdoc.get("ellipse_azimuth_deg")
        except Exception:
            pass
        # Mean downrange from impacts.csv
        try:
            import csv as _csv

            if impacts_path and impacts_path.exists():
                dr_vals = []
                total_imp = 0
                harmful_cnt = 0
                with open(impacts_path, "r", newline="") as fimp:
                    rimp = _csv.DictReader(fimp)
                    for row in rimp:
                        # consider only valid impacts (non-empty time)
                        ti = (row.get("impact_time_s") or "").strip()
                        if ti == "":
                            continue
                        total_imp += 1
                        v = row.get("downrange_m")
                        if v not in (None,""):
                            try:
                                fv = float(v)
                                if np.isfinite(fv):
                                    dr_vals.append(fv)
                            except Exception:
                                pass
                        uh = (row.get("unharmed") or "").strip().lower()
                        if uh == "false":
                            harmful_cnt += 1
                if dr_vals:
                    mean_downrange = float(sum(dr_vals) / len(dr_vals))
                harmful_count = int(harmful_cnt)
                total_impacts = int(total_imp)
                harmful_fraction = (float(harmful_cnt) / float(total_imp) if total_imp > 0 else None)
        except Exception:
            pass
        # Row data from parsed CSV rows list
        rsrc = rows[idx_scan - 1]
        epoch_tt_row = _row_epoch(rsrc["time_s"])
        # Rebuilt index row — honor same configurable output frame
        index_vf2 = str(
            cfg.get("output", {}).get("index_velocity_frame", "ecef")
        ).lower()
        if index_vf2 not in ("ecef", "eci", "source"):
            index_vf2 = "ecef"
        des_frame2 = vel_frame if index_vf2 == "source" else index_vf2
        vx_out2, vy_out2, vz_out2, ok2 = _convert_velocity_frame(
            rsrc["lat"],
            rsrc["lon"],
            rsrc["alt_m"],
            rsrc["vx"],
            rsrc["vy"],
            rsrc["vz"],
            epoch_tt_row,
            vel_frame,
            des_frame2,
        )
        vel_frame_out2 = des_frame2 if ok2 else vel_frame

        # Mass from CSV for rebuild
        mass_kg_idx2 = None
        try:
            mv2 = rows[idx_scan - 1].get("mass", None)
            if mv2 is not None and np.isfinite(float(mv2)) and float(mv2) >= 0.0:
                mass_kg_idx2 = float(mv2)
        except Exception:
            mass_kg_idx2 = None
        initial_momentum2 = None
        try:
            if mass_kg_idx2 is not None:
                vmag2 = math.sqrt(
                    float(vx_out2) ** 2 + float(vy_out2) ** 2 + float(vz_out2) ** 2
                )
                if np.isfinite(vmag2):
                    initial_momentum2 = round(mass_kg_idx2 * vmag2, 3)
        except Exception:
            initial_momentum2 = None

        # Fixed-axis mean downrange for rebuild pass
        mean_impact_downrange_fixed_m = None
        try:
            if (mean_lat is not None) and (mean_lon is not None):
                r0_ecef2 = _lla_to_ecef(
                    float(rsrc["lat"]), float(rsrc["lon"]), float(rsrc["alt_m"])
                )
                rc_ecef2 = _lla_to_ecef(float(mean_lat), float(mean_lon), 0.0)
                disp2 = rc_ecef2 - r0_ecef2
                # Initialize fixed axis from first valid row
                if (
                    "fixed_axis_u_rebuild" not in locals()
                    or fixed_axis_u_rebuild is None
                ):
                    nrm2 = float(np.linalg.norm(disp2))
                    if nrm2 > 0.0:
                        fixed_axis_u_rebuild = disp2 / nrm2
                        mean_impact_downrange_fixed_m = nrm2
                else:
                    mean_impact_downrange_fixed_m = float(
                        np.dot(disp2, fixed_axis_u_rebuild)
                    )
        except Exception:
            mean_impact_downrange_fixed_m = None

        # mean CdA for rebuild
        mean_cda_m2b = None
        try:
            with open(summary_path, "r") as sf:
                sdoc2b = json.load(sf)
            cda_stats2 = sdoc2b.get("cda_stats") or {}
            if isinstance(cda_stats2, dict):
                mc2 = cda_stats2.get("mean")
                if mc2 is not None and np.isfinite(float(mc2)):
                    mean_cda_m2b = float(mc2)
        except Exception:
            pass


        rebuilt.append(
            {
                "row": idx_scan,
                "time_s": rsrc["time_s"],
                "epoch_tt": epoch_tt_row,
                "lat": rsrc["lat"],
                "lon": rsrc["lon"],
                "altitude_m": rsrc["alt_m"],
                "vx": vx_out2,
                "vy": vy_out2,
                "vz": vz_out2,
                "velocity_frame": vel_frame_out2,
                "mode": mode,
                "output_folder": str(dst.resolve()),
                "summary_json": (str(summary_path) if summary_path.exists() else None),
                "impacts_csv": (str(impacts_path) if impacts_path.exists() else None),
                "mean_impact_lat_deg": mean_lat,
                "mean_impact_lon_deg": mean_lon,
                "mean_impact_speed_mps": mean_speed,
                "mean_impact_downrange_m": mean_downrange,
                "mean_impact_downrange_fixed_m": mean_impact_downrange_fixed_m,
                "mass_kg": mass_kg_idx2,
                "initial_momentum_kg_mps": initial_momentum2,
                "mean_cda_m2": mean_cda_m2b,
                "harmful_count": (harmful_count if 'harmful_count' in locals() else None),
                "harmful_fraction": (harmful_fraction if 'harmful_fraction' in locals() else None),
                "ellipse3_a_m": ellipse3_a,
                "ellipse3_b_m": ellipse3_b,
                "ellipse3_azimuth_deg": ellipse3_az,
            }
        )

    # Sort and write index files
    index_rows = sorted(rebuilt, key=lambda d: int(d.get("row", 0)))
    index_json = index_rows
    if index_rows:
        keys = [
            "row",
            "time_s",
            "epoch_tt",
            "lat",
            "lon",
            "altitude_m",
            "vx",
            "vy",
            "vz",
            "velocity_frame",
            "mode",
            "output_folder",
            "summary_json",
            "impacts_csv",
            "mean_impact_lat_deg",
            "mean_impact_lon_deg",
            "mean_impact_speed_mps",
            "mean_impact_downrange_m",
            "mean_impact_downrange_fixed_m",
            "mean_cda_m2",
            "mass_kg",
            "initial_momentum_kg_mps",
            "harmful_count",
            "harmful_fraction",
            "ellipse3_a_m",
            "ellipse3_b_m",
            "ellipse3_azimuth_deg",
        ]
        with open(idx_csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=keys)
            w.writeheader()
            for r in index_rows:
                w.writerow(r)
    with open(idx_json, "w") as f:
        json.dump(index_json, f, indent=2)

    # Build overview HTML (Folium) with time-selectable layers and global 1σ/2σ/3σ ellipses
    try:
        ov = cfg.get("output", {}).get("overview_map", {})
        write_ov = bool(ov.get("write", True))
        if write_ov and index_rows:
            try:
                import folium
                from pyproj import Geod

                try:
                    from folium.plugins import BeautifyIcon
                except Exception:
                    BeautifyIcon = None
            except Exception:
                write_ov = False
        if write_ov:
            marker_radius = int(ov.get("marker_radius", 3))
            marker_opacity = float(ov.get("marker_opacity", 0.9))
            ellipse_fill_opacity = float(ov.get("ellipse_fill_opacity", 0.15))

            # Center map on mean of explosion lat/lon
            lats = [r.get("lat") for r in index_rows if r.get("lat") is not None]
            lons = [r.get("lon") for r in index_rows if r.get("lon") is not None]
            lat_c = float(sum(lats) / len(lats)) if lats else 0.0
            lon_c = float(sum(lons) / len(lons)) if lons else 0.0

            fmap = folium.Map(location=[lat_c, lon_c], zoom_start=6, tiles=None)
            # Base tiles like leaflet_map
            tiles_default = str(ov.get("tiles", "OpenStreetMap"))
            extra_tiles = list(ov.get("extra_tiles", [
                "OpenStreetMap",
                "Esri.WorldImagery",
                "CartoDB positron",
                "Esri.WorldTopoMap",
            ]))
            if tiles_default not in extra_tiles:
                extra_tiles.append(tiles_default)
            for base in list(dict.fromkeys(extra_tiles)):
                try:
                    folium.TileLayer(base, name=base, show=(base == tiles_default)).add_to(fmap)
                except Exception:
                    pass
            # Global impact toggles
            layer_unharmov = folium.FeatureGroup(name="Unharmful Impacts", show=True)
            layer_harmov = folium.FeatureGroup(name="Harmful Impacts", show=True)
            fmap.add_child(layer_unharmov)
            fmap.add_child(layer_harmov)

            # Create time-based layers: one layer per CSV time value
            # Default visibility: only the minimum time layer ON; others OFF
            times = [float(r.get("time_s", 0.0)) for r in index_rows]
            min_time = min(times) if times else 0.0

            def _time_label(t: float) -> str:
                try:
                    if float(t).is_integer():
                        return f"{int(round(float(t)))} sec"
                    else:
                        return f"{float(t):.1f} sec"
                except Exception:
                    return f"{t} sec"

            time_layers = {}
            for r in index_rows:
                t = float(r.get("time_s", 0.0))
                label = _time_label(t)
                show = t == min_time
                if label not in time_layers:
                    time_layers[label] = folium.FeatureGroup(name=label, show=show)
            # Dummy sigma toggles (empty; for UI control only)
            layer_sigma1 = folium.FeatureGroup(name="Ellipses 1σ", show=False)
            layer_sigma2 = folium.FeatureGroup(name="Ellipses 2σ", show=False)
            layer_sigma3 = folium.FeatureGroup(name="Ellipses 3σ", show=True)
            fmap.add_child(layer_sigma1)
            fmap.add_child(layer_sigma2)
            fmap.add_child(layer_sigma3)

            geod = Geod(ellps="WGS84")

            def add_ellipse(
                center_lat,
                center_lon,
                a_m,
                b_m,
                az_deg,
                target_layer,
                color,
                sigma=None,
            ):
                try:
                    import math

                    pts = []
                    az_rad = math.radians(float(az_deg or 0.0))
                    for k in range(0, 361, 3):
                        t = math.radians(k)
                        # Major along azimuth
                        n0 = (a_m or 0.0) * math.cos(t)
                        e0 = (b_m or 0.0) * math.sin(t)
                        n = n0 * math.cos(az_rad) - e0 * math.sin(az_rad)
                        e = n0 * math.sin(az_rad) + e0 * math.cos(az_rad)
                        d = math.hypot(n, e)
                        bearing = math.degrees(math.atan2(e, n))
                        lonp, latp, _ = geod.fwd(
                            float(center_lon), float(center_lat), bearing, d
                        )
                        pts.append((latp, lonp))
                    folium.Polygon(
                        locations=pts,
                        color=color,
                        weight=1,
                        fill=True,
                        fill_opacity=ellipse_fill_opacity,
                        class_name=(
                            f"sigma-{int(round(float(sigma)))}"
                            if sigma is not None
                            else None
                        ),
                    ).add_to(target_layer)
                except Exception:
                    pass

            # Global toggle for Failure + Mean markers
            layer_markers = folium.FeatureGroup(name="Markers: Failure + Mean", show=True)

            for r in index_rows:
                row_idx = r.get("row")
                t = float(r.get("time_s", 0.0))
                label = _time_label(t)
                target_layer = time_layers.get(label)
                if not target_layer:
                    continue
                # Failure marker at CSV lat/lon for this time layer
                try:
                    la0 = r.get("lat")
                    lo0 = r.get("lon")
                    if la0 is not None and lo0 is not None:
                        tooltip_fail = f"Row {row_idx} | t = {label} | Failure: lat {float(la0):.5f}, lon {float(lo0):.5f}"
                        if "BeautifyIcon" in globals() and BeautifyIcon is not None:
                            icon_fail = BeautifyIcon(
                                icon="fa-star",
                                border_color="#2ca02c",
                                text_color="#ffffff",
                                background_color="#2ca02c",
                                icon_shape="marker",
                                inner_icon_style="font-size:3px;",
                            )
                            folium.Marker(location=[float(la0), float(lo0)], tooltip=tooltip_fail, icon=icon_fail).add_to(layer_markers)
                        else:
                            folium.Marker(location=[float(la0), float(lo0)], tooltip=tooltip_fail, icon=folium.Icon(color="green", icon="star", prefix="fa")).add_to(layer_markers)
                except Exception:
                    pass
                # Add impacts for this row into global toggles
                try:
                    imp_csv = r.get("impacts_csv")
                    if imp_csv:
                        import csv as _csv
                        with open(imp_csv, "r", newline="") as fimp:
                            rimp = _csv.DictReader(fimp)
                            for prow in rimp:
                                ti = (prow.get("impact_time_s") or "").strip()
                                if ti == "":
                                    continue
                                try:
                                    la = float(prow.get("impact_lat_deg")); lo = float(prow.get("impact_lon_deg"))
                                except Exception:
                                    continue
                                if not (np.isfinite(la) and np.isfinite(lo)):
                                    continue
                                unh = (str(prow.get("unharmed") or "").strip().lower() in ("1","true","yes"))
                                color = "#2ecc71" if unh else "#e74c3c"
                                folium.CircleMarker(
                                    location=(la, lo), radius=max(1, marker_radius), color=color,
                                    weight=1, fill=True, fill_opacity=marker_opacity,
                                ).add_to(layer_unharmov if unh else layer_harmov)
                except Exception:
                    pass

                if mode == "single":
                    la = r.get("impact_lat_deg")
                    lo = r.get("impact_lon_deg")
                    if la is not None and lo is not None:
                        try:
                            tooltip = f"Row {row_idx} | t = {label} | lat: {float(la):.5f}, lon: {float(lo):.5f}"
                            folium.CircleMarker(
                                location=[float(la), float(lo)],
                                radius=marker_radius,
                                color="#ff8c00",
                                fill=True,
                                fill_opacity=marker_opacity,
                                tooltip=tooltip,
                            ).add_to(target_layer)
                        except Exception:
                            pass
                else:
                    la = r.get("mean_impact_lat_deg")
                    lo = r.get("mean_impact_lon_deg")
                    if la is not None and lo is not None:
                        try:
                            tooltip = f"Row {row_idx} | t = {label} | lat: {float(la):.5f}, lon: {float(lo):.5f}"
                            if "BeautifyIcon" in globals() and BeautifyIcon is not None:
                                icon_mean = BeautifyIcon(
                                    icon="fa-arrow-down",
                                    border_color="#5e2d79",
                                    text_color="#ffffff",
                                    background_color="#7e3aa7",
                                    icon_shape="marker",
                                    inner_icon_style="font-size:3px;",
                                )
                                folium.Marker(location=[float(la), float(lo)], tooltip=tooltip, icon=icon_mean).add_to(layer_markers)
                            else:
                                folium.Marker(location=[float(la), float(lo)], tooltip=tooltip, icon=folium.Icon(color="purple", icon="arrow-down", prefix="fa")).add_to(layer_markers)
                        except Exception:
                            pass
                    # Ellipses per row from summary.json (in time layer)
                    try:
                        with open(r.get("summary_json"), "r") as _sf:
                            sdoc = json.load(_sf)
                        levels = sdoc.get("ellipse_levels", [])
                        ctr_lat = sdoc.get("ellipse_center_lat", la)
                        ctr_lon = sdoc.get("ellipse_center_lon", lo)
                        # colors per sigma
                        sig_colors = {1: "#2ca02c", 2: "#1f77b4", 3: "#d62728"}
                        for lvl in levels:
                            try:
                                sig = int(round(float(lvl.get("sigma", 0))))
                            except Exception:
                                continue
                            a_m = lvl.get("a_m")
                            b_m = lvl.get("b_m")
                            az = lvl.get("azimuth_deg")
                            if sig in (1, 2, 3):
                                add_ellipse(
                                    ctr_lat,
                                    ctr_lon,
                                    a_m,
                                    b_m,
                                    az,
                                    target_layer,
                                    sig_colors[sig],
                                    sigma=sig,
                                )
                    except Exception:
                        pass

            # (Heatmap overlay removed by request)

            # Add time layers (sorted by time ascending; min time layer is already set to show=True)
            for lbl in sorted(time_layers.keys(), key=lambda s: float(s.split()[0])):
                fmap.add_child(time_layers[lbl])
            fmap.add_child(layer_markers)
            # Inject JS to gate sigma visibility across time layers using the dummy sigma checkboxes
            try:
                from branca.element import MacroElement, Template

                tmpl = Template(
                    """
{% macro script(this,kwargs) %}
(function(){
  function applySigmaVisibility(){
    var checks = document.querySelectorAll('.leaflet-control-layers-overlays label');
    var st = {1:false,2:false,3:false};
    checks.forEach(function(lab){
      var txt=(lab.textContent||'').trim();
      var inp=lab.querySelector('input[type=\"checkbox\"]');
      if(!inp) return;
      if(txt==='Ellipses 1σ') st[1]=inp.checked;
      if(txt==='Ellipses 2σ') st[2]=inp.checked;
      if(txt==='Ellipses 3σ') st[3]=inp.checked;
    });
    [1,2,3].forEach(function(s){
      document.querySelectorAll('.sigma-'+s).forEach(function(el){ el.style.display = st[s] ? '' : 'none';});
    });
  }
  function attach(){
    var ctl = document.querySelector('.leaflet-control-layers-overlays');
    if(!ctl){ setTimeout(attach,200); return; }
    ctl.addEventListener('change', function(){ setTimeout(applySigmaVisibility, 0); });
    applySigmaVisibility();
  }
  if(document.readyState!=='loading') attach();
  else document.addEventListener('DOMContentLoaded', attach);
})();
{% endmacro %}
"""
                )
                macro = MacroElement()
                macro._template = tmpl
                fmap.get_root().add_child(macro)
            except Exception:
                pass
            folium.LayerControl(collapsed=False).add_to(fmap)
            overview_path = parent / "overview.html"
            fmap.save(str(overview_path))
    except Exception:
        pass

    # Build overview_inc_impacts HTML: time-selectable layers including all impact points (clusterable)
    try:
        ov2 = cfg.get("output", {}).get("overview_inc_impacts", {})
        write_ov2 = bool(ov2.get("write", True))
        if write_ov2 and index_rows:
            try:
                import folium
                from folium.plugins import MarkerCluster
                from pyproj import Geod
                try:
                    from folium.plugins import BeautifyIcon
                except Exception:
                    BeautifyIcon = None
            except Exception:
                write_ov2 = False
        if write_ov2:
            marker_radius = int(ov2.get("marker_radius", 3))
            marker_opacity = float(ov2.get("marker_opacity", 0.9))

            # Impact energy threshold (J) and color scheme for harmless/harmful
            try:
                ke_thresh_j = float(cfg.get("impact_energy", cfg.get("output", {}).get("impact_energy", {})).get("threshold_j", 15.0))
            except Exception:
                ke_thresh_j = 15.0
            color_harmless = "#2ecc71"
            color_harmful = "#e74c3c"

            # Center map on mean of explosion lat/lon
            lats = [r.get("lat") for r in index_rows if r.get("lat") is not None]
            lons = [r.get("lon") for r in index_rows if r.get("lon") is not None]
            lat_c = float(sum(lats) / len(lats)) if lats else 0.0
            lon_c = float(sum(lons) / len(lons)) if lons else 0.0

            fmap2 = folium.Map(location=[lat_c, lon_c], zoom_start=6, tiles="OpenStreetMap")
            # Global toggle layers for impacts by harm
            fg_unharm = folium.FeatureGroup(name="Unharmful Impacts", show=True)
            fg_harm = folium.FeatureGroup(name="Harmful Impacts", show=True)

            # Create time-based layers: one layer per CSV time value
            times = [float(r.get("time_s", 0.0)) for r in index_rows]
            min_time = min(times) if times else 0.0

            def _time_label2(t: float) -> str:
                try:
                    if float(t).is_integer():
                        return f"{int(round(float(t)))} sec"
                    else:
                        return f"{float(t):.1f} sec"
                except Exception:
                    return f"{t} sec"

            time_layers2 = {}
            for r in index_rows:
                t = float(r.get("time_s", 0.0))
                label = _time_label2(t)
                show = t == min_time
                if label not in time_layers2:
                    time_layers2[label] = folium.FeatureGroup(name=label, show=show)

            # Add impacts into global harm/unharm toggles and collect per-time harmful points
            impacts_by_label = {}  # kept for reference (all points)
            impacts_by_label_harm = {}
            for r in index_rows:
                t = float(r.get("time_s", 0.0))
                label = _time_label2(t)
                layer_fg = time_layers2[label]
                imp_csv = r.get("impacts_csv")
                if not imp_csv:
                    continue
                try:
                    import csv as _csv
                    pts = []
                    cluster = None
                    with open(imp_csv, "r", newline="") as fimp:
                        rimp = _csv.DictReader(fimp)
                        for prow in rimp:
                            ti = (prow.get("impact_time_s") or "").strip()
                            if ti == "":
                                continue
                            try:
                                la = float(prow.get("impact_lat_deg"))
                                lo = float(prow.get("impact_lon_deg"))
                            except Exception:
                                continue
                            if not (np.isfinite(la) and np.isfinite(lo)):
                                continue
                            unh_v = prow.get("unharmed")
                            try:
                                unh = (str(unh_v).strip().lower() in ("1", "true", "yes"))
                            except Exception:
                                unh = False
                            try:
                                idx_deb = int(prow.get("index"))
                            except Exception:
                                idx_deb = None
                            # Popup info
                            spd = prow.get("impact_speed_mps")
                            ke = prow.get("impact_ke_j")
                            mass = prow.get("mass_kg")
                            popup_html = (
                                f"<b>Row t={label}</b><br>"
                                f"Debris #{idx_deb if idx_deb is not None else ''}<br>"
                                f"lat: {la:.5f}, lon: {lo:.5f}<br>"
                                f"impact speed: {spd} m/s<br>"
                                f"impact KE: {ke} J<br>"
                                f"unharmed (<= {ke_thresh_j} J): {unh}<br>"
                                f"mass: {mass} kg"
                            )
                            color = color_harmless if unh else color_harmful
                            marker = folium.CircleMarker(
                                location=(la, lo),
                                radius=max(1, marker_radius),
                                color=color,
                                weight=1,
                                fill=True,
                                fill_opacity=marker_opacity,
                                popup=folium.Popup(popup_html, max_width=320),
                            )
                            impacts_by_label.setdefault(label, []).append((la, lo))
                            if unh:
                                fg_unharm.add_child(marker)
                            else:
                                fg_harm.add_child(marker)
                                impacts_by_label_harm.setdefault(label, []).append((la, lo))
                except Exception:
                    continue

            # Add the layers to the map
            for lbl, fg in time_layers2.items():
                fmap2.add_child(fg)
            fmap2.add_child(fg_unharm)
            fmap2.add_child(fg_harm)

            # Ellipse toggles and per-time empirical ellipses
            try:
                # Create empty sigma toggle layers (UI toggles only)
                layer_sigma1 = folium.FeatureGroup(name="Ellipses 1σ", show=False)
                layer_sigma2 = folium.FeatureGroup(name="Ellipses 2σ", show=False)
                layer_sigma3 = folium.FeatureGroup(name="Ellipses 3σ", show=True)
                fmap2.add_child(layer_sigma1)
                fmap2.add_child(layer_sigma2)
                fmap2.add_child(layer_sigma3)
                # Build per-time ellipses based on harmful-only points per time
                for lbl, pts_latlon in impacts_by_label_harm.items():
                    if len(pts_latlon) < 3:
                        continue
                    # Center at mean lat/lon per time label
                    lat_c_imp = float(sum(p[0] for p in pts_latlon) / len(pts_latlon))
                    lon_c_imp = float(sum(p[1] for p in pts_latlon) / len(pts_latlon))
                    # Build NE coordinates via geodesic from center
                    import math as _m
                    P = []
                    for la, lo in pts_latlon:
                        az12, az21, dist = geod.inv(lon_c_imp, lat_c_imp, lo, la)
                        azr = _m.radians(az12)
                        n = dist * _m.cos(azr)
                        e = dist * _m.sin(azr)
                        P.append([n, e])
                    P = np.array(P, dtype=float)
                    if P.shape[0] >= 3 and np.isfinite(P).all():
                        # Covariance and eigen decomposition
                        C = np.cov(P.T)
                        vals, vecs = np.linalg.eigh(C)
                        vals = np.clip(vals, 1e-9, None)
                        order = np.argsort(vals)
                        v_major = vecs[:, order[1]]
                        az_major = (np.degrees(np.arctan2(v_major[1], v_major[0])) + 360.0) % 360.0
                        from scipy.stats import chi2
                        levels = [
                            (1, 0.6827, "#2ca02c", layer_sigma1),
                            (2, 0.95,   "#1f77b4", layer_sigma2),
                            (3, 0.9973, "#d62728", layer_sigma3),
                        ]
                        for sig, conf_p, color, target_layer in levels:
                            try:
                                k2 = float(chi2.ppf(conf_p, df=2))
                            except Exception:
                                k2 = 5.991 if sig == 2 else (2.279 if sig == 1 else 11.829)
                            a_m = float(np.sqrt(max(k2, 0.0) * vals[order[1]]))
                            b_m = float(np.sqrt(max(k2, 0.0) * vals[order[0]]))
                            pts_out = []
                            az_rad = np.radians(az_major)
                            for k in range(0, 361, 3):
                                t = np.radians(k)
                                n0 = a_m * np.cos(t)
                                e0 = b_m * np.sin(t)
                                n = n0 * np.cos(az_rad) - e0 * np.sin(az_rad)
                                e = n0 * np.sin(az_rad) + e0 * np.cos(az_rad)
                                d = float(np.hypot(n, e))
                                bearing = float((np.degrees(np.arctan2(e, n)) + 360.0) % 360.0)
                                lonp, latp, _ = geod.fwd(lon_c_imp, lat_c_imp, bearing, d)
                                pts_out.append((latp, lonp))
                            # Attach ellipse to the sigma layer (no JS needed)
                            folium.Polygon(
                                locations=pts_out,
                                color=color,
                                weight=1,
                                fill=True,
                                fill_opacity=0.12,
                            ).add_to(target_layer)
            except Exception:
                pass

            # Mean harmful impact marker per time label (if at least 2 harmful points)
            try:
                for lbl, pts_latlon in impacts_by_label_harm.items():
                    if len(pts_latlon) < 2:
                        continue
                    lat_c_imp = float(sum(p[0] for p in pts_latlon) / len(pts_latlon))
                    lon_c_imp = float(sum(p[1] for p in pts_latlon) / len(pts_latlon))
                    tooltip = f"Mean Harmful Impact | {lbl}: lat {lat_c_imp:.5f}, lon {lon_c_imp:.5f}"
                    if BeautifyIcon is not None:
                        icon_mean = BeautifyIcon(icon='fa-arrow-down', border_color='#5e2d79', text_color='#ffffff', background_color='#7e3aa7', icon_shape='marker', inner_icon_style='font-size:3px;')
                        folium.Marker(location=[lat_c_imp, lon_c_imp], tooltip=tooltip, icon=icon_mean).add_to(time_layers2[lbl])
                    else:
                        folium.Marker(location=[lat_c_imp, lon_c_imp], tooltip=tooltip, icon=folium.Icon(color="purple", icon="arrow-down", prefix="fa")).add_to(time_layers2[lbl])
            except Exception:
                pass

            # Combined toggle for Failure + Mean markers across rows
            try:
                layer_markers = folium.FeatureGroup(name="Markers: Failure + Mean", show=True)
                # Failure per row
                for r in index_rows:
                    try:
                        la0 = float(r.get("lat")); lo0 = float(r.get("lon"))
                    except Exception:
                        continue
                    try:
                        if 'BeautifyIcon' in globals() and BeautifyIcon is not None:
                            icon_launch = BeautifyIcon(
                                icon='fa-star', border_color='#2ca02c', text_color='#ffffff',
                                background_color='#2ca02c', icon_shape='marker', inner_icon_style='font-size:3px;')
                            layer_markers.add_child(folium.Marker(location=(la0, lo0), tooltip="Failure", icon=icon_launch))
                        else:
                            layer_markers.add_child(folium.Marker(location=(la0, lo0), tooltip="Failure", icon=folium.Icon(color="green", icon="star", prefix="fa")))
                    except Exception:
                        pass
                # Mean per row
                for r in index_rows:
                    la_m = r.get("mean_impact_lat_deg"); lo_m = r.get("mean_impact_lon_deg")
                    if la_m is None or lo_m is None:
                        continue
                    try:
                        la_m = float(la_m); lo_m = float(lo_m)
                    except Exception:
                        continue
                    try:
                        if 'BeautifyIcon' in globals() and BeautifyIcon is not None:
                            icon_mean = BeautifyIcon(
                                icon='fa-arrow-down', border_color='#5e2d79', text_color='#ffffff',
                                background_color='#7e3aa7', icon_shape='marker', inner_icon_style='font-size:3px;')
                            layer_markers.add_child(folium.Marker(location=(la_m, lo_m), tooltip="Mean Impact", icon=icon_mean))
                        else:
                            layer_markers.add_child(folium.Marker(location=(la_m, lo_m), tooltip="Mean Impact", icon=folium.Icon(color="purple", icon="arrow-down", prefix="fa")))
                    except Exception:
                        pass
                fmap2.add_child(layer_markers)
            except Exception:
                pass

            # Layer control and save
            try:
                folium.LayerControl(collapsed=False).add_to(fmap2)
            except Exception:
                pass
            overview2_path = parent / "overview_inc_impacts.html"
            fmap2.save(str(overview2_path))
    except Exception:
        pass

    return {
        "parent_folder": str(parent.resolve()),
        "rows": len(index_rows),
        "index_csv": str(idx_csv.resolve()),
        "index_json": str(idx_json.resolve()),
    }


def _run_debris_batch_with_dict(cfg: dict) -> dict:
    """Convenience: run debris_batch with an in-memory config dict.
    Uses a unique temp file per call to avoid cross-process collisions.
    """
    import tempfile
    tf = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    temp_name = tf.name
    try:
        json.dump(cfg, tf)
        tf.flush()
        tf.close()
        return run_debris_batch(str(temp_name))
    finally:
        try:
            os.unlink(temp_name)
        except Exception:
            pass
