import time
simulation_start_time = time.perf_counter()
import_start_time = time.perf_counter()

import numpy as np
import json
import pandas as pd
from pyproj import Geod  # Using pyproj to represent WGS84 ellipsoid
from scipy.integrate import solve_ivp
from pathlib import Path
from tqdm import tqdm
from functions.runge_kutta4 import runge_kutta4
import colorama
from colorama import Fore, Back, Style

import_end_time = time.perf_counter()
setup_start_time = time.perf_counter()

from aerodynamic.aerodynamic import Aerodynamic
from environment.gravity.coesa76_pyatmos import COESA76
from environment.gravity.kepler import Kepler
from environment.gravity.J2 import J2

from functions.enable_stage import enable_stage
from functions.start_stage import start_stage
from functions.start_inbetween_stage import start_inbetween_stage

from functions.moment_of_inertia.static_moment_of_inertia_class import StaticMomentOfInertia
from functions.moment_of_inertia.calculate_moment_of_inertia import DynamicMomentOfInertia
from Classes.coordinate_transformation import CoordinateTransformation
from Classes.stage import Stage
from Classes.state import State

colorama.init()

######################################################################################################################################################
#                                          Create Instances from Classes
######################################################################################################################################################
coord_transform = CoordinateTransformation()
print("\n" + "=" * 70)
print(f"{Fore.LIGHTCYAN_EX}{Style.BRIGHT}|~~~~~~~~~~~~~~~~~~~~~~~~ Start of Simulation ~~~~~~~~~~~~~~~~~~~~~~~|{Style.RESET_ALL}")
print("=" * 70 + "\n")
######################################################################################################################################################
#                                                 Earth Parameters
######################################################################################################################################################
# Earth Parameters
wgs84 = Geod(ellps='WGS84')
semi_major = wgs84.a
semi_minor = wgs84.b
wgs84_mean_radius = (2 * semi_major + semi_minor) / 3

j2_gravity = J2()
kepler_gravity = Kepler()

mu = 3.986 * (10 ** 14)  # [m^3/s^2]
omega_earth = np.array([0, 0, 7.29211585e-5])
atmosphere_limit = 100 * 1000

######################################################################################################################################################
#                                                     JSON
######################################################################################################################################################
import sys as _sys
json_file_path = _sys.argv[1] if len(_sys.argv) > 1 else "../json_files/_current.json"
with open(json_file_path, "r") as f:
    config = json.load(f)

aerodynamic = Aerodynamic()
atmosphere = COESA76()


# ----- Launch Parameters -----
lat_launch = config["lat_launch"]
lon_launch = config["lon_launch"]
height_launch = config["height_launch"]
initial_launch_azimuth_with_rotation = config["initial_launch_azimuth_with_rotation"]
initial_role = config["initial_role"]

# ----- Initial Conditions -----
initial_speed = config["initial_speed"]
initial_path_angle = config["initial_path_angle"]

# ----- Orbit Parameters -----
desired_inclination = config["desired_inclination"]
desired_orbit_height = config["desired_orbit_height"]

# ----- Timing Parameters -----
free_fall_timing = config["free_fall_timing"]
pull_up_time = config["pull_up_time"]
pitch_command_delay_time = config["pitch_command_delay_time"]
coasting_s1_s2 = config["coasting_s1_s2"]
stage_2_timing = config["stage_2_timing"]
coasting_s2_s3 = config["coasting_s2_s3"]
stage_3_timing_total_burn = config["stage_3_timing_total_burn"]
stage_3_timing_burn_1 = config["stage_3_timing_burn_1"]
stage_3_timing_coast = config["stage_3_timing_coast"]

# ----- Propellant/Stage Information -----
no_of_stages = config["no_of_stages"]

# ----- Payload and Fairing Parameters -----
final_payload_mass = config["final_payload_mass"]
fairing_mass = config["fairing_mass"]
fairing_release_conditions = config["fairing_release_conditions"]

# --------- Aerodynamic Parameters ---------
rocket_diameter_cd = config["rocket_diameter_cd"]
rocket_diameter_cl = config["rocket_diameter_cl"]

# -------------------- nan -------------------
ejection_velocity = np.nan
stage_1_timing = np.nan  # (nan) if stage 1 engine equals stage 2 engine

# --------------- Calculations ---------------
rs1_e_rs2 = True  # (True) if Rocket stage 1 equals rocket stage 2

pitch_command_delay_time_constant = -pitch_command_delay_time / np.log(1 - 0.995)

stage_3_timing_burn_2 = stage_3_timing_total_burn - stage_3_timing_burn_1
stage_3_timing = stage_3_timing_burn_1 + stage_3_timing_coast + stage_3_timing_burn_2

s_ref_cd = 0.25 * np.pi * rocket_diameter_cd ** 2
s_ref_cl = 0.25 * np.pi * rocket_diameter_cl ** 2

######################################################################################################################################################
#                                                   Calculations
######################################################################################################################################################
if desired_inclination < lat_launch:
    raise ValueError("MESSAGE: Desired Inclination is lower than Launch Latitude")

r_0_ecef = coord_transform.lla_2_ecef(lat_launch, lon_launch, height_launch)
lat_lon_h_vector = np.array([lat_launch, lon_launch, height_launch])

# Calculation for Launch Azimuth
initial_launch_azimuth_with_rotation = coord_transform.calculate_launch_azimuth(
    desired_inclination,
    lat_launch,
    desired_orbit_height,
    mu,
    omega_earth,
    wgs84_mean_radius
)

yaw_pitch_roll_controls_initial = [initial_launch_azimuth_with_rotation, initial_path_angle, initial_role]

# Initial angles in radians (.T - Transpose, @ - multiplication)
initial_yaw_rad = np.radians(initial_launch_azimuth_with_rotation)
initial_pitch_rad = np.radians(initial_path_angle)
initial_role_rad = np.radians(0)

yaw_pitch_roll_controls_initial_rad = [initial_yaw_rad, initial_pitch_rad, initial_role_rad]

initial_dcm_ned2body = coord_transform.angle_2_dcm(initial_yaw_rad, initial_pitch_rad, initial_role_rad, input_unit='rad')
initial_dcm_body2ned = initial_dcm_ned2body.T

# DCM for ECEF to NED
initial_dcm_ecef2ned = coord_transform.ecef_2_ned_dcm(lat_launch, lon_launch)

v_0_body = initial_speed * np.array([1, 0, 0])
v_0_ecef = initial_dcm_ecef2ned.T @ (initial_dcm_body2ned @ v_0_body)

######################################################################################################################################################
#                                                   Stages
######################################################################################################################################################
stage_file = json_file_path
stage3 = Stage(3, final_payload_mass, rocket_diameter_cl, rs1_e_rs2, stage_3_timing, stage_file)
# print(stage3)
stage2 = Stage(2, final_payload_mass, rocket_diameter_cl, rs1_e_rs2, stage_2_timing, stage_file,
                previous_stages={3: stage3})
# print(stage2)
stage1 = Stage(1, final_payload_mass, rocket_diameter_cl, rs1_e_rs2, stage_1_timing, stage_file,
                previous_stages={2: stage2, 3: stage3})
# print(stage1)
stage3.stage_burn_time = stage_3_timing_burn_1 + stage_3_timing_burn_2
# print("Initial Mass: ", stage1.total_mass_payload_included + fairing_mass)

######################################################################################################################################################
#                                                 SIMULATION
######################################################################################################################################################
earth_rot_velocity = np.cross(omega_earth, r_0_ecef)

mp1_initial = stage1.propellant_mass
mp2_initial = stage2.propellant_mass
mp3_initial = stage3.propellant_mass

propellant_mass_derivative_1 = 0.0
propellant_mass_derivative_2 = 0.0
propellant_mass_derivative_3 = 0.0

initial_state = np.concatenate([r_0_ecef, v_0_ecef, [mp1_initial], [mp2_initial], [mp3_initial]])

dt_ascent = 0.01  
dt_orbital = 0.1 

dt_settings = "thrust_only"  # Other option: "until_orbital"

static_data_for_moment_of_inertia = StaticMomentOfInertia(json_file_path)
dynamic_moi_calculator = DynamicMomentOfInertia(static_data_for_moment_of_inertia)

simulation_time = config["simulation_time"]
n_steps = int(simulation_time / dt_ascent)

state_instance = State(r_0_ecef, v_0_ecef, mp1_initial, mp2_initial, mp3_initial)
initial_state_vector = state_instance.as_vector()
current_state = initial_state.copy()
current_t = 0.0

# Preallocate arrays for simulation outputs
time_history = np.empty(n_steps)
state_history = np.empty((n_steps, len(initial_state_vector)))
height_array = np.empty(n_steps)
thrust_history = np.empty(n_steps)
mass_history = np.empty(n_steps)
mach_history = np.empty(n_steps)
aoa_body_history = np.empty(n_steps)
thrust_body_x = np.empty(n_steps)
lat_history = np.empty(n_steps)
long_history = np.empty(n_steps)
lift_x_ecef = np.empty(n_steps)
lift_y_ecef = np.empty(n_steps)
lift_z_ecef = np.empty(n_steps)
drag_x_ecef = np.empty(n_steps)
drag_y_ecef = np.empty(n_steps)
drag_z_ecef = np.empty(n_steps)
v_x_body = np.empty(n_steps)
v_y_body = np.empty(n_steps)
v_z_body = np.empty(n_steps)
I_xx_moi = np.empty(n_steps)
I_yy_moi = np.empty(n_steps)
I_zz_moi = np.empty(n_steps)
current_com_history = np.empty(n_steps)
density_history = np.empty(n_steps)
speed_of_sound_history = np.empty(n_steps)
z_engine_history = np.empty(n_steps)
propellant_mass_history = np.empty(n_steps)

# Initialize the first elements
time_history[0] = current_t
state_history[0, :] = initial_state_vector
height_array[0] = height_launch
thrust_history[0] = 0.0
mass_history[0] = stage1.total_mass_payload_included + fairing_mass


def dX_dt(t, state):
    # Extract position and velocity from the state vector
    position = state[0:3]
    velocity = state[3:6]

    # Use the computed global values for mass derivatives
    global net_force, propellant_mass_derivative_1, propellant_mass_derivative_2, propellant_mass_derivative_3
    acceleration = net_force / current_mass

    # Use the computed propellant mass derivatives instead of zeros
    additional_state_derivatives = np.array([propellant_mass_derivative_1, propellant_mass_derivative_2, propellant_mass_derivative_3])

    dstate_dt = np.concatenate([velocity, acceleration, additional_state_derivatives])
    return dstate_dt


print_interval = simulation_time / 100
next_print_time = print_interval
threshold_printed = {1: False, 2: False, 3: False}

# Initialize dictionary with new keys for each external function call timing
section_times = {
    "imports": import_end_time - import_start_time,
    "enable_stage": 0.0,
    "state_update": 0.0,
    "coord_transform_ecef2ned": 0.0,
    "COESA76": 0.0,
    "v_ned_calc": 0.0,
    "trajectory_control": 0.0,
    "angle2dcm": 0.0,
    "v_body_calc": 0.0,
    "start_stage": 0.0,
    "start_inbetween_stage": 0.0,
    "thrust_transformation": 0.0,
    "aerodynamic": 0.0,
    "kepler_gravity": 0.0,
    "integration": 0.0,
    "storage": 0.0,
    "progress_bar": 0.0,
    "setup": 0.0,
    "data_processing": 0.0,
    "array_trimming": 0.0,
    "dt_calculation": 0.0,
    "force_calculations": 0.0,
    "stage_determination": 0.0,
    "threshold_checks": 0.0,
    "propellant_updates": 0.0,
    "moment_of_inertia": 0.0
}

# Configure simple tqdm progress bar
print("\n")  # Add a newline before the progress bar
progress_bar = tqdm(
    total=simulation_time * 1.001,  # Add 0.1% buffer
    desc=f"{Fore.LIGHTMAGENTA_EX}{Style.BRIGHT}Simulation Progress{Style.RESET_ALL}",
    unit="s",
    bar_format="{desc}: {percentage:3.0f}%|{bar}| {n:.1f}/{total:.1f}s [{elapsed}<{remaining}]",
    ncols=100,
    colour='green'
)

# Record setup time
setup_end_time = time.perf_counter()
section_times["setup"] = setup_end_time - setup_start_time

# Start timing the simulation loop
loop_start_time = time.perf_counter()

for step in range(n_steps):
    # -------------- Calculations --------------
    # Enable stages:
    t0 = time.perf_counter()
    (
        sep_free_fall,
        en_stage_1,
        en_interstage_1_2,
        en_stage_2,
        en_interstage_2_3,
        en_stage_3,
        en_stage_3_coasting,
        en_stage_3_burn_2,
        en_in_orbit,
        timing_list,
        enables
    ) = enable_stage(
        current_t,
        free_fall_timing,
        stage1.stage_timing,
        coasting_s1_s2,
        stage2.stage_timing,
        coasting_s2_s3,
        stage3.stage_timing,
        stage_3_timing_burn_1,
        stage_3_timing_coast,
        stage_3_timing_burn_2
    )
    t1 = time.perf_counter()
    section_times["enable_stage"] += (t1 - t0)
    
    # Time the dt calculation
    t0 = time.perf_counter()
    if dt_settings == "until_orbital":
        # Use small dt until the end of stage 3 (including coasting)
        if current_t < free_fall_timing + stage1.stage_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3 + stage_3_timing:
            dt = dt_ascent
        else:
            dt = dt_orbital
            remaining_time = simulation_time - current_t
            remaining_steps = int(remaining_time / dt_orbital)
            if step + remaining_steps < n_steps:
                n_steps = step + remaining_steps + 1
    else:  # "thrust_only"
        # Use small dt only during thrust phases
        if (current_t < free_fall_timing + stage1.stage_timing) or \
            (free_fall_timing + stage1.stage_timing + coasting_s1_s2 <= current_t < free_fall_timing + stage1.stage_timing + coasting_s1_s2 + stage_2_timing) or \
            (free_fall_timing + stage1.stage_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3 <= current_t < free_fall_timing + stage1.stage_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3 + stage_3_timing_burn_1) or \
            (free_fall_timing + stage1.stage_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3 + stage_3_timing_burn_1 + stage_3_timing_coast <= current_t < free_fall_timing + stage1.stage_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3 + stage_3_timing):
            dt = dt_ascent
        else:
            dt = dt_orbital
            remaining_time = simulation_time - current_t
            remaining_steps = int(remaining_time / dt_orbital)
            if step + remaining_steps < n_steps:
                n_steps = step + remaining_steps + 1
    t1 = time.perf_counter()
    section_times["dt_calculation"] += (t1 - t0)

    t0 = time.perf_counter()
    state_instance.update_from_vector(current_state)
    current_r = state_instance.position
    current_v = state_instance.velocity
    current_propellant_mass_1 = state_instance.mp1
    current_propellant_mass_2 = state_instance.mp2
    current_propellant_mass_3 = state_instance.mp3
    t1 = time.perf_counter()
    section_times["state_update"] += (t1 - t0)

    lat, lon, current_height = coord_transform.ecef_2_lla(current_r)
    height_array[step] = current_height
    lat_history[step] = lat
    long_history[step] = lon

    t0 = time.perf_counter()
    dcm_ecef2ned = coord_transform.ecef_2_ned_dcm(lat, lon)
    dcm_ned2ecef = dcm_ecef2ned.T
    t1 = time.perf_counter()
    section_times["coord_transform_ecef2ned"] += (t1 - t0)

    if current_height <= 100000:
        t0 = time.perf_counter()
        
        atmos_properties = atmosphere.calculate(current_height)

        temperature = atmos_properties["temperature"]
        pressure = atmos_properties["pressure"]
        density = atmos_properties["density"]
        speed_of_sound = atmos_properties["speed_of_sound"]
        atmosphere_max_altitude = 100000 # atmosphere._max_altitude
        
        mach = np.linalg.norm(current_v) / speed_of_sound
        t1 = time.perf_counter()
        section_times["COESA76"] += (t1 - t0)
    else:
        density = 0
        mach = 0
        speed_of_sound = 0
        pressure = 0
        atmosphere_max_altitude = 100000

    t0 = time.perf_counter()
    v_ned = dcm_ecef2ned @ current_v
    t1 = time.perf_counter()
    section_times["v_ned_calc"] += (t1 - t0)

    t0 = time.perf_counter()
    yaw_pitch_roll_controls_rad = coord_transform.trajectory_control(current_t,
                                                                    enables,
                                                                    pull_up_time,
                                                                    v_ned,
                                                                    mach)
    t1 = time.perf_counter()
    section_times["trajectory_control"] += (t1 - t0)

    t0 = time.perf_counter()
    yaw_rad = yaw_pitch_roll_controls_rad[0]
    pitch_rad = yaw_pitch_roll_controls_rad[1]
    roll_rad = yaw_pitch_roll_controls_rad[2]

    dcm_ned2body = coord_transform.angle_2_dcm(yaw_rad, pitch_rad, roll_rad, input_unit='rad')
    # dcm_ned2body = coord_transform.angle2dcm(yaw_rad, pitch_rad, roll_rad)
    dcm_body2ned = dcm_ned2body.T
    t1 = time.perf_counter()
    section_times["angle2dcm"] += (t1 - t0)

    t0 = time.perf_counter()
    v_body = dcm_ned2body @ v_ned
    v_x_body[step] = v_body[0]
    v_y_body[step] = v_body[1]
    v_z_body[step] = v_body[2]
    t1 = time.perf_counter()
    section_times["v_body_calc"] += (t1 - t0)

    # Time the stage determination
    t0 = time.perf_counter()
    propellant_mass_derivative_1 = 0
    propellant_mass_derivative_2 = 0
    propellant_mass_derivative_3 = 0

    if current_height > 120000:
        fairing_mass = 0
    else:
        fairing_mass = config["fairing_mass"]

    if en_stage_1:
        current_stage = stage1
        en_stage = 1
        current_propellant_mass = current_propellant_mass_1
        propellant_mass_derivative_1 = -(current_stage.mass_flow_rate_per_engine * current_stage.number_of_engines)
    elif en_stage_2:
        current_stage = stage2
        en_stage = 1
        current_propellant_mass = current_propellant_mass_2
        propellant_mass_derivative_2 = -(current_stage.mass_flow_rate_per_engine * current_stage.number_of_engines)
    elif en_stage_3:
        current_stage = stage3
        en_stage = 1
        current_propellant_mass = current_propellant_mass_3
        propellant_mass_derivative_3 = -(current_stage.mass_flow_rate_per_engine * current_stage.number_of_engines)
    elif en_stage_3_burn_2:
        current_stage = stage3
        en_stage = 1
        current_propellant_mass = current_propellant_mass_3
        propellant_mass_derivative_3 = -(current_stage.mass_flow_rate_per_engine * current_stage.number_of_engines)
    elif sep_free_fall:
        current_stage = sep_free_fall
        en_stage = 0
        current_propellant_mass = current_propellant_mass_1
        current_mass = stage1.total_mass_payload_included + fairing_mass
    elif en_interstage_1_2:
        current_stage = en_interstage_1_2
        en_stage = 0
        current_propellant_mass = current_propellant_mass_2
        current_mass = stage2.total_mass_payload_included + fairing_mass
    elif en_interstage_2_3:
        current_stage = en_interstage_2_3
        en_stage = 0
        current_propellant_mass = current_propellant_mass_3
        current_mass = stage3.total_mass_payload_included + fairing_mass
    elif en_stage_3_coasting:
        current_stage = en_stage_3_coasting
        en_stage = 0
        current_propellant_mass = current_propellant_mass_3
        structural_mass = stage3.structural_mass
        payload_mass = stage3.payload_mass
        current_mass = current_propellant_mass + structural_mass + payload_mass + fairing_mass
    else:
        current_stage = en_in_orbit
        en_stage = 0
        current_propellant_mass = current_propellant_mass_3
        current_mass = current_propellant_mass + final_payload_mass

    if en_stage == 1:
        structural_mass = current_stage.structural_mass
        payload_mass = current_stage.payload_mass
        current_mass = current_propellant_mass + structural_mass + payload_mass + fairing_mass
    t1 = time.perf_counter()
    section_times["stage_determination"] += (t1 - t0)

    # Calculate moment of inertia
    t0 = time.perf_counter()
    
    current_com, current_moment_of_inertia = dynamic_moi_calculator.calculate(enables, current_propellant_mass, current_height)
    
    I_xx_moi[step] = current_moment_of_inertia[0, 0]
    I_yy_moi[step] = current_moment_of_inertia[1, 1]
    I_zz_moi[step] = current_moment_of_inertia[2, 2]
    current_com_history[step] = current_com
    
    # Store additional TVC data
    density_history[step] = density
    speed_of_sound_history[step] = speed_of_sound
    # Get engine position based on current stage
    if en_stage_1:
        z_engine_history[step] = static_data_for_moment_of_inertia.stage1_engine_com
    elif en_stage_2:
        z_engine_history[step] = static_data_for_moment_of_inertia.stage2_engine_com
    elif en_stage_3 or en_stage_3_burn_2:
        z_engine_history[step] = static_data_for_moment_of_inertia.stage3_engine_com
    else:
        z_engine_history[step] = 0  # No active engine during coasting/freefall
    
    propellant_mass_history[step] = current_propellant_mass
    
    t1 = time.perf_counter()
    section_times["moment_of_inertia"] += (t1 - t0)

    # Time the threshold checks
    t0 = time.perf_counter()
    if en_stage == 1:
        mp_next = (current_propellant_mass - (current_stage.mass_flow_rate_per_engine * current_stage.number_of_engines * dt))
        if mp_next <= current_stage.propellant_mass * current_stage.unburned_propellant_fraction:
            stage_id = current_stage.stage_number  
            if not threshold_printed[stage_id]:
                print(f"\n\n{Style.BRIGHT}Stage {stage_id} propellant mass: {Fore.RED}{current_propellant_mass:.2f} kg{Style.RESET_ALL}")
                print(f"{Style.BRIGHT}Threshold (1% fraction):{Fore.RED} {current_stage.propellant_mass * current_stage.unburned_propellant_fraction}{Style.RESET_ALL}")
                print("\n") 
                threshold_printed[stage_id] = True

            current_propellant_mass = current_stage.propellant_mass * current_stage.unburned_propellant_fraction
            thrust_vector_body = [0.0, 0.0, 0.0]
            propellant_mass_derivative_1 = 0
            propellant_mass_derivative_2 = 0
            propellant_mass_derivative_3 = 0
        else:
            if en_stage == 1:
                (
                    thrust_vector_body,
                    thrust_out,
                    total_rocket_mass,
                    mass_flow_rate,
                    p_a
                ) = start_stage(
                    current_height,
                    en_stage,
                    current_stage.mass_flow_rate_per_engine,
                    current_stage.exit_velocity,
                    current_stage.Ae,
                    current_stage.exit_pressure,
                    current_stage.number_of_engines,
                    current_stage.structural_mass,
                    current_stage.payload_mass,
                    current_propellant_mass,
                    pressure
                )
                t1 = time.perf_counter()
                section_times["start_stage"] += (t1 - t0)
    else:
        t0 = time.perf_counter()
        (thrust_vector_body, current_mass, mass_flow_rate) = start_inbetween_stage(en_stage, current_mass)
        t1 = time.perf_counter()
        section_times["start_inbetween_stage"] += (t1 - t0)
    t1 = time.perf_counter()
    section_times["threshold_checks"] += (t1 - t0)

    # Time propellant derivative updates
    t0 = time.perf_counter()
    if abs(current_t - (free_fall_timing - dt)) < 1e-8:
        propellant_mass_derivative_1 = -(stage1.mass_flow_rate_per_engine * stage1.number_of_engines)
    elif abs(current_t - (free_fall_timing + stage1.stage_timing + coasting_s1_s2 - dt)) < 1e-8:
        propellant_mass_derivative_2 = -(current_stage.mass_flow_rate_per_engine * current_stage.number_of_engines)
    elif abs(current_t - (free_fall_timing + stage1.stage_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3 - dt)) < 1e-8:
        propellant_mass_derivative_3 = -(current_stage.mass_flow_rate_per_engine * current_stage.number_of_engines)
    elif abs(current_t - (free_fall_timing + stage1.stage_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3 + stage_3_timing_burn_1 + stage_3_timing_coast - dt)) < 1e-8:
        propellant_mass_derivative_3 = -(current_stage.mass_flow_rate_per_engine * current_stage.number_of_engines)
    t1 = time.perf_counter()
    section_times["propellant_updates"] += (t1 - t0)

    t0 = time.perf_counter()
    thrust_body_x[step] = thrust_vector_body[0]
    thrust_vector_ned = dcm_body2ned @ thrust_vector_body
    thrust_vector_ecef = dcm_ned2ecef @ thrust_vector_ned
    t1 = time.perf_counter()
    section_times["thrust_transformation"] += (t1 - t0)

    t0 = time.perf_counter()
    
    # Calculate aerodynamic forces
    drag_vector_ecef, lift_vector_ecef, mach, aoa_deg_body = aerodynamic.calculate_forces(
        current_height,
        current_v,
        current_r,
        v_body,
        s_ref_cd, 
        s_ref_cl,
        speed_of_sound,
        density,
        atmosphere_max_altitude
    )

    mach_history[step] = mach
    aoa_body_history[step] = aoa_deg_body
    lift_x_ecef[step] = lift_vector_ecef[0]
    lift_y_ecef[step] = lift_vector_ecef[1]
    lift_z_ecef[step] = lift_vector_ecef[2]
    drag_x_ecef[step] = drag_vector_ecef[0]
    drag_y_ecef[step] = drag_vector_ecef[1]
    drag_z_ecef[step] = drag_vector_ecef[2]
    t1 = time.perf_counter()
    section_times["aerodynamic"] += (t1 - t0)

    # Time the force calculations
    t0 = time.perf_counter()
    # F = ma
    f_thrust = thrust_vector_ecef
    f_drag = drag_vector_ecef
    f_lift = lift_vector_ecef
    g_acceleration = kepler_gravity.calculate(current_r)
    t1 = time.perf_counter()
    section_times["kepler_gravity"] += (t1 - t0)

    # Continue timing force calculations
    t0 = time.perf_counter()
    f_net = f_thrust + f_drag + f_lift
    inertial_acceleration = (f_net / current_mass) + g_acceleration
    coriolis = np.cross(2 * omega_earth, current_v)
    centrifugal = np.cross(omega_earth, np.cross(omega_earth, current_r))  # Ω × (Ω × r)
    total_acceleration = inertial_acceleration - (coriolis + centrifugal)
    net_force = total_acceleration * current_mass
    t1 = time.perf_counter()
    section_times["force_calculations"] += (t1 - t0)

    # -------------- Integration --------------
    t0 = time.perf_counter()
    current_state = runge_kutta4(dX_dt, current_t, current_state, dt)  # ~2 m

    t1 = time.perf_counter()
    section_times["integration"] += (t1 - t0)

    # --- Store the results ---
    t0 = time.perf_counter()
    time_history[step] = current_t
    current_thrust = np.linalg.norm(thrust_vector_ecef)
    thrust_history[step] = current_thrust
    state_history[step, :] = current_state
    current_t += dt
    mass_history[step] = current_mass
    t1 = time.perf_counter()
    section_times["storage"] += (t1 - t0)

    # Simple progress bar update
    t0 = time.perf_counter()

    progress_bar.update(dt)
    if current_t >= next_print_time or current_t >= simulation_time:
        print(f"PROGRESS:{current_t / simulation_time * 100:.1f}", flush=True)
        next_print_time += print_interval
    t1 = time.perf_counter()
    section_times["progress_bar"] += (t1 - t0)

    # Exit loop if we've reached the simulation time
    if current_t >= simulation_time:
        break

progress_bar.close()
print("\n")  # Add a newline after the progress bar
loop_end_time = time.perf_counter()
section_times["simulation_loop"] = loop_end_time - loop_start_time

print("\n" + "=" * 70)
print(f"{Fore.LIGHTCYAN_EX}{Style.BRIGHT}|~~~~~~~~~~~~~~~~~~~~~~~~ End of Simulation ~~~~~~~~~~~~~~~~~~~~~~~|{Style.RESET_ALL}")
print("=" * 70)

# Trim arrays to actual used size
t0 = time.perf_counter()
actual_steps = step + 1  # +1 because step is 0-indexed
time_history = time_history[:actual_steps]
state_history = state_history[:actual_steps]
height_array = height_array[:actual_steps]
thrust_history = thrust_history[:actual_steps]
mass_history = mass_history[:actual_steps]
mach_history = mach_history[:actual_steps]
aoa_body_history = aoa_body_history[:actual_steps]
thrust_body_x = thrust_body_x[:actual_steps]
lat_history = lat_history[:actual_steps]
long_history = long_history[:actual_steps]
lift_x_ecef = lift_x_ecef[:actual_steps]
lift_y_ecef = lift_y_ecef[:actual_steps]
lift_z_ecef = lift_z_ecef[:actual_steps]
drag_x_ecef = drag_x_ecef[:actual_steps]
drag_y_ecef = drag_y_ecef[:actual_steps]
drag_z_ecef = drag_z_ecef[:actual_steps]
v_x_body = v_x_body[:actual_steps]
v_y_body = v_y_body[:actual_steps]
v_z_body = v_z_body[:actual_steps]
I_xx_moi = I_xx_moi[:actual_steps]
I_yy_moi = I_yy_moi[:actual_steps]
I_zz_moi = I_zz_moi[:actual_steps]
current_com_history = current_com_history[:actual_steps]
density_history = density_history[:actual_steps]
speed_of_sound_history = speed_of_sound_history[:actual_steps]
z_engine_history = z_engine_history[:actual_steps]
propellant_mass_history = propellant_mass_history[:actual_steps]
t1 = time.perf_counter()
section_times["array_trimming"] += (t1 - t0)

# Export MOI and COM data to CSV
import os
aero_data_path = 'TVC Calculation/Data_for_TVC/aero_data.csv'
moi_com_df = pd.DataFrame({
    'time_s': time_history,
    'I_xx': I_xx_moi,
    'I_yy': I_yy_moi,
    'I_zz': I_zz_moi,
    'COM': current_com_history,
    'density': density_history,
    'speed_of_sound': speed_of_sound_history,
    'z_engine': z_engine_history,
    'thrust': thrust_history,
    'rocket_diameter': rocket_diameter_cl,
    'propellant_mass': propellant_mass_history
})
moi_com_df.to_csv(aero_data_path, index=False)
print(f"\n{Fore.GREEN}Exported MOI/COM data to {aero_data_path}{Style.RESET_ALL}")


###########################################################################
#                      Export Simulation Data
###########################################################################
# ---------------- Data Extraction ----------------
t0 = time.perf_counter()
states_array = state_history

x_ecef = states_array[:, 0]
y_ecef = states_array[:, 1]
z_ecef = states_array[:, 2]
positions_ecef = states_array[:, 0:3]

delta_positions = np.diff(positions_ecef, axis=0)
incremental_distances = np.linalg.norm(delta_positions, axis=1)
s = np.concatenate(([0], np.cumsum(incremental_distances)))

vx_ecef = states_array[:, 3]
vy_ecef = states_array[:, 4]
vz_ecef = states_array[:, 5]
velocities_ecef = states_array[:, 3:6]
velocity_ecef_magnitudes = np.linalg.norm(velocities_ecef, axis=1)
t1 = time.perf_counter()
section_times["data_processing"] += (t1 - t0)

# ------------------ Export Comprehensive Simulation Data to Excel ------------------
t0 = time.perf_counter()

mp1_history = states_array[:, 6]
mp2_history = states_array[:, 7]
mp3_history = states_array[:, 8]

simulation_df = pd.DataFrame({
    'time_s': time_history,
    'height_m': height_array,
    'lat_deg': lat_history,
    'lon_deg': long_history,
    'x_ecef_m': x_ecef,
    'y_ecef_m': y_ecef,
    'z_ecef_m': z_ecef,
    'vx_ecef_m_s': vx_ecef,
    'vy_ecef_m_s': vy_ecef,
    'vz_ecef_m_s': vz_ecef,
    'speed_ecef_m_s': velocity_ecef_magnitudes,
    'distance_m': s,
    'vx_body_m_s': v_x_body,
    'vy_body_m_s': v_y_body,
    'vz_body_m_s': v_z_body,
    'mach': mach_history,
    'aoa_deg': aoa_body_history,
    'mass_kg': mass_history,
    'thrust_N': thrust_history,
    'thrust_body_x_N': thrust_body_x,
    'mp1_kg': mp1_history,
    'mp2_kg': mp2_history,
    'mp3_kg': mp3_history,
    'propellant_mass_kg': propellant_mass_history,
    'lift_x_ecef_N': lift_x_ecef,
    'lift_y_ecef_N': lift_y_ecef,
    'lift_z_ecef_N': lift_z_ecef,
    'drag_x_ecef_N': drag_x_ecef,
    'drag_y_ecef_N': drag_y_ecef,
    'drag_z_ecef_N': drag_z_ecef,
    'I_xx_kg_m2': I_xx_moi,
    'I_yy_kg_m2': I_yy_moi,
    'I_zz_kg_m2': I_zz_moi,
    'COM_m': current_com_history,
    'density_kg_m3': density_history,
    'speed_of_sound_m_s': speed_of_sound_history,
    'z_engine_m': z_engine_history,
})

# CC_OUTPUT_DIR (set by the web backend, points at the calling user's
# per-session workspace) directs the CSV there. Falls back to the
# legacy relative path when running the script directly from a shell.
# `os` was already imported above the aero_data section.
_output_override = os.environ.get('CC_OUTPUT_DIR')
if _output_override:
    simulation_output_path = Path(_output_override) / 'simulation_output.csv'
else:
    simulation_output_path = Path('../output/simulation_output.csv')
simulation_output_path.parent.mkdir(parents=True, exist_ok=True)
simulation_df.to_csv(str(simulation_output_path), index=False)
print(f"\n{Fore.GREEN}Exported simulation data to {simulation_output_path}{Style.RESET_ALL}")

# Generate rocket structure sketch
from sketch.generate_sketch import generate_sketch
generate_sketch(static_data_for_moment_of_inertia)

t1 = time.perf_counter()
section_times["data_processing"] += (t1 - t0)

