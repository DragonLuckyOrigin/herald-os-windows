import { t as uiT } from '../../../store/i18n.ts'
import type { EditorView } from '@tiptap/pm/view'
import { messageOf } from '../../canvas/errors.ts'
import type { OfficeCommand, OfficeMenu } from '../shell/commands.ts'
import * as act from './actions.ts'
import { $commentsShown, activeThread, commentsState, moveToThread, removeThread, resolveThread, startComment } from './comments.ts'
import { applyLive, comments, deleteAllComments, insertTableOfContents, tocAt, updateTablesOfContents } from './model.ts'
import { $reviewProvider } from './review-provider.ts'
import { $pages, activeEditor, docsSession } from './store.ts'

const activeKey = (): string | null => docsSession.$activeKey.get()

/** Whether the comments of the document in front show: as the person chose, or when it has some. */
function commentsShown(): boolean {
  const editor = activeEditor()
  const key = activeKey()

  return Boolean(editor && key && ($commentsShown.get()[key] ?? (comments(editor.state.doc).length > 0 || Boolean(commentsState(editor.state)?.draft))))
}

function newComment(): void {
  const editor = activeEditor()
  const key = activeKey()

  if (editor && key && !startComment(editor.view, key)) {
    docsSession.notify(uiT('docs.comments.selectText'))
  }
}

const hasOpenComments = (): boolean => Boolean(activeEditor() && comments(activeEditor()!.state.doc).some((thread) => !thread.resolved && thread.from !== null))
const hasActive = (): boolean => Boolean(activeThread(activeEditor()?.view) || (activeEditor() && commentsState(activeEditor()!.state)?.draft))
const hasToc = (): boolean => Boolean(activeEditor() && tocAt(activeEditor()!.state.doc, { index: 0 }) !== null)

/** A command on the editor of the document in front. */
const live = (run: (view: EditorView) => unknown) => () => {
  const editor = activeEditor()

  if (editor) {
    run(editor.view)
  }
}

/** The menu items for reviewing: what Insert offers for comments and contents, and the Review menu. */
export function reviewMenuItems(): { insert: OfficeCommand[]; menu: OfficeMenu | null } {
  const has = act.hasEditor
  const items: OfficeCommand[] = [
    { id: 'comment-new', label: uiT("ui.d244fabdef89"), shortcut: 'mod+alt+m', enabled: has, run: newComment },
    { id: 'comment-next', label: uiT("ui.9bbfde029e9d"), enabled: hasOpenComments, dividerBefore: true, run: live((view) => moveToThread(view, 1)) },
    { id: 'comment-previous', label: uiT("ui.b166c5cebce7"), enabled: hasOpenComments, run: live((view) => moveToThread(view, -1)) },
    {
      id: 'comment-resolve',
      label: uiT("ui.c106b3cb97f2"),
      enabled: () => Boolean(activeThread(activeEditor()?.view)),
      dividerBefore: true,
      run: live((view) => {
        const id = activeThread(view)

        if (id) {
          resolveThread(view, id)
        }
      })
    },
    { id: 'comment-delete', label: uiT("ui.534716e70e41"), enabled: hasActive, run: live((view) => removeThread(view, activeThread(view))) },
    { id: 'comment-delete-all', label: uiT("ui.f68601e5dc4c"), enabled: () => Boolean(activeEditor() && comments(activeEditor()!.state.doc).length), run: () => act.apply(deleteAllComments()) },
    {
      id: 'comment-show',
      label: uiT("ui.b92e93d523cd"),
      enabled: has,
      checked: commentsShown,
      dividerBefore: true,
      run: () => {
        const key = activeKey()

        if (key) {
          $commentsShown.setKey(key, !commentsShown())
        }
      }
    },
    {
      id: 'toc-update',
      label: uiT("ui.a0062ec43098"),
      enabled: hasToc,
      dividerBefore: true,
      run: live((view) => {
        if (!applyLive(view, updateTablesOfContents($pages.get()[activeKey() ?? '']?.headings))) {
          docsSession.notify(uiT('docs.toc.current'))
        }
      })
    }
  ]

  return {
    insert: [
      { id: 'toc', label: uiT("ui.a9360e0212a4"), enabled: has, dividerBefore: true, run: () => act.apply(insertTableOfContents()) },
      { id: 'comment', label: uiT("ui.44f5e3fbec57"), shortcut: 'mod+alt+m', enabled: has, run: newComment }
    ],
    menu: {
      id: 'review',
      label: uiT("ui.aff0766a5290"),
      // Read each time the menu opens, so an AI review offered later shows up.
      get items() {
        const provider = $reviewProvider.get()

        if (!provider) {
          return items
        }

        const review: OfficeCommand = {
          id: 'review-ai',
          label: provider.label,
          enabled: () => {
            const key = activeKey()

            return Boolean(key && has() && (provider.enabled?.(key) ?? true))
          },
          dividerBefore: true,
          run: () => {
            const key = activeKey()

            if (key) {
              Promise.resolve()
                .then(() => provider.run(key))
                .catch((error: unknown) => docsSession.notify(uiT('docs.review.failed', { provider: provider.label, error: messageOf(error) }), 'error'))
            }
          }
        }

        return [...items, review]
      }
    }
  }
}
