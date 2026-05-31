import numpy as np


class State:

    def __init__(self, position, velocity, mp1, mp2, mp3):
        self.position = np.array(position, dtype=float)
        self.velocity = np.array(velocity, dtype=float)
        self.mp1 = float(mp1)
        self.mp2 = float(mp2)
        self.mp3 = float(mp3)

    def as_vector(self):

        return np.concatenate((
            self.position,
            self.velocity,
            [self.mp1, self.mp2, self.mp3]
        ))

    def update_from_vector(self, vector):

        v = np.asarray(vector, dtype=float)
        self.position = v[0:3]
        self.velocity = v[3:6]
        self.mp1 = v[6]
        self.mp2 = v[7]
        self.mp3 = v[8]

    def __repr__(self):
        return (
            f"State(position={self.position}, velocity={self.velocity}, "
            f"mp1={self.mp1}, mp2={self.mp2}, mp3={self.mp3})"
        )
