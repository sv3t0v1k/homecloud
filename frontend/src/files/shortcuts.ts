export interface ShortcutHint {
  keys: string
  description: string
}

/** Единый реестр клавиатурных сокращений файлового менеджера. */
export const DIRECTORY_SHORTCUTS: ShortcutHint[] = [
  { keys: '↑ / ↓', description: 'Переход по списку файлов и папок' },
  { keys: 'Home / End', description: 'К первому или последнему элементу списка' },
  { keys: 'Enter', description: 'Открыть файл или папку под фокусом' },
  { keys: 'Ctrl/Cmd + A', description: 'Выбрать все видимые элементы' },
  { keys: 'Esc', description: 'Снять выделение' },
  { keys: 'Delete', description: 'Переместить выбранное в корзину' },
  { keys: 'F2', description: 'Переименовать выбранный элемент' },
  { keys: '?', description: 'Открыть эту справку' },
]
