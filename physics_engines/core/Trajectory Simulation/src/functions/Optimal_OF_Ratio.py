import numpy as np
from scipy.interpolate import interp1d


def Optimal_OF_Ratio(P_c, Ae_At, Fuel_Type, Oxidizer_Type):

    # Define a range of O/F ratios
    OF_ratios = np.linspace(2, 10, 15)

    # Initialize lists to store results
    Exit_Pressure = []
    Exit_Velocity = []
    C_star_th = []

    # Evaluate Rocket CEA for each O/F ratio
    for OF in OF_ratios:
        m_dot_Fuel_in = 100  # Example fuel mass flow rate
        m_dot_Oxidizer_in = m_dot_Fuel_in * OF

        # Replace this with the actual Rocket_CEA function in Python
        # exit_pressure, exit_velocity, c_star = Rocket_CEA(P_c, Ae_At, Fuel_Type, Oxidizer_Type, m_dot_Fuel_in, m_dot_Oxidizer_in)
        exit_pressure, exit_velocity, c_star = 0.38990, 762.9, 1657.7

        Exit_Pressure.append(exit_pressure)
        Exit_Velocity.append(exit_velocity)
        C_star_th.append(c_star)

    # Interpolate C* values for finer resolution
    OF_interp = np.linspace(OF_ratios[0], OF_ratios[-1], 1000)
    interp_func = interp1d(OF_ratios, C_star_th, kind='cubic')
    C_star_interp = interp_func(OF_interp)

    # Find the O/F ratio corresponding to the maximum C*
    max_index = np.argmax(C_star_interp)
    Optimal_OF = OF_interp[max_index]

    return Optimal_OF