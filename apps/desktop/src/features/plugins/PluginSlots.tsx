import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconPuzzle, IconX } from '@tabler/icons-react'
import { $plugins, pluginsAt } from '../../store/plugins.ts'
import { PluginFrame } from './PluginFrame.tsx'

/** Menu-bar widgets: 24 px tall, as wide as they ask (up to 240). */
export function MenuBarWidgets() {
  useUiT()
  const plugins = pluginsAt(useStore($plugins), 'menubar')

  return plugins.map(plugin => <PluginFrame key={plugin.manifest.id} plugin={plugin} at="menubar" width={Math.min(240, plugin.manifest.size?.width ?? 120)} height={24} className="rounded-md" />)
}

/** Overview cards, one per widget that sits there. */
export function OverviewWidgets() {
  useUiT()
  const plugins = pluginsAt(useStore($plugins), 'overview')

  if (plugins.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col gap-2" aria-label={uiT("ui.1fda79ffb659")}>
      {plugins.map(plugin => (
        <div key={plugin.manifest.id} className="glass overflow-hidden rounded-xl">
          <div className="flex h-7 items-center gap-1.5 px-3 text-[11px] font-medium text-fg-4">
            <IconPuzzle size={12} />
            {plugin.manifest.name}
          </div>
          <PluginFrame plugin={plugin} at="overview" className="w-full" height={plugin.manifest.size?.height ?? 160} />
        </div>
      ))}
    </div>
  )
}

/** A widget in its own floating window (the `panel` placement). */
export function WidgetWindow({ pluginId, onClose }: { pluginId?: string; onClose?: () => void }) {
  useUiT()
  const plugin = useStore($plugins).find(item => item.manifest.id === pluginId)

  if (!plugin?.enabled) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[12.5px] text-fg-3">
        <IconPuzzle size={20} />
        {plugin ? uiT("ui.c7d421f2f980", { value1: String(plugin.manifest.name) }) : uiT("ui.e49437d1f952")}
        {onClose && (
          <button type="button" onClick={onClose} className="mt-2 flex items-center gap-1 text-fg-4 hover:text-fg">
            <IconX size={13} />{uiT("ui.b6105258a5b0")}</button>
        )}
      </div>
    )
  }

  return <PluginFrame plugin={plugin} at="panel" className="h-full w-full" />
}
