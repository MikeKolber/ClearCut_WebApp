from functions.stage_characteristics import stage_characteristics


def start_stage(current_height,
                en_stage,
                mass_flow_rate_per_engine,
                exit_velocity,
                ae,
                exit_pressure,
                number_of_engines,
                structural_mass,
                payload_mass,
                current_propellant_mass,
                p_a
                ):

    if en_stage == 1:
        mass_flow_rate_total = mass_flow_rate_per_engine * number_of_engines

        thrust_vector_body, total_thrust, total_rocket_mass, mass_flow_rate = stage_characteristics(
            mass_flow_rate_per_engine,
            number_of_engines,
            exit_velocity,
            exit_pressure,
            structural_mass,
            payload_mass,
            en_stage,
            p_a,
            ae,
            current_propellant_mass)

    return thrust_vector_body, total_thrust, total_rocket_mass, mass_flow_rate_total, p_a
