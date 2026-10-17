import { Modal } from 'antd'

const editors = new Set<() => boolean>()

/** Editors remain responsible for their own dirty state, including cached tabs. */
export function registerUnsavedEditor(isDirty: () => boolean) {
  editors.add(isDirty)
  return () => { editors.delete(isDirty) }
}

export function confirmPageNavigation(navigate: () => void) {
  if (![...editors].some((isDirty) => isDirty())) {
    navigate()
    return
  }
  Modal.confirm({
    title: '还有未保存的修改',
    content: '切换页面可能丢失未保存内容。请先保存，或确认继续离开。',
    okText: '继续离开',
    cancelText: '留下保存',
    autoFocusButton: 'cancel',
    okButtonProps: { danger: true },
    onOk: navigate,
  })
}
