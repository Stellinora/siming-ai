"""Capture only rows changed by one author deletion, including ORM/FK cascades."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, and_, event, inspect, select

from app.database.session import Base

AUTHOR_MODULES = (
    "app.modules.story.infrastructure.entities",
    "app.modules.assistant.infrastructure.models",
    "app.modules.continuity.infrastructure.models",
    "app.modules.creation.infrastructure.models",
)
EXCLUDED_TABLES = {
    "rag_chunk_embeddings",
    "novel_creation_run_claims",
    "assistant_runs",
    "assistant_run_steps",
}


def author_tables():
    # Import the canonical model catalogue before walking registered mappers.
    from app.database import models as _models  # noqa: F401

    return {
        mapper.local_table.name: mapper.local_table
        for mapper in Base.registry.mappers
        if (
            mapper.class_.__module__ in AUTHOR_MODULES
            or mapper.local_table.name in {"skills", "skill_versions", "sync_projects"}
        )
        and mapper.local_table.name not in EXCLUDED_TABLES
    }


def encode_row(row):
    if row is None:
        return None
    return {
        key: value.isoformat() if isinstance(value, (date, datetime)) else value
        for key, value in dict(row).items()
    }


def decode_row(table, row):
    result = dict(row)
    for column in table.columns:
        value = result.get(column.name)
        if value is not None and isinstance(column.type, DateTime):
            result[column.name] = datetime.fromisoformat(value)
        elif value is not None and isinstance(column.type, Date):
            result[column.name] = date.fromisoformat(value)
    return result


def key_for(table, row):
    return tuple(row[column.name] for column in table.primary_key)


def predicate(table, key):
    return and_(*(column == value for column, value in zip(table.primary_key, key, strict=True)))


class DeletionRecorder:
    def __init__(self, db):
        self.db = db
        self.tables = author_tables()
        self.before = {}
        self.pending_new = []
        self.expanded = set()
        self.inbound = {}
        for table in self.tables.values():
            for fk in table.foreign_keys:
                self.inbound.setdefault(fk.column.table.name, []).append(fk)

    def read(self, table, key):
        row = (
            self.db.connection()
            .execute(select(table).where(predicate(table, key)))
            .mappings()
            .first()
        )
        return encode_row(row)

    def remember(self, table, row, *, cascade=False):
        if table.name not in self.tables:
            return
        key = key_for(table, row)
        address = (table.name, key)
        if address not in self.before:
            self.before[address] = encode_row(row)
        if not cascade or address in self.expanded:
            return
        self.expanded.add(address)
        for fk in self.inbound.get(table.name, []):
            child = fk.parent.table
            rows = (
                self.db.connection()
                .execute(select(child).where(fk.parent == row[fk.column.name]))
                .mappings()
            )
            for related in rows:
                self.remember(child, related, cascade=(fk.ondelete or "").upper() == "CASCADE")

    def before_flush(self, session, _context, _instances):
        for value in list(session.dirty) + list(session.deleted):
            state = inspect(value)
            table = state.mapper.local_table
            if table.name not in self.tables or state.identity is None:
                continue
            row = self.read(table, state.identity)
            if row is not None:
                self.remember(table, row, cascade=value in session.deleted)
        self.pending_new.extend(
            value for value in session.new if inspect(value).mapper.local_table.name in self.tables
        )

    def after_flush(self, _session, _context):
        for value in self.pending_new:
            state = inspect(value)
            table = state.mapper.local_table
            if state.identity is not None:
                self.before.setdefault((table.name, state.identity), None)
        self.pending_new.clear()

    def __enter__(self):
        event.listen(self.db, "before_flush", self.before_flush)
        event.listen(self.db, "after_flush_postexec", self.after_flush)
        return self

    def __exit__(self, *_args):
        event.remove(self.db, "before_flush", self.before_flush)
        event.remove(self.db, "after_flush_postexec", self.after_flush)

    def changes(self):
        changes = []
        for (name, key), before in self.before.items():
            after = self.read(self.tables[name], key)
            if before != after:
                changes.append({"table": name, "key": list(key), "before": before, "after": after})
        return changes
