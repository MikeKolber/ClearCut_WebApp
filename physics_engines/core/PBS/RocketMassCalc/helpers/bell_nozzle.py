import csv
import math

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Arc
from matplotlib.widgets import Button
from scipy.interpolate import griddata

# --- Wall Angle Interpolation Setup ---
# New scattered data for theta_n (inflexion angle)
data_n = {
    60: (
        [
            5.39,
            8.01,
            10.37,
            13.04,
            15.55,
            18.22,
            20.38,
            23.15,
            25.21,
            28.03,
            30.08,
            32.80,
            35.11,
            38.04,
            40.20,
            43.07,
            45.38,
            48.05,
            50.36,
            60.0,
            70.0,
            80.0,
        ],
        [
            28.55,
            30.88,
            32.23,
            33.42,
            34.30,
            35.08,
            35.70,
            36.42,
            36.74,
            37.20,
            37.46,
            37.88,
            38.13,
            38.34,
            38.50,
            38.86,
            39.02,
            39.22,
            39.38,
            39.50,
            39.58,
            39.64,
        ],
    ),
    70: (
        [
            5.39,
            7.91,
            10.37,
            12.94,
            15.45,
            17.86,
            20.38,
            23.05,
            25.10,
            27.87,
            30.08,
            32.96,
            35.11,
            37.83,
            40.14,
            42.81,
            45.28,
            47.90,
            50.31,
            60.0,
            70.0,
            80.0,
        ],
        [
            25.49,
            27.31,
            28.55,
            29.64,
            30.62,
            31.40,
            31.92,
            32.44,
            32.85,
            33.26,
            33.58,
            33.94,
            34.20,
            34.46,
            34.72,
            34.97,
            35.23,
            35.39,
            35.65,
            35.82,
            35.94,
            36.02,
        ],
    ),
    80: (
        [
            5.44,
            8.06,
            10.37,
            12.89,
            15.55,
            18.17,
            20.23,
            22.90,
            25.15,
            27.87,
            30.08,
            32.75,
            35.01,
            37.94,
            40.14,
            42.97,
            45.28,
            48.00,
            50.26,
            60.0,
            70.0,
            80.0,
        ],
        [
            23.37,
            25.08,
            26.01,
            27.15,
            28.08,
            28.81,
            29.27,
            29.90,
            30.21,
            30.67,
            31.04,
            31.35,
            31.61,
            31.87,
            32.07,
            32.33,
            32.54,
            32.80,
            32.90,
            33.05,
            33.15,
            33.22,
        ],
    ),
    90: (
        [
            5.34,
            7.70,
            10.37,
            13.19,
            15.45,
            18.17,
            20.17,
            22.84,
            25.21,
            27.77,
            30.08,
            32.70,
            35.06,
            38.04,
            40.20,
            43.02,
            45.43,
            48.15,
            50.31,
            60.0,
            70.0,
            80.0,
        ],
        [
            21.40,
            22.90,
            24.25,
            25.34,
            26.27,
            26.99,
            27.51,
            27.98,
            28.34,
            28.76,
            29.02,
            29.43,
            29.74,
            30.05,
            30.31,
            30.57,
            30.73,
            31.04,
            31.19,
            31.32,
            31.41,
            31.47,
        ],
    ),
    100: (
        [
            5.39,
            7.80,
            10.42,
            12.83,
            15.45,
            17.92,
            20.38,
            22.84,
            25.10,
            28.08,
            30.13,
            32.60,
            34.96,
            37.73,
            40.09,
            42.86,
            45.33,
            47.59,
            50.21,
            60.0,
            70.0,
            80.0,
        ],
        [
            20.10,
            21.55,
            22.64,
            23.73,
            24.61,
            25.39,
            25.96,
            26.53,
            26.89,
            27.41,
            27.77,
            28.13,
            28.45,
            28.70,
            28.91,
            29.22,
            29.43,
            29.64,
            29.90,
            30.05,
            30.15,
            30.22,
        ],
    ),
}

# New scattered data for theta_e (exit angle)
data_e = {
    60: (
        [
            5.34,
            8.06,
            10.28,
            12.79,
            15.30,
            18.00,
            20.29,
            22.84,
            25.06,
            27.72,
            29.94,
            32.53,
            34.93,
            37.33,
            39.95,
            42.62,
            45.06,
            47.68,
            50.08,
            60.0,
            70.0,
            80.0,
        ],
        [
            19.95,
            17.97,
            16.89,
            16.07,
            15.51,
            15.10,
            14.76,
            14.39,
            14.24,
            14.01,
            13.90,
            13.75,
            13.56,
            13.53,
            13.34,
            13.26,
            13.23,
            13.11,
            12.97,
            12.85,
            12.76,
            12.70,
        ],
    ),
    70: (
        [
            5.25,
            7.87,
            10.24,
            12.60,
            15.34,
            17.67,
            20.18,
            22.80,
            25.02,
            27.54,
            29.83,
            32.53,
            34.85,
            37.63,
            39.84,
            42.43,
            44.98,
            47.57,
            50.01,
            60.0,
            70.0,
            80.0,
        ],
        [
            16.33,
            14.54,
            13.38,
            12.63,
            12.14,
            11.81,
            11.47,
            11.24,
            11.10,
            10.91,
            10.72,
            10.68,
            10.53,
            10.42,
            10.42,
            10.42,
            10.35,
            10.38,
            10.31,
            10.25,
            10.20,
            10.16,
        ],
    ),
    80: (
        [
            5.25,
            7.76,
            10.16,
            12.86,
            15.26,
            18.00,
            20.07,
            22.69,
            24.99,
            27.35,
            29.83,
            32.41,
            34.89,
            37.33,
            39.99,
            42.65,
            45.02,
            47.79,
            50.05,
            60.0,
            70.0,
            80.0,
        ],
        [
            13.34,
            11.84,
            10.83,
            10.09,
            9.67,
            9.34,
            9.08,
            8.93,
            8.78,
            8.66,
            8.51,
            8.48,
            8.40,
            8.40,
            8.29,
            8.29,
            8.29,
            8.25,
            8.25,
            8.22,
            8.20,
            8.18,
        ],
    ),
    90: (
        [
            5.25,
            7.65,
            10.16,
            12.71,
            15.30,
            17.70,
            20.14,
            22.66,
            25.02,
            27.57,
            29.90,
            32.53,
            34.85,
            37.40,
            39.88,
            42.54,
            45.06,
            47.64,
            50.08,
            60.0,
            70.0,
            80.0,
        ],
        [
            10.61,
            9.52,
            8.63,
            7.92,
            7.43,
            7.09,
            6.83,
            6.76,
            6.68,
            6.68,
            6.61,
            6.68,
            6.64,
            6.64,
            6.61,
            6.64,
            6.72,
            6.72,
            6.72,
            6.71,
            6.70,
            6.69,
        ],
    ),
    100: (
        [
            5.17,
            7.54,
            10.16,
            12.75,
            15.23,
            17.78,
            20.18,
            22.66,
            24.99,
            27.61,
            29.90,
            32.34,
            34.85,
            37.44,
            39.81,
            42.58,
            44.94,
            47.61,
            50.01,
            60.0,
            70.0,
            80.0,
        ],
        [
            8.44,
            7.58,
            6.76,
            6.20,
            5.67,
            5.41,
            5.07,
            5.00,
            4.89,
            4.92,
            4.85,
            4.89,
            5.00,
            5.04,
            5.00,
            5.00,
            5.07,
            5.04,
            5.11,
            5.12,
            5.13,
            5.14,
        ],
    ),
}

# Aggregate scattered data into structured arrays for griddata
points_n_list = []
values_n_list = []
for l_perc, (x_vals, y_vals) in data_n.items():
    for i in range(len(x_vals)):
        points_n_list.append([l_perc, x_vals[i]])
        values_n_list.append(y_vals[i])
points_n = np.array(points_n_list)
values_n = np.array(values_n_list)

points_e_list = []
values_e_list = []
for l_perc, (x_vals, y_vals) in data_e.items():
    for i in range(len(x_vals)):
        points_e_list.append([l_perc, x_vals[i]])
        values_e_list.append(y_vals[i])
points_e = np.array(points_e_list)
values_e = np.array(values_e_list)


def find_wall_angles(ar, throat_radius, l_percent=80):
    """
    Calculates nozzle length and wall angles using 2D interpolation on scattered data.
    """
    f1 = ((np.sqrt(ar) - 1) * throat_radius) / np.tan(np.radians(15))
    Ln = (l_percent / 100) * f1

    point_to_interpolate = [[l_percent, ar]]

    # Interpolate for theta_n
    theta_n_deg = griddata(points_n, values_n, point_to_interpolate, method="linear")
    if np.isnan(theta_n_deg.any()):
        theta_n_deg = griddata(
            points_n, values_n, point_to_interpolate, method="nearest"
        )

    # Interpolate for theta_e
    theta_e_deg = griddata(points_e, values_e, point_to_interpolate, method="linear")
    if np.isnan(theta_e_deg.any()):
        theta_e_deg = griddata(
            points_e, values_e, point_to_interpolate, method="nearest"
        )

    return Ln, np.radians(theta_n_deg.item()), np.radians(theta_e_deg.item())


def bell_nozzle(k, aratio, throat_radius, l_percent, alpha_deg=None, epsilon_c=None):
    """
    Generates the contour for a Rao bell nozzle.
    """
    # This now uses the new griddata interpolation internally
    angles = find_wall_angles(aratio, throat_radius, l_percent)
    nozzle_length, theta_n, theta_e = angles

    # Determine inlet arc parameters based on geometric constraints
    if alpha_deg is not None and epsilon_c is not None:
        ea_start = np.radians(-90 - alpha_deg)
        alpha_rad = np.radians(alpha_deg)

        # Calculate actual chamber radius
        Rc = throat_radius * math.sqrt(epsilon_c)

        # Calculate Ri_chamber using the tangent formula
        Ri_chamber = 2.5 * throat_radius - 1.5 * throat_radius * math.cos(alpha_rad)

        # Classical Rao parameters
        R1_classical = 1.5 * throat_radius
        yc1_classical = 2.5 * throat_radius

        # Check if classical geometry allows tangent connection without chamber wall intersection
        # Point on classical arc at ea_start (tangent point)
        x_tangent_classical = R1_classical * math.cos(ea_start)
        y_tangent_classical = R1_classical * math.sin(ea_start) + yc1_classical

        # Check if this point exceeds the chamber radius bounds
        if abs(y_tangent_classical) > Rc * 0.98:  # 2% safety margin
            # Classical geometry would intersect chamber wall - use adaptive approach

            # CRITICAL: Ensure continuity with throat arc at all times
            # The throat arc starts at (0, 1.0*throat_radius) at angle -90°
            # This is because: 0.382*Rt*sin(-90°) + 1.382*Rt = -0.382*Rt + 1.382*Rt = 1.0*Rt
            throat_connection_y = 1.0 * throat_radius
            throat_connection_point = (0.0, throat_connection_y)

            # Check for geometric impossibility: when throat connection is close to or exceeds chamber bounds
            geometric_impossibility = throat_connection_y >= Rc * 0.98

            if geometric_impossibility:
                # EXTREME CASE: Prioritize continuity over chamber bounds
                # For very small contraction ratios, chamber bounds become meaningless
                print(
                    f"Warning: Geometric impossibility detected (throat_y={throat_connection_y:.4f} >= chamber_r={Rc:.4f})"
                )
                print("Prioritizing continuity over strict chamber bounds")

                # Strategy: Create minimal arc that ensures continuity
                # Allow slight overshoot of chamber bounds if necessary for connection
                target_y_tangent = max(
                    Rc * 1.05, throat_connection_y * 1.1
                )  # Allow overshoot
            else:
                # NORMAL CASE: Stay within chamber bounds
                target_y_tangent = min(
                    Rc * 0.95, abs(y_tangent_classical) * 0.9
                )  # Conservative target

            # Method 1: Try simple scaling while preserving throat connection
            scale_factor = target_y_tangent / abs(y_tangent_classical)

            # For scaling to work properly, we need to scale around the throat connection point
            # instead of scaling the entire geometry uniformly

            # Calculate arc that connects throat at (0, 1.0*Rt) and has tangent at ea_start
            # Arc equation: (x - xc)² + (y - yc)² = R²
            # Constraints:
            # 1. Arc passes through (0, 1.0*Rt) at angle -90°
            # 2. Arc has tangent at ea_start with y ≤ target_y_tangent

            # From throat connection: R*cos(-90°) = 0 and R*sin(-90°) + yc = 1.0*Rt
            # This gives: yc = 1.0*Rt + R

            # From tangent constraint: R*sin(ea_start) + yc ≤ target_y_tangent
            # Substituting: R*sin(ea_start) + (1.0*Rt + R) ≤ target_y_tangent
            # Solving: R*(sin(ea_start) + 1) ≤ target_y_tangent - 1.0*Rt
            # Therefore: R ≤ (target_y_tangent - 1.0*Rt) / (sin(ea_start) + 1)

            sin_ea_start = math.sin(ea_start)
            denominator = sin_ea_start + 1.0

            if denominator > 0.1:  # Avoid division by small numbers
                R1_max = (target_y_tangent - throat_connection_y) / denominator

                # Use the smaller of classical scaled radius and constraint-based radius
                R1_scaled = R1_classical * scale_factor
                R1 = min(R1_scaled, R1_max) if R1_max > 0 else R1_scaled

                # Ensure minimum reasonable radius
                R1 = max(R1, 0.2 * throat_radius)

                # Calculate center to ensure throat connection
                yc1 = throat_connection_y + R1

            else:
                # For extreme angles, use conservative scaling
                R1 = R1_classical * min(scale_factor, 0.5)
                yc1 = yc1_classical * min(scale_factor, 0.5)

            # Verify the geometry makes sense
            test_y_at_start = R1 * sin_ea_start + yc1
            test_y_at_throat = (
                R1 * math.sin(-math.pi / 2) + yc1
            )  # Should be throat_connection_y

            # ALWAYS ensure perfect throat connection (highest priority)
            if abs(test_y_at_throat - throat_connection_y) > 0.001 * throat_radius:
                yc1 = throat_connection_y + R1
                # Recalculate start point after throat correction
                test_y_at_start = R1 * sin_ea_start + yc1

            # For normal cases, try to stay within bounds. For extreme cases, accept overshoot
            final_y_at_start = R1 * sin_ea_start + yc1
            if not geometric_impossibility and abs(final_y_at_start) > target_y_tangent:
                # Only reduce radius if not in extreme case
                reduction_factor = target_y_tangent / abs(final_y_at_start)
                R1 *= reduction_factor
                yc1 = throat_connection_y + R1

            # Final verification: Check if continuity is achieved
            final_throat_y = R1 * math.sin(-math.pi / 2) + yc1
            continuity_error = abs(final_throat_y - throat_connection_y)

            if continuity_error > 0.01 * throat_radius:
                # Last resort: Force continuity even if it breaks other constraints
                print(f"Warning: Forcing continuity (error was {continuity_error:.6f})")
                yc1 = throat_connection_y + R1
        else:
            # Classical geometry works fine
            R1 = R1_classical
            yc1 = yc1_classical
    elif alpha_deg is not None:
        # Only alpha provided, use classical with tangent angle
        ea_start = np.radians(-90 - alpha_deg)
        R1 = 1.5 * throat_radius
        yc1 = 2.5 * throat_radius
    else:
        # Original behavior for backward compatibility
        entrant_angle = -135
        ea_start = math.radians(entrant_angle)
        R1 = 1.5 * throat_radius
        yc1 = 2.5 * throat_radius

    data_interval = 100
    # First circular arc (inlet)
    ea_end = -math.pi / 2
    angle_list = np.linspace(ea_start, ea_end, data_interval)
    xe_orig = [R1 * math.cos(i) for i in angle_list]
    ye_orig = [R1 * math.sin(i) + yc1 for i in angle_list]

    # Second circular arc (throat)
    ea2_start = -math.pi / 2
    ea2_end = theta_n - math.pi / 2
    angle_list = np.linspace(ea2_start, ea2_end, data_interval)
    xe2_orig = [0.382 * throat_radius * math.cos(i) for i in angle_list]
    ye2_orig = [
        0.382 * throat_radius * math.sin(i) + 1.382 * throat_radius for i in angle_list
    ]

    # Points for the quadratic Bezier curve (bell section)
    Nx_orig = 0.382 * throat_radius * math.cos(theta_n - math.pi / 2)
    Ny_orig = (
        0.382 * throat_radius * math.sin(theta_n - math.pi / 2) + 1.382 * throat_radius
    )
    Ex_orig = nozzle_length
    Ey_orig = math.sqrt(aratio) * throat_radius

    # Control point for the Bezier curve
    m1 = math.tan(theta_n)
    m2 = math.tan(theta_e)
    # Check for m1 being close to m2 to avoid division by zero
    if abs(m1 - m2) < 1e-9:
        m2 += 1e-9

    C1 = Ny_orig - m1 * Nx_orig
    C2 = Ey_orig - m2 * Ex_orig
    Qx_orig = (C2 - C1) / (m1 - m2)
    Qy_orig = (m1 * C2 - m2 * C1) / (m1 - m2)

    # Generate points for the Bezier curve
    t_list = np.linspace(0, 1, data_interval)
    xbell_orig = [
        ((1 - t) ** 2) * Nx_orig + 2 * (1 - t) * t * Qx_orig + (t**2) * Ex_orig
        for t in t_list
    ]
    ybell_orig = [
        ((1 - t) ** 2) * Ny_orig + 2 * (1 - t) * t * Qy_orig + (t**2) * Ey_orig
        for t in t_list
    ]

    # Shift all x-coordinates so the nozzle throat is at x=0
    x_shift = 0.0  # Throat is the origin for the nozzle part

    xe = [x + x_shift for x in xe_orig]
    xe2 = [x + x_shift for x in xe2_orig]
    xbell = [x + x_shift for x in xbell_orig]

    shifted_throat_x = 0.0 + x_shift
    # This is the "start" of the nozzle section relative to the throat at x=0
    shifted_inlet_x = xe_orig[0] if xe_orig else shifted_throat_x
    shifted_exit_x = xbell[-1] if xbell else shifted_throat_x

    nye = [-y for y in ye_orig]
    nye2 = [-y for y in ye2_orig]
    nybell = [-y for y in ybell_orig]

    contour_data = (
        xe_orig,
        ye_orig,
        nye,
        xe2_orig,
        ye2_orig,
        nye2,
        xbell_orig,
        ybell_orig,
        nybell,
    )

    return (
        angles,
        contour_data,
        x_shift,
        shifted_throat_x,
        shifted_inlet_x,
        shifted_exit_x,
    )


# Plot styling constants
PLOT_STYLE = {
    "FONT_SIZE": 7.5,
    "CURVE_LW": 1.0,
    "ANNOT_LW": 0.8,
    "ARROW_COLOR": "grey",
    "ANGLE_COLOR": "purple",
}


def _extract_geometry_data(results):
    """Extract geometry data from results dictionary."""
    chamber_data = {
        "Rc": results["chamber_Rc"],
        "Lc": results["chamber_Lc"],
        "L_cone": results["chamber_L_cone"],
        "x_cone_end": results["chamber_x_cone_end"],
        "Ri_chamber": results["chamber_Ri"],
        "alpha_deg": results["alpha_deg"],
    }

    nozzle_data = {
        "throat_radius": results["throat_radius"],
        "angles": results["angles_data"],
        "contour": results["contour_data"],
        "shifted_throat_x": results["shifted_throat_x"],
        "shifted_inlet_x": results["shifted_inlet_x"],
    }

    return chamber_data, nozzle_data


def _plot_combustion_chamber(ax, chamber_data):
    """Plot the combustion chamber geometry."""
    Rc = chamber_data["Rc"]
    Lc = chamber_data["Lc"]
    x_cone_end = chamber_data["x_cone_end"]
    Ri_chamber = chamber_data["Ri_chamber"]

    # Define chamber geometry points
    x_chamber_upper = [0.0, Lc, x_cone_end]
    y_chamber_upper = [Rc, Rc, Ri_chamber]
    x_chamber_lower = x_chamber_upper
    y_chamber_lower = [-y for y in y_chamber_upper]

    # Plot chamber walls
    ax.plot(
        x_chamber_upper,
        y_chamber_upper,
        color="black",
        linewidth=PLOT_STYLE["CURVE_LW"],
        linestyle="dotted",
    )
    ax.plot(
        x_chamber_lower,
        y_chamber_lower,
        color="black",
        linewidth=PLOT_STYLE["CURVE_LW"],
        linestyle="dotted",
    )
    ax.plot(
        [0.0, 0.0],
        [y_chamber_upper[0], y_chamber_lower[0]],
        color="black",
        linewidth=PLOT_STYLE["CURVE_LW"],
        linestyle="dotted",
    )


def _plot_nozzle_contour(ax, nozzle_data, x_offset):
    """Plot the bell nozzle contour with proper offset."""
    contour = nozzle_data["contour"]
    (
        xe_orig,
        ye_orig,
        nye_orig,
        xe2_orig,
        ye2_orig,
        nye2_orig,
        xbell_orig,
        ybell_orig,
        nybell_orig,
    ) = contour

    # Apply offset to x-coordinates
    xe = [x + x_offset for x in xe_orig] if xe_orig else []
    xe2 = [x + x_offset for x in xe2_orig] if xe2_orig else []
    xbell = [x + x_offset for x in xbell_orig] if xbell_orig else []

    # Plot nozzle sections with different colors
    if xe and ye_orig:
        ax.plot(xe, ye_orig, linewidth=PLOT_STYLE["CURVE_LW"], color="g")
        ax.plot(xe, nye_orig, linewidth=PLOT_STYLE["CURVE_LW"], color="g")
    if xe2 and ye2_orig:
        ax.plot(xe2, ye2_orig, linewidth=PLOT_STYLE["CURVE_LW"], color="r")
        ax.plot(xe2, nye2_orig, linewidth=PLOT_STYLE["CURVE_LW"], color="r")
    if xbell and ybell_orig:
        ax.plot(xbell, ybell_orig, linewidth=PLOT_STYLE["CURVE_LW"], color="b")
        ax.plot(xbell, nybell_orig, linewidth=PLOT_STYLE["CURVE_LW"], color="b")

    return xe, xe2, xbell


def _add_length_annotations(
    ax, chamber_data, shifted_throat_x, shifted_inlet_x, shifted_exit_x
):
    """Add length dimension annotations to the plot."""
    Lc = chamber_data["Lc"]
    L_cone = chamber_data["L_cone"]
    x_cone_end = chamber_data["x_cone_end"]
    Rc = chamber_data["Rc"]

    y_text_offset = Rc * 0.08

    # Chamber length annotation
    lc_text = rf"$L_c = L^* / \epsilon_c = {Lc:.2f}$ m"
    ax.annotate(
        "",
        xy=(0, 0),
        xytext=(Lc, 0),
        arrowprops=dict(
            arrowstyle="<->", color=PLOT_STYLE["ARROW_COLOR"], lw=PLOT_STYLE["ANNOT_LW"]
        ),
    )
    ax.text(
        Lc / 2,
        y_text_offset,
        lc_text,
        ha="center",
        va="center",
        fontsize=PLOT_STYLE["FONT_SIZE"],
    )

    # Cone length annotation
    lcone_text = rf"$L_{{cone}} = \frac{{R_c - R_i}}{{\tan(\alpha)}} = {L_cone:.2f}$ m"
    ax.annotate(
        "",
        xy=(Lc, 0),
        xytext=(x_cone_end, 0),
        arrowprops=dict(
            arrowstyle="<->", color=PLOT_STYLE["ARROW_COLOR"], lw=PLOT_STYLE["ANNOT_LW"]
        ),
    )
    ax.text(
        (Lc + x_cone_end) / 2,
        -y_text_offset,
        lcone_text,
        ha="center",
        va="center",
        fontsize=PLOT_STYLE["FONT_SIZE"],
    )

    # Nozzle inlet length annotation
    Li_val = abs(shifted_throat_x - shifted_inlet_x)
    li_text = f"$L_i = {Li_val:.3f}$ m"
    ax.annotate(
        "",
        xy=(shifted_inlet_x, 0),
        xytext=(shifted_throat_x, 0),
        arrowprops=dict(
            arrowstyle="<->", color=PLOT_STYLE["ARROW_COLOR"], lw=PLOT_STYLE["ANNOT_LW"]
        ),
    )
    ax.text(
        (shifted_inlet_x + shifted_throat_x) / 2,
        y_text_offset,
        li_text,
        fontsize=PLOT_STYLE["FONT_SIZE"],
        ha="center",
        va="center",
    )

    # Nozzle length annotation
    Ln_val = abs(shifted_exit_x - shifted_throat_x)
    ln_text = f"$L_n = {Ln_val:.3f}$ m"
    ax.annotate(
        "",
        xy=(shifted_throat_x, 0),
        xytext=(shifted_exit_x, 0),
        arrowprops=dict(
            arrowstyle="<->", color=PLOT_STYLE["ARROW_COLOR"], lw=PLOT_STYLE["ANNOT_LW"]
        ),
    )
    ax.text(
        (shifted_exit_x + shifted_throat_x) / 2,
        -y_text_offset,
        ln_text,
        fontsize=PLOT_STYLE["FONT_SIZE"],
        ha="center",
        va="center",
    )


def _add_radius_annotations(
    ax,
    chamber_data,
    nozzle_data,
    shifted_throat_x,
    shifted_exit_x,
    xbell_orig,
    ybell_orig,
):
    """Add radius dimension annotations to the plot."""
    Rc = chamber_data["Rc"]
    Lc = chamber_data["Lc"]
    throat_radius = nozzle_data["throat_radius"]

    # Chamber radius annotation
    x_dim_line_rc = -Lc * 0.1
    ax.annotate(
        "",
        xy=(x_dim_line_rc, 0),
        xytext=(x_dim_line_rc, Rc),
        arrowprops=dict(
            arrowstyle="<->", color=PLOT_STYLE["ARROW_COLOR"], lw=PLOT_STYLE["ANNOT_LW"]
        ),
    )
    rc_text = rf"$R_c = R_t \sqrt{{\epsilon_c}} = {Rc:.2f}$ m"
    ax.text(
        x_dim_line_rc - 0.01,
        Rc / 2,
        rc_text,
        rotation="vertical",
        ha="right",
        va="center",
        fontsize=PLOT_STYLE["FONT_SIZE"],
    )

    # Throat radius annotation
    if throat_radius > 0:
        text = f"$R_t = {throat_radius:.3f}$ m"
        ax.annotate(
            text,
            xy=(shifted_throat_x, throat_radius),
            xytext=(shifted_throat_x, throat_radius + Rc * 0.2),
            arrowprops=dict(
                arrowstyle="->",
                color=PLOT_STYLE["ARROW_COLOR"],
                lw=PLOT_STYLE["ANNOT_LW"],
            ),
            fontsize=PLOT_STYLE["FONT_SIZE"],
            ha="center",
        )

    # Exit radius annotation
    if xbell_orig and ybell_orig:
        Re_val = abs(ybell_orig[-1])
        text = f"$R_e = {Re_val:.3f}$ m"
        ax.annotate(
            text,
            xy=(shifted_exit_x, Re_val),
            xytext=(shifted_exit_x, Re_val + Rc * 0.1),
            arrowprops=dict(
                arrowstyle="->",
                color=PLOT_STYLE["ARROW_COLOR"],
                lw=PLOT_STYLE["ANNOT_LW"],
            ),
            fontsize=PLOT_STYLE["FONT_SIZE"],
            ha="center",
        )


def _add_angle_annotations(
    ax,
    chamber_data,
    nozzle_data,
    shifted_throat_x,
    shifted_exit_x,
    xbell_orig,
    ybell_orig,
):
    """Add angle annotations to the plot."""
    alpha_deg = chamber_data["alpha_deg"]
    Rc = chamber_data["Rc"]
    Lc = chamber_data["Lc"]
    throat_radius = nozzle_data["throat_radius"]
    angles = nozzle_data["angles"]

    _, theta_n_rad, theta_e_rad = angles

    # Chamber angle annotation
    draw_angle_arc(
        ax,
        np.radians(-alpha_deg),
        (Lc, Rc),
        rf"$\alpha={alpha_deg}^\circ$",
        font_size=PLOT_STYLE["FONT_SIZE"],
        color=PLOT_STYLE["ANGLE_COLOR"],
        lw=PLOT_STYLE["ANNOT_LW"],
        is_upper=False,
    )

    # Nozzle throat angle annotation
    draw_angle_arc(
        ax,
        theta_n_rad,
        (shifted_throat_x, throat_radius),
        rf"$\theta_n={math.degrees(theta_n_rad):.1f}^\circ$",
        font_size=PLOT_STYLE["FONT_SIZE"],
        color=PLOT_STYLE["ANGLE_COLOR"],
        lw=PLOT_STYLE["ANNOT_LW"],
    )

    # Nozzle exit angle annotation
    if xbell_orig and ybell_orig:
        draw_angle_arc(
            ax,
            theta_e_rad,
            (shifted_exit_x, ybell_orig[-1]),
            rf"$\theta_e={math.degrees(theta_e_rad):.1f}^\circ$",
            font_size=PLOT_STYLE["FONT_SIZE"],
            color=PLOT_STYLE["ANGLE_COLOR"],
            lw=PLOT_STYLE["ANNOT_LW"],
        )


def _finalize_plot(ax, title):
    """Apply final plot formatting and styling."""
    ax.axhline(0, color="black", lw=0.8)
    ax.grid(True, which="major", linestyle="--", linewidth="0.5", alpha=0.5)
    ax.minorticks_on()
    ax.set_title(title, fontsize=PLOT_STYLE["FONT_SIZE"] + 4)
    ax.set_xlabel("Axial Distance [m]", fontsize=PLOT_STYLE["FONT_SIZE"] + 2)
    ax.set_ylabel("Radius [m]", fontsize=PLOT_STYLE["FONT_SIZE"] + 2)
    ax.tick_params(axis="both", which="major", labelsize=PLOT_STYLE["FONT_SIZE"])
    ax.set_aspect("equal", adjustable="box")


def plot_geometry(ax, title, results):
    """Plot both the combustion chamber and bell nozzle geometry."""
    chamber_data, nozzle_data = _extract_geometry_data(results)

    # Plot combustion chamber
    _plot_combustion_chamber(ax, chamber_data)

    # Calculate nozzle offset and plot nozzle contour
    x_offset = chamber_data["x_cone_end"] - nozzle_data["shifted_inlet_x"]
    xe, xe2, xbell = _plot_nozzle_contour(ax, nozzle_data, x_offset)

    # Calculate shifted positions for annotations
    shifted_throat_x = nozzle_data["shifted_throat_x"] + x_offset
    shifted_inlet_x = nozzle_data["shifted_inlet_x"] + x_offset
    contour = nozzle_data["contour"]
    xbell_orig = contour[6]  # xbell_orig from contour tuple
    ybell_orig = contour[7]  # ybell_orig from contour tuple
    shifted_exit_x = (xbell_orig[-1] + x_offset) if xbell_orig else shifted_throat_x

    # Add annotations
    _add_length_annotations(
        ax, chamber_data, shifted_throat_x, shifted_inlet_x, shifted_exit_x
    )
    _add_radius_annotations(
        ax,
        chamber_data,
        nozzle_data,
        shifted_throat_x,
        shifted_exit_x,
        xbell_orig,
        ybell_orig,
    )
    _add_angle_annotations(
        ax,
        chamber_data,
        nozzle_data,
        shifted_throat_x,
        shifted_exit_x,
        xbell_orig,
        ybell_orig,
    )

    # Add reference line at throat
    ax.axvline(chamber_data["x_cone_end"], color="black", lw=0.5, linestyle="dashed")

    # Finalize plot styling
    _finalize_plot(ax, title)


def draw_angle_arc(
    ax, angle_rad, origin, text, font_size=5.5, color="purple", lw=1.0, is_upper=True
):
    angle_deg = math.degrees(angle_rad)
    arc_radius = (ax.get_xlim()[1] - ax.get_xlim()[0]) * 0.05

    if is_upper:
        ax.plot(
            [origin[0], origin[0] + arc_radius * 1.5],
            [origin[1], origin[1]],
            color=color,
            linestyle="--",
            lw=lw,
        )
        arc = Arc(
            origin,
            width=arc_radius * 2,
            height=arc_radius * 2,
            angle=0,
            theta1=0,
            theta2=angle_deg,
            color=color,
            lw=lw,
        )
        text_angle = angle_rad / 2
    else:  # For alpha, drawn below the reference line
        ax.plot(
            [origin[0], origin[0] + arc_radius * 1.5],
            [origin[1], origin[1]],
            color=color,
            linestyle="--",
            lw=lw,
        )
        arc = Arc(
            origin,
            width=arc_radius * 2,
            height=arc_radius * 2,
            angle=0,
            theta1=angle_deg,
            theta2=0,
            color=color,
            lw=lw,
        )
        text_angle = angle_rad / 2

    ax.add_patch(arc)

    text_radius = arc_radius * 1.3
    text_x = origin[0] + text_radius * math.cos(text_angle)
    text_y = origin[1] + text_radius * math.sin(text_angle)

    ha = "left" if math.cos(text_angle) > 0 else "right"
    va = "bottom" if math.sin(text_angle) > 0 else "top"

    ax.text(text_x, text_y, text, fontsize=font_size, ha=ha, va=va, color=color)


def plot(title, results):
    # Create a figure with a dedicated button bar below the chart
    fig = plt.figure(figsize=(14, 8))
    try:
        gs = fig.add_gridspec(nrows=2, ncols=1, height_ratios=[12, 1], hspace=0.12)
        ax1 = fig.add_subplot(gs[0, 0])
        ax_bar = fig.add_subplot(gs[1, 0])
        ax_bar.axis("off")
    except Exception:
        # Fallback to a single subplot if GridSpec fails
        fig, ax1 = plt.subplots(figsize=(14, 8))
        ax_bar = None

    plot_geometry(ax1, title, results)

    # Adjust axis to make sure everything is shown
    ax1.autoscale_view()
    ax1.margins(0.15)

    # Re-apply equal aspect ratio after margin adjustments
    ax1.set_aspect("equal", adjustable="box")

    # Helpers to collect geometry points and to draw/remove point markers + labels
    def _collect_geometry_rows():
        rows = []
        try:
            Rc = results["chamber_Rc"]
            Lc = results["chamber_Lc"]
            x_cone_end = results["chamber_x_cone_end"]
            Ri_chamber = results["chamber_Ri"]

            contour = results["contour_data"]
            shifted_inlet_x = results["shifted_inlet_x"]
            # For offset alignment with main plot
            x_offset = x_cone_end - shifted_inlet_x
        except Exception:
            return rows

        def add_curve(xs, ys, part, side, color):
            if xs is None or ys is None:
                return
            for x, y in zip(xs, ys):
                rows.append(
                    {
                        "x": float(x),
                        "y": float(y),
                        "part": part,
                        "side": side,
                        "color": color,
                    }
                )

        # Chamber walls
        x_chamber = [0.0, Lc, x_cone_end]
        y_chamber_upper = [Rc, Rc, Ri_chamber]
        y_chamber_lower = [-y for y in y_chamber_upper]
        add_curve(x_chamber, y_chamber_upper, "Chamber wall", "upper", "black")
        add_curve(x_chamber, y_chamber_lower, "Chamber wall", "lower", "black")
        # Chamber inlet face (vertical line at x=0)
        add_curve([0.0], [Rc], "Chamber inlet face", "upper", "black")
        add_curve([0.0], [-Rc], "Chamber inlet face", "lower", "black")

        # Nozzle contours
        try:
            (
                xe_orig,
                ye_orig,
                nye_orig,
                xe2_orig,
                ye2_orig,
                nye2_orig,
                xbell_orig,
                ybell_orig,
                nybell_orig,
            ) = contour
        except Exception:
            xe_orig = ye_orig = nye_orig = xe2_orig = ye2_orig = nye2_orig = (
                xbell_orig
            ) = ybell_orig = nybell_orig = []

        # Apply the same x-offset used in plotting
        xe = [(x + x_offset) for x in (xe_orig or [])]
        xe2 = [(x + x_offset) for x in (xe2_orig or [])]
        xbell = [(x + x_offset) for x in (xbell_orig or [])]

        # Inlet arc (green)
        add_curve(xe, ye_orig or [], "Nozzle inlet arc", "upper", "green")
        add_curve(xe, (nye_orig or []), "Nozzle inlet arc", "lower", "green")
        # Throat arc (red)
        add_curve(xe2, (ye2_orig or []), "Nozzle throat arc", "upper", "red")
        add_curve(xe2, (nye2_orig or []), "Nozzle throat arc", "lower", "red")
        # Bell (blue)
        add_curve(xbell, (ybell_orig or []), "Nozzle bell", "upper", "blue")
        add_curve(xbell, (nybell_orig or []), "Nozzle bell", "lower", "blue")

        return rows

    point_artists = {
        "scatters": [],
        "labels": [],
        "hidden_texts": [],  # store text/annotation artists hidden while points are shown
        "visible": False,
    }

    def _decimate_rows_by_dx(rows, dx=0.05):
        # Group by (part, side) so spacing applies within each curve
        grouped = {}
        for r in rows:
            key = (r.get("part"), r.get("side"))
            grouped.setdefault(key, []).append(r)

        decimated = []
        for key, items in grouped.items():
            # Sort by x ascending to apply left-to-right spacing
            items_sorted = sorted(items, key=lambda d: d.get("x", 0.0))
            last_x = None
            for d in items_sorted:
                x = d.get("x", 0.0)
                if last_x is None or (x - last_x) >= dx:
                    decimated.append(d)
                    last_x = x
        return decimated

    def _show_points_with_labels():
        if point_artists["visible"]:
            return
        rows = _collect_geometry_rows()
        if not rows:
            return
        # Hide other text labels on the chart (annotations, titles, axis labels)
        try:
            to_hide = []
            for t in list(ax1.texts):
                if t.get_visible():
                    to_hide.append(t)
            # Axis labels and title text objects
            try:
                xl = ax1.get_xaxis().get_label()
                if xl.get_visible():
                    to_hide.append(xl)
            except Exception:
                pass
            try:
                yl = ax1.get_yaxis().get_label()
                if yl.get_visible():
                    to_hide.append(yl)
            except Exception:
                pass
            try:
                # Matplotlib stores title Text as ax.title
                title_obj = ax1.title
                if getattr(title_obj, "get_visible", lambda: False)():
                    to_hide.append(title_obj)
            except Exception:
                pass
            for artist in to_hide:
                try:
                    artist.set_visible(False)
                except Exception:
                    pass
            point_artists["hidden_texts"] = to_hide
        except Exception:
            point_artists["hidden_texts"] = []
        # Only show points spaced by at least 0.05 along x within each curve
        rows = _decimate_rows_by_dx(rows, dx=0.05)
        # Make value labels 30% larger for readability
        label_font = 7
        # Offset labels to the right and slightly down for clarity (smaller offsets)
        try:
            x_min, x_max = ax1.get_xlim()
            dx_label = 0.01 * (x_max - x_min)
            y_min, y_max = ax1.get_ylim()
            dy_label = 0.005 * (y_max - y_min)
        except Exception:
            dx_label = 0.01
            dy_label = 0.005
        for r in rows:
            sc = ax1.plot(
                r["x"],
                r["y"],
                marker="o",
                markersize=2.5,
                linestyle="None",
                color=r["color"],
                alpha=0.9,
            )[0]
            # Place throat arc (red area) labels above the point; others below
            is_red = (str(r.get("color", "")).lower() == "red") or (
                str(r.get("part", "")) == "Nozzle throat arc"
            )
            y_text = (r["y"] + dy_label) if is_red else (r["y"] - dy_label)
            va_text = "bottom" if is_red else "top"

            txt = ax1.text(
                r["x"] + dx_label,
                y_text,
                f"({r['x']:.3f}, {r['y']:.3f})",
                fontsize=label_font,
                color="#222222",
                ha="left",
                va=va_text,
            )
            point_artists["scatters"].append(sc)
            point_artists["labels"].append(txt)
        point_artists["visible"] = True
        try:
            fig.canvas.draw_idle()
        except Exception:
            pass

    def _hide_points_with_labels():
        if not point_artists["visible"]:
            return
        for a in point_artists["scatters"]:
            try:
                a.remove()
            except Exception:
                pass
        for t in point_artists["labels"]:
            try:
                t.remove()
            except Exception:
                pass
        point_artists["scatters"].clear()
        point_artists["labels"].clear()
        point_artists["visible"] = False
        # Restore previously hidden text/annotation artists
        try:
            for artist in point_artists.get("hidden_texts", []):
                try:
                    artist.set_visible(True)
                except Exception:
                    pass
        except Exception:
            pass
        point_artists["hidden_texts"] = []
        try:
            fig.canvas.draw_idle()
        except Exception:
            pass

    # Apply layout, then place buttons using the finalized subplot positions
    try:
        fig.tight_layout(pad=1.5)
    except Exception:
        pass

    # Build the bottom button bar (below chart), after layout is applied
    try:
        if ax_bar is not None:
            bbox = ax_bar.get_position()
        else:
            bbox = type(
                "B", (), {"x0": 0.1, "y0": 0.02, "width": 0.8, "height": 0.08}
            )()

        x0, y0, w, h = bbox.x0, bbox.y0, bbox.width, bbox.height
        btn_h = max(0.5 * h, 0.05)
        btn_y = y0 + (h - btn_h) / 2.0

        # Export button (green)
        exp_w = min(0.22 * w, 0.22)
        exp_x = x0 + 0.02 * w
        export_ax = fig.add_axes([exp_x, btn_y, exp_w, btn_h])
        # Ensure the button axes sit above other axes for event handling
        try:
            export_ax.set_zorder(100)
        except Exception:
            pass
        export_btn = Button(
            export_ax, "Export CSV", color="#2ea44f", hovercolor="#2c974b"
        )
        try:
            export_btn.label.set_color("white")
        except Exception:
            pass

        # Show/Hide points buttons
        btn_gap = 0.02 * w
        show_w = min(0.19 * w, 0.22)
        hide_w = min(0.19 * w, 0.22)
        show_x = exp_x + exp_w + 0.025 * w
        hide_x = show_x + show_w + btn_gap

        # Show button (blue)
        show_ax = fig.add_axes([show_x, btn_y, show_w, btn_h])
        try:
            show_ax.set_zorder(100)
        except Exception:
            pass
        show_btn = Button(
            show_ax, "Show Data Points", color="#1f6feb", hovercolor="#1a5fd0"
        )
        try:
            show_btn.label.set_color("white")
        except Exception:
            pass

        # Hide button (neutral gray)
        hide_ax = fig.add_axes([hide_x, btn_y, hide_w, btn_h])
        try:
            hide_ax.set_zorder(100)
        except Exception:
            pass
        hide_btn = Button(
            hide_ax, "Hide Data Points", color="#6a737d", hovercolor="#586069"
        )
        try:
            hide_btn.label.set_color("white")
        except Exception:
            pass

        def _export_points_to_csv(event=None):
            rows = _collect_geometry_rows()
            if not rows:
                print("No geometry data to export")
                return

            # Ask user for filename via static Qt file dialog for reliability
            filepath = None
            try:
                from PySide6.QtWidgets import QApplication, QFileDialog

                # Ensure we have a QApplication instance
                app = QApplication.instance()
                if app is None:
                    print("No QApplication found, using default filename")
                    filepath = "nozzle_geometry_points.csv"
                else:
                    # Get the parent window more reliably
                    parent = None
                    try:
                        # Try to get the matplotlib figure's window as parent
                        if hasattr(fig.canvas, "manager") and hasattr(
                            fig.canvas.manager, "window"
                        ):
                            parent = fig.canvas.manager.window
                        else:
                            parent = QApplication.activeWindow()
                    except Exception:
                        parent = None

                    # Show the file dialog
                    fname, _ = QFileDialog.getSaveFileName(
                        parent,
                        "Save Nozzle Geometry Points",
                        "nozzle_geometry_points.csv",
                        "CSV Files (*.csv);;All Files (*)",
                    )

                    if fname:
                        filepath = fname
                    else:
                        print("Export cancelled by user")
                        return

            except Exception as e:
                print(f"Export CSV dialog error: {e}")
                # Show a message to user about the error
                try:
                    from PySide6.QtWidgets import QMessageBox

                    QMessageBox.warning(
                        None,
                        "Export Error",
                        f"Could not show file dialog: {e}\nSaving to default filename.",
                    )
                except Exception:
                    pass
                filepath = "nozzle_geometry_points.csv"

            if not filepath:
                print("No filepath selected")
                return

            try:
                with open(filepath, "w", newline="", encoding="utf-8") as f:
                    writer = csv.DictWriter(
                        f, fieldnames=["x", "y", "part", "side", "color"]
                    )
                    writer.writeheader()
                    for r in rows:
                        writer.writerow(r)
                print(f"Successfully exported {len(rows)} nozzle points to: {filepath}")

                # Show success message to user
                try:
                    from PySide6.QtWidgets import QMessageBox

                    QMessageBox.information(
                        None,
                        "Export Complete",
                        f"Successfully exported {len(rows)} geometry points to:\n{filepath}",
                    )
                except Exception:
                    pass

            except Exception as e:
                print(f"Failed to export CSV: {e}")
                # Show error message to user
                try:
                    from PySide6.QtWidgets import QMessageBox

                    QMessageBox.critical(
                        None, "Export Failed", f"Failed to save file: {e}"
                    )
                except Exception:
                    pass

        # Primary callbacks via Matplotlib widgets API
        export_btn.on_clicked(_export_points_to_csv)
        show_btn.on_clicked(lambda evt=None: _show_points_with_labels())
        hide_btn.on_clicked(lambda evt=None: _hide_points_with_labels())

        # Fallback: figure-level event handlers to ensure clicks/hover work
        # even if another axes accidentally grabs events.
        def _fig_click(event):
            try:
                if event.inaxes is export_ax:
                    _export_points_to_csv(event)
                elif event.inaxes is show_ax:
                    _show_points_with_labels()
                elif event.inaxes is hide_ax:
                    _hide_points_with_labels()
            except Exception:
                pass

        def _fig_motion(event):
            # Manually apply hover color if Matplotlib widget hover isn’t firing
            try:
                if event.inaxes is export_ax:
                    export_ax.set_facecolor("#2c974b")
                else:
                    export_ax.set_facecolor("#2ea44f")
                if event.inaxes is show_ax:
                    show_ax.set_facecolor("#1a5fd0")
                else:
                    show_ax.set_facecolor("#1f6feb")
                if event.inaxes is hide_ax:
                    hide_ax.set_facecolor("#586069")
                else:
                    hide_ax.set_facecolor("#6a737d")
                fig.canvas.draw_idle()
            except Exception:
                pass

        try:
            fig.canvas.mpl_connect("button_press_event", _fig_click)
            fig.canvas.mpl_connect("motion_notify_event", _fig_motion)
        except Exception:
            pass
    except Exception:
        pass
    return fig
