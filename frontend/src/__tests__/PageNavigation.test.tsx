import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { Modal } from 'antd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PageNavigation from '../components/PageNavigation'
import PageNavigationHost from '../features/navigation/PageNavigationHost'
import { registerUnsavedEditor } from '../shared/pageNavigationGuard'

vi.mock('../features/projects', () => ({
  useProjects: () => ({ data: { items: [{ id: 'book-1', title: '山海记' }] }, isLoading: false }),
}))
function Location() {
  const location = useLocation()
  const navigate = useNavigate()
  return <><output aria-label="当前地址">{location.pathname}{location.search}</output><button onClick={() => navigate(-1)}>返回上页</button></>
}
function renderNavigation(path = '/project/book-1') {
  render(<MemoryRouter initialEntries={[path]}><PageNavigation /><PageNavigationHost /><Location /></MemoryRouter>)
}

describe('page navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const confirm = Modal.confirm
    vi.spyOn(Modal, 'confirm').mockImplementation((props) => confirm({ ...props, transitionName: '', maskTransitionName: '' }))
  })
  afterEach(() => { Modal.destroyAll(); vi.restoreAllMocks() })

  it('finds nested pages by visible name and makes a real, reversible route change', async () => {
    renderNavigation()
    fireEvent.click(screen.getByRole('button', { name: '页面导航' }))
    fireEvent.change(await screen.findByRole('textbox', { name: '搜索页面' }), { target: { value: '建档' } })
    fireEvent.click(screen.getByRole('button', { name: /作品建档/ }))
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('/project/book-1?view=cataloging')
    fireEvent.click(screen.getByRole('button', { name: '返回上页' }))
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('/project/book-1')
  })

  it('opens with Ctrl+K and provides an unambiguous global recycle bin destination', async () => {
    renderNavigation('/dashboard')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(await screen.findByRole('textbox', { name: '搜索页面' }), { target: { value: '回收站' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索页面' }), { key: 'Enter', code: 'Enter', charCode: 13 })
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('/recycle-bin')
  })

  it('requires choosing a real project before opening a project page from outside a workspace', async () => {
    renderNavigation('/dashboard')
    fireEvent.click(screen.getByRole('button', { name: '页面导航' }))
    expect(await screen.findByRole('button', { name: /角色管理/ })).toBeDisabled()
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '选择作品' }))
    fireEvent.click(await screen.findByText('山海记'))
    fireEvent.click(screen.getByRole('button', { name: /角色管理/ }))
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('/project/book-1?view=characters')
  })

  it('keeps the current page when the author cancels navigation with unsaved edits', async () => {
    const unregister = registerUnsavedEditor(() => true)
    try {
      renderNavigation()
      fireEvent.click(screen.getByRole('button', { name: '页面导航' }))
      fireEvent.change(await screen.findByRole('textbox', { name: '搜索页面' }), { target: { value: '回收站' } })
      fireEvent.click(screen.getByRole('button', { name: /回收站/ }))
      const [confirmation] = await screen.findAllByText('还有未保存的修改')
      const dialog = confirmation.closest('[role="dialog"]') as HTMLElement
      fireEvent.click(within(dialog).getByRole('button', { name: /留下保存/ }))
      await waitFor(() => expect(screen.queryAllByText('还有未保存的修改')).toHaveLength(0))
      expect(screen.getByLabelText('当前地址')).toHaveTextContent('/project/book-1')
    } finally { unregister() }
  })
})
