import numpy as np
import os
import pandas as pd
from scipy.interpolate import CubicSpline
from sigfig import round
import matplotlib.pyplot as plt
import math
import warnings


class RocketCEA:
    """A class to perform thermochemical calculations for rocket engines using the NASA CEA tool."""

    def __init__(self, P_c: float, Ae_At: float, Tinit_Fuel: float, Tinit_Oxidizer: float,
                 Fuel_Type: str, Oxidizer_Type: str, Run_Type: str, OF_ratio: float = None, 
                 HTP_Concentration: float = None):
        """Initialize the RocketCEA object with propellant conditions and types.
            Input:
            P_c -> Engine Pressure
            Ae_At -> Engine Expansion Ratio
            Tinit_Fuel -> Fuel initial temperature
            Tinit_Oxidizer -> Oxidizer initial temperature
            Fuel_Type -> Fuel Type
            Oxidizer_Type -> Oxidizer Type
            Run_Type:    "Full"   - To calculate both Optimal O/F and theoretical engine parameters at optimal O/F
            .            "Single" - To calculate the engine parameters based on given O/F (used while considering engine efficiency)
            OF_ratio -> Oxidizer to Fuel Ratio (optional, required for "Single" Run_Type)
        """
        self.P_c = P_c
        self.Ae_At = Ae_At
        self.Tinit_Fuel = Tinit_Fuel
        self.Tinit_Oxidizer = Tinit_Oxidizer
        self.Fuel_Type = Fuel_Type
        self.Oxidizer_Type = Oxidizer_Type
        if self.Oxidizer_Type == "HTP_Specific":
            if HTP_Concentration is None:
                raise ValueError("HTP_Concentration is required for 'HTP_Specific' oxidizer.")
            if not isinstance(HTP_Concentration, (float, int)):
                raise TypeError("HTP_Concentration must be a float (or int).")
            self.HTP_Concentration = float(HTP_Concentration)
            if self.HTP_Concentration < 80:
                raise ValueError("HTP concentration must be above 80%")
        else:
            self.HTP_Concentration = None
        self.Run_Type = Run_Type
        self.m_dot_Fuel = 100  # Base mass flow rate for calculation, arbitrary as it scales
        self.OF_ratio = OF_ratio  # This will be used only if Run_Type is "Single"
        self.m_dot_Oxidizer = self.m_dot_Fuel * self.OF_ratio if self.OF_ratio is not None else 0.0
        self.OF_ratios = np.linspace(2, 10, num=17)  # Default range for O/F study in "Full" mode
        self.validate_inputs()  # Validate inputs upon initialization

    def validate_inputs(self):
        """Validate the inputs to the RocketCEA class."""

        if self.Run_Type not in ["Full", "Single"]:
            raise ValueError("Run type must be either Full or Single.")

        if self.P_c <= 0:
            raise ValueError("Pressure (P_c) must be greater than zero.")

        if self.Ae_At < 1:
            raise ValueError("Area ratio (Ae_At) must be greater than or equal to 1.")

        valid_fuels = ["Jet-A(L)", "Paraffin"]
        if self.Fuel_Type not in valid_fuels:
            raise ValueError(f"Invalid fuel type. Must be one of: {valid_fuels}.")

        valid_oxidizers = ["Air", "LOX", "HTP90", "HTP_Specific"]
        if self.Oxidizer_Type not in valid_oxidizers:
            raise ValueError(f"Invalid oxidizer type. Must be one of: {valid_oxidizers}.")

        if self.Oxidizer_Type == "LOX":
            if self.Tinit_Oxidizer < 85 or self.Tinit_Oxidizer > 100:
                raise ValueError("Initial temperature of Oxidizer (LOX) must be 85 K < T < 100 K.")
        else:
            if self.Tinit_Oxidizer < 220:
                raise ValueError("Initial temperature of Non cryogenic Oxidizers must be above -50°C.")

        if self.Tinit_Fuel < 220:
            raise ValueError("Initial temperature of Non cryogenic Fuels must be above -50°C.")

        if self.m_dot_Fuel < 0:
            raise ValueError("Mass flow rate of fuel (m_dot_Fuel) must be greater or equal to zero.")

        if self.Run_Type == "Single":
            if self.OF_ratio is None or self.OF_ratio <= 0:
                raise ValueError("O/F must be greater than zero for 'Single' run type.")
            self.m_dot_Oxidizer = self.m_dot_Fuel * self.OF_ratio
        else:  # Full run type, OF_ratio is determined by CEA
            pass

    def define_fuel_and_oxidizer(self, fuel_type: str, oxidizer_type: str):
        """Define fuel and oxidizer properties."""
        if fuel_type == "Jet-A(L)":
            fuel_params = {"type": "Jet-A(L)", "in_list": True, "h_kj_mol": None, "composition": None}
        elif fuel_type == "Paraffin":
            fuel_params = {"type": "Paraffin", "in_list": False, "h_kj_mol": -553.36, "composition": "C 20 H 42"}
        else:
            raise ValueError('********* MESSAGE: Fuel not defined *********')

        if oxidizer_type == "Air":
            oxidizer_params = {"type": "Air", "in_list": True, "h_kj_mol": None, "composition": None}
        elif oxidizer_type == "LOX":
            oxidizer_params = {"type": "O2(L)", "in_list": True, "h_kj_mol": None, "composition": None}
        elif oxidizer_type == "HTP90":
            oxidizer_params = {"type": "HTP90", "in_list": False, "h_kj_mol": -60316.3, "composition": "H 642 O 586"}
        elif oxidizer_type == "HTP_Specific":
            oxidizer_params = {"type": "HTP_Specific", "in_list": True, "h_kj_mol": None, "composition": None}
        else:
            raise ValueError('********* MESSAGE: Oxidizer not defined *********')

        return fuel_params, oxidizer_params

    def execute_cea(self):
        """Create and execute the command file to run CEA."""
        current_dir = os.path.dirname(os.path.abspath(__file__))
        fcea2m_path = os.path.join(current_dir, "FCEA2m.exe")
        commandfile_path = os.path.join(current_dir, "commandfile.txt")
        run_bat_path = os.path.join(current_dir, "run_fcea.bat")

        with open(commandfile_path, 'w') as commandfile:
            commandfile.write("CEA_Input_File")

        with open(run_bat_path, 'w') as batfile:
            batfile.write(f'"{fcea2m_path}" < "{commandfile_path}"\n')

        # Change directory to where CEA files are located to run it
        original_cwd = os.getcwd()
        os.chdir(current_dir)
        try:
            os.system(f'"{run_bat_path}"')
        finally:
            os.chdir(original_cwd)  # Change back to original directory

    def create_input_file(self, fuel_params, oxidizer_params, OF_Study):
        """Create the CEA input file based on defined conditions."""
        txt = [""] * 14
        txt[0] = "problem \n rocket frozen nfz=2"
        txt[1] = f"p,bar= {self.P_c}"
        txt[2] = f"sup,ae/at= {self.Ae_At}"
        txt[3] = "react"

        txt[6] = f"fuel={fuel_params['type']}  wt= {self.m_dot_Fuel}  t,k= {self.Tinit_Fuel:.3f}"
        if not fuel_params['in_list']:
            txt[7] = f"h,kj/mol={fuel_params['h_kj_mol']}  {fuel_params['composition']}"

        if oxidizer_params['type'] == "HTP_Specific":
            m_dot_H2O2 = self.m_dot_Oxidizer * (self.HTP_Concentration / 100)
            m_dot_H2O = self.m_dot_Oxidizer * (1 - self.HTP_Concentration / 100)
            txt[8] = f"oxid=H2O2(L)  wt= {m_dot_H2O2}  t,k= {self.Tinit_Oxidizer:.3f}"
            txt[9] = f"oxid=H2O(L)  wt= {m_dot_H2O}  t,k= {self.Tinit_Oxidizer:.3f}"
        else:
            txt[8] = f"oxid={oxidizer_params['type']}  wt= {self.m_dot_Oxidizer}  t,k= {self.Tinit_Oxidizer:.3f}"
            if not oxidizer_params['in_list']:
                txt[9] = f"h,kj/mol={oxidizer_params['h_kj_mol']}  {oxidizer_params['composition']}"

        txt[10] = "output short"
        txt[12] = "output plot p ispfz son machfz cffz"
        txt[13] = "end"

        if OF_Study:
            ratios_str = ','.join(map(str, self.OF_ratios))
            txt[0] = f"problem     o/f={ratios_str},\n rocket frozen nfz=2"

        input_file_name = "CEA_Input_File"
        input_file_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"{input_file_name}.inp")

        with open(input_file_path, 'w') as inputfile:
            for item in txt:
                if item:
                    inputfile.write(item + "\n")

    def read_CEA_output(self, OF_Study) -> tuple:
        """Read the CEA output CSV file and extract relevant parameters."""
        output_csv_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "CEA_Input_File.csv")

        if not os.path.exists(output_csv_path):
            raise FileNotFoundError(f"CEA output file not found: {output_csv_path}. Ensure CEA ran successfully.")

        try:
            data = pd.read_csv(output_csv_path)
            data.columns = [col.strip() for col in data.columns]
        except pd.errors.EmptyDataError:
            raise ValueError("CEA output CSV is empty. Check CEA input parameters for validity.")
        except Exception as e:
            raise IOError(f"Error reading CEA output CSV: {e}")

        if not OF_Study:
            if data.shape[0] < 3:  # Expect at least 3 rows (chamber, throat, exit)
                raise ValueError("Insufficient data in CEA output for 'Single' run. Expected at least 3 rows.")
            # Ensure columns exist before accessing
            required_cols = ['p', 'ispfz', 'cffz']
            if not all(col in data.columns for col in required_cols):
                raise ValueError(f"Missing one or more required columns in CEA output: {required_cols}")

            Exit_Pressure = data.loc[2, 'p']
            Exit_Velocity = data.loc[2, 'ispfz']
            Exit_Thrust_Coefficient_CEA = data.loc[2, 'cffz']
            C_star_th = Exit_Velocity / Exit_Thrust_Coefficient_CEA

            return Exit_Pressure, Exit_Velocity, C_star_th

        elif OF_Study:
            num_expected_runs = len(self.OF_ratios)
            if data.shape[0] % 3 != 0:
                warnings.warn(
                    f"CEA output has an incomplete number of rows ({data.shape[0]}), which is not a multiple of 3. Parsing may be unreliable.")

            num_successful_runs = data.shape[0] // 3

            if num_successful_runs < num_expected_runs:
                print(
                    f"WARNING: CEA O/F study was truncated. It completed for {num_successful_runs} of {num_expected_runs} expected O/F ratios.")
                print("         This may be due to a thermochemical convergence failure at higher O/F ratios.")

            if num_successful_runs < 2:
                raise ValueError(
                    "CEA O/F study failed to converge for at least two points. Cannot determine an optimum O/F ratio.")

            # Use only the O/F ratios that correspond to successful runs
            successful_of_ratios = self.OF_ratios[:num_successful_runs]

            try:
                # Slicing the dataframe will naturally only select from available rows
                selected_values_Isp_CEA = data.loc[2::3, 'ispfz'].to_numpy()
                selected_values_Cf_CEA = data.loc[2::3, 'cffz'].to_numpy()

                # Ensure the number of parsed values matches the successful runs
                if len(selected_values_Isp_CEA) != num_successful_runs:
                    raise ValueError(
                        f"Data parsing mismatch. Expected {num_successful_runs} data points from CSV, but got {len(selected_values_Isp_CEA)}.")

                selected_values_C_star_th = selected_values_Isp_CEA / selected_values_Cf_CEA

            except KeyError as e:
                raise KeyError(
                    f"Missing expected column in CEA output for O/F study: {e}. Check CEA configuration for output plot.")
            except IndexError:
                raise ValueError("Data indexing failed for O/F study. Ensure CEA output format is as expected.")

            # Perform spline interpolation on the successfully converged data
            OF_interp = np.linspace(successful_of_ratios[0], successful_of_ratios[-1], 2000)
            cs = CubicSpline(successful_of_ratios, selected_values_C_star_th)
            selected_values_Interp = cs(OF_interp)
            max_index = np.argmax(selected_values_Interp)
            Optimal_OF = OF_interp[max_index]

            return Optimal_OF

    def run(self):
        """Execute the entire CEA process and return results."""
        fuel_params, oxidizer_params = self.define_fuel_and_oxidizer(self.Fuel_Type, self.Oxidizer_Type)

        if self.Run_Type == "Full":
            # Step 1: Get Optimal O/F from an O/F sweep
            self.create_input_file(fuel_params, oxidizer_params, True)
            self.execute_cea()
            Optimal_OF = self.read_CEA_output(True)

            # Step 2: Get Rocket parameters at the optimal O/F (run in 'Single' mode internally)
            # Temporarily set OF_ratio and m_dot_Oxidizer for the single run
            original_of_ratio = self.OF_ratio
            original_m_dot_oxidizer = self.m_dot_Oxidizer

            self.OF_ratio = Optimal_OF
            self.m_dot_Oxidizer = self.m_dot_Fuel * self.OF_ratio
            self.create_input_file(fuel_params, oxidizer_params, False)
            self.execute_cea()
            Exit_Pressure, Exit_Velocity, C_star_th = self.read_CEA_output(False)

            # Restore original OF_ratio and m_dot_Oxidizer for future calls if this object is reused
            self.OF_ratio = original_of_ratio
            self.m_dot_Oxidizer = original_m_dot_oxidizer

            return Optimal_OF, Exit_Pressure, Exit_Velocity, C_star_th
        elif self.Run_Type == "Single":
            # Get Rocket parameters at input O/F
            self.m_dot_Oxidizer = self.m_dot_Fuel * self.OF_ratio
            self.create_input_file(fuel_params, oxidizer_params, False)
            self.execute_cea()
            Exit_Pressure, Exit_Velocity, C_star = self.read_CEA_output(False)
            return Exit_Pressure, Exit_Velocity, C_star


if __name__ == "__main__":
    """" Example code to be inserted into the MAIN calculations"""

    Nozzle_Efficiency = 1

    D_out = 1.25  # [m]; Outer diameter of the rocket
    individual_par = 2 * np.array([1, 2, 2.155, 2.414, 2.701, 3, 3, 3.304,
                                   3.613])  # source: https://en.wikipedia.org/wiki/Circle_packing_in_a_circle
    De_allowed_vec = D_out * 2 / individual_par  # [m]

    # chosen configuration for the stage:
    stage_engine_number = 9
    P_c_Desired = 80
    Ae_At = 20
    De_allowed = De_allowed_vec[stage_engine_number - 1]

    Tinit_Fuel = 298
    Tinit_Oxidizer = 298
    Fuel_Type = "Jet-A(L)"
    Oxidizer_Type = "HTP90"  # HTP90
    run_type = "Full"
    user_defined_OF = 4
    m_dot = 5.4688  # [kg/s]
    Design_Efficiency = 1
    Actual_Efficiency = 0.97
    P_c_Actual = (Actual_Efficiency / Design_Efficiency) * P_c_Desired

    if run_type == "Full":
        cea = RocketCEA(P_c_Desired, Ae_At, Tinit_Fuel, Tinit_Oxidizer, Fuel_Type, Oxidizer_Type, "Full", 2)
        Optimal_OF_th, Exit_Pressure_th, Exit_Velocity_th, C_star_th = cea.run()

        cea = RocketCEA(P_c_Actual, Ae_At, Tinit_Fuel, Tinit_Oxidizer, Fuel_Type, Oxidizer_Type, "Single",
                        Optimal_OF_th)
        Exit_Pressure, Exit_Velocity, C_star = cea.run()

        # Thrust equation

        A_t = Design_Efficiency * C_star_th * m_dot / (
                P_c_Desired * 10 ** 5)  # [m^2]; P_c was in Bars, so converted to Pa
        A_e = A_t * Ae_At  # [m^2]
        De = (4 * A_e / np.pi) ** 0.5  # [m]
        Thrust = Nozzle_Efficiency * (Actual_Efficiency * m_dot * Exit_Velocity + Exit_Pressure * 10 ** 5 * A_e)  # [N]
        # Values Used for engine through entire trajectory calculation
        print("Pe [bar]: ", Exit_Pressure, " ve [m/s]: ", Exit_Velocity, "C_star [m/s]: ", C_star, "C_star_th: ",
              C_star_th, sep='\n')

    elif run_type == "Single":
        cea = RocketCEA(P_c_Actual, Ae_At, Tinit_Fuel, Tinit_Oxidizer, Fuel_Type, Oxidizer_Type, "Single",
                        user_defined_OF)
        Exit_Pressure, Exit_Velocity, C_star = cea.run()
        A_t = Design_Efficiency * C_star * m_dot / (P_c_Desired * 10 ** 5)  # [m^2]; P_c was in Bars, so converted to Pa
        A_e = A_t * Ae_At  # [m^2]
        De = (4 * A_e / np.pi) ** 0.5  # [m]
        Thrust = Nozzle_Efficiency * (Actual_Efficiency * m_dot * Exit_Velocity + Exit_Pressure * 10 ** 5 * A_e)  # [N]
        # Values Used for engine through entire trajectory calculation
        print("Pe [bar]: ", Exit_Pressure, " ve [m/s]: ", Exit_Velocity, "C_star [m/s]: ", C_star, sep='\n')

    # Print
    print("Thrust: ", round(Thrust, sigfigs=7), " [N]")
    print("Ae: ", round(A_e, sigfigs=5), " [m^2]")
    print("De: ", round(De, sigfigs=5), " [m] , and is ",
          "allowed :)" * bool(De <= De_allowed) + "NOT allowed :(" * bool(De > De_allowed))
    print("At: ", round(A_t, sigfigs=5), " [m^2]")
    print("De allowed: ", De_allowed)