import numpy as np
from scipy.integrate import solve_ivp
from environment.gravity.coesa76_pyatmos import COESA76


def stage_characteristics(mass_flow_rate_per_engine,
                          number_of_engines,
                          exit_velocity,
                          exit_pressure,
                          structure_mass,
                          payload_mass,
                          enable_stage,
                          p_a,
                          ae,
                          current_propellant_mass):

    total_rocket_mass = current_propellant_mass + structure_mass + payload_mass
    mass_flow_rate_total = mass_flow_rate_per_engine * number_of_engines * -1 if enable_stage else 0

    # Calculating thrust
    momentum_thrust = exit_velocity * mass_flow_rate_per_engine
    pressure_thrust = (exit_pressure * 1e5 - p_a) * ae  # Convert bar to Pascal
    total_thrust_per_engine = momentum_thrust + pressure_thrust
    total_thrust = total_thrust_per_engine * number_of_engines

    thrust_vector_body = total_thrust * np.array([1, 0, 0]) if enable_stage else np.zeros(3)

    return thrust_vector_body, total_thrust, total_rocket_mass, mass_flow_rate_total
