"""Unit conversion to canonical units: m, s, kcal, m/s, degC.

HAE units follow the phone's locale (mi/km, ft/m, mph/kmph, degF/degC).
Units not listed here pass through unchanged (e.g. bpm, count, spm, W, %).
"""
from typing import Callable

_LINEAR: dict[str, tuple[str, float]] = {
    # distance / length
    "m": ("m", 1.0),
    "km": ("m", 1000.0),
    "cm": ("m", 0.01),
    "mi": ("m", 1609.344),
    "ft": ("m", 0.3048),
    "yd": ("m", 0.9144),
    # energy
    "kcal": ("kcal", 1.0),
    "kj": ("kcal", 1 / 4.184),
    # speed
    "m/s": ("m/s", 1.0),
    "mps": ("m/s", 1.0),
    "kmph": ("m/s", 1 / 3.6),
    "km/h": ("m/s", 1 / 3.6),
    "km/hr": ("m/s", 1 / 3.6),
    "mph": ("m/s", 0.44704),
    "mi/hr": ("m/s", 0.44704),
    # time
    "s": ("s", 1.0),
    "sec": ("s", 1.0),
    "min": ("s", 60.0),
    "hr": ("s", 3600.0),
    "h": ("s", 3600.0),
}

_AFFINE: dict[str, tuple[str, Callable[[float], float]]] = {
    "degc": ("degC", lambda v: v),
    "degf": ("degC", lambda v: (v - 32) * 5 / 9),
}


def convert(qty: float, unit: str | None) -> tuple[float, str | None]:
    if unit is None:
        return qty, None
    key = unit.strip().lower()
    if key in _LINEAR:
        canonical, factor = _LINEAR[key]
        return qty * factor, canonical
    if key in _AFFINE:
        canonical, fn = _AFFINE[key]
        return fn(qty), canonical
    return qty, unit
