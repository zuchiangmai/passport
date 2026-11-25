"""app links, auth codes, oauth transactions

Revision ID: a1b2c3d4e5f6
Revises: f089c65eff0b
Create Date: 2026-11-24 12:20:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "f089c65eff0b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "app_links",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("app", sa.String(length=32), nullable=False),
        sa.Column("external_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "app", name="uq_app_links_user_app"),
        sa.UniqueConstraint("app", "external_id", name="uq_app_links_app_external"),
    )
    op.create_index("ix_app_links_user_id", "app_links", ["user_id"])
    op.create_table(
        "auth_codes",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("client_id", sa.String(length=32), nullable=False),
        sa.Column("redirect_uri", sa.String(length=1000), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_auth_codes_code_hash", "auth_codes", ["code_hash"], unique=True)
    op.create_index("ix_auth_codes_user_id", "auth_codes", ["user_id"])
    op.create_table(
        "oauth_transactions",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("provider", sa.String(length=16), nullable=False),
        sa.Column("client_id", sa.String(length=32), nullable=False),
        sa.Column("redirect_uri", sa.String(length=1000), nullable=False),
        sa.Column("client_state", sa.String(length=500), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("oauth_transactions")
    op.drop_index("ix_auth_codes_user_id", table_name="auth_codes")
    op.drop_index("ix_auth_codes_code_hash", table_name="auth_codes")
    op.drop_table("auth_codes")
    op.drop_index("ix_app_links_user_id", table_name="app_links")
    op.drop_table("app_links")
