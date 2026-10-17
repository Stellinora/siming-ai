import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Empty, Modal, Pagination, Select, Spin, Tag, Typography } from 'antd'
import { ArrowRightOutlined, DeleteOutlined, ReloadOutlined, UndoOutlined } from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import PageWrapper from '../../components/PageWrapper'
import SystemNav from '../../components/SystemNav'
import {
  RECYCLE_TYPES, listRecycleItems, purgeRecycleItem, restoreRecycleItem, restoredItemPath,
  type RecycleItem, type RestoredItem,
} from './index'
import { formatApiDateTime } from '../../utils/dateTime'
import { confirmPageNavigation } from '../../shared/pageNavigationGuard'
import './RecycleBinPage.css'

const PAGE_SIZE = 20
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试'

export function remainingRetention(expiresAt: string, now: number) {
  const remaining = Date.parse(expiresAt) - now
  if (remaining <= 0) return '已过期'
  if (remaining < 86_400_000) return '不足 1 天'
  return `剩余 ${Math.ceil(remaining / 86_400_000)} 天`
}

export default function RecycleBinPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const projectId = searchParams.get('project') || undefined
  const [entityType, setEntityType] = useState<string>()
  const [page, setPage] = useState(1)
  const [actionError, setActionError] = useState('')
  const [restored, setRestored] = useState<{ item: RestoredItem; title: string }>()
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const client = useQueryClient()
  const navigate = useNavigate()
  const query = useQuery({
    queryKey: ['recycle-bin', projectId || '', entityType || '', page],
    queryFn: () => listRecycleItems({ project_id: projectId, entity_type: entityType, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }),
    refetchInterval: 60_000,
  })
  const restore = useMutation({
    mutationFn: restoreRecycleItem,
    onSuccess: async () => { await client.invalidateQueries() },
  })
  const purge = useMutation({
    mutationFn: purgeRecycleItem,
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['recycle-bin'] }) },
  })
  const busy = restore.isPending || purge.isPending

  async function handleRestore(item: RecycleItem) {
    setActionError('')
    setNotice('')
    setRestored(undefined)
    try {
      const result = await restore.mutateAsync(item.id)
      setRestored({ item: result, title: item.title })
      setPage(1)
    } catch (error) { setActionError(errorText(error)) }
  }

  function confirmPurge(item: RecycleItem) {
    Modal.confirm({
      title: `永久删除「${item.title}」？`,
      content: '这条数据及随它删除的关联资料将立即从回收站清除，无法再恢复。',
      okText: '永久删除', cancelText: '取消', autoFocusButton: 'cancel', okButtonProps: { danger: true },
      onOk: async () => {
        setActionError('')
        setNotice('')
        setRestored(undefined)
        try {
          await purge.mutateAsync(item.id)
          setNotice(`「${item.title}」已永久删除`)
          setPage(1)
        } catch (error) {
          setActionError(errorText(error))
        }
      },
    })
  }

  return (
    <>
      <SystemNav current="recycle-bin" />
      <PageWrapper className="recycle-bin-page" maxWidth={1100}>
        <header className="recycle-bin-header">
          <div>
            <span className="siming-section-kicker">数据恢复</span>
            <Typography.Title level={2}><DeleteOutlined /> 回收站</Typography.Title>
            <p>删错了，可以找回来。删除后的数据保留 7 天，到期后自动清除。</p>
          </div>
          <Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => { void query.refetch() }}>刷新</Button>
        </header>
        <Alert
          className="recycle-bin-policy"
          type="info" showIcon
          message="恢复时会一并恢复随该条目删除的关联资料"
          description="若所属作品或其他依赖也被删除，请先恢复它们。此功能只能恢复启用回收站后删除的数据；永久删除与超过 7 天的数据无法恢复。"
        />
        {restored && <Alert className="recycle-bin-feedback" type="success" showIcon message={`「${restored.title}」已恢复`} action={
          <Button size="small" icon={<ArrowRightOutlined />} onClick={() => confirmPageNavigation(() => navigate(restoredItemPath(restored.item)))}>打开所在页面</Button>
        } />}
        {notice && <Alert className="recycle-bin-feedback" type="success" showIcon message={notice} />}
        {actionError && <Alert className="recycle-bin-feedback" type="error" showIcon message="操作未完成" description={actionError} closable onClose={() => setActionError('')} />}
        <section className="recycle-bin-list" aria-label="已删除数据">
          <div className="recycle-bin-toolbar">
            <Select
              aria-label="筛选数据类型" value={entityType} placeholder="全部类型" allowClear
              onChange={(value) => { setEntityType(value); setPage(1) }}
              options={Object.entries(RECYCLE_TYPES).map(([value, label]) => ({ value, label }))}
            />
            <span className="recycle-bin-count">{query.data ? `${query.data.total} 条可恢复数据` : '读取中'}</span>
            {projectId && <Tag closable onClose={() => { setSearchParams({}); setPage(1) }}>当前作品 · 点击 × 查看全部</Tag>}
          </div>
          {query.isError ? <Alert type="error" showIcon message="回收站读取失败" description={errorText(query.error)} action={<Button onClick={() => { void query.refetch() }}>重试</Button>} />
            : query.isLoading ? <div className="recycle-bin-loading" role="status"><Spin /><span>正在读取回收站</span></div>
              : !query.data?.items.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={entityType || projectId ? '此范围内没有可恢复的数据' : '回收站是空的'} />
                : query.data.items.map((item) => {
                  const expired = Date.parse(item.expires_at) <= now
                  return (
                    <article key={item.id} className="recycle-bin-item">
                      <div className="recycle-bin-item-main">
                        <div className="recycle-bin-item-title"><Tag>{RECYCLE_TYPES[item.entity_type as keyof typeof RECYCLE_TYPES] || '资料'}</Tag><h3>{item.title}</h3><Tag color={Date.parse(item.expires_at) - now < 86_400_000 ? 'orange' : undefined}>{remainingRetention(item.expires_at, now)}</Tag></div>
                        <p>{item.project_title ? `所属作品：${item.project_title}` : item.entity_type === 'project' ? '整部作品及关联资料' : '全局资料'}</p>
                        <div className="recycle-bin-dates"><span>删除于 {formatApiDateTime(item.deleted_at)}</span><span>到期清除 {formatApiDateTime(item.expires_at)}</span></div>
                      </div>
                      <div className="recycle-bin-item-actions">
                        <Button icon={<UndoOutlined />} aria-label={expired ? '已过期' : `恢复：${item.title}`} disabled={busy || expired} loading={restore.isPending && restore.variables === item.id} onClick={() => { void handleRestore(item) }}>{expired ? '已过期' : '恢复'}</Button>
                        <Button danger type="text" icon={<DeleteOutlined />} aria-label={`永久删除：${item.title}`} disabled={busy} loading={purge.isPending && purge.variables === item.id} onClick={() => confirmPurge(item)}>永久删除</Button>
                      </div>
                    </article>
                  )
                })}
          {!!query.data?.total && <Pagination current={page} pageSize={PAGE_SIZE} total={query.data.total} showSizeChanger={false} onChange={setPage} />}
        </section>
      </PageWrapper>
    </>
  )
}
