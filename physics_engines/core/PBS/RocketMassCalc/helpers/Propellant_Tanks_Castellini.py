# helpers/Propellant_Tanks_Castellini.py

import numpy as np
import pandas as pd
from dataclasses import dataclass
from typing import List, Dict, Tuple, Optional
import warnings


@dataclass
class TankParameters:
    """Container for tank design parameters"""
    type: str
    SM: str
    TT: str
    tank_shape: str  # 'Ellipsoidal', 'Sphero-cylinder', 'Torispherical', or 'Manual'
    R: float  # internal_radius
    r_crown: float  # reference radius (same as crown_radius for torispherical)
    L: float  # cylindrical_length
    rocket_length: float
    rocket_diameter: float
    ssm: float
    max_q: float
    max_g: float
    n_ax_max: float
    n_ax_max_pl: float
    p_cc: float
    feed_type: str
    manual_volume: Optional[float] = None  # optional, used if tank_shape is 'Manual'


class TankCalculator:
    """Handles all tank-related calculations"""

    def __init__(self, params: TankParameters):
        self.params = params
        self.k_factors = self._calculate_k_factors()

    @staticmethod
    def sm_values() -> Dict[str, float]:
        """Structural material coefficients"""
        return {
            'Aluminum Alloy': 1.0,
            'Al-Li Alloy': 0.9,
            'Composite Wings': 0.8,
            'Composite Tanks': 0.75,
            'Composite Interstage': 0.7
        }

    def calculate_volume(self) -> float:
        """Calculate tank volume based on shape or manual input"""
        R, L = self.params.R, self.params.L
        shape = self.params.tank_shape.lower()

        if shape == 'ellipsoidal':
            # The volume of a tank with two semi-ellipsoidal heads.
            # V_total = V_cylinder + V_two_heads
            # V_two_heads = 2 * ( (2/3) * pi * R^2 * h ) = (4/3) * pi * R^2 * h
            h = 0.3 * 2 * R  # h = 0.6 * R
            # The original formula "2 * 4 / 3 * ..." was a typo and has been corrected.
            return (4 / 3) * np.pi * R ** 2 * h + np.pi * R ** 2 * L
        elif shape == 'sphero-cylinder':
            # Volume of a cylinder (pi*R^2*L) + volume of a sphere (4/3*pi*R^3)
            return 4 / 3 * np.pi * R ** 3 + np.pi * R ** 2 * L
        elif shape == 'torispherical':
            h = 0.3 * 2 * R
            return np.pi * R ** 2 * L + 2 * (np.pi / 3) * (3 * R - h) * h ** 2
        elif shape == 'manual':
            if self.params.manual_volume is None:
                raise ValueError("Manual volume must be provided when tank_shape is 'Manual'.")
            return self.params.manual_volume
        else:
            raise ValueError(f"Unknown tank shape '{self.params.tank_shape}'")

    def calculate_dome_surface(self) -> float:
        """
        Calculate dome surface area based on the selected tank shape.
        This function is correlated with the geometric assumptions implied by the calculate_volume function.
        """
        shape = self.params.tank_shape.lower()
        R = self.params.R  # Tank's internal radius

        if shape == 'manual' or R == 0:
            return 0.0

        if shape == 'sphero-cylinder':
            # The dome of a sphero-cylinder is a hemisphere.
            # The surface area of one hemispherical dome is 2*pi*R^2.
            return 2 * np.pi * R ** 2

        elif shape == 'ellipsoidal':
            # This function calculates the surface area of a standard semi-ellipsoid head.
            # The corresponding calculate_volume function has been corrected to use the standard
            # volume for this geometry, ensuring correlation.
            h = 0.6 * R

            if h >= R:
                warnings.warn(f"Ellipsoidal head height h={h:.2f} is >= Radius R={R:.2f}. Treating as hemisphere.")
                return 2 * np.pi * R ** 2

            e_squared = 1 - (h / R) ** 2
            if e_squared <= 1e-9:  # Effectively a hemisphere
                return 2 * np.pi * R ** 2
            e = np.sqrt(e_squared)

            area = np.pi * R ** 2 + (np.pi * h ** 2 / e) * np.arctanh(e)
            return area

        elif shape == 'torispherical':
            # The calculate_volume function uses the formula for a spherical cap,
            # but assumes the sphere's radius (R_sphere) is equal to the tank's radius (R).
            h = 0.6 * R
            # To ensure strict correlation, we use the same assumption for surface area.
            # The surface area of a spherical cap is A = 2 * pi * R_sphere * h.
            area = 2 * np.pi * R * h
            return area

        else:
            raise ValueError(f"Unknown tank shape '{self.params.tank_shape}' for dome surface calculation.")

    def _calculate_k_factors(self) -> List[float]:
        """Calculate all k factors"""
        try:
            k1 = self.sm_values()[self.params.SM]
        except KeyError:
            raise ValueError(f"Unknown structural material '{self.params.SM}'")

        if self.params.R == 0 and self.params.tank_shape.lower() != 'manual':
            S_Dome = 0
            S_cylinder = 0
        elif self.params.L == 0 and self.params.R == 0 and self.params.tank_shape.lower() != 'manual':
            S_Dome = 0
            S_cylinder = 0
        else:
            S_Dome = self.calculate_dome_surface()
            S_cylinder = 2 * np.pi * self.params.R * self.params.L

        if self.params.TT == 'Separate Tanks':
            k2 = 1.0
        else:
            S_Total = 2 * S_Dome + S_cylinder
            if S_Total == 0:
                k2 = 1.0
            else:
                k2 = (S_Total - 1.5 * S_Dome) / S_Total

        if self.params.rocket_diameter == 0:
            raise ValueError("Rocket diameter cannot be zero for k3 calculation.")
        k3 = (1 / 30) * (self.params.rocket_length / self.params.rocket_diameter) + 29 / 30

        k4_ref = -1.964286e-11 * self.params.max_q ** 2 + 5.046429e-6 * self.params.max_q + 0.775929
        if k4_ref == 0:
            raise ValueError("k4_ref is zero, division by zero in k4 calculation.")
        k4 = self.params.max_q ** 0.16 / k4_ref

        SSM = self.params.ssm
        k5_ref = -0.001488 * self.params.max_g ** 2 + 0.04565 * self.params.max_g + 0.7886
        if k5_ref == 0:
            raise ValueError("k5_ref is zero, division by zero in k5 calculation.")
        k5 = ((SSM * min(self.params.n_ax_max, self.params.n_ax_max_pl)) ** 0.15) / k5_ref

        k6 = self.calculate_k6()

        return [float(val) for val in [k1, k2, k3, k4, k5, k6]]

    def calculate_k6(self) -> float:
        """Calculate k6 based on feed type and chamber pressure"""
        feed_systems = {
            'Pressure-fed': {'p_cc_range': (6.8, 15.6), 'p_tank_range': (13.0, 30.0)},
            'Gas generator': {'p_cc_range': (30.0, 120.0), 'p_tank_range': (2.0, 3.3)},
            'Expander cycle': {'p_cc_range': (30.0, 70.0), 'p_tank_range': (2.0, 3.4)},
            'Staged combustion': {'p_cc_range': (80.0, 270.0), 'p_tank_range': (2.0, 3.4)}
        }

        p_cc_bars = self.params.p_cc / 1e5

        if self.params.feed_type not in feed_systems:
            raise ValueError(f"Unknown feed type: {self.params.feed_type}. Available: {list(feed_systems.keys())}")

        system = feed_systems[self.params.feed_type]
        p_cc_min, p_cc_max = system['p_cc_range']
        p_tank_min, p_tank_max = system['p_tank_range']

        if not (p_cc_min <= p_cc_bars <= p_cc_max):
            warnings.warn(
                f"Chamber pressure {p_cc_bars:.2f} bar is out of typical range ({p_cc_min}-{p_cc_max} bar) for {self.params.feed_type}. Clamping to range for calculation.")
            p_cc_bars = np.clip(p_cc_bars, p_cc_min, p_cc_max)

        if (p_cc_max - p_cc_min) == 0:
            factor = 0.5
        else:
            factor = (p_cc_bars - p_cc_min) / (p_cc_max - p_cc_min)

        p_tank_bars = p_tank_min + factor * (p_tank_max - p_tank_min)
        # p_tank = p_tank_bars * 1e5

        k6_denominator = 2.7862
        if k6_denominator == 0:
            raise ValueError("k6 denominator is zero, division by zero in k6 calculation.")

        return (1.3012 + 1.4359 * 10 ** (-6) * p_tank_bars) / k6_denominator

    def calculate_mass(self) -> float:
        """Calculate tank mass based on type"""
        V = self.calculate_volume()
        prod_k = np.prod(self.k_factors)

        if self.params.type == 'Fuel':
            return prod_k * ((35.315 * V) * 0.4856 + 800) * 0.4536
        else:  # Oxidizer
            return prod_k * ((35.315 * V) ** 1.04 * 1.085 + 700) * 0.4536


if __name__ == "__main__":
    # ... I have also updated the test case below to use 'Sphero-cylinder' ...
    tank_params_ox = TankParameters(
        type='Oxidizer', SM='Aluminum Alloy', TT='Separate Tanks',
        tank_shape='Sphero-cylinder', R=0.8, r_crown=0.8, L=1.5,
        rocket_length=15, rocket_diameter=1.2, ssm=1.25, max_q=30000,
        max_g=5,
        n_ax_max=5.0, n_ax_max_pl=5.0,
        p_cc=50e5, feed_type='Gas generator', manual_volume=None
    )
    calculator_ox = TankCalculator(tank_params_ox)
    mass_ox = calculator_ox.calculate_mass()
    volume_ox = calculator_ox.calculate_volume()
    print(f"Oxidizer Tank K factors: {[f'{k:.4f}' for k in calculator_ox.k_factors]}")
    print(f"Oxidizer Tank Volume: {volume_ox:.2f} m³")
    print(f"Oxidizer Tank Mass: {mass_ox:.2f} kg")
    print("-" * 50)