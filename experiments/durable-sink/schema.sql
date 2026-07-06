-- Target table for the durable-buffer demo.
--
-- Models a "future works" enforcement event (a license-plate read) rather than
-- an aggregate count, because that is the data class whose loss actually
-- matters: it is captured off a live stream that is NOT stored, so a dropped
-- write is unrecoverable.
--
-- The unique constraint on the *business key* (cctv_id, plate, captured_at) is
-- what makes the sink's replay idempotent: if a batch is redelivered after a
-- crash mid-drain, the second insert hits ON CONFLICT DO NOTHING instead of
-- creating a duplicate row. This is an at-least-once pipeline made
-- effectively-once by the DB constraint.

CREATE TABLE IF NOT EXISTS plate_reads (
    id           BIGSERIAL PRIMARY KEY,
    event_id     TEXT        NOT NULL,        -- producer-side UUID (audit only)
    cctv_id      INTEGER     NOT NULL,
    plate        TEXT        NOT NULL,
    captured_at  TIMESTAMPTZ NOT NULL,
    confidence   REAL        NOT NULL,
    vehicle_type TEXT        NOT NULL,
    stored_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The dedup key. Replaying the same physical event is a no-op.
    CONSTRAINT plate_reads_business_key UNIQUE (cctv_id, plate, captured_at)
);

-- In the real system this would be a TimescaleDB hypertable partitioned on
-- captured_at:  SELECT create_hypertable('plate_reads', 'captured_at');
-- Omitted here so the demo works on plain Postgres too; the durability
-- behaviour is identical.
