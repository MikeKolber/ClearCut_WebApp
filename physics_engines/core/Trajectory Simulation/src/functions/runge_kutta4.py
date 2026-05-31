import numpy as np

def runge_kutta4(fun, x0, y0, h: float = 0.01):
    """ Runge-Kutta 4 method
    """
    k_0 = fun(x0, y0)
    k_1 = fun(x0 + h/2, y0 + h/2 * k_0)
    k_2 = fun(x0 + h/2, y0 + h/2 * k_1)
    k_3 = fun(x0 + h, y0 + h * k_2)

    k = 1/6 * (k_0 + 2.0*k_1 + 2.0*k_2 + k_3)

    y1 = y0 + h * k

    return y1
