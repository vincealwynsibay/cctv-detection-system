"""
Producer — simulates the live worker's write path.
=================================================
Instead of writing detections straight to Postgres (worker/main.py:process_detection),
it XADDs each plate-read event to a Redis Stream. That is the whole change the
real system needs: capture is decoupled from persistence.

Two counters are maintained in Redis so the demo can show, live, that no data is
lost even while the DB is down:

  produced:unique  distinct business events emitted (the number that MUST end up
                   in the DB)
  produced:raw     total XADDs including deliberate duplicate re-emits (simulated
                   retries / redeliveries) — proves the sink's dedup actually fires

Run:  python producer.py --count 4000 --rate 200 --dup-prob 0.05
"""

import argparse
import json
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import redis

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
STREAM = os.getenv("STREAM", "plate_reads")

PLATE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"
VEHICLE_TYPES = ["car", "motorcycle", "truck", "jeepney", "bus"]


def connect() -> redis.Redis:
    """Connect to Redis, retrying — the stack may still be coming up."""
    r = redis.from_url(REDIS_URL, decode_responses=True)
    for _ in range(30):
        try:
            r.ping()
            return r
        except redis.exceptions.ConnectionError:
            print("[producer] waiting for redis...")
            time.sleep(1)
    raise SystemExit("[producer] redis never came up")


def make_plate(i: int) -> str:
    return f"{PLATE_LETTERS[i % len(PLATE_LETTERS)]}{PLATE_LETTERS[(i // 24) % len(PLATE_LETTERS)]}{PLATE_LETTERS[(i // 576) % len(PLATE_LETTERS)]} {1000 + (i % 9000)}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=4000, help="unique events to emit")
    ap.add_argument("--rate", type=float, default=200.0, help="events per second")
    ap.add_argument("--dup-prob", type=float, default=0.05,
                    help="probability each event is emitted twice (simulated redelivery)")
    args = ap.parse_args()

    r = connect()

    # Fresh run: clear counters (the stream itself is cleared by run_demo.sh via down -v).
    r.delete("produced:unique", "produced:raw")

    interval = 1.0 / args.rate if args.rate > 0 else 0.0
    # Monotonic base time so every (cctv_id, plate, captured_at) tuple is unique.
    base = datetime.now(timezone.utc)

    print(f"[producer] emitting {args.count} events @ {args.rate}/s "
          f"(dup-prob={args.dup_prob}) -> stream '{STREAM}'")

    # Deterministic pseudo-random without importing random's global state churn.
    seed = 1234567
    def rnd() -> float:
        nonlocal seed
        seed = (1103515245 * seed + 12345) & 0x7FFFFFFF
        return seed / 0x7FFFFFFF

    for i in range(args.count):
        cctv_id = 1 + (i % 8)
        event = {
            "event_id":     str(uuid.uuid4()),
            "cctv_id":      cctv_id,
            "plate":        make_plate(i),
            "captured_at":  (base + timedelta(milliseconds=i)).isoformat(),
            "confidence":   round(0.60 + 0.39 * rnd(), 3),
            "vehicle_type": VEHICLE_TYPES[i % len(VEHICLE_TYPES)],
        }
        payload = json.dumps(event)

        r.xadd(STREAM, {"data": payload})
        r.incr("produced:raw")
        r.incr("produced:unique")

        # Occasionally re-emit the SAME event (same business key) to simulate a
        # redelivery / at-least-once retry. The sink must dedup this away.
        if rnd() < args.dup_prob:
            r.xadd(STREAM, {"data": payload})
            r.incr("produced:raw")

        if interval:
            time.sleep(interval)

    print(f"[producer] done. unique={r.get('produced:unique')} raw={r.get('produced:raw')}")


if __name__ == "__main__":
    main()
