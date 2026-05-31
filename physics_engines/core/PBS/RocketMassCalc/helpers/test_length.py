import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Arc # Import the Arc class for angle annotation

# -----------------------------
# INPUT PARAMETERS
# -----------------------------
# You can adjust these values to change the chamber's geometry.
# The cone section is now calculated based on the angle.
Epsilon_c = 2
Rt = 0.3
L_star = 1
Ri = 0.12        # Throat radius (radius at the end of the cone) [m]
alpha_deg = 45  # <<--- CHANGE THIS ANGLE for the converging cone

# -----------------------------
# CALCULATIONS
# -----------------------------
# These equations will be displayed as annotations on the plot.
Rc = Rt * np.sqrt(Epsilon_c)      # Chamber radius [m]
Lc = L_star / Epsilon_c           # Length of the cylindrical part [m]
alpha_rad = np.radians(alpha_deg)
L_cone = (Rc - Ri) / np.tan(alpha_rad)
x_cone_end = Lc + L_cone

# -----------------------------
# GEOMETRY CREATION
# -----------------------------
# Define the coordinates for the chamber's outline using the calculated values.
x_upper = [0.0, Lc, x_cone_end]
y_upper = [Rc, Rc, Ri]
x_lower = x_upper
y_lower = [-y for y in y_upper]

# -----------------------------
# PLOT
# -----------------------------
fig, ax = plt.subplots(figsize=(12, 7))

# Plot the chamber outline with a dotted line style
ax.plot(x_upper, y_upper, color='black', linewidth=2.5, linestyle=':')
ax.plot(x_lower, y_lower, color='black', linewidth=2.5, linestyle=':')
ax.plot([0.0, 0.0], [y_upper[0], y_lower[0]], color='black', linewidth=2.5, linestyle=':')

# -----------------------------
# ANNOTATIONS WITH EQUATIONS
# -----------------------------
# Add dimension lines and text labels that include the calculation formulas.

# --- Annotate Lc (Cylindrical Length) - ON AXIS ---
lc_text = fr'$L_c = L^* / \epsilon_c = {Lc:.2f}$ m'
# The dimension line is now on the y=0 axis
ax.annotate('', xy=(0, 0), xytext=(Lc, 0),
            arrowprops=dict(arrowstyle='<->', color='green', lw=1.5, shrinkA=0, shrinkB=0))
# Place text slightly ABOVE the axis line
ax.text(Lc / 2, 0.01, lc_text,
        ha='center', va='bottom', fontsize=11, color='green')

# --- Annotate L_cone (Cone Length) - ON AXIS ---
lcone_text = fr'$L_{{cone}} = \frac{{R_c - R_i}}{{\tan(\alpha)}} = {L_cone:.2f}$ m'
# The dimension line is also on the y=0 axis
ax.annotate('', xy=(Lc, 0), xytext=(x_cone_end, 0),
            arrowprops=dict(arrowstyle='<->', color='red', lw=1.5, shrinkA=0, shrinkB=0))
# Place text slightly BELOW the axis line to avoid overlap
ax.text((Lc + x_cone_end) / 2, -0.01, lcone_text,
        ha='center', va='top', fontsize=11, color='red')

# --- Annotate Rc (Chamber Radius) ---
x_dim_line = -Lc * 0.25
rc_text = fr'$R_c = R_t \sqrt{{\epsilon_c}} = {Rc:.2f}$ m'
ax.annotate('', xy=(x_dim_line, 0), xytext=(x_dim_line, Rc),
            arrowprops=dict(arrowstyle='<->', color='blue', lw=1.5))
ax.text(x_dim_line - 0.01, Rc / 2, rc_text,
        ha='right', va='center', rotation=90, fontsize=11, color='blue')

# --- Annotate alpha (Cone Angle) ---
cone_vertex = (Lc, Rc)
helper_line_len = L_cone * 0.6
ax.plot([Lc, Lc + helper_line_len], [Rc, Rc], color='purple', linestyle='--', lw=1)
arc_radius = L_cone * 0.5
angle_arc = Arc(cone_vertex, width=arc_radius, height=arc_radius, angle=0,
                theta1=-alpha_deg, theta2=0, color='purple', lw=1.5, zorder=5)
ax.add_patch(angle_arc)
angle_text_rad = np.radians(-alpha_deg / 2)
text_pos_x = cone_vertex[0] + (arc_radius * 0.6) * np.cos(angle_text_rad)
text_pos_y = cone_vertex[1] + (arc_radius * 0.6) * np.sin(angle_text_rad)
ax.text(text_pos_x, text_pos_y, fr'$\alpha={alpha_deg}^\circ$',
        color='purple', fontsize=12, ha='center', va='center')

# -----------------------------
# PLOT CUSTOMIZATION
# -----------------------------
ax.set_title("Combustion Chamber Geometry (Symmetric)")
ax.set_xlabel("Axial Distance [m]")
ax.set_ylabel("Radius [m]")
ax.set_aspect('equal', adjustable='box')
ax.grid(True, linestyle='--', color='grey', alpha=0.5)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)

# Draw the central axis line more prominently
ax.axhline(0, color='black', lw=0.8)

# Adjust axis limits to fit annotations
ax.set_xlim(x_dim_line - Lc * 0.1, x_cone_end + 0.05)
ax.set_ylim(-Rc * 0.6, Rc + 0.05)

plt.tight_layout(pad=1.0)
plt.show()