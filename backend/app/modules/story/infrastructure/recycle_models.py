"""Seven-day author-data recovery, stored in the existing database."""

from datetime import datetime

from sqlalchemy import Column, DateTime, Index, LargeBinary, String

from app.database.models_support import generate_uuid
from app.database.session import Base


class RecycleBinEntry(Base):
    __tablename__ = "recycle_bin_entries"

    id = Column(String(64), primary_key=True, default=generate_uuid)
    entity_type = Column(String(50), nullable=False)
    entity_id = Column(String(64), nullable=False)
    title = Column(String(300), nullable=False)
    project_id = Column(String(36), nullable=True)
    project_title = Column(String(200), nullable=True)
    deleted_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    snapshot = Column(LargeBinary, nullable=False)

    __table_args__ = (
        Index("ix_recycle_bin_expiry", "expires_at"),
        Index("ix_recycle_bin_project", "project_id", "deleted_at"),
    )
