"""Recovery tests use an isolated in-memory database, never the author's store."""

import json
import zlib
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.core.exceptions import ConflictError, NotFoundError
from app.database.models import (
    AssistantConversation,
    AssistantMemory,
    AssistantMessage,
    Base,
    Chapter,
    ChapterCharacter,
    ChapterDraft,
    ChapterSnapshot,
    Character,
    CharacterAlias,
    CharacterRelationship,
    NovelCreationEntity,
    NovelCreationSession,
    OperationRun,
    OutlineNode,
    OutlineNodeCharacter,
    Project,
    RecycleBinEntry,
    SystemAssistantConversation,
    SystemAssistantMessage,
)
from app.services.recycle_bin import (
    DELETED_AT_CONTEXT,
    ENTRY_ID_CONTEXT,
    delete_to_recycle,
    list_entries,
    purge_entry,
    purge_expired,
    restore_entry,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine, expire_on_commit=False)() as session:
        yield session
    engine.dispose()


def seed(db):
    project = Project(id="p", title="七日恢复测试")
    db.add(project)
    db.flush()
    character = Character(id="c", project_id="p", name="主角", background="完整背景")
    other = Character(id="c2", project_id="p", name="另一角色")
    db.add_all([character, other])
    db.flush()
    return project, character, other


def entry(db):
    return db.query(RecycleBinEntry).one()


def test_character_restores_relationship_alias_and_chapter_association(db):
    _, character, other = seed(db)
    chapter = Chapter(id="ch", project_id="p", title="正文", content="未删正文")
    db.add(chapter)
    db.flush()
    db.add_all(
        [
            CharacterAlias(id="a", project_id="p", character_id="c", alias="别名"),
            CharacterRelationship(
                id="r",
                project_id="p",
                character_a_id="c",
                character_b_id=other.id,
                relationship_type="朋友",
            ),
            ChapterCharacter(id="link", chapter_id="ch", character_id="c"),
        ]
    )
    db.commit()
    delete_to_recycle(db, character)
    item = entry(db)
    assert db.get(Character, "c") is None
    assert db.get(CharacterRelationship, "r") is None
    restore_entry(db, item.id)
    assert db.get(Character, "c").background == "完整背景"
    assert db.get(CharacterAlias, "a").alias == "别名"
    assert db.get(CharacterRelationship, "r").character_b_id == "c2"
    assert db.get(ChapterCharacter, "link").chapter_id == "ch"
    assert db.get(Chapter, "ch").content == "未删正文"
    assert db.query(RecycleBinEntry).count() == 0


def test_project_recovers_cycles_versions_and_relations_as_one_item(db):
    project, character, _ = seed(db)
    outline = OutlineNode(id="o", project_id="p", node_type="chapter", title="大纲")
    db.add(outline)
    db.flush()
    chapter = Chapter(
        id="ch", project_id="p", title="正文", content="正文全文", outline_node_id="o"
    )
    db.add(chapter)
    db.flush()
    outline.source_chapter_id = chapter.id
    character.last_seen_chapter_id = chapter.id
    db.add(
        ChapterSnapshot(
            id="v",
            chapter_id="ch",
            content="旧正文",
            version_number=1,
            word_count=3,
            trigger_type="manual",
        )
    )
    db.commit()
    delete_to_recycle(db, project)
    item = entry(db)
    restore_entry(db, item.id)
    assert db.get(Project, "p").title == "七日恢复测试"
    assert db.get(Chapter, "ch").outline_node_id == "o"
    assert db.get(OutlineNode, "o").source_chapter_id == "ch"
    assert db.get(ChapterSnapshot, "v").content == "旧正文"
    assert db.get(Character, "c").last_seen_chapter_id == "ch"


def test_outline_recovers_children_and_set_null_reference(db):
    seed(db)
    parent = OutlineNode(id="o", project_id="p", node_type="volume", title="卷")
    child = OutlineNode(id="o2", project_id="p", parent=parent, node_type="chapter", title="章")
    db.add_all([parent, child])
    db.flush()
    db.add(Chapter(id="ch", project_id="p", title="正文", content="不删除", outline_node_id="o2"))
    db.commit()
    delete_to_recycle(db, parent)
    db.expire_all()
    assert db.get(Chapter, "ch").outline_node_id is None
    restore_entry(db, entry(db).id)
    assert db.get(OutlineNode, "o2").parent_id == "o"
    assert db.get(Chapter, "ch").outline_node_id == "o2"


def test_restore_rejects_changed_association_and_is_atomic(db):
    seed(db)
    outline = OutlineNode(id="o", project_id="p", node_type="chapter", title="章")
    db.add(outline)
    db.flush()
    db.add(Chapter(id="ch", project_id="p", title="正文", content="原文", outline_node_id="o"))
    db.commit()
    delete_to_recycle(db, outline)
    item_id = entry(db).id
    db.expire_all()
    db.get(Chapter, "ch").content = "作者后来修改"
    db.commit()
    with pytest.raises(ConflictError, match="已被修改"):
        restore_entry(db, item_id)
    assert db.get(OutlineNode, "o") is None
    assert db.get(Chapter, "ch").content == "作者后来修改"
    assert db.get(RecycleBinEntry, item_id) is not None


def test_child_requires_project_restored_first(db):
    project, character, _ = seed(db)
    db.commit()
    delete_to_recycle(db, character)
    character_entry = entry(db).id
    delete_to_recycle(db, project)
    with pytest.raises(ConflictError, match="先恢复"):
        restore_entry(db, character_entry)
    project_entry = db.query(RecycleBinEntry).filter_by(entity_type="project").one()
    restore_entry(db, project_entry.id)
    restore_entry(db, character_entry)
    assert db.get(Character, "c").name == "主角"


def test_expiry_exact_boundary_and_immediate_permanent_delete(db):
    _, character, _ = seed(db)
    db.commit()
    delete_to_recycle(db, character)
    item = entry(db)
    assert item.expires_at - item.deleted_at == timedelta(days=7)
    with pytest.raises(ConflictError, match="7 天"):
        restore_entry(db, item.id, now=item.expires_at)
    purge_entry(db, item.id)
    purge_entry(db, item.id)
    assert db.query(RecycleBinEntry).count() == 0
    assert db.get(Character, "c") is None


def test_expired_cleanup_removes_snapshot_only(db):
    _, character, other = seed(db)
    db.commit()
    delete_to_recycle(db, character)
    expiry = entry(db).expires_at
    assert purge_expired(db, now=expiry) == 1
    assert db.get(Character, other.id) is not None


def test_active_task_blocks_deletion(db):
    _, character, _ = seed(db)
    db.add(
        OperationRun(
            id="run",
            project_id="p",
            source_kind="test",
            source_id="test",
            title="正在生成",
            status="running",
        )
    )
    db.commit()
    with pytest.raises(ConflictError, match="任务运行"):
        delete_to_recycle(db, character)
    assert db.get(Character, "c") is not None
    assert db.query(RecycleBinEntry).count() == 0


def test_delete_rollback_rolls_back_recycle_entry_together(db):
    _, character, _ = seed(db)
    db.commit()
    delete_to_recycle(db, character)
    assert entry(db)
    db.rollback()
    assert db.get(Character, "c") is not None
    assert db.query(RecycleBinEntry).count() == 0


def test_mobile_entry_identity_timestamp_and_owner_scope(db):
    _, character, _ = seed(db)
    db.commit()
    deleted_at = datetime.utcnow() - timedelta(days=2)
    db.info[ENTRY_ID_CONTEXT] = "mobile-delete-id"
    db.info[DELETED_AT_CONTEXT] = deleted_at
    delete_to_recycle(db, character)
    item = entry(db)
    assert item.id == "mobile-delete-id"
    assert item.deleted_at == deleted_at
    with pytest.raises(NotFoundError):
        restore_entry(db, item.id, project_id="other-project")
    with pytest.raises(NotFoundError):
        purge_entry(db, item.id, project_id="other-project")
    restore_entry(db, item.id, project_id="p")


def test_snapshot_does_not_copy_unmodified_project_or_unrelated_rows(db):
    _, character, _ = seed(db)
    db.add(Project(id="p2", title="另一作品"))
    db.commit()
    delete_to_recycle(db, character)
    changes = json.loads(zlib.decompress(entry(db).snapshot))["changes"]
    assert {item["table"] for item in changes} == {"characters"}
    assert {tuple(item["key"]) for item in changes} == {("c",)}
    assert list_entries(db)["retention_days"] == 7


@pytest.mark.parametrize("kind", ["project", "system"])
def test_conversation_messages_restored(db, kind):
    seed(db)
    if kind == "project":
        conversation = AssistantConversation(id="conversation", project_id="p", title="对话")
        message = AssistantMessage(
            id="message",
            conversation_id="conversation",
            sequence_no=1,
            role="user",
            content="保留消息",
        )
    else:
        conversation = SystemAssistantConversation(
            id="conversation", scope_type="general", title="对话"
        )
        message = SystemAssistantMessage(
            id="message",
            conversation_id="conversation",
            sequence_no=1,
            role="user",
            content="保留消息",
        )
    db.add(conversation)
    db.flush()
    db.add(message)
    db.commit()
    delete_to_recycle(db, conversation)
    restore_entry(db, entry(db).id)
    assert db.get(type(message), "message").content == "保留消息"


def test_creation_session_cascade_and_memory_restore(db):
    session = NovelCreationSession(id="s", user_brief="新的小说", draft_json={"theme": "原始资料"})
    db.add(session)
    db.flush()
    entity = NovelCreationEntity(
        id="e",
        session_id="s",
        artifact_key="characters",
        entity_type="character",
        entity_key="主角",
        data_json={"name": "主角"},
    )
    db.add(entity)
    db.commit()
    delete_to_recycle(db, session)
    restore_entry(db, entry(db).id)
    assert db.get(NovelCreationSession, "s").draft_json == {"theme": "原始资料"}
    assert db.get(NovelCreationEntity, "e").data_json == {"name": "主角"}
    memory = AssistantMemory(id="memory", key="测试", value="全局记忆")
    db.add(memory)
    db.commit()
    delete_to_recycle(db, memory)
    restore_entry(db, entry(db).id)
    assert db.get(AssistantMemory, "memory").value == "全局记忆"


def test_chapter_discard_recovery_and_permanent_delete(db):
    from app.services.workspace.generated_drafts import discard_chapter_draft

    seed(db)
    draft = ChapterDraft(
        id="draft",
        project_id="p",
        title="未保存正文",
        content="长篇草稿内容",
        status="pending",
        draft_kind="new",
    )
    db.add(draft)
    db.commit()
    discard_chapter_draft(db, "p", "draft")
    assert db.get(ChapterDraft, "draft").status == "discarded"
    restore_entry(db, entry(db).id)
    assert db.get(ChapterDraft, "draft").status == "pending"
    assert db.get(ChapterDraft, "draft").content == "长篇草稿内容"
    discard_chapter_draft(db, "p", "draft")
    purge_entry(db, entry(db).id)
    db.expire_all()
    assert db.get(ChapterDraft, "draft") is None


def test_appearance_removal_captures_outline_links_and_provenance(db):
    from app.services.character_appearance_service import remove_character_chapter_appearance

    _, character, _ = seed(db)
    outline = OutlineNode(id="o", project_id="p", node_type="chapter", title="大纲")
    db.add(outline)
    db.flush()
    db.add(Chapter(id="ch", project_id="p", title="正文", content="内容", outline_node_id="o"))
    db.flush()
    character.last_seen_chapter_id = "ch"
    db.add_all(
        [
            ChapterCharacter(id="appearance", chapter_id="ch", character_id="c"),
            OutlineNodeCharacter(id="outline-link", outline_node_id="o", character_id="c"),
        ]
    )
    db.commit()
    remove_character_chapter_appearance(db, "p", "c", "ch")
    assert db.get(OutlineNodeCharacter, "outline-link") is None
    restore_entry(db, entry(db).id)
    assert db.get(ChapterCharacter, "appearance") is not None
    assert db.get(OutlineNodeCharacter, "outline-link") is not None
    assert db.get(Character, "c").last_seen_chapter_id == "ch"


def test_chapter_deletion_recovers_cataloging_suffix_state(db):
    from app.modules.story.infrastructure.chapters import SqlAlchemyChapterWorkspace

    seed(db)
    db.add_all(
        [
            Chapter(
                id="ch1",
                project_id="p",
                title="第一章",
                content="内容一",
                sort_order=1,
                cataloging_required=False,
            ),
            Chapter(
                id="ch2",
                project_id="p",
                title="第二章",
                content="内容二",
                sort_order=2,
                cataloging_required=False,
            ),
        ]
    )
    db.commit()
    SqlAlchemyChapterWorkspace(db).delete("p", "ch1")
    assert db.get(Chapter, "ch1") is None
    assert db.get(Chapter, "ch2").cataloging_required is True
    restore_entry(db, entry(db).id)
    assert db.get(Chapter, "ch1").content == "内容一"
    assert db.get(Chapter, "ch2").cataloging_required is False


def test_authoring_restore_and_purge_share_owner_and_conflict_contract(db):
    from app.services.mobile_authoring_commands import apply_authoring_command

    _, character, _ = seed(db)
    db.commit()
    delete_to_recycle(db, character, entry_id="mobile-entry")
    apply_authoring_command(
        db,
        "p",
        {
            "command": "recycle_restore",
            "arguments": {"entry_id": "mobile-entry"},
            "expected": {},
        },
    )
    assert db.get(Character, "c") is not None
    delete_to_recycle(db, db.get(Character, "c"), entry_id="mobile-entry-2")
    apply_authoring_command(
        db,
        "p",
        {
            "command": "recycle_purge",
            "arguments": {"entry_id": "mobile-entry-2"},
            "expected": {},
        },
    )
    assert db.query(RecycleBinEntry).count() == 0


def test_owner_http_restore_enqueues_gateway_upserts(db, monkeypatch):
    from types import SimpleNamespace

    from app.database.models import SyncCaptureJob, SyncProject
    from app.modules.gateway.infrastructure import change_capture

    _, character, _ = seed(db)
    db.add(SyncProject(project_id="p", status="enabled"))
    db.commit()
    delete_to_recycle(db, character)
    monkeypatch.setattr(
        change_capture, "get_settings", lambda: SimpleNamespace(gateway_enabled=True)
    )
    event.listen(db, "before_flush", change_capture._capture_before_flush)
    try:
        restore_entry(db, entry(db).id)
    finally:
        event.remove(db, "before_flush", change_capture._capture_before_flush)
    capture = db.query(SyncCaptureJob).filter_by(entity_id="c", operation="upsert").one()
    assert capture.payload_json["name"] == "主角"
