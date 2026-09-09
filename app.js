import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.82";

const $ = id => document.getElementById(id);
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const CONFIG_KEY = 'tcf-live-v5-config';
const HISTORY_KEY = 'tcf-live-v5-history';

const WARMUPS = [
  ["les différentes étapes de la procédure","Pouvez-vous m'expliquer les différentes étapes de la procédure ?"],
  ["les documents nécessaires ou obligatoires","Quels sont les documents nécessaires ou obligatoires ?"],
  ["les délais","Quels sont les délais habituels ?"],
  ["les frais","Y a-t-il des frais à prévoir ?"],
  ["le suivi de la demande","Comment puis-je suivre l'évolution de ma demande ?"],
  ["une erreur ou un document manquant","Que se passe-t-il en cas d'erreur ou de document manquant ?"],
  ["l'accélération de la procédure","Est-il possible d'accélérer la procédure dans certains cas ?"],
  ["les démarches en ligne ou en personne","Puis-je effectuer les démarches en ligne ou dois-je me présenter en personne ?"],
  ["un refus, une révision ou un recours","En cas de refus, est-il possible de demander une révision ou de faire un recours ?"]
];

const LIVE_ANALYZE_SYSTEM = `You are Arthur, a private French and Québec-French conversation copilot.

GOAL:
Identify who most likely spoke, understand real spoken Québec French, normalize meaning without erasing the raw wording, and—ONLY when the speaker is THEM—prepare a tiny private reply cue.

INPUT includes:
- expected speaker: ME or THEM
- whether Arthur just gave the learner a cue
- recent conversation turns
- raw French transcript

QUEBEC FRENCH:
Understand common Québec speech naturally, including informal pronunciation/transcription and vocabulary such as:
faque/fait que, ben, pantoute, à soir, tantôt, char, dépanneur, magasiner, c'est correct, t'sais, j'vas, chu/chus, icitte, pogner, niaiser, plate.
Do NOT assume these are errors. Interpret them in context.

SPEAKER CLASSIFICATION:
Use expected turn as a strong signal, but do not blindly alternate.
Use sentence meaning and conversational context too.
If the sentence sounds like a follow-up question or reaction from the other person, it may be THEM even if ME was expected.
If it sounds like the learner responding to the previous question/cue, it may be ME.
This is probabilistic, not biometric voice identification.

Return EXACTLY these lines:
SPEAKER: ME or THEM
CONFIDENCE: integer 0-100
NORMALIZED: clear standard French interpretation of the raw transcript
MEANING: maximum 7 simple English words
START: 2 to 5 natural French words that BEGIN a possible reply

Rules:
- If SPEAKER is ME, MEANING and START must be empty.
- Never correct the learner during Live mode.
- Never give a full scripted answer.
- Do not lecture.
- Prefer natural neutral/Canadian French for the reply starter, not forced slang.`;

const REVIEW_SYSTEM = `You are Arthur, a strict but linguistically accurate B2 French coach.
The real conversation has ended.

The transcript contains RAW and NORMALIZED text and speaker labels.
Correct ONLY turns marked ME.
Never correct THEM.

IMPORTANT QUEBEC RULE:
Distinguish actual French errors from legitimate informal Québec French.
Do not label a Québec expression as simply "wrong".
When useful, show:
- Québec oral form
- standard French equivalent
- TCF-preferred form

For every ME turn:
YOU SAID:
CORRECTED:
IMPORTANT MISTAKE:
NATURAL B2+:

Then:
RECURRING MISTAKES:
VOCABULARY GAPS:
FLUENCY / CONNECTORS:
TOP 3 DRILLS:

Finally:
QUEBEC FRENCH HEARD:
List only Québec expressions that actually appeared in the conversation.
For each: expression = standard meaning / short usage note.
If none appeared, say "None detected."

Be realistic, concise, and do not invent quotes.`;

let config = loadConfig();
let engine = null;
let recognition = null;
let session = false;
let paused = false;
let expectedSpeaker = config.defaultStarter || 'them';
let turns = [];
let finalBuffer = '';
let silenceTimer = null;
let processing = false;
let speakingCue = false;
let headphonesArmed = false;
let warmupIndex = 0;
let resumeAfterPage = false;
let arthurJustCued = false;

function loadConfig(){
  const defaults = {
    setupComplete:false,
    autoStart:true,
    cueMode:'starter',
    model:'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    defaultStarter:'them'
  };
  try{return {...defaults,...JSON.parse(localStorage.getItem(CONFIG_KEY)||'{}')}}
  catch{return defaults}
}
function saveConfig(){ localStorage.setItem(CONFIG_KEY,JSON.stringify(config)); }

function setDot(s){ $('stateDot').className='dot '+s; }
function status(t){ $('liveStatus').textContent=t; }

function setExpected(speaker){
  expectedSpeaker = speaker === 'me' ? 'me' : 'them';
  $('expectThem')?.classList.toggle('active', expectedSpeaker==='them');
  $('expectMe')?.classList.toggle('active', expectedSpeaker==='me');
  if($('speakerConfidence')) $('speakerConfidence').textContent='Expected: '+expectedSpeaker.toUpperCase();
  if($('phaseTitle')) $('phaseTitle').textContent = paused ? 'LIVE PAUSED' : (expectedSpeaker==='them'?'LISTENING TO THEM':'YOUR TURN');
  showSpeakerPanel();
}
function showSpeakerPanel(){
  if(!session || paused) return;
  $('cuePanel').classList.add('hidden');
  if(expectedSpeaker==='them'){
    $('listenPanel').classList.remove('hidden');
    $('yourPanel').classList.add('hidden');
  }else{
    $('listenPanel').classList.add('hidden');
    $('yourPanel').classList.remove('hidden');
  }
}
$('expectThem')?.addEventListener('click',()=>{stopRecognition();finalBuffer='';setExpected('them');setTimeout(startRecognition,120)});
$('expectMe')?.addEventListener('click',()=>{stopRecognition();finalBuffer='';setExpected('me');setTimeout(startRecognition,120)});

function parseLiveAnalysis(text){
  const speaker=(text.match(/SPEAKER:\s*(ME|THEM)/i)?.[1]||expectedSpeaker).toLowerCase();
  const confidence=Math.max(0,Math.min(100,Number(text.match(/CONFIDENCE:\s*(\d+)/i)?.[1]||65)));
  const normalized=(text.match(/NORMALIZED:\s*(.*)/i)?.[1]||'').trim();
  const meaning=(text.match(/MEANING:\s*(.*)/i)?.[1]||'').trim();
  const start=(text.match(/START:\s*(.*)/i)?.[1]||'').trim();
  return {speaker,confidence,normalized,meaning,start};
}

function configureAudio(){
  try{
    if(navigator.audioSession){
      navigator.audioSession.type='auto';
      setTimeout(()=>{try{navigator.audioSession.type='play-and-record'}catch{}},40);
    }
  }catch{}
}
function resetAudio(){
  try{if(navigator.audioSession) navigator.audioSession.type='auto'}catch{}
}
async function speakCue(text){
  if(!text || !headphonesArmed || !('speechSynthesis' in window)) return false;
  return new Promise(resolve=>{
    speakingCue=true;
    speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(text);
    u.lang='fr-CA';u.rate=.96;u.volume=.72;
    u.onend=()=>{speakingCue=false;resolve(true)};
    u.onerror=()=>{speakingCue=false;resolve(false)};
    speechSynthesis.speak(u);
  });
}

async function loadAI(){
  if(engine) return true;
  $('aiStatus').textContent='Loading local Qwen…';
  try{
    engine=await webllm.CreateMLCEngine(config.model,{
      initProgressCallback:p=>{
        const pct=Math.round((p.progress||0)*100);
        $('progressBar').style.width=pct+'%';
        $('aiStatus').textContent=(p.text||'Loading')+' · '+pct+'%';
        status('Preparing local AI… '+pct+'%');
      }
    });
    $('aiStatus').textContent='Arthur ready · '+config.model;
    setDot(session?'live':'ready');
    return true;
  }catch(e){
    engine=null;
    $('aiStatus').textContent='AI load failed: '+(e?.message||e);
    status('AI load failed.');
    return false;
  }
}
async function complete(messages,max_tokens=180){
  if(!engine && !(await loadAI())) throw new Error('Local AI unavailable.');
  const r=await engine.chat.completions.create({messages,temperature:.15,max_tokens});
  return r.choices?.[0]?.message?.content?.trim()||'';
}

function recentContext(){
  return turns.slice(-5).map((t,i)=>`${i+1}. ${t.speaker.toUpperCase()} RAW: ${t.raw}`).join('\n') || '(none)';
}

function newRecognition(){
  if(!SpeechRecognition) throw new Error('Speech recognition unavailable in this Safari/PWA.');
  const r=new SpeechRecognition();
  r.lang='fr-CA';
  r.continuous=true;
  r.interimResults=true;

  r.onresult=e=>{
    if(!session || paused || processing || speakingCue) return;
    let interim='', committed='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      const txt=e.results[i][0].transcript.trim();
      if(e.results[i].isFinal) committed+=(committed?' ':'')+txt;
      else interim+=(interim?' ':'')+txt;
    }
    if(committed){
      finalBuffer+=(finalBuffer?' ':'')+committed;
      clearTimeout(silenceTimer);
      silenceTimer=setTimeout(finalizeTurn,1050);
    }
    const shown=(finalBuffer+' '+interim).trim();
    if(expectedSpeaker==='them') $('partialTranscript').textContent=shown;
    else $('yourPartial').textContent=shown;
  };

  r.onerror=e=>{
    status('Speech permission/input: '+e.error);
    if(['not-allowed','service-not-allowed'].includes(e.error)) showPermissionFallback();
  };
  r.onend=()=>{
    if(session && !paused && !processing && !speakingCue){
      setTimeout(()=>{try{r.start()}catch{}},120);
    }
  };
  return r;
}
function startRecognition(){
  if(!session || paused) return;
  stopRecognition();
  finalBuffer='';
  recognition=newRecognition();
  try{recognition.start();hidePermissionFallback()}catch{showPermissionFallback()}
}
function stopRecognition(){try{recognition?.abort()}catch{} recognition=null;}

async function finalizeTurn(){
  if(!session || paused || processing || !finalBuffer.trim()) return;
  processing=true;
  const raw=finalBuffer.trim();
  finalBuffer='';
  stopRecognition();

  try{
    const analysisText=await complete([
      {role:'system',content:LIVE_ANALYZE_SYSTEM},
      {role:'user',content:
`Expected speaker: ${expectedSpeaker.toUpperCase()}
Arthur just gave learner a cue: ${arthurJustCued ? 'YES' : 'NO'}

Recent turns:
${recentContext()}

Raw transcript:
${raw}`}
    ],190);

    const a=parseLiveAnalysis(analysisText);
    const turn={
      id:Date.now()+'-'+Math.random(),
      speaker:a.speaker,
      confidence:a.confidence,
      raw,
      normalized:a.normalized || raw,
      time:Date.now()
    };
    turns.push(turn);
    renderTranscript();
    $('speakerConfidence').textContent=`Detected ${a.speaker.toUpperCase()} · ${a.confidence}%`;

    if(a.speaker==='them'){
      expectedSpeaker='me';
      arthurJustCued=true;
      $('meaningText').textContent=a.meaning;
      $('starterText').textContent=a.start;
      $('meaningBlock').classList.toggle('hidden',config.cueMode==='starter');
      $('listenPanel').classList.add('hidden');
      $('yourPanel').classList.add('hidden');
      $('cuePanel').classList.remove('hidden');

      configureAudio();
      const spoken=config.cueMode==='meaning' ? `${a.meaning}. ${a.start}` : a.start;
      const played=await speakCue(spoken);

      $('cueAudioState').textContent=headphonesArmed
        ? (played?'Cue spoken through current audio route.':'iOS blocked cue audio; tap 🎧 Arm.')
        : 'Tap 🎧 Arm once to enable private spoken cues.';

      processing=false;
      setExpected('me');
      setTimeout(()=>{
        $('cuePanel').classList.add('hidden');
        showSpeakerPanel();
        status('Your turn · saved, not corrected.');
        startRecognition();
      },played?220:650);
    }else{
      // Learner speech is saved untouched. Never correct in Live.
      expectedSpeaker='them';
      arthurJustCued=false;
      processing=false;
      setExpected('them');
      status('Listening to them…');
      startRecognition();
    }
  }catch(e){
    processing=false;
    status('Live analysis error: '+(e?.message||e));
    // Fall back to expected-turn logic rather than losing the session.
    turns.push({
      id:Date.now()+'-'+Math.random(),
      speaker:expectedSpeaker,
      confidence:40,
      raw,
      normalized:raw,
      time:Date.now()
    });
    renderTranscript();
    expectedSpeaker = expectedSpeaker==='them'?'me':'them';
    setExpected(expectedSpeaker);
    startRecognition();
  }
}

function renderTranscript(){
  const box=$('transcript');box.innerHTML='';
  turns.slice(-8).forEach(t=>{
    const d=document.createElement('div');d.className='turn';
    const tag=document.createElement('div');tag.className='tag '+(t.speaker==='me'?'me':'them');
    tag.textContent=`${t.speaker==='me'?'ME':'THEM'} · ${t.confidence}%`;
    const tx=document.createElement('div');tx.className='turnText';tx.textContent=t.raw;
    d.append(tag,tx);
    if(t.normalized && t.normalized.toLowerCase()!==t.raw.toLowerCase()){
      const n=document.createElement('div');n.className='normalized';
      n.textContent='↳ '+t.normalized;
      d.appendChild(n);
    }
    box.appendChild(d);
  });
  $('replyCount').textContent=turns.filter(t=>t.speaker==='me').length+' replies';
}

function updatePhase(){
  $('phaseTitle').textContent=paused?'LIVE PAUSED':(expectedSpeaker==='them'?'LISTENING TO THEM':'YOUR TURN');
  $('recordingLabel').textContent=paused?'● PAUSED':'● LIVE TRANSCRIPTION';
  setDot(paused?'paused':'live');
  showSpeakerPanel();
}
function showPermissionFallback(){
  $('permissionFallback').classList.remove('hidden');
  $('listenPanel').classList.add('hidden');
  $('yourPanel').classList.add('hidden');
  $('cuePanel').classList.add('hidden');
  $('liveControls').classList.add('hidden');
  $('endConversation').classList.add('hidden');
  setDot('paused');
}
function hidePermissionFallback(){
  $('permissionFallback').classList.add('hidden');
  $('liveControls').classList.remove('hidden');
  $('endConversation').classList.remove('hidden');
  showSpeakerPanel();
}

async function startLive({automatic=false}={}){
  if(!config.setupComplete){showSetupGate();return}
  if(!SpeechRecognition){showPermissionFallback();status('Speech recognition is unavailable.');return}

  $('needsSetup').classList.add('hidden');
  $('liveHome').classList.remove('hidden');
  $('recordingLabel').textContent='● STARTING LIVE…';
  $('phaseTitle').textContent='PREPARING';
  setDot('paused');

  const aiOK=await loadAI();
  if(!aiOK)return;

  configureAudio();
  session=true;paused=false;processing=false;turns=[];arthurJustCued=false;
  setExpected(config.defaultStarter || 'them');
  renderTranscript();
  status(automatic?'Auto Live starting…':'Starting Live…');

  try{startRecognition();updatePhase();status(expectedSpeaker==='them'?'Listening to them…':'Your turn…')}
  catch{showPermissionFallback()}
}

function showSetupGate(){
  $('needsSetup').classList.remove('hidden');
  $('liveHome').classList.add('hidden');
  setDot('off');
}
function pauseForNavigation(){
  if(!session || paused)return;
  paused=true;resumeAfterPage=true;stopRecognition();updatePhase();status('Live paused while you practice.');
}
function resumeFromNavigation(){
  if(session && paused && resumeAfterPage){
    paused=false;resumeAfterPage=false;updatePhase();status('Listening resumed…');startRecognition();
  }
}
function navigate(page){
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===page));
  if(page!=='home')pauseForNavigation();else resumeFromNavigation();
  if(page==='review')renderHistory();
}
document.querySelectorAll('.navTo').forEach(b=>b.onclick=()=>navigate(b.dataset.page));
document.querySelectorAll('.navHome').forEach(b=>b.onclick=()=>navigate('home'));
$('homeButton').onclick=()=>navigate('home');

// First-time default speaker
document.querySelectorAll('.starterBtn').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('.starterBtn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    config.defaultStarter=b.dataset.start;
  };
});

$('enableAutoLive').onclick=()=>{
  if(!$('autoLiveConsent').checked){
    alert('Please confirm the transcription/consent rule first.');return;
  }
  config.setupComplete=true;config.autoStart=true;saveConfig();
  $('autoStartSetting').checked=true;
  $('defaultStarter').value=config.defaultStarter;
  $('needsSetup').classList.add('hidden');$('liveHome').classList.remove('hidden');
  startLive();
};

$('tapToListen').onclick=()=>{
  if(!session) startLive();
  else{paused=false;hidePermissionFallback();startRecognition();updatePhase()}
};

$('pauseLive').onclick=()=>{
  if(!session)return;
  paused=!paused;
  if(paused){stopRecognition();status('Live paused.')}
  else{startRecognition();status('Listening resumed.')}
  updatePhase();
};

// REVERSE = change who is expected NEXT. Does not edit prior transcript.
$('reverseTurn').onclick=()=>{
  if(!session)return;
  stopRecognition();finalBuffer='';
  setExpected(expectedSpeaker==='them'?'me':'them');
  arthurJustCued=false;
  status(`Reversed · expecting ${expectedSpeaker.toUpperCase()} next.`);
  setTimeout(startRecognition,120);
};

// FIX LAST = repair an already completed turn.
$('fixLastSpeaker').onclick=()=>{
  if(!turns.length)return;
  const last=turns[turns.length-1];
  last.speaker=last.speaker==='me'?'them':'me';
  last.confidence=100;
  renderTranscript();
  $('speakerConfidence').textContent=`Last corrected manually → ${last.speaker.toUpperCase()}`;
};

$('endConversation').onclick=async()=>{
  session=false;paused=false;resumeAfterPage=false;stopRecognition();clearTimeout(silenceTimer);resetAudio();
  setDot(engine?'ready':'off');

  const mine=turns.filter(t=>t.speaker==='me');
  if(!mine.length){status('Conversation ended. No learner replies captured.');return}

  navigate('review');
  $('reviewText').textContent='Arthur is correcting only your French…';
  $('quebecReview').textContent='Analysing Québec expressions…';

  const transcript=turns.map((t,i)=>
`${i+1}. ${t.speaker.toUpperCase()} (${t.confidence}%)
RAW: ${t.raw}
NORMALIZED: ${t.normalized}`).join('\n\n');

  try{
    const review=await complete([
      {role:'system',content:REVIEW_SYSTEM},
      {role:'user',content:transcript}
    ],1400);

    const qIndex=review.indexOf('QUEBEC FRENCH HEARD:');
    if(qIndex>=0){
      $('reviewText').textContent=review.slice(0,qIndex).trim();
      $('quebecReview').textContent=review.slice(qIndex+'QUEBEC FRENCH HEARD:'.length).trim();
    }else{
      $('reviewText').textContent=review;
      $('quebecReview').textContent='No separate Québec-expression section returned.';
    }

    const h=getHistory();
    h.unshift({date:new Date().toISOString(),turns:[...turns],review});
    localStorage.setItem(HISTORY_KEY,JSON.stringify(h.slice(0,30)));
    renderHistory();
  }catch(e){
    $('reviewText').textContent='Review error: '+(e?.message||e);
    $('quebecReview').textContent='Could not analyse Québec expressions.';
  }
};

function getHistory(){try{return JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]')}catch{return[]}}
function renderHistory(){
  const box=$('history');box.innerHTML='';
  const h=getHistory();
  if(!h.length){box.innerHTML='<div class="small">No previous sessions yet.</div>';return}
  h.slice(0,10).forEach(x=>{
    const d=document.createElement('div');d.className='historyItem';
    const date=document.createElement('div');date.className='date';date.textContent=new Date(x.date).toLocaleString();
    const s=document.createElement('div');s.className='summary';s.textContent=x.review;
    d.append(date,s);box.appendChild(d);
  });
}

$('armHeadphones').onclick=async()=>{
  configureAudio();headphonesArmed=true;
  await speakCue("Arthur prêt.");
  $('armHeadphones').textContent='🎧 Armed';
  $('headphoneStatus').textContent='Headphone cues armed for this app session.';
};
$('testHeadphones').onclick=async()=>{
  configureAudio();headphonesArmed=true;
  await speakCue("Arthur connecté. Mode écouteurs prêt.");
  $('armHeadphones').textContent='🎧 Armed';
  $('headphoneStatus').textContent='If you heard that in BTH661, the active route is ready.';
};

$('loadAI').onclick=async()=>{
  config.model=$('model').value;saveConfig();
  if(engine){try{await engine.unload?.()}catch{} engine=null}
  await loadAI();
};
$('cueMode').onchange=e=>{config.cueMode=e.target.value;saveConfig()};
$('autoStartSetting').onchange=e=>{config.autoStart=e.target.checked;saveConfig()};
$('defaultStarter').onchange=e=>{
  config.defaultStarter=e.target.value;saveConfig();
  if(!session)setExpected(config.defaultStarter);
};
$('resetSetup').onclick=()=>{
  if(confirm('Reset Auto Live first-time setup?')){
    config.setupComplete=false;config.autoStart=true;saveConfig();
    session=false;stopRecognition();showSetupGate();navigate('home');
  }
};

// TCF warm-up
function updateWarmup(){
  $('warmupNumber').textContent=`QUESTION ${warmupIndex+1} / ${WARMUPS.length}`;
  $('warmupCue').textContent=`Pose une question sur ${WARMUPS[warmupIndex][0]}.`;
  $('warmupInput').value='';
  $('warmupTarget').textContent=WARMUPS[warmupIndex][1];
  $('warmupTarget').classList.add('hidden');
}
$('startWarmup').onclick=()=>{$('warmupArea').classList.remove('hidden');updateWarmup()};
$('checkWarmup').onclick=()=>{if($('warmupInput').value.trim())$('warmupTarget').classList.remove('hidden')};
$('nextWarmup').onclick=()=>{warmupIndex=(warmupIndex+1)%WARMUPS.length;updateWarmup()};

// Extra practice
const extras={
  daily:"Situation: Tu rencontres quelqu'un au travail après le week-end. Commence une conversation naturelle en français et pose une question de suivi.",
  listening:"Listening mode will include standard French and authentic Québec-French patterns.",
  rescue:"Quick rescue drill: Someone asks « Qu'est-ce que t'en penses ? » Start immediately with 3–5 natural French words.",
  mistakes:"Finish real Live conversations first. Arthur will turn your recurring mistakes and Québec expressions into drills."
};
document.querySelectorAll('.extraCard').forEach(b=>{
  b.onclick=()=>{$('extraOutput').querySelector('.practicePrompt').textContent=extras[b.dataset.extra]};
});
document.querySelectorAll('.coming').forEach(b=>{
  b.onclick=()=>alert('TCF Tâche 2/3 will use the same local Qwen engine; this remains in the next implementation pass.');
});

// Setup UI
$('model').value=config.model;
$('cueMode').value=config.cueMode;
$('autoStartSetting').checked=config.autoStart;
$('defaultStarter').value=config.defaultStarter;
setExpected(config.defaultStarter);

async function boot(){
  renderHistory();
  if(!config.setupComplete){showSetupGate();return}
  $('needsSetup').classList.add('hidden');$('liveHome').classList.remove('hidden');
  if(config.autoStart){
    try{await startLive({automatic:true})}catch{showPermissionFallback()}
  }else{
    showPermissionFallback();
    document.querySelector('.fallbackTitle').textContent='Live is ready.';
    document.querySelector('.fallbackText').textContent='Auto-start is disabled in Setup.';
  }
}
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
    boot();
  });
}else window.addEventListener('load',boot);
