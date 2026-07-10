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
DETECTIONS_STREAM  = os.getenv("DETECTIONS_STREAM",  "detections_buffer")
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


def emit_detection(
    *,
    detection_uuid: str,
    cctv_id: int,
    track_id: int,
    object_type: str,
    confidence: float,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    initial_region_ids: Optional[list] = None,
    captured_at: Optional[datetime] = None,
) -> bool:
    """Emit a detection to the durable stream. Returns True on success.
    On first sighting the worker generates a UUID, calls this once with all
    regions the vehicle is already inside (initial_region_ids), and never
    touches the DB. The detection-sink drains and inserts both the detection
    row and the initial region entries atomically."""
    captured_at = captured_at or datetime.now(timezone.utc)
    payload = {
        "type":           "detection",
        "detection_uuid": detection_uuid,
        "cctv_id":        cctv_id,
        "track_id":       track_id,
        "object_type":    object_type,
        "confidence":     round(float(confidence), 4),
        "x1": x1, "y1": y1, "x2": x2, "y2": y2,
        "captured_at":    captured_at.astimezone(timezone.utc).isoformat(),
        "region_ids":     initial_region_ids or [],
    }
    try:
        _client().xadd(
            DETECTIONS_STREAM,
            {"data": json.dumps(payload)},
            maxlen=STREAM_MAXLEN,
            approximate=True,
        )
        return True
    except Exception as e:
        print(f"[durable] detection emit failed (dropped): {e}")
        return False


def emit_detection_region(*, detection_uuid: str, region_id: int) -> bool:
    """Emit a region-entry event for a detection entering a new region on a
    subsequent frame. The detection event (with its initial_region_ids) was
    already emitted on first sighting, so the sink will always see the
    detection before these region events."""
    payload = {"type": "region", "detection_uuid": detection_uuid, "region_id": region_id}
    try:
        _client().xadd(
            DETECTIONS_STREAM,
            {"data": json.dumps(payload)},
            maxlen=STREAM_MAXLEN,
            approximate=True,
        )
        return True
    except Exception as e:
        print(f"[durable] region emit failed (dropped): {e}")
        return False
