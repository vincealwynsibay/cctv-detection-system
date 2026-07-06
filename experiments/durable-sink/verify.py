"""
Verify — the assertion that closes the demo.
============================================
Compares what the producer emitted against what actually landed in the DB and
the state of the Redis stream, then prints PASS/FAIL.

PASS requires all of:
  * DB row count == produced:unique       (nothing lost)
  * DB row count == sunk:total            (sink's own tally agrees with the DB)
  * stream backlog fully drained          (no un-acked events left)
  * produced:raw  >  produced:unique      (duplicates WERE emitted...)
  * DB row count  == produced:unique      (...and were deduped away, not stored)
"""

import os
import sys

import psycopg2
import redis

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/traffic")
STREAM = os.getenv("STREAM", "plate_reads")
GROUP = os.getenv("GROUP", "sink")


def main() -> None:
    r = redis.from_url(REDIS_URL, decode_responses=True)
    produced_unique = int(r.get("produced:unique") or 0)
    produced_raw = int(r.get("produced:raw") or 0)
    sunk_total = int(r.get("sunk:total") or 0)

    # Un-acked backlog across the consumer group.
    try:
        pending = r.xpending(STREAM, GROUP)["pending"]
    except redis.exceptions.ResponseError:
        pending = 0

    conn = psycopg2.connect(DATABASE_URL)
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM plate_reads")
        db_rows = cur.fetchone()[0]
    conn.close()

    dropped = produced_unique - db_rows
    dups = produced_raw - produced_unique

    print()
    print("  ┌─────────────────────────────────────────────────────────┐")
    print("  │  DURABLE-SINK RESULT                                     │")
    print("  ├─────────────────────────────────────────────────────────┤")
    print(f"  │  unique events emitted (must persist) : {produced_unique:<15}│")
    print(f"  │  duplicate re-emits (must be deduped)  : {dups:<15}│")
    print(f"  │  raw XADDs to stream                   : {produced_raw:<15}│")
    print(f"  │  rows actually in DB                   : {db_rows:<15}│")
    print(f"  │  sink's own committed tally            : {sunk_total:<15}│")
    print(f"  │  un-acked backlog in stream            : {pending:<15}│")
    print(f"  │  DROPPED (lost forever)                : {dropped:<15}│")
    print("  └─────────────────────────────────────────────────────────┘")

    ok = (
        db_rows == produced_unique
        and db_rows == sunk_total
        and pending == 0
        and produced_raw > produced_unique   # duplicates really were injected
    )
    if ok:
        print("\n  ✅ PASS — DB died mid-stream, zero events lost, duplicates deduped.\n")
        sys.exit(0)
    print("\n  ❌ FAIL — see numbers above.\n")
    sys.exit(1)


if __name__ == "__main__":
    main()
