#!/usr/bin/env python3
"""Builds the boot banners that the `claude` wrapper in ~/.bashrc prints, one per skins-mod skin.

Writes <skin>.txt and <skin>@2x.txt next to this script with 24-bit colour escapes baked in, so the
wrapper only has to `cat` the file for the active skin (it picks @2x on terminals of 120+ columns).
Every builder takes a scale s. At 2x, shapes defined by maths are resampled at the higher
resolution (real detail), hand-drawn grids go through Scale2x, and pixel patterns (stars, windows,
rain) are redrawn in hi-res pixel coordinates. The s=1 output must not change when you edit the 2x
path. Edit the art or colours here and rerun. A colour is '#rrggbb', or an int n for the terminal's
own colour n (the terminal skin's, which has no hex palette).
"""

import math
from pathlib import Path

OUT = Path(__file__).resolve().parent
RESET = "\033[0m"
SCALES = (1, 2)


def rgb(h):
    return tuple(int(h[i : i + 2], 16) for i in (1, 3, 5))


def fg(h):
    if isinstance(h, int):
        return f"\033[38;5;{h}m"
    r, g, b = rgb(h)
    return f"\033[38;2;{r};{g};{b}m"


def bg(h):
    if isinstance(h, int):
        return f"\033[48;5;{h}m"
    r, g, b = rgb(h)
    return f"\033[48;2;{r};{g};{b}m"


def mix(a, b, t):
    t = min(
        1.0, max(0.0, t)
    )  # 2x sampling can land just outside [0, 1] at canvas edges
    return "#" + "".join(
        f"{round(x + (y - x) * t):02x}" for x, y in zip(rgb(a), rgb(b))
    )


def scale(h, f):
    return "#" + "".join(f"{min(255, round(c * f)):02x}" for c in rgb(h))


def gradient(text, a, b):
    n = max(len(text) - 1, 1)
    return "".join(fg(mix(a, b, i / n)) + ch for i, ch in enumerate(text)) + RESET


def logical(v, s):
    """Hi-res pixel index -> 1x coordinate, pixel centres aligned (exactly v at s=1)."""
    return (v + 0.5) / s - 0.5


def scale2x(grid):
    """EPX/Scale2x: double a char grid, rounding off diagonal staircases instead of blocking them."""
    h, w = len(grid), len(grid[0])

    def at(y, x, p):
        return grid[y][x] if 0 <= y < h and 0 <= x < w else p

    out = []
    for y in range(h):
        top = bot = ""
        for x in range(w):
            p = grid[y][x]
            a, b, c, d = (
                at(y - 1, x, p),
                at(y, x + 1, p),
                at(y, x - 1, p),
                at(y + 1, x, p),
            )
            top += (a if c == a != d and a != b else p) + (
                b if a == b != c and b != d else p
            )
            bot += (c if d == c != b and c != a else p) + (
                d if b == d != a and d != c else p
            )
        out += [top, bot]
    return out


# --- retro-terminal: green phosphor CLAUDE (figlet "ANSI Shadow" glyphs) --------------------

GLYPHS = {
    "C": [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
    "L": ["██╗     ", "██║     ", "██║     ", "██║     ", "███████╗", "╚══════╝"],
    "A": [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
    "U": ["██╗   ██╗", "██║   ██║", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
    "D": ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
    "E": ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
}
WORD = ["".join(GLYPHS[c][row] for c in "CLAUDE") for row in range(6)]
# A text cell is 1x2 half-block pixels, so doubling it on screen takes 2x4 pixels.
WORD_W, WORD_H = 2 * len(WORD[0]), 4 * len(WORD)


def word_pixel(y, x):
    """2x wordmark pixel: 'solid', 'shadow' or None. Box-drawing shadows don't scale, so the
    shadow becomes a 1-px drop shadow down-right of the solid mask."""

    def solid(y, x):
        return 0 <= y < WORD_H and 0 <= x < WORD_W and WORD[y // 4][x // 2] == "█"

    if solid(y, x):
        return "solid"
    return "shadow" if solid(y - 1, x - 1) else None


def retro_terminal(s=1):
    phosphor, glow, muted = "#33ff66", "#1f8a45", "#74b386"
    lines = [""]
    if s == 1:
        for row in range(6):
            # Odd rows a touch dimmer: reads as CRT scanlines.
            f = 1.0 if row % 2 == 0 else 0.8
            out = "  "
            for ch in WORD[row]:
                out += (
                    ch
                    if ch == " "
                    else fg(scale(phosphor if ch == "█" else glow, f)) + ch
                )
            lines.append(out + RESET)
    else:

        def color(y, x):
            # Dimming every other pixel row: real scanlines at this size.
            kind = word_pixel(y, x)
            if kind is None:
                return None
            return scale(phosphor if kind == "solid" else glow, 0.8 if y % 2 else 1.0)

        lines += ["  " + row for row in pixel_rows(WORD_H, WORD_W, color)]
    lines += [
        "",
        "  " + fg(muted) + "CLAUDE CODE  ·  PHOSPHOR/OS 2.1  ·  640K RAM OK" + RESET,
        "  " + fg(phosphor) + "READY." + RESET,
        "  " + fg(phosphor) + "█" + RESET,
        "",
    ]
    return "\n".join(lines) + "\n"


# --- cyberpunk-neon: pixel skull, neon outline, glowing eyes, circuit traces --------------
# Two pixel rows per text row (half blocks), so pixels are square.
# '#' bone  'E' eye glow  'e' eye core  'c' circuit trace  'o' circuit node  '.' empty

SKULL = [
    "..........#####o####..........",
    ".......########c#######.......",
    ".....##########c#########.....",
    "....######cccccc##########....",
    "...#######c####c###########...",
    "..########c####ccccc########..",
    "..########c########c########..",
    ".#########c########c#########.",
    ".#########o########o#########.",
    ".############################.",
    ".############################.",
    ".######....########....######.",
    ".#####......######......#####.",
    ".####...EE...####...EE...####.",
    ".####..EeeE..####..EeeE..####.",
    ".####..EeeE..####..EeeE..####.",
    ".#####..EE..######..EE..#####.",
    ".######....########....######.",
    ".#############..#############.",
    "..###########....###########..",
    "..##########......##########..",
    "...#########..##..#########...",
    "...########################...",
    "....######################....",
    ".....##.##.##.##.##.##.##.....",
    ".....##.##.##.##.##.##.##.....",
    ".....##.##.##.##.##.##.##.....",
    ".....####################.....",
    "......##################......",
    "........##############........",
]


def skull_grid(s):
    """SKULL at scale s. At 2x the silhouette and eyes go through Scale2x; circuit traces are then
    redrawn 1 px wide (top row of horizontal runs, left column of vertical runs, so runs and
    corners still join) instead of doubling, and nodes stay 2x2 pads."""
    if s == 1:
        return SKULL
    out = [
        list(r) for r in scale2x([r.replace("c", "#").replace("o", "#") for r in SKULL])
    ]
    h, w = len(SKULL), len(SKULL[0])

    def trace(y, x):
        return 0 <= y < h and 0 <= x < w and SKULL[y][x] in "co"

    for y, row in enumerate(SKULL):
        for x, ch in enumerate(row):
            if ch not in "co":
                continue
            across = trace(y, x - 1) or trace(y, x + 1)
            down = trace(y - 1, x) or trace(y + 1, x)
            for dy in (0, 1):
                for dx in (0, 1):
                    keep = (
                        ch == "o"
                        or (dy == 0 and across)
                        or (dx == 0 and down)
                        or dy == dx == 0
                    )
                    out[2 * y + dy][2 * x + dx] = ch if keep else "#"
    return ["".join(r) for r in out]


def skull_pixel(grid, y, x):
    h, w = len(grid), len(grid[0])
    ch = grid[y][x]
    if ch == ".":
        return None
    if ch in "Eeco":
        return {"E": "#05d9e8", "e": "#c8fdff", "c": "#0fa3b8", "o": "#d6fffa"}[ch]
    t = y / (h - 1)
    edge = any(
        not (0 <= y + dy < h and 0 <= x + dx < w) or grid[y + dy][x + dx] == "."
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1))
    )
    # Bright outline over a dark fill reads as a neon tube.
    return mix("#ff2bd6", "#9d4dff", t) if edge else mix("#4a1446", "#24124a", t)


def pixel_rows(h, w, color):
    """Render color(y, x) -> hex | None as half-block text rows; h must be even."""
    rows = []
    for y in range(0, h, 2):
        out = ""
        for x in range(w):
            top, bot = color(y, x), color(y + 1, x)
            if top is None and bot is None:
                out += " "
            elif bot is None:
                out += fg(top) + "▀" + RESET
            elif top is None:
                out += fg(bot) + "▄" + RESET
            else:
                out += fg(top) + bg(bot) + "▀" + RESET
        rows.append(out)
    return rows


def hr(c):
    """The 26-column rule that frames side panels."""
    return fg(c) + "━" * 26 + RESET


def heading(title, a, b, rule, sub=None):
    """Side-panel opening: bold gradient title, optional subtitle line, rule."""
    return ["\033[1m" + gradient(title, a, b), *([sub] if sub else []), hr(rule)]


def with_panel(rows, panel):
    """Art rows on the left, panel lines vertically centred beside them."""
    start = (len(rows) - len(panel)) // 2
    lines = [""]
    for i, row in enumerate(rows):
        side = panel[i - start] if 0 <= i - start < len(panel) else ""
        lines.append("  " + row + ("    " + side if side else ""))
    return "\n".join(lines + [""]) + "\n"


def cyberpunk_neon(s=1):
    rule = "#3a2f5a"
    # xxd-style dump, four bytes a row: offset, hex bytes, then the same bytes as text.
    msg = b"jack in now."
    dump = [
        fg("#4a4470")
        + f"{i:04x}  "
        + fg("#8f93bf")
        + " ".join(f"{c:02x}" for c in msg[i : i + 4])
        + "  \033[1m"
        + fg("#ff2bd6")
        + msg[i : i + 4].decode()
        + RESET
        for i in range(0, len(msg), 4)
    ]
    panel = [
        *heading("C L A U D E  ·  C O D E", "#ff2bd6", "#05d9e8", rule),
        *dump,
        hr(rule),
    ]
    grid = skull_grid(s)
    rows = pixel_rows(len(grid), len(grid[0]), lambda y, x: skull_pixel(grid, y, x))
    return with_panel(rows, panel)


def grid_color(grid, colors):
    """color(y, x) for a char grid: '.' is empty, other chars map through colors."""
    return lambda y, x: None if grid[y][x] == "." else colors[grid[y][x]]


# --- space-gray: ringed planet in a starfield --------------------------------------------


def space_gray(s=1):
    W, H, cx, cy, r = 38, 20, 18.5, 9.5, 7.0
    tilt = 0.25
    light = (-0.55, -0.6, 0.58)
    ln = math.sqrt(sum(c * c for c in light))
    stars = {
        (0, 22),
        (1, 3),
        (2, 31),
        (4, 8),
        (6, 36),
        (12, 37),
        (14, 1),
        (17, 25),
        (18, 12),
        (19, 33),
    }
    # Faint stars only the 2x canvas has room for, in hi-res pixel coords.
    faint = (
        {(1, 58), (3, 13), (9, 70), (16, 7), (25, 4), (31, 55), (35, 19), (38, 66)}
        if s > 1
        else set()
    )

    def color(y, x):
        dx, dy = logical(x, s) - cx, logical(y, s) - cy
        u = dx * math.cos(tilt) + dy * math.sin(tilt)
        v = -dx * math.sin(tilt) + dy * math.cos(tilt)
        e = (u / 16) ** 2 + (v / 4.2) ** 2
        ring = 0.62 <= e <= 1.0
        ring_c = mix("#eceef3", "#9aa0ab", (e - 0.62) / 0.38)
        if dx * dx + dy * dy <= r * r:
            # Ring passes in front of the planet on its lower (near) side only.
            if ring and v > 0:
                return ring_c
            nz = math.sqrt(max(0.0, 1 - (dx * dx + dy * dy) / (r * r)))
            lit = (dx / r * light[0] + dy / r * light[1] + nz * light[2]) / ln
            band = 0.06 * math.sin(dy * 1.4)
            return mix("#34363c", "#eceef3", min(1, max(0, lit) * 0.85 + 0.15 + band))
        if ring:
            return ring_c
        # Stars stay single pixels at every scale.
        if y % s == 0 and x % s == 0 and (y // s, x // s) in stars:
            return "#eceef3" if (x // s + y // s) % 2 else "#9aa0ab"
        return "#5c6069" if (y, x) in faint else None

    muted, rule, text = "#9aa0ab", "#34363c", "#eceef3"
    # Radio log from Saturn: the reply is stamped 02:41 because the 1h 20m light delay
    # applies both ways, plus a minute for Earth to answer.
    panel = [
        *heading("S P A C E  ·  G R A Y", "#eceef3", "#ff6eb3", rule),
        fg(muted)
        + "00:00  "
        + fg("#ff6eb3")
        + "▸ "
        + fg(text)
        + "ring plane clear"
        + RESET,
        fg(muted)
        + "02:41  "
        + fg("#3ddcff")
        + "◂ "
        + fg(text)
        + "copy, go for code"
        + RESET,
        hr(rule),
        fg(muted) + "signal delay  " + fg("#3dff8b") + "1h 20m" + RESET,
    ]
    return with_panel(pixel_rows(H * s, W * s, color), panel)


# --- tokyo-night: rainy skyline, lit windows, neon sign, antenna light --------------------

BUILDINGS = [
    (0, 4, 9),
    (4, 5, 14),
    (9, 3, 7),
    (12, 6, 18),
    (18, 4, 11),
    (22, 5, 15),
    (27, 3, 8),
    (30, 6, 13),
    (36, 4, 10),
]  # (x0, width, height)
RAIN = {1: (9, 3), 2: (13, 4)}  # (diagonal spacing, dash cycle) in hi-res pixels


def tokyo_night(s=1):
    W, H = 40, 22
    spacing, dash = RAIN[s]

    # Geometry scales with s; walls, windows, rain and the antenna are drawn in hi-res pixels,
    # so 2x gets finer edges and four times the windows rather than bigger blocks.
    def color(y, x):
        x0, w, h = next(b for b in BUILDINGS if b[0] <= x // s < b[0] + b[1])
        x0, w, top = x0 * s, w * s, (H - h) * s
        if (
            x == 14 * s + s // 2 and top - 3 * s <= y < top
        ):  # antenna on the tallest tower
            return "#f7768e" if y == top - 3 * s else "#565f89"
        if y < top:
            # Sparse diagonal dashes read as rain.
            return (
                "#3d59a1" if (x - y) % spacing == 0 and y % dash != dash - 1 else None
            )
        if y == top:
            return mix("#7aa2f7", "#bb9af7", logical(x, s) / (W - 1))
        if x // s == 20 and top + s <= y < top + 7 * s:  # vertical neon sign
            if s > 1 and y % s == s - 1:
                return "#16161e"  # dark seams between the sign's glyphs
            return "#f7768e" if (y // s) % 2 else "#ff9e64"
        if x in (x0, x0 + w - 1) or y == H * s - 1:
            return "#292e42"
        if (x - x0) % 2 == 1 and (y - top) % 2 == 0:
            if (x * 7 + y * 13) % 5 < 2:
                return "#e0af68" if (x + y) % 3 else "#7dcfff"
            return "#16161e"
        return "#24283b"

    muted = "#737aa2"

    def departure(time, dest, status, c, text="#c0caf5"):
        return (
            fg("#7aa2f7")
            + time
            + "  "
            + fg(text)
            + f"{dest:<10} "
            + fg(c)
            + f"{status:>8}"
        ) + RESET

    # Departure board; the bold amber last train closes the panel instead of a prompt line.
    sub = fg(muted) + "DEPARTURES  ·  " + fg("#f7768e") + "新宿"
    panel = [
        *heading(
            "T O K Y O  ·  N I G H T",
            "#7aa2f7",
            "#bb9af7",
            "#292e42",
            sub + fg(muted) + "  ·  " + fg("#7dcfff") + "雨" + RESET,
        ),
        departure("23:52", "YAMANOTE", "ON TIME", "#9ece6a"),
        departure("00:04", "CHUO", "+4 MIN", "#ff9e64"),
        "\033[1m" + departure("00:12", "LAST TRAIN", "BOARDING", "#e0af68", "#e0af68"),
    ]
    return with_panel(pixel_rows(H * s, W * s, color), panel)


# --- dracula: bat across a purple moon ----------------------------------------------------

BAT = [
    "#...............#",
    "##....#...#....##",
    "###...#####...###",
    "#######E#E#######",
    "#################",
    ".####.#####.####.",
    "..#....###....#..",
    "........#........",
]
SMALL_BAT = ["##.##", "..#.."]
SMALL_BATS = [(1, 0), (20, 25)]  # (y, x) of each SMALL_BAT


def dracula(s=1):
    W, H, cx, cy, r = 30, 24, 14.5, 11.5, 10.5
    craters = [(8, 10, 1.8), (15, 19, 2.2), (5, 17, 1.2)]
    bat, small = (BAT, SMALL_BAT) if s == 1 else (scale2x(BAT), scale2x(SMALL_BAT))

    def sprite(grid, y, x):
        return 0 <= y < len(grid) and 0 <= x < len(grid[0]) and grid[y][x] != "."

    def color(y, x):
        by, bx = y - 8 * s, x - 6 * s
        if sprite(bat, by, bx):
            return "#ff5555" if bat[by][bx] == "E" else "#191a21"
        for sy, sx in SMALL_BATS:
            if sprite(small, y - sy * s, x - sx * s):
                return "#6272a4"
        lx, ly = logical(x, s), logical(y, s)
        if (lx - cx) ** 2 + (ly - cy) ** 2 <= r * r:
            c = mix("#bd93f9", "#ff79c6", ly / (H - 1))
            if any(
                (lx - kx) ** 2 + (ly - ky) ** 2 <= kr * kr for ky, kx, kr in craters
            ):
                c = mix(c, "#6272a4", 0.35)
            return c
        return None

    muted, rule, quote = "#6272a4", "#44475a", "\033[3m" + fg("#f8f8f2")
    # The Count's greeting to Harker in chapter 2 of the novel; the attribution ends
    # under the end of the quote (column 21), not at the rule's edge.
    panel = [
        *heading("D R A C U L A", "#bd93f9", "#ff79c6", rule),
        quote + '  "Enter freely and' + RESET,
        quote + '   of your own will!"' + RESET,
        fg(muted) + "— the Count".rjust(21) + RESET,
        hr(rule),
        fg(muted) + "sunrise in " + fg("#f1fa8c") + "6h 12m" + RESET,
    ]
    return with_panel(pixel_rows(H * s, W * s, color), panel)


# --- ayu: slatted sun rising over water, rays, reflection ---------------------------------

# Hi-res rows left out of the sun. At 2x the gaps widen toward the horizon (classic slatted sun).
SUN_SLATS = {1: (7, 9), 2: (13, 16, 17, 19, 20)}


def ayu(s=1):
    W, H, cx, horizon, r = 40, 20, 19.5, 11, 8.0
    ray = 0.18 if s == 1 else 0.12  # angular half-width; thinner where pixels allow

    def color(y, x):
        ly = logical(y, s)
        dx, dy = logical(x, s) - cx, ly - horizon
        d = math.hypot(dx, dy)
        if y < horizon * s:
            if d <= r:
                return (
                    None
                    if y in SUN_SLATS[s]
                    else mix("#e6b450", "#ff8f40", (ly - (horizon - r)) / r)
                )
            t = math.atan2(-dy, dx) / math.pi * 8
            if r + 1.5 <= d <= r + 3.5 and abs(round(t) - t) < ray:
                return mix("#e6b450", "#626a73", 0.4)
            return None
        if y == horizon * s:
            return "#e6b450"
        k = y - horizon * s - 1  # hi-res rows below the horizon line
        if abs(dx) <= r - k / s * 1.1 and (x + k) % 4:
            return mix("#ff8f40", "#39bae6", k / ((H - horizon) * s - 2))
        sparkle = (x * 3 + y * 7) % (11 * s) == 0
        return mix("#39bae6", "#131721", 0.5) if sparkle else None

    muted, rule = "#626a73", "#2d3640"
    # The sun's height from sunrise to sunset, amber to orange; lit up to the "you are
    # here" marker (just after sunrise), dimmed toward the rule colour after it.
    arc, now = "▁▂▃▅▆▇█▇▆▅▃▂▁", 1
    chart = "".join(
        fg(mix(mix("#e6b450", "#ff8f40", i / (len(arc) - 1)), rule, 0.55 * (i > now)))
        + ch
        for i, ch in enumerate(arc)
    )
    panel = [
        *heading("A Y U", "#e6b450", "#ff8f40", rule),
        fg("#e6b450") + "06:12 " + chart + fg(muted) + " 20:41" + RESET,
        " " * (6 + now) + fg("#ff8f40") + "^ " + fg(muted) + "you are here" + RESET,
        hr(rule),
        fg("#ff8f40")
        + "▶ "
        + fg("#bfbdb6")
        + "rise and ship"
        + fg("#e6b450")
        + "_"
        + RESET,
    ]
    return with_panel(pixel_rows(H * s, W * s, color), panel)


# --- gruvbox: 70s wordmark, rows warm yellow to red, rainbow racing stripes ----------------

STRIPES = (("#fabd2f", "#fe8019"), ("#fb4934", "#d3869b"), ("#83a598", "#8ec07c"))


def gruvbox(s=1):
    lines = [""]
    if s == 1:
        for row, text in enumerate(WORD):
            c = mix("#fabd2f", "#fb4934", row / 5)
            out = "  "
            for ch in text:
                out += ch if ch == " " else fg(c if ch == "█" else "#7c6f64") + ch
            lines.append(out + RESET)
        # Each half-block row carries two stripes: fg paints the top half, bg the bottom.
        for top, bot in STRIPES:
            lines.append("  " + fg(top) + bg(bot) + "▀" * len(WORD[0]) + RESET)
    else:
        flat = [c for pair in STRIPES for c in pair]

        def color(y, x):
            if y >= WORD_H:  # the six stripes, two pixels (one text row) each
                return flat[(y - WORD_H) // 2]
            kind = word_pixel(y, x)
            if kind == "solid":
                return mix("#fabd2f", "#fb4934", y / (WORD_H - 1))
            return "#7c6f64" if kind else None

        lines += ["  " + r for r in pixel_rows(WORD_H + 2 * len(flat), WORD_W, color)]
    lines += [
        "",
        "  "
        + fg("#928374")
        + "CLAUDE CODE  ·  SIDE A  ·  33 RPM  ·  RETRO GROOVE"
        + RESET,
        "  "
        + fg("#fe8019")
        + "▶ "
        + fg("#ebdbb2")
        + "now playing"
        + fg("#fabd2f")
        + "_"
        + RESET,
        "",
    ]
    return "\n".join(lines) + "\n"


# --- kanagawa: the Great Wave curling over Fuji -------------------------------------------
# 'F' foam  'L' light crest  'B' wave body  'D' deep water  'M' Fuji  'S' snow  '.' empty

WAVE = [
    "...........FFFFFF",
    ".........FFLLLLLLFF",
    "........FLLLBBBBLLLFF",
    ".......FLLBBBBBBBBLLFF.F",
    "......FLBBBDDDDDBBBLLF.F.F",
    ".....FLBBDDD....DDBBLF..F",
    ".....FLBDD........DBLF.F..F",
    "....FLBBD..........DBF..F",
    "....FLBD............DF....F",
    "...FLBBD.............F..........S",
    "...FLBD.......................SSS",
    "..FLBBD......................SSSSS",
    "..FLBD......................MSSMSSM",
    "..FLBD.....................MMMMMMMMM",
    ".FLBBD.........FFF........MMMMMMMMMMM",
    ".FLBD.........FLLLF......MMMMMMMMMMMMM",
    ".FLBD........FLBBBLF..FFFLLLFFFMMMMMMMMM",
    "FLBBD.......FLBDDDBLFFLLBBBBBLLFF....FF",
    "FLBDDD.....FLBDDDDDBLLBBDDDDDBBLLFFFFLL",
    "LBBDDDD...FLBDDDDDDDBBBDDDDDDDDBBBLLLLBB",
    "BBDDDDDDBBLBDDDDDDDDDDDDDDDDDDDDDDBBBBDD",
    "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    "DDDDBBDDDDDDDDDDDBBDDDDDDDDDDDBBDDDDDDDD",
    "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
]
WAVE = [r.ljust(40, ".") for r in WAVE]


def wave_grid(s):
    """WAVE at scale s: Scale2x at 2x, except lone spray dots, which stay single pixels."""
    if s == 1:
        return WAVE
    out = [list(r) for r in scale2x(WAVE)]
    h, w = len(WAVE), len(WAVE[0])
    for y, row in enumerate(WAVE):
        for x, ch in enumerate(row):
            near = [
                WAVE[y + dy][x + dx]
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1))
                if 0 <= y + dy < h and 0 <= x + dx < w
            ]
            if ch == "F" and not any(n in "FL" for n in near):
                out[2 * y][2 * x + 1] = out[2 * y + 1][2 * x] = "."
                out[2 * y + 1][2 * x + 1] = "."
    return ["".join(r) for r in out]


def kanagawa(s=1):
    colors = {
        "F": "#dcd7ba",
        "L": "#7fb4ca",
        "B": "#2d4f67",
        "D": "#223249",
        "M": "#54546d",
        "S": "#dcd7ba",
    }
    # A haiku in place of a status readout: two wave lines in crest blue, Fuji in snow.
    panel = [
        *heading(
            "K A N A G A W A",
            "#7e9cd8",
            "#7fb4ca",
            "#2a2a37",
            fg("#e46876") + "神奈川沖浪裏" + RESET,
        ),
        "\033[3m" + fg("#7fb4ca") + "great wave bares its claws" + RESET,
        "\033[3m" + fg("#7fb4ca") + "oarsmen bow into the foam" + RESET,
        "\033[3m" + fg("#dcd7ba") + "fuji does not move" + RESET,
    ]
    grid = wave_grid(s)
    return with_panel(
        pixel_rows(len(grid), len(grid[0]), grid_color(grid, colors)), panel
    )


# --- nord: striped lighthouse on snowy rocks, beam through falling snow ------------------

NORD_SNOW = {
    (0, 3),
    (1, 17),
    (2, 26),
    (0, 33),
    (3, 6),
    (4, 21),
    (5, 37),
    (6, 2),
    (7, 15),
    (8, 29),
    (9, 35),
    (10, 19),
    (11, 4),
    (12, 27),
    (13, 36),
    (1, 38),
    (6, 24),
    (9, 1),
}  # (y, x)


def nord(s=1):
    W, H, cx, horizon = 40, 20, 10.5, 14.5
    ox, oy = cx, 2.9  # lamp: where the beam starts

    def rock_top(lx):
        return 11.8 + 3.2 * ((lx - cx) / 8) ** 2 + 0.5 * abs(math.sin(lx * 1.3))

    def lighthouse(lx, ly):
        dx = abs(lx - cx)
        if 0.3 <= ly < 0.8:
            return "#bf616a" if dx <= 0.3 else None
        if 0.8 <= ly < 2:
            return "#bf616a" if dx <= (ly - 0.8) * 1.2 + 0.3 else None
        if 2 <= ly < 3.8:
            return "#ebcb8b" if dx <= 1.0 else None
        if 3.8 <= ly < 4.5:
            return "#616e88" if dx <= 2.2 else None
        hw = 1.3 + (ly - 4.5) * 0.13
        if ly >= 4.5 and dx <= hw and ly < rock_top(cx) + 0.5:
            c = "#bf616a" if int((ly - 4.5) / 1.8) % 2 else "#e5e9f0"
            # Right flank in shadow: the tower turns away from the lamp-lit side.
            return mix(c, "#2e3440", 0.35) if lx - cx > hw * 0.4 else c
        return None

    def beam(lx, ly):
        """Brightness 0..1 of the lamp's beam: a long cone to the right, a stub to the left."""
        dx, dy = lx - ox, ly - oy
        if dx > 0:
            reach, tilt = 29.0, 0.12
        else:
            dx, reach, tilt = -dx, 8.0, 0.05
        if dx < 1.0 or dx > reach:
            return 0
        off = abs(dy - dx * tilt) / (
            0.6 + dx * 0.11
        )  # 0 on the axis, 1 at the cone's edge
        return max(0.0, 1 - off) ** 0.7 * (1 - dx / reach) ** 0.8

    def color(y, x):
        lx, ly = logical(x, s), logical(y, s)
        c = lighthouse(lx, ly)
        if c:
            return c
        top = rock_top(lx)
        if abs(lx - cx) <= 8.5 and top <= ly < 16.5:
            if ly < top + 0.5:
                return "#eceff4"
            return "#616e88" if ly < top + 2 else "#4c566a"
        if ly >= horizon:
            if abs(logical(x, s) - 35) < 0.5 and ly < horizon + 2:
                return (
                    "#d08770" if (y // s) % 2 == 0 else None
                )  # the ship light's reflection
            if 8.5 < abs(lx - cx) < 9.8 and ly < 16.5:
                return "#d8dee9"  # foam where the swell meets the rocks
            row = int(ly - horizon)
            if math.sin(lx * 0.7 + row * 2.1) > 0.75 - 0.08 * row:
                return "#5e81ac"
            return "#3b4252"
        if (round(ly), round(lx)) == (14, 35):
            return "#ebcb8b"  # a ship's light on the horizon
        b = beam(lx, ly)
        flake = y % s == 0 and x % s == 0 and (y // s, x // s) in NORD_SNOW
        if flake:
            # Snow catches the beam: flakes inside it burn white, the rest stay dim.
            return "#eceff4" if b > 0.15 else "#7b88a1"
        if b > 0.15:
            return mix(
                "#2e3440", mix("#eceff4", "#88c0d0", abs(lx - ox) / 29), 0.2 + 0.8 * b
            )
        return None

    muted, rule = "#7b88a1", "#3b4252"
    panel = [
        *heading(
            "N O R D",
            "#88c0d0",
            "#81a1c1",
            rule,
            fg(muted) + "polar night  ·  snow storm" + RESET,
        ),
        fg(muted) + "light       " + fg("#ebcb8b") + "Fl W 10s" + RESET,
        fg(muted) + "visibility  " + fg("#88c0d0") + "2 nm  ·  snow" + RESET,
        fg(muted) + "wind        " + fg("#d8dee9") + "NW 8  gale" + RESET,
    ]
    return with_panel(pixel_rows(H * s, W * s, color), panel)


# --- rose-pine: pine silhouettes against a rose dusk glow, crescent moon ------------------

PINES = [
    (3, 9, 20),
    (9, 6, 20),
    (14, 11, 20),
    (21, 7, 20),
    (27, 10, 20),
    (33, 8, 20),
]  # (x, top, base)
ROSE_STARS = {(1, 4), (3, 12), (0, 18), (2, 33), (6, 2), (5, 15)}


def rose_pine(s=1):
    W, H = 36, 22

    def pine(lx, ly):
        for cx, top, base in PINES:
            if top <= ly < base - 1:
                # Tiers: the half-width grows down each 3-row tier, then snaps back in a
                # little narrower than it ended, so every tier reads as its own bough.
                depth = int(ly - top + 0.5)
                hw = 0.4 + 0.55 * (depth % 3) + 0.5 * (depth // 3)
                if abs(lx - cx) <= hw:
                    return "#3e8fb0" if lx - cx < -hw + 0.9 else "#31748f"
            elif base - 1 <= ly < base and abs(lx - cx) <= 0.5:
                return "#6e6a86"
        return None

    def color(y, x):
        lx, ly = logical(x, s), logical(y, s)
        if ly >= 20:
            return "#26233a"
        c = pine(lx, ly)
        if c:
            return c
        if (lx - 27) ** 2 + (ly - 4.5) ** 2 <= 3.2**2 and (lx - 28.6) ** 2 + (
            ly - 3.6
        ) ** 2 > 2.9**2:
            return mix("#e0def4", "#ebbcba", (ly - 1.3) / 6.4)
        e = ((lx - 18) / 19) ** 2 + ((ly - 20) / 9) ** 2
        # Checkerboard dither on the glow's rim so it frays instead of ending in a hard arc.
        if e < 1 - 0.12 * ((x // s + y // s) % 2):
            return mix("#eb6f92", mix("#c4a7e7", "#26233a", 0.35), math.sqrt(e))
        if y % s == 0 and x % s == 0 and (y // s, x // s) in ROSE_STARS:
            return "#f6c177"
        return None

    muted, rule, quote = "#908caa", "#26233a", "\033[3m" + fg("#e0def4")
    # The project's own tagline.
    panel = [
        *heading("R O S É  P I N E", "#ebbcba", "#c4a7e7", rule),
        quote + "all natural pine, faux fur" + RESET,
        quote + "and a bit of soho vibes" + RESET,
        quote + "for the classy minimalist" + RESET,
        hr(rule),
        fg(muted) + "moon  " + fg("#f6c177") + "waxing crescent" + RESET,
    ]
    return with_panel(pixel_rows(H * s, W * s, color), panel)


# --- everforest: rolling hills, round trees, low sun, wildflowers ------------------------

TREES = [
    (6, 9.5, 2.6),
    (11, 10.5, 2.0),
    (25, 8.5, 2.4),
    (30, 9.5, 1.8),
]  # (x, canopy y, r)
FLOWERS = {
    (17, 4): "#d699b6",
    (18, 13): "#e67e80",
    (17, 21): "#dbbc7f",
    (19, 29): "#d699b6",
    (18, 35): "#e67e80",
    (19, 9): "#dbbc7f",
}  # (y, x) -> colour


def everforest(s=1):
    W, H = 40, 20
    shade = mix("#a7c080", "#2d353b", 0.45)

    def meadow(lx):
        return 14.5 + 0.9 * math.sin(lx * 0.18 + 2)

    def color(y, x):
        lx, ly = logical(x, s), logical(y, s)
        if y % s == 0 and x % s == 0 and (y // s, x // s) in FLOWERS:
            return FLOWERS[(y // s, x // s)]
        if ly >= meadow(lx):
            return "#83c092" if ly < 17 + 0.8 * math.sin(lx * 0.4) else "#a7c080"
        for cx, cy, r in TREES:
            if math.hypot(lx - cx, ly - cy) <= r:
                # Lit from the sun, up and to the right.
                return "#a7c080" if (lx - cx) - (ly - cy) > r * 0.3 else shade
            if abs(lx - cx) <= 0.5 and cy + r < ly < meadow(cx) + 0.5:
                return "#e69875"
        if ly >= 11 + 1.4 * math.sin(lx * 0.21):
            return "#5c6a72"
        if ly >= 7.5 + 1.8 * math.sin(lx * 0.14 + 3):
            return "#475258"
        d = math.hypot(lx - 33, ly - 4)
        if d <= 2.6:
            return "#dbbc7f"
        if d <= 3.6 and (x // s + y // s) % 2:
            return mix("#dbbc7f", "#2d353b", 0.5)
        return None

    muted, rule = "#859289", "#3d484d"
    panel = [
        *heading("E V E R F O R E S T", "#a7c080", "#83c092", rule),
        "\033[3m" + fg("#d3c6aa") + "comfortable & pleasant" + RESET,
        hr(rule),
        fg(muted)
        + "trail   "
        + fg("#a7c080")
        + "4.2 km"
        + fg(muted)
        + "  ·  ↑ "
        + fg("#dbbc7f")
        + "310 m"
        + RESET,
        fg(muted) + "camp    " + fg("#e69875") + "before dusk" + RESET,
    ]
    return with_panel(pixel_rows(H * s, W * s, color), panel)


def mirror(half):
    """A symmetric grid from its left half; the centre column is doubled."""
    return [r + r[::-1] for r in half]


def at_scale(grid, s):
    return grid if s == 1 else scale2x(grid)


# --- catppuccin: a pastel cat face -------------------------------------------------------
# '#' fur  'i' inner ear  'e' eye  'p' pupil  'n' nose  'm' mouth  'w' whisker

CAT = mirror(
    [
        "...#.......",
        "...##......",
        "...#i#.....",
        "...#ii#....",
        "...#iii####",
        "..#########",
        "..#########",
        ".##########",
        ".##########",
        ".###eee####",
        ".##eepe####",
        ".##eepe####",
        ".###eee####",
        "w##########",
        ".#########n",
        "w#######m#m",
        "..#########",
        "...########",
        "....#######",
        "......#####",
    ]
)


def catppuccin(s=1):
    grid = at_scale(CAT, s)
    h = len(grid)
    parts = {
        "i": "#f5c2e7",
        "e": "#a6e3a1",
        "p": "#1e1e2e",
        "n": "#f38ba8",
        "m": "#585b70",
        "w": "#9399b2",
    }

    def color(y, x):
        ch = grid[y][x]
        if ch == ".":
            return None
        return parts.get(ch) or mix("#cba6f7", "#b4befe", y / (h - 1))

    muted, rule = "#7f849c", "#313244"
    flavours = (
        " · ".join(fg(muted) + f for f in ("latte", "frappé", "macchiato"))
        + fg(muted)
        + " · "
        + fg("#cba6f7")
        + "mocha"
        + RESET
    )
    panel = [
        *heading("C A T P P U C C I N", "#cba6f7", "#f5c2e7", rule),
        "\033[3m" + fg("#cdd6f4") + "soothing pastel for the" + RESET,
        "\033[3m" + fg("#cdd6f4") + "high-spirited" + RESET,
        hr(rule),
        flavours,
        fg(muted) + "mood    " + fg("#fab387") + "purring" + RESET,
    ]
    return with_panel(pixel_rows(len(grid), len(grid[0]), color), panel)


# --- night-owl: an owl on a branch under the moon ----------------------------------------
# '#' feathers  't' ear tuft  'e' eye ring  'p' pupil  'k' beak  'b' breast  'v' breast mark
# 'f' talon  'o' branch

OWL = mirror(
    [
        "..t........",
        "..tt.......",
        "..t########",
        ".##########",
        ".##eeee####",
        ".#eeppee###",
        ".#eeppee###",
        ".##eeee###k",
        ".#########k",
        ".######bbbb",
        "#####bbbbbb",
        "####bvbbvbb",
        "####bbbbbbb",
        "####bbvbbvb",
        ".###bbbbbbb",
        ".####bbbbbb",
        "..####bbbbb",
        "...###bbbbb",
        "....f.f....",
        "ooooooooooo",
    ]
)


def night_owl(s=1):
    W, H = 34, 20
    owl = at_scale(OWL, s)
    parts = {
        "t": "#c792ea",
        "e": "#ecc48d",
        "p": "#011627",
        "k": "#f78c6c",
        "b": "#a9b8cc",
        "v": "#637777",
        "f": "#ecc48d",
        "o": "#7a5b3c",
    }

    def color(y, x):
        if x < len(owl[0]):
            ch = owl[y][x]
            if ch != ".":
                return parts.get(ch) or mix("#82aaff", "#5f7fd0", y / (H * s - 1))
        lx, ly = logical(x, s), logical(y, s)
        d = math.hypot(lx - 28, ly - 5)
        if d <= 3.2:
            # a gibbous moon: the disc less a circle shifted left
            return None if math.hypot(lx - 26.2, ly - 4.4) <= 2.6 else "#d6deeb"
        if (x * 5 + y * 11) % (23 * s) == 0 and y < 14 * s:
            return "#637777"
        return None

    muted, rule = "#637777", "#1d3b53"
    panel = [
        *heading("N I G H T   O W L", "#82aaff", "#c792ea", rule),
        "\033[3m" + fg("#d6deeb") + "for the ones who code at night" + RESET,
        hr(rule),
        fg(muted) + "moon    " + fg("#ecc48d") + "waning gibbous" + RESET,
        fg(muted) + "watch   " + fg("#addb67") + "wide awake" + RESET,
    ]
    return with_panel(pixel_rows(H * s, W * s, color), panel)


# --- github: a contribution graph that gets busier toward today --------------------------

GRAPH = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"]
WEEKS, DAYS = 20, 7


def github(s=1):
    # A cell is 1 px with a 1 px gap at 1x, 3 px with a 1 px gap at 2x.
    cell, pitch = (1, 2) if s == 1 else (3, 4)

    def level(week, day):
        busy = 0.25 + 0.75 * week / (WEEKS - 1)
        noise = ((week * 7 + day) * 2654435761 % 2**32) / 2**32
        return (
            min(4, int(noise * busy * 5.5)) if day not in (0, 6) or noise > 0.7 else 0
        )

    def color(y, x):
        week, day = x // pitch, y // pitch
        if x % pitch >= cell or y % pitch >= cell or week >= WEEKS or day >= DAYS:
            return None
        return GRAPH[level(week, day)]

    muted, rule = "#7d8590", "#30363d"
    legend = (
        fg(muted)
        + "less "
        + "".join(fg(c) + "■" for c in GRAPH)
        + fg(muted)
        + " more"
        + RESET
    )
    panel = [
        *heading("G I T H U B", "#58a6ff", "#3fb950", rule),
        fg(muted) + "1,337 contributions this year" + RESET,
        legend,
        hr(rule),
        fg("#3fb950") + "✓ " + fg("#e6edf3") + "all checks have passed" + RESET,
        fg(muted) + "main ← " + fg("#d2a8ff") + "claude/ship-it" + RESET,
    ]
    rows = pixel_rows(DAYS * pitch, WEEKS * pitch, color)
    return with_panel(rows, panel)


# --- solarized: a sun whose rays are the eight accents -----------------------------------

ACCENTS = [
    "#b58900",
    "#cb4b16",
    "#dc322f",
    "#d33682",
    "#6c71c4",
    "#268bd2",
    "#2aa198",
    "#859900",
]


def solarized(s=1):
    W, H, cx, cy, r = 36, 20, 17.5, 9.5, 4.5
    ray = 0.2 if s == 1 else 0.13  # angular half-width, in eighths of a turn

    def color(y, x):
        dx, dy = logical(x, s) - cx, logical(y, s) - cy
        d = math.hypot(dx, dy)
        if d <= r:
            return mix("#b58900", "#cb4b16", (dy + r) / (2 * r))
        t = (math.atan2(-dy, dx) / (2 * math.pi) * 8) % 8
        if (
            r + 1.5 <= d <= r + 4.5 + (0 if round(t) % 2 else 2.5)
            and abs(round(t) - t) < ray
        ):
            return ACCENTS[round(t) % 8]
        return None

    muted, rule = "#586e75", "#073642"
    swatches = "".join(fg(c) + "██" for c in ACCENTS) + RESET
    panel = [
        *heading("S O L A R I Z E D", "#b58900", "#cb4b16", rule),
        "\033[3m" + fg("#93a1a1") + "precision colours for" + RESET,
        "\033[3m" + fg("#93a1a1") + "machines and people" + RESET,
        hr(rule),
        swatches,
        fg(muted) + "sixteen colours  ·  CIELAB" + RESET,
    ]
    return with_panel(pixel_rows(H * s, W * s, color), panel)


# --- one-dark: an atom, three orbits round a nucleus -------------------------------------


def one_dark(s=1):
    W, H, cx, cy, a, b = 30, 22, 14.5, 10.5, 11.0, 3.6
    width = 0.5 if s == 1 else 0.32  # half the orbit's line width, in 1x pixels
    orbits = [(0, "#61afef"), (math.pi / 3, "#c678dd"), (2 * math.pi / 3, "#98c379")]

    def color(y, x):
        dx, dy = logical(x, s) - cx, logical(y, s) - cy
        if math.hypot(dx, dy) <= 1.8:
            return "#e06c75"
        for k, (angle, c) in enumerate(orbits):
            u = dx * math.cos(angle) + dy * math.sin(angle)
            v = -dx * math.sin(angle) + dy * math.cos(angle)
            f = math.hypot(u / a, v / b)
            grad = math.hypot(u / (a * a), v / (b * b)) / max(f, 1e-9)
            # an electron on each orbit, a third of the way round from the last
            ex, ey = a * math.cos(2.1 * k + 0.6), b * math.sin(2.1 * k + 0.6)
            if math.hypot(u - ex, v - ey) <= 1.1:
                return "#e5c07b"
            if abs(f - 1) / max(grad, 1e-9) <= width:
                return c
        return None

    muted, rule = "#5c6370", "#3e4451"
    code = (
        fg("#c678dd")
        + "const "
        + fg("#61afef")
        + "ship"
        + fg("#56b6c2")
        + " = "
        + fg("#abb2bf")
        + "() "
        + fg("#c678dd")
        + "=> "
        + fg("#d19a66")
        + "true"
        + fg("#abb2bf")
        + ";"
        + RESET
    )
    panel = [
        *heading("O N E   D A R K", "#61afef", "#c678dd", rule),
        code,
        "\033[3m" + fg(muted) + "// hackable to the core" + RESET,
        hr(rule),
        fg(muted) + "build   " + fg("#98c379") + "passing" + RESET,
    ]
    return with_panel(pixel_rows(H * s, W * s, color), panel)


# --- noir: light through venetian blinds, a fedora in silhouette -------------------------


def noir(s=1):
    W, H = 36, 22

    def figure(lx, ly):
        return (
            math.hypot(lx - 18, ly - 12.5) <= 3.2  # head
            or (15.2 <= lx <= 20.8 and 5.8 <= ly <= 9.6)  # crown of the hat
            or ((lx - 18) / 6.2) ** 2 + ((ly - 9.6) / 1.1) ** 2 <= 1  # brim
            or (16.6 <= lx <= 19.4 and 14 <= ly <= 18)  # neck
            or ((lx - 18) / 9.5) ** 2 + ((ly - 23) / 5.8) ** 2 <= 1  # shoulders
        )

    def color(y, x):
        lx, ly = logical(x, s), logical(y, s)
        if figure(lx, ly):
            # rim light on the side facing the window
            return "#4a4a4a" if not figure(lx + 0.7 / s, ly) else "#0d0d0d"
        in_light = 3 + 0.5 * ly <= lx <= 29 + 0.5 * ly and 1 <= ly <= 20
        if in_light and int((ly + 0.15 * lx) / 1.6) % 2 == 0:
            return mix("#ededed", "#5c5c5c", ly / H)
        return None

    muted, rule, quote = "#8c8c8c", "#2a2a2a", "\033[3m" + fg("#ededed")
    panel = [
        *heading("N O I R", "#f5f5f5", "#8c8c8c", rule),
        quote + '"The bug walked in at' + RESET,
        quote + ' midnight. Trouble."' + RESET,
        fg(muted) + "— case file 0451".rjust(21) + RESET,
        hr(rule),
        fg(muted) + "status  " + fg("#f87171") + "open" + RESET,
    ]
    return with_panel(pixel_rows(H * s, W * s, color), panel)


# --- mono: the wordmark in greys, nothing else -------------------------------------------


def mono(s=1):
    solid, shadow, muted = "#e0e0e0", "#7a7a7a", "#9e9e9e"
    lines = [""]
    if s == 1:
        for text in WORD:
            lines.append(
                "  "
                + "".join(
                    c if c == " " else fg(solid if c == "█" else shadow) + c
                    for c in text
                )
                + RESET
            )
    else:

        def color(y, x):
            kind = word_pixel(y, x)
            return {"solid": solid, "shadow": shadow, None: None}[kind]

        lines += ["  " + r for r in pixel_rows(WORD_H, WORD_W, color)]
    lines += [
        "",
        "  " + fg(muted) + "CLAUDE CODE  ·  MONO  ·  NO COLOUR, NO NOISE" + RESET,
        "  " + fg(solid) + "| " + fg(muted) + "working" + RESET,
        "",
    ]
    return "\n".join(lines) + "\n"


# --- terminal: a terminal window, in the terminal's own colours --------------------------


def terminal(s=1):
    border, dim, text, prompt = 8, 8, 15, 2
    if s == 1:
        art = [
            "".join(c if c == " " else fg(text if c == "█" else dim) + c for c in row)
            + RESET
            for row in WORD
        ]
    else:

        def color(y, x):
            kind = word_pixel(y, x)
            return {"solid": text, "shadow": dim, None: None}[kind]

        art = pixel_rows(WORD_H, WORD_W, color)
    width = (len(WORD[0]) if s == 1 else WORD_W) + 4
    body = [
        "",
        *art,
        "",
        fg(prompt) + "$ " + fg(7) + "claude" + RESET,
        fg(prompt) + "$ " + fg(7) + "█" + RESET,
    ]

    def plain(line):
        out, i = "", 0
        while i < len(line):
            if line[i] == "\033":
                i = line.index("m", i) + 1
            else:
                out += line[i]
                i += 1
        return out

    title = " " + fg(1) + "●" + fg(3) + " ●" + fg(2) + " ●" + fg(border) + " "
    tail = " bash "
    top = (
        fg(border) + "╭─" + title + "─" * (width - 9 - len(tail)) + tail + "─╮" + RESET
    )
    rows = [
        fg(border)
        + "│  "
        + RESET
        + line
        + " " * (width - 4 - len(plain(line)))
        + fg(border)
        + "  │"
        + RESET
        for line in body
    ]
    bottom = fg(border) + "╰" + "─" * width + "╯" + RESET
    return (
        "\n".join(["", "  " + top, *("  " + r for r in rows), "  " + bottom, ""]) + "\n"
    )


if __name__ == "__main__":
    for grid in (
        SKULL,
        WAVE,
        CAT,
        OWL,
        skull_grid(2),
        wave_grid(2),
        scale2x(CAT),
        scale2x(OWL),
    ):
        assert all(len(r) == len(grid[0]) for r in grid) and len(grid) % 2 == 0
    for name, build in (
        ("retro-terminal", retro_terminal),
        ("cyberpunk-neon", cyberpunk_neon),
        ("space-gray", space_gray),
        ("tokyo-night", tokyo_night),
        ("dracula", dracula),
        ("ayu", ayu),
        ("gruvbox", gruvbox),
        ("kanagawa", kanagawa),
        ("nord", nord),
        ("rose-pine", rose_pine),
        ("everforest", everforest),
        ("catppuccin", catppuccin),
        ("night-owl", night_owl),
        ("github", github),
        ("solarized", solarized),
        ("one-dark", one_dark),
        ("noir", noir),
        ("mono", mono),
        ("terminal", terminal),
    ):
        for s in SCALES:
            path = OUT / (f"{name}.txt" if s == 1 else f"{name}@{s}x.txt")
            path.write_text(build(s))
            print("wrote", path)
