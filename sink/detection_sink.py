"""
Detection sink - durable drain from Redis Stream -> Postgres.
=============================================================
Drains the detections_buffer stream into the detections table (and
detections_in_regions for region entries). Mirrors the at-least-once +
idempotent pattern of sink/sink.py.

Two event types arrive on the same stream in emission order:

  {"type": "detection", "detection_uuid": ..., ...fields, "region_ids": [...]}
    Written by the worker on first sighting of a track. Contains the full
    detection row plus the list of regions the vehicle was already inside on
    that frame. Inserted with ON CONFLICT (detection_uuid) DO NOTHING.

  {"type": "region", "detection_uuid": ..., "region_id": ...}
    Written by the worker when a tracked vehicle enters a new region on a
    subsequent frame. The detection row is guaranteed to be in the stream
    (and therefore in the DB) before these events because they are emitted
    after the detection event in the same ordered stream.

Run:  python -m sink.detection_sink
"""

import json
import os
import time
from datetime import datetime

import redis
from sqlalchemy import text
from sqlalchemy.exc import OperationalError, InterfaceError
from sqlalchemy.dialects.postgresql import insert as pg_insert

from common.database import engine
from common.models import Detection, DetectionInRegion

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
STREAM    = os.getenv("DETECTIONS_STREAM", "detections_buffer")
GROUP     = os.getenv("DETECTION_GROUP",   "detection-sink")
CONSUMER  = os.getenv("HOSTNAME",          "detection-sink-1")
BATCH     = int(os.getenv("SINK_BATCH",    "200"))


def connect_redis() -> redis.Redis:
    r = redis.from_url(REDIS_URL, decode_responses=True)
    while True:
        try:
            r.ping()
            return r
        except redis.exceptions.ConnectionError:
            print("[detection-sink] waiting for redis...")
            time.sleep(1)


def ensure_group(r: redis.Redis) -> None:
    try:
        r.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
        print(f"[detection-sink] created consumer group '{GROUP}' on '{STREAM}'")
    except redis.exceptions.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


def process_batch(msgs: list) -> tuple[int, int]:
    """Insert all events from a batch in one transaction.
    Returns (detections_inserted, region_entries_inserted)."""
    detection_events = []
    region_events = []
    for _, fields in msgs:
        e = json.loads(fields["data"])
        if e.get("type") == "detection":
            detection_events.append(e)
        elif e.get("type") == "region":
            region_events.append(e)

    det_inserted = 0
    reg_inserted = 0

    with engine.begin() as conn:
        if detection_events:
            det_rows = [{
                "detection_uuid": e["detection_uuid"],
                "cctv_id":        e.get("cctv_id"),
                "track_id":       e.get("track_id"),
                "object_type":    e["object_type"],
                "confidence":     e["confidence"],
                "x1": e["x1"], "y1": e["y1"], "x2": e["x2"], "y2": e["y2"],
                "time":           datetime.fromisoformat(e["captured_at"]),
            } for e in detection_events]
            stmt = pg_insert(Detection).values(det_rows).on_conflict_do_nothing(
                index_elements=["detection_uuid", "time"],
                index_where=text("detection_uuid IS NOT NULL"),
            )
            result = conn.execute(stmt)
            det_inserted = result.rowcount or 0

        # Region entries: initial ones bundled with detection events, plus
        # subsequent ones from separate region events.
        reg_rows = []
        for e in detection_events:
            for rid in (e.get("region_ids") or []):
                reg_rows.append({"detection_uuid": e["detection_uuid"], "region_id": rid})
        for e in region_events:
            reg_rows.append({"detection_uuid": e["detection_uuid"], "region_id": e["region_id"]})

        if reg_rows:
            # Existing analytics JOIN detections_in_regions.detection_id -> detections.id
            # (a plain BigInteger, not a FK - see migration 0020). We populate it
            # alongside detection_uuid so those queries pick up durable-path rows
            # too; without this the UI count paths silently drop everything.
            uuids = list({r["detection_uuid"] for r in reg_rows})
            id_map = {
                row.detection_uuid: row.id
                for row in conn.execute(
                    text("SELECT id, detection_uuid FROM detections WHERE detection_uuid = ANY(:uuids)"),
                    {"uuids": uuids},
                )
            }
            for r in reg_rows:
                r["detection_id"] = id_map.get(r["detection_uuid"])
            # Any region row whose detection didn't land in this batch will be
            # written in a later batch when its region event replays.
            reg_rows = [r for r in reg_rows if r["detection_id"] is not None]
            if reg_rows:
                stmt = pg_insert(DetectionInRegion).values(reg_rows).on_conflict_do_nothing(
                    constraint="uq_dir_detection_uuid_region_id"
                )
                result = conn.execute(stmt)
                reg_inserted = result.rowcount or 0

    return det_inserted, reg_inserted


def commit_with_retry(r: redis.Redis, msgs: list) -> None:
    ids = [mid for mid, _ in msgs]
    backoff = 0.5
    while True:
        try:
            det, reg = process_batch(msgs)
            r.xack(STREAM, GROUP, *ids)
            print(f"[detection-sink] committed det={det} reg={reg} / {len(msgs)} in batch, acked")
            return
        except (OperationalError, InterfaceError) as e:
            msg = str(e).splitlines()[0]
            print(f"[detection-sink] DB unavailable, holding {len(msgs)} events, retrying: {msg}")
            time.sleep(backoff)
            backoff = min(backoff * 2, 5.0)


def main() -> None:
    r = connect_redis()
    ensure_group(r)
    print(f"[detection-sink] draining '{STREAM}' -> detections (batch={BATCH}, consumer={CONSUMER})")

    while True:
        resp = r.xreadgroup(GROUP, CONSUMER, {STREAM: "0"}, count=BATCH)
        pending = resp[0][1] if resp else []
        if not pending:
            break
        print(f"[detection-sink] recovering {len(pending)} pending events from previous run")
        commit_with_retry(r, pending)

    while True:
        resp = r.xreadgroup(GROUP, CONSUMER, {STREAM: ">"}, count=BATCH, block=2000)
        if not resp:
            continue
        msgs = resp[0][1]
        if msgs:
            commit_with_retry(r, msgs)


if __name__ == "__main__":
    main()
