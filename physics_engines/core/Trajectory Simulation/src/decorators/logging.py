from functools import wraps
from typing import Callable, Any, Type
import logging

logger = logging.getLogger(__name__)

def log(func: Callable) -> Callable:
    """
    A decorator that logs the call to a function, including the function's name, 
    positional arguments, and keyword arguments.

    Args:
        func (Callable): The function to be wrapped and logged.

    Returns:
        Callable: The wrapped function with logging enabled.
    """
    @wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        name = func.__name__ if hasattr(func, '__name__') else func.func.__name__
        args_str = ', '.join(repr(arg) for arg in args)
        kwargs_str = ', '.join(f"{k}={v!r}" for k, v in kwargs.items())
        logger.info(f"Calling function '{name}' with arguments: ({args_str}) and keyword arguments: {{{kwargs_str}}}")
        return func(*args, **kwargs)
    return wrapper

def log_class(cls: Type) -> Type:
    """
    A class decorator that applies the `log` decorator to each method in the class, 
    including the `__init__` method, to log the calls to the methods and the 
    initialization of class instances.

    Args:
        cls (Type): The class to be decorated.

    Returns:
        Type: The modified class with logging enabled for each method.
    
    Note:
        This decorator will wrap all methods except special methods (those starting 
        with double underscores) in the `log` decorator.
    """
    # Wrap __init__ method to log class instantiation
    if hasattr(cls, '__init__'):
        original_init = cls.__init__
        
        @wraps(original_init)
        def init_wrapper(*args: Any, **kwargs: Any) -> Any:
            logger.info(f"Initializing {cls.__name__} class")
            return original_init(*args, **kwargs)
        
        cls.__init__ = init_wrapper

    # # Wrap all other methods to log calls
    # for attr_name, attr_value in cls.__dict__.items():
    #     if callable(attr_value) and not attr_name.startswith("__"):
    #         setattr(cls, attr_name, log(attr_value))

    return cls
