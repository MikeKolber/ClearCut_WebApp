import numpy as np
from tvc_data_functions import AeroData, load_rocket_stages
from tvc_calc_functions import run_simulation, plot_omega_dot_all_axes, plot_I_and_I_dot, plot_omega_dot_vs_time, plot_omega_pitch_all_stages

# =============================================================================
# LOAD DATA
# =============================================================================

aero = AeroData("Data_for_TVC/AoA_Mach_Cp_CL.xlsx")
stages = load_rocket_stages("Data_for_TVC/aero_data.csv", thrust_col_index=8)

stage1 = stages['stage1']
stage2 = stages['stage2']
stage3 = stages['stage3']

# =============================================================================
# STAGE 1 PARAMETERS
# =============================================================================

alpha_deg_s1 = 5.0
beta_deg_s1 = 0.0
theta1_values_s1 = [0, 1, 2, 3, 4, 5, 6, 7]
theta2_deg_s1 = 0.0
initial_velocity_s1 = 0.0      # m/s at start of stage 1
final_velocity_s1 = 2000.0     # m/s at end of stage 1
max_time_s1 = 70.0  # seconds, set to None for full stage duration

# =============================================================================
# STAGE 2 PARAMETERS
# =============================================================================

alpha_deg_s2 = 5.0
beta_deg_s2 = 0.0
theta1_values_s2 = [0, 1, 2, 3, 4, 5, 6, 7]
theta2_deg_s2 = 0.0
initial_velocity_s2 = 2000.0   # m/s at start of stage 2 (= end of stage 1)
final_velocity_s2 = 4000.0     # m/s at end of stage 2
max_time_s2 = 65.0  # full stage duration

# =============================================================================
# STAGE 3 PARAMETERS
# =============================================================================

alpha_deg_s3 = 0.0
beta_deg_s3 = 0.0
theta1_values_s3 = [0, 1, 2, 3, 4, 5, 6, 7]
theta2_deg_s3 = 0.0
initial_velocity_s3 = 4000.0   # m/s at start of stage 3 (= end of stage 2)
final_velocity_s3 = 6000.0     # m/s at end of stage 3
max_time_s3 = 200.0  # full stage duration

# =============================================================================
# RUN SIMULATIONS FOR STAGE 1
# =============================================================================

alpha_total_s1 = np.degrees(np.arccos(np.cos(np.radians(alpha_deg_s1)) * np.cos(np.radians(beta_deg_s1))))
print(f"\n{'='*60}")
print(f"STAGE 1 (alpha={alpha_deg_s1}, beta={beta_deg_s1}, total AoA={alpha_total_s1:.2f} deg)")
print(f"Velocity: {initial_velocity_s1} -> {final_velocity_s1} m/s")
print(f"{'='*60}")

results_stage1 = {}
for theta1_deg in theta1_values_s1:
    print(f"  theta1 = {theta1_deg} deg")
    results = run_simulation(
        stage=stage1,
        aero=aero,
        alpha_deg=alpha_deg_s1,
        beta_deg=beta_deg_s1,
        theta1_deg=theta1_deg,
        theta2_deg=theta2_deg_s1,
        initial_velocity=initial_velocity_s1,
        final_velocity=final_velocity_s1,
        max_time=max_time_s1,
        stage_name="Stage 1"
    )
    results_stage1[theta1_deg] = results

# =============================================================================
# RUN SIMULATIONS FOR STAGE 2
# =============================================================================

alpha_total_s2 = np.degrees(np.arccos(np.cos(np.radians(alpha_deg_s2)) * np.cos(np.radians(beta_deg_s2))))
print(f"\n{'='*60}")
print(f"STAGE 2 (alpha={alpha_deg_s2}, beta={beta_deg_s2}, total AoA={alpha_total_s2:.2f} deg)")
print(f"Velocity: {initial_velocity_s2} -> {final_velocity_s2} m/s")
print(f"{'='*60}")

results_stage2 = {}
for theta1_deg in theta1_values_s2:
    print(f"  theta1 = {theta1_deg} deg")
    results = run_simulation(
        stage=stage2,
        aero=aero,
        alpha_deg=alpha_deg_s2,
        beta_deg=beta_deg_s2,
        theta1_deg=theta1_deg,
        theta2_deg=theta2_deg_s2,
        initial_velocity=initial_velocity_s2,
        final_velocity=final_velocity_s2,
        max_time=max_time_s2,
        stage_name="Stage 2"
    )
    results_stage2[theta1_deg] = results

# =============================================================================
# RUN SIMULATIONS FOR STAGE 3
# =============================================================================

alpha_total_s3 = np.degrees(np.arccos(np.cos(np.radians(alpha_deg_s3)) * np.cos(np.radians(beta_deg_s3))))
print(f"\n{'='*60}")
print(f"STAGE 3 (alpha={alpha_deg_s3}, beta={beta_deg_s3}, total AoA={alpha_total_s3:.2f} deg)")
print(f"Velocity: {initial_velocity_s3} -> {final_velocity_s3} m/s")
print(f"{'='*60}")

results_stage3 = {}
for theta1_deg in theta1_values_s3:
    print(f"  theta1 = {theta1_deg} deg")
    results = run_simulation(
        stage=stage3,
        aero=aero,
        alpha_deg=alpha_deg_s3,
        beta_deg=beta_deg_s3,
        theta1_deg=theta1_deg,
        theta2_deg=theta2_deg_s3,
        initial_velocity=initial_velocity_s3,
        final_velocity=final_velocity_s3,
        max_time=max_time_s3,
        stage_name="Stage 3"
    )
    results_stage3[theta1_deg] = results

# =============================================================================
# PLOT RESULTS - STAGE 1
# =============================================================================

plot_omega_dot_all_axes(results_stage1, title_prefix="Stage 1", alpha_deg=alpha_deg_s1, beta_deg=beta_deg_s1)
# plot_omega_dot_vs_time(results_stage1, title_prefix="Stage 1", alpha_deg=alpha_deg_s1, beta_deg=beta_deg_s1)
# plot_I_and_I_dot(results_stage1, title_prefix="Stage 1", alpha_deg=alpha_deg_s1, beta_deg=beta_deg_s1)

# =============================================================================
# PLOT RESULTS - STAGE 2
# =============================================================================

plot_omega_dot_all_axes(results_stage2, title_prefix="Stage 2", alpha_deg=alpha_deg_s2, beta_deg=beta_deg_s2)

# =============================================================================
# PLOT RESULTS - STAGE 3
# =============================================================================

plot_omega_dot_all_axes(results_stage3, title_prefix="Stage 3", alpha_deg=alpha_deg_s3, beta_deg=beta_deg_s3)

# =============================================================================
# PLOT INTEGRATED OMEGA (PITCH) - ALL STAGES
# =============================================================================

plot_omega_pitch_all_stages(results_stage1, results_stage2, results_stage3, alpha_deg=alpha_deg_s1, beta_deg=beta_deg_s1)
