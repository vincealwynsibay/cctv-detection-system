"""add detection_uuid to detections and detections_in_regions for durable stream

Adds a producer-generated UUID to the detections table so the worker can emit
detections to a Redis Stream (detections_buffer) without a synchronous DB
round-trip. The sink (sink/detection_sink.py) drains the stream and inserts
rows using detection_uuid as the idempotency key (ON CONFLICT DO NOTHING).

detection_uuid is also added to detections_in_regions so region entries written
by the sink can be linked to their detection without needing the BigInt PK.
Old rows keep detection_id (BigInt) set and detection_uuid NULL; new rows from
the stream path keep detection_id NULL and detection_uuid set. Postgres treats
NULLs as distinct in unique constraints, so the two populations never collide.

Revision ID: 0021
Revises: 0020
Create Date: 2026-07-09
"""
from alembic import op
import sqlalchemy as sa


revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotency key for the detection stream sink.
    op.add_column("detections", sa.Column("detection_uuid", sa.Text(), nullable=True))
    # TimescaleDB hypertables require unique indexes to include the partitioning
    # column (time). The sink stores the original captured_at timestamp, so a
    # replayed event has the same (detection_uuid, time) pair and is deduped.
    op.execute(
        "CREATE UNIQUE INDEX uq_detections_detection_uuid_time "
        "ON detections (detection_uuid, time) WHERE detection_uuid IS NOT NULL"
    )

    # Link column for region entries written via the durable path.
    op.add_column("detections_in_regions", sa.Column("detection_uuid", sa.Text(), nullable=True))
    # Legacy detection_id was NOT NULL; the durable path leaves it NULL and uses
    # detection_uuid instead, so relax the constraint. Postgres treats NULLs as
    # distinct in the unique index below, so old data is unaffected.
    op.alter_column("detections_in_regions", "detection_id", nullable=True)
    # detections_in_regions is NOT a hypertable, so a plain unique constraint works.
    # NULL detection_uuid rows (legacy path) are never considered equal, so old
    # data is unaffected.
    op.create_unique_constraint(
        "uq_dir_detection_uuid_region_id",
        "detections_in_regions",
        ["detection_uuid", "region_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_dir_detection_uuid_region_id", "detections_in_regions", type_="unique")
    op.alter_column("detections_in_regions", "detection_id", nullable=False)
    op.drop_column("detections_in_regions", "detection_uuid")
    op.execute("DROP INDEX IF EXISTS uq_detections_detection_uuid_time")
    op.drop_column("detections", "detection_uuid")
