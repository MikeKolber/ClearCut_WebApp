def enable_stage(
        time,
        free_fall_timing,
        stage_1_timing,
        coasting_s1_s2,
        stage_2_timing,
        coasting_s2_s3,
        stage_3_timing,
        stage_3_timing_burn_1,
        stage_3_timing_coast,
        stage_3_timing_burn_2
        ):

    enable_separation_free_fall = 0
    enable_stage_1 = 0
    enable_interstage_1_2 = 0
    enable_stage_2 = 0
    enable_interstage_2_3 = 0
    enable_stage_3 = 0
    enable_stage_3_coasting = 0
    enable_stage_3_burn_2 = 0
    enable_in_orbit = 0

    # Determine which phase we are in based on 'time'
    if 0 <= time < free_fall_timing:
        enable_separation_free_fall = 1
    elif free_fall_timing <= time < (free_fall_timing + stage_1_timing):
        enable_stage_1 = 1
    elif (free_fall_timing + stage_1_timing) <= time < (free_fall_timing + stage_1_timing + coasting_s1_s2):
        enable_interstage_1_2 = 1
    elif (free_fall_timing + stage_1_timing + coasting_s1_s2) <= time < (
            free_fall_timing + stage_1_timing + coasting_s1_s2 + stage_2_timing):
        enable_stage_2 = 1
    elif (free_fall_timing + stage_1_timing + coasting_s1_s2 + stage_2_timing) <= time < (
            free_fall_timing + stage_1_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3):
        enable_interstage_2_3 = 1
    # stage 3 burn time 1
    elif (free_fall_timing + stage_1_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3) <= time < (
            free_fall_timing + stage_1_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3 + stage_3_timing_burn_1):
        enable_stage_3 = 1
    # stage 3 coasting time
    elif (free_fall_timing + stage_1_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3 + stage_3_timing_burn_1) <= time < (
            free_fall_timing + stage_1_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3 + stage_3_timing_burn_1 + stage_3_timing_coast):
        enable_stage_3_coasting = 1
    # stage 3 burn time 2
    elif (free_fall_timing + stage_1_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3 + stage_3_timing_burn_1 + stage_3_timing_coast) <= time < (
            free_fall_timing + stage_1_timing + coasting_s1_s2 + stage_2_timing + coasting_s2_s3 + stage_3_timing_burn_1 + stage_3_timing_coast + stage_3_timing_burn_2):
        enable_stage_3_burn_2 = 1
    else:
        enable_in_orbit = 1

    # Return the original timing values as a list
    times = [
        free_fall_timing,
        stage_1_timing,
        coasting_s1_s2,
        stage_2_timing,
        coasting_s2_s3,
        stage_3_timing
    ]

    enables = [enable_separation_free_fall,
               enable_stage_1,
               enable_interstage_1_2,
               enable_stage_2,
               enable_interstage_2_3,
               enable_stage_3,
               enable_stage_3_coasting,
               enable_stage_3_burn_2,
               enable_in_orbit]

    return (
        enable_separation_free_fall,
        enable_stage_1,
        enable_interstage_1_2,
        enable_stage_2,
        enable_interstage_2_3,
        enable_stage_3,
        enable_stage_3_coasting,
        enable_stage_3_burn_2,
        enable_in_orbit,
        times,
        enables
    )
