"""add enforcement_events table (durable-buffer sink target)

The retained event class for future enforcement features (license-plate reads,
traffic violations). Unlike `detections` — a Timescale hypertable with a 72h
retention policy, i.e. transient and re-derivable — these events must be kept,
so they live in a plain table with their own durability guarantees.

Rows are written by `sink/sink.py`, which drains a Redis Stream fed by the live
worker. `event_id` carries a UNIQUE constraint so the sink's at-least-once
replay is idempotent (`ON CONFLICT (event_id) DO NOTHING`): a batch redelivered
after a crash mid-drain never creates duplicates.

Revision ID: 0020
Revises: 0019
Create Date: 2026-07-06
"""
from alembic import op
import sqlalchemy as sa


revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "enforcement_events",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        # Producer-generated idempotency key (stable per source event).
        sa.Column("event_id", sa.Text(), nullable=False),
        # 'vehicle_candidate' now; 'plate_read' / 'violation' as OCR + rules land.
        sa.Column("event_type", sa.String(length=40), nullable=False),
        # Plain int, deliberately NOT a foreign key: an append-only event log
        # must never fail to record because a camera row is missing or changed
        # (a write-time FK would be a poison-message vector for the sink).
        # Mirrors detections_in_regions.detection_id, which is also a bare int.
        sa.Column("cctv_id", sa.Integer(), nullable=True),
        sa.Column("track_id", sa.Integer(), nullable=True),
        sa.Column("plate", sa.String(length=16), nullable=True),
        sa.Column("vehicle_type", sa.String(length=50), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("meta", sa.JSON(), nullable=True),
        sa.Column("stored_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
    )
    # Idempotency key for the sink's ON CONFLICT DO NOTHING.
    op.create_unique_constraint(
        "uq_enforcement_events_event_id", "enforcement_events", ["event_id"],
    )
    # Query paths: recent events per camera, and per type.
    op.create_index(
        "ix_enforcement_events_cctv_captured",
        "enforcement_events", ["cctv_id", "captured_at"],
    )
    op.create_index(
        "ix_enforcement_events_type_captured",
        "enforcement_events", ["event_type", "captured_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_enforcement_events_type_captured", table_name="enforcement_events")
    op.drop_index("ix_enforcement_events_cctv_captured", table_name="enforcement_events")
    op.drop_constraint("uq_enforcement_events_event_id", "enforcement_events", type_="unique")
    op.drop_table("enforcement_events")
