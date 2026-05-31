from functools import wraps
from typing import Callable, Any, Union, List
import inspect
import logging

logger = logging.getLogger(__name__)

def __is_dict_based_call(args: tuple) -> bool:
    """ Check if the call is dict-based (single dict argument) """
    return len(args) == 1 and isinstance(args[0], dict)

def __filter_relevant_args(args_dict: dict, sig: inspect.Signature) -> dict:
    """ Filter out irrelevant parameters from the dictionary based on the function signature """
    return {k: v for k, v in args_dict.items() if k in sig.parameters}

def __fill_default_values(func: Callable, bound_arguments: inspect.BoundArguments, sig: inspect.Signature) -> None:
    """ Fill in default values for missing arguments """
    for index, (name, param) in enumerate(sig.parameters.items()):
        if name not in bound_arguments.arguments:
            if param.default is not param.empty:
                bound_arguments.arguments[name] = param.default
            else:
                msg = f"Missing required parameter '{name}' (position {index + 1}) for function '{func.__name__}'"
                logger.error(msg)
                raise ValueError(msg)

def dict_input(func: Callable) -> Callable:
    """ A decorator function for pre- and post-processing functions """

    @wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        sig = inspect.signature(func)

        if __is_dict_based_call(args):
            kwargs.update(args[0])
            relevant_args = __filter_relevant_args(kwargs, sig)
            bound_arguments = sig.bind_partial(**relevant_args)
        else:
            # Standard call
            bound_arguments = sig.bind_partial(*args, **__filter_relevant_args(kwargs, sig))

        __fill_default_values(func, bound_arguments, sig)

        # logger.info(f"Calling '{func.__name__}' with arguments: {bound_arguments.arguments}")
        return func(*bound_arguments.args, **bound_arguments.kwargs)

    return wrapper

def __validate_output_names(output_names: Union[None, str, List[str], Callable]) -> List[str]:
    if not output_names:
        return None
    if isinstance(output_names, str) and output_names:
        return [output_names]
    if isinstance(output_names, list) and all(isinstance(name, str) for name in output_names):
        return output_names
    if not output_names:
        msg = "No output names provided to the decorator"
        logger.error(msg)
        raise ValueError(msg)

    msg = f"Invalid type ({type(output_names)}) for output names. Must be a non-empty string or list of strings"
    logger.error(msg)
    raise TypeError(msg)

# TODO can use inspect.getdoc or something like that to receive the docstring and extract return name from it
def dict_output(output_names: List[str] = None) -> Callable:
    # Validate output_names
    output_names = __validate_output_names(output_names)

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            # Execute the function
            result = func(*args, **kwargs)

            # Handle dictionary result
            if isinstance(result, dict) and not output_names:
                return result # unpack the dict

            # Handle non-dictionary results
            if result is None:
                return result

            # Handle tuple results
            if isinstance(result, tuple):
                if len(result) != len(output_names):
                    msg = "Number of output names does not match the number of outputs"
                    logger.error(msg)
                    raise ValueError(msg)
                return dict(zip(output_names, result))

            # Handle single value results
            return {output_names[0]: result}

        return wrapper
    return decorator

def dict_input_output(output_names: List[str] = None) -> Callable:
    def decorator(func: Callable) -> Callable:
        func = dict_output(output_names)(func)
        func = dict_input(func)
        return func
    return decorator
