"""Author deletion, recovery and expiry share one transactional implementation."""

from __future__ import annotations

import json
import zlib
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import false, inspect, select, update
from sqlalchemy.exc import IntegrityError

from app.architecture.uow import defer_session_commits
from app.core.exceptions import ConflictError, NotFoundError
from app.modules.story.infrastructure.recycle_models import RecycleBinEntry

from .recycle_snapshot import DeletionRecorder, author_tables, decode_row, encode_row, predicate

RETENTION_DAYS = 7
ENTRY_ID_CONTEXT = "siming.recycle_entry_id"
DELETED_AT_CONTEXT = "siming.recycle_deleted_at"
_CAPTURE_ACTIVE = "siming.recycle_capture_active"
ENTITY_TYPES = {
    "projects": "project",
    "chapters": "chapter",
    "outline_nodes": "outline",
    "characters": "character",
    "worldbuilding_entries": "worldbuilding",
    "novel_creation_sessions": "creation_session",
    "novel_creation_entities": "creation_entity",
    "assistant_conversations": "assistant_conversation",
    "system_assistant_conversations": "system_conversation",
    "assistant_memories": "assistant_memory",
    "chapter_drafts": "chapter_draft",
    "outline_drafts": "outline_draft",
    "skills": "skill",
    "character_relationships": "character_relationship",
    "chapter_characters": "character_appearance",
    "character_change_logs": "character_change_log",
    "worldbuilding_relations": "worldbuilding_relationship",
    "foreshadowings": "foreshadowing",
    "narrative_debts": "narrative_debt",
}


def purge_expired(db, *, now=None):
    now = now or datetime.utcnow()
    rows = db.query(RecycleBinEntry).filter(RecycleBinEntry.expires_at <= now).all()
    for row in rows:
        _purge_retained_root(db, row)
        db.delete(row)
    db.flush()
    return len(rows)


def _lock_writes(db):
    # Acquire the same cross-process SQLite writer lease before taking snapshots.
    # This statement does not change a row and remains valid on other databases.
    db.execute(update(RecycleBinEntry).where(false()).values(title=""))


def _require_idle(db, project_id, *, session_id=None, allow_current=True):
    from app.database.models import (
        AssistantRun,
        CatalogingJob,
        ContentSyncJob,
        NovelCreationMaterialImport,
        NovelCreationRunClaim,
        NovelCreationStageRun,
        OperationRun,
    )
    from app.modules.operations.interfaces.runtime import current_operation_id

    if project_id:
        if (
            not allow_current
            and db.query(AssistantRun.id)
            .filter(
                AssistantRun.project_id == project_id,
                AssistantRun.status.in_(["queued", "running", "cancelling", "pausing"]),
            )
            .first()
        ):
            raise ConflictError("作品仍有助手任务运行，请先停止任务再删除")
        query = db.query(OperationRun.id).filter(
            OperationRun.project_id == project_id,
            OperationRun.status.in_(["queued", "running", "cancelling", "pausing"]),
        )
        current = current_operation_id() if allow_current else None
        if current:
            query = query.filter(OperationRun.id != current)
        if (
            query.first()
            or db.query(CatalogingJob.id)
            .filter(
                CatalogingJob.project_id == project_id,
                CatalogingJob.status.in_(["queued", "running"]),
            )
            .first()
        ):
            raise ConflictError("作品仍有生成、建档或其他任务运行，请先停止任务再操作回收站")
        if (
            db.query(ContentSyncJob.id)
            .filter(
                ContentSyncJob.project_id == project_id,
                ContentSyncJob.status == "running",
            )
            .first()
        ):
            raise ConflictError("作品文件正在同步，请稍后再删除或恢复")
    if session_id:
        for model in (NovelCreationStageRun, NovelCreationMaterialImport, NovelCreationRunClaim):
            if (
                db.query(model.id)
                .filter(
                    model.session_id == session_id,
                    model.status.in_(["queued", "running"]),
                )
                .first()
            ):
                raise ConflictError("立项任务仍在运行，请先停止任务再删除或恢复")


def _root_metadata(db, root):
    from app.database.models import Project

    table = inspect(root).mapper.local_table.name
    if table not in ENTITY_TYPES:
        raise ValueError(f"Unsupported author deletion: {table}")
    kind = ENTITY_TYPES[table]
    root_id = str(root.id)
    project_id = root_id if kind == "project" else getattr(root, "project_id", None)
    if kind == "character_appearance":
        project_id = root.chapter.project_id
    if kind == "character_change_log":
        project_id = root.character.project_id
    if kind in {"creation_session", "creation_entity"}:
        session = root if kind == "creation_session" else root.session
        project_id = session.created_project_id or session.source_project_id
    project = db.get(Project, project_id) if project_id else None
    title = next(
        (
            str(getattr(root, key))
            for key in ("title", "name", "entity_key", "key", "content", "user_brief")
            if getattr(root, key, None)
        ),
        kind,
    )
    return dict(
        entity_type=kind,
        entity_id=root_id,
        title=title[:300],
        project_id=project_id,
        project_title=project.title if project else None,
    )


@contextmanager
def capture_deletion(db, root, *, entry_id=None):
    """Enclose the entire existing mutation, including derived-data rollback."""
    if db.info.get(_CAPTURE_ACTIVE):
        yield
        return
    db.flush()
    _lock_writes(db)
    metadata = _root_metadata(db, root)
    if metadata["entity_type"] == "system_conversation":
        from app.database.models import SystemAssistantMessage

        if (
            db.query(SystemAssistantMessage.id)
            .filter(
                SystemAssistantMessage.conversation_id == root.id,
                SystemAssistantMessage.status == "running",
            )
            .first()
        ):
            raise ConflictError("对话仍在生成，请先停止生成再删除")
    session_id = (
        root.id
        if metadata["entity_type"] == "creation_session"
        else (getattr(root, "session_id", None) or getattr(root, "creation_session_id", None))
    )
    _require_idle(
        db,
        metadata["project_id"],
        session_id=session_id,
        allow_current=metadata["entity_type"]
        not in {"project", "assistant_conversation", "system_conversation"},
    )
    purge_expired(db)
    now = datetime.utcnow()
    requested_time = db.info.get(DELETED_AT_CONTEXT)
    if requested_time is not None:
        if requested_time.tzinfo is not None:
            requested_time = requested_time.astimezone(UTC).replace(tzinfo=None)
        if requested_time > now + timedelta(minutes=5):
            raise ConflictError("删除时间超过允许的设备时钟偏差，请校准设备时间")
        now = min(now, requested_time)
    db.info[_CAPTURE_ACTIVE] = True
    try:
        with db.begin_nested():
            with defer_session_commits(db), DeletionRecorder(db) as recorder:
                yield
                db.flush()
            changes = recorder.changes()
            if changes:
                db.add(
                    RecycleBinEntry(
                        id=entry_id or db.info.get(ENTRY_ID_CONTEXT) or str(uuid4()),
                        **metadata,
                        deleted_at=now,
                        expires_at=now + timedelta(days=RETENTION_DAYS),
                        snapshot=zlib.compress(
                            json.dumps(
                                {"version": 1, "changes": changes},
                                ensure_ascii=False,
                                separators=(",", ":"),
                            ).encode("utf-8")
                        ),
                    )
                )
                db.flush()
    finally:
        db.info.pop(_CAPTURE_ACTIVE, None)


def delete_to_recycle(db, root, *, entry_id=None):
    with capture_deletion(db, root, entry_id=entry_id):
        db.delete(root)


def entry_data(entry):
    return {
        key: getattr(entry, key)
        for key in (
            "id",
            "entity_type",
            "entity_id",
            "title",
            "project_id",
            "project_title",
        )
    } | {key: getattr(entry, key).isoformat() + "Z" for key in ("deleted_at", "expires_at")}


def list_entries(db, *, project_id=None, entity_type=None, limit=50, offset=0):
    purge_expired(db)
    query = db.query(RecycleBinEntry)
    if project_id:
        query = query.filter(RecycleBinEntry.project_id == project_id)
    if entity_type:
        query = query.filter(RecycleBinEntry.entity_type == entity_type)
    total = query.count()
    items = (
        query.order_by(RecycleBinEntry.deleted_at.desc(), RecycleBinEntry.id)
        .offset(offset)
        .limit(limit)
        .all()
    )
    return {
        "items": [entry_data(row) for row in items],
        "total": total,
        "retention_days": RETENTION_DAYS,
    }


def _entry(db, entry_id, project_id=None):
    row = db.query(RecycleBinEntry).filter(RecycleBinEntry.id == entry_id).with_for_update().first()
    if row is None or (project_id is not None and row.project_id != project_id):
        raise NotFoundError("回收记录不存在、已过期或不属于当前作品")
    return row


def purge_entry(db, entry_id, *, project_id=None):
    _lock_writes(db)
    row = db.get(RecycleBinEntry, entry_id)
    if row is None:
        return
    row = _entry(db, entry_id, project_id)
    _purge_retained_root(db, row)
    db.delete(row)
    db.flush()


def _purge_retained_root(db, entry):
    if entry.entity_type not in {"chapter_draft", "outline_draft", "creation_entity"}:
        return
    tables = author_tables()
    changes = json.loads(zlib.decompress(entry.snapshot))["changes"]
    for item in changes:
        if item["key"] != [entry.entity_id] or item["after"] is None:
            continue
        if ENTITY_TYPES.get(item["table"]) != entry.entity_type:
            continue
        table = tables[item["table"]]
        current = (
            db.connection()
            .execute(select(table).where(predicate(table, item["key"])))
            .mappings()
            .first()
        )
        if encode_row(current) == item["after"]:
            db.connection().execute(table.delete().where(predicate(table, item["key"])))


def _validate_recovery(db, changes, tables):
    restored = {
        (item["table"], tuple(item["key"])) for item in changes if item["before"] is not None
    }
    for item in changes:
        table = tables.get(item["table"])
        if table is None:
            raise ConflictError("此回收记录的字段契约已变化，无法安全恢复")
        current = (
            db.connection()
            .execute(select(table).where(predicate(table, item["key"])))
            .mappings()
            .first()
        )
        if encode_row(current) != item["after"]:
            raise ConflictError("删除后的关联数据已被修改或原 ID 已被占用，无法覆盖恢复")
        before = item["before"]
        if before is None:
            continue
        if set(before) != set(table.columns.keys()):
            raise ConflictError("此回收记录的字段契约已变化，无法安全恢复")
        for fk in table.foreign_keys:
            target = before.get(fk.parent.name)
            if target is None or (fk.column.table.name, (target,)) in restored:
                continue
            exists = db.connection().execute(select(fk.column).where(fk.column == target)).first()
            if exists:
                continue
            if fk.column.table.name not in tables and fk.parent.nullable:
                # Ephemeral execution/context state is never resurrected.
                before[fk.parent.name] = None
            else:
                raise ConflictError("恢复依赖的作品或关联对象不存在，请先恢复该对象")


def _restore_changes(db, changes, tables):
    # Restore new rows in FK order; nullable cycles are wired after insertion.
    pending = [item for item in changes if item["before"] is not None and item["after"] is None]
    links = []
    while pending:
        progress = False
        identities = {(item["table"], tuple(item["key"])) for item in pending}
        for item in list(pending):
            table = tables[item["table"]]
            values = decode_row(table, item["before"])
            deferred = {}
            blocked = False
            for fk in table.foreign_keys:
                value = values.get(fk.parent.name)
                if value is None or (fk.column.table.name, (value,)) not in identities:
                    continue
                if fk.parent.nullable:
                    deferred[fk.parent.name] = value
                    values[fk.parent.name] = None
                else:
                    blocked = True
            if blocked:
                continue
            db.connection().execute(table.insert().values(**values))
            if deferred:
                links.append((table, item["key"], deferred))
            pending.remove(item)
            progress = True
        if not progress:
            raise ConflictError("回收记录包含无法恢复的循环依赖")
    for item in changes:
        table = tables[item["table"]]
        if item["before"] is not None and item["after"] is not None:
            db.connection().execute(
                table.update()
                .where(predicate(table, item["key"]))
                .values(**decode_row(table, item["before"]))
            )
    for table, key, values in links:
        db.connection().execute(table.update().where(predicate(table, key)).values(**values))
    for item in reversed(changes):
        if item["before"] is None:
            table = tables[item["table"]]
            db.connection().execute(table.delete().where(predicate(table, item["key"])))


def restore_entry(db, entry_id, *, project_id=None, now=None):
    db.flush()
    _lock_writes(db)
    row = _entry(db, entry_id, project_id)
    if (now or datetime.utcnow()) >= row.expires_at:
        raise ConflictError("该数据已超过 7 天保留期，无法恢复")
    _require_idle(
        db,
        row.project_id,
        session_id=row.entity_id if row.entity_type == "creation_session" else None,
    )
    result = {key: getattr(row, key) for key in ("id", "entity_type", "entity_id", "project_id")}
    changes = json.loads(zlib.decompress(row.snapshot))["changes"]
    tables = author_tables()
    try:
        with db.begin_nested():
            _validate_recovery(db, changes, tables)
            if result["entity_type"] == "creation_entity":
                for item in changes:
                    if item["table"] == "novel_creation_sessions" and item["after"] is not None:
                        # Recovery is a new author edit; do not reuse old CAS revisions.
                        item["before"]["revision"] = (
                            max(
                                int(item["before"]["revision"] or 0),
                                int(item["after"]["revision"] or 0),
                            )
                            + 1
                        )
                        item["before"]["updated_at"] = datetime.utcnow().isoformat()
            _restore_changes(db, changes, tables)
            db.expire_all()
            if result["project_id"]:
                db.info["siming_recovered_author_rows"] = {
                    "project_id": result["project_id"],
                    "changes": changes,
                }
            db.delete(row)
            db.flush()
    except IntegrityError as exc:
        raise ConflictError("恢复对象与现有数据冲突，未覆盖任何现有内容") from exc
    finally:
        db.info.pop("siming_recovered_author_rows", None)
    db.expire_all()
    if result["project_id"]:
        from app.database.models import Project
        from app.modules.story.domain.content_sync import ContentSyncIntent, ContentSyncTarget
        from app.modules.story.infrastructure.content_sync import enqueue_content_sync

        if db.get(Project, result["project_id"]) is not None:
            from app.database.models import ContentSyncJob

            for pending in (
                db.query(ContentSyncJob)
                .filter(
                    ContentSyncJob.project_id == result["project_id"],
                    ContentSyncJob.status.in_(["pending", "failed"]),
                    ContentSyncJob.target.in_(["file_delete", "project_delete"]),
                )
                .all()
            ):
                if result["entity_type"] != "project" and pending.entity_id not in {
                    item["key"][0] for item in changes if item["before"] is not None
                }:
                    continue
                pending.status = "cancelled"
                pending.completed_at = datetime.utcnow()
            enqueue_content_sync(
                db,
                ContentSyncIntent(
                    project_id=result["project_id"],
                    target=ContentSyncTarget.PROJECT,
                    source="recycle_restore",
                ),
            )
    return result
