"""
Enforcement-event sink — durable drain from Redis Stream -> Postgres.
====================================================================
The consumer half of the durable-buffer pattern. Reads the enforcement_events
stream via a consumer group and writes rows to the enforcement_events table.

Durability contract (at-least-once, made effectively-once by the DB unique
constraint on event_id):
  1. Read a batch from the stream.
  2. Insert it in ONE transaction with ON CONFLICT (event_id) DO NOTHING.
  3. XACK the batch ONLY after the commit succeeds.

If the DB is down, step 2 raises OperationalError; we do NOT ack, we hold the
batch and retry with backoff while new events accumulate durably in the stream
(Redis AOF). When the DB returns, the batch commits, we ack, and drain the
backlog. On startup we reprocess this consumer's pending entries first, so a
crash of the sink itself is also safe.

Run:  python -m sink.sink       (as a docker-compose service; see compose file)

The standalone, dependency-free proof of this exact behaviour — including a
chaos harness that kills the DB mid-stream and asserts zero loss — lives in
experiments/durable-sink/.
"""

import json
import os
import time
from datetime import datetime

import redis
from sqlalchemy.exc import OperationalError, InterfaceError
from sqlalchemy.dialects.postgresql import insert as pg_insert

from common.database import engine
from common.models import EnforcementEvent

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
STREAM = os.getenv("ENFORCEMENT_STREAM", "enforcement_events")
GROUP = os.getenv("ENFORCEMENT_GROUP", "sink")
CONSUMER = os.getenv("HOSTNAME", "sink-1")
BATCH = int(os.getenv("SINK_BATCH", "200"))


def connect_redis() -> redis.Redis:
    r = redis.from_url(REDIS_URL, decode_responses=True)
    while True:
        try:
            r.ping()
            return r
        except redis.exceptions.ConnectionError:
            print("[sink] waiting for redis...")
            time.sleep(1)


def ensure_group(r: redis.Redis) -> None:
    try:
        r.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
        print(f"[sink] created consumer group '{GROUP}' on '{STREAM}'")
    except redis.exceptions.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


def to_row(fields: dict) -> dict:
    e = json.loads(fields["data"])
    return {
        "event_id":     e["event_id"],
        "event_type":   e.get("event_type", "vehicle_candidate"),
        "cctv_id":      e.get("cctv_id"),
        "track_id":     e.get("track_id"),
        "plate":        e.get("plate"),
        "vehicle_type": e.get("vehicle_type"),
        "confidence":   e.get("confidence"),
        "captured_at":  datetime.fromisoformat(e["captured_at"]),
        "meta":         e.get("meta"),
    }


def insert_batch(rows: list[dict]) -> int:
    """Insert one batch in a single transaction. Returns rows inserted.
    Raises on DB error so the caller can retry without acking."""
    stmt = pg_insert(EnforcementEvent).values(rows).on_conflict_do_nothing(
        index_elements=["event_id"]
    )
    with engine.begin() as conn:      # BEGIN ... COMMIT, or ROLLBACK on error
        result = conn.execute(stmt)
    return result.rowcount or 0


def commit_with_retry(r: redis.Redis, msgs: list) -> None:
    """Persist a batch, retrying until the DB accepts it, THEN ack. The heart of
    the durability guarantee: while the DB is down we hold here; the stream keeps
    buffering new events."""
    rows = [to_row(f) for _, f in msgs]
    ids = [mid for mid, _ in msgs]
    backoff = 0.5
    while True:
        try:
            inserted = insert_batch(rows)
            r.xack(STREAM, GROUP, *ids)
            print(f"[sink] committed {inserted} new / {len(rows)} in batch, acked")
            return
        except (OperationalError, InterfaceError) as e:
            # Connection-level only: the DB is genuinely down/unreachable -> hold
            # the batch and retry (the durability guarantee). Non-connection DB
            # errors (bad data etc.) are NOT swallowed as "outages" here; they
            # propagate so they surface loudly instead of looping forever.
            msg = str(e).splitlines()[0]
            print(f"[sink] DB unavailable, holding {len(rows)} events, retrying: {msg}")
            time.sleep(backoff)
            backoff = min(backoff * 2, 5.0)


def main() -> None:
    r = connect_redis()
    ensure_group(r)
    print(f"[sink] draining '{STREAM}' -> enforcement_events (batch={BATCH}, consumer={CONSUMER})")

    # Phase 1: reprocess anything left pending for this consumer from a prior run.
    while True:
        resp = r.xreadgroup(GROUP, CONSUMER, {STREAM: "0"}, count=BATCH)
        pending = resp[0][1] if resp else []
        if not pending:
            break
        print(f"[sink] recovering {len(pending)} pending events from previous run")
        commit_with_retry(r, pending)

    # Phase 2: live tail.
    while True:
        resp = r.xreadgroup(GROUP, CONSUMER, {STREAM: ">"}, count=BATCH, block=2000)
        if not resp:
            continue
        msgs = resp[0][1]
        if msgs:
            commit_with_retry(r, msgs)


if __name__ == "__main__":
    main()
