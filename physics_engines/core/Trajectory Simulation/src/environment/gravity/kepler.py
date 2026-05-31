from environment.gravity.gravity import Gravity
import numpy as np


class Kepler(Gravity):
    def __init__(self):
        super().__init__()
        self._Re = 6.378137e6  # Volumetric mean radius [m]              - Source: EGM2008
        self.mu = 3.986004418e14  # mu = G*M [m^3/s^2]                   - Source: EGM2008

    def calculate(self, position: list[float]) -> list[float]:

        r = self.calculateRadius(position)
        g_scaling_factor = -(self.mu / (r ** 3))

        position = np.asarray(position)
        gravity_vector = g_scaling_factor * position

        return gravity_vector
