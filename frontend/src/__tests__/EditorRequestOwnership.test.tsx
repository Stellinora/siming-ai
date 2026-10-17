import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Modal, message } from 'antd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}))

vi.unmock('axios')

vi.mock('../api/client', () => ({ apiClient: api }))
vi.mock('../hooks/useModelOptions', () => ({
  useModelOptions: () => ({
    modelOptions: [{
      value: 'opencode_cli:test-model',
      label: 'OpenCode CLI · test-model（全局默认）',
      provider: 'opencode_cli',
      model: 'test-model',
      isGlobalDefault: true,
    }],
    defaultModel: 'opencode_cli:test-model',
    loading: false,
  }),
}))

import WriterPage from '../pages/WriterPage'
import { AiPanelProvider, useAiPanelContext } from '../contexts/AiPanelContext'

const source = '他站在门边，心中不由得涌起一阵复杂的情绪。值得注意的是，这一切都说明命运已经改变。'
const chapter = {
  id: 'chapter-1',
  project_id: 'project-1',
  outline_node_id: null,
  title: '第一章',
  word_count: source.length,
  current_version: 1,
  sort_order: 1000,
  outline_title: null,
  outline_status: null,
  outline_node_type: null,
  outline_path: [],
  summary_text: null,
  key_events: [],
  created_at: '2026-08-09T12:00:00Z',
  updated_at: '2026-08-09T12:00:00Z',
  content: source,
  snapshot_count: 1,
}

const response = <T,>(data: T) => ({ data: { code: 0, message: 'ok', data } })


function RefreshControl() {
 const {triggerRefresh} = useAiPanelContext()
 return <button onClick={triggerRefresh}>后台建档完成刷新</button>
}
const second = {...chapter, id:'chapter-2',current_version:2,title:'第二章',content:'第二章原正文'}
describe('editor request ownership', () => {
 afterEach(() => { Modal.destroyAll(); message.destroy(); vi.restoreAllMocks() })
 beforeEach(() => {
  vi.clearAllMocks(); window.sessionStorage.clear()
  api.get.mockImplementation((url:string) => {
   if(url.endsWith('/chapter-drafts/pending')) return Promise.resolve(response(null))
   if(url.endsWith('/outline')) return Promise.resolve(response({items:[],flat:[],total:0}))
   if(url.endsWith('/chapters')) return Promise.resolve(response({items:[chapter,second],total:2}))
   if(url.endsWith('/snapshots')) return Promise.resolve(response({items:[{id:'snapshot-1',chapter_id:'chapter-1',version_number:1,word_count:10,trigger_type:'manual_save',created_at:'2026-08-09T12:00:00Z'}],total:1}))
   if(url.endsWith('/chapters/chapter-1')) return Promise.resolve(response(chapter))
   if(url.endsWith('/chapters/chapter-2')) return Promise.resolve(response(second))
   throw new Error('Unexpected '+url)
  })
 })
 it('background refresh preserves unsaved chapter editing', async()=>{
  render(<AiPanelProvider><RefreshControl/><WriterPage projectId="project-1"/></AiPanelProvider>)
  const editor=await screen.findByDisplayValue(source)
  fireEvent.change(editor,{target:{value:'作者未保存的重要修改'}})
  expect(screen.getByRole('status')).toHaveTextContent('有未保存修改')
  fireEvent.click(screen.getByRole('button',{name:'后台建档完成刷新'}))
  await act(async()=>{})
  expect(editor).toHaveValue('作者未保存的重要修改')
  expect(screen.getByRole('status')).toHaveTextContent('有未保存修改')
  expect(api.put).not.toHaveBeenCalled()
 })
 it('delayed restore cannot overwrite or save into another chapter', async()=>{
  let finish!: (value:unknown)=>void
  api.post.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  render(<AiPanelProvider><WriterPage projectId="project-1"/></AiPanelProvider>)
  await screen.findByDisplayValue(source)
  fireEvent.click(screen.getByText('版本历史'))
  fireEvent.click(await screen.findByRole('button',{name:/恢复/}))
  await waitFor(()=>expect(document.querySelector('.ant-popconfirm .ant-btn-primary')).toBeTruthy())
  fireEvent.click(document.querySelector('.ant-popconfirm .ant-btn-primary')!)
  await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/projects/project-1/chapters/chapter-1/restore/snapshot-1'))
  fireEvent.click(screen.getByRole('button',{name:'打开章节：第二章'}))
  await screen.findByDisplayValue(second.content)
  await act(async()=>finish(response({...chapter,content:'第一章历史正文',current_version:2})))
  const editor=await screen.findByDisplayValue(second.content)
  expect(screen.queryByDisplayValue('第一章历史正文')).toBeNull()
  fireEvent.change(editor,{target:{value:'第二章正常编辑'}})
  api.put.mockResolvedValue(response({...second,content:'第二章正常编辑',current_version:2}))
  fireEvent.click(screen.getByRole('button',{name:'保存正文'}))
  await waitFor(()=>expect(api.put).toHaveBeenCalledWith('/projects/project-1/chapters/chapter-2',expect.objectContaining({content:'第二章正常编辑'})))
 })
})




import OutlinePage from '../pages/OutlinePage'
import { MemoryRouter } from 'react-router-dom'
it('outline refresh preserves unsaved formal node edits', async()=>{
 const volume={id:'volume-1',project_id:'project-1',parent_id:null,node_type:'volume',title:'原卷名',summary:'原卷纲',status:'pending',sort_order:0,metadata:{},linked_characters:[],children:[]}
 api.get.mockImplementation((url:string)=>{
  if(url.endsWith('/outline')) {const formal={...volume}; return Promise.resolve(response({items:[formal],flat:[formal],total:1}))}
  if(url.endsWith('/outline-drafts/pending'))return Promise.resolve(response(null))
  if(url.endsWith('/characters'))return Promise.resolve(response({items:[],total:0}))
  throw new Error('Unexpected '+url)
 })
 render(<MemoryRouter><AiPanelProvider><RefreshControl/><OutlinePage projectId="project-1"/></AiPanelProvider></MemoryRouter>)
 const title=await screen.findByDisplayValue('原卷名')
 fireEvent.change(title,{target:{value:'作者未保存的卷名修改'}})
 fireEvent.click(screen.getByRole('button',{name:'后台建档完成刷新'}))
 await act(async()=>{})
 expect(title).toHaveValue('作者未保存的卷名修改')
})
