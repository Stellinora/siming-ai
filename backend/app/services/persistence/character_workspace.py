"""SQLAlchemy adapter for character HTTP use cases."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.exceptions import ValidationError
from app.database.models import (
    Chapter,
    Character,
    CharacterAIConfig,
    CharacterAlias,
    CharacterChangeLog,
    CharacterRelationship,
    CharacterVersion,
)
from app.services.character_role_types import normalize_character_role_type


class SqlAlchemyCharacterWorkspace:
    def __init__(self, session: Session) -> None:
        self.db = session

    def list_characters(self, project_id: str, query: str | None = None):
        rows = self.db.query(Character).filter(
            Character.project_id == project_id,
            or_(Character.role_type.is_(None), Character.role_type != "merged_alias"),
        )
        if query:
            keyword = f"%{query}%"
            alias_ids = [
                row.character_id
                for row in self.db.query(CharacterAlias.character_id).filter(
                    CharacterAlias.project_id == project_id,
                    CharacterAlias.alias.like(keyword),
                ).all()
            ]
            rows = rows.filter(
                or_(
                    Character.name.like(keyword),
                    Character.appearance.like(keyword),
                    Character.personality.like(keyword),
                    Character.background.like(keyword),
                    Character.role_type.like(keyword),
                    Character.id.in_(alias_ids) if alias_ids else False,
                )
            )
        return rows.order_by(Character.updated_at.desc()).all()

    def create_character(self, **values: Any):
        if "role_type" in values:
            raw_role = values.get("role_type")
            values["role_type"] = normalize_character_role_type(raw_role)
        character = Character(**values)
        self.db.add(character)
        return character

    def relationship_network(self, project_id: str):
        characters = self.db.query(Character).filter(
            Character.project_id == project_id,
            or_(Character.role_type.is_(None), Character.role_type != "merged_alias"),
        ).all()
        relationships = self.db.query(CharacterRelationship).filter(
            CharacterRelationship.project_id == project_id
        ).order_by(CharacterRelationship.created_at.asc()).all()
        return characters, relationships

    def create_version(self, **values: Any):
        version = CharacterVersion(**values)
        self.db.add(version)
        return version

    def delete(self, value: Any) -> None:
        from app.services.recycle_bin import delete_to_recycle
        delete_to_recycle(self.db, value)

    def versions(self, character_id: str):
        return self.db.query(CharacterVersion).filter(
            CharacterVersion.character_id == character_id
        ).order_by(CharacterVersion.version_number.desc()).all()

    def version(self, character_id: str, version_id: str):
        return self.db.query(CharacterVersion).filter(
            CharacterVersion.id == version_id,
            CharacterVersion.character_id == character_id,
        ).first()

    def targets_exist(self, project_id: str, target_ids: set[str]) -> bool:
        if not target_ids:
            return True
        count = self.db.query(Character).filter(
            Character.project_id == project_id,
            Character.id.in_(target_ids),
        ).count()
        return count == len(target_ids)

    def replace_relationships(
        self,
        project_id: str,
        character_id: str,
        relationships: Sequence[Any],
    ) -> None:
        seen_pairs: set[tuple[str, str]] = set()
        endpoint_ids = {character_id}
        for item in relationships:
            source_id = item.source_character_id or character_id
            pair = (source_id, item.target_character_id)
            if character_id not in pair:
                raise ValidationError("提交的关系必须连接当前角色")
            if source_id == item.target_character_id:
                raise ValidationError("角色不能与自身建立关系")
            if pair in seen_pairs:
                raise ValidationError("同一方向的两个角色只能保留一条现行关系")
            seen_pairs.add(pair)
            endpoint_ids.update(pair)
        if not self.targets_exist(project_id, endpoint_ids):
            raise ValidationError("关系两端角色必须属于当前作品")
        existing = self.db.query(CharacterRelationship).filter(
            CharacterRelationship.project_id == project_id,
            or_(CharacterRelationship.character_a_id == character_id,
                CharacterRelationship.character_b_id == character_id),
        ).all()
        by_id = {row.id: row for row in existing}
        by_pair = {(row.character_a_id, row.character_b_id): row for row in existing}
        retained = set()
        updates = []
        for item in relationships:
            source_id = item.source_character_id or character_id
            requested_id = getattr(item, "id", None)
            row = by_id.get(requested_id) if requested_id else by_pair.get((source_id, item.target_character_id))
            if requested_id and row is None and self.db.get(CharacterRelationship, requested_id) is not None:
                raise ValidationError("不能覆盖其他角色或作品的关系")
            if row is not None:
                if row.id in retained:
                    raise ValidationError("关系 ID 不能重复")
                retained.add(row.id)
            updates.append((item, source_id, row))
        removed = [row for row in existing if row.id not in retained]
        if removed:
            from app.services.recycle_bin import capture_deletion
            with capture_deletion(self.db, removed[0]):
                for row in removed:
                    self.db.delete(row)
        for item, source_id, row in updates:
            if row is None:
                row = CharacterRelationship(
                    **({"id": item.id} if getattr(item, "id", None) else {}),
                    project_id=project_id,
                )
                self.db.add(row)
            row.character_a_id = source_id
            row.character_b_id = item.target_character_id
            row.relationship_type = item.relationship_type
            row.description = item.description

    def ensure_ai_config(self, character: Any):
        config = character.ai_config
        if config:
            return config
        config = CharacterAIConfig(character_id=character.id)
        self.db.add(config)
        return config

    def change_logs(
        self,
        project_id: str,
        *,
        chapter_id: str | None = None,
        character_id: str | None = None,
        confirmed: bool | None = None,
        limit: int = 200,
    ):
        query = self.db.query(CharacterChangeLog).join(
            Character,
            CharacterChangeLog.character_id == Character.id,
        ).filter(Character.project_id == project_id)
        if chapter_id:
            query = query.filter(CharacterChangeLog.chapter_id == chapter_id)
        if character_id:
            query = query.filter(CharacterChangeLog.character_id == character_id)
        if confirmed is not None:
            query = query.filter(CharacterChangeLog.confirmed == confirmed)
        return query.order_by(CharacterChangeLog.created_at.desc()).limit(limit).all()

    def change_log(self, project_id: str, log_id: str):
        return self.db.query(CharacterChangeLog).join(
            Character,
            CharacterChangeLog.character_id == Character.id,
        ).filter(
            CharacterChangeLog.id == log_id,
            Character.project_id == project_id,
        ).first()

    def character(self, character_id: str):
        return self.db.query(Character).filter(Character.id == character_id).first()

    def pending_change_logs(
        self,
        project_id: str,
        *,
        chapter_id: str | None = None,
        character_id: str | None = None,
    ):
        return self.change_logs(
            project_id,
            chapter_id=chapter_id,
            character_id=character_id,
            confirmed=False,
            limit=100000,
        )

    def serialize_change_logs(self, logs: Sequence[Any]) -> list[dict]:
        items: list[dict] = []
        for log in logs:
            character = self.character(log.character_id)
            chapter = self.db.query(Chapter).filter(Chapter.id == log.chapter_id).first()
            items.append(
                {
                    "id": log.id,
                    "character_id": log.character_id,
                    "character_name": character.name if character else "未知",
                    "chapter_id": log.chapter_id,
                    "chapter_title": chapter.title if chapter else "未知",
                    "change_type": log.change_type,
                    "field_name": log.field_name,
                    "old_value": log.old_value,
                    "new_value": log.new_value,
                    "confirmed": log.confirmed,
                    "created_at": log.created_at.isoformat() if log.created_at else None,
                }
            )
        return items


__all__ = ["SqlAlchemyCharacterWorkspace"]
