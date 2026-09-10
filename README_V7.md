# TCF Live v7 — Sentence Copilot

This build adds the missing core behavior: Arthur now helps while **you** are speaking, not only after the other person finishes.

## Live behavior

THEM speaks → starter cue → ME speaks → hesitation detected → tiny continuation cue → ME continues → completed idea / longer pause → app returns to THEM.

Example:

- THEM: `Pourquoi tu as décidé de venir au Québec ?`
- Arthur: `Principalement parce que…`
- ME: `Principalement parce que je voulais avoir une meilleure…`
- pause → Arthur: `qualité de vie…`
- ME continues.

## Timing

- Normal short pauses: Arthur stays silent.
- About 1.25 seconds + an unfinished phrase: Arthur gives the next few words.
- About 2.65 seconds after a complete idea: your turn is treated as finished.
- If your phrase is still clearly unfinished, Arthur helps again instead of immediately switching to THEM.

These are approximate because Safari/iOS speech-recognition finalization timing varies.

## Manual Rescue

A new `⚡ Rescue` button is added to the Live controls. It gives the next few words immediately when automatic detection does not trigger.

## Assistance tracking

The Live screen now counts how many times Arthur assisted you. The goal for later progress tracking is to reduce the assisted percentage over time.

## iPhone safety / zero cost

- Live cues and sentence continuations do **not** require Qwen.
- Qwen 1.5B remains disabled on iPhone.
- Qwen 0.5B remains optional for deeper after-conversation review.
- No paid API or Apple Developer account is required.

## Update the existing GitHub Pages app

Replace only:

- `app.js`
- `sw.js`

Then wait for GitHub Pages to redeploy, open the site in Safari and refresh once, close the Home-Screen app fully, and reopen it.
