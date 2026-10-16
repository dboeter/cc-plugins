import type { EngineInterface, Register } from 'claude-code'

const PANE = 'notepad'
const TITLE = 'Notepad'

// one note per project: keyed by the session's project root, which /cd moves but a shell `cd` does not
export const keyOf = (root: string) => `notes:${root}`
let typed: { root: string; text: string } | undefined
const isUp = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: 'notepad', description: 'Toggle a notepad pane for this project. Claude does not see it.' }) }
    catch (err) { $.ui.log(`notepad: /notepad not registered: ${(err as Error)?.message ?? err}`, { to: 'debug' }) } // throws on hot reload (no session bound yet)
    return next(e)
  })

  on('command.run', { command: 'notepad' }, async $ => {
    const up = await isUp($)
    if (up) await $.ui.close({ id: PANE })
    else await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: up ? 'notepad hidden' : 'notepad shown · click the note to edit it' }
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'editor') return next(e)
    const text = (e.data as { text?: unknown } | null)?.text
    if (typeof text === 'string') { const root = await $.session.root(); typed = { root, text }; await $.store.set(keyOf(root), text) }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const root = await $.session.root()
    // the text typed last wins over the store: a redraw landing before its save settles would otherwise put the field back
    const notes = typed?.root === root ? typed.text : String((await $.store.get(keyOf(root))) ?? '')
    const keep = (text: string) => { typed = { root, text }; void $.store.set(keyOf(root), text) }
    const rows = Math.max(3, e.props.scroll?.bodyRows ?? 20)
    if (e.surface === 'mobile') { // no Input or Client there: the note rendered, read-only
      const { Box, Text, Markdown } = $.ui.resolve(e)
      return <Box flexDirection="column">{notes ? <Markdown text={notes} /> : <Text dimColor>No notes for this project.</Text>}</Box>
    }
    if (e.surface === 'vscode') { // no Client there: the engine's own field, whose Enter only saves
      const { Box, Input } = $.ui.resolve(e)
      return <Box flexDirection="column"><Input key="notes" rows={rows - 1} autoFocus value={notes} placeholder="Markdown notes for this project" submitLabel="save" onInput={keep} onSubmit={keep} /></Box>
    }
    // our own editor (editor.tsx), which also draws the rendered note: the engine's multi-row Input draws its hint level
    // with its first row at its widest line, and keeps the cursor to itself. Each edit comes back as ui.message
    const { Box, Client } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Client key="editor" module="./editor.tsx" width="100%" height={rows} props={{ text: notes, root, columns: e.props.bodyColumns, rows }} />
      </Box>
    )
  })
}
