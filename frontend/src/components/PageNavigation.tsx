import { Button, Tooltip } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { PAGE_NAVIGATION_OPEN } from '../shared/navigation'

export default function PageNavigation({ iconOnly = false }: { iconOnly?: boolean }) {
  return (
    <Tooltip title="页面导航（Ctrl / ⌘ + K）">
      <Button
        className="page-navigation-trigger"
        icon={<SearchOutlined />}
        aria-label="页面导航"
        onClick={() => window.dispatchEvent(new Event(PAGE_NAVIGATION_OPEN))}
      >
        {!iconOnly && '页面导航'}
      </Button>
    </Tooltip>
  )
}
