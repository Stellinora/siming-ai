/** Page names and destinations shared by workspace menus and page navigation. */
export const PAGE_NAVIGATION_OPEN = 'siming:page-navigation-open'

export const PROJECT_PAGES = [
  { key: 'writer', label: '写作', title: '写作工作台', group: '创作', description: '章节正文、草稿、保存与版本历史' },
  { key: 'outline', label: '大纲', title: '大纲规划', group: '创作', description: '卷章结构与下一章规划' },
  { key: 'creation', label: '创作设定', title: '创作设定', group: '故事资料', description: '创作约束、创意方向与文风' },
  { key: 'characters', label: '角色', title: '角色管理', group: '故事资料', description: '人物资料、关系与成长变化' },
  { key: 'world', label: '世界观', title: '世界观', group: '故事资料', description: '地点、势力、规则与世界设定' },
  { key: 'visualization', label: '关系图', title: '关系图', group: '故事资料', description: '查看角色与故事关系' },
  { key: 'governance', label: '叙事治理', title: '叙事治理', group: '连续性与档案', description: '连续性检查、矛盾与伏笔' },
  { key: 'context', label: 'AI 参考资料', title: 'AI 参考资料', group: '连续性与档案', description: '管理模型可以参考的作品资料' },
  { key: 'cataloging', label: '作品建档', title: '作品建档', group: '连续性与档案', description: '章节摘要、事实提取与建档进度' },
  { key: 'stats', label: '统计追踪', title: '统计追踪', group: '连续性与档案', description: '字数、写作进度与统计' },
  { key: 'deconstruct', label: '拆书分析', title: '拆书分析', group: '工具与发布', description: '分析参考作品与写作方法' },
  { key: 'import', label: '内容导入', title: '内容导入', group: '工具与发布', description: '导入文本与作品内容' },
  { key: 'export', label: '导出作品', title: '导出作品', group: '工具与发布', description: '导出章节与完整作品' },
  { key: 'scheduler', label: '自动任务', title: '自动任务', group: '工具与发布', description: '计划与管理定时任务' },
  { key: 'skills', label: '技能管理', title: '技能管理', group: '工具与发布', description: '管理作品可用的写作技能' },
  { key: 'prompts', label: '提示词投稿', title: '提示词投稿', group: '工具与发布', description: '管理与分享提示词' },
] as const

export type ProjectPageKey = typeof PROJECT_PAGES[number]['key']

export const SYSTEM_PAGES = [
  { key: 'dashboard', title: '作品库', group: '创作入口', description: '全部作品与立项草稿', path: '/dashboard' },
  { key: 'assistant', title: 'AI 助手 · 新书立项', group: '创作入口', description: '讨论新小说、整理立项资料', path: '/gui', desktopOnly: true },
  { key: 'getting-started', title: '快速开始', group: '连接与能力', description: '获取 API Key 并连接模型', path: '/getting-started', desktopOnly: true },
  { key: 'models', title: '模型与训练', group: '连接与能力', description: '本地模型、下载与模型能力', path: '/models' },
  { key: 'external-agent', title: '外部 Agent', group: '连接与能力', description: 'CLI 与 MCP 连接', path: '/external-agent' },
  { key: 'recycle-bin', title: '回收站', group: '系统', description: '恢复 7 日内删除的数据，或立即永久删除', path: '/recycle-bin' },
  { key: 'settings', title: '系统设置', group: '系统', description: 'API 配置、模型默认值与同步', path: '/settings' },
  { key: 'terminal', title: '运行日志', group: '系统', description: '查看运行信息与报错', path: '/gui?tab=terminal', desktopOnly: true },
  { key: 'about', title: '关于司命', group: '系统', description: '版本、更新与项目信息', path: '/about' },
] as const

export function projectPagePath(projectId: string, view: ProjectPageKey) {
  const base = `/project/${encodeURIComponent(projectId)}`
  return view === 'writer' ? base : `${base}?view=${view}`
}
