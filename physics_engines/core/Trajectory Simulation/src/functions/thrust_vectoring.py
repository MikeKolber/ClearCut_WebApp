import numpy as np
from typing import Tuple

def calculate_center_of_gravity_and_inertia(stage: int) -> Tuple[np.ndarray, np.ndarray]:
    """
    Calculate center of gravity and moments of inertia for a given stage.
    
    Parameters:
    stage (int): Stage number to determine mass properties
    
    Returns:
    tuple: (center_of_gravity, moments_of_inertia) where both are arrays
            center_of_gravity: [x, y, z] position in meters
            moments_of_inertia: [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] in kg*m^2
    """
    # TODO: fill with the actual values
    if stage == 1:
        center_of_gravity = np.array([-2.5, 0.0, 0.0])  # m
        moments_of_inertia = np.array([1000.0, 5000.0, 5000.0, 0.0, 0.0, 0.0])  # kg*m^2
    elif stage == 2:
        center_of_gravity = np.array([-1.5, 0.0, 0.0])  # m
        moments_of_inertia = np.array([500.0, 2500.0, 2500.0, 0.0, 0.0, 0.0])  # kg*m^2
    elif stage == 3:
        center_of_gravity = np.array([-0.5, 0.0, 0.0])  # m
        moments_of_inertia = np.array([200.0, 1000.0, 1000.0, 0.0, 0.0, 0.0])  # kg*m^2
    else:
        raise ValueError(f"Invalid stage: {stage}")
    
    return center_of_gravity, moments_of_inertia


def get_thrust_properties(stage: int) -> Tuple[float, np.ndarray]:
    """
    Get thrust magnitude and position for a given stage.
    
    Parameters:
    stage (int): Stage number to determine thrust properties
    
    Returns:
    tuple: (total_thrust, thrust_position) where
            total_thrust: thrust magnitude in Newtons
            thrust_position: 3-element array [x, y, z] of thrust position in meters
    """
    # TODO: fill with the actual values
    if stage == 1:
        total_thrust = 1000.0  # N
        thrust_position = np.array([-5.0, 0.0, 0.0])  # m
    elif stage == 2:
        total_thrust = 500.0   # N
        thrust_position = np.array([-3.0, 0.0, 0.0])  # m
    elif stage == 3:
        total_thrust = 200.0   # N
        thrust_position = np.array([-1.0, 0.0, 0.0])  # m
    else:
        raise ValueError(f"Invalid stage: {stage}")
    
    return total_thrust, thrust_position


def calculate_thrust_forces_and_moments(total_thrust: float, thrust_position: np.ndarray, center_of_gravity: np.ndarray, angleXY: float, angleXZ: float) -> Tuple[np.ndarray, np.ndarray]:
    """
    Calculate thrust forces and moments for given thrust properties, center of gravity, and angles.
    
    Parameters:
    total_thrust (float): Thrust magnitude in Newtons
    thrust_position (array): 3-element array [x, y, z] of thrust position in meters
    center_of_gravity (array): 3-element array [x, y, z] of center of gravity position
    angleXY (float): Angle in XY plane (radians)
    angleXZ (float): Angle in XZ plane (radians)
    
    Returns:
    tuple: (thrust_forces, moments) where both are 3-element arrays
    """
    # Calculate distance vector from center of gravity to thrust position
    distance_vector = thrust_position - center_of_gravity
    
    # Decompose thrust vector into 3 components based on angles
    force_x = total_thrust * np.cos(angleXY) * np.cos(angleXZ)
    force_y = total_thrust * np.cos(angleXZ) * np.sin(angleXY)
    force_z = total_thrust * np.cos(angleXY) * np.sin(angleXZ)
    
    forces = np.array([force_x, force_y, force_z])
    
    # Calculate moments as cross product of distance vector and thrust vector
    moment_x = -force_y * distance_vector[2] + force_z * distance_vector[1]
    moment_y = force_x * distance_vector[2] - force_z * distance_vector[0]
    moment_z = -force_x * distance_vector[1] + force_y * distance_vector[0]
    
    moments = np.array([moment_x, moment_y, moment_z])
    
    return forces, moments

def calculate_angular_acceleration(moments_of_inertia: np.ndarray, moments: np.ndarray, angular_velocity: np.ndarray) -> np.ndarray:
    """
    Calculate angular acceleration using Euler's rotation equations with full inertia tensor.
    
    Parameters:
    moments_of_inertia (array): 6-element array [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] in kg*m^2
    moments (array): 3-element array [Mx, My, Mz] of applied moments in N*m
    angular_velocity (array): 3-element array [wx, wy, wz] in rad/s
    
    Returns:
    array: 3-element array [alpha_x, alpha_y, alpha_z] of angular accelerations in rad/s^2
    """
    # TODO needs to be validated
    # Extract inertia tensor components
    Ixx, Iyy, Izz, Ixy, Ixz, Iyz = moments_of_inertia
    
    # Extract applied moments
    L, M, N = moments
    
    # Extract angular velocities
    p, q, r = angular_velocity
    
    # Determinant of inertia tensor
    D = (Ixx * Iyy * Izz
         + 2 * Ixy * Iyz * Ixz
         - Ixx * Iyz**2
         - Iyy * Ixz**2
         - Izz * Ixy**2)

    # Coefficients for each moment input
    A1 = Iyy * Izz - Iyz**2
    A2 = Ixz * Iyz - Ixy * Izz
    A3 = Ixy * Iyz - Iyy * Ixz

    B1 = Iyz * Ixz - Ixy * Izz
    B2 = Ixx * Izz - Ixz**2
    B3 = Ixy * Ixz - Ixx * Iyz

    C1 = Ixy * Iyz - Iyy * Ixz
    C2 = Ixy * Ixz - Ixx * Iyz
    C3 = Ixx * Iyy - Ixy**2

    # Gyroscopic terms (omega cross I * omega)
    G1 = ((Izz - Iyy) * q * r
          + Iyz * (q**2 - r**2)
          + Ixz * p * q
          - Ixy * p * r)

    G2 = ((Ixx - Izz) * r * p
          + Ixz * (r**2 - p**2)
          + Ixy * q * r
          - Iyz * q * p)

    G3 = ((Iyy - Ixx) * p * q
          + Ixy * (p**2 - q**2)
          + Iyz * r * p
          - Ixz * r * q)

    # Final angular accelerations
    pdot = (A1 * L + A2 * M + A3 * N - G1) / D
    qdot = (B1 * L + B2 * M + B3 * N - G2) / D
    rdot = (C1 * L + C2 * M + C3 * N - G3) / D

    return np.array([pdot, qdot, rdot])

# TODO: from here and below: work in progress
def thrust_vector_control_loop(desired_angular_acceleration: np.ndarray, 
                                stage: int, 
                                current_angular_velocity: np.ndarray = None,
                                kp_xy: float = 0.1, 
                                kp_xz: float = 0.1,
                                max_angle: float = np.pi/6) -> Tuple[float, float]:
    # TODO: needs to be validated
    """
    Control loop function that calculates required thrust vector angles to achieve desired angular acceleration.
    
    This function implements a proportional controller that maps desired angular accelerations
    to thrust vector angles (angleXY and angleXZ) by using the relationship between
    thrust angles and the resulting moments/angular accelerations.
    
    Parameters:
    desired_angular_acceleration (array): 3-element array [alpha_x, alpha_y, alpha_z] in rad/s^2
    stage (int): Stage number to determine vehicle properties
    current_angular_velocity (array): 3-element array [wx, wy, wz] in rad/s (optional, defaults to zero)
    kp_xy (float): Proportional gain for XY plane control
    kp_xz (float): Proportional gain for XZ plane control  
    max_angle (float): Maximum allowable thrust vector angle in radians
    
    Returns:
    tuple: (angleXY, angleXZ) where both are control angles in radians
            angleXY: Thrust vector angle in XY plane
            angleXZ: Thrust vector angle in XZ plane
    """
    # Set default angular velocity if not provided
    if current_angular_velocity is None:
        current_angular_velocity = np.array([0.0, 0.0, 0.0])
    
    # Get vehicle properties for the specified stage
    center_of_gravity, moments_of_inertia = calculate_center_of_gravity_and_inertia(stage)
    total_thrust, thrust_position = get_thrust_properties(stage)
    
    # Calculate distance vector from center of gravity to thrust position
    distance_vector = thrust_position - center_of_gravity
    
    # Extract desired angular accelerations
    alpha_x_desired, alpha_y_desired, alpha_z_desired = desired_angular_acceleration
    
    # For small angle approximation, the relationship between thrust angles and moments is:
    # moment_y ≈ total_thrust * angleXZ * distance_vector[0]  (pitch moment from XZ angle)
    # moment_z ≈ -total_thrust * angleXY * distance_vector[0] (yaw moment from XY angle)
    
    # Calculate required moments to achieve desired angular accelerations
    # Using simplified approach: M = I * alpha (ignoring gyroscopic terms for control)
    Ixx, Iyy, Izz = moments_of_inertia[0], moments_of_inertia[1], moments_of_inertia[2]
    
    required_moment_y = Iyy * alpha_y_desired  # Pitch moment
    required_moment_z = Izz * alpha_z_desired  # Yaw moment
    
    # Calculate control angles using small angle approximation
    # For pitch control (rotation about Y-axis): angleXZ controls moment_y
    if abs(distance_vector[0]) > 1e-6:  # Avoid division by zero
        angleXZ_raw = required_moment_y / (total_thrust * distance_vector[0])
    else:
        angleXZ_raw = 0.0
    
    # For yaw control (rotation about Z-axis): angleXY controls moment_z  
    if abs(distance_vector[0]) > 1e-6:  # Avoid division by zero
        angleXY_raw = -required_moment_z / (total_thrust * distance_vector[0])
    else:
        angleXY_raw = 0.0
    
    # Apply proportional gains
    angleXY = kp_xy * angleXY_raw
    angleXZ = kp_xz * angleXZ_raw
    
    # Apply angle limits to prevent excessive thrust vectoring
    angleXY = np.clip(angleXY, -max_angle, max_angle)
    angleXZ = np.clip(angleXZ, -max_angle, max_angle)
    
    return float(angleXY), float(angleXZ)


def simulate_control_step(desired_angular_acceleration: np.ndarray,
                            stage: int,
                            current_angular_velocity: np.ndarray = None,
                            kp_xy: float = 0.1,
                            kp_xz: float = 0.1) -> Tuple[float, float, np.ndarray, np.ndarray]:
    # TODO: needs to be validated
    """
    Simulate one control step: compute control angles and resulting angular acceleration.
    
    This function demonstrates the complete control loop by:
    1. Computing control angles for desired angular acceleration
    2. Calculating the actual forces and moments from those angles
    3. Computing the resulting angular acceleration
    
    Parameters:
    desired_angular_acceleration (array): 3-element array [alpha_x, alpha_y, alpha_z] in rad/s^2
    stage (int): Stage number to determine vehicle properties
    current_angular_velocity (array): 3-element array [wx, wy, wz] in rad/s (optional)
    kp_xy (float): Proportional gain for XY plane control
    kp_xz (float): Proportional gain for XZ plane control
    
    Returns:
    tuple: (angleXY, angleXZ, actual_angular_acceleration, control_error)
            angleXY: Control angle in XY plane (radians)
            angleXZ: Control angle in XZ plane (radians) 
            actual_angular_acceleration: Resulting angular acceleration (rad/s^2)
            control_error: Difference between desired and actual angular acceleration
    """
    # Set default angular velocity if not provided
    if current_angular_velocity is None:
        current_angular_velocity = np.array([0.0, 0.0, 0.0])
    
    # Get control angles
    angleXY, angleXZ = thrust_vector_control_loop(
        desired_angular_acceleration, stage, current_angular_velocity, kp_xy, kp_xz
    )
    
    # Get vehicle properties
    center_of_gravity, moments_of_inertia = calculate_center_of_gravity_and_inertia(stage)
    total_thrust, thrust_position = get_thrust_properties(stage)
    
    # Calculate actual forces and moments from control angles
    forces, moments = calculate_thrust_forces_and_moments(
        total_thrust, thrust_position, center_of_gravity, angleXY, angleXZ
    )
    
    # Calculate actual angular acceleration
    actual_angular_acceleration = calculate_angular_acceleration(
        moments_of_inertia, moments, current_angular_velocity
    )
    
    # Calculate control error
    control_error = desired_angular_acceleration - actual_angular_acceleration
    
    return angleXY, angleXZ, actual_angular_acceleration, control_error
