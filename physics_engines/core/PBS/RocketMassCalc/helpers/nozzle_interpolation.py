# helpers/nozzle_interpolation.py

import numpy as np
from scipy.interpolate import RegularGridInterpolator, griddata
import math

# --- Nozzle Wall Angle Interpolation ---

# Data from "Modern Engineering for Design of Liquid-Propellant Rocket Engines" by Huzel and Huang
# Table 4-3. Bell-Nozzle Exit-Section Coordinates for Parabolic Approximation
l_percents = np.array([60, 70, 80, 90, 100])
ar_values = np.array(
    [5.39, 7.8, 10.37, 13.19, 15.45, 18.17, 20.38, 22.84, 25.1, 28.08, 30.08, 32.6, 34.96, 37.73, 40.2, 42.86, 45.33,
     47.59, 50.21])

# theta_n values by row for each l_percent
theta_n_table = np.array([
    [36.0, 34.1, 32.5, 31.2, 30.5, 29.5, 29.0, 28.3, 27.8, 27.0, 26.5, 25.8, 25.1, 24.3, 23.8, 23.2, 22.7, 22.2, 21.8],
    # 60%
    [33.5, 31.6, 30.1, 28.8, 28.1, 27.1, 26.6, 25.9, 25.4, 24.6, 24.1, 23.4, 22.7, 21.9, 21.4, 20.8, 20.3, 19.8, 19.4],
    # 70%
    [31.0, 29.1, 27.6, 26.3, 25.6, 24.6, 24.1, 23.4, 22.9, 22.1, 21.6, 20.9, 20.2, 19.4, 18.9, 18.3, 17.8, 17.3, 16.9],
    # 80%
    [28.5, 26.6, 25.1, 23.8, 23.1, 22.1, 21.6, 20.9, 20.4, 19.6, 19.1, 18.4, 17.7, 16.9, 16.4, 15.8, 15.3, 14.8, 14.4],
    # 90%
    [26.0, 24.1, 22.6, 21.3, 20.6, 19.6, 19.1, 18.4, 17.9, 17.1, 16.6, 15.9, 15.2, 14.4, 13.9, 13.3, 12.8, 12.3, 11.9]
    # 100%
])

# theta_e values by row for each l_percent
theta_e_table = np.array([
    [12.0, 11.0, 10.1, 9.5, 9.1, 8.6, 8.3, 8.0, 7.7, 7.4, 7.2, 6.9, 6.7, 6.4, 6.2, 6.0, 5.8, 5.7, 5.6],  # 60%
    [10.0, 9.0, 8.1, 7.5, 7.1, 6.6, 6.3, 6.0, 5.7, 5.4, 5.2, 4.9, 4.7, 4.4, 4.2, 4.0, 3.8, 3.7, 3.6],  # 70%
    [8.0, 7.0, 6.1, 5.5, 5.1, 4.6, 4.3, 4.0, 3.7, 3.4, 3.2, 2.9, 2.7, 2.4, 2.2, 2.0, 1.8, 1.7, 1.6],  # 80%
    [6.0, 5.0, 4.1, 3.5, 3.1, 2.6, 2.3, 2.0, 1.7, 1.4, 1.2, 0.9, 0.7, 0.4, 0.2, 0, 0, 0, 0],  # 90%
    [4.0, 3.0, 2.1, 1.5, 1.1, 0.6, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]  # 100%
])

# Create 2D interpolator functions for theta_n and theta_e using RegularGridInterpolator
# The points are ordered (y, x) which corresponds to (l_percents, ar_values)
theta_n_interp = RegularGridInterpolator((l_percents, ar_values), theta_n_table, method='linear', bounds_error=False,
                                         fill_value=None)
theta_e_interp = RegularGridInterpolator((l_percents, ar_values), theta_e_table, method='linear', bounds_error=False,
                                         fill_value=None)


def find_wall_angles(ar: float, throat_radius: float, l_percent: float = 80.0):
    """
    Calculates nozzle length and wall angles using interpolation.
    """
    f1 = ((np.sqrt(ar) - 1) * throat_radius) / np.tan(np.radians(15))
    Ln = (l_percent / 100) * f1

    # Call the new interpolators with a point [l_percent, ar]
    theta_n_deg_val = theta_n_interp([l_percent, ar])
    theta_e_deg_val = theta_e_interp([l_percent, ar])

    # The result is an array, get the scalar value
    theta_n_deg = float(theta_n_deg_val[0]) if theta_n_deg_val is not None else 0.0
    theta_e_deg = float(theta_e_deg_val[0]) if theta_e_deg_val is not None else 0.0

    return Ln, np.radians(theta_n_deg), np.radians(theta_e_deg)


# --- Nozzle Efficiency Interpolation ---

# Define nozzle efficiency data
expansion_ratios = [10, 20, 30, 40, 50, 60, 70, 80]
l_percent_data = [
    [60.180526275309916, 62.72061400894178, 65.26070027241808, 67.62560867984621, 70.12190047931045, 72.44301442272655,
     75.24586894043065, 77.61077587770322, 80.36983446123973, 82.9099221948716, 85.31862506631177, 88.07768364984828,
     90.35500459940788, 93.28924103899257, 95.34758819833638, 97.9752619196812, 100.25257992892969],
    [60.268115203334006, 62.89579186498995, 65.12931541022638, 67.71319613771473, 70.1218990091549, 72.83716459883493,
     75.2896634044427, 77.82974819776344, 80.3260399972277, 82.86612773085956, 85.31862359615621, 87.81491539562046,
     90.35500606956344, 93.2454436346694, 95.39138266234843, 98.15044124588495, 100.20878840522877],
    [60.22432073932196, 62.85199740097791, 65.12931541022638, 67.62560720969064, 70.25328387134658, 72.83716459883493,
     75.2896634044427, 78.26769577819499, 80.3698359313953, 83.04130558690773, 85.36241953032382, 88.16527404802792,
     90.26741420122823, 93.20165064081291, 95.34758966849196, 97.97526338983678, 100.20878840522877],
    [60.22432073932196, 62.85199740097791, 65.12931541022638, 67.71319613771473, 70.20948793717898, 72.88096053300254,
     75.3772523324668, 78.1801068501709, 80.3260399972277, 82.99750965274012, 85.36241953032382, 87.94630025781215,
     90.31120719508472, 93.20165064081291, 95.34758966849196, 98.06284937754975, 100.1649954113723],
    # ER = 50 (extrapolated)
    [60.18, 62.75, 65.05, 67.68, 70.15, 72.85, 75.35, 78.15, 80.35, 82.95, 85.32, 87.95, 90.28, 93.18, 95.33, 98.05, 100.15],
    # ER = 60 (extrapolated)
    [60.15, 62.70, 65.00, 67.65, 70.10, 72.80, 75.30, 78.10, 80.30, 82.90, 85.28, 87.90, 90.25, 93.15, 95.30, 98.00, 100.10],
    # ER = 70 (extrapolated)
    [60.12, 62.68, 64.98, 67.62, 70.08, 72.78, 75.28, 78.08, 80.28, 82.88, 85.26, 87.88, 90.22, 93.12, 95.28, 97.98, 100.08],
    # ER = 80 (extrapolated)
    [60.10, 62.65, 64.95, 67.60, 70.05, 72.75, 75.25, 78.05, 80.25, 82.85, 85.24, 87.85, 90.20, 93.10, 95.25, 97.95, 100.05]
]
efficiency_data = [
    [96.22446674848, 96.58669040512136, 96.9444965662756, 97.266963801548, 97.56734430082415, 97.82796852701918,
     98.12393182738393, 98.33596508609936, 98.54358099761554, 98.71585805739379, 98.85721361263336, 98.97206497346154,
     99.03832536681011, 99.10016841295943, 99.12225522309961, 99.13992468604054, 99.1575941119095],
    [96.70154172887757, 97.11235620471068, 97.42598874558456, 97.73520408754707, 97.99141096654286, 98.24320049833939,
     98.41547755811764, 98.58333727069665, 98.71585805739379, 98.83070945529393, 98.92789135318118, 99.00740386227143,
     99.0648295612215, 99.10458579723064, 99.12225522309961, 99.1443420332398, 99.15317676471025],
    [97.14769513059254, 97.45691032426718, 97.70869985606372, 97.9472373462625, 98.19019218366054, 98.38897340077821,
     98.54799834481479, 98.71585805739379, 98.80420529795451, 98.90138719584175, 98.95881289479182, 99.02507328814039,
     99.0604121769503, 99.10458579723064, 99.12225522309961, 99.13992468604054, 99.1575941119095],
    [97.25371175995025, 97.54967491202714, 97.79262974942517, 98.03558458682322, 98.22994845674165, 98.42431225251615,
     98.58333727069665, 98.72469275179229, 98.8218746867515, 98.91463927451147, 98.97648232066079, 99.02065594094114,
     99.0648295612215, 99.10458579723064, 99.12225522309961, 99.1443420332398, 99.15317676471025],
    # ER = 50 (extrapolated - very conservative increase)
    [97.28, 97.57, 97.82, 98.06, 98.26, 98.45, 98.61, 98.75, 98.85, 98.94, 99.00, 99.05, 99.09, 99.13, 99.15, 99.17, 99.18],
    # ER = 60 (extrapolated - approaching asymptotic limit)
    [97.30, 97.59, 97.84, 98.08, 98.28, 98.47, 98.63, 98.77, 98.87, 98.96, 99.02, 99.07, 99.11, 99.15, 99.17, 99.19, 99.20],
    # ER = 70 (extrapolated - very close to maximum)
    [97.32, 97.61, 97.86, 98.10, 98.30, 98.49, 98.65, 98.79, 98.89, 98.98, 99.04, 99.09, 99.13, 99.17, 99.19, 99.20, 99.21],
    # ER = 80 (extrapolated - at practical maximum)
    [97.33, 97.62, 97.87, 98.11, 98.31, 98.50, 98.66, 98.80, 98.90, 98.99, 99.05, 99.10, 99.14, 99.18, 99.20, 99.21, 99.22]
]

# Flatten the data to prepare for 2D interpolation
grids_E = []
grids_L = []
grid_vals = []

for i, E in enumerate(expansion_ratios):
    grids_E.extend([E] * len(l_percent_data[i]))
    grids_L.extend(l_percent_data[i])
    grid_vals.extend(efficiency_data[i])

grids_E = np.array(grids_E)
grids_L = np.array(grids_L)
grid_vals = np.array(grid_vals)


def get_nozzle_efficiency(E: float, l_percent: float):
    """
    Calculates nozzle efficiency using griddata interpolation.
    """
    if E is None or l_percent is None:
        return 100.0  # Default value

    efficiency = griddata((grids_E, grids_L), grid_vals, (E, l_percent), method='linear')

    if efficiency is None or math.isnan(efficiency):
        # Fallback to nearest neighbor if linear interpolation fails (e.g., out of convex hull)
        efficiency = griddata((grids_E, grids_L), grid_vals, (E, l_percent), method='nearest')

    return float(efficiency)