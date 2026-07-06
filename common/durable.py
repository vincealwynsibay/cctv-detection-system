"""
Durable enforcement-event emit.
===============================
The producer half of the durable-buffer pattern (see experiments/durable-sink/).
The live worker calls emit_enforcement_event() to append an event to a Redis
Stream instead of writing Postgres directly. sink/sink.py drains that stream
into the enforcement_events table.

Why a stream and not a direct DB write: enforcement events (plate reads,
violations) are captured off a live camera feed that is NOT stored, so a write
lost while the DB is down is unrecoverable. Buffering in a Redis Stream (durable
on disk via AOF) turns a DB outage into a delay instead of data loss, on a
single node, without redundancy.

Emitting is best-effort and MUST NOT crash or block the detection loop: if Redis
itself is unavailable we log and move on (that is the total-node-loss failure
class, handled separately by backups — not by this path).
"""

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

import redis

ENFORCEMENT_STREAM = os.getenv("ENFORCEMENT_STREAM", "enforcement_events")
# Cap the stream so a prolonged DB outage can't grow it without bound. ~1M
# events is hours of headroom; approximate trimming (~) is cheap.
STREAM_MAXLEN = int(os.getenv("ENFORCEMENT_STREAM_MAXLEN", "1000000"))

_REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
_redis: Optional[redis.Redis] = None


def _client() -> redis.Redis:
    global _redis
    if _redis is None:
        _redis = redis.from_url(_REDIS_URL)
    return _redis


def make_event_id(cctv_id: int, track_id: int, captured_at: datetime) -> str:
    """Stable idempotency key for one source event. A given (camera, track,
    first-sighting time) always maps to the same id, so re-emitting it is a
    no-op at the sink (ON CONFLICT (event_id) DO NOTHING)."""
    return f"{cctv_id}:{track_id}:{int(captured_at.timestamp() * 1000)}"


def emit_enforcement_event(
    *,
    cctv_id: int,
    track_id: int,
    vehicle_type: str,
    confidence: float,
    event_type: str = "vehicle_candidate",
    plate: Optional[str] = None,
    captured_at: Optional[datetime] = None,
    meta: Optional[dict] = None,
    event_id: Optional[str] = None,
) -> Optional[str]:
    """Append one enforcement event to the durable stream. Returns the event_id,
    or None if emission failed (never raises)."""
    captured_at = captured_at or datetime.now(timezone.utc)
    event_id = event_id or make_event_id(cctv_id, track_id, captured_at)
    payload = {
        "event_id":     event_id,
        "event_type":   event_type,
        "cctv_id":      cctv_id,
        "track_id":     track_id,
        "plate":        plate,
        "vehicle_type": vehicle_type,
        "confidence":   round(float(confidence), 4),
        "captured_at":  captured_at.astimezone(timezone.utc).isoformat(),
        "meta":         meta,
    }
    try:
        _client().xadd(
            ENFORCEMENT_STREAM,
            {"data": json.dumps(payload)},
            maxlen=STREAM_MAXLEN,
            approximate=True,
        )
        return event_id
    except Exception as e:  # redis down / any transport error - best effort
        print(f"[durable] emit failed (event dropped at source): {e}")
        return None
