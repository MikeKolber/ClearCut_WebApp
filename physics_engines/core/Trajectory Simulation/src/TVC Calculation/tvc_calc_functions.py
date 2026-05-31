import numpy as np
import matplotlib.pyplot as plt

# =============================================================================
# PHYSICS CALCULATIONS
# =============================================================================

def calculate_velocity_direction(alpha_rad, beta_rad):
    """Calculate velocity direction vector in body frame."""
    return np.array([
        np.cos(alpha_rad) * np.cos(beta_rad),
        np.sin(beta_rad),
        np.sin(alpha_rad) * np.cos(beta_rad)
    ])


def calculate_velocity_magnitude(mach, speed_of_sound):
    """Calculate velocity magnitude from Mach number."""
    return mach * speed_of_sound


def calculate_lift_vector(alpha_rad, beta_rad, rho, v_mag, C_L, A_ref):
    """Calculate lift vector in body frame."""
    L_mag = 0.5 * rho * v_mag**2 * C_L * A_ref
    
    L_dir = np.array([
        0.0,
        np.sin(beta_rad),
        -np.sin(alpha_rad) * np.cos(beta_rad)
    ])
    
    norm = np.sqrt(np.sin(beta_rad)**2 + (np.sin(alpha_rad) * np.cos(beta_rad))**2)
    
    if norm < 1e-10:
        return np.array([0.0, 0.0, 0.0])
    
    n_hat = L_dir / norm
    return L_mag * n_hat


def calculate_thrust_vector(F_thrust, theta1_rad, theta2_rad):
    """
    Calculate thrust vector in body frame.
    theta1 = pitch gimbal (about Y), theta2 = yaw gimbal (about Z)
    """
    Ry = np.array([
        [ np.cos(theta1_rad), 0, np.sin(theta1_rad)],
        [ 0,                  1, 0                 ],
        [-np.sin(theta1_rad), 0, np.cos(theta1_rad)]
    ])
    
    Rz = np.array([
        [np.cos(theta2_rad), -np.sin(theta2_rad), 0],
        [np.sin(theta2_rad),  np.cos(theta2_rad), 0],
        [0,                   0,                  1]
    ])
    
    F_engine = np.array([F_thrust, 0, 0])
    return Ry @ Rz @ F_engine


def calculate_torques(L_vec, F_body, d_cp, d_tvc):
    """Calculate aerodynamic and TVC torques."""
    r_cp = np.array([d_cp, 0.0, 0.0])
    r_tvc = np.array([d_tvc, 0.0, 0.0])
    
    tau_aero = np.cross(r_cp, L_vec)
    tau_tvc = np.cross(r_tvc, F_body)
    tau_net = tau_aero + tau_tvc
    
    return tau_aero, tau_tvc, tau_net


def calculate_angular_acceleration(tau_net, omega, I, I_dot=None):
    """Calculate angular acceleration: omega_dot = I^-1 @ (tau - omega x I@omega)"""
    if I_dot is None:
        I_dot = np.zeros((3, 3))
    
    I_inv = np.linalg.inv(I)
    gyroscopic = np.cross(omega, I @ omega)
    inertia_change = I_dot @ omega
    
    return I_inv @ (tau_net - gyroscopic - inertia_change)


# =============================================================================
# SIMULATION
# =============================================================================

def run_simulation(stage, aero, alpha_deg, beta_deg, theta1_deg, theta2_deg, initial_velocity, final_velocity, max_time=None, stage_name=""):
    """
    Run TVC simulation for a single stage.
    
    initial_velocity: velocity at start of stage (m/s)
    final_velocity: velocity at end of stage (m/s)
    
    Returns: dict of time -> {omega, omega_dot, tau_net, propellant_mass, I_dot, mach}
    """
    alpha_rad = np.radians(alpha_deg)
    beta_rad = np.radians(beta_deg)
    theta1_rad = np.radians(theta1_deg)
    theta2_rad = np.radians(theta2_deg)
    
    alpha_total_deg = np.degrees(np.arccos(np.cos(alpha_rad) * np.cos(beta_rad)))
    
    time_steps = stage.time_steps
    if max_time is not None:
        time_steps = time_steps[time_steps <= max_time]
    dt = time_steps[1] - time_steps[0]
    t_max = time_steps[-1]
    
    omega = np.array([0.0, 0.0, 0.0])
    results = {}
    mid_idx = len(time_steps) // 2
    
    for t in time_steps:
        props = stage.get_properties(t)
        
        x_com = props['x_com']
        x_engine = props['x_engine']
        F_thrust = props['F_thrust']
        rho = props['rho']
        speed_of_sound = props['speed_of_sound']
        A_ref = props['A_ref']
        I = props['I']
        I_dot = props['I_dot']
        propellant_mass = props['propellant_mass']
        
        velocity = initial_velocity + (t / t_max) * (final_velocity - initial_velocity)
        mach = velocity / speed_of_sound if speed_of_sound > 0 else 0.0
        mach_lookup = max(0.1, min(mach, 5.0))
        
        C_L, x_cp = aero.get_coefficients(alpha_total_deg, mach_lookup)
        
        d_cp = x_com - x_cp
        d_tvc = x_com - x_engine

        L_vec = calculate_lift_vector(alpha_rad, beta_rad, rho, velocity, C_L, A_ref)
        L_mag = np.linalg.norm(L_vec)
        
        # Print info at start, middle, and end of stage (only for theta=0)
        if theta1_deg == 0 and theta2_deg == 0:
            if t == time_steps[0] or t == time_steps[mid_idx] or t == time_steps[-1]:
                stability = "UNSTABLE" if x_com > x_cp else "STABLE"
                print(f"    [{stage_name}] t={t:.1f}s: L={L_mag:.1f}N, ρ={rho:.4f}, x_cp={x_cp:.2f}, x_com={x_com:.2f}, {stability}")
        
        F_body = calculate_thrust_vector(F_thrust, theta1_rad, theta2_rad)
        tau_aero, tau_tvc, tau_net = calculate_torques(L_vec, F_body, d_cp, d_tvc)
        
        omega_zero = np.array([0.0, 0.0, 0.0])
        omega_dot = calculate_angular_acceleration(tau_net, omega_zero, I, I_dot)
        
        results[t] = {
            'omega': np.degrees(omega).copy(),
            'omega_dot': np.degrees(omega_dot).copy(),
            'tau_net': tau_net.copy(),
            'propellant_mass': propellant_mass,
            'I': np.diag(I).copy(),
            'I_dot': np.diag(I_dot).copy(),
            'mach': mach
        }
        
        omega = omega + omega_dot * dt
    
    return results


# =============================================================================
# PLOTTING
# =============================================================================

def plot_omega_dot_all_axes(results_dict, title_prefix="Stage", alpha_deg=None, beta_deg=None, final_velocity=None):
    """Plot omega_dot vs propellant mass for roll, pitch, and yaw with Mach markers."""
    axis_labels = ['Roll (x)', 'Pitch (y)', 'Yaw (z)']
    
    fig, axes = plt.subplots(3, 1, figsize=(12, 12))
    
    if alpha_deg is not None or beta_deg is not None:
        title_prefix += f" (α={alpha_deg}°, β={beta_deg}°)"
    
    # Get first result set to find Mach-to-propellant mapping
    first_theta = list(results_dict.keys())[0]
    first_results = results_dict[first_theta]
    times = sorted(first_results.keys())
    mach_values = [first_results[t]['mach'] for t in times]
    propellant_all = [first_results[t]['propellant_mass'] for t in times]
    
    # Generate dynamic Mach markers based on actual range (every 0.2)
    mach_min = min(m for m in mach_values if m > 0) if any(m > 0 for m in mach_values) else 0
    mach_max = max(mach_values)
    if mach_max > 0:
        start_marker = int(np.ceil(mach_min / 0.2)) * 0.2
        mach_markers = np.arange(start_marker, mach_max + 0.2, 0.2)
    else:
        mach_markers = []
    
    for axis in range(3):
        for theta_deg, results in results_dict.items():
            t_list = sorted(results.keys())
            propellant_values = [results[t]['propellant_mass'] for t in t_list]
            omega_dot_values = [results[t]['omega_dot'][axis] for t in t_list]
            axes[axis].plot(propellant_values, omega_dot_values, label=f'θ={theta_deg}°')
        
        # Add vertical lines for Mach markers
        for m in mach_markers:
            for i, mach_val in enumerate(mach_values):
                if i > 0 and mach_values[i-1] < m <= mach_val:
                    axes[axis].axvline(x=propellant_all[i], color='gray', linestyle='--', alpha=0.5)
                    axes[axis].text(propellant_all[i], axes[axis].get_ylim()[0], f'M={m:.1f}', 
                                   rotation=90, va='bottom', ha='right', fontsize=7, alpha=0.7)
                    break
        
        axes[axis].set_xlabel('Propellant Mass (kg)')
        axes[axis].set_ylabel(f'ω̇ {axis_labels[axis]} (deg/s²)')
        axes[axis].set_title(f'{title_prefix} - {axis_labels[axis]}')
        axes[axis].legend(loc='center left', bbox_to_anchor=(1.02, 0.5), fontsize=9)
        axes[axis].grid(True)
        axes[axis].invert_xaxis()
    
    plt.tight_layout()
    plt.show()


def plot_I_and_I_dot(results_dict, title_prefix="Stage", alpha_deg=None, beta_deg=None):
    """Plot I and I_dot side by side vs time for I_xx, I_yy, and I_zz."""
    I_labels = ['I_xx', 'I_yy', 'I_zz']
    I_dot_labels = ['İ_xx', 'İ_yy', 'İ_zz']
    
    fig, axes = plt.subplots(3, 2, figsize=(14, 12))
    
    if alpha_deg is not None or beta_deg is not None:
        title_prefix += f" (α={alpha_deg}°, β={beta_deg}°)"
    
    # Use first theta result for I plots (I doesn't depend on theta)
    first_theta = list(results_dict.keys())[0]
    first_results = results_dict[first_theta]
    times = sorted(first_results.keys())
    mach_values = [first_results[t]['mach'] for t in times]
    
    # Generate dynamic Mach markers based on actual range (every 0.2)
    mach_min = min(m for m in mach_values if m > 0) if any(m > 0 for m in mach_values) else 0
    mach_max = max(mach_values)
    if mach_max > 0:
        start_marker = int(np.ceil(mach_min / 0.2)) * 0.2
        mach_markers = np.arange(start_marker, mach_max + 0.2, 0.2)
    else:
        mach_markers = []
    
    for axis in range(3):
        # Left column: I values
        I_values = [first_results[t]['I'][axis] for t in times]
        axes[axis, 0].plot(times, I_values, 'b-', linewidth=1.5)
        axes[axis, 0].set_xlabel('Time (s)')
        axes[axis, 0].set_ylabel(f'{I_labels[axis]} (kg·m²)')
        axes[axis, 0].set_title(f'{title_prefix} - {I_labels[axis]}')
        axes[axis, 0].grid(True)
        
        # Right column: I_dot values
        I_dot_values = [first_results[t]['I_dot'][axis] for t in times]
        axes[axis, 1].plot(times, I_dot_values, 'r-', linewidth=1.5)
        axes[axis, 1].set_xlabel('Time (s)')
        axes[axis, 1].set_ylabel(f'{I_dot_labels[axis]} (kg·m²/s)')
        axes[axis, 1].set_title(f'{title_prefix} - {I_dot_labels[axis]}')
        axes[axis, 1].grid(True)
        
        # Add Mach markers to both columns
        for m in mach_markers:
            for i, mach_val in enumerate(mach_values):
                if i > 0 and mach_values[i-1] < m <= mach_val:
                    axes[axis, 0].axvline(x=times[i], color='gray', linestyle='--', alpha=0.5)
                    axes[axis, 0].text(times[i], axes[axis, 0].get_ylim()[0], f'M={m:.1f}', 
                                       rotation=90, va='bottom', ha='right', fontsize=7, alpha=0.7)
                    axes[axis, 1].axvline(x=times[i], color='gray', linestyle='--', alpha=0.5)
                    axes[axis, 1].text(times[i], axes[axis, 1].get_ylim()[0], f'M={m:.1f}', 
                                       rotation=90, va='bottom', ha='right', fontsize=7, alpha=0.7)
                    break
    
    plt.tight_layout()
    plt.show()


def plot_omega_dot_vs_time(results_dict, title_prefix="Stage", alpha_deg=None, beta_deg=None):
    """Plot omega_dot vs time for roll, pitch, and yaw."""
    axis_labels = ['Roll (x)', 'Pitch (y)', 'Yaw (z)']
    
    fig, axes = plt.subplots(3, 1, figsize=(12, 12))
    
    if alpha_deg is not None or beta_deg is not None:
        title_prefix += f" (α={alpha_deg}°, β={beta_deg}°)"
    
    # Get first result set for Mach mapping
    first_theta = list(results_dict.keys())[0]
    first_results = results_dict[first_theta]
    times_all = sorted(first_results.keys())
    mach_values = [first_results[t]['mach'] for t in times_all]
    
    # Generate dynamic Mach markers based on actual range (every 0.2)
    mach_min = min(m for m in mach_values if m > 0) if any(m > 0 for m in mach_values) else 0
    mach_max = max(mach_values)
    if mach_max > 0:
        start_marker = int(np.ceil(mach_min / 0.2)) * 0.2
        mach_markers = np.arange(start_marker, mach_max + 0.2, 0.2)
    else:
        mach_markers = []
    
    for axis in range(3):
        for theta_deg, results in results_dict.items():
            times = sorted(results.keys())
            omega_dot_values = [results[t]['omega_dot'][axis] for t in times]
            axes[axis].plot(times, omega_dot_values, label=f'θ={theta_deg}°')
        
        # Add Mach markers
        for m in mach_markers:
            for i, mach_val in enumerate(mach_values):
                if i > 0 and mach_values[i-1] < m <= mach_val:
                    axes[axis].axvline(x=times_all[i], color='gray', linestyle='--', alpha=0.5)
                    axes[axis].text(times_all[i], axes[axis].get_ylim()[0], f'M={m:.1f}', 
                                   rotation=90, va='bottom', ha='right', fontsize=7, alpha=0.7)
                    break
        
        axes[axis].set_xlabel('Time (s)')
        axes[axis].set_ylabel(f'ω̇ {axis_labels[axis]} (deg/s²)')
        axes[axis].set_title(f'{title_prefix} - {axis_labels[axis]}')
        axes[axis].legend(loc='center left', bbox_to_anchor=(1.02, 0.5), fontsize=9)
        axes[axis].grid(True)
    
    plt.tight_layout()
    plt.show()


def plot_omega_pitch_all_stages(results_s1, results_s2, results_s3, alpha_deg=None, beta_deg=None):
    """Plot integrated omega (pitch/y) vs time for all three stages in one figure."""
    
    fig, axes = plt.subplots(3, 1, figsize=(12, 12))
    stage_data = [
        (results_s1, "Stage 1"),
        (results_s2, "Stage 2"),
        (results_s3, "Stage 3")
    ]
    
    title_suffix = ""
    if alpha_deg is not None or beta_deg is not None:
        title_suffix = f" (α={alpha_deg}°, β={beta_deg}°)"
    
    for idx, (results_dict, stage_name) in enumerate(stage_data):
        for theta_deg, results in results_dict.items():
            times = sorted(results.keys())
            omega_y_values = [results[t]['omega'][1] for t in times]  # pitch (y-axis)
            axes[idx].plot(times, omega_y_values, label=f'θ={theta_deg}°')
        
        axes[idx].set_xlabel('Time (s)')
        axes[idx].set_ylabel('ω Pitch (deg/s)')
        axes[idx].set_title(f'{stage_name}{title_suffix} - Integrated Pitch (ω_y)')
        axes[idx].legend(loc='center left', bbox_to_anchor=(1.02, 0.5), fontsize=9)
        axes[idx].grid(True)
        axes[idx].axhline(y=0, color='black', linestyle='-', linewidth=0.5)
    
    plt.tight_layout()
    plt.show()
