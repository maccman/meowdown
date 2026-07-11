import { Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { describe, expect, it } from 'vitest'

interface FlushableDOMObserver {
  forceFlush(): void
  flush(): void
}

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'text*',
      toDOM: () => ['p', 0] as const,
    },
    text: {},
  },
})

function createEditor(text: string): { mount: HTMLElement; view: EditorView } {
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])])
  const view = new EditorView(mount, {
    attributes: { style: 'white-space: pre-wrap' },
    state: EditorState.create({ doc }),
  })
  return { mount, view }
}

function getDOMObserver(view: EditorView): FlushableDOMObserver {
  const observer: unknown = Reflect.get(view, 'domObserver')
  if (typeof observer !== 'object' || observer === null) {
    throw new Error('expected ProseMirror to expose a domObserver')
  }
  const forceFlush: unknown = Reflect.get(observer, 'forceFlush')
  const flush: unknown = Reflect.get(observer, 'flush')
  if (typeof forceFlush !== 'function' || typeof flush !== 'function') {
    throw new TypeError('expected a flushable ProseMirror domObserver')
  }
  return observer as FlushableDOMObserver
}

/**
 * Independent evidence for the pending-input reconciliation: this mounts bare
 * ProseMirror, not Meowdown or ProseKit, and does not dispatch fixture events
 * or directly mutate the editor DOM. `execCommand('insertText')` enters the
 * browser engine's editing pipeline and emits a trusted `input` event.
 *
 * Headless automation cannot drive a real OS IME or emoji palette. This test
 * therefore proves the narrower premise needed by the fix: the WebKit CI lane
 * exhibits native editing followed by stale ProseMirror state in the same-turn
 * blur boundary. The ordering is not claimed to be Safari-exclusive.
 */
describe('browser-native input around blur in bare ProseMirror', () => {
  it('requires an explicit observer drain before synchronous serialization', () => {
    const before = 'Business ideas'
    const after = '🧠 Business ideas'
    const { mount, view } = createEditor(before)

    try {
      let inputWasTrusted = false
      view.dom.addEventListener(
        'input',
        (event) => {
          inputWasTrusted = event.isTrusted
        },
        { once: true },
      )

      view.focus()
      if (!document.execCommand('insertText', false, '🧠 ')) {
        throw new Error('the browser engine refused execCommand insertText')
      }
      view.dom.blur()

      // The contenteditable is current, but ProseMirror's blur handler parked
      // the pending MutationRecord behind a 20ms timer. A host serializing in
      // this synchronous turn still sees the previous document.
      expect(inputWasTrusted).toBe(true)
      expect(view.dom.textContent).toBe(after)
      expect(view.state.doc.textContent).toBe(before)

      const observer = getDOMObserver(view)
      observer.forceFlush()
      expect(view.state.doc.textContent).toBe(before)

      // forceFlush only drains flushSoon(); blur has a separate queue.
      observer.flush()
      expect(view.state.doc.textContent).toBe(after)
    } finally {
      view.destroy()
      mount.remove()
    }
  })
})
