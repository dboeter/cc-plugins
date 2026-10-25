import {
  batMoon, band, blink, blinds, blinker, breathing, crest, flat, flowers, glint, grove, harbour, heat, hexDecode, mirrored, modem, orbit,
  overdrive, packet, signal, skyline, spin, splitFlap, sunlit, sunrise, tape, typewriter, waves, type Sprite, type Word,
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

// a bar of `n` cells that fills with heat, in `on` over `off`
const gauge = (t: Tick, n: number, on: string, off: string): Run[] => {
  const at = Math.round(n * heat(t))
  return merge([{ text: '▰'.repeat(at), color: on }, { text: '▱'.repeat(n - at), color: off }])
}

export const THEMES: Readonly<Record<string, Theme>> = {
  'retro-terminal': {
    muted: '#74b386',
    sprite: modem({ on: '#33ff66', off: '#1f4d2b', noise: '#74b386' }),
    word: overdrive(typewriter({ ink: '#33ff66', dim: '#74b386', glow: '#c2f5cc' }), ['#c2f5cc', '#ffff66']),
    words: [
      'DIALING UP AT 56K', 'Handshaking furiously', 'Spooling ALL the things', 'Seeking track 0', 'Rewinding the mainframe',
      'Defragmenting reality', 'Paging in the universe', 'Polling at maximum baud', 'POKEing memory', 'Bit-banging',
    ],
    suffix: '',
    clock: t => say(`[${mmss(t.elapsedMs)}]`, '#74b386'),
    // the C64's start-up line, losing 16 bytes a second
    tag: t => {
      const free = 38911 - 16 * Math.floor(t.elapsedMs / 1000)
      return free > 0 ? say(`${free} BYTES FREE`, heat(t) >= 1 ? '#ffff66' : '#74b386') : blink(t, say('?OUT OF MEMORY', '#ff5050', { bold: true }))
    },
    done: {
      ok: '#66ff99', err: '#ff5050',
      mark: { text: 'READY.', color: '#33ff66', bold: true },
      words: ['LOADED', 'Spooled to perfection', 'Dialed in', 'Compiled without a single warning', 'RUN complete'],
      aborted: ['BREAK IN 10'],
      error: ['?SYNTAX ERROR', '?LOAD ERROR'],
    },
  },

  'cyberpunk-neon': {
    muted: '#8f93bf',
    sprite: packet({ trace: '#0fa3b8', packet: '#ff2bd6', flash: '#d6fffa' }),
    word: overdrive(hexDecode({ done: '#ff2bd6', hex: '#05d9e8', glitch: '#fcee0a' }), ['#fcee0a', '#05d9e8', '#d6fffa']),
    words: [
      'JACKING IN', 'Breaching black ICE', 'Spoofing the megacorp', 'Overclocking the wetware', 'Netrunning at redline',
      'Decrypting the mainframe', 'Ghosting the daemons', 'Burning chrome',
    ],
    clock: t => say(`t+0x${Math.floor(t.elapsedMs / 1000).toString(16).padStart(2, '0')}`, '#8f93bf'),
    tag: t =>
      heat(t) < 1
        ? merge([{ text: 'TRACE ', color: '#8f93bf' }, ...gauge(t, 6, '#ff3860', '#3a3d5c')])
        : blink(t, say('!! TRACE COMPLETE !!', '#ff3860', { bold: true })),
    done: {
      ok: '#39ff88', err: '#ff3860',
      mark: mark('#ff2bd6'),
      words: ['JACKED OUT', 'Zeroed the ICE', 'Ghosted clean', 'Patched into the matrix', 'Flawless run'],
      aborted: ['Disconnected'],
      error: ['FLATLINED'],
    },
  },

  'space-gray': {
    muted: '#9aa0ab',
    sprite: orbit({ planet: '#3ddcff', path: '#9aa0ab', body: '#eceef3', moon: '#3ddcff', pulse: '#ff6eb3', star: '#ffe03d' }),
    word: overdrive(signal('#eceef3', '#9aa0ab'), ['#3ddcff', '#ff6eb3', '#ffe03d']),
    words: [
      'TRANSMITTING TO DEEP SPACE', 'Station-keeping', 'Slingshotting round Jupiter', 'Orbiting at escape velocity',
      'Clearing the ring plane', 'Main engine burn', 'Awaiting reply from Voyager', 'Engaging warp',
    ],
    clock: t => say(`T+${mmss(t.elapsedMs)}`, '#9aa0ab'),
    tag: t =>
      heat(t) < 1
        ? merge([{ text: 'ΔV ', color: '#9aa0ab' }, ...gauge(t, 6, '#3ddcff', '#34363c')])
        : blink(t, say('MASTER ALARM', '#ff4d5e', { bold: true })),
    done: {
      ok: '#3dff8b', err: '#ff4d5e',
      mark: mark('#ff6eb3'),
      words: ['Copy, go for code', 'Ring plane clear', 'Signal acquired', 'Splashdown', 'The Eagle has landed', 'Orbit achieved'],
      aborted: ['Scrubbed'],
      error: ['Signal lost', 'Houston, we have a problem'],
      line: (word, ms) => [{ text: `${word} · T+${mmss(ms)}` }],
    },
  },

  'tokyo-night': {
    muted: '#737aa2',
    sprite: skyline({
      heights: [1, 2, 1, 2, 2, 1, 2, 1, 2, 2, 1], mast: 3,
      wall: '#3b4261', lit: '#e0af68', antenna: '#f7768e', rain: mix('#7aa2f7', '#1a1b26', 0.5), bolt: '#c0caf5',
    }),
    word: overdrive(splitFlap({ landed: '#c0caf5', spinning: '#e0af68', flicker: '#7dcfff' }), ['#f7768e', '#bb9af7', '#7dcfff']),
    words: [
      'NEON OVERDRIVE', 'Drizzling on Shibuya', 'Glowing like Akihabara', 'Wiring the whole city', 'Night-driving the Shuto',
      'Rain-checking', 'Departing platform 9', 'Boarding the bullet train', 'Transferring at Shinjuku', 'Minding the gap',
    ],
    tag: t =>
      t.elapsedMs < 60000 ? say('ON TIME', '#9ece6a')
      : t.elapsedMs < 600000 ? say(`+${Math.floor(t.elapsedMs / 60000)} MIN`, '#ff9e64')
      : say('LAST TRAIN · BOARDING', '#e0af68', { bold: true }),
    done: {
      ok: '#9ece6a', err: '#f7768e',
      mark: mark('#7aa2f7'),
      words: ['Lit up the skyline', 'Wired', 'Shipped', 'Landed', 'Arrived to the second', 'Caught the last train'],
      aborted: ['Missed the train'],
      error: ['Service suspended'],
    },
  },

  dracula: {
    muted: '#6272a4',
    sprite: batMoon({ moon: '#bd93f9', shade: '#8a6ad1', bat: '#6272a4', cut: '#282a36', blood: '#ff5555' }),
    word: overdrive(band({ head: '#ff5555', near: '#ff79c6', base: '#6272a4' }), ['#ff5555', '#f1fa8c']),
    words: [
      'BROODING DARKLY', 'Haunting the halls', 'Conjuring the undead', 'Lurking in the crypt', 'Scheming eternally',
      'Unliving my best unlife', 'Entering freely and of my own will', 'Counting every grain', 'Coffin-napping', 'Turning to mist',
    ],
    clock: t => {
      const left = Math.max(0, 6 * 3600 + 12 * 60 - Math.floor(t.elapsedMs / 1000))
      if (left === 0) return say('sunrise', '#f1fa8c')
      return [
        { text: 'sunrise in ', color: '#6272a4' },
        { text: `${Math.floor(left / 3600)}h ${pad2(Math.floor(left / 60) % 60)}m ${pad2(left % 60)}s`, color: '#f1fa8c' },
      ]
    },
    tag: t => (heat(t) < 1 ? [] : blink(t, say('THE BLOOD MOON RISES', '#ff5555', { bold: true }))),
    done: {
      ok: '#50fa7b', err: '#ff5555',
      mark: mark('#bd93f9'),
      words: ['RISEN', 'Conjured from the void', 'Bitten', 'Vanquished', 'Immortal'],
      aborted: ['Fled at dawn'],
      error: ['Staked through the heart'],
    },
  },

  ayu: {
    muted: '#626a73',
    sprite: sunrise({ from: '#e6b450', to: '#ff8f40', water: '#39bae6', glint: '#fff3d6' }),
    word: overdrive(glint('#e6b450', '#ff8f40', '#fff3d6'), ['#fff3d6', '#f07178']),
    words: [
      'DAWNING GLORIOUSLY', 'Glinting', 'Warming the world', 'Kindling a new sun', 'Shining at full blaze', 'Ripening',
      'Rising and shipping', 'Catching first light', 'Going supernova',
    ],
    tag: t => {
      if (heat(t) >= 1) return blink(t, say('☼ HIGH NOON ☼', '#ff8f40', { bold: true }))
      const at = Math.min(8, Math.floor(t.elapsedMs / 30000))
      return merge([
        { text: '━'.repeat(at), color: '#e6b450' },
        { text: '●', color: '#ff8f40' },
        { text: '┄'.repeat(8 - at), color: '#626a73' },
      ])
    },
    done: {
      ok: '#aad94c', err: '#f07178',
      mark: mark('#e6b450'),
      words: ['DAWNED', 'Shone', 'Warmed', 'Lit', 'Risen and shipped', 'Blazed'],
      aborted: ['Clouded over'],
      error: ['Eclipsed'],
    },
  },

  gruvbox: {
    muted: '#928374',
    sprite: tape({ reel: '#ebdbb2', tape: '#a89984', button: '#fabd2f', vu: ['#b8bb26', '#fabd2f', '#fb4934'] }),
    word: overdrive(mirrored(['#fabd2f', '#fe8019', '#fb4934']), ['#ebdbb2', '#b8bb26']),
    words: [
      'BREWING A DOUBLE', 'Roasting the beans', 'Simmering', 'Toasting', 'Percolating', 'Kindling', 'Grooving',
      'Dropping the needle', 'Rewinding with a pencil', 'Cranking it to eleven',
    ],
    clock: t => {
      const s = Math.floor(t.elapsedMs / 1000)
      return say(`${Math.floor(s / 60)}:${pad2(s % 60)} · side ${s >= 45 * 60 ? 'B' : 'A'}`, '#928374')
    },
    tag: t => pixels([[0, 1, 2, 3].map(j => stripe(j, t)[0]), [0, 1, 2, 3].map(j => stripe(j, t)[1])]),
    done: {
      ok: '#b8bb26', err: '#fb4934',
      mark: mark('#fabd2f'),
      words: ['Brewed', 'Roasted', 'Toasted', 'Served', 'Side A done', 'Far out', 'Encore!'],
      aborted: ['Tape jammed'],
      error: ['Needle skipped'],
    },
  },

  kanagawa: {
    muted: '#727169',
    sprite: waves({ sea: '#7e9cd8', crest: '#7fb4ca', mountain: '#dcd7ba' }),
    word: overdrive(crest({ head: '#dcd7ba', rising: '#7fb4ca', foam: '#727169', sea: '#7e9cd8' }), ['#dcd7ba', '#e46876']),
    words: [
      'CRESTING THE GREAT WAVE', 'Inking', 'Brushing', 'Swelling', 'Breaking over the bow', 'Ebbing', 'Rowing for your life',
      'Bowing into the foam',
    ],
    tag: t =>
      t.elapsedMs < 20000 ? []
      : t.elapsedMs < 40000 ? say('great wave bares its claws', '#727169', { italic: true })
      : t.elapsedMs < 60000 ? say('oarsmen bow into the foam', '#727169', { italic: true })
      : say('fuji does not move', '#dcd7ba', { italic: true }),
    done: {
      ok: '#98bb6c', err: '#e46876',
      mark: mark('#7e9cd8'),
      words: ['Crested', 'Inked', 'Brushed', 'Broken', 'Rode the great wave'],
      aborted: ['Ebbed'],
      error: ['Capsized'],
    },
  },

  nord: {
    muted: '#7b88a1',
    sprite: harbour({ dark: '#4c566a', tower: '#bf616a', flake: '#d8dee9', flash: '#eceff4', night: '#2e3440', aurora: ['#a3be8c', '#88c0d0', '#b48ead', '#a3be8c'] }),
    word: overdrive(band({ head: '#eceff4', near: '#88c0d0', base: '#7b88a1' }, 2, 2), ['#a3be8c', '#b48ead']),
    words: [
      'BRAVING THE BLIZZARD', 'Frosting', 'Chilling to absolute zero', 'Thawing', 'Skiing the black run', 'Gliding',
      'Keeping watch', 'Trimming the wick', 'Sounding the horn',
    ],
    tag: t => {
      if (heat(t) >= 1) return blink(t, say('WHITEOUT', '#eceff4', { bold: true }))
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
      words: ['Frozen', 'Thawed', 'Charted', 'Crossed', 'Ship sighted', 'Safe harbour', 'Conquered the fjord'],
      aborted: ['Fog bound'],
      error: ['Ran aground'],
    },
  },

  'rose-pine': {
    muted: '#6e6a86',
    sprite: grove({ shade: '#191724', glow: '#ebbcba', pine: '#31748f', leaf: '#9ccfd8', petal: '#eb6f92' }),
    word: overdrive(breathing('#ebbcba', '#c4a7e7'), ['#eb6f92', '#f6c177']),
    words: [
      'BLOOMING MAGNIFICENTLY', 'Pruning', 'Steeping', 'Petaling', 'Wilting dramatically', 'Climbing', 'Pining', 'Lounging',
      'Swooning',
    ],
    suffix: '⁓',
    clock: t => (t.elapsedMs < 30000 ? [] : timer(t.elapsedMs, '#6e6a86')),
    tag: t => (heat(t) < 1 ? [] : blink(t, say('✿ FULL BLOOM ✿', '#eb6f92', { bold: true }))),
    done: {
      ok: '#9ccfd8', err: '#eb6f92',
      mark: mark('#c4a7e7'),
      words: ['Bloomed', 'Pruned', 'Steeped', 'Planted', 'Blossomed gloriously'],
      aborted: ['Wilted'],
      error: ['Frostbitten'],
    },
  },

  everforest: {
    muted: '#859289',
    sprite: flowers({ sprout: '#a7c080', bud: '#83c092', blooms: ['#d699b6', '#e67e80', '#dbbc7f'] }),
    word: overdrive(sunlit('#a7c080', '#dbbc7f', '#d3c6aa'), ['#e69875', '#d699b6']),
    words: [
      'FORAGING FEROCIOUSLY', 'Rooting', 'Sprouting', 'Hiking', 'Mossing', 'Branching', 'Switchbacking', 'Trailblazing',
      'Pitching camp', 'Summiting',
    ],
    tag: t => {
      if (t.elapsedMs >= 20 * 60000) return say('camp before dusk', '#e69875')
      const km = t.elapsedMs / 100000
      return say(`trail ${km.toFixed(1)} km · ↑ ${Math.round(km * 73.8)} m`, '#859289')
    },
    done: {
      ok: '#a7c080', err: '#e67e80',
      mark: mark('#a7c080'),
      words: ['Grown', 'Rooted', 'Foraged', 'Camped', 'Summited', 'Made camp', 'Conquered the peak'],
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
