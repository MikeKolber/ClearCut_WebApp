"""PBS calculation engine.

Calls the exact same helper functions from PBS/RocketMassCalc/helpers/.
"""

import sys
import math
from pathlib import Path

_HELPERS_ROOT = Path(__file__).resolve().parent / "RocketMassCalc"
if str(_HELPERS_ROOT) not in sys.path:
    sys.path.insert(0, str(_HELPERS_ROOT))

from helpers import Engine_Mass
from helpers import TVC_Mass
from helpers import Gas_Mass
from helpers import Thrust_Structure_Mass
from helpers import Propellant_Tanks_Standard as pt
from helpers import Propellant_Tanks_Castellini as ptc
from helpers import Propellant_Tanks_Pablo_Rachov as ptr


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def _f(val, default=0.0):
    """Safely convert to float."""
    if isinstance(val, (int, float)):
        return float(val)
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def _i(val, default=1):
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return default


_TOTAL_MASS_METHODS = {"castellini_storables_conserv"}


# ---------------------------------------------------------------------------
# Per-component calculators
# ---------------------------------------------------------------------------

def calc_engine(data: dict) -> dict:
    method = data.get("model_key", "our_thrust")
    num_eng = _i(data.get("num_engines", 1))
    if method == "our_flow":
        value = _f(data.get("m_dot", 17))
    else:
        value = _f(data.get("thrust_kN", 200))

    single = Engine_Mass.estimate_engine_mass(method, value, num_eng)
    if method in _TOTAL_MASS_METHODS:
        total = single
    else:
        total = single * num_eng

    result = {"mass": total, "per_engine": single, "num_engines": num_eng}

    # Derived performance when CEA section is enabled
    cea_on = data.get("cea_enabled", False)
    if cea_on:
        result["performance"] = _calc_engine_performance(data, num_eng)

    return result


def _calc_engine_performance(data: dict, num_eng: int) -> dict:
    """Derive engine performance metrics. Tries CEA first; falls back to
    analytical estimates from the user-provided inputs."""
    g0 = 9.80665
    thrust_kN = _f(data.get("thrust_kN", 200))
    m_dot = _f(data.get("m_dot", 17))
    P_c_bar = _f(data.get("P_c", 80))
    Ae_At = _f(data.get("Ae_At", 20))
    design_eff = _f(data.get("design_efficiency", 100)) / 100
    actual_eff = _f(data.get("actual_efficiency", 97)) / 100
    nozzle_eff = _f(data.get("nozzle_efficiency", 98.7)) / 100
    l_pct = _f(data.get("l_percent", 80))
    D_rocket = _f(data.get("outer_diameter", 1.25))

    perf: dict = {
        "P_c_bar": P_c_bar,
        "Ae_At": Ae_At,
        "m_dot": m_dot,
    }

    # Try running CEA (requires the executable — will fail gracefully)
    cea_ok = False
    try:
        from helpers.CEA.Rocket_CEA_Class import RocketCEA
        run_type = data.get("run_type", "Full (Optimal O/F)")
        fuel = data.get("fuel_type", "Jet-A(L)")
        ox = data.get("oxidizer_type", "HTP90")
        T_f = _f(data.get("Tinit_Fuel", 298))
        T_ox = _f(data.get("Tinit_Oxidizer", 298))
        htp = _f(data.get("HTP_concentration", 94)) if ox == "HTP_Specific" else None
        of_custom = _f(data.get("OF_ratio", 4)) if "Single" in str(run_type) else 2.0

        cea = RocketCEA(P_c_bar, Ae_At, T_f, T_ox, fuel, ox,
                        "Full" if "Full" in str(run_type) else "Single",
                        of_custom, htp)
        cea_result = cea.run()

        if "Full" in str(run_type):
            opt_of, Pe, Ve, C_star_th = cea_result
            perf["optimal_OF"] = opt_of
            P_c_actual = (actual_eff / design_eff) * P_c_bar if design_eff else P_c_bar
            cea2 = RocketCEA(P_c_actual, Ae_At, T_f, T_ox, fuel, ox,
                             "Single", opt_of, htp)
            Pe, Ve, C_star = cea2.run()
        else:
            Pe, Ve, C_star = cea_result
            C_star_th = C_star

        perf["C_star_th"] = C_star_th
        perf["C_star"] = C_star
        perf["Ve"] = Ve
        perf["Pe_bar"] = Pe
        cea_ok = True
    except Exception:
        pass

    # Derive geometry from available data
    P_c_Pa = P_c_bar * 1e5
    if cea_ok:
        A_t = design_eff * perf["C_star_th"] * m_dot / P_c_Pa if P_c_Pa else 0
        A_e = A_t * Ae_At
        De = math.sqrt(4 * A_e / math.pi) if A_e > 0 else 0
        thrust_N = nozzle_eff * (actual_eff * m_dot * perf["Ve"]
                                 + perf["Pe_bar"] * 1e5 * A_e)
        perf["Isp_s"] = thrust_N / (m_dot * g0) if m_dot > 0 else 0
    else:
        thrust_N = thrust_kN * 1000
        Isp_est = thrust_N / (m_dot * g0) if m_dot > 0 else 0
        C_star_est = Isp_est * g0 / 1.5 if Isp_est else 0
        A_t = m_dot * C_star_est / P_c_Pa if P_c_Pa and C_star_est else 0
        A_e = A_t * Ae_At
        De = math.sqrt(4 * A_e / math.pi) if A_e > 0 else 0
        perf["Isp_s"] = Isp_est
        perf["cea_note"] = "CEA not available — geometry from analytical estimate"

    perf["A_t"] = A_t
    perf["A_e"] = A_e
    perf["De"] = De
    perf["thrust_N"] = thrust_N * num_eng

    # Packaging check
    individual_pack = [2, 4, 4.31, 4.828, 5.402, 6, 6, 6.608, 7.226]
    if num_eng <= len(individual_pack):
        De_max = D_rocket / individual_pack[num_eng - 1]
        perf["De_max"] = De_max
        perf["De_fits"] = De <= De_max

    return perf


def calc_tvc(data: dict) -> dict:
    model = data.get("model", "Castellini")

    if model == "Castellini":
        thrust = _f(data.get("thrust_kN", 200))
        act_str = str(data.get("actuator", "2"))
        tvc_type = 1 if act_str.startswith("1") else 2
        delta = _f(data.get("delta", 6))
        mass = TVC_Mass.calculate_tvc_mass_castellini(thrust, 1, tvc_type, delta)
    elif model == "Rohrschneider":
        thrust = _f(data.get("thrust_kN", 200))
        n_eng = _i(data.get("N_eng", 1))
        mass = TVC_Mass.calculate_tvc_mass_rohrschneider(thrust, n_eng)
    elif model == "Akin":
        thrust = _f(data.get("thrust_kN", 200))
        n_eng = _i(data.get("N_eng", 1))
        pc = _f(data.get("Pc_Pa", 3e6))
        mass = TVC_Mass.calculate_tvc_mass_akin(thrust, pc, n_eng)
    else:
        mass = 0.0

    return {"mass": mass, "model": model}


def calc_thrust_structure(data: dict) -> dict:
    method = data.get("method", "linear_fit")
    if method == "linear_fit":
        thrust_N = _f(data.get("T_total_N", 200_000))
        mass = Thrust_Structure_Mass.thrust_structure_mass(thrust_N)
    elif method == "castellini":
        n_eng = _i(data.get("N_eng", 1))
        T_per = _f(data.get("T_per_engine_N", 200_000))
        m_eng = _f(data.get("m_eng_kg", 500))
        ssm = _f(data.get("SSM", 1.0))
        n_ax = _f(data.get("n_ax", 1.0))
        g0 = _f(data.get("g0", 9.80665))
        k_sm = _f(data.get("k_sm", 1.0))
        mass = k_sm * ssm * n_eng * m_eng * n_ax * g0 / (T_per if T_per else 1)
    elif method == "rohrschneider":
        thrust_N = _f(data.get("T_total_N", 200_000))
        k_t = _f(data.get("k_thrust", 0.0))
        mass = Thrust_Structure_Mass.thrust_structure_mass(thrust_N) + k_t * thrust_N
    else:
        mass = 0.0
    return {"mass": mass, "method": method}


def calc_pressurant(data: dict) -> dict:
    R_gas = _f(data.get("R_gas", 2077))
    params = {
        "V_ox": _f(data.get("V_ox", 0.12)),
        "V_fu": _f(data.get("V_fu", 0.115)),
        "P_tank": _f(data.get("P_tank", 3e6)),
        "P0": _f(data.get("P0", 2.86e8)),
        "T0": _f(data.get("T0", 293)),
        "R_gas_const": R_gas,
        "gamma": _f(data.get("gamma", 1.667)),
        "rho_material": _f(data.get("rho_mat", 4429)),
        "sigma_y": _f(data.get("sigma_y", 880e6)),
        "SF": _f(data.get("SF", 3.5)),
        "model_text": data.get("model", "Adiabatic"),
    }

    uts_sel = str(data.get("UTS", ""))
    if "950" in uts_sel:
        params["UTS"] = 950e6
        params["SF_UTS"] = params["SF"]
    elif "Custom" in uts_sel:
        params["UTS"] = _f(data.get("UTS_custom", 950e6))
        params["SF_UTS"] = params["SF"]

    gas_mass, tank_mass, gas_vol, tank_r, wall_t = Gas_Mass.pressurant_system_mass(params)
    return {
        "gas_mass": gas_mass,
        "tank_mass": tank_mass,
        "mass": gas_mass + tank_mass,
        "gas_volume": gas_vol,
        "tank_radius": tank_r,
        "wall_thickness": wall_t,
    }


# ---------------------------------------------------------------------------
# Propellant Tanks
# ---------------------------------------------------------------------------

def _auto_cyl_length(required_vol, radius, head_vol):
    """Cylinder length needed after subtracting head volume."""
    cyl_vol = required_vol - head_vol
    area = math.pi * radius ** 2
    return max(0.0, cyl_vol / area) if area > 0 else 0.0


def _calc_standard_tank(td: dict, prop_mass: float, role: str) -> dict:
    """Standard-method tank sizing for one tank (Ox or Fuel)."""
    prop_density = _f(td.get("prop_density_resolved", 1140))
    mat_density = _f(td.get("mat_density_resolved", 2700))
    ullage = _f(td.get("ullage", 0.05))
    pressure = _f(td.get("pressure", 3e6))
    stress = _f(td.get("stress", 250e6))
    eff = _f(td.get("efficiency", 0.9))
    shape = td.get("shape", "Sphero-cylinder")

    required_vol = prop_mass / (prop_density * (1 - ullage)) if prop_density > 0 else 0

    if shape == "Sphero-cylinder":
        r = _f(td.get("sc_radius", 0.4))
        user_L = td.get("sc_cyl_len", "")
        head_vol = (4 / 3) * math.pi * r ** 3
        L = _f(user_L) if user_L else _auto_cyl_length(required_vol, r, head_vol)
        params = pt.TankParameters(
            cylindrical_length=L, ullage=ullage, pressure=pressure,
            material_density=mat_density, stress=stress, efficiency=eff,
            diameter=2 * r, propellant_density=prop_density,
            propellant_mass=prop_mass,
        )
    elif shape == "Ellipsoidal":
        r = _f(td.get("el_radius", 0.4))
        head_h = _f(td.get("el_head_h", 0.2))
        user_L = td.get("el_cyl_len", "")
        head_vol = 2 * (2 / 3) * math.pi * r ** 2 * head_h
        L = _f(user_L) if user_L else _auto_cyl_length(required_vol, r, head_vol)
        params = pt.EllipsoidalParameters(
            cylindrical_length=L, ullage=ullage, pressure=pressure,
            material_density=mat_density, stress=stress, efficiency=eff,
            diameter=2 * r, propellant_density=prop_density,
            propellant_mass=prop_mass, head_height=head_h,
        )
    elif shape == "Torispherical":
        r = _f(td.get("ts_radius", 0.4))
        user_L = td.get("ts_cyl_len", "")
        crown = _f(td.get("ts_crown", 0.7))
        knuckle = _f(td.get("ts_knuckle", 0.08))
        head_vol = (4 / 3) * math.pi * r ** 3  # rough approximation for auto-L
        L = _f(user_L) if user_L else _auto_cyl_length(required_vol, r, head_vol)
        params = pt.TorisphericalParameters(
            cylindrical_length=L, ullage=ullage, pressure=pressure,
            material_density=mat_density, stress=stress, efficiency=eff,
            diameter=2 * r, propellant_density=prop_density,
            propellant_mass=prop_mass,
            crown_radius=crown, knuckle_radius=knuckle,
        )
    elif shape == "Spherical (Separated)":
        r = _f(td.get("sc_radius", 0.4))
        params = pt.SphericalSeparatedParameters(
            cylindrical_length=0, ullage=ullage, pressure=pressure,
            material_density=mat_density, stress=stress, efficiency=eff,
            diameter=2 * r, propellant_density=prop_density,
            propellant_mass=prop_mass,
            oxidizer_propellant_mass=prop_mass if role == "Oxidizer" else 1.0,
            fuel_propellant_mass=prop_mass if role == "Fuel" else 1.0,
            oxidizer_propellant_density=prop_density if role == "Oxidizer" else 800.0,
            fuel_propellant_density=prop_density if role == "Fuel" else 800.0,
        )
    else:
        return {"shell_mass": 0.0, "error": f"Unknown shape {shape}"}

    analysis = pt.TankAnalysis(params)
    results = analysis.calculate_tank_properties()
    return results


def _calc_castellini_tank(td: dict, cg: dict, role: str) -> dict:
    cast_type = "Oxidizer" if role == "Oxidizer" else "Fuel"
    sm = td.get("cast_SM", "Composite Tanks")
    shape_sel = td.get("cast_shape", "Ellipsoidal")

    R = _f(td.get("cast_R", 0.4))
    crown = _f(td.get("cast_crown", 0.4))
    L = _f(td.get("cast_L", 0.0))
    manual_vol = _f(td.get("cast_manual_vol", 1.0)) if shape_sel == "Manual" else None

    params = ptc.TankParameters(
        type=cast_type,
        SM=sm,
        TT="Separate Tanks",
        tank_shape=shape_sel,
        R=R,
        r_crown=crown,
        L=L,
        rocket_length=_f(cg.get("rocket_len", 15)),
        rocket_diameter=_f(cg.get("rocket_diam", 1.2)),
        ssm=_f(cg.get("ssm", 1.5)),
        max_q=_f(cg.get("max_q", 40000)),
        max_g=_f(cg.get("max_g", 7)),
        n_ax_max=_f(cg.get("n_ax_max", 7)),
        n_ax_max_pl=_f(cg.get("n_ax_max_pl", 7)),
        p_cc=_f(cg.get("p_cc", 1e6)),
        feed_type=cg.get("feed_type", "Pressure-fed"),
        manual_volume=manual_vol,
    )

    calc = ptc.TankCalculator(params)
    mass = calc.calculate_mass()
    volume = calc.calculate_volume()
    return {"shell_mass": mass, "volume": volume, "k_factors": calc.k_factors}


def _calc_pablo_tank(td: dict, prop_mass: float) -> dict:
    prop_density = _f(td.get("prop_density_resolved", 1140))
    mat_density = _f(td.get("mat_density_resolved", 2700))
    params = {
        "pressure": _f(td.get("pressure", 3e6)),
        "ullage": _f(td.get("ullage", 0.05)),
        "material_density": mat_density,
        "SF_cyl": _f(td.get("pablo_SF_cyl", 2.0)),
        "SF_sph": _f(td.get("pablo_SF_sph", 2.0)),
        "uts": _f(td.get("pablo_uts", 500e6)),
        "V_cyl_actual": _f(td.get("pablo_cyl_vol", 1.0)),
        "V_sph_actual": _f(td.get("pablo_sph_vol", 0.25)),
    }
    mass = ptr.calculate_tank_mass(params)
    return {"shell_mass": mass}


def _calc_common_bulkhead(ox_td: dict, fu_td: dict,
                          ox_prop: float, fu_prop: float) -> dict:
    """Integrated Common Bulkhead calculation — shared tank for Ox + Fuel."""
    ox_prop_density = _f(ox_td.get("prop_density_resolved", 1140))
    fu_prop_density = _f(fu_td.get("prop_density_resolved", 800))
    mat_density = _f(ox_td.get("mat_density_resolved", 2700))
    ullage = _f(ox_td.get("ullage", 0.05))
    pressure = _f(ox_td.get("pressure", 3e6))
    stress = _f(ox_td.get("stress", 250e6))
    eff = _f(ox_td.get("efficiency", 0.9))

    r = _f(ox_td.get("cb_radius", 0.4))
    head_type = ox_td.get("cb_head_type", "Spherical")
    fraction = _f(ox_td.get("cb_fraction", 0.5))

    kwargs = dict(
        cylindrical_length=0,
        ullage=ullage, pressure=pressure, material_density=mat_density,
        stress=stress, efficiency=eff, diameter=2 * r,
        propellant_density=ox_prop_density,
        propellant_mass=ox_prop + fu_prop,
        head_type=head_type,
        bulkhead_shell_fraction=fraction,
        oxidizer_propellant_mass=ox_prop,
        fuel_propellant_mass=fu_prop,
        oxidizer_propellant_density=ox_prop_density,
        fuel_propellant_density=fu_prop_density,
    )

    if head_type == "Ellipsoidal":
        kwargs["head_height"] = _f(ox_td.get("cb_head_h", 0.2))
    elif head_type == "Torispherical":
        kwargs["crown_radius"] = _f(ox_td.get("cb_crown", 0.7))
        kwargs["knuckle_radius"] = _f(ox_td.get("cb_knuckle", 0.08))

    params = pt.CommonBulkheadParameters(**kwargs)
    analysis = pt.TankAnalysis(params)
    return analysis.calculate_tank_properties()


def calc_propellant_tanks(data: dict) -> dict:
    method = data.get("method", "Standard")
    total_prop = _f(data.get("propellant_mass", 10000))
    of_ratio = _f(data.get("OF_ratio", 2.5))

    ox_prop_mass = total_prop * of_ratio / (1 + of_ratio)
    fu_prop_mass = total_prop / (1 + of_ratio)

    ox_td = data.get("oxidizer", {})
    fu_td = data.get("fuel", {})

    if method == "Standard":
        ox_shape = ox_td.get("shape", "Sphero-cylinder")
        if ox_shape == "Common Bulkhead":
            cb_res = _calc_common_bulkhead(ox_td, fu_td, ox_prop_mass, fu_prop_mass)
            ox_res = cb_res
            fu_res = {"shell_mass": 0.0, "note": "Included in Common Bulkhead"}
        else:
            ox_res = _calc_standard_tank(ox_td, ox_prop_mass, "Oxidizer")
            fu_res = _calc_standard_tank(fu_td, fu_prop_mass, "Fuel")
    elif method == "Castellini":
        cg = data.get("castellini_global", {})
        ox_res = _calc_castellini_tank(ox_td, cg, "Oxidizer")
        fu_res = _calc_castellini_tank(fu_td, cg, "Fuel")
    elif method == "Pablo Rachov":
        ox_res = _calc_pablo_tank(ox_td, ox_prop_mass)
        fu_res = _calc_pablo_tank(fu_td, fu_prop_mass)
    else:
        ox_res = {"shell_mass": 0.0}
        fu_res = {"shell_mass": 0.0}

    return {
        "ox_propellant_mass": ox_prop_mass,
        "fuel_propellant_mass": fu_prop_mass,
        "total_propellant_mass": total_prop,
        "ox_tank_mass": ox_res.get("shell_mass", 0),
        "fuel_tank_mass": fu_res.get("shell_mass", 0),
        "ox_details": ox_res,
        "fuel_details": fu_res,
    }


# ---------------------------------------------------------------------------
# Fairing
# ---------------------------------------------------------------------------

def calc_fairing(data: dict) -> dict:
    if not data.get("enabled"):
        return {"mass": 0.0, "enabled": False}

    r_cyl = _f(data.get("r_cyl", 0.6))
    L_cyl = _f(data.get("L_cyl", 5.0))
    r_base = _f(data.get("r_base", 0.8))
    L_base = _f(data.get("L_base", 3.0))
    t = _f(data.get("t", 0.005))
    rho_cyl = _f(data.get("rho_cyl", 1600))
    rho_frust = _f(data.get("rho_frust", 1600))
    rho_nose = _f(data.get("rho_nose", 1600))
    k_nose = _f(data.get("k_nose", 1.1))
    L_nose = _f(data.get("L_nose", 2.0))
    delta = _f(data.get("delta", 0.0))

    cyl_area = 2 * math.pi * r_cyl * L_cyl
    slant = math.sqrt(L_base ** 2 + (r_base - r_cyl) ** 2)
    frust_area = math.pi * (r_cyl + r_base) * slant
    nose_slant = math.sqrt(L_nose ** 2 + (r_cyl - delta) ** 2)
    nose_area = math.pi * (r_cyl + delta) * nose_slant

    m_cyl = cyl_area * t * rho_cyl
    m_frust = frust_area * t * rho_frust
    m_nose = k_nose * nose_area * t * rho_nose

    return {
        "mass": m_cyl + m_frust + m_nose,
        "enabled": True,
        "m_cyl": m_cyl,
        "m_frust": m_frust,
        "m_nose": m_nose,
    }


# ---------------------------------------------------------------------------
# Interstages
# ---------------------------------------------------------------------------

def calc_interstages(data: dict) -> dict:
    sections = data.get("interstages", {})
    results = {}
    total = 0.0
    for idx_key, vals in sections.items():
        r = _f(vals.get("radius_m", 0.5))
        stage_len = _f(vals.get("stage_length_m", 5.0))
        frac = _f(vals.get("interstage_frac", 10.0)) / 100.0
        area_d = _f(vals.get("area_density", 5.0))
        interstage_len = stage_len * frac
        surface = 2 * math.pi * r * interstage_len
        mass = surface * area_d
        results[idx_key] = {"mass": mass, "length": interstage_len}
        total += mass
    return {"sections": results, "total_mass": total}


# ---------------------------------------------------------------------------
# PLA
# ---------------------------------------------------------------------------

def calc_pla(data: dict) -> dict:
    if not data.get("enabled"):
        return {"mass": 0.0, "enabled": False}
    return {
        "mass": _f(data.get("payload_mass", 0)),
        "enabled": True,
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def calculate_pbs(stage_data: dict, num_stages: int) -> dict:
    """
    Run the full PBS calculation.

    Parameters
    ----------
    stage_data : dict
        {stage_idx: {tab_key: tab_data_dict, ...}, ...}
        Keys: "engine", "tvc", "thrust", "propellant", "pressurant",
              "fairing", "pla", "interstages"
    num_stages : int

    Returns
    -------
    dict  with "stages", "interstages", "totals"
    """
    stages_out = {}
    total_dry = 0.0
    total_prop = 0.0

    for si in range(1, num_stages + 1):
        sd = stage_data.get(si, {})
        stage = {}
        errors = []

        # Engine
        try:
            r = calc_engine(sd.get("engine", {}))
            stage["engine"] = r
        except Exception as e:
            stage["engine"] = {"mass": 0.0}
            errors.append(f"Engine: {e}")

        # TVC
        try:
            r = calc_tvc(sd.get("tvc", {}))
            stage["tvc"] = r
        except Exception as e:
            stage["tvc"] = {"mass": 0.0}
            errors.append(f"TVC: {e}")

        # Thrust structure
        try:
            r = calc_thrust_structure(sd.get("thrust", {}))
            stage["thrust_structure"] = r
        except Exception as e:
            stage["thrust_structure"] = {"mass": 0.0}
            errors.append(f"Thrust structure: {e}")

        # Propellant tanks
        try:
            r = calc_propellant_tanks(sd.get("propellant", {}))
            stage["propellant_tanks"] = r
        except Exception as e:
            stage["propellant_tanks"] = {
                "ox_tank_mass": 0.0, "fuel_tank_mass": 0.0,
                "total_propellant_mass": 0.0,
            }
            errors.append(f"Propellant tanks: {e}")

        # Pressurant
        try:
            r = calc_pressurant(sd.get("pressurant", {}))
            stage["pressurant"] = r
        except Exception as e:
            stage["pressurant"] = {"mass": 0.0}
            errors.append(f"Pressurant: {e}")

        # Fairing (typically only top stage)
        try:
            r = calc_fairing(sd.get("fairing", {}))
            stage["fairing"] = r
        except Exception as e:
            stage["fairing"] = {"mass": 0.0}
            errors.append(f"Fairing: {e}")

        # PLA
        try:
            r = calc_pla(sd.get("pla", {}))
            stage["pla"] = r
        except Exception as e:
            stage["pla"] = {"mass": 0.0}
            errors.append(f"PLA: {e}")

        # Summaries
        pt_data = stage["propellant_tanks"]
        dry = (
            stage["engine"].get("mass", 0)
            + stage["tvc"].get("mass", 0)
            + stage["thrust_structure"].get("mass", 0)
            + pt_data.get("ox_tank_mass", 0)
            + pt_data.get("fuel_tank_mass", 0)
            + stage["pressurant"].get("mass", 0)
            + stage["fairing"].get("mass", 0)
            + stage["pla"].get("mass", 0)
        )
        prop = pt_data.get("total_propellant_mass", 0)
        stage["dry_mass"] = dry
        stage["propellant_mass"] = prop
        stage["wet_mass"] = dry + prop
        stage["errors"] = errors

        stages_out[si] = stage
        total_dry += dry
        total_prop += prop

    # Interstages (shared, not per-stage)
    inter_data = stage_data.get("interstages", {})
    try:
        inter_res = calc_interstages(inter_data)
    except Exception as e:
        inter_res = {"total_mass": 0.0, "sections": {}, "error": str(e)}

    total_dry += inter_res.get("total_mass", 0)

    return {
        "stages": stages_out,
        "interstages": inter_res,
        "totals": {
            "dry_mass": total_dry,
            "propellant_mass": total_prop,
            "wet_mass": total_dry + total_prop,
        },
    }
