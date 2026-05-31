import logging

from environment.gravity.atmosphere import Atmosphere
from decorators.logging import log_class

logger = logging.getLogger(__name__)


@log_class
class COESA76(Atmosphere):
    """
    A class implementing the COESA 1976 atmosphere model, providing temperature,
    pressure, density, and speed of sound as functions of altitude.

    Using the package pyatmos-1.2.6.
    """

    def __init__(self, is_check_warning: bool = True):
        """
        Initialize the COESA76 atmosphere model.
        """
        super().__init__()

        # TODO very slow loading (~8 seconds). Need to re-write it
        from pyatmos import coesa76  # load when initializing the class
        self._model = coesa76

        self._min_altitude = 0  # Minimum altitude for the model [m]
        self._max_altitude = 84852  # Maximal altitude for the model [m]
        self._is_check_warning = is_check_warning
        pass

    def calculate(self, altitude: float, is_geometric: bool = False) -> dict:
        """
        Calculate and return all atmospheric properties at the current altitude.

        :return: Dictionary containing temperature, pressure, density, and speed of sound.
        """
        # TODO use an exponential height density model for heights above the maximal
        if self._is_check_warning and altitude >= self._max_altitude:
            logger.warning(f"Altitude {altitude} is above the maximal altitude")
        elif self._is_check_warning and altitude < self._min_altitude:
            logger.warning(f"Altitude {altitude} is below the minimal altitude")

        altitude = altitude / 1000  # model requires input in [km]
        # TODO check if the altitude is geometric or geopotential
        alt_type = 'geometric' if is_geometric else 'geopotential'
        parameters = self._model(altitude, alt_type)

        density = parameters.rho[0]
        temperature = parameters.T[0]
        pressure = parameters.P[0]

        speed_of_sound = self._speed_of_sound(temperature)

        return {
            "temperature": temperature,
            "pressure": pressure,
            "density": density,
            "speed_of_sound": speed_of_sound
        }