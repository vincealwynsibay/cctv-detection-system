"""
Sink — the durable drain from Redis Stream -> Postgres/TimescaleDB.
==================================================================
This is the piece that makes "the database goes down" a non-event.

Contract (at-least-once, made effectively-once by the DB unique constraint):
  1. Read a batch from the stream via a consumer group.
  2. Insert it in ONE transaction with ON CONFLICT DO NOTHING.
  3. XACK the batch **only after the commit succeeds.**

If the DB is down, step 2 throws. We do NOT ack, we hold the batch, and we
retry with backoff. Meanwhile new events keep piling up *in the stream* (durable
on disk via Redis AOF), not in volatile memory. When the DB comes back the batch
commits, we ack, and we drain the backlog. Nothing is dropped.

On startup we first reprocess this consumer's pending (un-acked) entries, so a
crash of the sink itself mid-drain is also safe.

A Redis counter `sunk:total` is incremented by the number of rows *actually
inserted* (cur.rowcount, so duplicates don't inflate it) purely so the demo
monitor can watch progress without querying a possibly-down DB.
"""

import json
import os
import time

import psycopg2
from psycopg2.extras import execute_values
import redis

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/traffic")
STREAM = os.getenv("STREAM", "plate_reads")
GROUP = os.getenv("GROUP", "sink")
CONSUMER = os.getenv("CONSUMER", "sink-1")
BATCH = int(os.getenv("BATCH", "200"))

INSERT_SQL = """
    INSERT INTO plate_reads
        (event_id, cctv_id, plate, captured_at, confidence, vehicle_type)
    VALUES %s
    ON CONFLICT (cctv_id, plate, captured_at) DO NOTHING
"""


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


class DB:
    """Lazily (re)connecting Postgres handle. Survives the DB going away."""

    def __init__(self, dsn: str):
        self.dsn = dsn
        self.conn = None

    def _connect(self):
        self.conn = psycopg2.connect(self.dsn)
        self.conn.autocommit = False

    def insert_batch(self, rows: list[tuple]) -> int:
        """Insert one batch in a single transaction. Returns rows inserted.
        Raises on any DB error so the caller can retry without acking."""
        if self.conn is None or self.conn.closed:
            self._connect()
        try:
            with self.conn.cursor() as cur:
                # page_size > batch => single statement => cur.rowcount is exact.
                execute_values(cur, INSERT_SQL, rows,
                               template="(%s,%s,%s,%s,%s,%s)",
                               page_size=len(rows) + 1)
                inserted = cur.rowcount
            self.conn.commit()
            return inserted
        except psycopg2.Error:
            # Roll back / drop the dead connection so the next attempt reconnects.
            try:
                self.conn.rollback()
            except Exception:
                pass
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = None
            raise


def to_row(fields: dict) -> tuple:
    e = json.loads(fields["data"])
    return (e["event_id"], e["cctv_id"], e["plate"],
            e["captured_at"], e["confidence"], e["vehicle_type"])


def commit_with_retry(db: DB, r: redis.Redis, msgs: list) -> None:
    """Persist a batch, retrying forever until the DB accepts it, THEN ack.
    This is the heart of the durability guarantee."""
    rows = [to_row(f) for _, f in msgs]
    ids = [mid for mid, _ in msgs]
    backoff = 0.5
    while True:
        try:
            inserted = db.insert_batch(rows)
            r.xack(STREAM, GROUP, *ids)
            if inserted:
                r.incrby("sunk:total", inserted)
            return
        except psycopg2.Error as e:
            print(f"[sink] DB unavailable, holding {len(rows)} events, retrying: "
                  f"{str(e).splitlines()[0]}")
            time.sleep(backoff)
            backoff = min(backoff * 2, 5.0)


def main() -> None:
    r = connect_redis()
    ensure_group(r)
    db = DB(DATABASE_URL)
    print(f"[sink] draining '{STREAM}' -> Postgres (batch={BATCH})")

    # Phase 1: reprocess anything left pending for this consumer from a prior run.
    while True:
        resp = r.xreadgroup(GROUP, CONSUMER, {STREAM: "0"}, count=BATCH)
        pending = resp[0][1] if resp else []
        if not pending:
            break
        print(f"[sink] recovering {len(pending)} pending events from previous run")
        commit_with_retry(db, r, pending)

    # Phase 2: live tail.
    while True:
        resp = r.xreadgroup(GROUP, CONSUMER, {STREAM: ">"}, count=BATCH, block=2000)
        if not resp:
            continue
        msgs = resp[0][1]
        if msgs:
            commit_with_retry(db, r, msgs)


if __name__ == "__main__":
    main()
