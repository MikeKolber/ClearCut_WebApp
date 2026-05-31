import json
import math
import os
import sys
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import numpy as np
from scipy.stats import chi2, truncnorm

from Classes.coordinate_transformation import CoordinateTransformation
from environment.gravity.coesa76_pyatmos import COESA76
from functions.runge_kutta4 import runge_kutta4

# Optional JIT (no hard dependency)
try:
    from numba import njit
except Exception:  # pragma: no cover

    def njit(*args, **kwargs):  # type: ignore
        def _wrap(f):
            return f

        return _wrap


@njit(cache=True)
def _kepler_acc_numba(r: np.ndarray, mu: float) -> np.ndarray:
    rx = r[0]
    ry = r[1]
    rz = r[2]
    r2 = rx * rx + ry * ry + rz * rz
    r1 = math.sqrt(r2)
    # Guard against r == 0
    if r1 == 0.0:
        return np.array([0.0, 0.0, 0.0])
    inv_r3 = 1.0 / (r1 * r1 * r1)
    s = -mu * inv_r3
    return np.array([s * rx, s * ry, s * rz])


def _kepler_acc_fast(r: np.ndarray, mu: float) -> np.ndarray:
    """Fast Kepler acceleration with optional Numba speedup (float64)."""
    return _kepler_acc_numba(r, mu)


def _build_coesa_table(atmosphere: COESA76, dz_m: float, h_max_m: float):
    """Precompute COESA density and speed-of-sound tables for 0..h_max at dz."""
    dz_m = float(max(1.0, dz_m))
    h_max_m = float(max(dz_m, h_max_m))
    z = np.arange(0.0, h_max_m + 0.5 * dz_m, dz_m, dtype=float)
    rho = np.empty_like(z)
    a = np.empty_like(z)
    for i, zi in enumerate(z):
        params = atmosphere.calculate(zi)
        rho[i] = float(params["density"]) if math.isfinite(params["density"]) else 0.0
        a[i] = (
            float(params["speed_of_sound"])
            if math.isfinite(params["speed_of_sound"])
            else 0.0
        )
    return z, rho, a


def _interp_linear(x_grid: np.ndarray, y_grid: np.ndarray, x: float) -> float:
    """Simple clipped linear interpolant for monotonically increasing grid."""
    if x <= x_grid[0]:
        return float(y_grid[0])
    if x >= x_grid[-1]:
        return float(y_grid[-1])
    i = int(np.searchsorted(x_grid, x))
    x0 = float(x_grid[i - 1])
    x1 = float(x_grid[i])
    y0 = float(y_grid[i - 1])
    y1 = float(y_grid[i])
    if x1 == x0:
        return y0
    t = (x - x0) / (x1 - x0)
    return y0 + t * (y1 - y0)


# WGS84 ellipsoid parameters (meters) — used for impact detection
_a_ell = 6378137.0
_b_ell = 6356752.314245


def _F_ecef(rvec: np.ndarray) -> float:
    try:
        x, y, z = float(rvec[0]), float(rvec[1]), float(rvec[2])
        return (x * x + y * y) / (_a_ell * _a_ell) + (z * z) / (_b_ell * _b_ell) - 1.0
    except Exception:
        return float("nan")


def _bisect_impact(
    prev_r: np.ndarray, r: np.ndarray, prev_t: float, dt: float
) -> tuple:
    """Bisection along the segment prev_r->r to locate ellipsoid boundary (F==0)."""
    lo, hi = 0.0, 1.0
    rdiff = r - prev_r
    f_lo = _F_ecef(prev_r)
    f_hi = _F_ecef(r)
    if not (np.isfinite(f_lo) and np.isfinite(f_hi)):
        alpha = 0.0
    else:
        for _ in range(30):
            mid = 0.5 * (lo + hi)
            r_mid = prev_r + mid * rdiff
            f_mid = _F_ecef(r_mid)
            if not np.isfinite(f_mid):
                mid = 0.5 * (lo + mid)
                r_mid = prev_r + mid * rdiff
                f_mid = _F_ecef(r_mid)
            if np.isfinite(f_lo) and (f_lo <= 0.0) != (f_mid <= 0.0):
                hi = mid
                f_hi = f_mid
            else:
                lo = mid
                f_lo = f_mid
            if hi - lo < 1e-6:
                break
        alpha = 0.5 * (lo + hi)
    alpha = max(0.0, min(1.0, float(alpha)))
    r_imp = prev_r + alpha * rdiff
    t_imp = prev_t + alpha * dt
    return t_imp, r_imp, alpha


def _integrate_chunk(
    indices,
    r0_ecef,
    v0_ecef,
    lat0,
    lon0,
    dt,
    t_max,
    output_stride,
    atmosphere_cutoff_m,
    omega_earth,
    masses,
    cda_s,
    dvxs,
    dvys,
    dvzs,
    idx_width,
    out_dir_str,
    save_csv,
    capture_traces,
    coesa_interp,
    coesa_dz,
    coesa_hmax,
    coesa_grid,
    coesa_rho,
    coesa_a,
):
    """Worker: integrate a chunk of debris indices and return results list."""
    # Reconstruct objects locally to avoid cross-process pickling issues
    coord = CoordinateTransformation()
    dcm_ecef2ned = coord.ecef_2_ned_dcm(lat0, lon0)
    v0_ned = dcm_ecef2ned @ v0_ecef
    v0_h = v0_ned.copy()
    v0_h[2] = 0.0
    v0_h_norm = np.linalg.norm(v0_h) or 1.0
    along_unit = v0_h / v0_h_norm
    mu = 3.986004418e14
    out_dir = Path(out_dir_str)

    def _rho_a_at(h_m: float):
        if h_m <= 0.0:
            return (
                0.0 if not coesa_interp else _interp_linear(coesa_grid, coesa_rho, 0.0)
            ), (0.0 if not coesa_interp else _interp_linear(coesa_grid, coesa_a, 0.0))
        if h_m > atmosphere_cutoff_m:
            return 0.0, 0.0
        if not coesa_interp:
            # fallback to on-demand COESA (slower); create model lazily per call to avoid global
            atm = COESA76()
            p = atm.calculate(h_m)
            return float(p["density"]), float(p["speed_of_sound"])
        # fast interpolated
        rh = _interp_linear(coesa_grid, coesa_rho, h_m)
        aa = _interp_linear(coesa_grid, coesa_a, h_m)
        return float(rh), float(aa)

    results = []

    for idx in indices:
        mass = float(masses[idx])
        cda = float(cda_s[idx])
        dvx = float(dvxs[idx])
        dvy = float(dvys[idx])
        dvz = float(dvzs[idx])

        state = np.concatenate(
            [r0_ecef, v0_ecef + np.array([dvx, dvy, dvz], dtype=float)]
        )
        t = 0.0
        step = 0
        times = [] if capture_traces else None
        hs = [] if capture_traces else None
        speeds = [] if capture_traces else None
        lats = [] if capture_traces else None
        lons = [] if capture_traces else None
        crossranges = [] if capture_traces else None
        downranges = [] if capture_traces else None
        xs = [] if capture_traces else None
        ys = [] if capture_traces else None
        zs = [] if capture_traces else None
        prev_r = None
        prev_v = None
        prev_h = None
        prev_t = None
        impact = None
        impact_status = "timeout"  # Default: exceeded t_max without impact

        while t <= t_max:
            r = state[0:3]
            v = state[3:6]
            # Numeric guards
            if not (np.all(np.isfinite(r)) and np.all(np.isfinite(v))):
                impact = None
                impact_status = "timeout"
                break
            speed = float(np.linalg.norm(v))
            if not np.isfinite(speed):
                impact = None
                impact_status = "timeout"
                break
            # Early-abort conditions (user-defined)
            try:
                # 1) Speed cap (m/s)
                if speed > 12000.0:
                    impact = None
                    impact_status = "timeout"
                    break
                # 2) Position magnitude cap: |r| > R_earth + 36,000 km
                # Interpret 36000 as km per user clarification.
                r_norm = float(np.linalg.norm(r))
                if r_norm > (6371000.0 + 36000.0 * 1000.0):
                    impact = None
                    impact_status = "timeout"
                    break
            except Exception:
                pass
            # Detect ellipsoid crossing using implicit function F(r)==0
            F_curr = _F_ecef(r)
            if prev_r is not None and prev_t is not None:
                F_prev = _F_ecef(prev_r)
                if np.isfinite(F_prev) and np.isfinite(F_curr):
                    if (F_prev > 0.0 and F_curr <= 0.0) or (
                        F_prev >= 0.0 and F_curr < 0.0
                    ):
                        # Crossing detected within this step
                        t_imp, r_imp, alpha = _bisect_impact(prev_r, r, prev_t, dt)
                        v_imp = (
                            prev_v + alpha * (v - prev_v) if (prev_v is not None) else v
                        )
                        try:
                            lat_i, lon_i, _ = coord.ecef_2_lla(r_imp)
                        except Exception:
                            # Fallback spherical approximation
                            x, y, z = float(r_imp[0]), float(r_imp[1]), float(r_imp[2])
                            lon_i = math.degrees(math.atan2(y, x))
                            hyp = math.hypot(x, y)
                            lat_i = math.degrees(math.atan2(z, hyp))
                        impact = (
                            t_imp,
                            float(lat_i),
                            float(lon_i),
                            float(np.linalg.norm(v_imp)),
                        )
                        impact_status = "impact"
                        break
                # If we are deep inside ellipsoid (F_curr < 0) without a clear bracket, stop
                if np.isfinite(F_curr) and (F_curr < 0.0):
                    impact = None
                    impact_status = "timeout"
                    break

            # Atmosphere (use height from LLA if available; guard against NaN)
            try:
                lat, lon, h = coord.ecef_2_lla(r)
            except Exception:
                lat = lon = h = float("nan")
            rho, a_sound = _rho_a_at(
                h if (h is not None and np.isfinite(h) and h > 0.0) else 0.0
            )

            # Aero forces (fixed Cd/Cl)
            speed = float(np.linalg.norm(v))
            if speed == 0.0 or rho == 0.0:
                drag_vec = np.zeros(3)
            else:
                drag_vec = -0.5 * rho * speed * cda * v

            # Accelerations
            a_g = _kepler_acc_fast(r, mu)
            coriolis = np.cross(2.0 * omega_earth, v)
            centrifugal = np.cross(omega_earth, np.cross(omega_earth, r))
            a_rot = -(coriolis + centrifugal)
            a_aero = (drag_vec) / mass
            a_total = a_g + a_aero + a_rot

            # Output stride
            if capture_traces and (step % max(1, output_stride) == 0):
                times.append(t)
                hs.append(h if (h is not None and np.isfinite(h)) else float("nan"))
                speeds.append(speed)
                lats.append(
                    lat if (lat is not None and np.isfinite(lat)) else float("nan")
                )
                lons.append(
                    lon if (lon is not None and np.isfinite(lon)) else float("nan")
                )
                xs.append(r[0])
                ys.append(r[1])
                zs.append(r[2])
                # Calculate crossrange/downrange with guards against astronomical values
                try:
                    p_ned = dcm_ecef2ned @ (r - r0_ecef)
                    # Check for unreasonable position magnitudes (> 1e10 m)
                    if np.linalg.norm(p_ned) > 1e10:
                        signed_cross = float("nan")
                        along = float("nan")
                    else:
                        p_h = p_ned.copy()
                        p_h[2] = 0.0
                        along = np.dot(p_h[:2], along_unit[:2])
                        pr = p_h[:2] - along * along_unit[:2]
                        sign_val = along_unit[0] * p_h[1] - along_unit[1] * p_h[0]
                        signed_cross = float(np.sign(sign_val) * np.linalg.norm(pr))
                        # Final sanity check on computed values
                        if not (np.isfinite(signed_cross) and abs(signed_cross) < 1e10):
                            signed_cross = float("nan")
                        if not (np.isfinite(along) and abs(along) < 1e10):
                            along = float("nan")
                except Exception:
                    signed_cross = float("nan")
                    along = float("nan")
                crossranges.append(signed_cross)
                downranges.append(
                    float(abs(along)) if np.isfinite(along) else float("nan")
                )

            # RK4 step
            def f(_t, y):
                rr = y[0:3]
                vv = y[3:6]
                lat2, lon2, h2 = coord.ecef_2_lla(rr)
                rho2, _ = _rho_a_at(h2 if h2 > 0.0 else 0.0)
                sp2 = float(np.linalg.norm(vv))
                if sp2 == 0.0 or rho2 == 0.0:
                    drag2 = np.zeros(3)
                else:
                    drag2 = -0.5 * rho2 * sp2 * cda * vv
                ag = _kepler_acc_fast(rr, mu)
                cor = np.cross(2.0 * omega_earth, vv)
                cen = np.cross(omega_earth, np.cross(omega_earth, rr))
                arot = -(cor + cen)
                a = ag + (drag2) / mass + arot
                return np.concatenate([vv, a])

            prev_r, prev_v, prev_h, prev_t = r, v, h, t
            state = runge_kutta4(f, t, state, dt)
            t += dt
            step += 1

        # Ensure endpoints captured
        if impact is not None:
            t_imp, lat_i, lon_i, speed_i = impact
            try:
                r_imp_vec = coord.lla_2_ecef(lat_i, lon_i, 0.0)
            except Exception:
                r_imp_vec = prev_r if prev_r is not None else (r0_ecef)
            # Calculate impact crossrange/downrange with guards
            try:
                p_ned_imp = dcm_ecef2ned @ (r_imp_vec - r0_ecef)
                # Check for unreasonable values
                if np.linalg.norm(p_ned_imp) > 1e10:
                    signed_cross_imp = float("nan")
                    along_imp = float("nan")
                else:
                    p_h_imp = p_ned_imp.copy()
                    p_h_imp[2] = 0.0
                    along_imp = np.dot(p_h_imp[:2], along_unit[:2])
                    pr_imp = p_h_imp[:2] - along_imp * along_unit[:2]
                    sign_val_imp = (
                        along_unit[0] * p_h_imp[1] - along_unit[1] * p_h_imp[0]
                    )
                    signed_cross_imp = float(
                        np.sign(sign_val_imp) * np.linalg.norm(pr_imp)
                    )
                    # Sanity check
                    if not (
                        np.isfinite(signed_cross_imp) and abs(signed_cross_imp) < 1e10
                    ):
                        signed_cross_imp = float("nan")
                    if not (np.isfinite(along_imp) and abs(along_imp) < 1e10):
                        along_imp = float("nan")
            except Exception:
                signed_cross_imp = float("nan")
                along_imp = float("nan")
            if capture_traces:
                times.append(float(t_imp) if t_imp is not None else t)
                hs.append(0.0)
                speeds.append(float(speed_i))
                lats.append(float(lat_i))
                lons.append(float(lon_i))
                xs.append(float(r_imp_vec[0]))
                ys.append(float(r_imp_vec[1]))
                zs.append(float(r_imp_vec[2]))
                crossranges.append(signed_cross_imp)
                downranges.append(
                    float(abs(along_imp)) if np.isfinite(along_imp) else float("nan")
                )

        csv_path = None
        if save_csv and capture_traces:
            csv_path = out_dir / f"debris_{idx:0{idx_width}d}.csv"
            import csv

            with open(csv_path, "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(
                    [
                        "t_s",
                        "lat_deg",
                        "lon_deg",
                        "h_m",
                        "speed_mps",
                        "x_m",
                        "y_m",
                        "z_m",
                        "signed_crossrange_m",
                        "downrange_m",
                    ]
                )
                for i in range(len(times)):
                    w.writerow(
                        [
                            times[i],
                            lats[i],
                            lons[i],
                            hs[i],
                            speeds[i],
                            xs[i],
                            ys[i],
                            zs[i],
                            crossranges[i],
                            downranges[i],
                        ]
                    )

        if impact is None:
            # No ground impact detected (or aborted due to non-finite state)
            impact = (None, None, None, None)

        results.append(
            {
                "idx": idx,
                "csv": str(csv_path) if csv_path else None,
                "times": times if capture_traces else [],
                "hs": hs if capture_traces else [],
                "speeds": speeds if capture_traces else [],
                "lats": lats if capture_traces else [],
                "lons": lons if capture_traces else [],
                "xs": xs if capture_traces else [],
                "ys": ys if capture_traces else [],
                "zs": zs if capture_traces else [],
                "cross": crossranges if capture_traces else [],
                "down": downranges if capture_traces else [],
                "impact_time_s": impact[0],
                "impact_lat_deg": impact[1],
                "impact_lon_deg": impact[2],
                "impact_speed_mps": impact[3],
                "impact_status": impact_status,
            }
        )

    return results


def _trunc_params(a, b, mu, sigma):
    a_n = (a - mu) / sigma
    b_n = (b - mu) / sigma
    return a_n, b_n


def _sample_symmetric_bimodal_trunc(n, mu_abs, sigma, vmin, vmax):
    """
    Sample n values from a symmetric bimodal normal distribution with peaks at
    ±mu_abs (equal weights 0.5), truncated to [vmin, vmax].
    """
    mu_abs = float(mu_abs)
    sigma = max(float(sigma), 1e-12)
    vmin = float(vmin)
    vmax = float(vmax)
    if vmax < vmin:
        vmin, vmax = vmax, vmin
    # Randomly pick sign for each sample
    signs = np.where(np.random.rand(n) < 0.5, 1.0, -1.0)
    locs = signs * mu_abs
    # Use per-sample truncated normal around chosen mean
    a = (vmin - locs) / sigma
    b = (vmax - locs) / sigma
    # SciPy truncnorm supports vectorized a,b,loc,scale with size
    return truncnorm.rvs(a, b, loc=locs, scale=sigma, size=n)


# Correlation-based samplers removed; all variables sampled independently.


## Removed unused erf helper


# Generic mixture sampler removed; using explicit symmetric bimodal per axis.


def _sample_truncnorm(n, vmin, vmax, mean, std):
    """
    Sample from a 1D truncated normal with given min, max, mean, std.
    If std <= 0 or vmin == vmax, returns a constant array at mean clipped to bounds.
    """
    vmin = float(vmin)
    vmax = float(vmax)
    mean = float(mean)
    std = float(std)
    if vmax < vmin:
        vmin, vmax = vmax, vmin
    if std <= 0 or abs(vmax - vmin) < 1e-12:
        val = float(min(max(mean, vmin), vmax))
        return np.full(n, val, dtype=float)
    a, b = (vmin - mean) / std, (vmax - mean) / std
    return truncnorm.rvs(a, b, loc=mean, scale=std, size=n)


# Gaussian copula rank-matching removed.


def run_debris_batch(config_path: str) -> dict:
    """
    Run a batch of debris simulations with correlated, truncated bimodal distributions.
    Writes outputs to a timestamped folder and returns a summary dict.
    """
    cfg_path = Path(config_path)
    with open(cfg_path, "r") as f:
        cfg = json.load(f)

    # Read general settings
    N = int(cfg.get("number_of_debris", 1))
    N = max(1, min(10000, N))
    notes = []
    seed = cfg.get("random_seed", None)
    if seed is not None:
        np.random.seed(int(seed))

    # Coordinate transform helper available for start conversion
    coord = CoordinateTransformation()

    base = cfg["base_state"]
    # Flexible start: support ECEF, LLA, or ECI (with TT epoch).
    # Velocity can be provided in ECEF or ECI (with TT epoch). Mixed frames allowed.
    r0_ecef = None
    v0_ecef = None
    pos_source = None
    vel_source = None

    # Parse epoch if provided (required when any ECI inputs are used)
    epoch_tt = base.get("epoch_tt", None)

    # Position candidates
    ecef0_cfg = base.get("ecef0", None)
    lla0_cfg = base.get("lla0", None)
    eci0_cfg = base.get("eci0", None)
    # Velocity candidates
    v_ecef_cfg = base.get("initial_velocity_ecef", None)
    v_eci_cfg = base.get("initial_velocity_eci", None)

    # Helper: convert ECI pos/vel to ECEF using Astropy at epoch TT
    def _eci_to_ecef_pos_vel(pos_eci_m=None, vel_eci_mps=None, pos_ecef_m=None):
        # pos_eci_m: np.array(3,) in meters in ECI (GCRS)
        # vel_eci_mps: np.array(3,) in m/s in ECI (GCRS)
        # pos_ecef_m: if ECI velocity is given but only ECEF/LLA position provided,
        #             supply ECEF position and we'll transform it to ECI first.
        if epoch_tt is None:
            raise ValueError("epoch_tt is required when using ECI inputs")
        try:
            import astropy.units as u
            from astropy.coordinates import (
                GCRS,
                ITRS,
                CartesianDifferential,
                CartesianRepresentation,
            )
            from astropy.time import Time
        except Exception as e:
            raise RuntimeError(
                f"Astropy import failed; required for ECI conversions: {e}"
            )

        # Ensure IERS/EOP are available for maximum accuracy
        try:
            from astropy.utils import iers

            iers.conf.auto_download = True
            try:
                from astropy.utils.iers import IERS_Auto

                _ = IERS_Auto.open()
            except Exception:
                pass
        except Exception:
            pass

        t = Time(str(epoch_tt), scale="tt")

        # Build GCRS position (either from provided ECI position or by converting ECEF position)
        if pos_eci_m is not None:
            gcrs_pos = GCRS(CartesianRepresentation(*(pos_eci_m * u.m)), obstime=t)
        elif pos_ecef_m is not None:
            # Convert ECEF->ECI to attach ECI velocity
            itrs_pos = ITRS(CartesianRepresentation(*(pos_ecef_m * u.m)), obstime=t)
            gcrs_pos = itrs_pos.transform_to(GCRS(obstime=t))
        else:
            raise ValueError(
                "Position required for ECI velocity transform (provide eci0 or ecef0/lla0)"
            )

        # If ECI velocity provided, attach and transform back to ITRS
        if vel_eci_mps is not None:
            vel = CartesianDifferential(*(vel_eci_mps * u.m / u.s))
            gcrs_posvel = GCRS(gcrs_pos.cartesian.with_differentials(vel), obstime=t)
            itrs_posvel = gcrs_posvel.transform_to(ITRS(obstime=t))
            r_ecef = np.array(
                [
                    itrs_posvel.cartesian.x.to_value(u.m),
                    itrs_posvel.cartesian.y.to_value(u.m),
                    itrs_posvel.cartesian.z.to_value(u.m),
                ],
                dtype=float,
            )
            v_ecef = np.array(
                [
                    itrs_posvel.velocity.d_x.to_value(u.m / u.s),
                    itrs_posvel.velocity.d_y.to_value(u.m / u.s),
                    itrs_posvel.velocity.d_z.to_value(u.m / u.s),
                ],
                dtype=float,
            )
            return r_ecef, v_ecef
        else:
            # Only position requested (ECI->ECEF)
            itrs_pos = gcrs_pos.transform_to(ITRS(obstime=t))
            r_ecef = np.array(
                [
                    itrs_pos.cartesian.x.to_value(u.m),
                    itrs_pos.cartesian.y.to_value(u.m),
                    itrs_pos.cartesian.z.to_value(u.m),
                ],
                dtype=float,
            )
            return r_ecef, None

    # 1) Resolve starting position in ECEF
    if isinstance(ecef0_cfg, dict):
        try:
            x0 = float(ecef0_cfg.get("x"))
            y0 = float(ecef0_cfg.get("y"))
            z0 = float(ecef0_cfg.get("z"))
            if np.isfinite(x0) and np.isfinite(y0) and np.isfinite(z0):
                r0_ecef = np.array([x0, y0, z0], dtype=float)
                pos_source = "ecef"
        except Exception:
            r0_ecef = None

    if r0_ecef is None and isinstance(lla0_cfg, dict):
        try:
            lat0_in = float(lla0_cfg.get("lat_deg"))
            lon0_in = float(lla0_cfg.get("lon_deg"))
            h0_in = float(lla0_cfg.get("h_m"))
            # Prefer Astropy EarthLocation for highest fidelity; fallback to internal converter
            try:
                import astropy.units as u
                from astropy.coordinates import EarthLocation

                loc = EarthLocation.from_geodetic(
                    lon0_in * u.deg, lat0_in * u.deg, h0_in * u.m
                )
                r0_ecef = np.array(
                    [loc.x.to_value(u.m), loc.y.to_value(u.m), loc.z.to_value(u.m)],
                    dtype=float,
                )
            except Exception:
                r0_ecef = coord.lla_2_ecef(lat0_in, lon0_in, h0_in)
            pos_source = "lla"
        except Exception:
            r0_ecef = None

    if r0_ecef is None and isinstance(eci0_cfg, dict):
        try:
            x0e = float(eci0_cfg.get("x"))
            y0e = float(eci0_cfg.get("y"))
            z0e = float(eci0_cfg.get("z"))
            r_ecef_conv, _ = _eci_to_ecef_pos_vel(
                pos_eci_m=np.array([x0e, y0e, z0e], dtype=float)
            )
            r0_ecef = r_ecef_conv
            pos_source = "eci"
        except Exception as e:
            raise ValueError(f"ECI position provided but conversion failed: {e}")

    # Fallback to legacy lat0/lon0/h0
    if r0_ecef is None:
        lat0_in = float(base["lat0"])  # deg
        lon0_in = float(base["lon0"])  # deg
        h0_in = float(base["h0"])  # m
        r0_ecef = coord.lla_2_ecef(lat0_in, lon0_in, h0_in)
        pos_source = "legacy_lla"

    # Compute geodetic for later use (prefer Astropy EarthLocation)
    try:
        import astropy.units as u
        from astropy.coordinates import EarthLocation

        loc0 = EarthLocation.from_geocentric(
            r0_ecef[0] * u.m, r0_ecef[1] * u.m, r0_ecef[2] * u.m
        )
        lat0 = float(loc0.lat.to_value(u.deg))
        lon0 = float(loc0.lon.to_value(u.deg))
        h0 = float(loc0.height.to_value(u.m))
    except Exception:
        lat0, lon0, h0 = coord.ecef_2_lla(r0_ecef)

    # 2) Resolve initial velocity in ECEF
    if isinstance(v_ecef_cfg, dict):
        try:
            vx0 = float(v_ecef_cfg.get("vx"))
            vy0 = float(v_ecef_cfg.get("vy"))
            vz0 = float(v_ecef_cfg.get("vz"))
            v0_ecef = np.array([vx0, vy0, vz0], dtype=float)
            vel_source = "ecef"
        except Exception:
            v0_ecef = None

    if v0_ecef is None and isinstance(v_eci_cfg, dict):
        try:
            vx_e = float(v_eci_cfg.get("vx"))
            vy_e = float(v_eci_cfg.get("vy"))
            vz_e = float(v_eci_cfg.get("vz"))
            # Choose associated position for velocity transform
            if isinstance(eci0_cfg, dict):
                x0e = float(eci0_cfg.get("x"))
                y0e = float(eci0_cfg.get("y"))
                z0e = float(eci0_cfg.get("z"))
                r_conv, v_conv = _eci_to_ecef_pos_vel(
                    pos_eci_m=np.array([x0e, y0e, z0e], dtype=float),
                    vel_eci_mps=np.array([vx_e, vy_e, vz_e], dtype=float),
                )
            else:
                # Use resolved ECEF position and transform internally to ECI to attach v_eci
                r_conv, v_conv = _eci_to_ecef_pos_vel(
                    pos_ecef_m=np.array(r0_ecef, dtype=float),
                    vel_eci_mps=np.array([vx_e, vy_e, vz_e], dtype=float),
                )
            # r_conv should match r0_ecef within transform precision; prefer resolved r0_ecef
            v0_ecef = v_conv
            vel_source = "eci"
        except Exception as e:
            raise ValueError(f"ECI velocity provided but conversion failed: {e}")

    # Final guard
    if v0_ecef is None:
        raise ValueError(
            "No valid initial velocity provided. Provide initial_velocity_ecef or initial_velocity_eci with epoch_tt."
        )

    # Physics
    physics = cfg.get("physics", {})
    use_j2 = bool(physics.get("use_j2", False))
    if use_j2:
        # For batch we fix to Kepler only
        use_j2 = False
    atmosphere_cutoff_m = float(physics.get("atmosphere_cutoff_m", 100000.0))
    alpha_deg = float(physics.get("alpha_deg", 0.0))
    # Enforce fixed aero only, per user request
    aero_model = str(physics.get("aero_model", "fixed")).lower()
    if aero_model != "fixed":
        raise ValueError("physics.aero_model must be 'fixed' for debris batch")

    # Deterministic single-debris override (no sampling)
    single_cfg = cfg.get("single_debris")
    single_mode = False
    if isinstance(single_cfg, dict):
        if N != 1:
            # Prefer single_debris to override N; record a note for visibility
            notes.append("single_debris present; number_of_debris overridden to 1")
            N = 1
        single_mode = True

    # Distributions (independent): dv_components symmetric bimodal; positives via trunc_normal
    dist_cfg = cfg.get("distributions", {}) if not single_mode else {}
    # Global minimum mass (kg)
    try:
        min_mass_kg_cfg = float(
            dist_cfg.get("min_mass_kg", cfg.get("min_mass_kg", 0.001))
        )
    except Exception:
        min_mass_kg_cfg = 0.001
    # Explosion ΔV model (no legacy per-axis model)
    dv_cfg = cfg.get("dv_explosion", {}) if not single_mode else {}
    alpha = float(dv_cfg.get("alpha", 1.6))
    Lc_min = float(dv_cfg.get("Lc_min_m", 0.001))
    Lc_max = float(dv_cfg.get("Lc_max_m", 0.5))
    k_am = float(dv_cfg.get("k_am", 0.0005556))
    sigma_log10_am = float(dv_cfg.get("sigma_log10_am", 0.25))
    mu_offset = float(dv_cfg.get("mu_offset", 1.85))
    mu_slope = float(dv_cfg.get("mu_slope", 0.2))
    sigma_log10_dv = float(dv_cfg.get("sigma_log10_dv", 0.4))
    dv_min = float(dv_cfg.get("dv_min", 1.0))
    dv_max = float(dv_cfg.get("dv_max", 4000.0))

    # Positive distributions specs with explicit mu/sigma/min/max
    def _get_trunc_spec(name, defaults):
        s = dist_cfg.get(name, defaults)
        mu = float(s.get("mu", defaults.get("mu", 1.0)))
        vmin = float(s.get("min", defaults.get("min", -float("inf"))))
        vmax = float(s.get("max", defaults.get("max", float("inf"))))
        if vmin > vmax:
            vmin, vmax = vmax, vmin
        # Compute sigma from bounds if not provided: place ~99.7% within [min,max]
        sigma_val = s.get("sigma", None)
        if sigma_val is None:
            if vmin <= mu <= vmax:
                left = max(mu - vmin, 1e-12)
                right = max(vmax - mu, 1e-12)
                sigma = max(min(left, right) / 3.0, 1e-12)
            else:
                notes.append(
                    f"Warning: distributions.{name}.mu outside [min,max]; using (max-min)/6 for σ"
                )
                width = max(vmax - vmin, 1e-12)
                sigma = max(width / 6.0, 1e-12)
        else:
            sigma = max(float(sigma_val), 1e-12)
        return mu, sigma, vmin, vmax

    # Mass distribution: support log-normal (preferred) or truncated normal (legacy)
    mass_model = str(dist_cfg.get("mass_model", "truncnorm")).lower()
    mass_mu, mass_sigma, mass_min, mass_max = _get_trunc_spec(
        "mass_kg", {"mu": 8.0, "sigma": 1.5, "min": 0.1, "max": 20.0}
    )
    masslog_cfg = dist_cfg.get("mass_lognorm", {})
    # Support modes: by_p_target (solve mu so CDF(target_x)=target_p for given sigma), or by_median
    masslog_mode = str(masslog_cfg.get("mode", "by_median")).lower()

    # Parameters (prefer kg keys; support legacy *_g by converting to kg)
    def _get_float(d, k, default):
        try:
            return float(d.get(k, default))
        except Exception:
            return default

    masslog_sigma = _get_float(
        masslog_cfg, "sigma", _get_float(masslog_cfg, "sigma_hint", 1.0)
    )
    target_p = _get_float(masslog_cfg, "target_p", 0.95)
    target_x_kg = masslog_cfg.get("target_x_kg", None)
    if target_x_kg is None:
        # Legacy support: target_x_g
        gx = masslog_cfg.get("target_x_g", None)
        target_x_kg = (float(gx) / 1000.0) if gx is not None else 0.025
    else:
        target_x_kg = float(target_x_kg)
    masslog_median_kg = masslog_cfg.get("median_kg", None)
    if masslog_median_kg is None:
        mg = masslog_cfg.get("median_g", None)
        masslog_median_kg = (float(mg) / 1000.0) if mg is not None else 0.00483
    else:
        masslog_median_kg = float(masslog_median_kg)
    # Optional truncation in kg (clip bounds)
    masslog_min_kg = masslog_cfg.get("min_kg", None)
    if masslog_min_kg is None:
        gmin = masslog_cfg.get("min_g", None)
        masslog_min_kg = (float(gmin) / 1000.0) if gmin is not None else None
    else:
        masslog_min_kg = float(masslog_min_kg)
    masslog_max_kg = masslog_cfg.get("max_kg", None)
    if masslog_max_kg is None:
        gmax = masslog_cfg.get("max_g", None)
        masslog_max_kg = (float(gmax) / 1000.0) if gmax is not None else None
    else:
        masslog_max_kg = float(masslog_max_kg)
    diam_mu, diam_sigma, diam_min, diam_max = _get_trunc_spec(
        "diameter_m", {"mu": 0.15, "sigma": 0.03, "min": 0.02, "max": 0.5}
    )
    cd_mu, cd_sigma, cd_min, cd_max = _get_trunc_spec(
        "fixed_cd", {"mu": 1.0, "sigma": 0.2, "min": 0.05, "max": 3.0}
    )
    cl_mu, cl_sigma, cl_min, cl_max = _get_trunc_spec(
        "fixed_cl", {"mu": 0.05, "sigma": 0.02, "min": 0.0, "max": 0.5}
    )

    # Constraints (legacy removed)
    constraints = cfg.get("constraints", {})
    eq_d = False

    # Material density and tumble Cd reference for deterministic CdA
    try:
        rho_mat = float(cfg.get("material_density_kg_m3", 2700.0))
    except Exception:
        rho_mat = 2700.0
    try:
        cd_ref = float(cfg.get("drag_coefficient_ref", cfg.get("cd_tumble_ref", 1.1)))
    except Exception:
        cd_ref = 1.1

    if single_mode:
        # Deterministic single case: mass provided, CdA from mass & material
        def _req(name):
            if name not in single_cfg:
                raise ValueError(f"single_debris missing required field: {name}")
            return single_cfg[name]

        mass_s = np.array([float(_req("mass_kg"))], dtype=float)
        if not (np.isfinite(mass_s[0]) and mass_s[0] > 0.0):
            raise ValueError("single_debris.mass_kg must be a positive finite number")
        # Enforce minimum mass
        if mass_s[0] < float(min_mass_kg_cfg):
            mass_s[0] = float(min_mass_kg_cfg)

        # Δv components provided directly
        dvx_s = np.array([float(single_cfg.get("dvx", 300.0))], dtype=float)
        dvy_s = np.array([float(single_cfg.get("dvy", 0.0))], dtype=float)
        dvz_s = np.array([float(single_cfg.get("dvz", 0.0))], dtype=float)

        # CdA model (single): default from mass via equivalent sphere
        try:
            cda_model = str(
                cfg.get("distributions", {}).get(
                    "cda_model", cfg.get("cda_model", "from_mass")
                )
            ).lower()
        except Exception:
            cda_model = "from_mass"

        if cda_model == "diameter":
            # If diameter provided in single_debris, use it; else fallback to from_mass
            d_single = single_cfg.get("diameter_m", None)
            try:
                if d_single is not None and float(d_single) > 0.0:
                    A_single = 0.25 * np.pi * (float(d_single) ** 2)
                    cda_s = np.array([cd_ref * A_single], dtype=float)
                else:
                    raise ValueError("no diameter for single")
            except Exception:
                d_eq_single = float(
                    ((6.0 * mass_s[0]) / (np.pi * rho_mat)) ** (1.0 / 3.0)
                )
                A_single = 0.25 * np.pi * (d_eq_single**2)
                cda_s = np.array([cd_ref * A_single], dtype=float)
        elif cda_model == "lognormal":
            ln_cfg = cfg.get("distributions", {}).get("cda_lognorm", {})
            try:
                med = float(ln_cfg.get("median_m2"))
            except Exception:
                med = None
            try:
                s = float(ln_cfg.get("sigma", 0.8))
            except Exception:
                s = 0.8
            if med is not None and med > 0.0:
                try:
                    cda_s = np.array(
                        [
                            float(
                                np.random.lognormal(
                                    mean=np.log(med), sigma=max(s, 1e-9)
                                )
                            )
                        ],
                        dtype=float,
                    )
                except Exception:
                    d_eq_single = float(
                        ((6.0 * mass_s[0]) / (np.pi * rho_mat)) ** (1.0 / 3.0)
                    )
                    A_single = 0.25 * np.pi * (d_eq_single**2)
                    cda_s = np.array([cd_ref * A_single], dtype=float)
            else:
                d_eq_single = float(
                    ((6.0 * mass_s[0]) / (np.pi * rho_mat)) ** (1.0 / 3.0)
                )
                A_single = 0.25 * np.pi * (d_eq_single**2)
                cda_s = np.array([cd_ref * A_single], dtype=float)
        else:
            # from_mass
            d_eq_single = float(((6.0 * mass_s[0]) / (np.pi * rho_mat)) ** (1.0 / 3.0))
            A_single = 0.25 * np.pi * (d_eq_single**2)
            cda_s = np.array([cd_ref * A_single], dtype=float)
        beta_s = mass_s / np.maximum(cda_s, 1e-12)
        A_from_beta_s = cda_s / max(cd_ref, 1e-12)
    else:
        # Mass split or sampling
        mass_override = cfg.get("mass_override_kg", None)
        if isinstance(mass_override, list) or isinstance(mass_override, tuple):
            mass_arr = np.array(mass_override, dtype=float)
            if mass_arr.size != N:
                raise ValueError(
                    f"mass_override_kg length {mass_arr.size} must equal number_of_debris {N}"
                )
            if not (np.all(np.isfinite(mass_arr)) and np.all(mass_arr > 0.0)):
                raise ValueError(
                    "mass_override_kg must contain positive, finite values"
                )
            # Enforce minimum mass on overrides
            mass_s = np.maximum(mass_arr, float(min_mass_kg_cfg))
            # Update plotting ranges to reflect overrides
            mass_min = float(np.min(mass_s))
            mass_max = float(np.max(mass_s))
            mass_mu = float(np.mean(mass_s))
            mass_sigma = float(np.std(mass_s))
        else:
            if mass_model == "lognormal":
                # Log-normal in kg; compute scale depending on mode
                try:
                    import math as _m

                    from scipy.stats import lognorm as _ln

                    s = max(1e-9, float(masslog_sigma))
                    if masslog_mode == "by_p_target":
                        # mu = ln(target_x_kg) - s*z_p where z_p ~ Phi^-1(target_p)
                        # approximate z for common p=0.95
                        z_p = (
                            1.6448536269514722
                            if abs(target_p - 0.95) < 1e-6
                            else (
                                float(_m.sqrt(2) * _m.erfinv(2 * target_p - 1))
                                if 0.0 < target_p < 1.0
                                else 1.6448536269514722
                            )
                        )
                        mu = _m.log(max(target_x_kg, 1e-12)) - s * z_p
                        scale = _m.exp(mu)
                    else:
                        # by_median (scale equals median in kg)
                        scale = max(1e-12, float(masslog_median_kg))
                    samples = _ln.rvs(s=s, scale=scale, size=N)
                    if (masslog_min_kg is not None) or (masslog_max_kg is not None):
                        if masslog_min_kg is not None:
                            samples = np.maximum(samples, float(masslog_min_kg))
                        if masslog_max_kg is not None:
                            samples = np.minimum(samples, float(masslog_max_kg))
                    # Enforce global minimum mass
                    samples = np.maximum(samples, float(min_mass_kg_cfg))
                    mass_s = np.asarray(samples, dtype=float)
                except Exception:
                    mass_s = _sample_truncnorm(
                        N, mass_min, mass_max, mass_mu, mass_sigma
                    )
                    notes.append(
                        "mass_model lognormal requested but sampling failed; used truncnorm fallback"
                    )
            else:
                mass_min = max(float(mass_min), float(min_mass_kg_cfg))
                mass_s = _sample_truncnorm(N, mass_min, mass_max, mass_mu, mass_sigma)
        # CdA model selection (batch)
        try:
            cda_model = str(
                cfg.get("distributions", {}).get(
                    "cda_model", cfg.get("cda_model", "from_mass")
                )
            ).lower()
        except Exception:
            cda_model = "from_mass"
        if cda_model == "diameter":
            # Sample diameters and compute CdA
            try:
                d_eq_s = _sample_truncnorm(
                    N, diam_min, diam_max, diam_mu, max(diam_sigma, 1e-12)
                )
            except Exception:
                d_eq_s = np.full(int(N), float(diam_mu), dtype=float)
            A_from_beta_s = 0.25 * np.pi * (d_eq_s**2)
            cda_s = cd_ref * A_from_beta_s
            beta_s = mass_s / np.maximum(cda_s, 1e-12)
        elif cda_model == "lognormal":
            ln_cfg = cfg.get("distributions", {}).get("cda_lognorm", {})
            try:
                med = float(ln_cfg.get("median_m2", 0.0))
            except Exception:
                med = 0.0
            try:
                s = float(ln_cfg.get("sigma", 0.8))
            except Exception:
                s = 0.8
            if med > 0.0:
                try:
                    cda_s = np.random.lognormal(
                        mean=np.log(med), sigma=max(s, 1e-9), size=int(N)
                    )
                except Exception:
                    # fallback to from_mass
                    d_eq_s = ((6.0 * mass_s) / (np.pi * rho_mat)) ** (1.0 / 3.0)
                    A_from_beta_s = 0.25 * np.pi * (d_eq_s**2)
                    cda_s = cd_ref * A_from_beta_s
            else:
                d_eq_s = ((6.0 * mass_s) / (np.pi * rho_mat)) ** (1.0 / 3.0)
                A_from_beta_s = 0.25 * np.pi * (d_eq_s**2)
                cda_s = cd_ref * A_from_beta_s
            beta_s = mass_s / np.maximum(cda_s, 1e-12)
            # Provide A_from_beta_s consistent with cda_s
            A_from_beta_s = cda_s / max(cd_ref, 1e-12)
        else:
            # from_mass (equivalent sphere)
            d_eq_s = ((6.0 * mass_s) / (np.pi * rho_mat)) ** (1.0 / 3.0)
            A_from_beta_s = 0.25 * np.pi * (d_eq_s**2)
            cda_s = cd_ref * A_from_beta_s
            beta_s = mass_s / np.maximum(cda_s, 1e-12)

        # Δv components: symmetric bimodal per-axis (independent), with axis-wise truncation
        def _sigma_for_bimodal(spec):
            mu_abs = float(spec.get("mu_abs", 60.0))
            vmin = float(spec.get("min", -150.0))
            vmax = float(spec.get("max", 150.0))
            # Prefer user-provided sigma if present, else compute so 3σ fits between peak and nearest bound
            if "sigma" in spec and spec["sigma"] is not None:
                return max(float(spec["sigma"]), 1e-12)
            left_space = (-mu_abs) - vmin
            right_space = vmax - mu_abs
            span = min(left_space, right_space)
            if span <= 0:
                notes.append(
                    "Warning: dv component bounds too tight around ±mu_abs; using (max-min)/12 for σ"
                )
                return max((vmax - vmin) / 12.0, 1e-12)
            return max(span / 3.0, 1e-12)

        # Sample ΔV (magnitude) and assign random directions
        U = np.random.rand(N)
        if abs(alpha - 1.0) < 1e-12:
            Lc = Lc_min * (Lc_max / Lc_min) ** U
        else:
            a1 = Lc_min ** (1.0 - alpha)
            b1 = Lc_max ** (1.0 - alpha)
            Lc = (a1 + (b1 - a1) * U) ** (1.0 / (1.0 - alpha))
        Lc = np.clip(Lc, Lc_min, Lc_max)

        log10_am_base = np.log10(max(k_am, 1e-16)) - np.log10(np.maximum(Lc, 1e-16))
        chi = log10_am_base + np.random.normal(0.0, max(sigma_log10_am, 1e-12), size=N)
        mu = mu_offset + mu_slope * chi
        log10_dv = np.random.normal(mu, max(sigma_log10_dv, 1e-12), size=N)
        DV = np.power(10.0, log10_dv)
        DV = np.clip(DV, dv_min, dv_max)

        g = np.random.normal(size=(N, 3))
        norms = np.linalg.norm(g, axis=1)
        norms = np.where(norms <= 0.0, 1.0, norms)
        u = g / norms[:, None]
        dvx_s = DV * u[:, 0]
        dvy_s = DV * u[:, 1]
        dvz_s = DV * u[:, 2]

        # Store stats for summary
        try:
            p50, p90, p99 = [float(x) for x in np.percentile(DV, [50, 90, 99])]
            dv_stats_local = {
                "p50": p50,
                "p90": p90,
                "p99": p99,
                "min": float(np.min(DV)),
                "max": float(np.max(DV)),
                "mean_log10": float(np.mean(np.log10(np.where(DV > 0, DV, 1.0)))),
                "count": int(N),
            }
        except Exception:
            dv_stats_local = None
        dv_params_local = {
            "alpha": alpha,
            "Lc_min_m": Lc_min,
            "Lc_max_m": Lc_max,
            "k_am": k_am,
            "sigma_log10_am": sigma_log10_am,
            "mu_offset": mu_offset,
            "mu_slope": mu_slope,
            "sigma_log10_dv": sigma_log10_dv,
            "dv_min": dv_min,
            "dv_max": dv_max,
        }

    # Setup environment
    # Match main simulation: default COESA76 warnings/behavior
    atmosphere = COESA76(is_check_warning=False)
    omega_earth = np.array([0.0, 0.0, 7.29211585e-5])
    mu = 3.986004418e14

    # COESA interpolation (optional)
    coesa_cfg = cfg.get("compute", {}).get("coesa_interp", {})
    coesa_interp_enabled = bool(coesa_cfg.get("enabled", False))
    coesa_dz_m = float(coesa_cfg.get("dz_m", 10.0))
    coesa_h_max_m = float(coesa_cfg.get("h_max_m", 120000.0))
    z_grid = rho_grid = a_grid = None
    if coesa_interp_enabled:
        try:
            z_grid, rho_grid, a_grid = _build_coesa_table(
                atmosphere, coesa_dz_m, coesa_h_max_m
            )
            notes.append(
                f"COESA table built: dz={coesa_dz_m} m, h_max={coesa_h_max_m} m, size={z_grid.size}"
            )
        except Exception as e:
            notes.append(f"COESA table build failed; falling back to exact: {e}")
            coesa_interp_enabled = False

    # Launch site
    # r0_ecef already determined above
    dcm_ecef2ned = coord.ecef_2_ned_dcm(lat0, lon0)
    v0_ned = dcm_ecef2ned @ v0_ecef
    # Along-track unit in horizontal plane
    v0_h = v0_ned.copy()
    v0_h[2] = 0.0
    v0_h_norm = np.linalg.norm(v0_h) or 1.0
    along_unit = v0_h / v0_h_norm

    # Output folder
    # Use a unique name to avoid collisions under parallel row execution
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        import uuid

        uniq = uuid.uuid4().hex[:6]
    except Exception:
        uniq = f"{os.getpid():x}"
    # Keep readable prefix; uniqueness ensures no cross-process clobbering
    out_dir_name = (
        f"debris_single_{ts}_{uniq}" if single_mode else f"debris_batch_{ts}_{uniq}"
    )
    # Allow caller to suggest a parent dir for output
    output_parent_dir = cfg.get("output_parent_dir")
    if output_parent_dir:
        base_dir = Path(str(output_parent_dir))
    else:
        base_dir = Path(".")
    out_dir = (base_dir / out_dir_name).resolve()
    out_dir.mkdir(parents=True, exist_ok=False)

    # Time settings
    dt = float(cfg.get("dt", 0.1))
    t_max = float(cfg.get("t_max", 20000.0))
    output_cfg = cfg.get("output", {})
    # standardized output keys only
    output_stride = int(output_cfg.get("stride", 1))
    write_plots = bool(output_cfg.get("plots", True))
    auto_open = bool(output_cfg.get("open_plots", False))
    # Impact energy options (read from top-level config, fallback to output for legacy)
    try:
        ke_thresh_j = float(
            cfg.get("impact_energy", output_cfg.get("impact_energy", {})).get(
                "threshold_j", 15.0
            )
        )
    except Exception:
        ke_thresh_j = 15.0
    # save_debris_csv (standardized)
    capture_traces = bool(output_cfg.get("save_debris_csv", True))
    save_csv = bool(output_cfg.get("save_debris_csv", True))

    # Parallel settings (clean: new key only)
    par_cfg = cfg.get("parallel_debris", {})
    par_enabled = bool(par_cfg.get("enabled", False))
    try:
        default_workers = os.cpu_count() or 10
    except Exception:
        default_workers = 10
    workers = int(par_cfg.get("workers", default_workers))
    chunk_size = int(par_cfg.get("chunk_size", 200))

    # Storage for combined plots
    traces_alt_time = []
    traces_speed_time = []
    traces_ground = []
    traces_alt_cross = []
    traces_alt_down = []

    summary = []

    # Determine CSV index width based on N for consistent lexicographic ordering
    idx_width = max(3, len(str(max(1, N) - 1)))

    # Helper: integrate one debris
    def integrate_one(idx, mass, cda, dvx, dvy, dvz):
        state = np.concatenate(
            [r0_ecef, v0_ecef + np.array([dvx, dvy, dvz], dtype=float)]
        )
        t = 0.0
        step = 0
        times = []
        hs = []
        speeds = []
        lats = []
        lons = []
        crossranges = []
        downranges = []
        xs = []
        ys = []
        zs = []
        prev_r = None
        prev_v = None
        prev_h = None
        prev_t = None
        impact = None
        impact_status = "timeout"  # Default: exceeded t_max without impact

        # Atmosphere helper (optional COESA interpolation)
        def _rho_a_at(h_m: float):
            if h_m <= 0.0:
                if coesa_interp_enabled and (z_grid is not None):
                    rh = _interp_linear(z_grid, rho_grid, 0.0)
                    aa = _interp_linear(z_grid, a_grid, 0.0)
                    return float(rh), float(aa)
                return 0.0, 0.0
            if h_m > atmosphere_cutoff_m:
                return 0.0, 0.0
            if coesa_interp_enabled and (z_grid is not None):
                rh = _interp_linear(z_grid, rho_grid, h_m)
                aa = _interp_linear(z_grid, a_grid, h_m)
                return float(rh), float(aa)
            atmos = atmosphere.calculate(h_m)
            return float(atmos["density"]), float(atmos["speed_of_sound"])

        while t <= t_max:
            r = state[0:3]
            v = state[3:6]
            # Numeric guards
            if not (np.all(np.isfinite(r)) and np.all(np.isfinite(v))):
                impact = None
                impact_status = "diverged"
                break
            sp_now = float(np.linalg.norm(v))
            if not np.isfinite(sp_now):
                impact = None
                impact_status = "diverged"
                break
            # Ellipsoid crossing detection
            F_curr = _F_ecef(r)
            if prev_r is not None and prev_t is not None:
                F_prev = _F_ecef(prev_r)
                if np.isfinite(F_prev) and np.isfinite(F_curr):
                    if (F_prev > 0.0 and F_curr <= 0.0) or (
                        F_prev >= 0.0 and F_curr < 0.0
                    ):
                        t_imp, r_imp, alpha = _bisect_impact(prev_r, r, prev_t, dt)
                        v_imp = (
                            prev_v + alpha * (v - prev_v) if (prev_v is not None) else v
                        )
                        try:
                            lat_i, lon_i, _ = coord.ecef_2_lla(r_imp)
                        except Exception:
                            x, y, z = float(r_imp[0]), float(r_imp[1]), float(r_imp[2])
                            lon_i = math.degrees(math.atan2(y, x))
                            hyp = math.hypot(x, y)
                            lat_i = math.degrees(math.atan2(z, hyp))
                        impact = (
                            t_imp,
                            float(lat_i),
                            float(lon_i),
                            float(np.linalg.norm(v_imp)),
                        )
                        impact_status = "impact"
                        break
                if np.isfinite(F_curr) and (F_curr < 0.0):
                    impact = None
                    impact_status = "inside_earth"
                    break

            # Atmosphere
            try:
                lat, lon, h = coord.ecef_2_lla(r)
            except Exception:
                lat = lon = h = float("nan")
            rho, a_sound = _rho_a_at(
                h if (h is not None and np.isfinite(h) and h > 0.0) else 0.0
            )

            # Aero forces: CdA-only model
            speed = float(np.linalg.norm(v))
            if speed == 0 or rho == 0:
                drag_vec = np.zeros(3)
            else:
                drag_vec = -0.5 * rho * speed * cda * v

            # Accelerations
            a_g = _kepler_acc_fast(r, mu)
            coriolis = np.cross(2.0 * omega_earth, v)
            centrifugal = np.cross(omega_earth, np.cross(omega_earth, r))
            a_rot = -(coriolis + centrifugal)
            a_aero = (drag_vec) / mass
            a_total = a_g + a_aero + a_rot

            # Save outputs at configured stride based on integration step counter
            if step % max(1, output_stride) == 0:
                times.append(t)
                hs.append(h if (h is not None and np.isfinite(h)) else float("nan"))
                speeds.append(speed)
                lats.append(
                    lat if (lat is not None and np.isfinite(lat)) else float("nan")
                )
                lons.append(
                    lon if (lon is not None and np.isfinite(lon)) else float("nan")
                )
                xs.append(r[0])
                ys.append(r[1])
                zs.append(r[2])
                # Crossrange using NED at launch - with guards against astronomical values
                try:
                    p_ned = dcm_ecef2ned @ (r - r0_ecef)
                    # Check for unreasonable position magnitudes (> 1e10 m)
                    if np.linalg.norm(p_ned) > 1e10:
                        signed_cross = float("nan")
                        along = float("nan")
                    else:
                        p_h = p_ned.copy()
                        p_h[2] = 0.0
                        along = np.dot(p_h[:2], along_unit[:2])
                        pr = p_h[:2] - along * along_unit[:2]
                        # Signed crossrange using 2D cross-product z-component
                        sign_val = along_unit[0] * p_h[1] - along_unit[1] * p_h[0]
                        signed_cross = float(np.sign(sign_val) * np.linalg.norm(pr))
                        # Final sanity check on computed values
                        if not (np.isfinite(signed_cross) and abs(signed_cross) < 1e10):
                            signed_cross = float("nan")
                        if not (np.isfinite(along) and abs(along) < 1e10):
                            along = float("nan")
                except Exception:
                    signed_cross = float("nan")
                    along = float("nan")
                crossranges.append(signed_cross)
                downranges.append(
                    float(abs(along)) if np.isfinite(along) else float("nan")
                )

            # RK4 step
            def f(_t, y):
                rr = y[0:3]
                vv = y[3:6]
                # atmosphere for forces
                lat2, lon2, h2 = coord.ecef_2_lla(rr)
                rho2, _a2 = _rho_a_at(h2 if h2 > 0.0 else 0.0)
                sp2 = float(np.linalg.norm(vv))
                if sp2 == 0 or rho2 == 0:
                    drag2 = np.zeros(3)
                else:
                    drag2 = -0.5 * rho2 * sp2 * cda * vv
                ag = _kepler_acc_fast(rr, mu)
                cor = np.cross(2.0 * omega_earth, vv)
                cen = np.cross(omega_earth, np.cross(omega_earth, rr))
                arot = -(cor + cen)
                a = ag + (drag2) / mass + arot
                return np.concatenate([vv, a])

            prev_r, prev_v, prev_h, prev_t = r, v, h, t
            state = runge_kutta4(f, t, state, dt)
            t += dt
            step += 1

        # Ensure final impact sample is appended for plotting completeness
        if impact is not None:
            t_imp, lat_i, lon_i, speed_i = impact
            # Recompute position vector at impact for cross/downrange
            # We already computed r_imp above in loop; approximate using last known r and prev_r
            # Fallback to projecting lat/lon back to ECEF via coord if needed
            try:
                r_imp_vec = coord.lla_2_ecef(lat_i, lon_i, 0.0)
            except Exception:
                r_imp_vec = prev_r if prev_r is not None else (r0_ecef)
            # Calculate impact crossrange/downrange with guards
            try:
                p_ned_imp = dcm_ecef2ned @ (r_imp_vec - r0_ecef)
                # Check for unreasonable values
                if np.linalg.norm(p_ned_imp) > 1e10:
                    signed_cross_imp = float("nan")
                    along_imp = float("nan")
                else:
                    p_h_imp = p_ned_imp.copy()
                    p_h_imp[2] = 0.0
                    along_imp = np.dot(p_h_imp[:2], along_unit[:2])
                    pr_imp = p_h_imp[:2] - along_imp * along_unit[:2]
                    sign_val_imp = (
                        along_unit[0] * p_h_imp[1] - along_unit[1] * p_h_imp[0]
                    )
                    signed_cross_imp = float(
                        np.sign(sign_val_imp) * np.linalg.norm(pr_imp)
                    )
                    # Sanity check
                    if not (
                        np.isfinite(signed_cross_imp) and abs(signed_cross_imp) < 1e10
                    ):
                        signed_cross_imp = float("nan")
                    if not (np.isfinite(along_imp) and abs(along_imp) < 1e10):
                        along_imp = float("nan")
            except Exception:
                signed_cross_imp = float("nan")
                along_imp = float("nan")
            # Always append final point (independent of stride)
            times.append(float(t_imp) if t_imp is not None else t)
            hs.append(0.0)
            speeds.append(float(speed_i))
            lats.append(float(lat_i))
            lons.append(float(lon_i))
            xs.append(float(r_imp_vec[0]))
            ys.append(float(r_imp_vec[1]))
            zs.append(float(r_imp_vec[2]))
            crossranges.append(signed_cross_imp)
            downranges.append(
                float(abs(along_imp)) if np.isfinite(along_imp) else float("nan")
            )

        # Write CSV
        csv_path = None
        if save_csv:
            csv_path = out_dir / f"debris_{idx:0{idx_width}d}.csv"
            import csv

            with open(csv_path, "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(
                    [
                        "t_s",
                        "lat_deg",
                        "lon_deg",
                        "h_m",
                        "speed_mps",
                        "x_m",
                        "y_m",
                        "z_m",
                        "signed_crossrange_m",
                        "downrange_m",
                    ]
                )
                for i in range(len(times)):
                    w.writerow(
                        [
                            times[i],
                            lats[i],
                            lons[i],
                            hs[i],
                            speeds[i],
                            xs[i],
                            ys[i],
                            zs[i],
                            crossranges[i],
                            downranges[i],
                        ]
                    )

        if impact is None:
            impact = (None, None, None, None)

        return {
            "csv": str(csv_path) if csv_path else None,
            "times": times,
            "hs": hs,
            "speeds": speeds,
            "lats": lats,
            "lons": lons,
            "xs": xs,
            "ys": ys,
            "zs": zs,
            "cross": crossranges,
            "down": downranges,
            "impact_time_s": impact[0],
            "impact_lat_deg": impact[1],
            "impact_lon_deg": impact[2],
            "impact_speed_mps": impact[3],
            "impact_status": impact_status,
        }

    # Run all debris (parallel chunks if enabled)
    results = []
    # Optional progress tracking
    progress_file = None
    try:
        progress_file = cfg.get("compute", {}).get("progress_file", None)
    except Exception:
        progress_file = None

    def _write_progress(done):
        if not progress_file:
            return
        try:
            doc = {"total_debris": int(N), "done_debris": int(done)}
            p = Path(str(progress_file))
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(p.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(doc, f)
            os.replace(tmp, p)
        except Exception:
            pass

    done_counter = 0
    if par_enabled and N > 1:
        backend = str(par_cfg.get("backend", "process")).lower()
        if (
            sys.platform.startswith("win")
            and backend == "process"
            and not bool(par_cfg.get("windows_process_ok", False))
        ):
            backend = "thread"
            notes.append(
                "parallel: downgraded to thread backend on Windows; set parallel.windows_process_ok=true and run under __main__ guard to enable processes."
            )
        indices = np.arange(N, dtype=int)
        chunks = [
            indices[i : i + max(1, chunk_size)] for i in range(0, N, max(1, chunk_size))
        ]
        futs = []
        Exec = ThreadPoolExecutor if backend == "thread" else ProcessPoolExecutor
        with Exec(max_workers=max(1, workers)) as ex:
            for ch in chunks:
                fut = ex.submit(
                    _integrate_chunk,
                    ch.tolist(),
                    np.array(r0_ecef, dtype=float),
                    np.array(v0_ecef, dtype=float),
                    float(lat0),
                    float(lon0),
                    float(dt),
                    float(t_max),
                    int(output_stride),
                    float(atmosphere_cutoff_m),
                    np.array(omega_earth, dtype=float),
                    np.array(mass_s, dtype=float),
                    np.array(cda_s, dtype=float),
                    np.array(dvx_s, dtype=float),
                    np.array(dvy_s, dtype=float),
                    np.array(dvz_s, dtype=float),
                    int(idx_width),
                    str(out_dir.resolve()),
                    bool(save_csv),
                    bool(capture_traces or write_plots),
                    bool(coesa_interp_enabled),
                    float(coesa_dz_m),
                    float(coesa_h_max_m),
                    (
                        np.array(z_grid, dtype=float)
                        if z_grid is not None
                        else np.array([], dtype=float)
                    ),
                    (
                        np.array(rho_grid, dtype=float)
                        if rho_grid is not None
                        else np.array([], dtype=float)
                    ),
                    (
                        np.array(a_grid, dtype=float)
                        if a_grid is not None
                        else np.array([], dtype=float)
                    ),
                )
                futs.append(fut)
            for fut in as_completed(futs):
                try:
                    res_list = fut.result()
                    results.extend(res_list)
                    done_counter += len(res_list)
                    _write_progress(done_counter)
                except Exception as e:
                    notes.append(f"parallel chunk failed: {e}")
        results.sort(key=lambda r: r.get("idx", 0))
    else:
        for i in range(N):
            res = integrate_one(
                i,
                float(mass_s[i]),
                float(cda_s[i]),
                float(dvx_s[i]),
                float(dvy_s[i]),
                float(dvz_s[i]),
            )
            results.append(res)
            done_counter += 1
            _write_progress(done_counter)

    # Build summary aligned with results order
    for res in results:
        i = int(res.get("idx", len(summary)))
        try:
            _cda_i = float(cda_s[i])
            _beta_i = float(mass_s[i]) / max(_cda_i, 1e-12)
            _A_i = _cda_i / max(cd_ref, 1e-12)
            _d_eq_i = float(np.sqrt(max(4.0 * _A_i / np.pi, 0.0)))
        except Exception:
            _cda_i = None
            _A_i = None
            _beta_i = None
            _d_eq_i = None

        # Impact energy and harmless flag (exact threshold: 15 J and below)
        try:
            _speed_i = res.get("impact_speed_mps")
            _mass_i = float(mass_s[i])
            if _speed_i is not None and np.isfinite(_speed_i):
                _ke_i = 0.5 * _mass_i * float(_speed_i) * float(_speed_i)
                _unharmed_i = bool(_ke_i <= float(ke_thresh_j))
            else:
                _ke_i = None
                _unharmed_i = None
        except Exception:
            _ke_i = None
            _unharmed_i = None

        summary.append(
            {
                "index": i,
                "mass_kg": float(mass_s[i]),
                "rocket_diameter_cd": float(_d_eq_i) if _d_eq_i is not None else None,
                "rocket_diameter_cl": float(_d_eq_i) if _d_eq_i is not None else None,
                "fixed_cd": float(cd_ref),
                "fixed_cl": 0.0,
                "beta_kg_m2": float(_beta_i) if _beta_i is not None else None,
                "A_from_beta_m2": float(_A_i) if _A_i is not None else None,
                "d_eq_from_beta_m": float(_d_eq_i) if _d_eq_i is not None else None,
                "cda_m2": float(_cda_i) if _cda_i is not None else None,
                "dvx": float(dvx_s[i]),
                "dvy": float(dvy_s[i]),
                "dvz": float(dvz_s[i]),
                "impact_time_s": res["impact_time_s"],
                "impact_lat_deg": res["impact_lat_deg"],
                "impact_lon_deg": res["impact_lon_deg"],
                "impact_speed_mps": res["impact_speed_mps"],
                "impact_status": res["impact_status"],
                "impact_ke_j": float(_ke_i) if (_ke_i is not None) else None,
                "unharmed": _unharmed_i,
                "csv": res["csv"],
            }
        )

    # Prepare a plotting-friendly dist summary for legends
    dist_plot = {
        # dv* entries no longer reflect per-axis bimodal specs; keep placeholders for UI consistency
        "dvx": {
            "min": -float(dv_max),
            "max": float(dv_max),
            "mean1": 0.0,
            "mean2": 0.0,
        },
        "dvy": {
            "min": -float(dv_max),
            "max": float(dv_max),
            "mean1": 0.0,
            "mean2": 0.0,
        },
        "dvz": {
            "min": -float(dv_max),
            "max": float(dv_max),
            "mean1": 0.0,
            "mean2": 0.0,
        },
        "mass_kg": {"min": mass_min, "max": mass_max, "mean1": mass_mu},
        "rocket_diameter_cd": {"min": diam_min, "max": diam_max, "mean1": diam_mu},
        "rocket_diameter_cl": {"min": diam_min, "max": diam_max, "mean1": diam_mu},
        "fixed_cd": {"min": cd_min, "max": cd_max, "mean1": cd_mu},
        "fixed_cl": {"min": cl_min, "max": cl_max, "mean1": cl_mu},
    }

    # Plots
    plots = {}
    if write_plots:
        try:
            import plotly.graph_objects as go
            import plotly.io as pio

            opacity = float(cfg.get("output", {}).get("line_opacity", 0.35))
            lw = float(cfg.get("output", {}).get("line_width", 1.5))

            # Altitude vs Time
            fig_h = go.Figure()
            for r in results:
                # Skip non-impacts in altitude plots
                if r.get("impact_time_s") is None:
                    continue
                fig_h.add_trace(
                    go.Scatter(
                        x=r["times"],
                        y=r["hs"],
                        mode="lines",
                        line={"width": lw},
                        opacity=opacity,
                        showlegend=False,
                    )
                )
            fig_h.update_layout(
                title="Altitude vs Time",
                xaxis_title="Time (s)",
                yaxis_title="Altitude (m)",
                template="plotly_white",
            )
            path_h = out_dir / "altitude_vs_time.html"
            pio.write_html(fig_h, file=str(path_h), auto_open=auto_open)
            plots["altitude_vs_time"] = str(path_h.resolve())

            # Speed vs Time
            fig_v = go.Figure()
            for r in results:
                # Skip non-impacts in speed plots
                if r.get("impact_time_s") is None:
                    continue
                fig_v.add_trace(
                    go.Scatter(
                        x=r["times"],
                        y=r["speeds"],
                        mode="lines",
                        line={"width": lw},
                        opacity=opacity,
                        showlegend=False,
                    )
                )
            fig_v.update_layout(
                title="Speed vs Time",
                xaxis_title="Time (s)",
                yaxis_title="Speed (m/s)",
                template="plotly_white",
            )
            path_v = out_dir / "speed_vs_time.html"
            pio.write_html(fig_v, file=str(path_v), auto_open=auto_open)
            plots["speed_vs_time"] = str(path_v.resolve())

            # Ground Track and Altitude vs Crossrange removed per request

            # Altitude vs Downrange
            fig_ad = go.Figure()
            for r in results:
                # Skip non-impacts for downrange-altitude
                if r.get("impact_time_s") is None:
                    continue
                fig_ad.add_trace(
                    go.Scatter(
                        x=r["down"],
                        y=r["hs"],
                        mode="lines",
                        line={"width": lw},
                        opacity=opacity,
                        showlegend=False,
                    )
                )
            fig_ad.update_layout(
                title="Altitude vs Downrange",
                xaxis_title="Downrange (m)",
                yaxis_title="Altitude (m)",
                template="plotly_white",
            )
            path_ad = out_dir / "altitude_vs_downrange.html"
            pio.write_html(fig_ad, file=str(path_ad), auto_open=auto_open)
            plots["altitude_vs_downrange"] = str(path_ad.resolve())

            # Distributions HTML (histograms of sampled parameters)
            try:
                dist_cfg = cfg.get("output", {}).get("distributions", {})
                write_dists = bool(dist_cfg.get("write", True))
                # Auto-disable for true single mode (single_debris) or N <= 1
                if bool(single_mode) or int(N) <= 1:
                    write_dists = False
                if write_dists:
                    # Auto-binning per variable; no user bin count required
                    dist_auto_open = bool(dist_cfg.get("auto_open", False))
                    # Optional: visualize log-scaled variables entirely in log10-space with densities
                    log_space_density = bool(dist_cfg.get("log_space_density", False))
                    show_means = bool(dist_cfg.get("show_mixture_means", True))
                    height_px = int(
                        cfg.get("output", {}).get(
                            "distributions_figure_height_px", 1300
                        )
                    )
                    row_spacing = float(
                        cfg.get("output", {}).get("distributions_row_spacing", 0.12)
                    )

                    import plotly.graph_objects as go
                    from plotly.subplots import make_subplots

                    # Prepare variables and metadata (add |Δv| panel)
                    dv_mag_s = np.sqrt(dvx_s**2 + dvy_s**2 + dvz_s**2)
                    vars_info = [
                        ("dvx", dvx_s, "Δv_x (m/s)"),
                        ("dvy", dvy_s, "Δv_y (m/s)"),
                        ("dvz", dvz_s, "Δv_z (m/s)"),
                        ("dv_mag", dv_mag_s, "|Δv| (m/s)"),
                        ("mass_kg", mass_s, "Mass (kg)"),
                        (
                            "beta_kg_m2",
                            beta_s if "beta_s" in locals() else np.array([]),
                            "Ballistic Coefficient β (kg/m²)",
                        ),
                        (
                            "cda_m2",
                            cda_s if "cda_s" in locals() else np.array([]),
                            "CdA (m²)",
                        ),
                    ]

                    # Short per-variable captions (kept concise for readability)
                    var_desc = {
                        "dvx": "Δv component (x): random direction from |Δv| model.",
                        "dvy": "Δv component (y): random direction from |Δv| model.",
                        "dvz": "Δv component (z): random direction from |Δv| model.",
                        "dv_mag": "|Δv| magnitude sampled from explosion model (log10).",
                        "mass_kg": "Debris mass (kg).",
                        "beta_kg_m2": "Ballistic coefficient β = m / (Cd·A).",
                        "cda_m2": "Drag area Cd·A (m²).",
                    }

                    # Compute rows dynamically for 3 columns + add a footer row spanning all columns
                    nvars = len(vars_info)
                    ncols = 3
                    nrows = (nvars + ncols - 1) // ncols
                    specs = [[{} for _ in range(ncols)] for __ in range(nrows)]
                    specs.append([{"colspan": ncols}] + [None] * (ncols - 1))
                    row_heights = [1.0] * nrows + [0.35]
                    figd = make_subplots(
                        rows=nrows + 1,
                        cols=ncols,
                        specs=specs,
                        row_heights=row_heights,
                        subplot_titles=[t[2] for t in vars_info] + [""],
                        vertical_spacing=row_spacing,
                    )
                    # Legend flags: samples and KDE
                    legend_added_samples = False
                    legend_added_kde = False

                    # Auto-binning helper
                    def _auto_bins(x: np.ndarray, log_domain: bool = False) -> int:
                        try:
                            a = np.array([v for v in x if np.isfinite(v)], dtype=float)
                            if a.size <= 1:
                                return 1
                            if log_domain:
                                a = a[a > 0.0]
                                if a.size <= 1:
                                    return 1
                                a = np.log10(a)
                            rng = float(np.max(a) - np.min(a))
                            if rng <= 0:
                                return 1
                            q75, q25 = np.percentile(a, [75, 25])
                            iqr = float(q75 - q25)
                            if iqr > 0:
                                bw = 2.0 * iqr * (a.size ** (-1.0 / 3.0))
                            else:
                                std = float(np.std(a))
                                if std > 0:
                                    bw = 3.49 * std * (a.size ** (-1.0 / 3.0))
                                else:
                                    return int(max(1, np.ceil(np.log2(a.size) + 1)))
                            if bw <= 0:
                                return int(max(1, np.ceil(np.log2(a.size) + 1)))
                            nb = int(np.ceil(rng / bw))
                            return int(np.clip(nb, 5, 120))
                        except Exception:
                            try:
                                return int(max(1, np.ceil(np.log2(len(x)) + 1)))
                            except Exception:
                                return 10

                    for idx, (key, samples, title) in enumerate(vars_info):
                        row = idx // 3 + 1
                        col = idx % 3 + 1
                        # Filter finite
                        arr = np.array(
                            [x for x in samples if np.isfinite(x)], dtype=float
                        )
                        if arr.size == 0:
                            continue
                        dspec = dist_plot.get(key, {})

                        # Histogram (counts) with auto-binning
                        is_log = key in ("mass_kg", "beta_kg_m2", "cda_m2", "dv_mag")
                        nbinsx = _auto_bins(arr, log_domain=is_log)
                        # Keep per-panel bin params for KDE scaling
                        _log_bin_meta = None
                        if is_log and not log_space_density:
                            # For log-scale variables, build logarithmically spaced bins
                            arrp = arr[arr > 0.0]
                            if arrp.size > 0:
                                try:
                                    log_min = float(np.log10(np.min(arrp)))
                                    log_max = float(np.log10(np.max(arrp)))
                                    # Bin count per decade to avoid overcrowding on log axis
                                    span_dec = max(1e-12, (log_max - log_min))
                                    bins_per_decade = float(
                                        dist_cfg.get("bins_per_decade", 6.0)
                                    )
                                    nb = int(
                                        np.ceil(span_dec * max(1.0, bins_per_decade))
                                    )
                                    nb = int(np.clip(nb, 4, 48))
                                    edges_log = np.linspace(log_min, log_max, nb + 1)
                                    edges = np.power(10.0, edges_log)
                                    counts, edges = np.histogram(arrp, bins=edges)
                                    # Geometric centers for x locations; widths in data units
                                    centers = np.sqrt(edges[:-1] * edges[1:])
                                    widths = edges[1:] - edges[:-1]
                                    # Remember for KDE scaling in log domain
                                    _log_bin_meta = {
                                        "nb": nb,
                                        "zmin": log_min,
                                        "zmax": log_max,
                                    }
                                    figd.add_trace(
                                        go.Bar(
                                            x=centers.tolist(),
                                            y=counts.astype(int).tolist(),
                                            width=widths.tolist(),
                                            name="Samples",
                                            marker_color="rgba(31,119,180,0.6)",
                                            marker_line_width=0,
                                            showlegend=(not legend_added_samples),
                                        ),
                                        row=row,
                                        col=col,
                                    )
                                except Exception:
                                    # Fallback to default histogram if anything goes wrong
                                    figd.add_trace(
                                        go.Histogram(
                                            x=arr.tolist(),
                                            nbinsx=nbinsx,
                                            name="Samples",
                                            marker_color="rgba(31,119,180,0.6)",
                                            showlegend=(not legend_added_samples),
                                        ),
                                        row=row,
                                        col=col,
                                    )
                            else:
                                # No positive values; draw nothing for this panel
                                pass
                        elif is_log and log_space_density:
                            # Work in log10-space with density units; drawing on linear x-axis
                            arrp = arr[arr > 0.0]
                            if arrp.size > 0:
                                z = np.log10(arrp)
                                figd.add_trace(
                                    go.Histogram(
                                        x=z.tolist(),
                                        nbinsx=int(np.clip(int(nbinsx), 8, 60)),
                                        histnorm="probability density",
                                        name="Samples",
                                        marker_color="rgba(31,119,180,0.6)",
                                        showlegend=(not legend_added_samples),
                                    ),
                                    row=row,
                                    col=col,
                                )
                                # Axis labels for clarity in density mode
                                try:
                                    xlab = {
                                        "dv_mag": "log10(|Δv| [m/s])",
                                        "mass_kg": "log10(Mass [kg])",
                                        "beta_kg_m2": "log10(β [kg/m²])",
                                        "cda_m2": "log10(CdA [m²])",
                                    }.get(key, "log10(value)")
                                    figd.update_xaxes(title_text=xlab, row=row, col=col)
                                    figd.update_yaxes(
                                        title_text="Density",
                                        rangemode="tozero",
                                        row=row,
                                        col=col,
                                    )
                                except Exception:
                                    pass
                            # No x-axis log in this mode
                        else:
                            figd.add_trace(
                                go.Histogram(
                                    x=arr.tolist(),
                                    nbinsx=nbinsx,
                                    # counts (no normalization)
                                    name="Samples",
                                    marker_color="rgba(31,119,180,0.6)",
                                    showlegend=(not legend_added_samples),
                                ),
                                row=row,
                                col=col,
                            )
                        if not legend_added_samples:
                            legend_added_samples = True
                        # Ensure y-axis starts at zero and set y-axis label
                        try:
                            if not (is_log and log_space_density):
                                figd.update_yaxes(
                                    rangemode="tozero",
                                    title_text="Count",
                                    row=row,
                                    col=col,
                                )
                        except Exception:
                            pass

                        # Log-scale x-axis for skewed variables (counts mode only)
                        try:
                            if (
                                key in ("mass_kg", "beta_kg_m2", "cda_m2", "dv_mag")
                            ) and not log_space_density:
                                figd.update_xaxes(type="log", row=row, col=col)
                        except Exception:
                            pass

                        # KDE overlay scaled to expected counts per bin for guidance
                        try:
                            import math as _m

                            n = arr.size
                            if n >= 5:
                                # Estimate bin width in data domain for counts scaling
                                x_min = float(np.min(arr))
                                x_max = float(np.max(arr))
                                bw_bin = (x_max - x_min) / float(
                                    nbinsx if nbinsx > 0 else 1
                                )
                                if bw_bin <= 0:
                                    bw_bin = 1.0
                                if (
                                    key in ("mass_kg", "beta_kg_m2", "cda_m2", "dv_mag")
                                    and not log_space_density
                                ):
                                    # Log-domain KDE; scale to expected counts per log-bin width
                                    arrp = arr[arr > 0.0]
                                    if arrp.size >= 5:
                                        z = np.log10(arrp)
                                        std = float(np.std(z)) or 1.0
                                        bw = 1.06 * std * (arrp.size ** (-1.0 / 5.0))
                                        if not (np.isfinite(bw) and bw > 1e-12):
                                            bw = max(std * 0.3, 1e-3)
                                        zmin, zmax = float(np.min(z)), float(np.max(z))
                                        grid = np.linspace(zmin, zmax, 400)
                                        diffs = (grid[:, None] - z[None, :]) / bw
                                        kde_z = np.exp(-0.5 * diffs * diffs).sum(
                                            axis=1
                                        ) / (arrp.size * bw * np.sqrt(2 * np.pi))
                                        # Choose Δz to match the histogram binning if available
                                        if _log_bin_meta is not None:
                                            dz = (
                                                float(_log_bin_meta["zmax"])
                                                - float(_log_bin_meta["zmin"])
                                            ) / max(int(_log_bin_meta["nb"]), 1)
                                        else:
                                            dz = (zmax - zmin) / float(
                                                nbinsx if nbinsx > 0 else 1
                                            )
                                        dz = float(dz if dz > 1e-9 else 1e-3)
                                        # Smooth line scaled to counts-per-log-bin: n * f_Z(z) * Δz
                                        yk = (kde_z * dz * arr.size).tolist()
                                        xk = np.power(10.0, grid)
                                    else:
                                        yk = None
                                elif (
                                    key in ("mass_kg", "beta_kg_m2", "cda_m2", "dv_mag")
                                    and log_space_density
                                ):
                                    # KDE in log-space, density units, drawn on linear axis in z
                                    arrp = arr[arr > 0.0]
                                    if arrp.size >= 5:
                                        z = np.log10(arrp)
                                        std = float(np.std(z)) or 1.0
                                        bw = 1.06 * std * (arrp.size ** (-1.0 / 5.0))
                                        if not (np.isfinite(bw) and bw > 1e-12):
                                            bw = max(std * 0.3, 1e-3)
                                        zmin, zmax = float(np.min(z)), float(np.max(z))
                                        grid = np.linspace(zmin, zmax, 400)
                                        diffs = (grid[:, None] - z[None, :]) / bw
                                        kde_z = np.exp(-0.5 * diffs * diffs).sum(
                                            axis=1
                                        ) / (arrp.size * bw * np.sqrt(2 * np.pi))
                                        xk = grid
                                        yk = kde_z.tolist()
                                    else:
                                        yk = None
                                else:
                                    # Linear-domain KDE
                                    z = arr
                                    std = float(np.std(z)) or 1.0
                                    bw = 1.06 * std * (n ** (-1.0 / 5.0))
                                    if not (np.isfinite(bw) and bw > 1e-12):
                                        bw = max(std * 0.3, 1e-9)
                                    zmin, zmax = float(np.min(z)), float(np.max(z))
                                    grid = np.linspace(zmin, zmax, 256)
                                    diffs = (grid[:, None] - z[None, :]) / bw
                                    kde = np.exp(-0.5 * diffs * diffs).sum(axis=1) / (
                                        n * bw * np.sqrt(2 * np.pi)
                                    )
                                    xk = grid
                                    yk = (kde * bw_bin * n).tolist()
                                if yk is not None and np.any(np.isfinite(yk)):
                                    figd.add_trace(
                                        go.Scatter(
                                            x=(
                                                xk.tolist()
                                                if hasattr(xk, "tolist")
                                                else list(xk)
                                            ),
                                            y=yk,
                                            mode="lines",
                                            name="KDE (counts)",
                                            line=dict(color="rgba(0,0,0,0.7)"),
                                        ),
                                        row=row,
                                        col=col,
                                    )
                                    if not legend_added_kde:
                                        legend_added_kde = True
                        except Exception:
                            pass

                        # No bounds or μ lines in subplots (simplified)

                        # Basic stats as annotation
                        try:
                            # Axis domain refs (plotly uses 'x domain' for first subplot, then 'x2 domain', ...)
                            axis_num = idx + 1
                            xdom = (
                                "x domain" if axis_num == 1 else f"x{axis_num} domain"
                            )
                            ydom = (
                                "y domain" if axis_num == 1 else f"y{axis_num} domain"
                            )
                            mean = float(np.mean(arr))
                            std = float(np.std(arr))
                            p5 = float(np.percentile(arr, 5))
                            p50 = float(np.percentile(arr, 50))
                            p95 = float(np.percentile(arr, 95))
                            if key in ("mass_kg", "beta_kg_m2", "cda_m2", "dv_mag"):
                                stats_text = f"n={arr.size}<br>P5={p5:.3g}, P50={p50:.3g}, P95={p95:.3g}"
                            else:
                                stats_text = f"n={arr.size}<br>μ={mean:.3g}, σ={std:.3g}<br>P5={p5:.3g}, P50={p50:.3g}, P95={p95:.3g}"
                            figd.add_annotation(
                                row=row,
                                col=col,
                                xref=xdom,
                                yref=ydom,
                                x=0.99,
                                y=0.98,
                                xanchor="right",
                                yanchor="top",
                                showarrow=False,
                                text=stats_text,
                                bgcolor="rgba(255,255,255,0.5)",
                                bordercolor="rgba(0,0,0,0.2)",
                                borderwidth=1,
                            )
                            # Per-variable caption near bottom-left of subplot
                            desc = var_desc.get(key, None)
                            if desc:
                                figd.add_annotation(
                                    row=row,
                                    col=col,
                                    xref=xdom,
                                    yref=ydom,
                                    x=0.01,
                                    y=0.06,
                                    xanchor="left",
                                    yanchor="bottom",
                                    showarrow=False,
                                    text=desc,
                                    font=dict(size=11, color="#555"),
                                    bgcolor="rgba(255,255,255,0.4)",
                                    bordercolor="rgba(0,0,0,0.15)",
                                    borderwidth=1,
                                )
                        except Exception:
                            pass

                    figd.update_layout(
                        height=height_px,
                        title_text="Sampled Distributions (Batch)",
                        template="plotly_white",
                        bargap=0.12,
                    )
                    path_dist = out_dir / "distributions.html"
                    try:
                        fig_html = pio.to_html(
                            figd, include_plotlyjs="cdn", full_html=False
                        )
                        footer_html = """
<div style=\"max-width:1200px;margin:24px auto 40px;padding:12px 16px;border-top:1px solid #ddd;color:#444;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;\">
  <div style=\"margin-bottom:8px;\"><b>Legend</b>: blue bars = counts; black line = KDE (counts, scaled).</div>
  <div style=\"margin-bottom:8px;\"><b>Stats</b>: n, percentiles (P5, P50, P95); mean/σ shown only for linear variables.</div>
  <div style=\"margin-bottom:8px;\"><b>Notes</b>: mass, β, CdA, and |Δv| panels use a log x-axis for readability.</div>
  <div style=\"margin-bottom:6px;\"><b>Δv model (intuition)</b>: We draw |Δv| on a log scale (log10 |Δv| is Gaussian) and truncate to [dv_min, dv_max], then pick a random direction. That’s why dv_x/dv_y/dv_z are symmetric about zero with long tails, while |Δv| looks log‑normal (skewed right).</div>
  <div><b>Ballistic coefficient β (intuition)</b>: β = m/(Cd·A) measures resistance to drag: large β ≈ harder to slow; small β ≈ easier to brake. If diameter limits are hit, A (and thus β and d_eq) are recomputed; this can create shoulders in the β and d_eq histograms.</div>
</div>
"""
                        html_doc = """
<!doctype html>
<html>
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>Sampled Distributions (Batch)</title>
    <style>body{margin:16px;background:#fff;}</style>
  </head>
  <body>
    %s
    %s
  </body>
</html>
""" % (
                            fig_html,
                            footer_html,
                        )
                        with open(path_dist, "w", encoding="utf-8") as f:
                            f.write(html_doc)
                        if dist_auto_open:
                            try:
                                import webbrowser

                                webbrowser.open(str(path_dist.resolve()))
                            except Exception:
                                pass
                    except Exception:
                        # Fallback to default writer
                        pio.write_html(
                            figd, file=str(path_dist), auto_open=dist_auto_open
                        )
                    plots["distributions"] = str(path_dist.resolve())
            except Exception as e:
                msg = f"Distributions generation failed: {e}"
                print(msg)
                plots["error"] = msg
        except Exception:
            plots["error"] = "Plot generation failed"

    # --- Leaflet map (Folium) + Impacts CSV ---
    # Build a lightweight interactive map with runtime base-layer switching and overlays.
    impacts_csv_path = None
    try:
        out_map_cfg = cfg.get("output", {}).get("leaflet_map", {})
        lf_write = bool(out_map_cfg.get("write", True))
        if lf_write:
            try:
                import folium

                try:
                    from folium.plugins import BeautifyIcon
                except Exception:
                    BeautifyIcon = None
            except Exception as _e:
                lf_write = False
                notes.append(f"leaflet_map disabled: folium import failed ({_e})")

        # Gather valid impact points (index, lat, lon) — only true impacts (time & speed finite)
        impacts_ll = []
        impacts_ll_harm = []  # harmful-only (unharmed == False)
        for i, r in enumerate(results):
            la = r.get("impact_lat_deg")
            lo = r.get("impact_lon_deg")
            ti = r.get("impact_time_s")
            sp = r.get("impact_speed_mps")
            if la is None or lo is None or ti is None or sp is None:
                continue
            try:
                la_v = float(la)
                lo_v = float(lo)
                ti_v = float(ti)
                sp_v = float(sp)
                if (
                    np.isfinite(la_v)
                    and np.isfinite(lo_v)
                    and np.isfinite(ti_v)
                    and np.isfinite(sp_v)
                ):
                    impacts_ll.append((i, la_v, lo_v))
                    try:
                        unh = summary[i].get("unharmed") if i < len(summary) else None
                        if unh is False:
                            impacts_ll_harm.append((i, la_v, lo_v))
                    except Exception:
                        pass
            except Exception:
                continue

        # Compute mean center for map/ellipse if impacts exist
        lat_c_map, lon_c_map = float(lat0), float(lon0)
        e_a_m = e_b_m = e_az_deg = None
        ellipse_mode = str(out_map_cfg.get("ellipse_mode", "chi2")).lower()
        ellipse_conf = float(out_map_cfg.get("ellipse_confidence", 0.9973))

        # Optional map centering policy
        center_on = str(out_map_cfg.get("center_on", "failure")).lower()
        # Precompute means for all and harmful
        if impacts_ll:
            try:
                ecefs = [coord.lla_2_ecef(la, lo, 0.0) for _, la, lo in impacts_ll]
                rc = np.mean(np.array(ecefs), axis=0)
                lat_mean_all, lon_mean_all, _ = coord.ecef_2_lla(rc)
            except Exception:
                lat_mean_all = lon_mean_all = None
        else:
            lat_mean_all = lon_mean_all = None
        if impacts_ll_harm:
            try:
                ecefs_h = [
                    coord.lla_2_ecef(la, lo, 0.0) for _, la, lo in impacts_ll_harm
                ]
                rc_h = np.mean(np.array(ecefs_h), axis=0)
                lat_mean_h, lon_mean_h, _ = coord.ecef_2_lla(rc_h)
            except Exception:
                lat_mean_h = lon_mean_h = None
        else:
            lat_mean_h = lon_mean_h = None

        # Choose initial map center
        if (
            center_on == "impacts"
            and lat_mean_all is not None
            and lon_mean_all is not None
        ):
            lat_c_map, lon_c_map = float(lat_mean_all), float(lon_mean_all)
        elif (
            center_on == "harmful_impacts"
            and lat_mean_h is not None
            and lon_mean_h is not None
        ):
            lat_c_map, lon_c_map = float(lat_mean_h), float(lon_mean_h)
        # else keep default lat0/lon0

        # Create Folium map with multiple base tiles
        if lf_write:
            tiles_default = str(out_map_cfg.get("tiles", "OpenStreetMap"))
            extra_tiles = list(
                out_map_cfg.get(
                    "extra_tiles",
                    [
                        "OpenStreetMap",
                        "Esri.WorldImagery",
                        "CartoDB positron",
                        "Esri.WorldTopoMap",
                    ],
                )
            )
            if tiles_default not in extra_tiles:
                extra_tiles.append(tiles_default)

            marker_radius = int(out_map_cfg.get("marker_radius", 3))
            marker_opacity = float(out_map_cfg.get("marker_opacity", 0.7))
            marker_color = str(out_map_cfg.get("marker_color", "#ff8c00"))
            lf_show_impacts = bool(out_map_cfg.get("show_impacts", True))
            lf_show_launch = bool(out_map_cfg.get("show_launch", True))
            lf_show_mean = bool(out_map_cfg.get("show_mean_impact", True))
            lf_show_ellipse = bool(out_map_cfg.get("show_footprint_ellipse", True))
            lf_zoom = int(out_map_cfg.get("zoom_start", 6))

            fmap = folium.Map(
                location=[lat_c_map, lon_c_map], zoom_start=lf_zoom, tiles=None
            )
            # Base layers
            for base in list(dict.fromkeys(extra_tiles)):
                try:
                    folium.TileLayer(
                        base, name=base, show=(base == tiles_default)
                    ).add_to(fmap)
                except Exception:
                    # Skip unavailable providers
                    pass

            # Overlays
            # Ellipses (non-interactive) – 1σ/2σ/3σ empirical footprints over harmful impacts only
            if lf_show_ellipse and len(impacts_ll_harm) >= 2:
                try:
                    # Center the ellipse at the mean of harmful impacts (ECEF mean -> LLA)
                    _ecefs_h = [
                        coord.lla_2_ecef(la, lo, 0.0) for _, la, lo in impacts_ll_harm
                    ]
                    r_center = np.mean(np.array(_ecefs_h), axis=0)
                    lat_c_h, lon_c_h, _ = coord.ecef_2_lla(r_center)
                    dcm_c_e2n = coord.ecef_2_ned_dcm(lat_c_h, lon_c_h)
                    pts_ne = []
                    for _, la, lo in impacts_ll_harm:
                        r_i = coord.lla_2_ecef(la, lo, 0.0)
                        p_ned = dcm_c_e2n @ (r_i - r_center)
                        pts_ne.append([p_ned[0], p_ned[1]])
                    P = np.array(pts_ne)
                    if P.shape[0] >= 2 and np.isfinite(P).all():
                        C = np.cov(P.T)
                        try:
                            vals, vecs = np.linalg.eigh(C)
                        except Exception:
                            vals = np.array([1.0, 1.0])
                            vecs = np.eye(2)
                        vals = np.clip(vals, 1e-6, None)
                        order = np.argsort(vals)
                        # Mahalanobis distances
                        eps = 1e-9
                        C_reg = C + eps * np.eye(2)
                        try:
                            C_inv = np.linalg.inv(C_reg)
                        except Exception:
                            C_inv = np.linalg.pinv(C_reg)
                        d2 = np.einsum("ij,jk,ik->i", P, C_inv, P)
                        d2 = (
                            d2[np.isfinite(d2)]
                            if np.any(np.isfinite(d2))
                            else np.array([])
                        )
                        levels = [
                            ("1σ Harmful Footprint (68%)", 0.6827, "#2ca02c", False),
                            ("2σ Harmful Footprint (95%)", 0.95, "#1f77b4", False),
                            ("3σ Harmful Footprint (99.7%)", 0.9973, "#d62728", True),
                        ]
                        V = vecs[:, [order[1], order[0]]]
                        dcm_n2e = dcm_c_e2n.T
                        for name, conf_p, color, show_default in levels:
                            if d2.size > 0:
                                try:
                                    k2 = float(np.quantile(d2, conf_p))
                                except Exception:
                                    k2 = float(chi2.ppf(conf_p, df=2))
                                cov_emp = float(np.mean(d2 <= k2))
                            else:
                                k2 = float(chi2.ppf(conf_p, df=2))
                                cov_emp = float("nan")
                            a = float(np.sqrt(max(k2, 0.0) * vals[order[1]]))
                            b = float(np.sqrt(max(k2, 0.0) * vals[order[0]]))
                            thetas = np.linspace(0, 2 * np.pi, 96)
                            circ = np.stack([np.cos(thetas), np.sin(thetas)], axis=0)
                            scale_mat = np.diag([a, b])
                            ell_ne = (V @ scale_mat @ circ).T
                            ell_latlon = []
                            for ne in ell_ne:
                                p_ned = np.array([ne[0], ne[1], 0.0])
                                r_ell = r_center + (dcm_n2e @ p_ned)
                                la_e, lo_e, _ = coord.ecef_2_lla(r_ell)
                                ell_latlon.append((la_e, lo_e))
                            layer = folium.FeatureGroup(
                                name=f"{name} (cov ~ {cov_emp*100:.1f}%)",
                                show=show_default,
                            )
                            tooltip_txt = f"{name}: major≈{2*a/1000:.1f} km, minor≈{2*b/1000:.1f} km"
                            layer.add_child(
                                folium.Polygon(
                                    locations=ell_latlon,
                                    color=color,
                                    fill=True,
                                    fill_opacity=(
                                        0.10
                                        if name.startswith("1σ")
                                        or name.startswith("2σ")
                                        else 0.12
                                    ),
                                    weight=2,
                                    tooltip=tooltip_txt,
                                )
                            )
                            fmap.add_child(layer)
                except Exception:
                    pass

            # Combined toggle for Failure + Mean Harmful Impact markers (single layer below ellipses)
            try:
                layer_markers = folium.FeatureGroup(
                    name="Markers: Failure + Mean", show=True
                )
                added_any_marker = False
                # Failure marker (explosion location)
                if lf_show_launch:
                    try:
                        if "BeautifyIcon" in globals() and BeautifyIcon is not None:
                            icon_launch = BeautifyIcon(
                                icon="fa-star",
                                border_color="#2ca02c",
                                text_color="#ffffff",
                                background_color="#2ca02c",
                                icon_shape="marker",
                                inner_icon_style="font-size:3px;",
                            )
                            layer_markers.add_child(
                                folium.Marker(
                                    location=(float(lat0), float(lon0)),
                                    tooltip="Failure",
                                    icon=icon_launch,
                                )
                            )
                        else:
                            layer_markers.add_child(
                                folium.Marker(
                                    location=(float(lat0), float(lon0)),
                                    tooltip="Failure",
                                    icon=folium.Icon(
                                        color="green", icon="star", prefix="fa"
                                    ),
                                )
                            )
                        added_any_marker = True
                    except Exception:
                        pass
                # Mean harmful impact marker (purple arrow) — only if at least 2 harmful impacts
                if (
                    lf_show_mean
                    and len(impacts_ll_harm) >= 2
                    and (lat_mean_h is not None)
                    and (lon_mean_h is not None)
                ):
                    try:
                        if "BeautifyIcon" in globals() and BeautifyIcon is not None:
                            icon_mean = BeautifyIcon(
                                icon="fa-arrow-down",
                                border_color="#5e2d79",
                                text_color="#ffffff",
                                background_color="#7e3aa7",
                                icon_shape="marker",
                                inner_icon_style="font-size:3px;",
                            )
                            layer_markers.add_child(
                                folium.Marker(
                                    location=(float(lat_mean_h), float(lon_mean_h)),
                                    tooltip=f"Mean Harmful Impact: lat {lat_mean_h:.5f}, lon {lon_mean_h:.5f}",
                                    icon=icon_mean,
                                )
                            )
                        else:
                            layer_markers.add_child(
                                folium.Marker(
                                    location=(float(lat_mean_h), float(lon_mean_h)),
                                    tooltip=f"Mean Harmful Impact: lat {lat_mean_h:.5f}, lon {lon_mean_h:.5f}",
                                    icon=folium.Icon(
                                        color="purple", icon="arrow-down", prefix="fa"
                                    ),
                                )
                            )
                        added_any_marker = True
                    except Exception:
                        pass
                if added_any_marker:
                    fmap.add_child(layer_markers)
            except Exception:
                pass

            # Impact markers with global toggles: Unharmful (green) and Harmful (red)
            if lf_show_impacts and impacts_ll:
                try:
                    layer_unharm = folium.FeatureGroup(
                        name="Unharmful Impacts", show=True
                    )
                    layer_harm = folium.FeatureGroup(name="Harmful Impacts", show=True)
                    for idx_i, la, lo in impacts_ll:
                        tooltip = f"#{idx_i} — lat: {la:.5f}, lon: {lo:.5f}"
                        res_i = results[idx_i]
                        sum_i = summary[idx_i]
                        try:
                            down_last = (res_i.get("down") or [None])[-1]
                            cross_last = (res_i.get("cross") or [None])[-1]
                        except Exception:
                            down_last, cross_last = None, None
                        # Color markers by harmlessness (<=15 J)
                        try:
                            unh = (
                                bool(sum_i.get("unharmed"))
                                if sum_i.get("unharmed") is not None
                                else None
                            )
                        except Exception:
                            unh = None
                        color_harmless = "#2ecc71"  # green
                        color_harmful = "#e74c3c"  # red
                        mcolor = (
                            marker_color
                            if unh is None
                            else (color_harmless if unh else color_harmful)
                        )

                        popup_html = (
                            f"<b>Debris #{idx_i}</b><br>"
                            f"lat: {la:.5f}, lon: {lo:.5f}<br>"
                            f"impact t: {res_i.get('impact_time_s')} s<br>"
                            f"impact speed: {res_i.get('impact_speed_mps')} m/s<br>"
                            f"impact KE: {sum_i.get('impact_ke_j')} J<br>"
                            f"unharmed (<= {ke_thresh_j} J): {sum_i.get('unharmed')}<br>"
                            f"downrange: {down_last} m<br>"
                            f"crossrange: {cross_last} m<br>"
                            f"dv = ({sum_i.get('dvx')}, {sum_i.get('dvy')}, {sum_i.get('dvz')}) m/s<br>"
                            f"mass: {sum_i.get('mass_kg')} kg, diam: {sum_i.get('rocket_diameter_cd')} m<br>"
                            f"Cd: {sum_i.get('fixed_cd')}, Cl: {sum_i.get('fixed_cl')}"
                        )
                        marker_obj = folium.CircleMarker(
                            location=(la, lo),
                            radius=max(1, marker_radius),
                            color=mcolor,
                            weight=1,
                            fill=True,
                            fill_opacity=marker_opacity,
                            tooltip=tooltip,
                            popup=folium.Popup(popup_html, max_width=320),
                        )
                        if unh is True:
                            layer_unharm.add_child(marker_obj)
                        else:
                            layer_harm.add_child(marker_obj)
                    fmap.add_child(layer_unharm)
                    fmap.add_child(layer_harm)
                except Exception:
                    pass

            # Layer control
            try:
                folium.LayerControl(collapsed=True).add_to(fmap)
            except Exception:
                pass

            # Save map
            try:
                path_leaf = out_dir / "leaflet_map.html"
                fmap.save(str(path_leaf))
                plots["leaflet_map"] = str(path_leaf.resolve())
            except Exception:
                pass

        # Impacts CSV (consolidated)
        write_imp_csv = bool(cfg.get("output", {}).get("save_impacts_csv", True))
        if write_imp_csv:
            try:
                import csv as _csv

                imp_path = out_dir / "impacts.csv"
                with open(imp_path, "w", newline="") as fcsv:
                    w = _csv.writer(fcsv)
                    w.writerow(
                        [
                            "index",
                            "impact_time_s",
                            "impact_lat_deg",
                            "impact_lon_deg",
                            "impact_speed_mps",
                            "signed_crossrange_m",
                            "downrange_m",
                            "dvx",
                            "dvy",
                            "dvz",
                            "mass_kg",
                            "diameter_m",
                            "cda_m2",
                            "beta_kg_m2",
                            "impact_ke_j",
                            "unharmed",
                            "csv_path",
                            "impact_status",
                        ]
                    )
                    for i, (res_i, sum_i) in enumerate(
                        zip(results, summary, strict=False)
                    ):
                        la = res_i.get("impact_lat_deg")
                        lo = res_i.get("impact_lon_deg")
                        ti = res_i.get("impact_time_s")
                        sp = res_i.get("impact_speed_mps")
                        # Optional bounds sanity: clamp longitude to [-180, 180)
                        try:
                            if lo is not None and (lo < -180.0 or lo >= 180.0):
                                lo = ((lo + 180.0) % 360.0) - 180.0
                        except Exception:
                            pass
                        # Crossrange and downrange: only use if valid impact exists
                        # If impact is None (ti, sp are None), or if values are non-finite/astronomical, set to NaN
                        try:
                            if ti is None or sp is None:
                                # No valid impact detected
                                cross_end = ""
                                down_end = ""
                                la = ""
                                lo = ""
                                ti = ""
                                sp = ""
                            else:
                                cross_val = float((res_i.get("cross") or [np.nan])[-1])
                                down_val = float((res_i.get("down") or [np.nan])[-1])
                                # Sanity check: if values are astronomical (> 1e10 m), leave empty
                                cross_end = (
                                    cross_val
                                    if (
                                        np.isfinite(cross_val) and abs(cross_val) < 1e10
                                    )
                                    else ""
                                )
                                down_end = (
                                    down_val
                                    if (np.isfinite(down_val) and abs(down_val) < 1e10)
                                    else ""
                                )
                        except Exception:
                            cross_end = ""
                            down_end = ""
                        w.writerow(
                            [
                                i,
                                ti,
                                la,
                                lo,
                                sp,
                                cross_end,
                                down_end,
                                sum_i.get("dvx"),
                                sum_i.get("dvy"),
                                sum_i.get("dvz"),
                                sum_i.get("mass_kg"),
                                sum_i.get("rocket_diameter_cd"),
                                sum_i.get("cda_m2"),
                                sum_i.get("beta_kg_m2"),
                                sum_i.get("impact_ke_j"),
                                sum_i.get("unharmed"),
                                res_i.get("csv"),
                                sum_i.get("impact_status"),
                            ]
                        )
                impacts_csv_path = str(imp_path.resolve())
            except Exception as _e:
                notes.append(f"impacts.csv write failed: {_e}")
    except Exception as _e:
        notes.append(f"leaflet/impacts.csv phase failed: {_e}")

    # Write summary JSON
    summary_path = out_dir / "summary.json"
    summary_doc = {
        "count": N,
        "single_mode": bool(single_mode),
        "base": base,
        "physics": {
            "use_j2": use_j2,
            "atmosphere_cutoff_m": atmosphere_cutoff_m,
            "alpha_deg": alpha_deg,
        },
        "results": summary,
        "notes": notes,
    }
    # Input metadata for traceability
    try:
        if epoch_tt is not None:
            summary_doc["epoch_tt"] = str(epoch_tt)
        summary_doc["input_sources"] = {
            "position": pos_source,
            "velocity": vel_source,
        }
    except Exception:
        pass
    # ΔV model metadata
    try:
        summary_doc["dv_model"] = "explosion_empirical"
        summary_doc["dv_explosion_params"] = {
            "alpha": alpha,
            "Lc_min_m": Lc_min,
            "Lc_max_m": Lc_max,
            "k_am": k_am,
            "sigma_log10_am": sigma_log10_am,
            "mu_offset": mu_offset,
            "mu_slope": mu_slope,
            "sigma_log10_dv": sigma_log10_dv,
            "dv_min": dv_min,
            "dv_max": dv_max,
        }
        try:
            summary_doc["cda_model"] = str(
                cfg.get("distributions", {}).get(
                    "cda_model", cfg.get("cda_model", "from_mass")
                )
            ).lower()
        except Exception:
            pass
        if "dv_stats_local" in locals() and dv_stats_local is not None:
            summary_doc["dv_stats"] = dv_stats_local
    except Exception:
        pass
    # Fragment count and beta stats
    try:
        summary_doc["fragments_count"] = int(N)
    except Exception:
        pass
    # CdA stats
    try:
        if "cda_s" in locals() and cda_s is not None:
            cs = np.array(cda_s, dtype=float)
            cs = cs[np.isfinite(cs)]
            if cs.size > 0:

                def _pct2(a, p):
                    try:
                        return float(np.percentile(a, p))
                    except Exception:
                        return None

                summary_doc["cda_stats"] = {
                    "mean": float(np.mean(cs)),
                    "median": float(np.median(cs)),
                    "p10": _pct2(cs, 10),
                    "p90": _pct2(cs, 90),
                    "min": float(np.min(cs)),
                    "max": float(np.max(cs)),
                }
    except Exception:
        pass
    try:
        if "beta_s" in locals() and beta_s is not None:
            bs = np.array(beta_s, dtype=float)
            bs = bs[np.isfinite(bs)]
            if bs.size > 0:

                def _pct(a, p):
                    try:
                        return float(np.percentile(a, p))
                    except Exception:
                        return None

                summary_doc["beta_stats"] = {
                    "mean": float(np.mean(bs)),
                    "median": float(np.median(bs)),
                    "p10": _pct(bs, 10),
                    "p90": _pct(bs, 90),
                    "min": float(np.min(bs)),
                    "max": float(np.max(bs)),
                }
    except Exception:
        pass
    # If harmful impacts exist, add harmful counts and mean impact lat/lon (harmful-only)
    try:
        # harmful counts
        try:
            hc = int(
                sum(
                    1
                    for r in summary
                    if (r.get("impact_time_s") is not None)
                    and (r.get("unharmed") is False)
                )
            )
        except Exception:
            hc = None
        try:
            tc = int(sum(1 for r in summary if r.get("impact_time_s") is not None))
        except Exception:
            tc = None
        if hc is not None:
            summary_doc["harmful_count"] = hc
        if hc is not None and tc and tc > 0:
            summary_doc["harmful_fraction"] = float(hc) / float(tc)
        impacts_coords_harm = []
        for r in summary:
            la = r.get("impact_lat_deg")
            lo = r.get("impact_lon_deg")
            ti = r.get("impact_time_s")
            sp = r.get("impact_speed_mps")
            unh = r.get("unharmed")
            try:
                if (unh is False) and (
                    la is not None
                    and lo is not None
                    and ti is not None
                    and sp is not None
                ):
                    la_v = float(la)
                    lo_v = float(lo)
                    ti_v = float(ti)
                    sp_v = float(sp)
                    if (
                        np.isfinite(la_v)
                        and np.isfinite(lo_v)
                        and np.isfinite(ti_v)
                        and np.isfinite(sp_v)
                    ):
                        impacts_coords_harm.append((la_v, lo_v))
            except Exception:
                continue
        if len(impacts_coords_harm) >= 2:
            ecefs = [coord.lla_2_ecef(la, lo, 0.0) for la, lo in impacts_coords_harm]
            rc = np.mean(np.array(ecefs), axis=0)
            la_m, lo_m, _ = coord.ecef_2_lla(rc)
            summary_doc["mean_impact_lat_deg"] = float(la_m)
            summary_doc["mean_impact_lon_deg"] = float(lo_m)
            # Map center and tiles metadata
            summary_doc["map_center_lat"] = float(la_m)
            summary_doc["map_center_lon"] = float(lo_m)
            try:
                dcm_c_e2n = coord.ecef_2_ned_dcm(la_m, lo_m)
                P = []
                for la, lo in impacts_coords_harm:
                    r_i = coord.lla_2_ecef(la, lo, 0.0)
                    P.append((dcm_c_e2n @ (r_i - rc))[:2])
                P = np.array(P)
                if P.shape[0] >= 2 and np.isfinite(P).all():
                    C = np.cov(P.T)
                    eps = 1e-9
                    C_reg = C + eps * np.eye(2)
                    try:
                        C_inv = np.linalg.inv(C_reg)
                    except Exception:
                        C_inv = np.linalg.pinv(C_reg)
                    d2 = np.einsum("ij,jk,ik->i", P, C_inv, P)
                    d2 = (
                        d2[np.isfinite(d2)] if np.any(np.isfinite(d2)) else np.array([])
                    )
                    vals, vecs = np.linalg.eigh(C)
                    vals = np.clip(vals, 1e-6, None)
                    order = np.argsort(vals)
                    V = vecs[:, [order[1], order[0]]]
                    levels = [(1.0, 0.6827), (2.0, 0.95), (3.0, 0.9973)]
                    out_levels = []
                    for sigma, conf_p in levels:
                        if d2.size > 0:
                            try:
                                k2 = float(np.quantile(d2, conf_p))
                            except Exception:
                                k2 = float(chi2.ppf(conf_p, df=2))
                            cov_emp = float(np.mean(d2 <= k2))
                        else:
                            k2 = float(chi2.ppf(conf_p, df=2))
                            cov_emp = float("nan")
                        a = float(np.sqrt(max(k2, 0.0) * vals[order[1]]))
                        b = float(np.sqrt(max(k2, 0.0) * vals[order[0]]))
                        v_major = V[:, 0]
                        az_deg = float(
                            (np.degrees(np.arctan2(v_major[1], v_major[0])) + 360.0)
                            % 360.0
                        )
                        out_levels.append(
                            {
                                "sigma": sigma,
                                "conf": conf_p,
                                "a_m": a,
                                "b_m": b,
                                "azimuth_deg": az_deg,
                                "coverage_empirical": cov_emp,
                            }
                        )
                    summary_doc["ellipse_levels"] = out_levels
            except Exception:
                pass
    except Exception:
        pass
    # Impacts CSV path and map/ellipse metadata
    if impacts_csv_path:
        summary_doc["impacts_csv"] = impacts_csv_path
    # Tiles metadata (reflect defaults used above)
    try:
        out_map_cfg = cfg.get("output", {}).get("leaflet_map", {})
        summary_doc["default_basemap"] = str(out_map_cfg.get("tiles", "OpenStreetMap"))
        summary_doc["tiles_available"] = list(
            out_map_cfg.get(
                "extra_tiles",
                [
                    "OpenStreetMap",
                    "Esri.WorldImagery",
                    "CartoDB positron",
                    "Esri.WorldTopoMap",
                ],
            )
        )
        summary_doc["zoom_start"] = int(out_map_cfg.get("zoom_start", 6))
    except Exception:
        pass
    # Ellipse parameters if computed
    try:
        if "e_a_m" in locals() and (e_a_m is not None) and (e_b_m is not None):
            summary_doc["ellipse_sigma"] = 3
            summary_doc["ellipse_mode"] = ellipse_mode
            # ellipse_confidence removed from config; summaries use fixed 1σ/2σ/3σ levels
            summary_doc["ellipse_center_lat"] = float(lat_c_map)
            summary_doc["ellipse_center_lon"] = float(lon_c_map)
            summary_doc["ellipse_a_m"] = float(e_a_m)
            summary_doc["ellipse_b_m"] = float(e_b_m)
            summary_doc["ellipse_azimuth_deg"] = float(
                e_az_deg if e_az_deg is not None else 0.0
            )
    except Exception:
        pass
    # Timestamp
    try:
        summary_doc["generated_at"] = datetime.now().isoformat(timespec="seconds")
    except Exception:
        pass
    with open(summary_path, "w") as f:
        json.dump(summary_doc, f, indent=2)

    # Write summary HTML (easy to read)
    try:
        import html
        from datetime import datetime as _dt

        rows = []
        for r in summary:
            tstr = (
                ""
                if (r.get("impact_time_s") is None)
                else f"{r.get('impact_time_s'):.3f}"
            )
            betastr = (
                "" if (r.get("beta_kg_m2") is None) else f"{r.get('beta_kg_m2'):.3g}"
            )
            lastr = (
                ""
                if (r.get("impact_lat_deg") is None)
                else f"{r.get('impact_lat_deg'):.5f}"
            )
            lonstr = (
                ""
                if (r.get("impact_lon_deg") is None)
                else f"{r.get('impact_lon_deg'):.5f}"
            )
            spstr = (
                ""
                if (r.get("impact_speed_mps") is None)
                else f"{r.get('impact_speed_mps'):.3f}"
            )
            rows.append(
                f"<tr>"
                f"<td>{r['index']}</td>"
                f"<td>{r['mass_kg']:.3g}</td>"
                f"<td>{r['rocket_diameter_cd']:.3g}</td>"
                f"<td>{r['rocket_diameter_cl']:.3g}</td>"
                f"<td>{r['fixed_cd']:.3g}</td>"
                f"<td>{r['fixed_cl']:.3g}</td>"
                f"<td>{betastr}</td>"
                f"<td>{r['dvx']:.3g}</td>"
                f"<td>{r['dvy']:.3g}</td>"
                f"<td>{r['dvz']:.3g}</td>"
                f"<td>{tstr}</td>"
                f"<td>{lastr}</td>"
                f"<td>{lonstr}</td>"
                f"<td>{spstr}</td>"
                f"</tr>"
            )
        # Custom markers listing (from config)
        # globe_2d config removed
        g2_cfg = {}
        cm_list = []
        try:
            cms_cfg = g2_cfg.get("custom_markers", [])
            if isinstance(cms_cfg, list):
                for m in cms_cfg:
                    vis = bool(m.get("visible", True))
                    if not vis:
                        continue
                    la = m.get("lat", None)
                    lo = m.get("lon", None)
                    try:
                        la_v = float(la)
                        lo_v = float(lo)
                        if not (np.isfinite(la_v) and np.isfinite(lo_v)):
                            continue
                        if abs(la_v) > 90 or abs(lo_v) > 180:
                            continue
                        lab = str(m.get("label", "") or "")
                        cm_list.append((lab, la_v, lo_v))
                    except Exception:
                        continue
        except Exception:
            cm_list = []

        summary_html = f"""
<!DOCTYPE html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\" />
  <title>Debris Summary</title>
  <style>
    body {{ font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; }}
    h1 {{ margin-bottom: 0; }}
    .meta {{ color: #666; margin-top: 4px; margin-bottom: 16px; }}
    table {{ border-collapse: collapse; width: 100%; font-size: 14px; }}
    th, td {{ border: 1px solid #ddd; padding: 6px 8px; text-align: right; }}
    th {{ background: #f5f7fb; text-align: center; }}
    td:first-child, th:first-child {{ text-align: center; }}
    .grid {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 24px; margin-bottom: 16px; }}
    .kv b {{ color: #333; }}
  </style>
  </head>
<body>
  <h1>Debris Simulation Summary</h1>
  <div class=\"meta\">Generated {html.escape(_dt.now().strftime('%Y-%m-%d %H:%M'))}</div>
    <div class=\"grid\">
      <div class=\"kv\"><b>Count:</b> {summary_doc['count']}</div>
      <div class=\"kv\"><b>Mode:</b> {'Single' if summary_doc['single_mode'] else 'Batch'}</div>
      <div class=\"kv\"><b>Lat:</b> {lat0:.5f}</div>
      <div class=\"kv\"><b>Lon:</b> {lon0:.5f}</div>
      <div class=\"kv\"><b>Alt (m):</b> {h0:.1f}</div>
      <div class=\"kv\"><b>Atmos Cutoff (m):</b> {atmosphere_cutoff_m:.0f}</div>
      <div class=\"kv\"><b>Alpha (deg):</b> {alpha_deg:.2f}</div>
      {('<div class=\\"kv\\"><b>Epoch (TT):</b> %s</div>' % html.escape(str(summary_doc.get('epoch_tt')))) if ('epoch_tt' in summary_doc) else ''}
      {('<div class=\"kv\"><b>Mean Impact Lat:</b> %.5f</div><div class=\"kv\"><b>Mean Impact Lon:</b> %.5f</div>' % (summary_doc.get('mean_impact_lat_deg'), summary_doc.get('mean_impact_lon_deg'))) if ('mean_impact_lat_deg' in summary_doc and 'mean_impact_lon_deg' in summary_doc) else ''}
    </div>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Mass (kg)</th><th>D_cd (m)</th><th>D_cl (m)</th>
        <th>Cd</th><th>Cl</th><th>β (kg/m²)</th><th>Δv_x</th><th>Δv_y</th><th>Δv_z</th>
        <th>Impact t (s)</th><th>Impact lat</th><th>Impact lon</th><th>Impact speed (m/s)</th>
      </tr>
    </thead>
    <tbody>
      {''.join(rows)}
    </tbody>
  </table>
  {('<h2 style=\'margin-top:18px;\'>Custom Markers</h2>'
    '<table><thead><tr><th>Label</th><th>Lat</th><th>Lon</th></tr></thead><tbody>' +
    ''.join([f"<tr><td>{html.escape(lab)}</td><td>{lat:.5f}</td><td>{lon:.5f}</td></tr>" for (lab, lat, lon) in cm_list]) +
    '</tbody></table>') if cm_list else ''}
</body>
</html>
"""
        summary_html_path = out_dir / "summary.html"
        with open(summary_html_path, "w", encoding="utf-8") as f:
            f.write(summary_html)
        plots["summary_html"] = str(summary_html_path.resolve())
        # Auto-open summary HTML like other charts if requested
        try:
            if auto_open:
                import webbrowser

                webbrowser.open(summary_html_path.resolve().as_uri())
        except Exception:
            pass
    except Exception as e:
        plots["summary_html_error"] = f"Failed to write summary HTML: {e}"

    return {
        "output_folder": str(out_dir.resolve()),
        "count": N,
        "summary_json": str(summary_path.resolve()),
        "plots": plots,
    }
