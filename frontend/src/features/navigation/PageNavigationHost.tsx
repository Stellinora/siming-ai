import { useEffect, useState } from 'react'
import { Empty, Input, Modal, Select } from 'antd'
import { ArrowRightOutlined, SearchOutlined } from '@ant-design/icons'
import { matchPath, useLocation, useNavigate } from 'react-router-dom'
import { useProjects } from '../projects'
import { useGatewayRuntime } from '../../components/GatewayRuntimeContext'
import { PROJECT_PAGES, SYSTEM_PAGES, projectPagePath } from '../../shared/navigation'
import { confirmPageNavigation } from '../../shared/pageNavigationGuard'
import '../../components/PageNavigation.css'
import { PAGE_NAVIGATION_OPEN } from '../../shared/navigation'

function NavigationContents({ currentProjectId, onNavigate }: {
  currentProjectId?: string
  onNavigate: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [projectId, setProjectId] = useState(currentProjectId)
  const projects = useProjects()
  const { headless } = useGatewayRuntime()
  const needle = query.trim().toLocaleLowerCase()
  const systemPages = SYSTEM_PAGES
    .filter((page) => !headless || !('desktopOnly' in page && page.desktopOnly))
    .map((page) => ({ ...page, scope: '司命' }))
  const projectPages = PROJECT_PAGES.map((page) => ({ ...page, scope: '作品', path: projectId ? projectPagePath(projectId, page.key) : undefined }))
  const pages = (projectId ? [...projectPages, ...systemPages] : [...systemPages, ...projectPages])
    .filter((page) => `${page.title} ${page.description} ${page.group}`.toLocaleLowerCase().includes(needle))
  const groups = [...new Set(pages.map((page) => `${page.scope} · ${page.group}`))]
  const firstAvailable = pages.find((page) => page.path)
  return (
    <div className="page-navigation-content">
      <Input
        autoFocus
        size="large"
        prefix={<SearchOutlined />}
        placeholder="搜索页面名称，如建档、角色、模型、回收站"
        aria-label="搜索页面"
        allowClear
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onPressEnter={(event) => { if (!event.nativeEvent.isComposing && firstAvailable?.path) onNavigate(firstAvailable.path) }}
      />
      <div className="page-navigation-project">
        <label htmlFor="page-navigation-project">打开哪部作品的页面</label>
        <Select
          id="page-navigation-project"
          aria-label="选择作品"
          placeholder="选择作品"
          value={projectId}
          loading={projects.isLoading}
          showSearch
          optionFilterProp="label"
          onChange={setProjectId}
          options={projects.data?.items.map((project) => ({ label: project.title, value: project.id }))}
          notFoundContent={projects.isError ? '作品读取失败，请关闭后重试' : '暂无作品'}
        />
      </div>
      <div className="page-navigation-results" aria-label="页面列表">
        {!pages.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未找到匹配页面，试试更短的名称" />}
        {groups.map((group) => (
          <section key={group} className="page-navigation-group" aria-label={group}>
            <h3>{group}</h3>
            {pages.filter((page) => `${page.scope} · ${page.group}` === group).map((page) => (
              <button
                key={`${page.scope}-${page.key}`}
                className="page-navigation-item"
                type="button"
                disabled={!page.path}
                onClick={() => { if (page.path) onNavigate(page.path) }}
              >
                <span><strong>{page.title}</strong><small>{page.path ? page.description : '先选择作品'}</small></span>
                <ArrowRightOutlined aria-hidden />
              </button>
            ))}
          </section>
        ))}
      </div>
      <p className="page-navigation-hint">输入名称查找页面 · Enter 打开首个可用结果 · Esc 关闭</p>
    </div>
  )
}

export default function PageNavigationHost() {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const projectId = matchPath('/project/:projectId/*', location.pathname)?.params.projectId
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    const handleOpen = () => setOpen(true)
    window.addEventListener('keydown', handleKey)
    window.addEventListener(PAGE_NAVIGATION_OPEN, handleOpen)
    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener(PAGE_NAVIGATION_OPEN, handleOpen)
    }
  }, [])
  return (
    <>
      <Modal title="页面导航" open={open} onCancel={() => setOpen(false)} footer={null} width={660} destroyOnHidden>
        {open && <NavigationContents currentProjectId={projectId} onNavigate={(path) => {
          confirmPageNavigation(() => { setOpen(false); navigate(path) })
        }} />}
      </Modal>
    </>
  )
}
