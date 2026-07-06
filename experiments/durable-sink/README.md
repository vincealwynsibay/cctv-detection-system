# Durable-sink demo — surviving a database outage without redundancy

A controlled, one-command reproduction of the failure your professor raised:
**the database goes down while the system is producing events.** It proves that
an application-level write-ahead buffer (a Redis Stream) between the live worker
and TimescaleDB turns a DB outage from *data loss* into *a delay*, with **zero
events lost** — on a single node, no second server, no HA.

## The idea in one line

Today the live worker writes detections **straight** to Postgres
(`worker/main.py:process_detection`). If the DB is down, that write throws and
the event is **silently dropped** (`worker/main.py:510-513`) — unrecoverable,
because the live stream isn't stored. This demo inserts a durable buffer:

```
 worker/producer ──XADD──▶  Redis Stream (AOF on disk)  ──▶  sink ──ON CONFLICT──▶  TimescaleDB
   (capture)                (buffers while DB is down)      (drains, idempotent)      (persist)
```

- **DB down** → the sink holds its batch and retries; new events keep landing in
  the stream, which is durable on disk via Redis AOF.
- **DB back** → the sink drains the backlog. The unique constraint on the
  business key makes replay idempotent, so redeliveries don't duplicate.

## "WAL" — which one this is

Postgres's own WAL protects data *already committed* against a DB **crash**. It
does nothing while the DB is **unreachable** — you can't append to the WAL of a
database that isn't accepting connections. This demo is the *other* WAL: an
**application-level** write-ahead log sitting one layer out from the DB, which
is exactly the layer that keeps working when the DB is down.

## Run it

Requires only Docker (no host Python, no free ports needed).

```bash
./run_demo.sh
```

You'll watch, live: the DB gets killed mid-stream, `buffered` climbs while
`sunk` freezes and `stream_len` grows, then the DB returns and the gap collapses
to zero. It ends with:

```
✅ PASS — DB died mid-stream, zero events lost, duplicates deduped.
```

## What each PASS condition proves

| Check | Guarantees |
|---|---|
| `db_rows == produced:unique` | nothing was lost during the outage |
| `db_rows == sunk:total` | the sink's tally matches reality (no double count) |
| `pending == 0` | the whole backlog drained; no stuck events |
| `produced:raw > produced:unique` | duplicate deliveries really were injected... |
| `db_rows == produced:unique` | ...and were deduped, not stored twice |

## Files

- `producer.py` — stand-in for the live worker; `XADD`s plate-read events.
- `sink.py` — the durable drain: batch → `ON CONFLICT DO NOTHING` → `XACK` only
  after commit; retries forever while the DB is down; recovers its own pending
  on restart.
- `schema.sql` — `plate_reads` with the business-key unique constraint.
- `verify.py` — the zero-loss assertion.
- `run_demo.sh` — orchestrates the kill/recover timeline.

## What it does and does NOT cover (say this in the defense)

- **Covers:** the DB process going down — restart, migration, version upgrade,
  crash, connection-pool exhaustion. The common case, and the one asked about.
- **Does NOT cover:** total node loss (Redis is on the same box). That's a
  *different* failure class handled *separately* by off-box backups + WAL
  archiving. Two failure modes, two mechanisms — that separation is the point.

## Wiring it into the real system (future work)

1. In `worker/main.py`, replace the direct `db.add(detection)` with an `XADD` to
   a `detections` / `plate_reads` stream (capture stays real-time, never blocks
   on the DB).
2. Run `sink.py` as one more container in `docker-compose.yml` (a sibling of
   `rq-worker`), pointed at pgbouncer.
3. Add the business-key unique constraint via an Alembic migration.
4. Enable Redis AOF in the real `redis` service (`--appendonly yes`).
