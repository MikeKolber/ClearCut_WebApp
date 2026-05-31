from functions.enable_subsystem import enable_subsystem


def start_inbetween_stage(
                en_stage,
                total_mass_payload_included
                ):

    # Enable subsystems if inbetween stages:
    if en_stage == 0:
        total_rocket_mass, thrust_out, mass_flow_rate_total = enable_subsystem(total_mass_payload_included)
        thrust_vector_body = thrust_out

    return thrust_vector_body, total_rocket_mass, mass_flow_rate_total
