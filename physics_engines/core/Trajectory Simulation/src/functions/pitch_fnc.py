import numpy as np


def pitch_fnc(time, enables, gamma, mach, pull_up_time):

    enable_case = enables.index(1) + 1
    t_pull_up = pull_up_time

    if mach <= 3:
        pullup_angle_of_attack = 15
    else:
        pullup_angle_of_attack = 10

    if enable_case == 1:  # Free Fall
        pitch = gamma
    elif enable_case == 2:  # Stage One phase
        if time <= t_pull_up:
            pitch = gamma + pullup_angle_of_attack
        else:
            pitch = gamma  # + alpha wanted
    elif enable_case == 3:  # Coasting 1-2
        pitch = gamma
    elif enable_case == 4:  # Stage Two phase
        pitch = gamma
    elif enable_case == 5:  # Coasting 2-3
        pitch = gamma
    elif enable_case == 6:  # Stage Three burn phase
        pitch = 0
    elif enable_case == 7:  # Stage three coasting phase
        pitch = 0
    elif enable_case == 8:  # stage three burn 2
        pitch = 0
    elif enable_case == 9:  # In orbit
        pitch = gamma
    else:
        pitch = np.nan

    return pitch
