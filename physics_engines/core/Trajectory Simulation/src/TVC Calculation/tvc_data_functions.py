import numpy as np
from scipy.interpolate import RegularGridInterpolator, interp1d


class AeroData:
    """Handles aerodynamic coefficient interpolation from alpha/Mach tables."""
    
    def __init__(self, filepath):
        import pandas as pd
        
        aero_data = pd.read_excel(filepath)
        
        alpha_values = np.unique(aero_data['ALPHA'].values)
        mach_values = np.unique(aero_data['MACH'].values)
        
        n_alpha = len(alpha_values)
        n_mach = len(mach_values)
        
        C_L_grid = aero_data['CL'].values.reshape(n_alpha, n_mach)
        x_cp_grid = aero_data['CP (meter)'].values.reshape(n_alpha, n_mach)
        
        self._C_L_interp = RegularGridInterpolator((alpha_values, mach_values), C_L_grid)
        self._x_cp_interp = RegularGridInterpolator((alpha_values, mach_values), x_cp_grid)
    
    def get_coefficients(self, alpha_deg, mach):
        """Return C_L and x_cp for given alpha (deg) and Mach."""
        C_L = float(self._C_L_interp((alpha_deg, mach)))
        x_cp = float(self._x_cp_interp((alpha_deg, mach)))
        return C_L, x_cp


def split_by_thrust(data, thrust_col_index):
    """Split data into stages based on non-zero thrust regions."""
    thrust = data.iloc[:, thrust_col_index].values
    
    stages = []
    i = 0
    n = len(thrust)
    
    for stage_num in range(3):
        while i < n and thrust[i] == 0:
            i += 1
        
        start_idx = i
        while i < n and thrust[i] != 0:
            i += 1
        end_idx = i
        
        if start_idx < end_idx:
            stage_data = data.iloc[start_idx:end_idx].copy()
            stage_data.iloc[:, 0] = stage_data.iloc[:, 0] - stage_data.iloc[0, 0]
            stages.append(stage_data)
    
    return stages


class RocketProperties:
    """Time-dependent rocket properties interpolation for a single stage.
    
    Columns: time, I_xx, I_yy, I_zz, COM, density, speed_of_sound, 
             x_engine, thrust, diameter, propellant_mass
    """
    
    def __init__(self, stage_data):
        t = stage_data.iloc[:, 0].values
        
        self._t_max = t[-1]
        self._time_steps = t
        
        I_xx = stage_data.iloc[:, 1].values
        I_yy = stage_data.iloc[:, 2].values
        I_zz = stage_data.iloc[:, 3].values
        
        self._I_xx_interp = interp1d(t, I_xx)
        self._I_yy_interp = interp1d(t, I_yy)
        self._I_zz_interp = interp1d(t, I_zz)
        
        # Compute I_dot using numpy gradient (central difference)
        self._I_xx_dot_interp = interp1d(t, np.gradient(I_xx, t))
        self._I_yy_dot_interp = interp1d(t, np.gradient(I_yy, t))
        self._I_zz_dot_interp = interp1d(t, np.gradient(I_zz, t))
        
        self._x_com_interp = interp1d(t, stage_data.iloc[:, 4].values)
        self._rho_interp = interp1d(t, stage_data.iloc[:, 5].values)
        self._speed_of_sound_interp = interp1d(t, stage_data.iloc[:, 6].values)
        self._x_engine_interp = interp1d(t, stage_data.iloc[:, 7].values)
        self._F_thrust_interp = interp1d(t, stage_data.iloc[:, 8].values)
        
        diameter = stage_data.iloc[:, 9].values
        self._A_ref_interp = interp1d(t, np.pi * (diameter / 2) ** 2)
        
        self._propellant_mass_interp = interp1d(t, stage_data.iloc[:, 10].values)
        self._propellant_mass_values = stage_data.iloc[:, 10].values
    
    @property
    def t_max(self):
        return self._t_max
    
    @property
    def time_steps(self):
        return self._time_steps
    
    @property
    def propellant_mass_values(self):
        return self._propellant_mass_values
    
    def get_properties(self, t):
        """Return all rocket properties at time t."""
        return {
            'x_com': float(self._x_com_interp(t)),
            'x_engine': float(self._x_engine_interp(t)),
            'F_thrust': float(self._F_thrust_interp(t)),
            'rho': float(self._rho_interp(t)),
            'speed_of_sound': float(self._speed_of_sound_interp(t)),
            'A_ref': float(self._A_ref_interp(t)),
            'propellant_mass': float(self._propellant_mass_interp(t)),
            'I': np.array([
                [float(self._I_xx_interp(t)), 0, 0],
                [0, float(self._I_yy_interp(t)), 0],
                [0, 0, float(self._I_zz_interp(t))]
            ]),
            'I_dot': np.array([
                [float(self._I_xx_dot_interp(t)), 0, 0],
                [0, float(self._I_yy_dot_interp(t)), 0],
                [0, 0, float(self._I_zz_dot_interp(t))]
            ])
        }


def load_rocket_stages(filepath, thrust_col_index=8):
    """Load rocket data and split into stage1, stage2, stage3."""
    import pandas as pd
    
    data = pd.read_csv(filepath, header=0)
    stages = split_by_thrust(data, thrust_col_index)
    
    return {
        'stage1': RocketProperties(stages[0]),
        'stage2': RocketProperties(stages[1]),
        'stage3': RocketProperties(stages[2])
    }
