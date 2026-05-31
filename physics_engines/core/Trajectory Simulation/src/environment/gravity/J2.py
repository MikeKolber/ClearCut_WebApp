import numpy as np
from environment.gravity.kepler import Kepler


class J2(Kepler):
    def __init__(self):
        super().__init__()

    def calculate(self, position: list[float]) -> list[float]:
        # C20 = -4.8416980929E-04
        # 10^-4 because of normalization
        # -5^.5 because of geophysical modeling
        j2 = -4.8416980929E-04 * (10 ** -4) * (5 ** 0.5)
        g_vector_kepler = super().calculate(position)
        r = self.calculateRadius(position)
        x, y, z = position

        z_r_ratio = z / r
        second_term_factor = (9 / 2) * (z_r_ratio ** 2) - (3 / 2)
        second_term = [
            j2 * self.mu * (self.Re ** 2) * (x / r ** 5) * second_term_factor,  # dv/dx
            j2 * self.mu * (self.Re ** 2) * (y / r ** 5) * second_term_factor,  # dv/dy
            j2 * self.mu * (self.Re ** 2) * (z / r ** 5) * (3 * (z_r_ratio ** 2) - 1)  # dv/dz
        ]

        g_vector_total = np.array(g_vector_kepler) + np.array(second_term)

        return g_vector_total
