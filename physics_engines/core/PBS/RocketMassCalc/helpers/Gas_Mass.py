"""
Pressurant system mass calculation module.

This module provides functions for calculating pressurant gas mass and tank parameters
using different thermodynamic models (isothermal, energy, and adiabatic).
"""

import math
from typing import Dict, Tuple


class PressurantCalculationError(Exception):
    """Exception raised for calculation errors in pressurant system analysis."""
    pass


def _validate_parameters(params: Dict) -> None:
    """Validate input parameters for pressurant system calculations."""
    required_keys = [
        "V_ox", "V_fu", "P_tank", "P0", "T0", "R_gas_const",
        "gamma", "rho_material", "model_text"
    ]
    
    missing_keys = [key for key in required_keys if key not in params]
    if missing_keys:
        raise ValueError(f"Missing required parameters: {missing_keys}")
    
    # Validate physical constraints
    if params["P0"] <= 0:
        raise PressurantCalculationError("Initial storage pressure P0 must be positive.")
    if params["P_tank"] >= params["P0"]:
        raise PressurantCalculationError("Tank pressure P_tank must be less than initial pressure P0.")
    # If UTS-based sizing is used, ensure plausibility
    if ("UTS" in params and params.get("UTS", 0) > 0) and ("SF_UTS" in params and params.get("SF_UTS", 0) <= 0):
        raise PressurantCalculationError("SF_UTS must be positive when UTS is provided.")


def _calculate_isothermal_mass(params: Dict, total_tank_volume: float) -> float:
    """Calculate pressurant mass using isothermal model (Eq 6-2)."""
    P_tanks = params["P_tank"]
    P0 = params["P0"]
    R = params["R_gas_const"]
    T0 = params["T0"]
    
    pressure_ratio = P_tanks / P0
    if pressure_ratio >= 1.0:
        raise PressurantCalculationError("Invalid pressure ratio for isothermal model.")
    
    return (P_tanks * total_tank_volume) / (R * T0 * (1.0 - pressure_ratio))


def _calculate_energy_mass(params: Dict, total_tank_volume: float) -> float:
    """Calculate pressurant mass using energy model (Eq 6-7)."""
    P_tanks = params["P_tank"]
    P0 = params["P0"]
    R = params["R_gas_const"]
    T0 = params["T0"]
    gamma = params["gamma"]
    
    pressure_ratio = P_tanks / P0
    if pressure_ratio >= 1.0:
        raise PressurantCalculationError("Invalid pressure ratio for energy model.")
    
    return (P_tanks * total_tank_volume * gamma) / (R * T0 * (1.0 - pressure_ratio))


def _calculate_adiabatic_mass(params: Dict, total_tank_volume: float) -> float:
    """Calculate pressurant mass using adiabatic model (Eq 6-3)."""
    P_tanks = params["P_tank"]
    P0 = params["P0"]
    R = params["R_gas_const"]
    T0 = params["T0"]
    gamma = params["gamma"]
    
    # Calculate denominator with proper error handling
    gamma_exp = (1.0 - gamma) / gamma
    denominator = P0 ** gamma_exp - (P_tanks ** (1.0 / gamma)) / P0
    
    if abs(denominator) < 1e-12:
        raise PressurantCalculationError("Adiabatic calculation resulted in division by zero.")
    
    numerator = (P_tanks ** (1.0 / gamma)) * total_tank_volume / (R * T0)
    return numerator / denominator


def _calculate_tank_geometry(gas_mass: float, params: Dict) -> Tuple[float, float, float, float]:
    """Calculate tank volume, radius, and wall thickness."""
    R = params["R_gas_const"]
    T0 = params["T0"]
    P_tanks = params["P_tank"]
    P0 = params["P0"]
    SF = params.get("SF", 1.0)
    sigma_yield = params.get("sigma_y", 0.0)
    uts = params.get("UTS", 0.0)
    sf_uts = params.get("SF_UTS", 0.0)
    rho_tank = params["rho_material"]
    
    # Gas volume at storage conditions (ideal gas law)
    # Use storage pressure P0 as requested (Vg = m_g * R * T0 / P0)
    gas_volume = gas_mass * R * T0 / P0
    
    # Spherical tank radius (Eq 6-8)
    tank_radius = (3.0 * gas_volume / (4.0 * math.pi)) ** (1.0 / 3.0)

    # Allowed stress preference: UTS/SF_UTS if provided; else fallback to sigma_y/SF
    if uts > 0 and sf_uts > 0:
        s_allowed = uts / sf_uts
        # Use storage pressure P0 per requirement
        wall_thickness = P0 * tank_radius / (2.0 * s_allowed)
    else:
        if sigma_yield <= 0 or SF <= 0:
            raise PressurantCalculationError("Insufficient strength parameters for wall thickness calculation.")
        s_allowed = sigma_yield / SF
        wall_thickness = P_tanks * tank_radius / (2.0 * s_allowed)
    
    # Tank mass (Eq 6-11)
    tank_mass = 4.0 * math.pi * rho_tank * tank_radius ** 2 * wall_thickness
    
    return gas_volume, tank_radius, wall_thickness, tank_mass


def pressurant_system_mass(params: Dict) -> Tuple[float, float, float, float, float]:
    """
    Calculate pressurant gas and tank masses using specified thermodynamic model.

    Args:
        params: Dictionary containing calculation parameters:
            - V_ox: Oxidizer tank volume (m³)
            - V_fu: Fuel tank volume (m³)
            - P_tank: Tank operating pressure (Pa)
            - P0: Initial storage pressure (Pa)
            - T0: Storage temperature (K)
            - R_gas_const: Gas constant (J/kg·K)
            - gamma: Specific heat ratio (dimensionless)
            - rho_material: Tank material density (kg/m³)
            - sigma_y: Material yield strength (Pa)
            - SF: Safety factor (dimensionless)
            - model_text: Thermodynamic model ("Isothermal", "Energy", or "Adiabatic")

    Returns:
        Tuple containing:
            - gas_mass: Mass of pressurant gas (kg)
            - tank_mass: Mass of pressurant tank (kg)
            - gas_volume: Volume of gas at storage conditions (m³)
            - tank_radius: Radius of spherical tank (m)
            - wall_thickness: Tank wall thickness (m)

    Raises:
        ValueError: If required parameters are missing
        PressurantCalculationError: If calculation constraints are violated
    """
    _validate_parameters(params)
    
    # Calculate total propellant tank volume
    total_tank_volume = params["V_ox"] + params["V_fu"]
    model = params["model_text"]
    
    # Calculate gas mass based on selected model
    if model == "Isothermal":
        gas_mass = _calculate_isothermal_mass(params, total_tank_volume)
    elif model == "Energy":
        gas_mass = _calculate_energy_mass(params, total_tank_volume)
    else:  # Default to adiabatic model
        gas_mass = _calculate_adiabatic_mass(params, total_tank_volume)
    
    # Calculate tank geometry and mass
    gas_volume, tank_radius, wall_thickness, tank_mass = _calculate_tank_geometry(gas_mass, params)
    
    return gas_mass, tank_mass, gas_volume, tank_radius, wall_thickness
