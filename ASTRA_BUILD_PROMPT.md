# Astra Build Brief — TCF Live v5

You are continuing an existing zero-cost iPhone PWA project.

## Hard constraint
The finished product must remain 100% zero monetary cost for the user:
- no OpenAI API
- no paid AI APIs
- no Apple Developer membership
- no paid hosting
- no paid database
- no Mac requirement
- no subscription dependency
- static PWA + local/open model only

Do NOT replace local Qwen with GPT/OpenAI API. Astra is being used only as the development/coding agent.

## Product priority
This is primarily a REAL-LIFE FRENCH CONVERSATION COPILOT.
TCF preparation is secondary.

### Main Live experience
Opening the installed Home-Screen app should best-effort auto-start Live listening.
If iOS blocks microphone start, show one large "Tap to Listen" fallback.

Live loop:
1. Determine expected speaker (THEM or ME).
2. Transcribe French using fr-CA context.
3. Understand both standard French and real Québec French.
4. Classify speaker probabilistically using:
   - expected turn
   - whether Arthur just gave the learner a cue
   - recent conversation semantics
   - current sentence semantics
   Do NOT claim biometric voice identification.
5. Store:
   - raw transcript
   - normalized standard-French interpretation
   - speaker ME/THEM
   - confidence %
6. If THEM:
   - generate tiny English meaning (optional setting)
   - generate only 2–5 French reply-starting words
   - pause recognition
   - speak cue through current iPhone/BTH661 route
   - resume recognition
7. If ME:
   - save the learner's raw speech
   - do NOT correct or interrupt
8. Repeat.
9. On End:
   - correct only ME turns
   - distinguish genuine grammar mistakes from legitimate Québec oral forms
   - provide standard/TCF-preferred forms where appropriate
   - extract Québec expressions actually heard
   - save review locally

## Speaker controls
Must have:
- first-speaker choice: THEY START / I START
- `↔ Reverse`: changes who is expected NEXT
- `Fix last`: changes the speaker of the most recently completed turn
These are not the same action.

## Québec French
Primary locale/context: fr-CA.
Understand colloquial Québec usage including context-sensitive forms such as:
faque/fait que, ben, pantoute, à soir, tantôt, char, dépanneur, magasiner,
c'est correct, t'sais, j'vas, chu/chus, icitte, pogner, niaiser, plate.

Do not implement naive string replacement as the main interpretation method.
Use the local language model to normalize contextually while preserving raw speech.

Live response style:
- understand colloquial Québec French
- reply cue should default to clear natural neutral/Canadian French
- do not force the learner to imitate slang

Review style:
- label legitimate Québec usage as Québec oral, not simply "wrong"
- show standard French and TCF-preferred version when useful

## BTH661
The earbuds are ordinary Bluetooth audio:
- device name: BTH661
- SBC/AAC
- no proprietary SDK assumed

iOS owns audio routing. A PWA cannot guarantee output to a named BTH661 device.
Keep:
- 🎧 Arm/Test control
- current-audio-route wording
- pause recognition while Arthur speaks
- never claim the web app can force BTH661

## Home
Live is the primary content.
Secondary options under Live:
- Prep TCF
- Extra Practice
- Review
- Setup

Prep TCF:
- Questions by heart
- Tâche 2
- Tâche 3

Extra:
- Day-to-day talk
- Listening
- Rescue drill
- My weak points / Québec listening learned from real conversations

Entering a training page pauses Live.
Returning Home resumes it.

## Existing code
Start with the included `index.html`, `styles.css`, `app.js`, `manifest.json`, and `sw.js`.

## Astra tasks
1. Audit all DOM IDs and event handlers.
2. Run syntax/static checks.
3. Fix race conditions in speech-recognition restart logic.
4. Make speaker classification resilient to interruptions.
5. Keep AI calls minimal for latency.
6. Improve parsing so malformed local-model output cannot break the session.
7. Preserve raw transcript even if normalization fails.
8. Make local history schema migration-safe from future versions.
9. Ensure service-worker cache versioning updates.
10. Add an in-app diagnostics panel for:
    - SpeechRecognition support
    - WebGPU support
    - Qwen loaded
    - headphone audio armed
    - auto-start setting
    - current expected speaker
11. Do not add paid dependencies.
12. Do not claim features Safari cannot guarantee.

## Acceptance tests
- They start → their question → cue → my reply → back to them.
- I start → first sentence saved as ME → next expected speaker THEM.
- Other person interrupts while ME is expected → classifier may label THEM and confidence is shown.
- Reverse switches expected NEXT speaker without editing history.
- Fix last changes the saved previous speaker.
- Québec sentence "Faque t'es-tu libre à soir?" normalizes correctly and generates a neutral reply starter.
- Learner says "J'vas y aller tantôt." → review identifies Québec oral usage and provides standard/TCF form, not simply an error.
- Arthur cue is not transcribed as a human utterance.
- Ending session corrects only ME.
- No network AI/API calls other than static WebLLM/model asset download.
