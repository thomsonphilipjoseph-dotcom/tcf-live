import * as webllm from "https://esm.run/@mlc-ai/web-llm@0.2.82";

const $ = id => document.getElementById(id);
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const CONFIG_KEY = 'tcf-live-v7-config';
const HISTORY_KEY = 'tcf-live-v7-history';

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

const REVIEW_SYSTEM = `You are Arthur, a strict but linguistically accurate B2 French coach.
The real conversation has ended.

Correct ONLY turns marked ME. Never correct THEM.
Distinguish actual mistakes from legitimate informal Québec French.

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
List only Québec expressions actually present.
For each: expression = standard meaning / short usage note.
If none appeared, say "None detected."
Do not invent quotes.`;

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

// v7 sentence-copilot state
let meTurnBuffer = '';
let meAssistTimer = null;
let meFinishTimer = null;
let assistanceLog = [];
let assistanceCount = 0;
let autoAssistEnabled = config.autoAssist !== false;

function loadConfig(){
  const defaults = {
    setupComplete:false,
    autoStart:true,
    cueMode:'starter',
    model:'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    defaultStarter:'them',
    autoAssist:true
  };
  try{return {...defaults,...JSON.parse(localStorage.getItem(CONFIG_KEY)||'{}')}}
  catch{return defaults}
}
function saveConfig(){ localStorage.setItem(CONFIG_KEY,JSON.stringify(config)); }

function setDot(s){ if($('stateDot')) $('stateDot').className='dot '+s; }
function status(t){ if($('liveStatus')) $('liveStatus').textContent=t; }

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
    u.lang='fr-CA';
    u.rate=.96;
    u.volume=.72;
    u.onend=()=>{speakingCue=false;resolve(true)};
    u.onerror=()=>{speakingCue=false;resolve(false)};
    speechSynthesis.speak(u);
  });
}

/* ------------------------------------------------------------------
   FAST LIVE CUE ENGINE
   This is intentionally lightweight so iPhone Live mode does NOT
   require loading/inferencing a 1GB+ language model while the mic runs.
------------------------------------------------------------------- */

function simplify(s){
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[’']/g,"'")
    .replace(/\s+/g,' ')
    .trim();
}

function normalizeQuebecFrench(raw){
  let s = raw || '';
  const rules = [
    [/\bfaque\b|\bfait que\b/gi, 'alors'],
    [/\bben\b/gi, 'bien'],
    [/\bpantoute\b/gi, 'pas du tout'],
    [/\bà soir\b|\ba soir\b/gi, 'ce soir'],
    [/\bicitte\b/gi, 'ici'],
    [/\bt['’]?sais\b/gi, 'tu sais'],
    [/\bj['’]?vas\b/gi, 'je vais'],
    [/\bchu\b|\bchus\b/gi, 'je suis'],
    [/\bchar\b/gi, 'voiture'],
    [/\bdépanneur\b/gi, 'dépanneur'],
    [/\bmagasiner\b/gi, 'faire des achats']
  ];
  for(const [rx, rep] of rules) s = s.replace(rx, rep);

  // Québec yes/no question pattern: "t'es-tu libre" -> "est-ce que tu es libre"
  s = s.replace(/\bt['’]?es[- ]?tu\b/gi, 'est-ce que tu es');
  s = s.replace(/\btu vas[- ]?tu\b/gi, 'est-ce que tu vas');
  s = s.replace(/\btu veux[- ]?tu\b/gi, 'est-ce que tu veux');
  return s.replace(/\s+/g,' ').trim();
}

function likelyQuestion(s){
  const x=simplify(s);
  const questionish = [
    'est-ce que','es tu','t es tu','tu veux','tu peux','peux tu','pourquoi',
    'comment','combien','quand','ou ','où','quel','quelle','quels','quelles',
    'qu est ce','quoi','qui','depuis combien','ca fait combien','ça fait combien',
    'tu fais quoi','tu viens d ou','tu viens d’où','tu habites','tu travailles',
    'tu penses','ton avis','disponible','libre ce soir','libre a soir'
  ];
  return questionish.some(k=>x.includes(simplify(k))) || /\?$/.test(s.trim());
}

function classifySpeaker(raw){
  const x=simplify(raw);

  // Strongly prefer expected state.
  let speaker=expectedSpeaker;
  let confidence=82;

  // If we expect ME after giving a cue but hear an obvious follow-up question,
  // treat it as an interruption / continued THEM turn.
  if(expectedSpeaker==='me' && likelyQuestion(raw)){
    speaker='them';
    confidence=78;
  }

  // If we expect THEM but hear a classic first-person answer, it may be ME.
  const meSignals = [
    'je suis','j habite','je travaille','je pense','a mon avis','à mon avis',
    'je prefere','je préfère','j aime','j’aime','je vais','moi je','ca fait',
    'ça fait','oui je','non je','personnellement'
  ];
  const answerLike = meSignals.some(k=>x.includes(simplify(k)));

  if(expectedSpeaker==='them' && arthurJustCued && answerLike){
    speaker='me';
    confidence=76;
  }

  return {speaker,confidence};
}

function cueFor(raw){
  const x=simplify(raw);
  let meaning='They are talking to you.';
  let start='Oui, je…';

  // Time / duration
  if(x.includes('combien de temps') || x.includes('depuis') || x.includes('ca fait combien') || x.includes('ça fait combien')){
    meaning='Asking how long.';
    start='Ça fait environ…';
  }
  // Origin
  else if(x.includes('tu viens d') || x.includes("d'ou") || x.includes('d’où') || x.includes('origine')){
    meaning='Asking where you are from.';
    start='Je viens de…';
  }
  // Work
  else if(x.includes('tu fais quoi') || x.includes('tu travailles') || x.includes('travail') || x.includes('job') || x.includes('domaine')){
    meaning='Asking about your work.';
    start='Je travaille dans…';
  }
  // Residence / location
  else if(x.includes('tu habites') || x.includes('tu vis') || x.includes('tu restes ou') || x.includes('tu restes où')){
    meaning='Asking where you live.';
    start='J’habite à…';
  }
  // Availability / invitation
  else if(x.includes('libre') || x.includes('disponible') || x.includes('ce soir') || x.includes('a soir') || x.includes('à soir')){
    meaning='Asking if you are available.';
    start='Oui, normalement…';
  }
  // Why
  else if(x.includes('pourquoi')){
    meaning='Asking why.';
    start='C’est surtout parce que…';
  }
  // Opinion
  else if(x.includes('tu penses') || x.includes('ton avis') || x.includes("qu'est-ce que t'en penses") || x.includes('qu est ce que t en penses')){
    meaning='Asking your opinion.';
    start='Personnellement, je pense…';
  }
  // Preference
  else if(x.includes('tu preferes') || x.includes('tu préfères') || x.includes('tu aimes mieux') || x.includes('prefere') || x.includes('préfère')){
    meaning='Asking what you prefer.';
    start='Je préfère plutôt…';
  }
  // Weekend
  else if(x.includes('fin de semaine') || x.includes('weekend') || x.includes('week-end')){
    meaning='Asking about your weekend.';
    start='Cette fin de semaine…';
  }
  // Plans / what will you do
  else if(x.includes('tu vas faire') || x.includes('qu est ce que tu vas') || x.includes("qu'est-ce que tu vas")){
    meaning='Asking about your plans.';
    start='Je vais probablement…';
  }
  // How / condition
  else if(x.includes('comment ca va') || x.includes('comment ça va') || x==='ca va' || x==='ça va'){
    meaning='Asking how you are.';
    start='Ça va bien…';
  }
  // Name
  else if(x.includes('comment tu t appelles') || x.includes("t'appelles") || x.includes('ton nom')){
    meaning='Asking your name.';
    start='Je m’appelle…';
  }
  // Age
  else if(x.includes('quel age') || x.includes('quel âge') || x.includes('tu as quel age') || x.includes('tu as quel âge')){
    meaning='Asking your age.';
    start='J’ai…';
  }
  // When
  else if(x.includes('quand') || x.includes('quelle heure') || x.includes('a quelle heure') || x.includes('à quelle heure')){
    meaning='Asking when.';
    start='Normalement, vers…';
  }
  // Where
  else if(x.startsWith('ou ') || x.includes(' où ') || x.includes('ou est') || x.includes('où est')){
    meaning='Asking where.';
    start='C’est près de…';
  }
  // How
  else if(x.includes('comment')){
    meaning='Asking how.';
    start='En général, je…';
  }
  // Yes/no "do you..."
  else if(x.includes('est ce que') || x.startsWith('tu ') || x.includes('t es tu')){
    meaning='A yes-or-no question.';
    start='Oui, en général…';
  }
  // Statement/reaction
  else if(!likelyQuestion(raw)){
    meaning='They made a comment.';
    start='Oui, je comprends…';
  }

  return {meaning,start};
}

function fastAnalyze(raw){
  const cls=classifySpeaker(raw);
  const normalized=normalizeQuebecFrench(raw);
  const cue=cls.speaker==='them' ? cueFor(normalized) : {meaning:'',start:''};
  return {...cls,normalized,...cue};
}


/* ------------------------------------------------------------------
   v7 ME-SIDE SENTENCE COPILOT
   Gives tiny continuation cues while the learner is speaking.
   No correction happens during Live.
------------------------------------------------------------------- */

function endsLikeCompleteIdea(raw){
  const s = simplify(raw);
  if(!s) return false;
  if(/[.!?…]$/.test(raw.trim())) return true;

  const unfinished = [
    'et','mais','parce que','car','donc','alors','aussi','ensuite',
    'quand','si','comme','pour','avec','sans','de','du','des','un','une',
    'je veux','je voulais','je pense','je crois','j aime','j’aime',
    'je travaille','je vais','je suis','ca fait','ça fait','en plus'
  ];
  if(unfinished.some(x => s.endsWith(simplify(x)))) return false;
  return s.split(' ').length >= 7;
}

function looksUnfinished(raw){
  const s = simplify(raw);
  if(!s) return false;
  const tails = [
    'et','mais','parce que','car','donc','alors','aussi','ensuite',
    'quand','si','comme','pour','avec','sans','de','du','des','un','une',
    'je veux','je voulais','je voudrais','je pense','je crois',
    'j aime','j’aime','je travaille','je vais','je suis',
    'c est','c’est','ca fait','ça fait','il y a','en plus',
    'principalement','surtout','normalement','generalement','généralement'
  ];
  if(tails.some(x => s.endsWith(simplify(x)))) return true;
  if(/\b(euh|heu|hmm|hum|genre|comme)\s*$/.test(s)) return true;
  return s.split(' ').length <= 5 && !/[.!?…]$/.test(raw.trim());
}

function continuationFor(raw){
  const s = simplify(raw);
  let kind = 'phrase';
  let cue = 'et aussi…';

  if(s.endsWith('parce que') || s.endsWith('car')) cue = 'je voulais surtout…';
  else if(s.endsWith('je voulais') || s.endsWith('je veux')) cue = 'avoir une meilleure…';
  else if(s.endsWith('une meilleure')) cue = 'qualité de vie…';
  else if(s.endsWith('je travaille comme')) cue = 'technicien en…';
  else if(s.endsWith('je travaille') || s.endsWith('au travail je')) cue = 'principalement sur…';
  else if(s.endsWith('je pense') || s.endsWith('je crois')) cue = 'que c’est important…';
  else if(s.endsWith('a mon avis') || s.endsWith('à mon avis')) cue = 'c’est une bonne…';
  else if(s.endsWith('j aime') || s.endsWith('j’aime')) cue = 'faire du sport…';
  else if(s.endsWith('je vais')) cue = 'probablement essayer de…';
  else if(s.endsWith('je suis')) cue = 'plutôt quelqu’un qui…';
  else if(s.endsWith('et')) cue = 'en plus…';
  else if(s.endsWith('mais')) cue = 'en même temps…';
  else if(s.endsWith('aussi')) cue = 'j’essaie de…';
  else if(s.endsWith('en plus')) cue = 'j’essaie aussi de…';
  else if(s.endsWith('avec')) cue = 'mes amis…';
  else if(s.endsWith('pour')) cue = 'améliorer mon français…';
  else if((s.includes('temps libre')) && (s.endsWith('et') || s.endsWith('aussi'))) cue = 'passer du temps…';
  else if(endsLikeCompleteIdea(raw)) { cue = 'Et aussi…'; kind = 'next'; }

  return {cue, kind};
}

function oneWordRescue(raw){
  const s = simplify(raw);
  if(s.endsWith('une meilleure')) return 'qualité';
  if(s.endsWith('je travaille comme')) return 'technicien';
  if(s.endsWith('parce que')) return 'principalement';
  if(s.endsWith('avec')) return 'mes';
  if(s.endsWith('pour')) return 'améliorer';
  if(s.endsWith('et')) return 'aussi';
  if(s.endsWith('mais')) return 'cependant';
  return 'ensuite';
}

async function deliverMeAssist(level='phrase'){
  if(!session || paused || expectedSpeaker!=='me' || processing || speakingCue) return;
  const raw = (meTurnBuffer || finalBuffer).trim();
  if(!raw) return;

  clearTimeout(meAssistTimer);
  clearTimeout(meFinishTimer);

  const result = continuationFor(raw);
  let text = level==='word' ? oneWordRescue(raw) : result.cue;
  let type = level==='word' ? 'word' : result.kind;

  assistanceCount++;
  assistanceLog.push({time:Date.now(), sourceText:raw, suggestion:text, type});
  if($('assistCount')) $('assistCount').textContent=assistanceCount+' assists';

  stopRecognition();
  if($('meaningBlock')) $('meaningBlock').classList.add('hidden');
  if($('starterText')) $('starterText').textContent=text;
  $('cuePanel')?.classList.remove('hidden');
  $('yourPanel')?.classList.add('hidden');
  $('listenPanel')?.classList.add('hidden');

  status(type==='next' ? 'Next-idea cue…' : 'Sentence rescue…');
  configureAudio();
  await speakCue(text);

  setTimeout(()=>{
    $('cuePanel')?.classList.add('hidden');
    $('yourPanel')?.classList.remove('hidden');
    status('Keep speaking · no correction.');
    startRecognition({preserveMeBuffer:true});
  },180);
}

function scheduleMePauseHandling(){
  clearTimeout(meAssistTimer);
  clearTimeout(meFinishTimer);

  meAssistTimer=setTimeout(()=>{
    if(!session || paused || expectedSpeaker!=='me' || processing || speakingCue) return;
    const raw=(meTurnBuffer || finalBuffer).trim();
    if(raw && autoAssistEnabled && looksUnfinished(raw)) deliverMeAssist('phrase');
  },1250);

  meFinishTimer=setTimeout(()=>{
    if(!session || paused || expectedSpeaker!=='me' || processing || speakingCue) return;
    const raw=(meTurnBuffer || finalBuffer).trim();
    if(!raw) return;
    if(endsLikeCompleteIdea(raw) || !looksUnfinished(raw)) finalizeMeTurn();
    else if(autoAssistEnabled) deliverMeAssist('phrase');
  },2650);
}

async function finalizeMeTurn(){
  if(!session || paused || processing || expectedSpeaker!=='me') return;
  const raw=(meTurnBuffer || finalBuffer).trim();
  if(!raw) return;

  processing=true;
  clearTimeout(meAssistTimer); clearTimeout(meFinishTimer);
  stopRecognition();
  meTurnBuffer=''; finalBuffer='';

  const a=fastAnalyze(raw);
  turns.push({
    id:Date.now()+'-'+Math.random(),
    speaker:'me', confidence:Math.max(80,a.confidence || 80),
    raw, normalized:a.normalized||raw,
    assists:assistanceLog.slice(), time:Date.now()
  });
  renderTranscript();
  arthurJustCued=false;
  processing=false;
  setExpected('them');
  status('Listening to them…');
  startRecognition();
}

function ensureRescueUI(){
  const controls=$('liveControls');
  if(controls && !$('rescueNow')){
    const btn=document.createElement('button');
    btn.id='rescueNow'; btn.className='secondary'; btn.textContent='⚡ Rescue';
    btn.addEventListener('click',()=>deliverMeAssist('phrase'));
    controls.appendChild(btn);
  }

  if($('replyCount') && !$('assistCount')){
    const c=document.createElement('div');
    c.id='assistCount'; c.className='counter'; c.style.marginTop='4px'; c.textContent='0 assists';
    $('replyCount').parentElement?.appendChild(c);
  }

  const setupPage=$('setup');
  if(setupPage && !$('autoAssistSetting')){
    const cards=setupPage.querySelectorAll('.card');
    const anchor=cards[cards.length-1];
    if(anchor){
      const card=document.createElement('div');
      card.className='card';
      card.innerHTML=`<div class="label">SENTENCE COPILOT</div>
        <label class="switchrow"><span>Automatically help when I hesitate mid-sentence</span>
        <input id="autoAssistSetting" type="checkbox" ${autoAssistEnabled?'checked':''}></label>
        <p class="small">~1.25 s + unfinished phrase → next few words. ~2.65 s after a complete idea → your turn ends.</p>`;
      anchor.insertAdjacentElement('beforebegin',card);
      $('autoAssistSetting').addEventListener('change',e=>{
        autoAssistEnabled=e.target.checked; config.autoAssist=autoAssistEnabled; saveConfig();
      });
    }
  }
}

/* ----------------------- QWEN: OPTIONAL ----------------------- */

async function loadAI(){
  if(engine) return true;

  // iPhone safety: force the smallest live-compatible option.
  const isiPhone=/iPhone|iPod/i.test(navigator.userAgent);
  if(isiPhone){
    config.model='Qwen2.5-0.5B-Instruct-q4f16_1-MLC';
    if($('model')) $('model').value=config.model;
    saveConfig();
  }

  if(!navigator.gpu){
    if($('aiStatus')) $('aiStatus').textContent='WebGPU unavailable. Live cues still work without Qwen.';
    return false;
  }

  if($('aiStatus')) $('aiStatus').textContent='Loading optional Qwen…';
  try{
    engine=await webllm.CreateMLCEngine(config.model,{
      initProgressCallback:p=>{
        const pct=Math.round((p.progress||0)*100);
        if($('progressBar')) $('progressBar').style.width=pct+'%';
        if($('aiStatus')) $('aiStatus').textContent=(p.text||'Loading')+' · '+pct+'%';
      }
    });
    if($('aiStatus')) $('aiStatus').textContent='Qwen ready · optional review AI';
    return true;
  }catch(e){
    engine=null;
    if($('aiStatus')) $('aiStatus').textContent='Qwen unavailable. Live cues still work.';
    return false;
  }
}

async function complete(messages,max_tokens=900){
  if(!engine) throw new Error('Qwen not loaded');
  const r=await engine.chat.completions.create({messages,temperature:.15,max_tokens});
  return r.choices?.[0]?.message?.content?.trim()||'';
}

/* ----------------------- SPEECH ----------------------- */

function newRecognition(){
  if(!SpeechRecognition) throw new Error('Speech recognition unavailable in this Safari/PWA.');
  const r=new SpeechRecognition();
  r.lang='fr-CA';
  r.continuous=true;
  r.interimResults=true;

  r.onresult=e=>{
    if(!session || paused || processing || speakingCue) return;
    let interim='',committed='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      const txt=e.results[i][0].transcript.trim();
      if(e.results[i].isFinal) committed+=(committed?' ':'')+txt;
      else interim+=(interim?' ':'')+txt;
    }

    if(expectedSpeaker==='me'){
      if(committed){
        meTurnBuffer+=(meTurnBuffer?' ':'')+committed;
        finalBuffer='';
        scheduleMePauseHandling();
      }
      const shown=(meTurnBuffer+' '+interim).trim();
      if($('yourPartial')) $('yourPartial').textContent=shown;
    }else{
      if(committed){
        finalBuffer+=(finalBuffer?' ':'')+committed;
        clearTimeout(silenceTimer);
        silenceTimer=setTimeout(finalizeTurn,900);
      }
      const shown=(finalBuffer+' '+interim).trim();
      if($('partialTranscript')) $('partialTranscript').textContent=shown;
    }
  };

  r.onerror=e=>{
    status('Speech: '+e.error);
    if(['not-allowed','service-not-allowed'].includes(e.error)) showPermissionFallback();
  };
  r.onend=()=>{
    if(session && !paused && !processing && !speakingCue){
      setTimeout(()=>{try{r.start()}catch{}},120);
    }
  };
  return r;
}
function startRecognition(opts={}){
  if(!session || paused)return;
  stopRecognition();
  finalBuffer='';
  if(expectedSpeaker!=='me' || !opts.preserveMeBuffer){
    if(expectedSpeaker!=='me') meTurnBuffer='';
  }
  recognition=newRecognition();
  try{recognition.start();hidePermissionFallback()}
  catch{showPermissionFallback()}
}
function stopRecognition(){
  try{recognition?.abort()}catch{}
  recognition=null;
}

async function finalizeTurn(){
  // THEM turns use this. ME turns are hesitation-aware.
  if(expectedSpeaker==='me'){ scheduleMePauseHandling(); return; }
  if(!session || paused || processing || !finalBuffer.trim())return;

  processing=true;
  const raw=finalBuffer.trim();
  finalBuffer='';
  stopRecognition();

  // Critical v6 change: cue generation is immediate and DOES NOT call Qwen.
  const a=fastAnalyze(raw);

  const turn={
    id:Date.now()+'-'+Math.random(),
    speaker:a.speaker,
    confidence:a.confidence,
    raw,
    normalized:a.normalized||raw,
    time:Date.now()
  };
  turns.push(turn);
  renderTranscript();

  if($('speakerConfidence')){
    $('speakerConfidence').textContent=`Detected ${a.speaker.toUpperCase()} · ${a.confidence}%`;
  }

  if(a.speaker==='them'){
    expectedSpeaker='me';
    arthurJustCued=true;
    meTurnBuffer='';
    clearTimeout(meAssistTimer); clearTimeout(meFinishTimer);

    if($('meaningText')) $('meaningText').textContent=a.meaning;
    if($('starterText')) $('starterText').textContent=a.start;
    if($('meaningBlock')) $('meaningBlock').classList.toggle('hidden',config.cueMode==='starter');

    $('listenPanel')?.classList.add('hidden');
    $('yourPanel')?.classList.add('hidden');
    $('cuePanel')?.classList.remove('hidden');

    configureAudio();
    const spoken=config.cueMode==='meaning' ? `${a.meaning}. ${a.start}` : a.start;
    const played=await speakCue(spoken);

    if($('cueAudioState')){
      $('cueAudioState').textContent=headphonesArmed
        ? (played?'Cue spoken through current audio route.':'Tap 🎧 Arm to enable spoken cues.')
        : 'Tap 🎧 Arm once to enable private spoken cues.';
    }

    processing=false;
    setExpected('me');

    setTimeout(()=>{
      $('cuePanel')?.classList.add('hidden');
      showSpeakerPanel();
      status('Your turn · no correction.');
      startRecognition();
    },played?180:650);

  }else{
    arthurJustCued=false;
    processing=false;
    setExpected('them');
    status('Listening to them…');
    startRecognition();
  }
}

function setExpected(speaker){
  expectedSpeaker=speaker==='me'?'me':'them';
  $('expectThem')?.classList.toggle('active',expectedSpeaker==='them');
  $('expectMe')?.classList.toggle('active',expectedSpeaker==='me');
  if($('speakerConfidence')) $('speakerConfidence').textContent='Expected: '+expectedSpeaker.toUpperCase();
  updatePhase();
}
function showSpeakerPanel(){
  if(!session||paused)return;
  $('cuePanel')?.classList.add('hidden');
  if(expectedSpeaker==='them'){
    $('listenPanel')?.classList.remove('hidden');
    $('yourPanel')?.classList.add('hidden');
  }else{
    $('listenPanel')?.classList.add('hidden');
    $('yourPanel')?.classList.remove('hidden');
  }
}
function updatePhase(){
  if($('phaseTitle')) $('phaseTitle').textContent=paused?'LIVE PAUSED':(expectedSpeaker==='them'?'LISTENING TO THEM':'YOUR TURN');
  if($('recordingLabel')) $('recordingLabel').textContent=paused?'● PAUSED':'● LIVE TRANSCRIPTION';
  setDot(paused?'paused':'live');
  showSpeakerPanel();
}
function renderTranscript(){
  const box=$('transcript');
  if(!box)return;
  box.innerHTML='';
  turns.slice(-8).forEach(t=>{
    const d=document.createElement('div');d.className='turn';
    const tag=document.createElement('div');tag.className='tag '+(t.speaker==='me'?'me':'them');
    tag.textContent=`${t.speaker==='me'?'ME':'THEM'} · ${t.confidence}%`;
    const tx=document.createElement('div');tx.className='turnText';tx.textContent=t.raw;
    d.append(tag,tx);
    if(t.normalized && simplify(t.normalized)!==simplify(t.raw)){
      const n=document.createElement('div');n.className='normalized';n.textContent='↳ '+t.normalized;d.appendChild(n);
    }
    box.appendChild(d);
  });
  if($('replyCount')) $('replyCount').textContent=turns.filter(t=>t.speaker==='me').length+' replies';
  if($('assistCount')) $('assistCount').textContent=assistanceCount+' assists';
}

function showPermissionFallback(){
  $('permissionFallback')?.classList.remove('hidden');
  $('listenPanel')?.classList.add('hidden');
  $('yourPanel')?.classList.add('hidden');
  $('cuePanel')?.classList.add('hidden');
  $('liveControls')?.classList.add('hidden');
  $('endConversation')?.classList.add('hidden');
  setDot('paused');
}
function hidePermissionFallback(){
  $('permissionFallback')?.classList.add('hidden');
  $('liveControls')?.classList.remove('hidden');
  $('endConversation')?.classList.remove('hidden');
  showSpeakerPanel();
}

async function startLive({automatic=false}={}){
  if(!config.setupComplete){showSetupGate();return}
  if(!SpeechRecognition){showPermissionFallback();status('Speech recognition unavailable.');return}

  $('needsSetup')?.classList.add('hidden');
  $('liveHome')?.classList.remove('hidden');

  // v6: DO NOT LOAD QWEN HERE.
  // Live must start immediately and remain memory-safe.
  configureAudio();
  session=true;
  paused=false;
  processing=false;
  turns=[];
  meTurnBuffer=''; assistanceLog=[]; assistanceCount=0;
  clearTimeout(meAssistTimer); clearTimeout(meFinishTimer);
  arthurJustCued=false;
  setExpected(config.defaultStarter||'them');
  renderTranscript();

  status(automatic?'Auto Live · lightweight cue engine ready.':'Live cue engine ready.');
  try{startRecognition();updatePhase()}
  catch{showPermissionFallback()}
}

function showSetupGate(){
  $('needsSetup')?.classList.remove('hidden');
  $('liveHome')?.classList.add('hidden');
  setDot('off');
}
function pauseForNavigation(){
  if(!session||paused)return;
  paused=true;resumeAfterPage=true;stopRecognition();updatePhase();
}
function resumeFromNavigation(){
  if(session&&paused&&resumeAfterPage){
    paused=false;resumeAfterPage=false;updatePhase();startRecognition();
  }
}
function navigate(page){
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===page));
  if(page!=='home')pauseForNavigation();else resumeFromNavigation();
  if(page==='review')renderHistory();
}

document.querySelectorAll('.navTo').forEach(b=>b.onclick=()=>navigate(b.dataset.page));
document.querySelectorAll('.navHome').forEach(b=>b.onclick=()=>navigate('home'));
if($('homeButton')) $('homeButton').onclick=()=>navigate('home');

document.querySelectorAll('.starterBtn').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('.starterBtn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    config.defaultStarter=b.dataset.start;
  };
});

if($('enableAutoLive')) $('enableAutoLive').onclick=()=>{
  if(!$('autoLiveConsent').checked){
    alert('Please confirm the transcription/consent rule first.');return;
  }
  config.setupComplete=true;config.autoStart=true;saveConfig();
  if($('autoStartSetting')) $('autoStartSetting').checked=true;
  if($('defaultStarter')) $('defaultStarter').value=config.defaultStarter;
  $('needsSetup').classList.add('hidden');
  $('liveHome').classList.remove('hidden');
  startLive();
};

if($('tapToListen')) $('tapToListen').onclick=()=>{
  if(!session)startLive();
  else{paused=false;hidePermissionFallback();startRecognition();updatePhase()}
};

if($('pauseLive')) $('pauseLive').onclick=()=>{
  if(!session)return;
  paused=!paused;
  if(paused){stopRecognition();status('Live paused.')}
  else{startRecognition();status('Listening resumed.')}
  updatePhase();
};

if($('reverseTurn')) $('reverseTurn').onclick=()=>{
  if(!session)return;
  stopRecognition();finalBuffer='';meTurnBuffer='';
  clearTimeout(meAssistTimer);clearTimeout(meFinishTimer);
  setExpected(expectedSpeaker==='them'?'me':'them');
  arthurJustCued=false;
  status(`Reversed · expecting ${expectedSpeaker.toUpperCase()} next.`);
  setTimeout(startRecognition,120);
};

if($('fixLastSpeaker')) $('fixLastSpeaker').onclick=()=>{
  if(!turns.length)return;
  const last=turns[turns.length-1];
  last.speaker=last.speaker==='me'?'them':'me';
  last.confidence=100;
  renderTranscript();
  if($('speakerConfidence')) $('speakerConfidence').textContent=`Last corrected manually → ${last.speaker.toUpperCase()}`;
};

$('expectThem')?.addEventListener('click',()=>{stopRecognition();finalBuffer='';setExpected('them');setTimeout(startRecognition,120)});
$('expectMe')?.addEventListener('click',()=>{stopRecognition();finalBuffer='';setExpected('me');setTimeout(startRecognition,120)});

function localReview(){
  const me=turns.filter(t=>t.speaker==='me');
  let out='Qwen is not loaded, so the conversation was saved safely.\n\nYOUR TURNS:\n';
  out += me.map((t,i)=>`${i+1}. ${t.raw}`).join('\n');
  out += '\n\nLoad Qwen from Setup only when you want deeper after-conversation correction.';
  return out;
}

if($('endConversation')) $('endConversation').onclick=async()=>{
  if(session && expectedSpeaker==='me' && meTurnBuffer.trim()){
    const raw=meTurnBuffer.trim();
    const a=fastAnalyze(raw);
    turns.push({id:Date.now()+'-'+Math.random(),speaker:'me',confidence:90,raw,normalized:a.normalized||raw,time:Date.now()});
    meTurnBuffer='';
  }
  session=false;paused=false;resumeAfterPage=false;
  clearTimeout(meAssistTimer);clearTimeout(meFinishTimer);
  stopRecognition();clearTimeout(silenceTimer);resetAudio();
  setDot(engine?'ready':'off');

  const mine=turns.filter(t=>t.speaker==='me');
  if(!mine.length){status('Conversation ended. No learner replies captured.');return}

  navigate('review');
  $('reviewText').textContent='Preparing review…';
  $('quebecReview').textContent='Checking expressions…';

  const transcript=turns.map((t,i)=>
`${i+1}. ${t.speaker.toUpperCase()} (${t.confidence}%)
RAW: ${t.raw}
NORMALIZED: ${t.normalized}`).join('\n\n');

  let review;
  if(engine){
    try{
      review=await complete([
        {role:'system',content:REVIEW_SYSTEM},
        {role:'user',content:transcript}
      ],1200);
    }catch{
      review=localReview();
    }
  }else{
    review=localReview();
  }

  const qIndex=review.indexOf('QUEBEC FRENCH HEARD:');
  if(qIndex>=0){
    $('reviewText').textContent=review.slice(0,qIndex).trim();
    $('quebecReview').textContent=review.slice(qIndex+'QUEBEC FRENCH HEARD:'.length).trim();
  }else{
    $('reviewText').textContent=review;
    const heard=[];
    const joined=turns.map(t=>simplify(t.raw)).join(' ');
    [
      ['faque','donc / alors'],
      ['pantoute','pas du tout'],
      ['a soir','ce soir'],
      ['tantot','tout à l’heure / plus tard, selon contexte'],
      ['char','voiture'],
      ['depanneur','dépanneur / convenience store'],
      ['icitte','ici'],
      ['chu','je suis'],
      ['j vas','je vais']
    ].forEach(([k,v])=>{if(joined.includes(k))heard.push(`${k} = ${v}`)});
    $('quebecReview').textContent=heard.length?heard.join('\n'):'No Québec expressions detected by the lightweight layer.';
  }

  const h=getHistory();
  h.unshift({date:new Date().toISOString(),turns:[...turns],review});
  localStorage.setItem(HISTORY_KEY,JSON.stringify(h.slice(0,30)));
  renderHistory();
};

function getHistory(){try{return JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]')}catch{return[]}}
function renderHistory(){
  const box=$('history');if(!box)return;
  box.innerHTML='';
  const h=getHistory();
  if(!h.length){box.innerHTML='<div class="small">No previous sessions yet.</div>';return}
  h.slice(0,10).forEach(x=>{
    const d=document.createElement('div');d.className='historyItem';
    const date=document.createElement('div');date.className='date';date.textContent=new Date(x.date).toLocaleString();
    const s=document.createElement('div');s.className='summary';s.textContent=x.review;
    d.append(date,s);box.appendChild(d);
  });
}

if($('armHeadphones')) $('armHeadphones').onclick=async()=>{
  configureAudio();headphonesArmed=true;
  await speakCue("Arthur prêt.");
  $('armHeadphones').textContent='🎧 Armed';
  if($('headphoneStatus')) $('headphoneStatus').textContent='Headphone cues armed for this app session.';
};
if($('testHeadphones')) $('testHeadphones').onclick=async()=>{
  configureAudio();headphonesArmed=true;
  await speakCue("Arthur connecté. Mode écouteurs prêt.");
  if($('armHeadphones')) $('armHeadphones').textContent='🎧 Armed';
  if($('headphoneStatus')) $('headphoneStatus').textContent='If you heard that in BTH661, the active route is ready.';
};

if($('loadAI')) $('loadAI').onclick=async()=>{
  // Always use 0.5B on iPhone v6.
  if(/iPhone|iPod/i.test(navigator.userAgent)){
    config.model='Qwen2.5-0.5B-Instruct-q4f16_1-MLC';
    if($('model')) $('model').value=config.model;
  }else if($('model')){
    config.model=$('model').value;
  }
  saveConfig();
  if(engine){try{await engine.unload?.()}catch{}engine=null}
  await loadAI();
};

if($('cueMode')) $('cueMode').onchange=e=>{config.cueMode=e.target.value;saveConfig()};
if($('autoStartSetting')) $('autoStartSetting').onchange=e=>{config.autoStart=e.target.checked;saveConfig()};
if($('defaultStarter')) $('defaultStarter').onchange=e=>{config.defaultStarter=e.target.value;saveConfig();if(!session)setExpected(config.defaultStarter)};
if($('resetSetup')) $('resetSetup').onclick=()=>{
  if(confirm('Reset Auto Live first-time setup?')){
    config.setupComplete=false;config.autoStart=true;saveConfig();
    session=false;stopRecognition();showSetupGate();navigate('home');
  }
};

// Warm-up
function updateWarmup(){
  if(!$('warmupNumber'))return;
  $('warmupNumber').textContent=`QUESTION ${warmupIndex+1} / ${WARMUPS.length}`;
  $('warmupCue').textContent=`Pose une question sur ${WARMUPS[warmupIndex][0]}.`;
  $('warmupInput').value='';
  $('warmupTarget').textContent=WARMUPS[warmupIndex][1];
  $('warmupTarget').classList.add('hidden');
}
if($('startWarmup')) $('startWarmup').onclick=()=>{$('warmupArea').classList.remove('hidden');updateWarmup()};
if($('checkWarmup')) $('checkWarmup').onclick=()=>{if($('warmupInput').value.trim())$('warmupTarget').classList.remove('hidden')};
if($('nextWarmup')) $('nextWarmup').onclick=()=>{warmupIndex=(warmupIndex+1)%WARMUPS.length;updateWarmup()};

// Extra
const extras={
  daily:"Situation: Tu rencontres quelqu'un au travail après le week-end. Commence une conversation naturelle en français et pose une question de suivi.",
  listening:"Listening mode will include standard French and authentic Québec-French patterns.",
  rescue:"Quick rescue drill: Someone asks « Qu'est-ce que t'en penses ? » Start immediately with 3–5 natural French words.",
  mistakes:"Finish real Live conversations first. Arthur will turn recurring mistakes and Québec expressions into drills."
};
document.querySelectorAll('.extraCard').forEach(b=>b.onclick=()=>{$('extraOutput').querySelector('.practicePrompt').textContent=extras[b.dataset.extra]});
document.querySelectorAll('.coming').forEach(b=>b.onclick=()=>alert('This training module is still in the next implementation pass.'));

// Setup UI
if($('model')){
  // Remove/disable 1.5B on iPhone because it already reproduced a Safari crash.
  if(/iPhone|iPod/i.test(navigator.userAgent)){
    [...$('model').options].forEach(o=>{
      if(o.value.includes('1.5B')) o.disabled=true;
    });
    config.model='Qwen2.5-0.5B-Instruct-q4f16_1-MLC';
  }
  $('model').value=config.model;
}
if($('cueMode')) $('cueMode').value=config.cueMode;
if($('autoStartSetting')) $('autoStartSetting').checked=config.autoStart;
if($('defaultStarter')) $('defaultStarter').value=config.defaultStarter;
setExpected(config.defaultStarter);

async function boot(){
  ensureRescueUI();
  renderHistory();

  // Carry setup state forward from v6/v5.
  try{
    const prior=JSON.parse(localStorage.getItem('tcf-live-v6-config')||localStorage.getItem('tcf-live-v5-config')||'null');
    if(prior && !config.setupComplete){
      config={...config,...prior,model:'Qwen2.5-0.5B-Instruct-q4f16_1-MLC'};
      autoAssistEnabled=config.autoAssist!==false;
      saveConfig();
    }
  }catch{}

  if(!config.setupComplete){showSetupGate();return}
  $('needsSetup').classList.add('hidden');
  $('liveHome').classList.remove('hidden');

  if(config.autoStart){
    try{await startLive({automatic:true})}catch{showPermissionFallback()}
  }else{
    showPermissionFallback();
  }
}

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
    boot();
  });
}else window.addEventListener('load',boot);
