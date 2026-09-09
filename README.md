# TCF Live v5 — Astra Handoff Build

This version incorporates the latest product decisions:
- Live mode first and best-effort auto-start on launch
- BTH661 spoken reply cues
- THEY START / I START
- ↔ Reverse = change expected next speaker
- Fix last = repair completed speaker label
- probabilistic speaker classification using expected turn + context
- raw transcript + normalized standard-French interpretation
- standard French + Québec-French understanding
- no live correction
- correction only after End
- Québec expressions learned from real conversations
- Prep TCF / Extra / Review / Setup under the Live screen
- 100% zero-cost runtime architecture

## Important
Astra is NOT used as the runtime AI because that would violate the zero-cost/no-API design.
The runtime model remains local Qwen via WebLLM.

`ASTRA_BUILD_PROMPT.md` is the exact engineering brief to use when opening this project in ChatGPT Work/Codex with GPT-6 Astra.

## Recommended Astra workflow
1. Open ChatGPT Work or Codex.
2. Select GPT-6 Astra if it is available to your account.
3. Upload `TCF_Live_v5_Astra_Handoff.zip`.
4. Tell Astra: "Open ASTRA_BUILD_PROMPT.md and implement/audit this project. Keep every hard constraint."
5. Ask Astra to run the acceptance tests in the brief before returning the final build.

## Running the PWA
Host the static files on a free HTTPS host such as GitHub Pages, then:
Safari → open URL → Share → Add to Home Screen.

First run:
- choose They start / I start
- accept the consent rule
- load Qwen
- pair BTH661 in iPhone Bluetooth settings
- tap 🎧 Arm if iOS requires a user gesture for spoken cues

## Current limitation
Safari/iOS controls microphone permission and Bluetooth audio routing. This PWA uses best-effort auto-start and current-route playback. It does not claim to force BTH661 by name.
