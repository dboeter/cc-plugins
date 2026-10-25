# skin-spinners

Gives every skins skin its own spinner row and turn footer, turned up loud. Each skin gets a sprite that loops, an effect on the spinner word, a themed clock or tag, and, for 11 of them, themed done words in the footer. For those 11 the row escalates as a turn runs: letters of the word flash bold in spark colours, more of them each minute, the sprite gets busier, and at 3 minutes the word strobes and the tag turns to an alarm that blinks.

## Install

```
/plugin install skin-spinners --marketplace dboeter/cc-plugins
```

Answer `y` to add the marketplace, then pick a scope. It needs the skins mod, `skins@hellosverre-mods`, installed first. It names skins as a dependency, but Claude Code installs a dependency from another marketplace only by hand.

skins draws the spinner row and the footer too, and when two mods hook the same row, the one loaded first draws it. Claude Code loads plugins in the order of `enabledPlugins` in `~/.claude/settings.json`, and an install adds its key at the end, below skins. Move `"skin-spinners@dboeter": true` above `"skins@hellosverre-mods": true`, then restart Claude Code. Left below skins, this mod draws no footer, and draws the spinner row only while `/skin shimmer off` is set, because skins then hands the row on.

## Use

Nothing to switch on. Pick a skin with `/skin` and the spinner row and the footer under each reply change with it.

| Skin | Sprite | Word | Clock and tag | Footer |
| --- | --- | --- | --- | --- |
| retro-terminal | modem lights that follow the turn, and line noise that spikes higher | typed out in glowing phosphor, a blinking cursor, a refresh beam | `[mm:ss]`, then `38911 BYTES FREE` counting down, then a blinking `?OUT OF MEMORY` | `READY.` |
| cyberpunk-neon | packets racing into a port that flashes, one at first, three at full heat | decoding from hex | `t+0x0c`; a `TRACE` gauge, then a blinking `!! TRACE COMPLETE !!` | yes |
| space-gray | a moon orbiting, a pulse on the path, stars streaking past faster | signal that drops letters | `T+mm:ss`; a `ΔV` gauge, then a blinking `MASTER ALARM` | yes |
| tokyo-night | a wide skyline with lit windows and rain, and lightning past 90 s | split-flap board | `ON TIME`, then minutes late, then the last train | yes |
| dracula | bats across the moon, a colony of three and a blood moon at full heat | a red band | countdown to sunrise; then a blinking `THE BLOOD MOON RISES` | yes |
| ayu | the sun rising between ripples and twinkling glints | warming, with glints | a day bar, then a blinking `☼ HIGH NOON ☼` | yes |
| gruvbox | two tape reels, the button, and a VU meter that peaks into the red | scrolling gradient | `m:ss · side A`, then `side B`; a conveyor | yes |
| kanagawa | waves toward Fuji, calm, then a storm swell | a crest | lines that arrive at 20, 40 and 60 s | yes |
| nord | a lighthouse and snow under an aurora that brightens | a slow wide band | a ship coming in, then a blinking `WHITEOUT` | yes |
| rose-pine | three breathing pines, with petals falling among them | breathing colour | clock after 30 s; then a blinking `✿ FULL BLOOM ✿` | yes |
| everforest | seven flowers blooming, faster as the turn runs | sunlit gradient | trail distance and climb | yes |
| catppuccin, night-owl, github, solarized, one-dark, noir, mono | one each | skins' shimmer band (noir: blinds) | the default | skins' own |

These keep skins' own row instead of this mod's:

- the desktop, VS Code and the mobile app (this mod draws the terminal only);
- a skin set to `off`, `/skin calm`, ascii icons, a light palette;
- a skin this mod has no theme for. Custom skins keep skins' row, except space-gray, cyberpunk-neon and retro-terminal, which have a theme here and take the custom skin's own spinner and done words as extras.

With `/skin` words set to `claude`, Claude Code's own words are kept and only the look changes.

## What it does on your machine

- **State**: the frame count, the time the latest turn began, and how the last 20 turns ended, in the mod's own state. Nothing is written to disk.
- **Claude**: nothing is added to the prompt or the context.

## Preview

```
bun plugins/skin-spinners/preview.ts [--skin a,b] [--mode <mode>] [--at <seconds>] [--speed <n>] [--frames <n>] [--footer]
```

Draws every theme in 24-bit colour, one row per skin, redrawn every 90 ms until Ctrl-C. `--at` starts at an elapsed time, `--speed` runs the clock faster to see effects that take minutes, `--frames` prints that many frames per skin as lines and exits, `--footer` adds each footer.

## Develop

A theme is an entry of `THEMES` in `hooks/themes.ts`, built from the helpers in `hooks/effects.ts`; no code outside that file branches on a skin's name. `runs.ts`, `effects.ts`, `themes.ts` and `row.ts` import nothing from Claude Code, so the tests and the preview call them directly. `hooks/register.tsx` is the only file that reads skins' state and draws.
