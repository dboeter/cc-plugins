import {
  batMoon, band, blinds, blinker, breathing, crest, flat, flowers, glint, grove, harbour, hexDecode, mirrored, modem, orbit, packet,
  signal, skyline, spin, splitFlap, sunlit, sunrise, tape, typewriter, waves, type Sprite, type Word,
} from './effects'
import { cycle, mix, mmss, merge, pad2, pixels, rand, timer, type Run, type Tick } from './runs'

export type Done = {
  mark: Run
  ok: string // +added
  err: string // −removed
  words: readonly string[]
  aborted: readonly string[]
  error: readonly string[] // for 'error' and 'refusal'
  line?: (word: string, durationMs: number) => Run[]
}

export type Theme = {
  muted: string // suffix and default clock
  sprite: Sprite // the same width on every frame and in every mode
  word: Word // the same width on every frame, for a given word
  words: readonly string[] // spinner words: the skin's own, then the extras
  suffix?: string // default: the Spinner's props.suffix
  clock?: (t: Tick) => Run[] // default: formatDuration(elapsedMs) in muted; [] hides it
  tag?: (t: Tick) => Run[] // drawn after the clock
  done?: Done // absent: the footer stays skins'
}

const say = (text: string, color: string, style: Partial<Run> = {}): Run[] => [{ text, color, ...style }]
const mark = (color: string): Run => ({ text: '◆', color })

// A skin without a banner: the band in the skin's own colours.
const plain = (c: { user: string; fg: string; muted: string }, sprite: Sprite, words: readonly string[]): Theme => ({
  muted: c.muted,
  sprite,
  word: band({ head: c.fg, near: c.user, base: c.muted }),
  words,
})

const GRAPH = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353']
const STRIPES = [['#fabd2f', '#fe8019'], ['#fb4934', '#d3869b'], ['#83a598', '#8ec07c']] as const
const stripe = (j: number, t: Tick) => cycle(STRIPES, j + Math.floor(t.frame / 3))

export const THEMES: Readonly<Record<string, Theme>> = {
  'retro-terminal': {
    muted: '#74b386',
    sprite: modem({ on: '#33ff66', off: '#1f4d2b' }),
    word: typewriter({ ink: '#33ff66', dim: '#74b386', glow: '#c2f5cc' }),
    words: ['Dialing up', 'Handshaking', 'Spooling', 'Seeking track 0', 'Rewinding tape', 'Defragmenting', 'Paging in', 'Polling'],
    suffix: '',
    clock: t => say(`[${mmss(t.elapsedMs)}]`, '#74b386'),
    // the C64's start-up line, losing 16 bytes a second
    tag: t => {
      const free = 38911 - 16 * Math.floor(t.elapsedMs / 1000)
      return free > 0 ? say(`${free} BYTES FREE`, '#74b386') : say('?OUT OF MEMORY', '#ff5050')
    },
    done: { ok: '#66ff99', err: '#ff5050', mark: { text: 'READY.', color: '#33ff66' }, words: ['Loaded', 'Spooled', 'Dialed in', 'Compiled'], aborted: ['BREAK'], error: ['?SYNTAX ERROR'] },
  },

  'cyberpunk-neon': {
    muted: '#8f93bf',
    sprite: packet({ trace: '#0fa3b8', packet: '#ff2bd6', flash: '#d6fffa' }),
    word: hexDecode({ done: '#ff2bd6', hex: '#05d9e8', glitch: '#fcee0a' }),
    words: ['Jacking in', 'Breaching ICE', 'Spoofing', 'Overclocking', 'Netrunning', 'Decrypting', 'Ghosting'],
    clock: t => say(`t+0x${Math.floor(t.elapsedMs / 1000).toString(16).padStart(2, '0')}`, '#8f93bf'),
    done: { ok: '#39ff88', err: '#ff3860', mark: mark('#ff2bd6'), words: ['Jacked out', 'Zeroed', 'Ghosted', 'Patched'], aborted: ['Disconnected'], error: ['Flatlined'] },
  },

  'space-gray': {
    muted: '#9aa0ab',
    sprite: orbit({ planet: '#3ddcff', path: '#9aa0ab', body: '#eceef3', moon: '#3ddcff', pulse: '#ff6eb3' }),
    word: signal('#eceef3', '#9aa0ab'),
    words: ['Transmitting', 'Station-keeping', 'Slingshotting', 'Orbiting', 'Clearing the ring plane', 'Burning', 'Awaiting reply'],
    clock: t => say(`T+${mmss(t.elapsedMs)}`, '#9aa0ab'),
    done: {
      ok: '#3dff8b', err: '#ff4d5e',
      mark: mark('#ff6eb3'),
      words: ['Copy, go for code', 'Ring plane clear', 'Signal acquired', 'Splashdown'],
      aborted: ['Scrubbed'],
      error: ['Signal lost'],
      line: (word, ms) => [{ text: `${word} · T+${mmss(ms)}` }],
    },
  },

  'tokyo-night': {
    muted: '#737aa2',
    sprite: skyline({ heights: [1, 2, 1, 2, 2, 1], mast: 3, wall: '#3b4261', lit: '#e0af68', antenna: '#f7768e', rain: mix('#7aa2f7', '#1a1b26', 0.5) }),
    word: splitFlap({ landed: '#c0caf5', spinning: '#e0af68', flicker: '#7dcfff' }),
    words: ['Neon-ing', 'Drizzling', 'Glowing', 'Wiring', 'Night-driving', 'Rain-checking', 'Departing', 'Boarding', 'Transferring', 'Minding the gap'],
    tag: t =>
      t.elapsedMs < 60000 ? say('ON TIME', '#9ece6a')
      : t.elapsedMs < 600000 ? say(`+${Math.floor(t.elapsedMs / 60000)} MIN`, '#ff9e64')
      : say('LAST TRAIN · BOARDING', '#e0af68', { bold: true }),
    done: {
      ok: '#9ece6a', err: '#f7768e',
      mark: mark('#7aa2f7'),
      words: ['Lit up', 'Wired', 'Shipped', 'Landed', 'Arrived', 'Caught the last train'],
      aborted: ['Missed the train'],
      error: ['Service suspended'],
    },
  },

  dracula: {
    muted: '#6272a4',
    sprite: batMoon({ moon: '#bd93f9', shade: '#8a6ad1', bat: '#6272a4', cut: '#282a36' }),
    word: band({ head: '#ff5555', near: '#ff79c6', base: '#6272a4' }),
    words: ['Brooding', 'Haunting', 'Conjuring', 'Lurking', 'Scheming', 'Unliving', 'Entering freely', 'Counting', 'Coffin-napping', 'Turning to mist'],
    clock: t => {
      const left = Math.max(0, 6 * 3600 + 12 * 60 - Math.floor(t.elapsedMs / 1000))
      if (left === 0) return say('sunrise', '#f1fa8c')
      return [
        { text: 'sunrise in ', color: '#6272a4' },
        { text: `${Math.floor(left / 3600)}h ${pad2(Math.floor(left / 60) % 60)}m ${pad2(left % 60)}s`, color: '#f1fa8c' },
      ]
    },
    done: { ok: '#50fa7b', err: '#ff5555', mark: mark('#bd93f9'), words: ['Risen', 'Conjured', 'Bitten', 'Vanquished'], aborted: ['Fled at dawn'], error: ['Staked'] },
  },

  ayu: {
    muted: '#626a73',
    sprite: sunrise({ from: '#e6b450', to: '#ff8f40', water: '#39bae6' }),
    word: glint('#e6b450', '#ff8f40', '#fff3d6'),
    words: ['Dawning', 'Glinting', 'Warming', 'Kindling', 'Shining', 'Ripening', 'Rising and shipping', 'Catching first light'],
    tag: t => {
      const at = Math.min(8, Math.floor(t.elapsedMs / 30000))
      return merge([
        { text: '━'.repeat(at), color: '#e6b450' },
        { text: '●', color: '#ff8f40' },
        { text: '┄'.repeat(8 - at), color: '#626a73' },
      ])
    },
    done: { ok: '#aad94c', err: '#f07178', mark: mark('#e6b450'), words: ['Dawned', 'Shone', 'Warmed', 'Lit', 'Risen and shipped'], aborted: ['Clouded over'], error: ['Eclipsed'] },
  },

  gruvbox: {
    muted: '#928374',
    sprite: tape({ reel: '#ebdbb2', button: '#fabd2f' }),
    word: mirrored(['#fabd2f', '#fe8019', '#fb4934']),
    words: ['Brewing', 'Roasting', 'Simmering', 'Toasting', 'Percolating', 'Kindling', 'Grooving', 'Dropping the needle', 'Rewinding with a pencil'],
    clock: t => {
      const s = Math.floor(t.elapsedMs / 1000)
      return say(`${Math.floor(s / 60)}:${pad2(s % 60)} · side ${s >= 45 * 60 ? 'B' : 'A'}`, '#928374')
    },
    tag: t => pixels([[0, 1, 2, 3].map(j => stripe(j, t)[0]), [0, 1, 2, 3].map(j => stripe(j, t)[1])]),
    done: {
      ok: '#b8bb26', err: '#fb4934',
      mark: mark('#fabd2f'),
      words: ['Brewed', 'Roasted', 'Toasted', 'Served', 'Side A done', 'Far out'],
      aborted: ['Tape jammed'],
      error: ['Needle skipped'],
    },
  },

  kanagawa: {
    muted: '#727169',
    sprite: waves({ sea: '#7e9cd8', crest: '#7fb4ca', mountain: '#dcd7ba' }),
    word: crest({ head: '#dcd7ba', rising: '#7fb4ca', foam: '#727169', sea: '#7e9cd8' }),
    words: ['Cresting', 'Inking', 'Brushing', 'Swelling', 'Breaking', 'Ebbing', 'Rowing', 'Bowing into the foam'],
    tag: t =>
      t.elapsedMs < 20000 ? []
      : t.elapsedMs < 40000 ? say('great wave bares its claws', '#727169', { italic: true })
      : t.elapsedMs < 60000 ? say('oarsmen bow into the foam', '#727169', { italic: true })
      : say('fuji does not move', '#dcd7ba', { italic: true }),
    done: { ok: '#98bb6c', err: '#e46876', mark: mark('#7e9cd8'), words: ['Crested', 'Inked', 'Brushed', 'Broken'], aborted: ['Ebbed'], error: ['Capsized'] },
  },

  nord: {
    muted: '#7b88a1',
    sprite: harbour({ dark: '#4c566a', tower: '#bf616a', flake: '#d8dee9', flash: '#eceff4' }),
    word: band({ head: '#eceff4', near: '#88c0d0', base: '#7b88a1' }, 2, 2),
    words: ['Drifting', 'Frosting', 'Chilling', 'Thawing', 'Skiing', 'Gliding', 'Keeping watch', 'Trimming the wick', 'Sounding the horn'],
    tag: t => {
      const ship = Math.max(0, 5 - Math.floor(t.elapsedMs / 15000))
      return merge([
        { text: '─'.repeat(ship), color: '#3b4252' },
        { text: '•', color: '#ebcb8b' },
        { text: '─'.repeat(5 - ship), color: '#3b4252' },
      ])
    },
    done: {
      ok: '#a3be8c', err: '#bf616a',
      mark: mark('#88c0d0'),
      words: ['Frozen', 'Thawed', 'Charted', 'Crossed', 'Ship sighted', 'Safe harbour'],
      aborted: ['Fog bound'],
      error: ['Ran aground'],
    },
  },

  'rose-pine': {
    muted: '#6e6a86',
    sprite: grove({ shade: '#191724', glow: '#ebbcba', pine: '#31748f', leaf: '#9ccfd8' }),
    word: breathing('#ebbcba', '#c4a7e7'),
    words: ['Blooming', 'Pruning', 'Steeping', 'Petaling', 'Wilting', 'Climbing', 'Pining', 'Lounging'],
    suffix: '⁓',
    clock: t => (t.elapsedMs < 30000 ? [] : timer(t.elapsedMs, '#6e6a86')),
    done: { ok: '#9ccfd8', err: '#eb6f92', mark: mark('#c4a7e7'), words: ['Bloomed', 'Pruned', 'Steeped', 'Planted'], aborted: ['Wilted'], error: ['Frostbitten'] },
  },

  everforest: {
    muted: '#859289',
    sprite: flowers({ sprout: '#a7c080', bud: '#83c092', blooms: ['#d699b6', '#e67e80', '#dbbc7f'] }),
    word: sunlit('#a7c080', '#dbbc7f', '#d3c6aa'),
    words: ['Foraging', 'Rooting', 'Sprouting', 'Hiking', 'Mossing', 'Branching', 'Switchbacking', 'Trailblazing', 'Pitching camp'],
    tag: t => {
      if (t.elapsedMs >= 20 * 60000) return say('camp before dusk', '#e69875')
      const km = t.elapsedMs / 100000
      return say(`trail ${km.toFixed(1)} km · ↑ ${Math.round(km * 73.8)} m`, '#859289')
    },
    done: {
      ok: '#a7c080', err: '#e67e80',
      mark: mark('#a7c080'),
      words: ['Grown', 'Rooted', 'Foraged', 'Camped', 'Summited', 'Made camp'],
      aborted: ['Turned back'],
      error: ['Lost the trail'],
    },
  },

  catppuccin: plain(
    { user: '#cba6f7', fg: '#cdd6f4', muted: '#7f849c' },
    blinker([{ text: '=^.^=', color: '#cba6f7' }], [{ text: '=^-^=', color: '#cba6f7' }]),
    ['Purring', 'Napping', 'Pouncing', 'Kneading', 'Stretching', 'Nuzzling'],
  ),

  'night-owl': plain(
    { user: '#82aaff', fg: '#d6deeb', muted: '#637777' },
    blinker(
      [{ text: '(o', color: '#82aaff' }, { text: ',', color: '#ecc48d' }, { text: 'o)', color: '#82aaff' }],
      [{ text: '(-', color: '#82aaff' }, { text: ',', color: '#ecc48d' }, { text: '-)', color: '#82aaff' }],
    ),
    ['Hooting', 'Perching', 'Swooping', 'Watching', 'Prowling', 'Gliding'],
  ),

  github: plain(
    { user: '#58a6ff', fg: '#e6edf3', muted: '#7d8590' },
    t =>
      merge(
        [0, 1, 2, 3, 4].map((x): Run => ({
          text: '■',
          color: cycle(GRAPH, Math.floor(rand(t.seed, Math.floor(t.frame / 6) + x) * GRAPH.length)),
        })),
      ),
    ['Committing', 'Rebasing', 'Forking', 'Pushing', 'Cherry-picking', 'Stashing'],
  ),

  solarized: plain(
    { user: '#268bd2', fg: '#93a1a1', muted: '#586e75' },
    spin('○◔◑◕●◕◑◔', '#b58900', 2),
    ['Orbiting', 'Basking', 'Flaring', 'Eclipsing', 'Rising', 'Setting'],
  ),

  'one-dark': plain(
    { user: '#61afef', fg: '#abb2bf', muted: '#5c6370' },
    t => {
      const filled = Math.min(5, Math.floor(t.frame / 3) % 7)
      return merge([
        { text: '[', color: '#5c6370' },
        { text: '■'.repeat(filled), color: '#98c379' },
        { text: '□'.repeat(5 - filled), color: '#3e4451' },
        { text: ']', color: '#5c6370' },
      ])
    },
    ['Compiling', 'Linting', 'Atomizing', 'Bundling', 'Indexing', 'Parsing'],
  ),

  noir: {
    ...plain(
      { user: '#f5f5f5', fg: '#ededed', muted: '#8c8c8c' },
      t => {
        const glow = cycle([0, 1, 2, 3, 2, 1], Math.floor(t.frame / 2))
        return [{ text: cycle([...'·∙•●•∙'], Math.floor(t.frame / 2)), color: mix('#8c8c8c', '#f5f5f5', glow / 3) }]
      },
      ['Thinking', 'Working', 'Composing', 'Considering', 'Weighing'],
    ),
    word: blinds('#ededed', '#8c8c8c'),
  },

  mono: {
    ...plain(
      { user: '#e0e0e0', fg: '#e0e0e0', muted: '#7a7a7a' },
      spin('|/-\\', '#e0e0e0'),
      ['Working', 'Thinking', 'Reading', 'Writing', 'Checking'],
    ),
    word: flat('#e0e0e0'),
  },
}
