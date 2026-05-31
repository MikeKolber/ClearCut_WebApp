def thrust_structure_mass(thrust_N):
    """
    Estimate the mass of the thrust structure using the MER approach.

    Parameters:
        thrust_N (float): Engine thrust in Newtons.

    Returns:
        float: Estimated thrust structure mass in kilograms.
    """
    return 2.55e-4 * thrust_N