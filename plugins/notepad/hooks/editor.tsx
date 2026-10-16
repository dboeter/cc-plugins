// The notepad's editor: a Client surface module, run on the drawing thread with no `$`. It owns the text and the cursor
// (which the engine's Input keeps to itself), so Enter puts a newline at the cursor, and draws no hint of its own. Each
// edit is posted to the hooks module, which saves it.
//
// It also draws the rendered view, because only a click on a Client gives it the keyboard: `focus: true`, the focus
// chord and `$.ui.focus` do not, the pane's `isFocused` stays false while it has the keys, and Escape (which takes them
// back) never reaches it. So a click on the rendered note opens the editor with the keys already in it, and a click on
// the Preview row goes back.
import type { ClientKeyEvent, ClientModule } from 'claude-code'

export type EditorProps = { text: string; root: string; columns: number; rows: number }
export type Editor = { text: string; cur: number; goal?: number }
type State = Editor & { root: string; top: number; editing: boolean }
export type Row = { start: number; len: number; final: boolean }

// Soft-wraps the text into rows of at most `cols - 1` characters, the last column kept for the cursor at a line's end.
// A row that is not its line's last is full, so the offset at its end is the next row's start.
export const layout = (text: string, cols: number): Row[] => {
  const w = Math.max(1, cols - 1)
  const rows: Row[] = []
  let off = 0
  for (const line of text.split('\n')) {
    for (let s = 0; ; s += w) {
      const final = line.length - s <= w
      rows.push({ start: off + s, len: final ? line.length - s : w, final })
      if (final) break
    }
    off += line.length + 1
  }
  return rows
}

export const rowOf = (rows: Row[], cur: number) =>
  Math.max(0, rows.findIndex(r => cur >= r.start && (cur < r.start + r.len || (r.final && cur === r.start + r.len))))

// the offset under a cell of a row, past its end landing on its last place
export const offsetAt = (rows: Row[], row: number, x: number) => {
  const r = rows[Math.min(rows.length - 1, Math.max(0, row))]!
  return r.start + Math.max(0, Math.min(x, r.final ? r.len : r.len - 1))
}

// the first row drawn: the one before, moved only as far as it takes to keep the cursor's row in view
export const topFor = (ed: Editor, top: number, cols: number, height: number) => {
  const at = rowOf(layout(ed.text, cols), ed.cur)
  return Math.min(Math.max(top, at - height + 1), at)
}

// the engine names special keys by word, `space` included; one it names that is not handled here is dropped, never typed
// (a typed word arrives as itself only in a paste or a burst of keys, which no name below is likely to be)
const NAMED = new Set(['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'backspace', 'delete', 'return',
  'enter', 'tab', 'escape', 'space', 'insert', 'clear', ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`)])
// one UTF-16 unit, or two when they make one character, so a step never splits an emoji
const stepBack = (t: string, i: number) => (i >= 2 && /[\uDC00-\uDFFF]/.test(t[i - 1]!) && /[\uD800-\uDBFF]/.test(t[i - 2]!) ? 2 : 1)
const stepFwd = (t: string, i: number) => (/[\uD800-\uDBFF]/.test(t[i] ?? '') && /[\uDC00-\uDFFF]/.test(t[i + 1] ?? '') ? 2 : 1)

// One key applied to the text and cursor; `page` is how many rows a page key moves. A key it does not handle returns
// the editor unchanged (the same object), so the caller can skip a redraw.
export const apply = (ed: Editor, k: ClientKeyEvent, cols: number, page: number): Editor => {
  const { text, cur } = ed
  const insert = (s: string): Editor => ({ text: text.slice(0, cur) + s + text.slice(cur), cur: cur + s.length })
  const vertical = (by: number): Editor => {
    const rows = layout(text, cols)
    const at = rowOf(rows, cur)
    const goal = ed.goal ?? cur - rows[at]!.start
    return { text, cur: offsetAt(rows, at + by, goal), goal }
  }
  const lineStart = text.lastIndexOf('\n', cur - 1) + 1
  const lineEnd = (n => (n < 0 ? text.length : n))(text.indexOf('\n', cur))
  if (k.ctrl && k.key === 'a') return { text, cur: lineStart }
  if (k.ctrl && k.key === 'e') return { text, cur: lineEnd }
  if (k.ctrl || k.meta) return ed
  switch (k.key) {
    case 'left': return { text, cur: Math.max(0, cur - stepBack(text, cur)) }
    case 'right': return { text, cur: Math.min(text.length, cur + stepFwd(text, cur)) }
    case 'up': return vertical(-1)
    case 'down': return vertical(1)
    case 'pageup': return vertical(-page)
    case 'pagedown': return vertical(page)
    case 'home': return { text, cur: lineStart }
    case 'end': return { text, cur: lineEnd }
    case 'return': case 'enter': return insert('\n')
    case 'space': return insert(' ')
    case 'tab': return insert('  ')
    case 'backspace': return cur === 0 ? ed : (n => ({ text: text.slice(0, cur - n) + text.slice(cur), cur: cur - n }))(stepBack(text, cur))
    case 'delete': return cur === text.length ? ed : { text: text.slice(0, cur) + text.slice(cur + stepFwd(text, cur)), cur }
  }
  if (NAMED.has(k.key) || k.key.length === 0) return ed
  // a typed character, or a paste in one piece: line ends made newlines, tabs spaces, other control characters dropped
  const typed = k.key.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
  return typed ? insert(typed) : ed
}

const NotepadEditor: ClientModule<EditorProps, State> = (props, surface) => {
  const { Box, Text, Markdown } = surface.elements
  const cols = Math.max(2, surface.columns || props.columns)
  const height = Math.max(1, (surface.rows || props.rows) - 1) // the editor's first row is the Preview row
  // a new project (a /cd while the pane is open) starts from its own note, rendered
  const fresh = (): State => ({ text: props.text, cur: props.text.length, root: props.root, top: 0, editing: false })
  const current = () => (surface.state?.root === props.root ? surface.state : fresh())
  const st = current()
  surface.onKey(k => {
    const now = current()
    if (!now.editing) return
    const next = apply(now, k, cols, height - 1)
    if (next === now) return
    if (next.text !== now.text) surface.post({ text: next.text })
    surface.setState({ ...now, ...next, goal: next.goal, top: topFor(next, now.top, cols, height) })
  })
  surface.onPointer(p => {
    if (p.type !== 'down' || p.button !== 'left') return
    const now = current()
    if (!now.editing) return surface.setState({ ...now, editing: true, goal: undefined }) // the click gave it the keys
    if (p.y === 0) return surface.setState({ ...now, editing: false })
    const cur = offsetAt(layout(now.text, cols), now.top + p.y - 1, p.x)
    surface.setState({ ...now, cur, goal: undefined })
  })
  if (!st.editing) return (
    <Box flexDirection="column">
      {st.text ? <Markdown text={st.text} /> : <Text dimColor>No notes for this project. Click here to write.</Text>}
    </Box>
  )
  const rows = layout(st.text, cols)
  const at = rowOf(rows, st.cur)
  const top = topFor(st, st.top, cols, height) // again here, as a resize moves rows without a key
  return (
    <Box flexDirection="column">
      <Text dimColor>[ Preview ]  markdown · click to place the cursor · Esc leaves</Text>
      {rows.slice(top, top + height).map((r, i) => {
        const line = st.text.slice(r.start, r.start + r.len)
        if (top + i !== at) return <Text>{line || ' '}</Text>
        const x = st.cur - r.start
        const n = stepFwd(line, x)
        return <Text>{line.slice(0, x)}<Text inverse>{line.slice(x, x + n) || ' '}</Text>{line.slice(x + n)}</Text>
      })}
    </Box>
  )
}
export default NotepadEditor
