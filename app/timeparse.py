"""Timestamp parsing for Health Auto Export.

HAE documents `yyyy-MM-dd HH:mm:ss Z` (e.g. "2024-02-06 07:00:00 -0800"). ISO 8601
variants are accepted too. Timestamps without an offset are rejected rather
than silently assumed to be UTC.
"""
from datetime import datetime, timezone

_FORMATS = (
    "%Y-%m-%d %H:%M:%S %z",
    "%Y-%m-%d %H:%M:%S.%f %z",
    "%Y-%m-%d %H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%f%z",
)


def parse_timestamp(value: object) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("expected a timestamp string")
    text = value.strip()
    for fmt in _FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("unrecognized timestamp format") from None
    if parsed.tzinfo is None:
        raise ValueError("timestamp has no timezone offset")
    return parsed


def to_utc_text(dt: datetime) -> str:
    utc = dt.astimezone(timezone.utc)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def offset_minutes(dt: datetime) -> int:
    return int(dt.utcoffset().total_seconds() // 60)
