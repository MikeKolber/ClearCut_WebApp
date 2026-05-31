import numpy as np
import pandas as pd
from pathlib import Path
from typing import Tuple, List, Union
from scipy.interpolate import RegularGridInterpolator


class Aerodynamic:
    """
    Class for calculating aerodynamic forces (drag and lift) on a spacecraft.
    Includes methods for coefficient interpolation from tabular data.
    """

    def __init__(self, aero_data_file: str = None):
        """
        Initialize the Aerodynamic model and load coefficient data.
        
        Args:
            aero_data_file: Path to the aerodynamic coefficients data file.
                            If None, uses the default file in the data directory.
                            
        Raises:
            FileNotFoundError: If the aerodynamic data file cannot be found.
        """
        # Set the path to the aerodynamic data file
        if aero_data_file is None:
            # Get the project root directory (parent of src)
            project_root = Path(__file__).parent.parent.parent
            self.aero_data_file = project_root / "data" / "Aerodynamic_Coefficients_Data_V2_Rocket.xlsx"
        else:
            self.aero_data_file = Path(aero_data_file)
        
        # Check if the file exists
        if not self.aero_data_file.exists():
            raise FileNotFoundError(f"Aerodynamic data file not found at: {self.aero_data_file}")
        
        # Load coefficient data immediately
        self._load_coefficient_data()
            
    def _load_coefficient_data(self) -> None:
        """
        Load coefficient data from Excel file and create interpolation functions.
        """
        # Read the relevant sheets
        self._cd_data = pd.read_excel(self.aero_data_file, sheet_name="Cd(Alpha,Mach)", header=None)
        self._cl_data = pd.read_excel(self.aero_data_file, sheet_name="Cl(Alpha,Mach)", header=None)
        
        # Extract Mach and Alpha arrays from the data
        self._cd_alpha_values = np.array(self._cd_data.iloc[3:, 1].astype(float))
        self._cd_mach_values = np.array(self._cd_data.iloc[2, 2:].astype(float))
        
        self._cl_alpha_values = np.array(self._cl_data.iloc[3:, 1].astype(float))
        self._cl_mach_values = np.array(self._cl_data.iloc[2, 2:].astype(float))
        
        # Extract coefficient values as 2D arrays
        cd_values = self._cd_data.iloc[3:, 2:].values.astype(float)
        cl_values = self._cl_data.iloc[3:, 2:].values.astype(float)
        
        # Create interpolation functions
        self._cd_interp = RegularGridInterpolator(
            (self._cd_alpha_values, self._cd_mach_values), 
            cd_values, 
            method='linear', 
            bounds_error=False, 
            fill_value=None
        )
        
        self._cl_interp = RegularGridInterpolator(
            (self._cl_alpha_values, self._cl_mach_values), 
            cl_values, 
            method='linear', 
            bounds_error=False, 
            fill_value=None
        )

    def calculate_forces(self, 
                        height: float,
                        v_ecef: np.ndarray,
                        r_ecef: np.ndarray,
                        v_body: np.ndarray,
                        s_ref_cd: float, 
                        s_ref_cl: float,
                        speed_of_sound: float,
                        rho_a: float,
                        atmosphere_max_altitude: float) -> Tuple[np.ndarray, np.ndarray, float, float]:
        """
        Calculate aerodynamic forces (drag and lift) on a spacecraft.
        
        Args:
            height: Altitude above Earth's surface in meters
            v_ecef: Velocity vector in ECEF frame [vx, vy, vz] in m/s
            r_ecef: Position vector in ECEF frame [x, y, z] in m
            v_body: Velocity vector in body frame [vx, vy, vz] in m/s
            s_ref_cd: Reference area for drag coefficient in m²
            s_ref_cl: Reference area for lift coefficient in m²
            speed_of_sound: Speed of sound at current altitude in m/s
            rho_a: Atmospheric density at current altitude in kg/m³
            atmosphere_max_altitude: Maximum altitude for atmosphere model in m
            
        Returns:
            Tuple containing:
            - drag_vector: Drag force vector [Dx, Dy, Dz] in N
            - lift_vector: Lift force vector [Lx, Ly, Lz] in N
            - mach: Mach number (dimensionless)
        """
        # Convert inputs to numpy arrays if they aren't already
        v_ecef = np.asarray(v_ecef, dtype=np.float64)
        r_ecef = np.asarray(r_ecef, dtype=np.float64)
        v_body = np.asarray(v_body, dtype=np.float64)
        
        # Check if we're above the atmosphere
        if height > atmosphere_max_altitude:
            # No aerodynamic forces above the atmosphere
            return np.zeros(3), np.zeros(3), 0.0, np.arctan2(v_body[2], v_body[0]) * 180 / np.pi
        
        # Calculate velocity relative to air
        v_rel_to_air_vector = v_ecef
        v_rel_to_air_mag = np.linalg.norm(v_rel_to_air_vector)
        
        # Calculate angle of attack in degrees
        aoa_deg_body = np.arctan2(v_body[2], v_body[0]) * 180 / np.pi
        
        # Calculate Mach number and aerodynamic coefficients
        mach = v_rel_to_air_mag / speed_of_sound
        c_d, c_l = self.compute_cd_cl(mach, aoa_deg_body)
        
        # Calculate drag force
        drag_vector = -0.5 * rho_a * v_rel_to_air_mag * c_d * s_ref_cd * v_rel_to_air_vector
        
        # Calculate lift direction and force
        r_ecef_unit = r_ecef / np.linalg.norm(r_ecef)
        first_cross = np.cross(r_ecef_unit, v_rel_to_air_vector)
        lift_direction = np.cross(v_rel_to_air_vector, first_cross)
        
        # Normalize lift direction if non-zero
        # lift_dir_norm = np.linalg.norm(lift_direction)
        # if lift_dir_norm > 0:
        #    lift_direction = lift_direction / lift_dir_norm
            
        lift_vector = 0.5 * rho_a * s_ref_cl * c_l * lift_direction
        
        return drag_vector, lift_vector, mach, aoa_deg_body
    
    def compute_cd_cl(self, mach: float, alpha: float) -> Tuple[float, float]:
        """
        Compute drag and lift coefficients for given Mach number and angle of attack
        using NumPy's interpolation.
        
        Args:
            mach: Mach number (dimensionless)
            alpha: Angle of attack in degrees
            
        Returns:
            Tuple containing:
            - c_d: Drag coefficient (dimensionless)
            - c_l: Lift coefficient (dimensionless)
        """
        # Ensure mach and alpha are within bounds
        alpha_bounded = np.clip(alpha, min(self._cd_alpha_values), max(self._cd_alpha_values))
        mach_bounded = np.clip(mach, min(self._cd_mach_values), max(self._cd_mach_values))
        
        # Use the interpolation functions to get coefficients
        c_d = float(self._cd_interp((alpha_bounded, mach_bounded)))
        c_l = float(self._cl_interp((alpha_bounded, mach_bounded)))
        
        return c_d, c_l
