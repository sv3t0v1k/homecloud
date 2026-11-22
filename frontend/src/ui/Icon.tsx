import type { SVGProps } from 'react'
import {
  Search,
  ArrowLeft,
  Lock,
  Key,
  Cloud,
  Home,
  Menu,
  Trash2,
  User,
  LogOut,
  Folder,
  File,
  Image,
  FileText,
  MoreHorizontal,
  Upload,
  Download,
  Plus,
  X,
  ChevronRight,
  Check,
  Link,
  Copy,
  Edit2,
  Move,
  Grid,
  List,
  AlertTriangle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Undo2,
  ZoomIn,
  ZoomOut,
  QrCode,
  Keyboard,
  RotateCw,
} from 'lucide-react'

type IconName =
  | 'search'
  | 'arrow-left'
  | 'lock'
  | 'key'
  | 'cloud'
  | 'home'
  | 'menu'
  | 'trash'
  | 'user'
  | 'logout'
  | 'folder'
  | 'file'
  | 'image'
  | 'text'
  | 'more'
  | 'upload'
  | 'download'
  | 'plus'
  | 'close'
  | 'chevron'
  | 'check'
  | 'link'
  | 'copy'
  | 'edit'
  | 'move'
  | 'grid'
  | 'list'
  | 'warning'
  | 'sort'
  | 'sort-asc'
  | 'sort-desc'
  | 'undo'
  | 'zoom-in'
  | 'zoom-out'
  | 'qr'
  | 'keyboard'
  | 'refresh'

const iconMap: Record<IconName, React.ComponentType<SVGProps<SVGSVGElement>>> = {
  search: Search,
  'arrow-left': ArrowLeft,
  lock: Lock,
  key: Key,
  cloud: Cloud,
  home: Home,
  menu: Menu,
  trash: Trash2,
  user: User,
  logout: LogOut,
  folder: Folder,
  file: File,
  image: Image,
  text: FileText,
  more: MoreHorizontal,
  upload: Upload,
  download: Download,
  plus: Plus,
  close: X,
  chevron: ChevronRight,
  check: Check,
  link: Link,
  copy: Copy,
  edit: Edit2,
  move: Move,
  grid: Grid,
  list: List,
  warning: AlertTriangle,
  sort: ArrowUpDown,
  'sort-asc': ArrowUp,
  'sort-desc': ArrowDown,
  undo: Undo2,
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  qr: QrCode,
  keyboard: Keyboard,
  refresh: RotateCw,
}

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  const Component = iconMap[name]
  return <Component aria-hidden="true" strokeWidth={1.7} width={20} height={20} {...props} />
}