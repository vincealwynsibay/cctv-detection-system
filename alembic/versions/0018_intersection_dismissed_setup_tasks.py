"""add dismissed_setup_tasks to intersections

Persists per-intersection "snooze" decisions for onboarding tasks (regions,
timing, first_analysis, etc.) so the sidebar Setup Progress popover stops
nagging on intersections the operator has consciously skipped. Stored as a
JSON array of task names - keeps the migration minimal and lets the
frontend evolve the task vocabulary without further schema changes.

Revision ID: 0018
Revises: 0017
Create Date: 2026-06-27
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "intersections",
        sa.Column(
            "dismissed_setup_tasks",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("intersections", "dismissed_setup_tasks")
