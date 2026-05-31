# Propellant_Tanks_Standard.py

import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Union

# ---------------------------
# Tank Parameter Definitions
# ---------------------------


@dataclass
class TankParameters:
    cylindrical_length: float  # m
    ullage: float  # Fractional ullage (0 <= ullage < 1)
    pressure: float  # Pa
    material_density: float  # kg/m^3
    stress: float  # Pa
    efficiency: float  # (0 < efficiency <= 1)
    diameter: float  # m
    propellant_density: float  # kg/m^3
    propellant_mass: float  # kg

    @property
    def internal_radius(self):
        return self.diameter / 2

    def __post_init__(self):
        if not (0 <= self.ullage < 1):
            raise ValueError(
                "Ullage must be a fraction between 0 (inclusive) and 1 (exclusive)."
            )
        if not (0 < self.efficiency <= 1):
            raise ValueError(
                "Joint efficiency must be between 0 (exclusive) and 1 (inclusive)."
            )


@dataclass
class EllipsoidalParameters(TankParameters):
    head_height: float  # m
    k_factor: Optional[float] = None  # optional, calculated if not provided


@dataclass
class TorisphericalParameters(TankParameters):
    crown_radius: float  # m
    knuckle_radius: float  # m
    m_factor: Optional[float] = None


@dataclass
class CommonBulkheadParameters(TankParameters):
    head_height: Optional[float] = None  # For ellipsoidal heads
    crown_radius: Optional[float] = None  # For torispherical heads
    knuckle_radius: Optional[float] = None  # For torispherical heads
    bulkhead_shell_fraction: float = (
        0.5  # Shell volume multiplier for internal head (0-1)
    )
    oxidizer_cyl_length: float = 1.0  # m (auto-calculated)
    fuel_cyl_length: float = 1.0  # m (auto-calculated)
    oxidizer_propellant_mass: float = 100.0  # kg (from O/F split)
    fuel_propellant_mass: float = 100.0  # kg (from O/F split)
    oxidizer_propellant_density: float = 1400.0  # kg/m³
    fuel_propellant_density: float = 800.0  # kg/m³
    head_type: str = "Spherical"  # "Spherical", "Ellipsoidal", "Torispherical"


@dataclass
class SphericalSeparatedParameters(TankParameters):
    """Parameters for two separate spherical tanks (oxidizer and fuel)."""

    oxidizer_propellant_mass: float  # kg - required, no default
    fuel_propellant_mass: float  # kg - required, no default
    oxidizer_propellant_density: float  # kg/m³ - required, no default
    fuel_propellant_density: float  # kg/m³ - required, no default

    def __post_init__(self):
        super().__post_init__()
        if self.oxidizer_propellant_mass <= 0:
            raise ValueError("Oxidizer propellant mass must be positive.")
        if self.fuel_propellant_mass <= 0:
            raise ValueError("Fuel propellant mass must be positive.")
        if self.oxidizer_propellant_density <= 0:
            raise ValueError("Oxidizer propellant density must be positive.")
        if self.fuel_propellant_density <= 0:
            raise ValueError("Fuel propellant density must be positive.")


# ----------------------
# Shape Factor Utilities
# ----------------------


class ShapeFactors:
    @staticmethod
    def k_factor(D: float, h: float) -> float:  # Eq. 7-12
        if h <= 0:
            raise ValueError("Head height must be positive.")
        return (1 / 6) * (2 + (D / (2 * h)) ** 2)

    @staticmethod
    def m_factor(L: float, r: float) -> float:  # Eq. 7-15
        if r <= 0 or L <= 0:
            raise ValueError("Radii must be positive.")
        return 0.25 * (3 + math.sqrt(L / r))

    @staticmethod
    def compute_L_from_D_h(D: float, h: float) -> float:
        if D <= 0 or h <= 0:
            raise ValueError("Both D and h must be positive numbers.")

        R = D / (2 * h)  # Ratio D / 2h

        if R >= 3:
            K1 = 1.36
        elif R >= 2.8:
            K1 = 1.27 + (1.36 - 1.27) * (R - 2.8) / (3 - 2.8)
        elif R >= 2.6:
            K1 = 1.18 + (1.27 - 1.18) * (R - 2.6) / (2.8 - 2.6)
        elif R >= 2.4:
            K1 = 1.08 + (1.18 - 1.08) * (R - 2.4) / (2.6 - 2.4)
        elif R >= 2.2:
            K1 = 0.99 + (1.08 - 0.99) * (R - 2.2) / (2.4 - 2.2)
        elif R >= 2.0:
            K1 = 0.90 + (0.99 - 0.90) * (R - 2.0) / (2.2 - 2.0)
        elif R >= 1.8:
            K1 = 0.81 + (0.90 - 0.81) * (R - 1.8) / (2.0 - 1.8)
        elif R >= 1.6:
            K1 = 0.73 + (0.81 - 0.73) * (R - 1.6) / (1.8 - 1.6)
        elif R >= 1.4:
            K1 = 0.65 + (0.73 - 0.65) * (R - 1.4) / (1.6 - 1.4)
        elif R >= 1.2:
            K1 = 0.57 + (0.65 - 0.57) * (R - 1.2) / (1.4 - 1.2)
        elif R >= 1.0:
            K1 = 0.50 + (0.57 - 0.50) * (R - 1.0) / (1.2 - 1.0)
        else:
            K1 = 0.50  # Constant below 1.0

        L = K1 * D
        return L


# ------------------------
# Head Thickness Functions
# ------------------------


class TankHeadThicknessCalculations:
    @staticmethod
    def spherical_head_thickness(P, R, S, E):  # Eq. 7-8
        denom = 2 * S * E - 0.2 * P
        if denom <= 0:
            raise ValueError("Invalid parameters for spherical shell thickness.")
        return P * R / denom

    @staticmethod
    def ellipsoidal_head_thickness(P, D, K, S, E):  # Eq. 7-9
        denom = 2 * S * E - 0.2 * P
        if denom <= 0:
            raise ValueError("Invalid parameters for ellipsoidal head thickness.")
        return (P * D * K) / denom

    @staticmethod
    def torispherical_head_thickness(P, L, M, S, E):  # Eq. 7-13
        denom = 2 * S * E - 0.2 * P
        if denom <= 0:
            raise ValueError("Invalid parameters for torispherical head thickness.")
        return (P * L * M) / denom

    @staticmethod
    def spherical_separated_thickness(P, R, S):
        """
        Simplified thickness calculation for spherical separated tanks.
        Formula: t = (P * R_tank) / (2 * allowed_stress)

        Args:
            P: Internal pressure (Pa)
            R: Tank radius (m)
            S: Allowable stress (Pa)

        Returns:
            Thickness (m)
        """
        if S <= 0:
            raise ValueError(
                "Allowable stress must be positive for spherical separated tanks."
            )
        return (P * R) / (2 * S)


# -------------------------
# Shell Thickness Functions
# -------------------------


class ShellThicknessCalculations:
    @staticmethod
    def cylindrical_circumferential_thickness(P, R, S, E):  # Eq. 7-16
        denom = S * E - 0.6 * P
        if denom <= 0:
            raise ValueError("Invalid parameters for circumferential shell thickness.")
        return P * R / denom

    @staticmethod
    def cylindrical_longitudinal_thickness(P, R, S, E):  # Eq. 7-17
        denom = 2 * S * E + 0.4 * P
        if denom <= 0:
            raise ValueError("Invalid parameters for longitudinal shell thickness.")
        return P * R / denom


# -----------------
# Volume Calculators
# -----------------


class VolumeCalculations:
    @staticmethod
    def calculate_spherocylinder_volume(params: TankParameters) -> Dict[str, float]:
        ri, L = params.internal_radius, params.cylindrical_length
        cylindrical_volume = math.pi * ri**2 * L
        head_volume = (4 / 3) * math.pi * ri**3  # Two hemispheres = one full sphere
        internal = cylindrical_volume + head_volume  # Eq. 7-1
        return {
            "internal_volume": internal,
            "effective_volume": internal * (1 - params.ullage),
            "cylindrical_volume": cylindrical_volume,
            "head_volume": head_volume,
        }

    @staticmethod
    def calculate_ellipsoidal_tank_volume(
        params: EllipsoidalParameters,
    ) -> Dict[str, float]:
        ri, L, h = params.internal_radius, params.cylindrical_length, params.head_height
        single_head_volume = (2 / 3) * math.pi * ri**2 * h  # Eq. 7-3 (one head)
        total_head_volume = 2 * single_head_volume  # Two heads
        cylindrical_volume = math.pi * ri**2 * L
        internal = cylindrical_volume + total_head_volume  # Eq 7-4
        return {
            "internal_volume": internal,
            "effective_volume": internal * (1 - params.ullage),
            "head_volume": total_head_volume,
            "cylindrical_volume": cylindrical_volume,
        }

    @staticmethod
    def calculate_torispherical_tank_volume(
        params: TorisphericalParameters,
    ) -> Dict[str, float]:
        D = params.diameter
        R = params.crown_radius
        a = params.knuckle_radius
        L = params.cylindrical_length

        # Calculate head height using derived formula
        # Ensure argument of sqrt is non-negative
        sqrt_arg = (R - a) ** 2 - ((D / 2) - a) ** 2
        if sqrt_arg < 0:
            raise ValueError(
                f"Invalid geometry for torispherical head height calculation: (R-a)^2 < ((D/2)-a)^2. R={R}, a={a}, D/2={D / 2}"
            )
        h = R - math.sqrt(sqrt_arg)
        c = math.sqrt(
            (R - a) ** 2 - (R - h) ** 2
        )  # c is (D/2 - a) if derived correctly

        asin_arg = (R - h) / (R - a)
        if not -1 <= asin_arg <= 1:
            # This check might be redundant if h is derived correctly and R > a
            raise ValueError(
                f"Invalid asin argument: {asin_arg}. Check crown, knuckle, and derived head height. R={R}, a={a}, h={h}"
            )
        head_volume = (math.pi / 3) * (
            2 * h * R**2
            - (2 * a**2 + c**2 + 2 * a * R) * (R - h)
            + 3 * a**2 * c * math.asin(asin_arg)
        )  # Eq. 7-6

        cylindrical_volume = math.pi * (D / 2) ** 2 * L
        total_head_volume = 2 * head_volume
        total_internal_volume = (
            total_head_volume + cylindrical_volume
        )  # Based on Eq. 7-6
        effective_volume = total_internal_volume * (1 - params.ullage)

        return {
            "internal_volume": total_internal_volume,
            "effective_volume": effective_volume,
            "head_volume": total_head_volume,
            "cylindrical_volume": cylindrical_volume,
            "head_height": h,
        }

    @staticmethod
    def calculate_common_bulkhead_volume(
        params: CommonBulkheadParameters,
    ) -> Dict[str, float]:
        ri = params.internal_radius

        # Calculate single head volume based on head type
        if params.head_type == "Ellipsoidal" and params.head_height:
            single_head_vol = (2 / 3) * math.pi * ri**2 * params.head_height
        elif (
            params.head_type == "Torispherical"
            and params.crown_radius
            and params.knuckle_radius
        ):
            # Use torispherical calculation - create dummy params for calculation
            dummy_params = TorisphericalParameters(
                cylindrical_length=0,
                ullage=0,
                pressure=0,
                material_density=0,
                stress=0,
                efficiency=1.0,
                diameter=params.diameter,
                propellant_density=0,
                propellant_mass=0,
                crown_radius=params.crown_radius,
                knuckle_radius=params.knuckle_radius,
            )
            single_head_vol = VolumeCalculations.calculate_torispherical_tank_volume(
                dummy_params
            )["head_volume"]
        else:  # Spherical (default)
            single_head_vol = (2 / 3) * math.pi * ri**3

        # Internal bulkhead volume (always full-sized head - no fraction needed)
        internal_head_vol = single_head_vol

        # Required total internal volumes accounting for ullage
        ox_required_vol = params.oxidizer_propellant_mass / (
            params.oxidizer_propellant_density * (1 - params.ullage)
        )
        fuel_required_vol = params.fuel_propellant_mass / (
            params.fuel_propellant_density * (1 - params.ullage)
        )

        # Calculate lengths to satisfy volume requirements
        cyl_base_area = math.pi * ri**2

        # Oxidizer: Standard tank (cylindrical + 2 heads)
        L_ox_calculated = (
            (ox_required_vol - 2 * single_head_vol) / cyl_base_area
            if cyl_base_area > 0
            else 0
        )
        # Fuel: Cylindrical only (heads cancel out)
        L_fuel_calculated = (
            fuel_required_vol / cyl_base_area if cyl_base_area > 0 else 0
        )

        # Actual volumes with calculated lengths
        ox_vol = (cyl_base_area * L_ox_calculated) + (2 * single_head_vol)
        fuel_vol = cyl_base_area * L_fuel_calculated

        total_internal = ox_vol + fuel_vol
        # Effective volume is the propellant volume (total internal minus ullage space)
        effective_vol = (
            params.oxidizer_propellant_mass / params.oxidizer_propellant_density
            + params.fuel_propellant_mass / params.fuel_propellant_density
        )

        return {
            "oxidizer_volume": ox_vol,
            "fuel_volume": fuel_vol,
            "internal_head_volume": internal_head_vol,
            "single_head_volume": single_head_vol,
            "external_head_volume": single_head_vol,  # External head volume (same as single head)
            "oxidizer_cylindrical_volume": cyl_base_area
            * L_ox_calculated,  # Oxidizer cylindrical part volume
            "fuel_cylindrical_volume": cyl_base_area
            * L_fuel_calculated,  # Fuel cylindrical part volume
            "oxidizer_cyl_length_calculated": L_ox_calculated,
            "fuel_cyl_length_calculated": L_fuel_calculated,
            "internal_volume": total_internal,
            "effective_volume": effective_vol,
        }

    @staticmethod
    def calculate_spherical_separated_volume(
        params: SphericalSeparatedParameters,
    ) -> Dict[str, float]:
        """Calculate volumes for two separate spherical tanks (oxidizer and fuel)."""
        # Required volumes accounting for ullage
        ox_required_vol = params.oxidizer_propellant_mass / (
            params.oxidizer_propellant_density * (1 - params.ullage)
        )
        fuel_required_vol = params.fuel_propellant_mass / (
            params.fuel_propellant_density * (1 - params.ullage)
        )

        # Calculate internal radii using V = (4/3)πr³ → r = (3V/4π)^(1/3)
        ox_internal_radius = ((3 * ox_required_vol) / (4 * math.pi)) ** (1 / 3)
        fuel_internal_radius = ((3 * fuel_required_vol) / (4 * math.pi)) ** (1 / 3)

        # Internal volumes (should equal required volumes)
        ox_internal_vol = (4 / 3) * math.pi * ox_internal_radius**3
        fuel_internal_vol = (4 / 3) * math.pi * fuel_internal_radius**3

        # Total internal volume
        total_internal = ox_internal_vol + fuel_internal_vol

        # Effective volume is the propellant volume
        effective_vol = (
            params.oxidizer_propellant_mass / params.oxidizer_propellant_density
            + params.fuel_propellant_mass / params.fuel_propellant_density
        )

        return {
            "oxidizer_volume": ox_internal_vol,
            "fuel_volume": fuel_internal_vol,
            "oxidizer_internal_radius": ox_internal_radius,
            "fuel_internal_radius": fuel_internal_radius,
            "internal_volume": total_internal,
            "effective_volume": effective_vol,
        }


# ----------------
# Mass Calculations
# ----------------


class TankMassCalculations:
    @staticmethod
    def shell_mass(volume: float, density: float) -> float:
        return volume * density


# --------------------------
# Parameter Validation Helper
# --------------------------


def validate_and_prepare_parameters(
    params: Union[
        TankParameters,
        EllipsoidalParameters,
        TorisphericalParameters,
        CommonBulkheadParameters,
        SphericalSeparatedParameters,
    ],
):
    params.__post_init__()  # Call common validations
    if isinstance(params, EllipsoidalParameters):
        if params.head_height <= 0:
            raise ValueError("Ellipsoidal head height must be positive.")
        if params.k_factor is None:
            params.k_factor = ShapeFactors.k_factor(params.diameter, params.head_height)
    if isinstance(params, TorisphericalParameters):
        if params.diameter / 2 < params.knuckle_radius:
            raise ValueError("Diameter/2 must be >= knuckle radius.")
        if params.crown_radius < params.knuckle_radius:
            raise ValueError("Crown radius must be >= knuckle radius.")
        if (
            params.crown_radius <= params.diameter / 2
        ):  # L must be > D/2 for a standard torisphere
            # or more precisely, R (crown_radius) should be > D/2 - knuckle_radius for the knuckle to exist.
            # A common rule is L (crown_radius) <= D (diameter)
            pass  # This might need more nuanced validation depending on torispherical type
        if params.knuckle_radius <= 0:
            raise ValueError("Knuckle radius must be positive.")
        if params.m_factor is None:
            params.m_factor = ShapeFactors.m_factor(
                params.crown_radius, params.knuckle_radius
            )
    if isinstance(params, CommonBulkheadParameters):
        if not (0 <= params.bulkhead_shell_fraction <= 1):
            raise ValueError("Bulkhead shell fraction must be between 0 and 1.")
        if (
            params.head_type == "Ellipsoidal"
            and params.head_height
            and params.head_height <= 0
        ):
            raise ValueError(
                "Ellipsoidal head height must be positive for Common Bulkhead."
            )
        if params.head_type == "Torispherical":
            if params.crown_radius and params.crown_radius <= 0:
                raise ValueError(
                    "Crown radius must be positive for Torispherical Common Bulkhead."
                )
            if params.knuckle_radius and params.knuckle_radius <= 0:
                raise ValueError(
                    "Knuckle radius must be positive for Torispherical Common Bulkhead."
                )
            if (
                params.crown_radius
                and params.knuckle_radius
                and params.crown_radius < params.knuckle_radius
            ):
                raise ValueError(
                    "Crown radius must be >= knuckle radius for Torispherical Common Bulkhead."
                )
        if params.oxidizer_propellant_mass <= 0:
            raise ValueError("Oxidizer propellant mass must be positive.")
        if params.fuel_propellant_mass <= 0:
            raise ValueError("Fuel propellant mass must be positive.")
        if params.oxidizer_propellant_density <= 0:
            raise ValueError("Oxidizer propellant density must be positive.")
        if params.fuel_propellant_density <= 0:
            raise ValueError("Fuel propellant density must be positive.")
    return params


# ---------------------
# Calculate Shell Volume
# ---------------------
def calculate_shell_volume_with_breakdown(
    p: Union[
        TankParameters,
        EllipsoidalParameters,
        TorisphericalParameters,
        CommonBulkheadParameters,
    ],
    t_max: float,
) -> Dict[str, float]:
    """Calculate shell volume with detailed component breakdown."""
    ri = p.diameter / 2
    ro_cyl = ri + t_max  # Outer radius for cylindrical part using maximum thickness
    cyl_length = p.cylindrical_length

    # Volume of cylindrical shell
    V_cyl_shell = math.pi * (ro_cyl**2 - ri**2) * cyl_length if cyl_length > 0 else 0

    if isinstance(p, EllipsoidalParameters):
        # Volume of one ellipsoidal head (approximate outer - inner)
        h_inner = p.head_height
        # Approximate outer dimensions by adding thickness (simplification)
        # A more accurate method would be to calculate the volume of an ellipsoid with (ri+t_head, h+t_head) axes
        # This approximation assumes the shape remains ellipsoidal with increased semi-axes
        V_head_inner_one = (
            (2 / 3) * math.pi * ri**2 * h_inner
        )  # Based on Eq. 7-3 for one head

        # Approximate outer head geometry using maximum thickness
        # This is a simplification; true outer surface of an offset ellipsoid is complex
        ri_outer_head = ri + t_max
        h_outer_head = h_inner + t_max
        V_head_outer_one = (2 / 3) * math.pi * ri_outer_head**2 * h_outer_head

        V_head_shell_one = V_head_outer_one - V_head_inner_one
        return {
            "cylindrical_shell_volume": V_cyl_shell,
            "head_shell_volume": 2 * V_head_shell_one,
            "total_shell_volume": V_cyl_shell + 2 * V_head_shell_one,
        }

    elif isinstance(p, TorisphericalParameters):
        from copy import deepcopy  # Keep import local if only used here

        # Calculate inner head volume using the established method
        volumes_inner = VolumeCalculations.calculate_torispherical_tank_volume(p)
        head_inner_one = volumes_inner["head_volume"]  # This is for one head

        # Construct outer geometry by adding maximum thickness to radii
        # This is an approximation. The true offset surface of a torisphere is complex.
        p_outer = deepcopy(p)
        p_outer.diameter += 2 * t_max
        # For torispherical heads, adding maximum thickness to crown and knuckle radii
        # is a common simplification for shell volume.
        p_outer.crown_radius += t_max
        p_outer.knuckle_radius += t_max
        # Ullage and other non-geometric parameters are not relevant for outer shell volume calculation
        # but deepcopy copies them. We recalculate outer head volume.

        try:
            volumes_outer = VolumeCalculations.calculate_torispherical_tank_volume(
                p_outer
            )
            head_outer_one = volumes_outer["head_volume"]  # This is for one head
        except ValueError as e:
            # If outer geometry becomes invalid due to simple maximum thickness addition
            raise ValueError(
                f"Cannot form valid outer torispherical head with added maximum thickness: {e}"
            )

        V_head_shell_one = head_outer_one - head_inner_one
        return {
            "cylindrical_shell_volume": V_cyl_shell,
            "head_shell_volume": 2 * V_head_shell_one,
            "total_shell_volume": V_cyl_shell + 2 * V_head_shell_one,
        }

    elif isinstance(p, CommonBulkheadParameters):
        # Use dedicated Common Bulkhead shell volume calculation
        shell_breakdown = calculate_common_bulkhead_shell_volume(p, t_max)
        return shell_breakdown

    elif isinstance(p, SphericalSeparatedParameters):
        # Use dedicated Spherical Separated shell volume calculation
        shell_breakdown = calculate_spherical_separated_shell_volume(p, t_max)
        return shell_breakdown

    else:  # Spherical heads for TankParameters (spherocylinder)
        # Volume of one hemispherical head shell using maximum thickness
        ri_head = p.diameter / 2  # Same as internal_radius
        ro_head = ri_head + t_max
        V_head_shell_one = (2 / 3) * math.pi * (ro_head**3 - ri_head**3)
        return {
            "cylindrical_shell_volume": V_cyl_shell,
            "head_shell_volume": 2 * V_head_shell_one,
            "total_shell_volume": V_cyl_shell + 2 * V_head_shell_one,
        }


def calculate_shell_volume(
    p: Union[
        TankParameters,
        EllipsoidalParameters,
        TorisphericalParameters,
        CommonBulkheadParameters,
    ],
    t_max: float,
) -> float:
    """Backwards compatibility wrapper for calculate_shell_volume_with_breakdown."""
    breakdown = calculate_shell_volume_with_breakdown(p, t_max)
    return breakdown.get("total_shell_volume", breakdown.get("total_shell_vol", 0.0))


def calculate_common_bulkhead_shell_volume(
    params: CommonBulkheadParameters, t_max: float
) -> Dict[str, float]:
    """Calculate shell volume for Common Bulkhead tank with detailed breakdown.

    Tank structure:
    - Oxidizer tank shell: 1 external head + 1 internal head (fractional) + cylindrical section
    - Fuel tank shell: 1 external head + cylindrical section
    """
    ri = params.diameter / 2
    ro = ri + t_max

    # Calculate single head shell volume based on head type (normal calculation)
    if params.head_type == "Ellipsoidal" and params.head_height:
        # Ellipsoidal head shell: outer ellipsoid - inner ellipsoid
        h_inner = params.head_height
        h_outer = h_inner + t_max
        ri_outer = ri + t_max
        single_head_shell_vol = (
            (2 / 3) * math.pi * (ri_outer**2 * h_outer - ri**2 * h_inner)
        )
    elif (
        params.head_type == "Torispherical"
        and params.crown_radius
        and params.knuckle_radius
    ):
        # Use torispherical shell calculation - create dummy params for outer calculation
        from copy import deepcopy

        p_outer = deepcopy(params)
        p_outer.diameter += 2 * t_max
        p_outer.crown_radius += t_max
        p_outer.knuckle_radius += t_max

        try:
            # Calculate inner and outer head volumes
            dummy_inner = TorisphericalParameters(
                cylindrical_length=0,
                ullage=0,
                pressure=0,
                material_density=0,
                stress=0,
                efficiency=1.0,
                diameter=params.diameter,
                propellant_density=0,
                propellant_mass=0,
                crown_radius=params.crown_radius,
                knuckle_radius=params.knuckle_radius,
            )
            dummy_outer = TorisphericalParameters(
                cylindrical_length=0,
                ullage=0,
                pressure=0,
                material_density=0,
                stress=0,
                efficiency=1.0,
                diameter=p_outer.diameter,
                propellant_density=0,
                propellant_mass=0,
                crown_radius=p_outer.crown_radius,
                knuckle_radius=p_outer.knuckle_radius,
            )

            head_inner_vol = VolumeCalculations.calculate_torispherical_tank_volume(
                dummy_inner
            )["head_volume"]
            head_outer_vol = VolumeCalculations.calculate_torispherical_tank_volume(
                dummy_outer
            )["head_volume"]
            single_head_shell_vol = head_outer_vol - head_inner_vol
        except ValueError as e:
            raise ValueError(
                f"Cannot form valid outer torispherical head with added maximum thickness: {e}"
            )
    else:  # Spherical (default)
        single_head_shell_vol = (2 / 3) * math.pi * (ro**3 - ri**3)

    # Calculate individual shell volume components
    external_head_shell_vol = (
        single_head_shell_vol  # One external head (full shell volume)
    )
    internal_head_shell_vol = (
        single_head_shell_vol * params.bulkhead_shell_fraction
    )  # Internal head × shell fraction

    # Cylindrical sections (full shell volume)
    ox_cyl_shell_vol = math.pi * (ro**2 - ri**2) * params.oxidizer_cyl_length
    fuel_cyl_shell_vol = math.pi * (ro**2 - ri**2) * params.fuel_cyl_length

    # Total shell volume calculation
    total_shell_vol = (
        external_head_shell_vol
        + internal_head_shell_vol
        + ox_cyl_shell_vol
        + fuel_cyl_shell_vol
    )

    return {
        "external_head_shell_vol": external_head_shell_vol,
        "internal_head_shell_vol": internal_head_shell_vol,
        "oxidizer_cylindrical_shell_vol": ox_cyl_shell_vol,
        "fuel_cylindrical_shell_vol": fuel_cyl_shell_vol,
        "total_shell_vol": total_shell_vol,
    }


def calculate_spherical_separated_shell_volume(
    params: SphericalSeparatedParameters, results: Dict[str, float]
) -> Dict[str, float]:
    """Calculate shell volume for two separate spherical tanks using individual thicknesses.

    Tank structure:
    - Oxidizer tank shell: complete spherical shell with its own thickness
    - Fuel tank shell: complete spherical shell with its own thickness
    """
    # Get internal radii from volume calculations
    volumes = VolumeCalculations.calculate_spherical_separated_volume(params)
    ox_ri = volumes["oxidizer_internal_radius"]
    fuel_ri = volumes["fuel_internal_radius"]

    # Get individual thicknesses from results
    ox_thickness = results["oxidizer_thickness"]
    fuel_thickness = results["fuel_thickness"]

    # Calculate external radii using individual thicknesses
    ox_ro = ox_ri + ox_thickness
    fuel_ro = fuel_ri + fuel_thickness

    # Calculate shell volumes for each spherical tank: V_shell = (4/3)π(r_o³ - r_i³)
    ox_shell_vol = (4 / 3) * math.pi * (ox_ro**3 - ox_ri**3)
    fuel_shell_vol = (4 / 3) * math.pi * (fuel_ro**3 - fuel_ri**3)

    # Total shell volume
    total_shell_vol = ox_shell_vol + fuel_shell_vol

    return {
        "oxidizer_shell_vol": ox_shell_vol,
        "fuel_shell_vol": fuel_shell_vol,
        "total_shell_vol": total_shell_vol,
    }


# ---------------------
# Main Analysis Function
# ---------------------


class TankAnalysis:
    def __init__(
        self,
        params: Union[
            TankParameters,
            EllipsoidalParameters,
            TorisphericalParameters,
            CommonBulkheadParameters,
            SphericalSeparatedParameters,
        ],
    ):
        self.params = validate_and_prepare_parameters(params)
        self.results: Dict[str, Union[float, str, List[str], Dict[str, float]]] = {}

    def calculate_tank_properties(
        self,
    ) -> Dict[str, Union[float, str, List[str], Dict[str, float]]]:
        p = self.params
        results: Dict[str, Union[float, str, List[str], Dict[str, float]]] = {}
        formula_warnings: List[str] = []

        # Common parameters for checks
        P_val = p.pressure
        S_val = p.stress
        E_val = p.efficiency
        R_val = p.internal_radius  # internal_radius is a property
        D_val = p.diameter

        t_head: float = 0.0
        t_circ: float = 0.0
        t_long: float = 0.0
        volumes: Dict[str, float]  # Define volumes here

        if isinstance(p, EllipsoidalParameters):
            volumes = VolumeCalculations.calculate_ellipsoidal_tank_volume(p)
            t_head = TankHeadThicknessCalculations.ellipsoidal_head_thickness(
                P_val, p.diameter, p.k_factor, S_val, E_val  # type: ignore
            )
            try:
                L_char = ShapeFactors.compute_L_from_D_h(D_val, p.head_height)
                results["L_characteristic_ellipsoidal_head"] = (
                    L_char  # Store L for reference
                )
                if L_char > 1e-9:  # Avoid division by zero or issues with very small L
                    t_L_ratio = t_head / L_char

                    if t_L_ratio < 0.002:
                        formula_warnings.append(
                            f"Ellipsoidal head condition (t/L <= 0.002) is not met. "
                            f"Current t/L = {t_L_ratio:.4f} (t={t_head:.4f}m, L={L_char:.4f}m)."
                        )
                elif L_char < -1e-9:  # If L_char is negative
                    formula_warnings.append(
                        f"Ellipsoidal L_characteristic ({L_char:.4f}m) is negative. t/L_char condition cannot be reliably applied."
                    )

            except ValueError as e_l_calc:
                formula_warnings.append(
                    f"Could not compute L_characteristic for ellipsoidal head: {e_l_calc}"
                )

        elif isinstance(p, TorisphericalParameters):
            volumes = VolumeCalculations.calculate_torispherical_tank_volume(p)
            t_head = TankHeadThicknessCalculations.torispherical_head_thickness(
                P_val, p.crown_radius, p.m_factor, S_val, E_val  # type: ignore
            )
        elif isinstance(p, CommonBulkheadParameters):
            volumes = VolumeCalculations.calculate_common_bulkhead_volume(p)
            # Calculate head thickness based on head type
            if p.head_type == "Ellipsoidal" and p.head_height:
                # Calculate k_factor for ellipsoidal head
                k_factor = ShapeFactors.k_factor(p.diameter, p.head_height)
                t_head = TankHeadThicknessCalculations.ellipsoidal_head_thickness(
                    P_val, p.diameter, k_factor, S_val, E_val
                )
            elif p.head_type == "Torispherical" and p.crown_radius and p.knuckle_radius:
                # Calculate m_factor for torispherical head
                m_factor = ShapeFactors.m_factor(p.crown_radius, p.knuckle_radius)
                t_head = TankHeadThicknessCalculations.torispherical_head_thickness(
                    P_val, p.crown_radius, m_factor, S_val, E_val
                )
            else:  # Spherical (default)
                t_head = TankHeadThicknessCalculations.spherical_head_thickness(
                    P_val, R_val, S_val, E_val
                )
        elif isinstance(p, SphericalSeparatedParameters):
            volumes = VolumeCalculations.calculate_spherical_separated_volume(p)
            # For spherical separated tanks, calculate thickness individually for each tank
            ox_ri = volumes["oxidizer_internal_radius"]
            fuel_ri = volumes["fuel_internal_radius"]

            # Calculate individual thicknesses using simplified formula for spherical separated tanks
            ox_thickness_real = (
                TankHeadThicknessCalculations.spherical_separated_thickness(
                    P_val, ox_ri, S_val
                )
            )
            fuel_thickness_real = (
                TankHeadThicknessCalculations.spherical_separated_thickness(
                    P_val, fuel_ri, S_val
                )
            )

            # Round up thicknesses to 3 decimal places (0.001 precision) using ceiling
            ox_thickness_rounded = math.ceil(ox_thickness_real * 1000) / 1000
            fuel_thickness_rounded = math.ceil(fuel_thickness_real * 1000) / 1000

            # Store both real and rounded thicknesses
            results["oxidizer_thickness_real"] = ox_thickness_real
            results["fuel_thickness_real"] = fuel_thickness_real
            results["oxidizer_thickness"] = ox_thickness_rounded
            results["fuel_thickness"] = fuel_thickness_rounded

            # For spherical separated tanks, no validation needed and no traditional t_head concept
            # Each tank is independent with its own simplified thickness calculation
        else:  # Default to TankParameters (spherocylinder with hemispherical heads)
            volumes = VolumeCalculations.calculate_spherocylinder_volume(p)
            t_head = TankHeadThicknessCalculations.spherical_head_thickness(
                P_val, R_val, S_val, E_val
            )

            pressure_cond_met_sph = P_val <= 0.665 * S_val * E_val
            dim_cond_met_sph = t_head <= 0.356 * R_val

            if not (pressure_cond_met_sph or dim_cond_met_sph):
                limit_P_sph_val = 0.665 * S_val * E_val
                limit_t_sph_val = 0.356 * R_val
                formula_warnings.append(
                    f"Spherical head invalid must meet at least one of the following:"
                    f" P ≤ 0.665SE = {limit_P_sph_val / 1e6:.2f} MPa"
                    f" or t ≤ 0.356R = {limit_t_sph_val:.4f} m"
                )

        results.update(volumes)

        # Set head_thickness and calculate cylindrical thickness only for non-spherical-separated tanks
        if not isinstance(p, SphericalSeparatedParameters):
            results["head_thickness"] = t_head

        t_cyl_final: float = 0.0
        if p.cylindrical_length > 0 and not isinstance(p, SphericalSeparatedParameters):
            t_circ = ShellThicknessCalculations.cylindrical_circumferential_thickness(
                P_val, R_val, S_val, E_val
            )
            t_long = ShellThicknessCalculations.cylindrical_longitudinal_thickness(
                P_val, R_val, S_val, E_val
            )
            t_cyl_final = max(t_circ, t_long)

            pressure_cond_met_circ = P_val <= 0.385 * S_val * E_val
            dim_cond_met_circ = t_circ < R_val / 2
            if not (pressure_cond_met_circ or dim_cond_met_circ):
                limit_P_circ_val = 0.385 * S_val * E_val
                limit_t_cyl_val = R_val / 2
                formula_warnings.append(
                    f"Cylindrical circumferential section invalid — must meet at least one of the following:"
                    f" P ≤ 0.385SE = {limit_P_circ_val / 1e6:.2f} MPa"
                    f" or t < R/2 = {limit_t_cyl_val:.4f} m"
                )

            pressure_cond_met_long = P_val <= 1.25 * S_val * E_val
            dim_cond_met_long = t_long < R_val / 2
            if not (pressure_cond_met_long or dim_cond_met_long):
                limit_P_long_val = 1.25 * S_val * E_val
                limit_t_cyl_val = R_val / 2  # Same limit as circ for R/2
                formula_warnings.append(
                    f"Cylindrical longitudinal section invalid — must meet at least one of the following:"
                    f" P ≤ 1.25SE = {limit_P_long_val / 1e6:.2f} MPa"
                    f" or t < R/2 = {limit_t_cyl_val:.4f} m"
                )

        # Set cylindrical_thickness only for non-spherical-separated tanks
        if not isinstance(p, SphericalSeparatedParameters):
            results["cylindrical_thickness"] = t_cyl_final

        if formula_warnings:
            results["formula_warnings"] = formula_warnings

        # Ensure effective_volume is float for calculation
        effective_vol_val = results.get("effective_volume", 0.0)
        if not isinstance(effective_vol_val, (float, int)):
            effective_vol_val = 0.0  # Default to 0 if type is wrong, though it should be float from VolumeCalculations

        # Calculate shell volume and store breakdown for special tank types
        if isinstance(p, CommonBulkheadParameters):
            # Use maximum thickness for manufacturing consistency (governing thickness for entire tank)
            t_max = max(t_cyl_final, t_head)
            t_max = math.ceil(t_max * 10000) / 10000  # Round up to 4 decimal places

            shell_breakdown = calculate_common_bulkhead_shell_volume(p, t_max)
            results["shell_volume"] = shell_breakdown["total_shell_vol"]
            results["shell_volume_breakdown"] = shell_breakdown
            results["maximum_thickness"] = t_max

            # Add internal volume breakdown for Common Bulkhead tanks
            # The volume data is already in results dict from results.update(volumes)
            internal_breakdown = {
                "external_head_volume": results.get("external_head_volume", 0.0),
                "internal_head_volume": results.get("internal_head_volume", 0.0),
                "oxidizer_cylindrical_volume": results.get(
                    "oxidizer_cylindrical_volume", 0.0
                ),
                "fuel_cylindrical_volume": results.get("fuel_cylindrical_volume", 0.0),
                "total_internal_volume": results.get("internal_volume", 0.0),
                "total_effective_volume": results.get("effective_volume", 0.0),
            }
            results["internal_volume_breakdown"] = internal_breakdown
        elif isinstance(p, SphericalSeparatedParameters):
            # For spherical separated tanks, don't use max thickness - each tank has its own thickness
            shell_breakdown = calculate_spherical_separated_shell_volume(p, results)
            results["shell_volume"] = shell_breakdown["total_shell_vol"]
            results["shell_volume_breakdown"] = shell_breakdown
            # Do NOT set maximum_thickness for spherical separated tanks

            # Calculate effective volumes (without ullage) and outer radii
            ox_effective_volume = results.get("oxidizer_volume", 0.0) * (1 - p.ullage)
            fuel_effective_volume = results.get("fuel_volume", 0.0) * (1 - p.ullage)
            ox_outer_radius = results.get(
                "oxidizer_internal_radius", 0.0
            ) + results.get("oxidizer_thickness", 0.0)
            fuel_outer_radius = results.get("fuel_internal_radius", 0.0) + results.get(
                "fuel_thickness", 0.0
            )

            # Add internal volume breakdown for Spherical Separated tanks
            internal_breakdown = {
                "oxidizer_volume": results.get("oxidizer_volume", 0.0),
                "fuel_volume": results.get("fuel_volume", 0.0),
                "oxidizer_effective_volume": ox_effective_volume,  # Volume without ullage
                "fuel_effective_volume": fuel_effective_volume,  # Volume without ullage
                "oxidizer_internal_radius": results.get(
                    "oxidizer_internal_radius", 0.0
                ),
                "fuel_internal_radius": results.get("fuel_internal_radius", 0.0),
                "oxidizer_outer_radius": ox_outer_radius,  # Internal radius + thickness
                "fuel_outer_radius": fuel_outer_radius,  # Internal radius + thickness
                "oxidizer_thickness": results.get(
                    "oxidizer_thickness", 0.0
                ),  # Rounded thickness
                "fuel_thickness": results.get(
                    "fuel_thickness", 0.0
                ),  # Rounded thickness
                "oxidizer_thickness_real": results.get(
                    "oxidizer_thickness_real", 0.0
                ),  # Real thickness
                "fuel_thickness_real": results.get(
                    "fuel_thickness_real", 0.0
                ),  # Real thickness
                "oxidizer_propellant_mass": p.oxidizer_propellant_mass,  # Individual propellant masses
                "fuel_propellant_mass": p.fuel_propellant_mass,  # Individual propellant masses
                "total_internal_volume": results.get("internal_volume", 0.0),
                "total_effective_volume": results.get("effective_volume", 0.0),
            }
            results["internal_volume_breakdown"] = internal_breakdown
        else:
            # Use maximum thickness for manufacturing consistency (governing thickness for entire tank)
            t_max = max(t_cyl_final, t_head)
            t_max = math.ceil(t_max * 10000) / 10000  # Round up to 4 decimal places

            # Calculate shell volume with component breakdown
            shell_breakdown = calculate_shell_volume_with_breakdown(p, t_max)
            shell_vol = shell_breakdown.get("total_shell_volume", 0.0)
            results["shell_volume"] = shell_vol
            results["shell_volume_breakdown"] = {
                "head_shell_volume": shell_breakdown.get("head_shell_volume", 0.0),
                "cylindrical_shell_volume": shell_breakdown.get(
                    "cylindrical_shell_volume", 0.0
                ),
                "total_shell_volume": shell_vol,
            }

            # Add internal volume breakdown
            internal_breakdown = {
                "head_volume": volumes.get("head_volume", 0.0),
                "cylindrical_volume": volumes.get("cylindrical_volume", 0.0),
                "total_internal_volume": volumes.get("internal_volume", 0.0),
                "total_effective_volume": volumes.get("effective_volume", 0.0),
            }
            results["internal_volume_breakdown"] = internal_breakdown
            results["maximum_thickness"] = t_max

        shell_mass_val = TankMassCalculations.shell_mass(
            results["shell_volume"], p.material_density
        )
        results["shell_mass"] = shell_mass_val

        prop_mass_val = p.propellant_mass
        results["propellant_mass"] = prop_mass_val

        results["total_mass"] = shell_mass_val + prop_mass_val

        self.results.update(results)
        return self.results


# -------------------
# Example CLI Usage
# -------------------

if __name__ == "__main__":
    print("Propellant_Tanks_Standard.py - Tank Geometry and Structural Mass Analysis\n")

    # Torispherical Tank Test
    try:
        torisph_params = TorisphericalParameters(
            cylindrical_length=1.0,
            diameter=1.0,  # m
            ullage=0.001,  # 0.1%
            pressure=3e6,  # Pa (approx 30 bar)
            material_density=4430,  # kg/m^3 (e.g., Ti Grade 5)
            stress=200e6,  # Pa (Allowable stress, consider safety factor)
            efficiency=0.85,  # Joint efficiency
            propellant_density=1000,  # kg/m^3 (e.g. water for testing)
            propellant_mass=785.0,  # kg (example value)
            crown_radius=0.9,  # m (L)
            knuckle_radius=0.01,  # m (r)
        )
        analysis_tori = TankAnalysis(torisph_params)
        results_tori = analysis_tori.calculate_tank_properties()

        print("Torispherical Tank Results:")
        for k, v in results_tori.items():
            print(f"  {k}: {v:.6f}" if isinstance(v, (float, int)) else f"  {k}: {v}")
        print()

    except ValueError as err:
        print(f"Error during torispherical analysis: {err}\n")

    # Ellipsoidal Tank Test
    try:
        ellip_params = EllipsoidalParameters(
            cylindrical_length=1.0,
            diameter=1.0,
            ullage=0.001,
            pressure=3e6,
            material_density=4430,
            stress=200e6,
            efficiency=0.85,
            head_height=0.25,  # m (h for 2:1 ellipsoid would be D/4 = 0.25)
            propellant_density=1000,
            propellant_mass=785.0,  # kg (example value)
        )
        analysis_ellip = TankAnalysis(ellip_params)
        results_ellip = analysis_ellip.calculate_tank_properties()

        print("Ellipsoidal Tank Results:")
        for k, v in results_ellip.items():
            print(f"  {k}: {v:.6f}" if isinstance(v, (float, int)) else f"  {k}: {v}")
        print()

    except ValueError as err:
        print(f"Error during ellipsoidal analysis: {err}\n")

    # Spherocylindrical Tank Test (using base TankParameters)
    try:
        sphero_params = TankParameters(
            cylindrical_length=1.0,
            diameter=1.0,
            ullage=0.001,
            pressure=3e6,
            material_density=4430,
            stress=200e6,
            efficiency=0.85,
            propellant_density=1000,
            propellant_mass=785.0,  # kg (example value)
        )
        analysis_sphero = TankAnalysis(sphero_params)
        results_sphero = analysis_sphero.calculate_tank_properties()

        print("Spherocylindrical Tank Results (Hemispherical Heads):")
        for k, v in results_sphero.items():
            print(f"  {k}: {v:.6f}" if isinstance(v, (float, int)) else f"  {k}: {v}")
        print()

    except ValueError as err:
        print(f"Error during spherocylindrical analysis: {err}\n")

    # Purely Spherical Tank Test (using base TankParameters with L=0)
    try:
        sphere_params = TankParameters(
            cylindrical_length=0.0,
            diameter=1.0,  # L=0 makes it a sphere
            ullage=0.001,
            pressure=3e6,
            material_density=4430,
            stress=200e6,
            efficiency=0.85,
            propellant_density=1000,
            propellant_mass=523.0,  # kg (example value for pure sphere)
        )
        analysis_sphere = TankAnalysis(sphere_params)
        results_sphere = analysis_sphere.calculate_tank_properties()

        print("Purely Spherical Tank Results:")
        for k, v in results_sphere.items():
            print(f"  {k}: {v:.6f}" if isinstance(v, (float, int)) else f"  {k}: {v}")
        print()

    except ValueError as err:
        print(f"Error during purely spherical analysis: {err}\n")

    # Common Bulkhead Tank Test
    try:
        bulkhead_params = CommonBulkheadParameters(
            cylindrical_length=1.0,
            diameter=1.0,  # Base parameters
            ullage=0.001,
            pressure=3e6,
            material_density=4430,
            stress=200e6,
            efficiency=0.85,
            propellant_density=1000,
            propellant_mass=785.0,
            head_type="Spherical",
            bulkhead_shell_fraction=0.5,
            oxidizer_cyl_length=1.2,
            fuel_cyl_length=0.8,
            oxidizer_propellant_mass=471.0,
            fuel_propellant_mass=314.0,  # 3:2 O/F ratio
            oxidizer_propellant_density=1400.0,
            fuel_propellant_density=800.0,
        )
        analysis_bulkhead = TankAnalysis(bulkhead_params)
        results_bulkhead = analysis_bulkhead.calculate_tank_properties()

        print("Common Bulkhead Tank Results (Spherical Heads):")
        for k, v in results_bulkhead.items():
            if isinstance(v, (float, int)):
                print(f"  {k}: {v:.6f}")
            else:
                print(f"  {k}: {v}")
        print()

    except ValueError as err:
        print(f"Error during common bulkhead analysis: {err}\n")
