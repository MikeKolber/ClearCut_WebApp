import os
import pandas as pd
import numpy as np


# creates CEA_Input_File.inp
def Rocket_CEA(P_c, Ae_At, Fuel_Type, Oxidizer_Type, m_dot_Fuel_in, m_dot_Oxidizer_in):

    # Initialize parameters
    Exit_Pressure = None
    Exit_Velocity = None
    C_star_th = None

    # ------------------------ Define Conditions ---------------------------
    Pc = P_c  # Combustion chamber pressure in bar
    AeAt = Ae_At  # Nozzle area ratio
    m_dot_Fuel = m_dot_Fuel_in
    m_dot_Oxidizer = m_dot_Oxidizer_in
    Tinit_Fuel = 298  # Initial temperature of fuel in Kelvin
    Tinit_Oxidizer = 298  # Initial temperature of oxidizer in Kelvin

    # ---------------------------- Define Fuel -----------------------------
    if Fuel_Type == "Jet-A(L)":
        Fuel_in_CEA_list = True
    elif Fuel_Type == "Paraffin":
        h_kj_mol_Fuel = -553.36
        Fuel_Composition = "C 20 H 42"
        Fuel_in_CEA_list = False
    else:
        raise ValueError("MESSAGE: Fuel not defined")

    # ------------------------- Define Oxidizer ----------------------------
    if Oxidizer_Type == "Air":
        Oxidizer_in_CEA_list = True
    elif Oxidizer_Type == "LOX":
        Oxidizer_Type = "O2(L)"
        Oxidizer_in_CEA_list = True
        Tinit_Oxidizer = 90
    elif Oxidizer_Type == "HTP90":
        h_kj_mol_Oxidizer = -60316.3
        Oxidizer_Composition = "H 642 O 586"
        Oxidizer_in_CEA_list = False
    else:
        raise ValueError("MESSAGE: Oxidizer not defined")

    # ------------------------ Generate CEA Input File ---------------------
    txt = []
    txt.append("problem")  # First command
    txt.append("rocket frozen nfz=2")  # Second command
    txt.append(f"p,bar= {Pc}")
    txt.append(f"sup,ae/at= {AeAt}")
    txt.append("react")

    # Fuel definition
    if Fuel_in_CEA_list:
        txt.append(f"fuel={Fuel_Type} wt={m_dot_Fuel:.6f} t,k={Tinit_Fuel:.6f}")
    else:
        txt.append(f"fuel={Fuel_Type} wt={m_dot_Fuel:.6f} t,k={Tinit_Fuel:.6f}")
        txt.append(f"h,kj/mol={h_kj_mol_Fuel} {Fuel_Composition}")

    # Oxidizer definition
    if Oxidizer_in_CEA_list:
        txt.append(f"oxid={Oxidizer_Type} wt={m_dot_Oxidizer:.6f} t,k={Tinit_Oxidizer:.6f}")
    else:
        txt.append(f"oxid={Oxidizer_Type} wt={m_dot_Oxidizer:.6f} t,k={Tinit_Oxidizer:.6f}")
        txt.append(f"h,kj/mol={h_kj_mol_Oxidizer} {Oxidizer_Composition}")

    # Output specifications
    txt.append("output short")
    txt.append("output plot p ispfz son machfz cffz")
    txt.append("end")

    # Write input file
    inps = "CEA_Input_File"
    with open(f"{inps}.inp", "w") as inputfile:
        for line in txt:
            inputfile.write(line + "\n")

    # Run CEA
    with open("commandfile.txt", "w") as commandfile:
        commandfile.write(inps)

    status = os.system("./FCEA2m < commandfile.txt")

    if status != 0:
        raise RuntimeError("CEA execution failed")

    # Read output CSV file
    Data = pd.read_csv(f"{inps}.csv")
    # Data.columns = Data.columns.str.strip()

    # printing data file
    # with open(f"{inps}.csv", "r") as file:
    #    print(f"Contents of {inps}.csv:")
    #    print(file.read())


    # Extract results
    Exit_Pressure = Data.loc[2, "p           "]
    # print("exit pressure: ", Exit_Pressure)
    Exit_Velocity = Data.loc[2, "ispfz       ",]
    # print("exit velocity: ", Exit_Velocity)
    Exit_Thrust_Coefficient_CEA = Data.loc[2, "cffz        "]
    # print("exit_thrust: ", Exit_Thrust_Coefficient_CEA)
    C_star_th = Exit_Velocity / Exit_Thrust_Coefficient_CEA
    # print("C_star_th: ", C_star_th)

    return Exit_Pressure, Exit_Velocity, C_star_th