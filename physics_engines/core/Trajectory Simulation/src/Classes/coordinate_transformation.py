import numpy as np
from navpy import ecef2ned, angle2dcm, lla2ecef, ecef2lla  # coordinate transformation
from math import atan2, sqrt, pi
from functions.pitch_fnc import pitch_fnc


class CoordinateTransformation:

    def smoothing_function(self, value):
        # Placeholder for the actual smoothing function
        return value

    def trajectory_control(self,
                           time,
                           enables,
                           pull_up_time,
                           v_ned,
                           mach):
        gamma_deg = (180 / pi) * atan2(-v_ned[2], (sqrt(v_ned[0] ** 2 + v_ned[1] ** 2)))
        v_azimuth_deg = (180 / pi) * atan2(v_ned[1], v_ned[0])
        pitch_deg = pitch_fnc(time, enables, gamma_deg, mach, pull_up_time)
        pitch = (pi / 180) * pitch_deg

        # Calculate yaw, pitch, and roll
        yaw = (pi / 180) * v_azimuth_deg
        # pitch_inc = smoothing_function(pitch - initial_path_angle)
        # pitch = (pi / 180) * (initial_path_angle + pitch_inc)
        roll = 0

        yaw_pitch_roll_controls_rad = np.array([yaw, pitch, roll])

        return yaw_pitch_roll_controls_rad

    def ecef_2_ned_dcm(self, lat_deg: float, lon_deg: float) -> np.ndarray:
        lat_rad = np.radians(lat_deg)
        lon_rad = np.radians(lon_deg)

        sin_lat, cos_lat = np.sin(lat_rad), np.cos(lat_rad)
        sin_lon, cos_lon = np.sin(lon_rad), np.cos(lon_rad)

        dcm_ecef2ned = np.array([
            [-sin_lat * cos_lon, -sin_lat * sin_lon,  cos_lat],
            [-sin_lon, cos_lon, 0.],
            [-cos_lat * cos_lon, -cos_lat * sin_lon, -sin_lat]
        ])

        return dcm_ecef2ned

    def calculate_launch_azimuth(self, desired_inclination, lat_launch, desired_orbit_height, mu, omega_earth,
                                 wgs84_mean_radius):
        launch_azimuth_inertial = np.arcsin(np.cos(np.radians(desired_inclination)) / np.cos(np.radians(lat_launch)))

        target_orbit_velocity = np.sqrt(mu / (desired_orbit_height * 1000 + wgs84_mean_radius))

        # Step 3: Earth's Rotation Vector
        r_0_ecef = lla2ecef(lat_launch, 0, 0)  # Assuming longitude 0 and altitude 0
        v_rotation_vector = np.cross(omega_earth, r_0_ecef)
        v_rotation_norm = np.linalg.norm(v_rotation_vector)

        # Step 4: Velocity Components with Earth's Rotation
        vx_rot = target_orbit_velocity * np.sin(launch_azimuth_inertial) - v_rotation_norm
        vy_rot = target_orbit_velocity * np.cos(launch_azimuth_inertial)

        # Step 5: Calculate Initial Launch Azimuth with Rotation
        initial_launch_azimuth_with_rotation = np.degrees(np.arctan2(vx_rot, vy_rot))

        return initial_launch_azimuth_with_rotation

    def angle_2_dcm(self, yaw_rad, pitch_rad, role, input_unit):
        dcm_ned2body = angle2dcm(yaw_rad, pitch_rad, role, input_unit)
        return dcm_ned2body

    def lla_2_ecef(self, lat, long, height):
        r_vector = lla2ecef(lat, long, height)
        return r_vector

    def ecef_2_lla(self, r):
        lat, long, height = ecef2lla(r)
        return lat, long, height
