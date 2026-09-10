# TCF Live v6 — Cue Fix / iPhone Safe Mode

This patch addresses the real-device failure observed on iPhone:

- Live listening worked.
- Qwen 1.5B failed to load / Safari crashed.
- The app therefore never reached the "what should I say next?" cue.

## v6 critical change

LIVE CUES NO LONGER REQUIRE QWEN.

The Live pipeline is now:

speech recognition
→ lightweight local speaker/context analyser
→ Québec-French normalization
→ immediate reply starter
→ BTH661 spoken cue
→ your reply saved
→ repeat

Qwen is optional and is reserved for deeper after-conversation review when it successfully loads.

## iPhone safety

- Live mode does NOT auto-load Qwen.
- Qwen 1.5B is disabled on iPhone.
- Qwen 0.5B is optional.
- A Qwen failure does not disable Live.
- A Qwen failure does not prevent cues.
- New service worker uses network-first loading for app.js so future GitHub updates refresh more reliably.

## Quick GitHub update

You only need to replace:
- app.js
- sw.js

in the existing `tcf-live` repository.

After GitHub Pages redeploys:
1. Close the Home-Screen app completely.
2. Open the GitHub Pages site in Safari once and refresh.
3. Re-open the Home-Screen app.
4. Tap 🎧 Arm.
5. Test with: "Ça fait combien de temps que tu habites à Montréal ?"
6. Expected BTH661 cue: "Ça fait environ…"

The UI should also display the cue even if headphone speech is blocked.
