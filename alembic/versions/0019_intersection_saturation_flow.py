"""add saturation_flow_pcu_hr to intersections

Lets each intersection override the global Webster saturation flow default
(1400 PCU/hr for Philippine mixed-traffic single-lane approaches) once it
has been calibrated against measured discharge headways.

Revision ID: 0019
Revises: 0018
Create Date: 2026-06-29
"""
from alembic import op
import sqlalchemy as sa


revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "intersections",
        sa.Column("saturation_flow_pcu_hr", sa.Integer(), nullable=False, server_default="1400"),
    )


def downgrade() -> None:
    op.drop_column("intersections", "saturation_flow_pcu_hr")
