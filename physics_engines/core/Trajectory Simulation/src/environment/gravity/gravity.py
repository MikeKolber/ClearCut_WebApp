import numpy as np
from abc import ABCMeta, abstractmethod


class Gravity(metaclass=ABCMeta):
    """
    A general superclass for gravity models, allowing for gravitational acceleration based on position.
    """

    def __init__(self):
        """
        Initialize the gravity model.
        """
        pass

    @abstractmethod
    def calculate(self, position: list[float]) -> list[float]:
        """
        Calculate and return the gravitational acceleration at the current position.
        
        This method should be implemented in subclasses.
        
        :return: List containing gravitational acceleration in X, Y and Z directions.
        """
        raise NotImplementedError("This method should be implemented in a subclass")

    @property
    def Re(self) -> float:
        """
        """
        return self._Re

    # @abstractmethod
    # def getFlattening(self) -> float:
    #     """
    #     """
    #     raise NotImplementedError("This method should be implemented in a subclass")

    @staticmethod
    def calculateRadius(position: np.array) -> float:
        """
        """
        return np.linalg.norm(position)
