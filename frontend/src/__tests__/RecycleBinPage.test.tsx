import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { Modal } from 'antd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RecycleBinPage, { remainingRetention } from '../pages/RecycleBinPage'

const api = vi.hoisted(() => ({ list: vi.fn(), restore: vi.fn(), purge: vi.fn() }))
vi.mock('../features/recycleBin', async () => ({
  ...await vi.importActual('../features/recycleBin'),
  listRecycleItems: api.list, restoreRecycleItem: api.restore, purgeRecycleItem: api.purge,
}))
vi.mock('../components/SystemNav', () => ({ default: () => <nav>系统导航</nav> }))
const item = {
  id: 'trash-1', entity_type: 'chapter', entity_id: 'chapter-1', title: '遗失的开篇',
  project_id: 'project-1', project_title: '山海记', deleted_at: '2030-10-01T10:00:00Z', expires_at: '2030-10-08T10:00:00Z',
}
function Location() { return <output aria-label="当前地址">{useLocation().pathname}{useLocation().search}</output> }
function renderPage(path = '/recycle-bin') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><RecycleBinPage /><Location /></MemoryRouter></QueryClientProvider>)
}

describe('recycle bin author actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const confirm = Modal.confirm
    vi.spyOn(Modal, 'confirm').mockImplementation((props) => confirm({ ...props, transitionName: '', maskTransitionName: '' }))
    api.list.mockResolvedValue({ items: [item], total: 1, retention_days: 7 })
    api.restore.mockResolvedValue(item)
    api.purge.mockResolvedValue(undefined)
  })
  afterEach(() => { Modal.destroyAll(); vi.restoreAllMocks() })

  it('shows retention, related work and expiry, then restores through the authoritative API', async () => {
    renderPage('/recycle-bin?project=project-1')
    expect(await screen.findByText('遗失的开篇')).toBeInTheDocument()
    expect(screen.getByText('所属作品：山海记')).toBeInTheDocument()
    expect(screen.getByText(/到期清除/)).toBeInTheDocument()
    expect(api.list).toHaveBeenCalledWith({ project_id: 'project-1', entity_type: undefined, offset: 0, limit: 20 })
    api.list.mockResolvedValue({ items: [], total: 0, retention_days: 7 })
    fireEvent.click(screen.getByRole('button', { name: /^恢复：/ }))
    expect(await screen.findByText('「遗失的开篇」已恢复')).toBeInTheDocument()
    expect(api.restore).toHaveBeenCalledOnce()
    expect(api.restore.mock.calls[0][0]).toBe('trash-1')
    fireEvent.click(screen.getByRole('button', { name: /打开所在页面/ }))
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('/project/project-1?chapter=chapter-1')
  })

  it('does not permanently delete before explicit confirmation and supports cancellation', async () => {
    renderPage()
    await screen.findByText('遗失的开篇')
    fireEvent.click(screen.getByRole('button', { name: /永久删除/ }))
    const first = await screen.findByRole('dialog')
    expect(within(first).getByText(/无法再恢复/)).toBeInTheDocument()
    expect(api.purge).not.toHaveBeenCalled()
    fireEvent.click(within(first).getByRole('button', { name: /取\s*消/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 4000 })
    expect(api.purge).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /永久删除/ }))
    const second = await screen.findByRole('dialog')
    fireEvent.click(within(second).getByRole('button', { name: /永久删除/ }))
    await waitFor(() => expect(api.purge).toHaveBeenCalledOnce())
    expect(api.purge.mock.calls[0][0]).toBe('trash-1')
    expect(await screen.findByText('「遗失的开篇」已永久删除')).toBeInTheDocument()
  })

  it('shows dependency conflicts without pretending the item was restored', async () => {
    api.restore.mockRejectedValue(new Error('所属作品已删除，请先恢复作品'))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /^恢复：/ }))
    expect(await screen.findByText('所属作品已删除，请先恢复作品')).toBeInTheDocument()
    expect(screen.getByText('遗失的开篇')).toBeInTheDocument()
    expect(screen.queryByText('「遗失的开篇」已恢复')).not.toBeInTheDocument()
  })

  it('keeps a rejected permanent deletion visible and shows the server error after closing confirmation', async () => {
    api.purge.mockRejectedValue(new Error('数据正在恢复，请稍后重试'))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /永久删除/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /永久删除/ }))
    expect(await screen.findByText('数据正在恢复，请稍后重试')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText('遗失的开篇')).toBeInTheDocument()
    expect(screen.queryByText('「遗失的开篇」已永久删除')).not.toBeInTheDocument()
  })

  it('does not report an empty recycle bin after a loading failure', async () => {
    api.list.mockRejectedValue(new Error('数据库暂时不可用'))
    renderPage()
    expect(await screen.findByText('数据库暂时不可用')).toBeInTheDocument()
    expect(screen.queryByText('回收站是空的')).not.toBeInTheDocument()
  })

  it('disables recovery at the exact expiry boundary even before the next refresh', async () => {
    api.list.mockResolvedValue({ items: [{ ...item, expires_at: '2000-01-01T00:00:00Z' }], total: 1, retention_days: 7 })
    renderPage()
    expect(await screen.findByRole('button', { name: '已过期' })).toBeDisabled()
    expect(api.restore).not.toHaveBeenCalled()
  })

  it('distinguishes remaining days, the last day, and the exact expiry instant', () => {
    const expiry = '2030-10-08T10:00:00Z'
    const end = Date.parse(expiry)
    expect(remainingRetention(expiry, end - 6 * 86_400_000)).toBe('剩余 6 天')
    expect(remainingRetention(expiry, end - 1)).toBe('不足 1 天')
    expect(remainingRetention(expiry, end)).toBe('已过期')
  })
})
