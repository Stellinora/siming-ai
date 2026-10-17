import { apiClient } from '../../shared/api/client'
import type { ApiEnvelope } from '../../shared/api/contracts'
import { projectPagePath, type ProjectPageKey } from '../../shared/navigation'

export const RECYCLE_TYPES = {
  project: '作品', chapter: '章节', outline: '大纲', character: '角色', worldbuilding: '世界观',
  creation_session: '立项草稿', creation_entity: '立项资料', assistant_conversation: '项目对话',
  system_conversation: '立项对话', assistant_memory: '助手记忆', chapter_draft: '章节草稿',
  outline_draft: '大纲草稿', skill: '技能', character_relationship: '角色关系',
  character_appearance: '角色出场', character_change_log: '角色变化',
  worldbuilding_relationship: '世界观关系', foreshadowing: '伏笔', narrative_debt: '叙事债务',
} as const

export interface RecycleItem {
  id: string
  entity_type: string
  entity_id: string
  title: string
  project_id?: string | null
  project_title?: string | null
  deleted_at: string
  expires_at: string
}

export interface RestoredItem {
  id: string
  entity_type: string
  entity_id: string
  project_id?: string | null
}

export interface RecycleList {
  items: RecycleItem[]
  total: number
  retention_days: number
}

export async function listRecycleItems(params: { project_id?: string; entity_type?: string; offset: number; limit: number }) {
  return (await apiClient.get<ApiEnvelope<RecycleList>>('/recycle-bin', params)).data.data
}

export async function restoreRecycleItem(id: string) {
  return (await apiClient.post<ApiEnvelope<RestoredItem>>(`/recycle-bin/${encodeURIComponent(id)}/restore`)).data.data
}

export async function purgeRecycleItem(id: string) {
  await apiClient.delete(`/recycle-bin/${encodeURIComponent(id)}`)
}

export function restoredItemPath(item: RestoredItem): string {
  const id = encodeURIComponent(item.entity_id)
  if (item.entity_type === 'project') return projectPagePath(item.entity_id, 'writer')
  if (item.entity_type === 'creation_session') return `/gui?creationSession=${id}`
  if (item.entity_type === 'system_conversation') return `/gui?conversation=${id}`
  if (item.entity_type === 'creation_entity') return '/gui'
  if (!item.project_id) return '/dashboard'
  const project = `/project/${encodeURIComponent(item.project_id)}`
  if (item.entity_type === 'chapter') return `${project}?chapter=${id}`
  if (item.entity_type === 'assistant_conversation' || item.entity_type === 'assistant_memory') return `${project}?assistant=open`
  const views: Record<string, ProjectPageKey> = {
    character: 'characters', character_relationship: 'characters', character_appearance: 'characters',
    character_change_log: 'characters', outline: 'outline', outline_draft: 'outline',
    worldbuilding: 'world', worldbuilding_relationship: 'world',
    foreshadowing: 'governance', narrative_debt: 'governance', skill: 'skills', chapter_draft: 'writer',
  }
  return projectPagePath(item.project_id, views[item.entity_type] || 'writer')
}
