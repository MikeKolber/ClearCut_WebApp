import json
from typing import Dict, List, Union, Optional

import numpy as np
from functions.Optimal_OF_Ratio import Optimal_OF_Ratio


class Stage:
    def __init__(
            self,
            stage_number: int,
            final_payload_mass: float,
            rocket_diameter_Cl: float,
            RS1_e_RS2: bool,
            stage_timing,
            json_path: str = "stage_140_700.json",
            previous_stages: Optional[Dict[int, "Stage"]] = None
    ):

        self.stage_number = stage_number
        self.final_payload_mass = final_payload_mass
        self.rocket_diameter_Cl = rocket_diameter_Cl
        self.stage_timing = stage_timing
        self.previous_stages = previous_stages if previous_stages is not None else {}

        with open(json_path, 'r') as f:
            data = json.load(f)

        stage_key = f"Stage{stage_number}"
        if stage_key not in data:
            raise KeyError(f"'{stage_key}' not found in JSON file '{json_path}'.")
        stage_data = data[stage_key]

        self.propellant_mass = stage_data["propellant_mass"]
        self.structural_coefficient = stage_data["structural_coefficient"]
        self.number_of_engines = stage_data["number_of_engines"]
        self.stage_burn_time = stage_data["stage_burn_time"]
        self.fuel_type = stage_data["fuel_type"]
        self.oxidizer_type = stage_data["oxidizer_type"]
        self.desired_operating_pressure = stage_data["desired_operating_pressure"]
        self.area_ratio = stage_data["area_ratio"]
        self.efficiency = stage_data["efficiency"]
        self.unburned_propellant_fraction = stage_data["unburned_propellant_fraction"]
        # not set in json:
        self.payload_mass = 0
        self.structural_mass = 0
        self.payload_ratio = 0
        self.mass_flow_rate_per_engine = 0
        self.OF_ratio_optimal = 0
        self.exit_pressure_th = 0
        self.exit_velocity_th = 0
        self.C_star_th = 0
        self.exit_pressure = 0
        self.exit_velocity = 0
        self.C_star = 0
        self.at_theoretical = 0
        self.Ae = 0
        self.dt = 0
        self.real_operating_pressure = 0
        self.thrust_SL = 0
        self.thrust_vac = 0
        self.total_mass_payload_included = 0
        self.propellant_mass_derivative = 0

        if previous_stages is not None:
            if self.stage_number == 3:
                total_prev_propellant = sum(ps.propellant_mass for ps in previous_stages)
                self.propellant_mass = total_prev_propellant

        if RS1_e_RS2 is False and self.stage_number == 1:
            # Stage Burn Time
            self.stage_burn_time = 70  # Time in seconds
            if self.stage_burn_time != self.stage_timing:
                raise ValueError("MESSAGE: Stage and trajectory timings don't match")

            self.fuel_type = "Jet-A(L)"  # Options: "Paraffin", "Jet-A(L)"
            self.oxidizer_type = "HTP90"  # Options: "Air", "HTP90", "LOX"
            self.desired_operating_pressure = 80  # Operating pressure in bar
            self.area_ratio = 20  # Nozzle area ratio
            self.efficiency = 0.97  # Engine efficiency (dimensionless)
            self.unburned_propellant_fraction = 1 / 100  # Fraction of unburned propellant

        # ----- If the engine is the same as stage 2 engine ------------------------
        elif RS1_e_RS2 is True and self.stage_number == 1:
            stage2 = self.previous_stages[2]
            self.mass_flow_rate_per_engine = stage2.mass_flow_rate_per_engine
            self.dt = stage2.dt
            self.at_theoretical = stage2.at_theoretical
            self.fuel_type = stage2.fuel_type
            self.oxidizer_type = stage2.oxidizer_type
            self.efficiency = stage2.efficiency
            self.OF_ratio_Optimal = stage2.OF_ratio_Optimal
            self.C_star_th = stage2.C_star_th

            # Calculations
            self.stage_burn_time = self.propellant_mass / (self.mass_flow_rate_per_engine * self.number_of_engines)
            self.desired_operating_pressure = 1e-5 * (self.mass_flow_rate_per_engine * self.C_star_th) / self.at_theoretical
            self.stage_timing = self.stage_burn_time

        # ------------------------------- Calculations ----------------------------
        # --------------------------- Calculations Stage 3 ------------------------
        if self.stage_number == 3:
            self.payload_mass = final_payload_mass
            self.structural_mass = self.propellant_mass / ((1 / self.structural_coefficient) - 1)
            self.payload_ratio = self.payload_mass / (self.propellant_mass + self.structural_mass)
            self.total_mass_payload_included = self.propellant_mass + self.structural_mass + self.payload_mass
            self.mass_flow_rate_per_engine = (self.propellant_mass / self.stage_burn_time) / self.number_of_engines
            self.OF_ratio_Optimal = Optimal_OF_Ratio(self.desired_operating_pressure, self.area_ratio,
                                                     self.fuel_type, self.oxidizer_type)

            """
            ------------------------------------------------------------
            CEA Simulation Parameters and Results
            ------------------------------------------------------------

            # ----------------------- Input Parameters -----------------------
            P_c (Combustion Chamber Pressure):   77.6 bar
            Ae_At (Nozzle Area Ratio):            20
            Fuel_Type (Fuel Type):                "Jet-A(L)"
            Oxidizer_Type (Oxidizer Type):        "HTP90"
            m_dot_Fuel_in (Fuel Mass Flow Rate):  100 kg/s
            m_dot_Oxidizer_in (Oxidizer Mass Flow Rate): 700.5005 kg/s

            # ----------------------- Output Values --------------------------
            Exit_Pressure (Exit Pressure):        0.38990 bar
            Exit_Velocity (Exit Velocity):        762.9 m/s
            C_star_th (Characteristic Velocity):   1657.7 m/s

            ------------------------------------------------------------
            """
            self.exit_pressure_th, self.exit_velocity_th, self.C_star_th = 0.0569442, 3.04371e03, 1654.9
            # self.exit_pressure_th, self.exit_velocity_th, self.C_star_th = Rocket_CEA(
            #    self.desired_operating_pressure,
            #    self.area_ratio,
            #    self.fuel_type,
            #    self.oxidizer_type,
            #    100,
            #    100 * self.OF_ratio_optimal
            # )

            self.at_theoretical = (self.C_star_th * self.mass_flow_rate_per_engine) / (self.desired_operating_pressure * 1e5)
            self.Ae = self.at_theoretical * self.area_ratio
            self.dt = np.sqrt(self.at_theoretical * 4 / np.pi)
            self.real_operating_pressure = ((self.efficiency * self.C_star_th * self.mass_flow_rate_per_engine) / self.at_theoretical) / 1e5

            self.exit_pressure, self.exit_velocity, self.C_star = 0.0569442, 3.04371e03, 1654.9
            # self.exit_pressure, self.exit_velocity, self.C_star = Rocket_CEA(
            #    self.real_operating_pressure,
            #    self.area_ratio,
            #    self.fuel_type,
            #    self.oxidizer_type,
            #    100,
            #    100 * self.OF_ratio_optimal
            # )

            self.thrust_SL = (self.mass_flow_rate_per_engine * self.exit_velocity + self.Ae * (self.exit_pressure - 1) * 1e5)
            self.thrust_vac = (self.mass_flow_rate_per_engine * self.exit_velocity + self.Ae * self.exit_pressure * 1e5)
        # --------------------------- Calculations Stage 2 ------------------------
        elif self.stage_number == 2:
            self.payload_mass = self.previous_stages[3].total_mass_payload_included
            self.structural_mass = self.propellant_mass / ((1 / self.structural_coefficient) - 1)
            self.payload_ratio = self.payload_mass / (self.propellant_mass + self.structural_mass)
            self.total_mass_payload_included = self.propellant_mass + self.structural_mass + self.payload_mass

            self.mass_flow_rate_per_engine = (self.propellant_mass / self.stage_burn_time) / self.number_of_engines

            self.OF_ratio_Optimal = Optimal_OF_Ratio(self.desired_operating_pressure, self.area_ratio,
                                                     self.fuel_type, self.oxidizer_type)

            self.exit_pressure_th, self.exit_velocity_th, self.C_star_th = 0.1565, 2.9852e03, 1657.7
            # self.exit_pressure_th, self.exit_velocity_th, self.C_star_th = Rocket_CEA(
            #    self.desired_operating_pressure,
            #    self.area_ratio,
            #    self.fuel_type,
            #    self.oxidizer_type,
            #    100,
            #    100 * self.OF_ratio_optimal
            # )

            self.at_theoretical = (self.C_star_th * self.mass_flow_rate_per_engine) / (
                    self.desired_operating_pressure * 1e5)
            self.Ae = self.at_theoretical * self.area_ratio
            self.dt = np.sqrt(self.at_theoretical * 4 / np.pi)
            self.real_operating_pressure = ((self.efficiency * self.C_star_th * self.mass_flow_rate_per_engine) / self.at_theoretical) / 1e5

            self.exit_pressure, self.exit_velocity, self.C_star = 0.1565, 2.9852e03, 1657.7
            # self.exit_pressure, self.exit_velocity, self.C_star = Rocket_CEA(
            #    self.real_operating_pressure,
            #    self.area_ratio,
            #    self.fuel_type,
            #    self.oxidizer_type,
            #    100,
            #    100 * self.OF_ratio_optimal
            # )

            self.thrust_SL = (
                        self.mass_flow_rate_per_engine * self.exit_velocity + self.Ae * (self.exit_pressure - 1) * 1e5)
            self.thrust_vac = (self.mass_flow_rate_per_engine * self.exit_velocity + self.Ae * self.exit_pressure * 1e5)

            # Check Packing
            engine_max_diam = self.dt * np.sqrt(self.area_ratio)

            if self.number_of_engines == 3:
                min_external_diam_for_unit_circles = 1 + (2 / np.sqrt(3))
                min_required_rocket_diam = engine_max_diam * min_external_diam_for_unit_circles
            elif self.number_of_engines == 4:
                min_external_diam_for_unit_circles = 1 + np.sqrt(2)
                min_required_rocket_diam = engine_max_diam * min_external_diam_for_unit_circles
            else:
                raise ValueError("MESSAGE: Need to check packing")

            if min_required_rocket_diam > rocket_diameter_Cl:
                raise ValueError("MESSAGE: Packing of engines in Stage 2 is not possible")
        # --------------------------- Calculations Stage 1 ------------------------
        elif self.stage_number == 1:
            self.payload_mass = self.previous_stages[2].total_mass_payload_included
            self.structural_mass = self.propellant_mass / ((1 / self.structural_coefficient) - 1)
            self.payload_ratio = self.payload_mass / (self.propellant_mass + self.structural_mass)
            self.total_mass_payload_included = self.propellant_mass + self.structural_mass + self.payload_mass

            self.mass_flow_rate_per_engine = (self.propellant_mass / self.stage_burn_time) / self.number_of_engines
            self.OF_ratio_Optimal = Optimal_OF_Ratio(self.desired_operating_pressure, self.area_ratio,
                                                     self.fuel_type, self.oxidizer_type)

            self.exit_pressure_th, self.exit_velocity_th, self.C_star_th = 0.3899, 2.8487e03, 1657.7
            # self.exit_pressure_th, self.exit_velocity_th, self.C_star_th = Rocket_CEA(
            #    self.desired_operating_pressure,
            #    self.area_ratio,
            #    self.fuel_type,
            #    self.oxidizer_type,
            #    100,
            #    100 * self.OF_ratio_optimal
            # )

            self.at_theoretical = (self.C_star_th * self.mass_flow_rate_per_engine) / (
                    self.desired_operating_pressure * 1e5)
            self.Ae = self.at_theoretical * self.area_ratio
            self.dt = np.sqrt(self.at_theoretical * 4 / np.pi)
            self.real_operating_pressure = ((self.efficiency * self.C_star_th * self.mass_flow_rate_per_engine) / self.at_theoretical) / 1e5

            self.exit_pressure, self.exit_velocity, self.C_star = 0.3899, 2.8487e03, 1657.7
            # self.exit_pressure, self.exit_velocity, self.C_star = Rocket_CEA(
            #    self.real_operating_pressure,
            #    self.area_ratio,
            #    self.fuel_type,
            #    self.oxidizer_type,
            #    100,
            #    100 * self.OF_ratio_optimal
            # )

            self.thrust_SL = (
                        self.mass_flow_rate_per_engine * self.exit_velocity + self.Ae * (self.exit_pressure - 1) * 1e5)
            self.thrust_vac = (self.mass_flow_rate_per_engine * self.exit_velocity + self.Ae * self.exit_pressure * 1e5)

            # Check Packing
            engine_max_diam = self.dt * np.sqrt(self.area_ratio)

            if self.number_of_engines == 9:
                min_external_diam_for_unit_circles = 1 + np.sqrt(2 * (2 + np.sqrt(2)))
                min_required_rocket_diam = engine_max_diam * min_external_diam_for_unit_circles
            elif self.number_of_engines == 8:
                min_external_diam_for_unit_circles = 1 + (1 / np.sin(np.pi / 7))
                min_required_rocket_diam = engine_max_diam * min_external_diam_for_unit_circles
            else:
                raise ValueError("MESSAGE: Need to check packing")

            if min_required_rocket_diam > rocket_diameter_Cl:
                raise ValueError("MESSAGE: Packing of engines in Stage 2 is not possible")

    def __str__(self):
        return (
            f"Stage {self.stage_number}\n"
            f"{'-' * 60}\n"
            f"{'Stage Timing':35s}: {self.stage_timing:.2f} s\n"
            f"{'Final Payload Mass':35s}: {self.final_payload_mass:.2f} kg\n"
            f"{'Rocket Diameter':35s}: {self.rocket_diameter_Cl:.3f} m\n"
            f"{'Fuel Type':35s}: {self.fuel_type}\n"
            f"{'Oxidizer Type':35s}: {self.oxidizer_type}\n"
            f"{'Propellant Mass':35s}: {self.propellant_mass:.2f} kg\n"
            f"{'Structural Mass':35s}: {self.structural_mass:.2f} kg\n"
            f"{'Total Mass (Payload Included)':35s}: {self.total_mass_payload_included:.2f} kg\n"
            f"{'Mass Flow Rate per Engine':35s}: {self.mass_flow_rate_per_engine:.2f} kg/s\n"
            f"{'Optimal O/F Ratio':35s}: {self.OF_ratio_Optimal:.3f}\n"
            f"{'Exit Pressure (Throat)':35s}: {self.exit_pressure_th:.3f} bar\n"
            f"{'Exit Velocity (Throat)':35s}: {self.exit_velocity_th:.2f} m/s\n"
            f"{'Characteristic Velocity (C* th)':35s}: {self.C_star_th:.2f} m/s\n"
            f"{'Exit Pressure':35s}: {self.exit_pressure:.3f} bar\n"
            f"{'Exit Velocity':35s}: {self.exit_velocity:.2f} m/s\n"
            f"{'Characteristic Velocity (C*)':35s}: {self.C_star:.2f} m/s\n"
            f"{'Thrust at Sea Level':35s}: {self.thrust_SL:.2f} N\n"
            f"{'Thrust in Vacuum':35s}: {self.thrust_vac:.2f} N\n"
        )
