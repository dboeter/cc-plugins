# redact roadmap

Open work found in the council review of the desktop surface. None of it shows a real value off the terminal today.

## Masking

- **A rule matching across a held value**: a rule can match text that straddles a value the vault already holds and split it, so neither part is masked whole.
- **A held value inside a word**: masking known values matches whole words only, so a held value inside a longer word goes to Claude as it is. The desktop pane and `/redact test` warn when this happens; masking does not catch it yet.
- **Overlapping vault saves**: two saves in flight at once (a prompt and a pick, say) can race in `keep()`.
- **What "off" means**: with no rule and no env files on, the status reads `redact off`, yet values already in the vault are still masked. Decide on the wording or the behaviour.
- **Letters and digits beyond ASCII**: word boundaries and the pickable check count ASCII letters and digits only.
- **Other toasts**: toasts other than `/redact` replies use fixed wording and are not hidden against the vault. Send them through the same hiding so a later change to their text can't show a value.

## Desktop

- **A held value split across two drawn texts**: each text is hidden on its own, so a value whose halves land in two separate elements is drawn.
- **Placeholder numbers in a `/redact test` preview**: if a prompt saves a new value while a test runs, the preview can show the same number for two values. Cosmetic; no value is shown.

## Tests

The test kit can't set these up yet:

- a pick saved from the right-click menu while another save is in flight
- whether the pane's input field resets when the pane is drawn again
- the test toast's hiding with the trial vault merged with the live one

## By design

- **The terminal shows real values**: drawing them there is the point of the terminal pane. Revisit only if a terminal can be shared off the machine.
