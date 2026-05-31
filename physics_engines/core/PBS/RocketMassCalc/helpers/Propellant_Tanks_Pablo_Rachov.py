# helpers/Propellant_Tanks_Pablo_Rachov.py


def calculate_tank_mass(params: dict) -> float:
    """
    Calculates the mass of a propellant tank shell (fuel or oxidizer)
    based on the formula from the Excel specification.

    m_tank = ku * ρ_mat * P * ( (2*SF_cyl/σ)*V_cyl_geom + (3*SF_sph/(2*σ))*V_sph_geom )

    Args:
        params (dict): Dictionary containing all required tank parameters:
            - pressure (float): Internal tank pressure (P) [Pa].
            - ullage (float): Ullage factor (e.g., 0.05 for 5%).
            - material_density (float): Density of the tank material (ρ_mat) [kg/m³].
            - SF_cyl (float): Safety factor for the cylindrical section.
            - SF_sph (float): Safety factor for spherical heads.
            - uts (float): Ultimate tensile strength of tank material (σ) [Pa].
            - V_cyl_actual (float): The geometric volume of the cylindrical section [m³].
            - V_sph_actual (float): The geometric volume of the spherical sections [m³].

    Returns:
        float: Estimated tank shell mass in kg.
    """
    # --- Unpack parameters for clarity ---
    P = params["pressure"]
    ullage = params["ullage"]
    material_density = params["material_density"]
    SF_cyl = params["SF_cyl"]
    SF_sph = params["SF_sph"]
    uts = params["uts"]
    V_cyl_actual = params["V_cyl_actual"]
    V_sph_actual = params["V_sph_actual"]

    # --- 1. Calculate Ullage Factor (ku) ---
    if (1 - ullage) <= 0:
        raise ValueError("Ullage must be less than 1.")
    ku = 1 / (1 - ullage)

    # --- 2. Check for division by zero in strength values ---
    if uts <= 0:
        raise ValueError("Ultimate Tensile Strength (UTS) value must be positive.")

    # --- 3. Calculate the final tank mass using the full formula ---
    tank_mass = (
        ku
        * material_density
        * P
        * (2 * SF_cyl * V_cyl_actual + 3 * SF_sph / 2 * V_sph_actual)
        / uts
    )

    return tank_mass
