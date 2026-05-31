"""
Rocket engine mass estimation module.

This module provides functions for calculating rocket engine mass using various
empirical models and correlations from different sources in the literature.
"""

import numpy as np
from typing import Union


# Engine mass estimation model coefficients
ENGINE_MASS_MODELS = {
    'our_flow': {'coeff': 16.469, 'exponent': 0.7992, 'equation': '5-1'},
    'our_thrust': {'coeff': 6.1564, 'exponent': 0.7895, 'equation': '5-2'},
    'zandbergen_lo': {'coeff': 0.00514, 'exponent': 0.92068, 'equation': '5-3'},
    'mchugh': {'coeff': 2.2890, 'exponent': 0.89255, 'equation': '5-6'},
}


def _validate_engine_parameters(method: str, value: float, num_engines: int) -> None:
    """Validate input parameters for engine mass calculations."""
    if value <= 0:
        raise ValueError("Thrust or mass flow rate must be positive.")
    if num_engines <= 0:
        raise ValueError("Number of engines must be positive.")
    if not isinstance(method, str):
        raise ValueError("Method must be a string.")


def _calculate_power_law_mass(coefficient: float, value: float, exponent: float, 
                             scale_factor: float = 1.0) -> float:
    """Calculate mass using power law relationship: mass = coeff * (scale * value)^exp."""
    return coefficient * (scale_factor * value) ** exponent


def _calculate_linear_mass(slope: float, value: float, intercept: float,
                          scale_factor: float = 1.0) -> float:
    """Calculate mass using linear relationship: mass = slope * (scale * value) + intercept."""
    return slope * (scale_factor * value) + intercept


def _calculate_humble_mass(thrust_kN: float) -> float:
    """Calculate engine mass using Humble's correlation (Eq. 5-5)."""
    thrust_N = 1000 * thrust_kN
    denominator = 25.2 * np.log10(thrust_N) - 80.7
    if denominator <= 0:
        raise ValueError("Humble's correlation invalid for this thrust range.")
    return thrust_N / (9.80665 * denominator)


def _calculate_castellini_storables_conservative(thrust_kN: float, num_engines: int) -> float:
    """Calculate engine mass using Castellini's conservative storables model (Eq. 5-11)."""
    total_thrust_N = 1000 * thrust_kN * num_engines
    
    # Calculate denominator with minimum bounds
    log_term = 26.04 * np.log(total_thrust_N) - 207
    denominator = max(104.4, max(20.3, log_term))
    
    mass_lbm = total_thrust_N / denominator
    return mass_lbm * 0.453592  # Convert lbm to kg


def estimate_engine_mass(method: str, value: float, num_engines: int = 1) -> float:
    """
    Estimate rocket engine mass using specified empirical correlation.

    Args:
        method: Mass estimation method. Supported methods:
            - 'our_flow': Based on mass flow rate (kg/s)
            - 'our_thrust': Based on thrust (kN) 
            - 'zandbergen_lo': Zandbergen low-thrust correlation (kN)
            - 'zandbergen_hi': Zandbergen high-thrust linear correlation (kN)
            - 'humble': Humble's correlation (kN)
            - 'mchugh': McHugh correlation (kN)
            - 'castellini_storables_med': Castellini storable propellants (kN)
            - 'castellini_cryostorables_low': Castellini cryogenic/storables (kN)
            - 'castellini_staged_combustion_mid': Castellini staged combustion (kN)
            - 'castellini_gg_cycle_full': Castellini gas generator cycle (kN)
            - 'castellini_storables_conserv': Castellini conservative estimate (kN)
        value: Thrust in kN or mass flow rate in kg/s (depending on method)
        num_engines: Number of engines (used for some methods)

    Returns:
        Estimated engine mass in kg

    Raises:
        ValueError: If method is unsupported or parameters are invalid
    """
    _validate_engine_parameters(method, value, num_engines)

    # Power law models (most common)
    if method in ENGINE_MASS_MODELS:
        model = ENGINE_MASS_MODELS[method]
        scale = 1000 if method.startswith('zandbergen') else 1
        return _calculate_power_law_mass(model['coeff'], value, model['exponent'], scale)

    # Linear models
    elif method == 'zandbergen_hi':  # Eq. 5-4
        return _calculate_linear_mass(0.001104, value, 27.702, 1000)

    # Special correlations
    elif method == 'humble':  # Eq. 5-5
        return _calculate_humble_mass(value)

    # Castellini quadratic models
    elif method == 'castellini_storables_med':  # Eq. 5-7
        thrust_N = 1000 * value
        return -3.36532e-08 * thrust_N**2 + 4.74402e-03 * thrust_N - 1.93920e+01

    elif method == 'castellini_cryostorables_low':  # Eq. 5-8 (0–400 kN)
        thrust_N = 1000 * value
        return -2.13325e-09 * thrust_N**2 + 1.70870e-03 * thrust_N + 6.38629e+00

    # Castellini power models with offset
    elif method == 'castellini_staged_combustion_mid':  # Eq. 5-9 (0–5000 kN)
        thrust_N = 1000 * value
        return 4.74445e-01 * thrust_N**5.35755e-01 - 7.73681e+00

    elif method == 'castellini_gg_cycle_full':  # Eq. 5-10 (0–3000 kN)
        thrust_N = 1000 * value
        return 6.37913e+00 * thrust_N**3.53665e-01 - 1.48832e+02

    elif method == 'castellini_storables_conserv':  # Eq. 5-11
        return _calculate_castellini_storables_conservative(value, num_engines)

    else:
        raise ValueError(f"Unsupported method: '{method}'. See docstring for valid options.")


def calculate_contraction_ratio(characteristic_length: float, throat_area: float, 
                              chamber_length: float) -> tuple[float, float, float]:
    """
    Calculate combustion chamber contraction ratio and geometry.

    Args:
        characteristic_length: L* characteristic length (m)
        throat_area: Throat area At (m²)
        chamber_length: Chamber length Lc (m)

    Returns:
        Tuple containing:
            - contraction_ratio: Ac/At ratio (dimensionless)
            - chamber_area: Chamber cross-sectional area Ac (m²)
            - chamber_volume: Chamber volume Vc (m³)
    """
    chamber_volume = characteristic_length * throat_area
    chamber_area = chamber_volume / chamber_length
    contraction_ratio = chamber_area / throat_area
    
    return contraction_ratio, chamber_area, chamber_volume


def calculate_expansion_ratio(exit_area: float, throat_area: float) -> float:
    """
    Calculate nozzle area expansion ratio.

    Args:
        exit_area: Nozzle exit area Ae (m²)
        throat_area: Nozzle throat area At (m²)

    Returns:
        Expansion ratio Ae/At (dimensionless)
    """
    if throat_area <= 0:
        raise ValueError("Throat area must be positive.")
    return exit_area / throat_area

# Example usage - only executed when script is run directly
if __name__ == "__main__":
    # Example parameters
    L_star = 1.5
    At = 0.00458
    Ae = 0.091598
    L_chamber = 0.2

    exp_ratio = calculate_expansion_ratio(Ae, At)
    contr_ratio, Ac, Vc = calculate_contraction_ratio(L_star, At, L_chamber)

    print("Expansion ratio:", exp_ratio)
    print("Contraction ratio:", contr_ratio)
    print("Chamber area:", Ac)
    print("Chamber volume:", Vc)

