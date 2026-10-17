"""Deletion recovery at current authoring and sync boundaries, in isolated SQLite."""

from copy import deepcopy
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import event

from app.core.exceptions import ConflictError
from app.database.models import (
    AssistantRun,
    Character,
    CharacterRelationship,
    OutlineDraft,
    RecycleBinEntry,
    Skill,
    SkillVersion,
    SyncChange,
    SyncEntityState,
)
from app.services.recycle_bin import delete_to_recycle, restore_entry
from tests.test_recycle_bin import db as recycle_db_fixture
from tests.test_recycle_bin import entry, seed


@pytest.fixture(name="db")
def recycle_session():
    yield from recycle_db_fixture.__wrapped__()


def edge(target, *, identifier=None, description="新版关系"):
    return SimpleNamespace(
        id=identifier,
        source_character_id="c",
        target_character_id=target,
        relationship_type="朋友",
        description=description,
    )


def test_relationship_replacement_recycles_only_removed_rows(db):
    from app.services.persistence.character_workspace import SqlAlchemyCharacterWorkspace

    seed(db)
    db.add_all(
        [
            Character(id="c3", project_id="p", name="三"),
            Character(id="c4", project_id="p", name="四"),
        ]
    )
    db.flush()
    db.add_all(
        [
            CharacterRelationship(
                id="r1",
                project_id="p",
                character_a_id="c",
                character_b_id="c2",
                relationship_type="朋友",
            ),
            CharacterRelationship(
                id="r2",
                project_id="p",
                character_a_id="c",
                character_b_id="c3",
                relationship_type="朋友",
            ),
            CharacterRelationship(
                id="r3",
                project_id="p",
                character_a_id="c4",
                character_b_id="c",
                relationship_type="朋友",
            ),
        ]
    )
    db.commit()
    SqlAlchemyCharacterWorkspace(db).replace_relationships("p", "c", [edge("c2")])
    db.flush()
    assert db.get(CharacterRelationship, "r1").description == "新版关系"
    assert db.get(CharacterRelationship, "r2") is None
    assert db.get(CharacterRelationship, "r3") is None
    restore_entry(db, entry(db).id)
    assert db.get(CharacterRelationship, "r1").description == "新版关系"
    assert db.get(CharacterRelationship, "r2") is not None
    assert db.get(CharacterRelationship, "r3") is not None


def test_skill_versions_restore_and_unique_conflict_preserves_recycle(db):
    from app.services.skills.service import delete_skill

    seed(db)
    skill = Skill(id="skill", project_id="p", name="写作技能", system_prompt="作者技能正文")
    db.add(skill)
    db.flush()
    db.add(
        SkillVersion(
            id="version", skill_id="skill", project_id="p", title="原版本", snapshot_json="{}"
        )
    )
    db.commit()
    delete_skill(db, "p", "skill")
    deleted_id = entry(db).id
    replacement = Skill(id="replacement", project_id="p", name="写作技能", system_prompt="新版")
    db.add(replacement)
    db.commit()
    with pytest.raises(ConflictError, match="与现有数据冲突"):
        restore_entry(db, deleted_id)
    assert db.get(Skill, "skill") is None
    assert db.get(RecycleBinEntry, deleted_id) is not None
    replacement.name = "新技能"
    db.commit()
    restore_entry(db, deleted_id)
    assert db.get(SkillVersion, "version").title == "原版本"
    assert db.get(Skill, "skill").system_prompt == "作者技能正文"


def test_outline_draft_discard_restores_exact_unsaved_proposal(db):
    from app.services.workspace.outline_drafts import discard_outline_draft

    seed(db)
    draft = OutlineDraft(
        id="draft",
        project_id="p",
        nodes_json=[{"title": "未确认大纲"}],
        context_selection_digest="digest",
        base_outline_hash="base",
    )
    db.add(draft)
    db.commit()
    discard_outline_draft(db, "p", "draft")
    assert draft.status == "discarded"
    restore_entry(db, entry(db).id)
    assert db.get(OutlineDraft, "draft").status == "pending"
    assert db.get(OutlineDraft, "draft").nodes_json == [{"title": "未确认大纲"}]


def test_creation_entity_recovers_stage_revision_and_versions(db):
    from app.services.novel_creation_actions import delete_creation_entity, patch_creation_entity
    from app.services.novel_creation_entities import get_creation_entity, list_creation_entities
    from tests.test_novel_creation_workspace_v2 import _ready_session

    session = _ready_session(db)
    before = deepcopy(session.draft_json)
    revision = session.revision
    faction_data = next(
        item for item in list_creation_entities(session) if item["entity_type"] == "faction"
    )
    faction = get_creation_entity(db, faction_data["id"])
    delete_creation_entity(session, faction, expected_revision=revision)
    db.commit()
    assert faction.status == "deleted"
    deleted_revision = session.revision
    restore_entry(db, entry(db).id)
    assert faction.status == "active"
    assert session.revision > deleted_revision > revision
    assert session.draft_json == before
    with pytest.raises(RuntimeError, match="revision_conflict"):
        patch_creation_entity(session, faction, [], expected_revision=revision)


def test_mobile_delete_restore_are_ordered_idempotent_and_publish_actual_rows(db):
    from app.modules.gateway.application.contracts import SyncMutation
    from app.modules.gateway.infrastructure.mutation_service import GatewayMutationApplier

    seed(db)
    db.commit()
    applier = GatewayMutationApplier(
        db, tombstone_retention_days=30, refresh_project_manifest=lambda _: None
    )
    stamp = datetime.utcnow() - timedelta(days=2)
    deletion = SyncMutation(
        mutation_id="mobile-delete",
        project_id="p",
        entity_type="character",
        entity_id="c",
        operation="delete",
        base_revision=0,
        client_modified_at=stamp,
    )
    assert applier.apply(deletion, device_id=None).status == "applied"
    assert entry(db).id == "mobile-delete" and entry(db).deleted_at == stamp
    assert applier.apply(deletion, device_id=None).status == "duplicate"
    restoration = SyncMutation(
        mutation_id="mobile-restore",
        project_id="p",
        entity_type="authoring_command",
        entity_id="mobile-restore",
        operation="upsert",
        base_revision=0,
        payload={
            "command": "recycle_restore",
            "arguments": {"entry_id": "mobile-delete"},
            "expected": {},
        },
    )
    assert applier.apply(restoration, device_id=None).status == "applied"
    assert applier.apply(restoration, device_id=None).status == "duplicate"
    assert db.get(Character, "c").name == "主角"
    state = (
        db.query(SyncEntityState)
        .filter_by(project_id="p", entity_type="character", entity_id="c")
        .one()
    )
    assert state.is_deleted is False
    assert state.payload_json["name"] == "主角"
    assert db.query(SyncChange).filter_by(mutation_id="mobile-restore").count() == 1


def test_active_lease_blocks_project_delete_and_finished_lease_never_restores(db):
    import json
    import zlib

    project, _, _ = seed(db)
    run = AssistantRun(
        id="run", project_id="p", status="running", direct_mcp_lease_hash="secret-lease"
    )
    db.add(run)
    db.commit()
    with pytest.raises(ConflictError, match="助手任务运行"):
        delete_to_recycle(db, project)
    run.status = "completed"
    db.commit()
    delete_to_recycle(db, project)
    payload = json.loads(zlib.decompress(entry(db).snapshot))
    assert "secret-lease" not in str(payload)
    assert all(item["table"] != "assistant_runs" for item in payload["changes"])
    restore_entry(db, entry(db).id)
    assert db.get(AssistantRun, "run") is None


def test_gateway_capture_dispatch_waits_for_outer_commit(db, monkeypatch):
    from app.modules.gateway.infrastructure import change_capture

    calls = []
    monkeypatch.setattr(
        change_capture.SyncCaptureProcessor, "process", lambda _self, jobs: calls.append(list(jobs))
    )
    event.listen(db, "after_commit", change_capture._dispatch_after_commit)
    try:
        with db.begin_nested():
            db.info[change_capture._CAPTURE_JOB_IDS] = ["job"]
        assert calls == []
        assert db.info[change_capture._CAPTURE_JOB_IDS] == ["job"]
        db.commit()
        assert calls == [["job"]]
    finally:
        event.remove(db, "after_commit", change_capture._dispatch_after_commit)


def test_projectless_creation_conversation_cannot_delete_a_running_turn(db):
    from app.database.models import SystemAssistantConversation, SystemAssistantMessage

    conversation = SystemAssistantConversation(id="conversation", scope_type="creation")
    db.add(conversation)
    db.flush()
    message = SystemAssistantMessage(
        id="message",
        conversation_id="conversation",
        sequence_no=1,
        role="assistant",
        content="生成中",
        status="running",
    )
    db.add(message)
    db.commit()
    with pytest.raises(ConflictError, match="对话仍在生成"):
        delete_to_recycle(db, conversation)
    assert db.get(SystemAssistantMessage, "message").content == "生成中"
    assert db.query(RecycleBinEntry).count() == 0


def test_recycle_migration_creates_single_table_and_preserves_existing_rows():
    import importlib.util
    from pathlib import Path

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import create_engine, inspect, text

    engine = create_engine("sqlite:///:memory:")
    path = Path(__file__).resolve().parents[1] / "alembic/versions/300a40_recycle_bin.py"
    spec = importlib.util.spec_from_file_location("recycle_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT)"))
        connection.execute(text("INSERT INTO projects VALUES ('p','existing')"))
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
        assert set(inspect(connection).get_table_names()) == {"projects", "recycle_bin_entries"}
        assert connection.execute(text("SELECT title FROM projects")).scalar() == "existing"
    engine.dispose()
