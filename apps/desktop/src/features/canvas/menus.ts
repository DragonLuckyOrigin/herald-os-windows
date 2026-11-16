import { t as uiT } from '../../store/i18n.ts'
const EFFECT_KEYS = {
  "stroke": "canvas.effect.stroke",
  "shadow": "canvas.effect.shadow",
  "colorOverlay": "canvas.effect.colorOverlay",
  "innerShadow": "canvas.effect.innerShadow",
  "outerGlow": "canvas.effect.outerGlow",
  "innerGlow": "canvas.effect.innerGlow"
} as const
const effectLabel = (kind: keyof typeof EFFECT_KEYS) => uiT(EFFECT_KEYS[kind])

/*
 * Herald Canvas's menus and their shortcuts, in one table so the two never disagree. Shortcuts
 * follow the usual photo-editor keys (⌘J duplicates or copies the selection to a layer, ⌘E merges
 * down, ⌘G groups, ⌘T transforms, ⇧F5 fills).
 */

import { atom } from 'nanostores'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { defaultEffect } from '../../../shared/canvas/comp-format.ts'
import { ADJUSTMENT_MENU } from './adjustment-icons.tsx'
import {
  addAdjustmentLayer,
  addFolder,
  addLayer,
  addMask,
  alignPicked,
  arrange,
  autoAdjust,
  clearLayerStyle,
  copyLayerStyle,
  deletePicked,
  distributePicked,
  duplicatePicked,
  flattenImage,
  groupPicked,
  hasCopiedStyle,
  maskAction,
  mergeDown,
  mergeTarget,
  pasteLayerStyle,
  setEffect,
  showEffects,
  toggleClipping,
  ungroupActive
} from './actions.ts'
import {
  clearSelection,
  copySelection,
  cropToSelection,
  cutSelection,
  deselect,
  fillSelection,
  flipCanvasWay,
  invertSelected,
  layerViaCopy,
  paste,
  rasterize,
  reselect,
  rotateCanvasBy,
  selectEverything,
  type SelectionChange,
  selectLayerPixels
} from './editing.ts'
import { ensureModel } from './ai/models.ts'
import { cannotSegment, selectSubject } from './ai/remove-background.ts'
import { ALIGN_EDGES, DISTRIBUTE_MODES } from './engine/align.ts'
import { type FilterKind } from './engine/filters.ts'
import { applyFilterToDocument, lastFilter } from './filter-run.ts'
import { startSelectMask } from './select-mask.ts'
import { cannotPaint } from './tools/target.ts'
import type { CanvasDocument } from './engine/document.ts'
import { EFFECT_ORDER, effectKinds, takesEffects } from './engine/layer-effects.ts'
import { messageOf } from './errors.ts'
import { isMac } from './platform.ts'
import { keysLabel, matches } from '../../lib/shortcuts.ts'
import { $autosave, exportDocument, notify, openPath, save, setAutosave } from './store.ts'
import { hasOpenWork, settleTools } from './tools/sessions.ts'
import { $background, $foreground, setTool } from './tools/state.ts'
import { startTransform, turnPicked } from './tools/transform.ts'
import { $panelTab, $viewOptions, actualPixels, fitToScreen, setViewOption, showPanel, zoomStep } from './view-state.ts'

export { isMac }

/** Dialogs the window shows on request. */
export type CanvasDialog =
  | { kind: 'new' }
  | { kind: 'close'; key: string }
  | { kind: 'canvas-size' }
  | { kind: 'image-size' }
  | { kind: 'trim' }
  | { kind: 'fill' }
  | { kind: 'modify-selection'; change: SelectionChange }
  | { kind: 'remove-background' }
  | { kind: 'content-fill' }
  | { kind: 'generate'; mode: 'fill' | 'layer' }
  | { kind: 'models' }
  | { kind: 'notes'; title: string; notes: string[] }
  | { kind: 'new-guide' }
  | { kind: 'filter'; filter: FilterKind }
  | null

export const $dialog = atom<CanvasDialog>(null)

export interface CanvasCommand {
  id: string
  label: string | ((doc: CanvasDocument | null) => string)
  /** `mod` is ⌘ on the Mac and Ctrl elsewhere: `mod+shift+z`. */
  shortcut?: string
  /** Other shortcuts that run it, not shown in the menu. */
  also?: string[]
  run: (doc: CanvasDocument | null) => void
  /** Off when it cannot apply; commands that need a document are off without one. */
  enabled?: (doc: CanvasDocument) => boolean
  needsDocument?: boolean
  checked?: (doc: CanvasDocument | null) => boolean
  dividerBefore?: boolean
  /** Works on an open Free Transform rather than putting it in first. */
  inSession?: boolean
  /** Commands in a submenu of this one (which then runs nothing itself). */
  submenu?: CanvasCommand[]
}

export interface CanvasMenu {
  id: string
  label: string
  items: CanvasCommand[]
}

const onDoc = (run: (doc: CanvasDocument) => void) => (doc: CanvasDocument | null) => doc && run(doc)

const openFile = async (): Promise<void> => {
  const file = await window.heraldOS.canvas.pickOpen()

  if (file) {
    openPath(file).catch((error: unknown) => notify(uiT('office.openFailed', { file: file.split('/').pop() ?? file, error: messageOf(error) }), 'error'))
  }
}

const selected = (doc: CanvasDocument): boolean => Boolean(doc.state.selection)
const hasLayer = (doc: CanvasDocument): boolean => Boolean(doc.active)
const hasMask = (doc: CanvasDocument): boolean => Boolean(doc.active?.mask)
const nothing = (): void => {}

/** Select > Subject: the model is asked for first when it is not on this computer yet. */
async function subject(doc: CanvasDocument): Promise<void> {
  if (!(await ensureModel('isnet', 'Select Subject'))) {
    return
  }

  notify(uiT('canvas.notice.findingSubject'))

  try {
    await selectSubject(doc)
    notify(uiT('canvas.notice.selectedSubject'))
  } catch (error) {
    notify(uiT('canvas.notice.subjectFailed', { error: messageOf(error) }), 'error')
  }
}

const ADJUSTMENT_ITEMS: CanvasCommand[] = ADJUSTMENT_MENU.map(({ kind, dividerBefore }) => ({
  id: `adjustment-${kind}`,
  label: kind,
  needsDocument: true,
  dividerBefore,
  run: onDoc((doc) => addAdjustmentLayer(doc, kind))
}))

const MASK_ITEMS: CanvasCommand[] = [
  { id: 'mask-reveal', get label() { return uiT("ui.8ea6d7812ffd") }, needsDocument: true, enabled: hasLayer, run: onDoc((doc) => maskAction(doc, 'reveal')) },
  { id: 'mask-hide', get label() { return uiT("ui.95595d5acf6f") }, needsDocument: true, enabled: hasLayer, run: onDoc((doc) => maskAction(doc, 'hide')) },
  { id: 'mask-reveal-selection', get label() { return uiT("ui.3395a8b99d58") }, needsDocument: true, enabled: (doc) => hasLayer(doc) && selected(doc), run: onDoc((doc) => maskAction(doc, 'revealSelection')) },
  { id: 'mask-hide-selection', get label() { return uiT("ui.6be5434948e2") }, needsDocument: true, enabled: (doc) => hasLayer(doc) && selected(doc), run: onDoc((doc) => maskAction(doc, 'hideSelection')) },
  { id: 'mask-invert', get label() { return uiT("ui.7e04f2ffb933") }, needsDocument: true, enabled: hasMask, run: onDoc((doc) => maskAction(doc, 'invert')), dividerBefore: true },
  { id: 'mask-apply', get label() { return uiT("ui.31e392d1c037") }, needsDocument: true, enabled: (doc) => hasMask(doc) && !doc.active?.isGroup && !doc.active?.adjustment, run: onDoc((doc) => maskAction(doc, 'apply')) },
  {
    id: 'mask-toggle',
    label: (doc) => (doc?.active?.maskEnabled === false ? uiT('canvas.menu.enable') : uiT('canvas.menu.disable')),
    needsDocument: true,
    enabled: hasMask,
    run: onDoc((doc) => maskAction(doc, doc.active?.maskEnabled === false ? 'enable' : 'disable'))
  },
  {
    id: 'mask-link',
    label: (doc) => (doc?.active?.maskLinked === false ? uiT('canvas.menu.link') : uiT('canvas.menu.unlink')),
    needsDocument: true,
    enabled: hasMask,
    run: onDoc((doc) => maskAction(doc, doc.active?.maskLinked === false ? 'link' : 'unlink'))
  },
  { id: 'mask-delete', get label() { return uiT("ui.e2d0a54968ea") }, needsDocument: true, enabled: hasMask, run: onDoc((doc) => maskAction(doc, 'remove')), dividerBefore: true }
]

const EFFECT_ITEMS: CanvasCommand[] = [
  ...EFFECT_ORDER.map(
    (kind): CanvasCommand => ({
      id: `effect-${kind}`,
      get label() { return effectLabel(kind) },
      needsDocument: true,
      enabled: (doc) => takesEffects(doc.active),
      checked: (doc) => Boolean(doc?.active?.effects?.[kind]),
      // Picking one the layer lacks adds it; the Properties panel then shows its settings.
      run: onDoc((doc) => {
        const layer = doc.active

        if (layer && !layer.effects?.[kind]) {
          setEffect(doc, layer, kind, defaultEffect[kind]())
        } else if (layer) {
          setEffect(doc, layer, kind, undefined)
        }
      })
    })
  ),
  {
    id: 'effects-visible',
    label: (doc) => (effectKinds(doc?.active?.effects).every((kind) => (doc?.active?.effects?.[kind] as { enabled?: boolean }).enabled === false) ? uiT('canvas.menu.showEffects') : uiT('canvas.menu.hideEffects')),
    needsDocument: true,
    enabled: (doc) => effectKinds(doc.active?.effects).length > 0,
    dividerBefore: true,
    run: onDoc((doc) => {
      const layer = doc.active

      if (layer) {
        showEffects(doc, layer, effectKinds(layer.effects).every((kind) => (layer.effects?.[kind] as { enabled?: boolean }).enabled === false))
      }
    })
  },
  { id: 'style-copy', get label() { return uiT("ui.e6723f1abbca") }, needsDocument: true, enabled: (doc) => effectKinds(doc.active?.effects).length > 0, dividerBefore: true, run: onDoc((doc) => copyLayerStyle(doc)) },
  { id: 'style-paste', get label() { return uiT("ui.d9f1cbe64a30") }, needsDocument: true, enabled: (doc) => hasCopiedStyle() && doc.picked.some(takesEffects), run: onDoc((doc) => pasteLayerStyle(doc)) },
  { id: 'effects-clear', get label() { return uiT("ui.97608e9e2c8b") }, needsDocument: true, enabled: (doc) => doc.picked.some((layer) => effectKinds(layer.effects).length > 0), run: onDoc((doc) => clearLayerStyle(doc)) }
]

const ALIGN_ITEMS: CanvasCommand[] = ALIGN_EDGES.map((edge, i) => ({
  id: `align-${edge}`,
  get label() { return uiT(ALIGN_MENU_KEYS[edge]) },
  needsDocument: true,
  enabled: (doc) => doc.picked.length > 0,
  dividerBefore: i === 3,
  run: onDoc((doc) => alignPicked(doc, edge))
}))

const DISTRIBUTE_ITEMS: CanvasCommand[] = DISTRIBUTE_MODES.map((mode, i) => ({
  id: `distribute-${mode}`,
  get label() { return uiT(ALIGN_MENU_KEYS[mode]) },
  needsDocument: true,
  enabled: (doc) => doc.picked.length >= 3,
  dividerBefore: i === 3 || i === 6,
  run: onDoc((doc) => distributePicked(doc, mode))
}))

/** Filter > Last Filter: the last filter again, with the same settings, without its dialog. */
async function repeatLastFilter(doc: CanvasDocument): Promise<void> {
  const spec = lastFilter()

  if (!spec) {
    return
  }

  notify(uiT('canvas.notice.applyingFilter', { filter: uiT(FILTER_KEYS[spec.kind]) }))

  try {
    notify((await applyFilterToDocument(doc, spec)) ? uiT('canvas.notice.appliedFilter', { filter: uiT(FILTER_KEYS[spec.kind]) }) : uiT('canvas.notice.filterNoChange', { filter: uiT(FILTER_KEYS[spec.kind]) }))
  } catch (error) {
    notify(uiT('canvas.notice.filterFailed', { filter: uiT(FILTER_KEYS[spec.kind]), error: messageOf(error) }), 'error')
  }
}

const filterItem = (kind: FilterKind): CanvasCommand => ({
  id: `filter-${kind}`,
  get label() { return `${uiT(FILTER_KEYS[kind])}…` },
  needsDocument: true,
  enabled: (doc) => !cannotPaint(doc),
  run: () => $dialog.set({ kind: 'filter', filter: kind })
})

const SNAP_ITEMS: CanvasCommand[] = (
  [
    ['snapGuides', 'canvas.snap.guides'],
    ['snapLayers', 'canvas.snap.layers'],
    ['snapCanvas', 'canvas.snap.canvasEdges']
  ] as const
).map(([key, label]) => ({ id: `snap-${key}`, get label() { return uiT(label) }, checked: () => $viewOptions.get()[key], run: () => setViewOption(key, !$viewOptions.get()[key]) }))

export const MENUS: CanvasMenu[] = [
  {
    id: 'file',
    get label() { return uiT("ui.50009ce1da4d") },
    items: [
      { id: 'new', get label() { return uiT("ui.d16fba620e45") }, shortcut: 'mod+n', run: () => $dialog.set({ kind: 'new' }) },
      { id: 'open', get label() { return uiT("ui.1f1d592bdd1a") }, shortcut: 'mod+o', run: () => void openFile() },
      { id: 'save', get label() { return uiT("ui.1509f561f241") }, shortcut: 'mod+s', needsDocument: true, run: onDoc((doc) => void save(doc).catch(() => {})), dividerBefore: true },
      { id: 'save-as', get label() { return uiT("ui.a4b76af59533") }, shortcut: 'mod+shift+s', needsDocument: true, run: onDoc((doc) => void save(doc, { as: true }).catch(() => {})) },
      { id: 'autosave', get label() { return uiT("ui.d70b61004b83") }, checked: () => $autosave.get(), run: () => setAutosave(!$autosave.get()) },
      { id: 'export-png', get label() { return uiT("ui.d67c03f1b51a") }, shortcut: 'mod+alt+shift+w', needsDocument: true, run: onDoc((doc) => void exportDocument(doc, 'png')), dividerBefore: true },
      { id: 'export-jpeg', get label() { return uiT("ui.78ee1305a576") }, needsDocument: true, run: onDoc((doc) => void exportDocument(doc, 'jpeg')) },
      { id: 'export-webp', get label() { return uiT("ui.b5c2fef161ad") }, needsDocument: true, run: onDoc((doc) => void exportDocument(doc, 'webp')) },
      { id: 'export-psd', get label() { return uiT("ui.146c8b0ecb2e") }, needsDocument: true, run: onDoc((doc) => void exportDocument(doc, 'psd')) },
      { id: 'close', get label() { return uiT("ui.7d9eb7acb13e") }, shortcut: 'mod+w', needsDocument: true, run: onDoc((doc) => $dialog.set({ kind: 'close', key: doc.key })), dividerBefore: true }
    ]
  },
  {
    id: 'edit',
    get label() { return uiT("ui.464c4ffd019e") },
    items: [
      { id: 'undo', label: (doc) => (doc?.history.undoLabel ? uiT('canvas.menu.undoAction', { action: doc.history.undoLabel }) : uiT('canvas.menu.undo')), shortcut: 'mod+z', needsDocument: true, enabled: (doc) => doc.history.canUndo, run: onDoc((doc) => doc.undo()) },
      { id: 'redo', label: (doc) => (doc?.history.redoLabel ? uiT('canvas.menu.redoAction', { action: doc.history.redoLabel }) : uiT('canvas.menu.redo')), shortcut: 'mod+shift+z', needsDocument: true, enabled: (doc) => doc.history.canRedo, run: onDoc((doc) => doc.redo()) },
      { id: 'toggle-last', get label() { return uiT("ui.41451d291efa") }, shortcut: 'mod+alt+z', needsDocument: true, enabled: (doc) => doc.history.canUndo || doc.history.canRedo, run: onDoc((doc) => doc.toggleLast()) },
      { id: 'history', get label() { return uiT("ui.0e7696009337") }, needsDocument: true, checked: () => $panelTab.get() === 'history', run: () => showPanel($panelTab.get() === 'history' ? 'properties' : 'history') },
      { id: 'cut', get label() { return uiT("ui.1f45f02561f4") }, shortcut: 'mod+x', needsDocument: true, enabled: selected, run: onDoc(cutSelection), dividerBefore: true },
      { id: 'copy', get label() { return uiT("ui.e21f935f11d7") }, shortcut: 'mod+c', needsDocument: true, enabled: hasLayer, run: onDoc((doc) => copySelection(doc)) },
      { id: 'copy-merged', get label() { return uiT("ui.e91b1c221b8f") }, shortcut: 'mod+shift+c', needsDocument: true, run: onDoc((doc) => copySelection(doc, true)) },
      { id: 'paste', get label() { return uiT("ui.f3380f7b44bd") }, shortcut: 'mod+v', needsDocument: true, run: onDoc((doc) => void paste(doc).catch((error: unknown) => notify(uiT('canvas.notice.pasteFailed', { error: messageOf(error) }), 'error'))) },
      { id: 'fill', get label() { return uiT("ui.5b782a2a0323") }, shortcut: 'shift+f5', also: ['shift+backspace'], needsDocument: true, enabled: hasLayer, run: () => $dialog.set({ kind: 'fill' }), dividerBefore: true },
      { id: 'fill-foreground', get label() { return uiT("ui.6a989f4346c2") }, shortcut: 'alt+backspace', needsDocument: true, enabled: hasLayer, run: onDoc((doc) => fillSelection(doc, [...$foreground.get(), 255])) },
      { id: 'fill-background', get label() { return uiT("ui.4a7247734fad") }, shortcut: 'mod+backspace', needsDocument: true, enabled: hasLayer, run: onDoc((doc) => fillSelection(doc, [...$background.get(), 255])) },
      { id: 'content-fill', get label() { return uiT("ui.746a9822372e") }, needsDocument: true, enabled: selected, run: () => $dialog.set({ kind: 'content-fill' }) },
      { id: 'generative-fill', get label() { return uiT("ui.2029a078ffca") }, needsDocument: true, enabled: selected, run: () => $dialog.set({ kind: 'generate', mode: 'fill' }) },
      {
        id: 'clear',
        label: (doc) => (doc?.state.selection ? uiT('canvas.menu.clear') : uiT('canvas.menu.deleteLayer')),
        shortcut: 'backspace',
        also: ['delete'],
        needsDocument: true,
        enabled: (doc) => doc.picked.length > 0,
        run: onDoc((doc) => clearSelection(doc) || deletePicked(doc))
      },
      {
        id: 'free-transform',
        get label() { return uiT("ui.0c2693e9555d") },
        shortcut: 'mod+t',
        needsDocument: true,
        enabled: hasLayer,
        inSession: true,
        run: onDoc((doc) => {
          setTool('move')
          startTransform(doc)
        }),
        dividerBefore: true
      },
      {
        id: 'distort',
        get label() { return uiT("ui.86f8769ca876") },
        needsDocument: true,
        enabled: hasLayer,
        inSession: true,
        run: onDoc((doc) => {
          setTool('move')
          startTransform(doc, { distort: true })
        })
      },
      { id: 'flip-horizontal', get label() { return uiT("ui.7bb5bf753e0d") }, needsDocument: true, enabled: hasLayer, inSession: true, run: onDoc((doc) => turnPicked(doc, { flip: 'horizontal' }, 'Flip Horizontal')) },
      { id: 'flip-vertical', get label() { return uiT("ui.06d6fcadf22e") }, needsDocument: true, enabled: hasLayer, inSession: true, run: onDoc((doc) => turnPicked(doc, { flip: 'vertical' }, 'Flip Vertical')) },
      { id: 'rotate-180', get label() { return uiT("ui.cffb26b0098b") }, needsDocument: true, enabled: hasLayer, inSession: true, run: onDoc((doc) => turnPicked(doc, { degrees: 180 }, 'Rotate 180°')) },
      { id: 'rotate-cw', get label() { return uiT("ui.bad16d744e2d") }, needsDocument: true, enabled: hasLayer, inSession: true, run: onDoc((doc) => turnPicked(doc, { degrees: 90 }, 'Rotate 90° Clockwise')) },
      { id: 'rotate-ccw', get label() { return uiT("ui.e7d1965808e1") }, needsDocument: true, enabled: hasLayer, inSession: true, run: onDoc((doc) => turnPicked(doc, { degrees: -90 }, 'Rotate 90° Counter Clockwise')) },
      { id: 'models', get label() { return uiT("ui.c2e23511e30b") }, run: () => $dialog.set({ kind: 'models' }), dividerBefore: true }
    ]
  },
  {
    id: 'image',
    get label() { return uiT("ui.1aa4cb0bcca7") },
    items: [
      { id: 'auto-tone', get label() { return uiT("ui.f25557d5d134") }, shortcut: 'mod+shift+l', needsDocument: true, enabled: (doc) => doc.state.layers.length > 0, run: onDoc((doc) => autoAdjust(doc, 'tone')) },
      { id: 'auto-contrast', get label() { return uiT("ui.d01edfcf18fb") }, shortcut: 'mod+alt+shift+l', needsDocument: true, enabled: (doc) => doc.state.layers.length > 0, run: onDoc((doc) => autoAdjust(doc, 'contrast')) },
      { id: 'auto-color', get label() { return uiT("ui.f3ef3209b78a") }, shortcut: 'mod+shift+b', needsDocument: true, enabled: (doc) => doc.state.layers.length > 0, run: onDoc((doc) => autoAdjust(doc, 'color')) },
      { id: 'image-size', get label() { return uiT("ui.10baa2e33d03") }, shortcut: 'mod+alt+i', needsDocument: true, run: () => $dialog.set({ kind: 'image-size' }), dividerBefore: true },
      { id: 'canvas-size', get label() { return uiT("ui.840fa98abd57") }, shortcut: 'mod+alt+c', needsDocument: true, run: () => $dialog.set({ kind: 'canvas-size' }) },
      { id: 'crop', get label() { return uiT("ui.8b0cf21bf2a7") }, needsDocument: true, enabled: selected, run: onDoc(cropToSelection), dividerBefore: true },
      { id: 'trim', get label() { return uiT("ui.1bd5f1e3d7b9") }, needsDocument: true, run: () => $dialog.set({ kind: 'trim' }) },
      { id: 'rotate-canvas-180', get label() { return uiT("ui.01d09b3c7e03") }, needsDocument: true, run: onDoc((doc) => rotateCanvasBy(doc, 2)), dividerBefore: true },
      { id: 'rotate-canvas-cw', get label() { return uiT("ui.5cf9f2bf6ff6") }, needsDocument: true, run: onDoc((doc) => rotateCanvasBy(doc, 1)) },
      { id: 'rotate-canvas-ccw', get label() { return uiT("ui.af8eb34f4206") }, needsDocument: true, run: onDoc((doc) => rotateCanvasBy(doc, 3)) },
      { id: 'flip-canvas-horizontal', get label() { return uiT("ui.96a0103bfe31") }, needsDocument: true, run: onDoc((doc) => flipCanvasWay(doc, true)) },
      { id: 'flip-canvas-vertical', get label() { return uiT("ui.a73dddc55109") }, needsDocument: true, run: onDoc((doc) => flipCanvasWay(doc, false)) },
      { id: 'flatten', get label() { return uiT("ui.0280d310e6d8") }, needsDocument: true, enabled: (doc) => doc.state.layers.length > 0, run: onDoc(flattenImage), dividerBefore: true }
    ]
  },
  {
    id: 'layer',
    get label() { return uiT("ui.ac9ffcb2bf47") },
    items: [
      { id: 'new-layer', get label() { return uiT("ui.b09ba564b06b") }, shortcut: 'mod+shift+n', needsDocument: true, run: onDoc(addLayer) },
      { id: 'new-folder', get label() { return uiT("ui.c75ba8074400") }, needsDocument: true, run: onDoc(addFolder) },
      { id: 'new-adjustment', get label() { return uiT("ui.a59de743070e") }, needsDocument: true, run: nothing, submenu: ADJUSTMENT_ITEMS },
      { id: 'new-generated', get label() { return uiT("ui.c861270a1a0a") }, needsDocument: true, run: () => $dialog.set({ kind: 'generate', mode: 'layer' }) },
      {
        id: 'duplicate',
        label: (doc) => (doc?.state.selection ? 'New Layer via Copy' : 'Duplicate'),
        shortcut: 'mod+j',
        needsDocument: true,
        enabled: (doc) => doc.picked.length > 0,
        run: onDoc((doc) => (doc.state.selection ? layerViaCopy(doc) : duplicatePicked(doc)))
      },
      { id: 'via-cut', get label() { return uiT("ui.1b376749e44a") }, shortcut: 'mod+shift+j', needsDocument: true, enabled: (doc) => selected(doc) && Boolean(doc.active?.pixels), run: onDoc((doc) => layerViaCopy(doc, true)) },
      { id: 'delete', get label() { return uiT("ui.e2d0a54968ea") }, needsDocument: true, enabled: (doc) => doc.picked.length > 0, run: onDoc(deletePicked) },
      { id: 'rasterize', get label() { return uiT("ui.b37a1ce84fe7") }, needsDocument: true, enabled: (doc) => Boolean(doc.active?.text || doc.active?.shape), run: onDoc(rasterize) },
      { id: 'remove-background', get label() { return uiT("ui.dddcb6af1cee") }, needsDocument: true, enabled: (doc) => !cannotSegment(doc.active), run: () => $dialog.set({ kind: 'remove-background' }) },
      { id: 'group', get label() { return uiT("ui.08118fef2a75") }, shortcut: 'mod+g', needsDocument: true, enabled: (doc) => doc.picked.length > 0, run: onDoc(groupPicked), dividerBefore: true },
      { id: 'ungroup', get label() { return uiT("ui.b57ef478f9ba") }, shortcut: 'mod+shift+g', needsDocument: true, enabled: (doc) => Boolean(doc.active?.isGroup), run: onDoc(ungroupActive) },
      { id: 'mask', get label() { return uiT("ui.5adc794ffebe") }, needsDocument: true, enabled: (doc) => Boolean(doc.active && !doc.active.mask), run: onDoc((doc) => addMask(doc)), dividerBefore: true },
      { id: 'layer-mask', get label() { return uiT("ui.e868a12ad9a6") }, needsDocument: true, enabled: hasLayer, run: nothing, submenu: MASK_ITEMS },
      { id: 'layer-effects', get label() { return uiT("ui.395ac42544f9") }, needsDocument: true, enabled: (doc) => doc.picked.some(takesEffects), run: nothing, submenu: EFFECT_ITEMS },
      {
        id: 'clip',
        label: (doc) => (doc?.active?.maskSourceID ? 'Release Clipping Mask' : 'Create Clipping Mask'),
        shortcut: 'mod+alt+g',
        needsDocument: true,
        enabled: (doc) => Boolean(doc.active && !doc.active.isGroup),
        run: onDoc(toggleClipping),
        dividerBefore: true
      },
      { id: 'forward', get label() { return uiT("ui.1816a3240fe1") }, shortcut: 'mod+]', needsDocument: true, run: onDoc((doc) => arrange(doc, 'up')), dividerBefore: true },
      { id: 'backward', get label() { return uiT("ui.64a872d15087") }, shortcut: 'mod+[', needsDocument: true, run: onDoc((doc) => arrange(doc, 'down')) },
      { id: 'front', get label() { return uiT("ui.ce67c6954ace") }, shortcut: 'mod+shift+]', needsDocument: true, run: onDoc((doc) => arrange(doc, 'top')) },
      { id: 'back', get label() { return uiT("ui.33e1c6b9be0f") }, shortcut: 'mod+shift+[', needsDocument: true, run: onDoc((doc) => arrange(doc, 'bottom')) },
      { id: 'align', label: (doc) => (doc?.state.selection ? 'Align Layers to Selection' : 'Align'), needsDocument: true, enabled: (doc) => doc.picked.length > 0, run: nothing, submenu: ALIGN_ITEMS, dividerBefore: true },
      { id: 'distribute', get label() { return uiT("ui.b0585a6eba7b") }, needsDocument: true, enabled: (doc) => doc.picked.length >= 3, run: nothing, submenu: DISTRIBUTE_ITEMS },
      { id: 'merge-down', get label() { return uiT("ui.723f01ecd8f2") }, shortcut: 'mod+e', needsDocument: true, enabled: (doc) => Boolean(mergeTarget(doc)), run: onDoc(mergeDown), dividerBefore: true }
    ]
  },
  {
    id: 'select',
    get label() { return uiT("ui.2a78025de6aa") },
    items: [
      { id: 'select-all', get label() { return uiT("ui.a52ace420f21") }, shortcut: 'mod+a', needsDocument: true, run: onDoc(selectEverything) },
      { id: 'deselect', get label() { return uiT("ui.142174c19457") }, shortcut: 'mod+d', needsDocument: true, enabled: selected, run: onDoc(deselect) },
      { id: 'reselect', get label() { return uiT("ui.82ab787f5a1f") }, shortcut: 'mod+shift+d', needsDocument: true, enabled: (doc) => Boolean(doc.lastSelection && !doc.state.selection), run: onDoc(reselect) },
      { id: 'inverse', get label() { return uiT("ui.bfe272f94fb0") }, shortcut: 'mod+shift+i', needsDocument: true, enabled: selected, run: onDoc(invertSelected) },
      { id: 'subject', get label() { return uiT("ui.68971283841a") }, needsDocument: true, enabled: (doc) => doc.state.layers.length > 0, run: onDoc((doc) => void subject(doc)) },
      { id: 'select-and-mask', get label() { return uiT("ui.09f587d5b4af") }, shortcut: 'mod+alt+r', needsDocument: true, enabled: (doc) => selected(doc) || Boolean(doc.editingMask), run: onDoc(startSelectMask) },
      { id: 'feather', get label() { return uiT("ui.9bbb7333a5c2") }, shortcut: 'shift+f6', needsDocument: true, enabled: selected, run: () => $dialog.set({ kind: 'modify-selection', change: 'feather' }), dividerBefore: true },
      { id: 'expand', get label() { return uiT("ui.129be084ce16") }, needsDocument: true, enabled: selected, run: () => $dialog.set({ kind: 'modify-selection', change: 'expand' }) },
      { id: 'contract', get label() { return uiT("ui.9f480d06353d") }, needsDocument: true, enabled: selected, run: () => $dialog.set({ kind: 'modify-selection', change: 'contract' }) },
      { id: 'layer-pixels', get label() { return uiT("ui.fb17bd272097") }, needsDocument: true, enabled: (doc) => Boolean(doc.active?.pixels), run: onDoc((doc) => selectLayerPixels(doc)), dividerBefore: true },
      { id: 'layer-mask', get label() { return uiT("ui.e868a12ad9a6") }, needsDocument: true, enabled: (doc) => Boolean(doc.active?.mask), run: onDoc((doc) => selectLayerPixels(doc, doc.active, true)) }
    ]
  },
  {
    id: 'filter',
    get label() { return uiT("ui.638e249f4a15") },
    items: [
      {
        id: 'last-filter',
        label: () => {
          const spec = lastFilter()

          return spec ? uiT('canvas.notice.lastFilterName', { filter: uiT(FILTER_KEYS[spec.kind]) }) : uiT('canvas.menu.lastFilter')
        },
        shortcut: 'mod+alt+f',
        needsDocument: true,
        enabled: (doc) => Boolean(lastFilter()) && !cannotPaint(doc),
        run: onDoc((doc) => void repeatLastFilter(doc))
      },
      { id: 'filter-blur', get label() { return uiT("ui.cd83e6731d2b") }, needsDocument: true, run: nothing, submenu: [filterItem('gaussianBlur'), filterItem('motionBlur')], dividerBefore: true },
      { id: 'filter-noise', get label() { return uiT("ui.9ada8e83c118") }, needsDocument: true, run: nothing, submenu: [filterItem('addNoise'), filterItem('median'), filterItem('reduceNoise')] },
      { id: 'filter-sharpen', get label() { return uiT("ui.ac6f0be1274c") }, needsDocument: true, run: nothing, submenu: [filterItem('unsharpMask'), filterItem('smartSharpen')] },
      { id: 'filter-other', get label() { return uiT("ui.f97e9da0e3b8") }, needsDocument: true, run: nothing, submenu: [filterItem('highPass')] }
    ]
  },
  {
    id: 'view',
    get label() { return uiT("ui.dcc839a4015c") },
    items: [
      { id: 'zoom-in', get label() { return uiT("ui.5a982cf9dc11") }, shortcut: 'mod+=', needsDocument: true, run: onDoc((doc) => zoomStep(doc, 1)) },
      { id: 'zoom-out', get label() { return uiT("ui.24649ee0c7a9") }, shortcut: 'mod+-', needsDocument: true, run: onDoc((doc) => zoomStep(doc, -1)) },
      { id: 'fit', get label() { return uiT("ui.7694b431952a") }, shortcut: 'mod+0', needsDocument: true, run: onDoc((doc) => fitToScreen(doc)) },
      { id: 'actual', get label() { return uiT("ui.d1ff19e653b9") }, shortcut: 'mod+1', needsDocument: true, run: onDoc(actualPixels) },
      { id: 'rulers', get label() { return uiT("ui.347b3632e069") }, shortcut: 'mod+r', checked: () => $viewOptions.get().rulers, run: () => setViewOption('rulers', !$viewOptions.get().rulers), dividerBefore: true },
      { id: 'show-guides', get label() { return uiT("ui.572cd72feb9a") }, shortcut: 'mod+;', checked: () => $viewOptions.get().guides, run: () => setViewOption('guides', !$viewOptions.get().guides) },
      { id: 'lock-guides', get label() { return uiT("ui.3beb7832d7af") }, shortcut: 'mod+alt+;', checked: () => $viewOptions.get().lockGuides, run: () => setViewOption('lockGuides', !$viewOptions.get().lockGuides) },
      { id: 'new-guide', get label() { return uiT("ui.dc480dae0ece") }, needsDocument: true, run: () => $dialog.set({ kind: 'new-guide' }) },
      { id: 'clear-guides', get label() { return uiT("ui.24c559a4741b") }, needsDocument: true, enabled: (doc) => doc.state.guides.length > 0, run: onDoc((doc) => doc.commit('Clear Guides', { ...doc.state, guides: [] })) },
      { id: 'snap', get label() { return uiT("ui.98df9a59f064") }, shortcut: 'mod+shift+;', checked: () => $viewOptions.get().snap, run: () => setViewOption('snap', !$viewOptions.get().snap), dividerBefore: true },
      { id: 'snap-to', get label() { return uiT("ui.e7eef7e71c03") }, run: nothing, submenu: SNAP_ITEMS },
      { id: 'smart-guides', get label() { return uiT("ui.635e14edb752") }, checked: () => $viewOptions.get().smartGuides, run: () => setViewOption('smartGuides', !$viewOptions.get().smartGuides) }
    ]
  }
]

export const commandLabel = (command: CanvasCommand, doc: CanvasDocument | null): string => (typeof command.label === 'function' ? command.label(doc) : command.label)

export const isEnabled = (command: CanvasCommand, doc: CanvasDocument | null): boolean => (command.needsDocument ? Boolean(doc) && (command.enabled?.(doc!) ?? true) : true)

/** Run a command, putting a tool's open work in first; Undo with work open drops that work and stops there. */
export function runCommand(command: CanvasCommand, doc: CanvasDocument | null): void {
  if (command.id === 'undo' && hasOpenWork(doc)) {
    settleTools(doc, 'cancel')

    return
  }

  if (!command.inSession) {
    settleTools(doc)
  }

  command.run(doc)
}

export { keysLabel, matches }

/** Commands with the ones in their submenus. */
const everyCommand = (commands: readonly CanvasCommand[]): CanvasCommand[] => commands.flatMap((command) => [command, ...everyCommand(command.submenu ?? [])])

/** Run the command a key press is for; true when one ran. */
export function runShortcut(event: KeyboardEvent | ReactKeyboardEvent, doc: CanvasDocument | null): boolean {
  for (const menu of MENUS) {
    for (const command of everyCommand(menu.items)) {
      if ([command.shortcut, ...(command.also ?? [])].some((shortcut) => shortcut && matches(event, shortcut)) && isEnabled(command, doc)) {
        runCommand(command, doc)

        return true
      }
    }
  }

  return false
}

const ALIGN_MENU_KEYS = {
  "left": "canvas.alignmentMenu.left",
  "center": "canvas.alignmentMenu.center",
  "right": "canvas.alignmentMenu.right",
  "top": "canvas.alignmentMenu.top",
  "middle": "canvas.alignmentMenu.middle",
  "bottom": "canvas.alignmentMenu.bottom",
  "horizontal": "canvas.alignmentMenu.horizontal",
  "vertical": "canvas.alignmentMenu.vertical"
} as const
const FILTER_KEYS = {
  "gaussianBlur": "canvas.filter.gaussianBlur",
  "motionBlur": "canvas.filter.motionBlur",
  "highPass": "canvas.filter.highPass",
  "unsharpMask": "canvas.filter.unsharpMask",
  "smartSharpen": "canvas.filter.smartSharpen",
  "reduceNoise": "canvas.filter.reduceNoise",
  "addNoise": "canvas.filter.addNoise",
  "median": "canvas.filter.median"
} as const
