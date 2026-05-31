"""
Thrust Vector Control (TVC) mass estimation functions.

This module provides functions for calculating TVC system mass using different
empirical models (Castellini, Rohrschneider, and Akin).
"""

# TVC system coefficients: (a, b) where mass = a * thrust + b
TVC_COEFFICIENTS = {
    1: (0.1976, 20.922),  # hydraulic system
    2: (0.1078, 43.702),  # electro-mechanical system
}

# Unit conversion constants
LBF_TO_KN = 0.00444822
LBF_TO_KG = 0.453592


def calculate_tvc_mass_castellini(
    thrust_kN, num_engines, tvc_type=2, max_deflection_angle=6
):
    """
    Calculate TVC mass using Castellini's empirical model.

    Args:
        thrust_kN (float): Engine thrust in kilonewtons
        num_engines (int): Number of engines (parameter kept for interface consistency)
        tvc_type (int): TVC system type (1=hydraulic, 2=electro-mechanical)
        max_deflection_angle (float): Maximum deflection angle in degrees

    Returns:
        float: Total TVC system mass in kg

    Reference: Equation 5-15 from source documentation
    """
    if tvc_type not in TVC_COEFFICIENTS:
        raise ValueError(f"Invalid TVC type: {tvc_type}. Must be 1 or 2.")

    coefficient_a, coefficient_b = TVC_COEFFICIENTS[tvc_type]
    reference_mass = coefficient_a * thrust_kN + coefficient_b

    # Deflection angle correction factor (Eq 5-15)
    deflection_factor = 1.0 + (max_deflection_angle - 6.0) / 30.0

    return reference_mass * deflection_factor


def calculate_tvc_mass_rohrschneider(thrust_kN, num_engines):
    """
    Calculate TVC mass using Rohrschneider's empirical model.

    Args:
        thrust_kN (float): Engine thrust in kilonewtons
        num_engines (int): Number of engines in the stage

    Returns:
        float: Total TVC system mass in kg
    """
    thrust_lbf = thrust_kN / LBF_TO_KN
    mass_lbf = 0.001185 * thrust_lbf * num_engines
    return mass_lbf * LBF_TO_KG


def calculate_tvc_mass_akin(total_thrust_kN: float, chamber_pressure_pa: float, num_engines: int) -> float:
    """
    Calculate TVC mass using the Akin model.

    Args:
        total_thrust_kN (float): Total stage thrust in kilonewtons.
        chamber_pressure_pa (float): Desired chamber pressure in pascals.
        num_engines (int): Number of engines.

    Returns:
        float: Total TVC system dry mass in kg.

    Formula (provided):
        m_tvc = N_eng * 237.8 * (Total_thrust / N_eng / P_c)^0.9375

    Notes:
        - Converts kN to N internally for consistency with SI.
        - Validates positive inputs to avoid domain errors.
    """
    if num_engines <= 0:
        raise ValueError("Number of engines must be positive for Akin model.")
    if total_thrust_kN <= 0:
        raise ValueError("Total thrust (kN) must be positive for Akin model.")
    if chamber_pressure_pa <= 0:
        raise ValueError("Chamber pressure (Pa) must be positive for Akin model.")

    total_thrust_N = total_thrust_kN * 1_000.0
    ratio = (total_thrust_N / num_engines) / chamber_pressure_pa
    # Guard against any numerical issues
    if ratio <= 0:
        return 0.0
    return num_engines * 237.8 * (ratio ** 0.9375)


# Legacy function aliases for backward compatibility
def tvc_mass_castellini(thrust_kN, N_eng, tvc_type=2, delta_max=6):
    """Legacy function name - use calculate_tvc_mass_castellini instead."""
    return calculate_tvc_mass_castellini(thrust_kN, N_eng, tvc_type, delta_max)


def tvc_mass_rohrschneider(thrust_kN, N_eng):
    """Legacy function name - use calculate_tvc_mass_rohrschneider instead."""
    return calculate_tvc_mass_rohrschneider(thrust_kN, N_eng)


def tvc_mass_akin(total_thrust_kN, chamber_pressure_pa, N_eng):
    """Legacy function name - use calculate_tvc_mass_akin instead."""
    return calculate_tvc_mass_akin(total_thrust_kN, chamber_pressure_pa, N_eng)
