# notepad

A notepad pane beside the session: one note per project, kept between sessions. Claude does not see it.

## Install

```
/plugin install notepad --marketplace dboeter/cc-plugins
```

Answer `y` to add the marketplace, then pick a scope.

## Use

`/notepad` shows or hides the pane. It never opens by itself.

The note is markdown, and the pane shows it rendered. **Click the note to edit it**: the pane turns into a plain-text editor with the keyboard already in it. Enter starts a new line at the cursor, the arrow keys, Home, End, Page Up and Page Down move it (Ctrl+A and Ctrl+E go to the line's start and end), and a click places it. The note saves on every keystroke. Click **[ Preview ]** on the editor's top row to see it rendered again. Esc returns the keyboard to the prompt.

Why a click: Claude Code hands the keyboard to a mod's own editor only on a click, not when `/notepad` opens the pane or on the focus chord. The built-in text field would take the keyboard on open, but it draws its `⏎ · \⏎ new line` hint level with the first line at the width of the longest one, and Enter there could not start a new line at the cursor.

In VS Code, which cannot run the editor, the pane is the built-in text field (Enter saves; type a newline as in the prompt box). On the mobile app the note is shown rendered, read-only.

## What it does on your machine

- **Storage**: the note's text in the plugin's own store (a JSON file under your Claude Code configuration directory), one entry per project root. `/cd` switches to that directory's note; a shell `cd` does not. All notes together are capped at 4 MiB.
- **Claude**: nothing is added to the prompt or the context.
