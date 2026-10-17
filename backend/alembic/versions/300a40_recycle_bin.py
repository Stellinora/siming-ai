"""Keep deleted author data in one bounded-retention table."""

import sqlalchemy as sa

from alembic import op

revision = "300a40_recycle_bin"
down_revision = "300a39_retire_free_onboarding"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    # The initial baseline creates current ORM tables for fresh/legacy databases.
    # Existing versioned databases still need this explicit migration.
    if not inspector.has_table("recycle_bin_entries"):
        op.create_table(
            "recycle_bin_entries",
            sa.Column("id", sa.String(64), primary_key=True),
            sa.Column("entity_type", sa.String(50), nullable=False),
            sa.Column("entity_id", sa.String(64), nullable=False),
            sa.Column("title", sa.String(300), nullable=False),
            sa.Column("project_id", sa.String(36), nullable=True),
            sa.Column("project_title", sa.String(200), nullable=True),
            sa.Column("deleted_at", sa.DateTime(), nullable=False),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
            sa.Column("snapshot", sa.LargeBinary(), nullable=False),
        )
    indexes = {
        index["name"]
        for index in sa.inspect(op.get_bind()).get_indexes("recycle_bin_entries")
    }
    if "ix_recycle_bin_expiry" not in indexes:
        op.create_index("ix_recycle_bin_expiry", "recycle_bin_entries", ["expires_at"])
    if "ix_recycle_bin_project" not in indexes:
        op.create_index("ix_recycle_bin_project", "recycle_bin_entries", ["project_id", "deleted_at"])


def downgrade():
    op.drop_table("recycle_bin_entries")
