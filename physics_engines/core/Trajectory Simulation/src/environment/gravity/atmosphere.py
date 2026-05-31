from math import sqrt
from abc import ABCMeta, abstractmethod


class Atmosphere(metaclass=ABCMeta):
    """
    A general superclass for atmospheric models, allowing for various parameters retrieval based on input parameters.
    """

    def __init__(self):
        """
        Initialize the atmosphere model.
        """
        self._gamma = 1.4  # Heat capacity ratio []
        self._R = 287.052874  # Specific gas constant, for air [J/kg/K]
        pass

    @abstractmethod
    def calculate(self, altitude: float, *args, **kwargs) -> dict:
        """
        Calculate and return all atmospheric properties at the current altitude.

        This method should be implemented in subclasses.

        :return: Dictionary containing atmospheric properties.
        """

    def _speed_of_sound(self, temperature: float) -> float:
        """
        Calculate and return the speed of sound at the current altitude.

        This assumes constant heat capacity ratio (gamma) and constant specific gas constant, for air (R).

        :return: speed of sound.
        """
        return sqrt(self._gamma * self._R * temperature)