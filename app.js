/* ---------------- Supabase config ----------------
   1. Create a free project at https://supabase.com
   2. In the SQL editor, run the table + policy setup from the deployment guide.
   3. Paste your Project URL and anon public key below (Settings > API).
------------------------------------------------------ */
const SUPABASE_URL = 'https://yoxfgwjcqlnmqnimapfz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_YVDbO7XMFH5CZB5LHcZabw_y-DuAEvU';
let sb = null;
let SUPABASE_CONFIGURED = true;
try{
  if(!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes('YOUR_') || SUPABASE_ANON_KEY.includes('YOUR_')){
    SUPABASE_CONFIGURED = false;
  } else {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
}catch(e){
  SUPABASE_CONFIGURED = false;
  console.error('Supabase client failed to initialize — check SUPABASE_URL/SUPABASE_ANON_KEY.', e);
}

/* ---------------- storage helpers ---------------- */
const EMPTY_DEFAULTS = { users:{}, events:[], tokens:{}, attendance:[], departments:[] };
async function loadAll(){
  if(!SUPABASE_CONFIGURED) return { ...EMPTY_DEFAULTS };
  const out = { ...EMPTY_DEFAULTS };
  try{
    const { data, error } = await sb.from('app_storage').select('key,value');
    if(error) throw error;
    (data||[]).forEach(row=>{ out[row.key] = row.value; });
  }catch(e){
    console.error('Failed to load from Supabase — check SUPABASE_URL/SUPABASE_ANON_KEY and table setup.', e);
  }
  return out;
}
async function saveKey(key, value){
  if(!SUPABASE_CONFIGURED) return;
  try{
    const { error } = await sb.from('app_storage').upsert({ key, value, updated_at: new Date().toISOString() });
    if(error) throw error;
  }catch(e){ console.error('Supabase save failed', key, e); }
}
async function fetchKey(key, fallback){
  if(!SUPABASE_CONFIGURED) return fallback;
  try{
    const { data, error } = await sb.from('app_storage').select('value').eq('key', key).maybeSingle();
    if(error) throw error;
    return data ? data.value : fallback;
  }catch(e){ console.error('Supabase fetch failed', key, e); return fallback; }
}

/* simple non-cryptographic hash - fine for a school demo, not production auth */
function hashPw(pw){
  let h = 0;
  for(let i=0;i<pw.length;i++){ h = ((h<<5)-h + pw.charCodeAt(i))|0; }
  return 'h'+h.toString(36);
}
function uid(prefix){ return prefix+'_'+Math.random().toString(36).slice(2,9); }
function fmtDate(ts){ return new Date(ts).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }

const DEFAULT_DEPTS = ['CS Department','Business Department','Engineering Department','Arts & Sciences','Nursing Department'];
const ROTATE_MS = 20000;   // how often the officer's QR auto-refreshes
const TOKEN_TTL_MS = 25000; // grace window past a refresh before a code stops working entirely
let qrRotateTimer = null;
let lastRenderedQrToken = null;

let DB = { users:{}, events:[], tokens:{}, attendance:[], departments:[] };
let state = {
  route:'login',           // login | student | officer | admin
  authTab:'student',       // student | officer | admin
  authMode:'login',        // login | register
  currentUser:null,
  err:'',
  studentSubRoute:'checkin',
  officerSubRoute:'generate',
  adminSubRoute:'overview',
  checkinStep:'scan',      // scan | done
  lastPhase:'in',
  cameraOpen:false,
  officerActiveEventId:null,
  officerToken:null,
  officerTokenCreatedAt:null,
  officerRotating:false,
  officerPhase:'in',       // 'in' (time-in) or 'out' (time-out)
  newEventDraft:{name:'', date:'', departments:[...DEFAULT_DEPTS]},
  newOfficerDraft:{name:'', username:'', password:'', department:DEFAULT_DEPTS[0]},
  adminFilterEvent:'all',
  adminFilterDept:'all',
  profileMsg:''
};

async function seedIfEmpty(){
  DB = await loadAll();
  let usersChanged = false, deptsChanged = false;
  if(!DB.users['sas-admin']){
    DB.users['sas-admin'] = {id:'sas-admin', role:'admin', name:'System Admin', username:'sas-admin', passwordHash:hashPw('ChangeMe123')};
    usersChanged = true;
  }
  if(!DB.departments || DB.departments.length===0){
    DB.departments = [...DEFAULT_DEPTS];
    deptsChanged = true;
  }
  if(usersChanged){ await saveKey('users', DB.users); }
  if(deptsChanged){ await saveKey('departments', DB.departments); }
  state.newEventDraft.departments = [...DB.departments];
  state.newOfficerDraft.department = DB.departments[0];
}

function render(){
  const app = document.getElementById('app');
  if(state.route==='login'){ app.innerHTML = renderLogin(); attachLoginHandlers(); return; }
  if(state.route==='student'){ app.innerHTML = renderShell(renderStudent()); attachShellHandlers(); attachStudentHandlers(); return; }
  if(state.route==='officer'){ app.innerHTML = renderShell(renderOfficer()); attachShellHandlers(); attachOfficerHandlers(); return; }
  if(state.route==='admin'){ app.innerHTML = renderShell(renderAdmin()); attachShellHandlers(); attachAdminHandlers(); return; }
}

/* ---------------- LOGIN ---------------- */
function renderLogin(){
  const isAdminPage = (typeof PAGE_MODE !== 'undefined' && PAGE_MODE === 'admin');
  const tab = isAdminPage ? 'admin' : (state.authTab === 'admin' ? 'student' : state.authTab);
  return `
  <div class="login-wrap">
    <div class="login-hero">
      <div class="hero-watermark" aria-hidden="true">AS</div>
      <div class="login-hero-inner">
        <div class="seal-lg">AS</div>
        <h1 class="login-title">Attendance System</h1>
        <p class="login-tagline">${isAdminPage ? 'System admin portal' : 'One scan in, one scan out — every event, on record.'}</p>
      </div>
    </div>
    <div class="login-form-panel">
      <div class="login-form-inner">
        <h2 class="form-heading">${isAdminPage ? 'Admin sign in' : 'Sign in'}</h2>
        <p class="form-sub">${isAdminPage ? 'Restricted access — system admin only.' : 'Check in to an event, or open your department desk.'}</p>
        ${isAdminPage ? '' : `
        <div class="auth-tabs">
          <div class="auth-tab ${tab==='student'?'active':''}" data-tab="student">Student</div>
          <div class="auth-tab ${tab==='officer'?'active':''}" data-tab="officer">Officer</div>
        </div>`}
        ${tab==='student' ? renderStudentAuth() : tab==='officer' ? renderOfficerAuth() : renderAdminAuth()}
        ${state.err ? `<div class="err">${state.err}</div>` : ''}
      </div>
    </div>
  </div>`;
}

function renderStudentAuth(){
  const mode = state.authMode;
  return `
    <div class="auth-sub">
      <a data-mode="login" class="${mode==='login'?'active':''}">Log in</a>
      <a data-mode="register" class="${mode==='register'?'active':''}">Create account</a>
    </div>
    ${mode==='login' ? `
      <div class="field"><label>Student ID</label><input id="s-id" placeholder="e.g. 2023-00451"></div>
      <div class="field"><label>Password</label><input id="s-pw" type="password" placeholder="••••••••"></div>
      <button class="btn-primary" style="width:100%" id="student-login-btn">Log in</button>
    ` : `
      <div class="field"><label>Full name</label><input id="r-name" placeholder="Juan Dela Cruz"></div>
      <div class="field"><label>Student ID</label><input id="r-id" placeholder="e.g. 2023-00451"></div>
      <div class="field"><label>Section</label><input id="r-section" placeholder="BSCS 3-A"></div>
      <div class="field"><label>Department</label><select id="r-dept">${DB.departments.map(dep=>`<option>${dep}</option>`).join('')}</select></div>
      <div class="field"><label>Password</label><input id="r-pw" type="password" placeholder="Create a password"></div>
      <button class="btn-primary" style="width:100%" id="student-register-btn">Create account</button>
    `}
    <div class="hint">Your student ID doubles as your username. One account is used for every event this school year.</div>
  `;
}
function renderOfficerAuth(){
  return `
    <div class="field"><label>Officer username</label><input id="o-user" placeholder="set by the system admin"></div>
    <div class="field"><label>Password</label><input id="o-pw" type="password" placeholder="••••••••"></div>
    <button class="btn-primary" style="width:100%" id="officer-login-btn">Log in</button>
    <div class="hint">Officer accounts are created by the system admin and tied to one department.</div>
  `;
}
function renderAdminAuth(){
  return `
    <div class="field"><label>Admin username</label><input id="a-user" placeholder="Enter your admin username"></div>
    <div class="field"><label>Password</label><input id="a-pw" type="password" placeholder="••••••••"></div>
    <button class="btn-primary" style="width:100%" id="admin-login-btn">Log in</button>
    <div class="hint">Default seed account: <span class="mono">sas-admin</span> / <span class="mono">ChangeMe123</span> — change this immediately after first login.</div>
  `;
}

function attachLoginHandlers(){
  document.querySelectorAll('.auth-tab').forEach(el=>{
    el.onclick = ()=>{ state.authTab = el.dataset.tab; state.err=''; render(); };
  });
  document.querySelectorAll('.auth-sub a').forEach(el=>{
    el.onclick = ()=>{ state.authMode = el.dataset.mode; state.err=''; render(); };
  });
  const sLogin = document.getElementById('student-login-btn');
  if(sLogin) sLogin.onclick = ()=>{
    const id = document.getElementById('s-id').value.trim();
    const pw = document.getElementById('s-pw').value;
    const u = DB.users[id];
    if(!u || u.role!=='student' || u.passwordHash!==hashPw(pw)){ state.err='Incorrect student ID or password.'; render(); return; }
    state.currentUser = u; state.route='student'; state.err=''; render();
  };
  const sReg = document.getElementById('student-register-btn');
  if(sReg) sReg.onclick = async ()=>{
    const name = document.getElementById('r-name').value.trim();
    const id = document.getElementById('r-id').value.trim();
    const section = document.getElementById('r-section').value.trim();
    const department = document.getElementById('r-dept').value;
    const pw = document.getElementById('r-pw').value;
    if(!name || !id || !section || !department || !pw){ state.err='Please fill in every field.'; render(); return; }
    if(DB.users[id]){ state.err='An account with that student ID already exists.'; render(); return; }
    DB.users[id] = {id, role:'student', name, section, department, passwordHash:hashPw(pw)};
    await saveKey('users', DB.users);
    state.currentUser = DB.users[id]; state.route='student'; state.err=''; render();
  };
  const oLogin = document.getElementById('officer-login-btn');
  if(oLogin) oLogin.onclick = ()=>{
    const user = document.getElementById('o-user').value.trim();
    const pw = document.getElementById('o-pw').value;
    const u = DB.users[user];
    if(!u || u.role!=='officer' || u.passwordHash!==hashPw(pw)){ state.err='Incorrect username or password.'; render(); return; }
    state.currentUser = u; state.route='officer'; state.err=''; render();
  };
  const aLogin = document.getElementById('admin-login-btn');
  if(aLogin) aLogin.onclick = ()=>{
    const user = document.getElementById('a-user').value.trim();
    const pw = document.getElementById('a-pw').value;
    const u = DB.users[user];
    if(!u || u.role!=='admin' || u.passwordHash!==hashPw(pw)){ state.err='Incorrect username or password.'; render(); return; }
    state.currentUser = u; state.route='admin'; state.err=''; render();
  };
}

/* ---------------- SHELL ---------------- */
function renderShell(innerHtml){
  const u = state.currentUser;
  const role = u.role;
  const items = role==='student' ? [['checkin','Check In'],['history','My Attendance'],['profile','My Profile']]
              : role==='officer' ? [['generate','Generate QR'],['attendees','Attendees'],['profile','My Profile']]
              : [['overview','Overview'],['events','Manage Events'],['departments','Departments'],['officers','Manage Officers'],['records','All Records'],['profile','My Profile']];
  const sub = role==='student' ? state.studentSubRoute : role==='officer' ? state.officerSubRoute : state.adminSubRoute;
  return `
  <div class="shell">
    <div class="sidebar">
      <div class="brand">Attendance System</div>
      <div class="role-tag">${role==='admin'?'System Admin':role==='officer'?'Department Officer':'Student'}</div>
      ${items.map(([key,label])=>`<button class="nav-item ${sub===key?'active':''}" data-sub="${key}">${label}</button>`).join('')}
      <div class="who">
        Signed in as<br><strong style="color:#fff;">${u.name}</strong><br>
        <button class="nav-item" style="margin-top:10px; color:#ffb4b4;" id="logout-btn">Log out</button>
      </div>
    </div>
    <div class="main">${innerHtml}</div>
  </div>`;
}
function attachShellHandlers(){
  document.querySelectorAll('.nav-item[data-sub]').forEach(el=>{
    el.onclick = ()=>{
      const role = state.currentUser.role;
      if(role==='student'){ state.studentSubRoute = el.dataset.sub; state.checkinStep='scan'; }
      if(role==='officer'){
        if(el.dataset.sub !== 'generate'){ stopQrRotation(); state.officerRotating=false; }
        state.officerSubRoute = el.dataset.sub;
      }
      if(role==='admin'){ state.adminSubRoute = el.dataset.sub; }
      state.err=''; state.profileMsg='';
      render();
    };
  });
  const out = document.getElementById('logout-btn');
  if(out) out.onclick = ()=>{ stopQrRotation(); state.officerRotating=false; state.currentUser=null; state.route='login'; state.err=''; render(); };
}

/* ---------------- STUDENT ---------------- */
function renderStudent(){
  if(state.studentSubRoute==='checkin') return renderCheckin();
  if(state.studentSubRoute==='history') return renderHistory();
  return renderProfile();
}
function renderCheckin(){
  if(state.checkinStep==='scan'){
    return `
    <div class="page-head"><h1>Check in to an event</h1><p>Scan the QR code at the <span class="badge-dept">${state.currentUser.department}</span> station — once when you arrive, once before you leave. Codes from other departments won't work.</p></div>
    <div class="card" style="max-width:460px;">
      <button class="btn-gold" style="width:100%; padding:14px;" id="open-camera-btn">Scan QR code</button>
      <div style="text-align:center; margin:14px 0; color:var(--ink-soft); font-size:12px;">— or —</div>
      <div class="field"><label>Enter code manually</label><input id="manual-code" placeholder="paste or type the code shown by the officer" class="mono"></div>
      <button class="btn-primary" style="width:100%" id="submit-code-btn">Continue</button>
      ${state.err ? `<div class="err" style="margin-top:12px;">${state.err}</div>` : ''}
    </div>
    ${state.cameraOpen ? renderCameraModal() : ''}
    `;
  }
  // done
  const isIn = state.lastPhase === 'in';
  return `
  <div class="stamp-wrap">
    <div class="stamp">${isIn ? 'TIME IN' : 'TIME OUT'}<br>${new Date().toLocaleDateString()}</div>
    <h2 style="margin-top:24px;">${isIn ? "You're timed in" : "You're timed out"}</h2>
    <p style="color:var(--ink-soft); text-align:center; max-width:340px;">${isIn ? 'Come back and scan again before you leave to complete your attendance.' : 'Your attendance for this event is now complete.'}</p>
    <button class="btn-ghost" id="checkin-again-btn" style="margin-top:14px;">Back to check-in</button>
  </div>`;
}
function renderHistory(){
  const mine = DB.attendance.filter(a=>a.studentId===state.currentUser.id).sort((a,b)=>(b.timeIn||0)-(a.timeIn||0));
  if(mine.length===0) return `<div class="page-head"><h1>My Attendance</h1></div><div class="empty">No check-ins yet — scan a QR code at an event to get started.</div>`;
  return `
  <div class="page-head"><h1>My Attendance</h1><p>${mine.length} event${mine.length>1?'s':''} recorded this year.</p></div>
  <div class="card" style="padding:0;">
    <table>
      <tr><th>Event</th><th>Department</th><th>Time in</th><th>Time out</th><th>Status</th></tr>
      ${mine.map(a=>`<tr><td>${a.eventName}</td><td><span class="badge-dept">${a.department}</span></td><td>${a.timeIn?fmtDate(a.timeIn):'—'}</td><td>${a.timeOut?fmtDate(a.timeOut):'—'}</td><td>${a.timeIn && a.timeOut ? '<span class="pill green">Present</span>' : '<span class="pill gold">Time-in only</span>'}</td></tr>`).join('')}
    </table>
  </div>`;
}
function renderCameraModal(){
  return `
  <div class="camera-modal" id="camera-modal">
    <div class="camera-card">
      <button class="close-x" id="close-camera-btn">&times;</button>
      <h3 style="margin-top:0;">Point your camera at the QR code</h3>
      <video id="qr-video" playsinline muted></video>
      <canvas id="qr-canvas" style="display:none;"></canvas>
      <p style="font-size:12px; color:var(--ink-soft);" id="camera-status">Requesting camera access…</p>
    </div>
  </div>`;
}
let cameraStream = null, cameraLoop = null;
function attachStudentHandlers(){
  const openCam = document.getElementById('open-camera-btn');
  if(openCam) openCam.onclick = ()=>{ state.cameraOpen=true; state.err=''; render(); startCamera(); };
  const closeCam = document.getElementById('close-camera-btn');
  if(closeCam) closeCam.onclick = ()=>{ stopCamera(); state.cameraOpen=false; render(); };
  const submitCode = document.getElementById('submit-code-btn');
  if(submitCode) submitCode.onclick = ()=>{
    const code = document.getElementById('manual-code').value.trim();
    tryUseToken(code);
  };
  const again = document.getElementById('checkin-again-btn');
  if(again) again.onclick = ()=>{ state.checkinStep='scan'; render(); };
  if(state.cameraOpen) startCamera();
  if(state.studentSubRoute==='profile') attachProfileHandlers();
}
async function tryUseToken(rawCode){
  if(!rawCode){ state.err='Enter or scan a code first.'; render(); return; }
  const code = rawCode.trim().toUpperCase();
  // pull the latest codes from storage — the officer may have generated/rotated one since this tab loaded
  DB.tokens = await fetchKey('tokens', DB.tokens);
  const tok = DB.tokens[code];
  if(!tok){ state.err='That code is not valid. Ask the officer for the current QR.'; render(); return; }
  if((Date.now() - tok.createdAt) > TOKEN_TTL_MS){
    state.err='This QR code has expired. It refreshes often — ask the officer to show the current one.';
    render(); return;
  }
  if(tok.department !== state.currentUser.department){
    state.err=`This QR is for ${tok.department}. You're registered under ${state.currentUser.department}, so it can't be used to check you in.`;
    render(); return;
  }
  const u = state.currentUser;
  const ev = DB.events.find(e=>e.id===tok.eventId);
  if(!ev){ state.err='This event no longer exists.'; render(); return; }
  // pull the latest attendance log too, so duplicate/order checks reflect other devices
  DB.attendance = await fetchKey('attendance', DB.attendance);
  let record = DB.attendance.find(a=>a.eventId===ev.id && a.studentId===u.id);
  if(tok.phase==='out'){
    if(!record || !record.timeIn){ state.err='You need to time in first before you can time out.'; render(); return; }
    if(record.timeOut){ state.err='You already timed out for this event.'; render(); return; }
    record.timeOut = Date.now();
    record.tokenUsed = code;
  } else {
    if(record && record.timeIn){ state.err='You already timed in for this event.'; render(); return; }
    if(!record){
      record = {id: uid('att'), eventId:ev.id, eventName:ev.name, department:tok.department, studentId:u.id, studentName:u.name, section:u.section, timeIn:null, timeOut:null, tokenUsed:null};
      DB.attendance.push(record);
    }
    record.timeIn = Date.now();
    record.tokenUsed = code;
  }
  await saveKey('attendance', DB.attendance);
  state.checkinStep = 'done';
  state.lastPhase = tok.phase;
  state.err = '';
  stopCamera();
  state.cameraOpen = false;
  render();
}
async function startCamera(){
  setTimeout(async ()=>{
    const video = document.getElementById('qr-video');
    const statusEl = document.getElementById('camera-status');
    if(!video) return;
    try{
      cameraStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
      video.srcObject = cameraStream;
      await video.play();
      if(statusEl) statusEl.textContent = 'Scanning…';
      const canvas = document.getElementById('qr-canvas');
      const ctx = canvas.getContext('2d');
      cameraLoop = setInterval(()=>{
        if(video.readyState !== video.HAVE_ENOUGH_DATA) return;
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video,0,0,canvas.width,canvas.height);
        const img = ctx.getImageData(0,0,canvas.width,canvas.height);
        const code = jsQR(img.data, img.width, img.height);
        if(code && code.data){ tryUseToken(code.data.trim()); }
      }, 350);
    }catch(e){
      if(statusEl) statusEl.textContent = 'Camera unavailable — close this and use "Enter code manually" instead.';
    }
  }, 50);
}
function stopCamera(){
  if(cameraLoop){ clearInterval(cameraLoop); cameraLoop=null; }
  if(cameraStream){ cameraStream.getTracks().forEach(t=>t.stop()); cameraStream=null; }
}

/* ---------------- OFFICER ---------------- */
function stopQrRotation(){
  if(qrRotateTimer){ clearInterval(qrRotateTimer); qrRotateTimer=null; }
}
async function generateRotatingToken(eventId, department, phase){
  const token = uid('qr').toUpperCase();
  DB.tokens[token] = {eventId, department, phase, createdAt: Date.now()};
  // prune this desk's old expired tokens so storage doesn't grow forever
  Object.keys(DB.tokens).forEach(t=>{
    const info = DB.tokens[t];
    if(info.eventId===eventId && info.department===department && t!==token && (Date.now()-info.createdAt)>TOKEN_TTL_MS){
      delete DB.tokens[t];
    }
  });
  await saveKey('tokens', DB.tokens);
  state.officerToken = token;
  state.officerTokenCreatedAt = Date.now();
}
async function startQrRotation(eventId, department, phase){
  stopQrRotation();
  lastRenderedQrToken = null;
  await generateRotatingToken(eventId, department, phase);
  render();
  qrRotateTimer = setInterval(()=>officerTick(eventId, department, phase), 2000);
}
async function officerTick(eventId, department, phase){
  if(!state.officerRotating || !state.officerToken) return;
  // pull the latest attendance log so we can tell if someone just used this code
  DB.attendance = await fetchKey('attendance', DB.attendance);
  const consumed = DB.attendance.some(a => a.tokenUsed === state.officerToken);
  const elapsed = Date.now() - state.officerTokenCreatedAt;
  if(consumed || elapsed >= ROTATE_MS){
    await generateRotatingToken(eventId, department, phase);
    render(); // full render only when the token actually changes, so the QR redraws just once
    return;
  }
  // otherwise just tick the countdown label in place — no full re-render, no flicker
  const remaining = Math.max(0, Math.ceil((ROTATE_MS - elapsed)/1000));
  const pill = document.getElementById('qr-countdown');
  if(pill) pill.textContent = `Refreshes in ${remaining}s`;
}
function renderOfficer(){
  const u = state.currentUser;
  const myEvents = DB.events.filter(e=>e.departments.includes(u.department));
  if(state.officerSubRoute==='generate') return renderOfficerGenerate(myEvents);
  if(state.officerSubRoute==='attendees') return renderOfficerAttendees(myEvents);
  return renderProfile();
}
function renderOfficerGenerate(myEvents){
  const activeId = state.officerActiveEventId || (myEvents[0] && myEvents[0].id);
  const remaining = state.officerRotating && state.officerTokenCreatedAt
    ? Math.max(0, Math.ceil((ROTATE_MS - (Date.now()-state.officerTokenCreatedAt))/1000)) : null;
  return `
  <div class="page-head"><h1>Generate check-in QR</h1><p>Department: <span class="badge-dept">${state.currentUser.department}</span></p></div>
  ${myEvents.length===0 ? `<div class="empty">No events have been set up for your department yet. Ask the system admin to add one.</div>` : `
  <div class="card" style="max-width:480px;">
    <div class="field">
      <label>Event</label>
      <select id="officer-event-select" ${state.officerRotating?'disabled':''}>
        ${myEvents.map(e=>`<option value="${e.id}" ${e.id===activeId?'selected':''}>${e.name} — ${e.date}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Which check-in is this?</label>
      <div class="auth-tabs" style="margin-bottom:0;">
        <div class="auth-tab phase-tab ${state.officerPhase==='in'?'active':''}" data-phase="in" style="${state.officerRotating?'pointer-events:none; opacity:0.6;':''}">Before event (time in)</div>
        <div class="auth-tab phase-tab ${state.officerPhase==='out'?'active':''}" data-phase="out" style="${state.officerRotating?'pointer-events:none; opacity:0.6;':''}">Before they leave (time out)</div>
      </div>
    </div>
    ${!state.officerRotating ? `
      <button class="btn-gold" style="width:100%; margin-top:16px;" id="start-qr-btn">Start live check-in</button>
      <p class="hint">The code refreshes the instant someone checks in with it, and also on its own every ${ROTATE_MS/1000}s if it sits idle — so a screenshot shared off-site goes dead fast.</p>
    ` : `
      <button class="btn-ghost" style="width:100%; margin-top:16px;" id="stop-qr-btn">Stop live check-in</button>
    `}
  </div>
  ${state.officerRotating && state.officerToken ? `
    <div class="qr-box" style="max-width:320px; margin-top:20px;">
      <div class="pill ${state.officerPhase==='in'?'green':'gold'}" style="margin-bottom:12px;">${state.officerPhase==='in'?'TIME IN':'TIME OUT'}</div>
      <div id="qr-render"></div>
      <div class="code-text">${state.officerToken}</div>
      <div class="pill gold" id="qr-countdown" style="margin-top:12px;">Refreshes in ${remaining}s</div>
      <p style="font-size:12px; color:var(--ink-soft); margin-top:12px;">Display this on a screen at your station. It updates itself as students check in — keep the tab open.</p>
    </div>
  ` : ''}
  `}`;
}
function renderOfficerAttendees(myEvents){
  const activeId = state.officerActiveEventId || (myEvents[0] && myEvents[0].id);
  const ev = myEvents.find(e=>e.id===activeId);
  const rows = ev ? DB.attendance.filter(a=>a.eventId===ev.id && a.department===state.currentUser.department).sort((a,b)=>(b.timeIn||0)-(a.timeIn||0)) : [];
  const complete = rows.filter(r=>r.timeIn && r.timeOut).length;
  return `
  <div class="page-head"><h1>Attendees</h1><p>Live list for your department's desk.</p></div>
  ${myEvents.length===0 ? `<div class="empty">No events yet.</div>` : `
  <div class="card" style="max-width:300px; margin-bottom:18px;">
    <div class="field" style="margin-bottom:0;">
      <label>Event</label>
      <select id="officer-att-event-select">
        ${myEvents.map(e=>`<option value="${e.id}" ${e.id===activeId?'selected':''}>${e.name}</option>`).join('')}
      </select>
    </div>
  </div>
  <div class="grid">
    <div class="stat"><div class="num">${rows.length}</div><div class="lbl">Timed in</div></div>
    <div class="stat"><div class="num">${complete}</div><div class="lbl">Completed (in &amp; out)</div></div>
  </div>
  <div class="card" style="padding:0;">
    <table>
      <tr><th>Student</th><th>Section</th><th>Time in</th><th>Time out</th><th>Status</th></tr>
      ${rows.map(r=>`<tr><td>${r.studentName}</td><td>${r.section}</td><td>${r.timeIn?fmtDate(r.timeIn):'—'}</td><td>${r.timeOut?fmtDate(r.timeOut):'—'}</td><td>${r.timeIn && r.timeOut ? '<span class="pill green">Present</span>' : '<span class="pill gold">Time-in only</span>'}</td></tr>`).join('') || `<tr><td colspan="5" class="empty">No check-ins yet for this event.</td></tr>`}
    </table>
  </div>
  `}`;
}
function attachOfficerHandlers(){
  const sel = document.getElementById('officer-event-select');
  if(sel) sel.onchange = ()=>{
    stopQrRotation();
    state.officerRotating = false;
    state.officerToken = null;
    lastRenderedQrToken = null;
    state.officerActiveEventId = sel.value;
    render();
  };
  const start = document.getElementById('start-qr-btn');
  if(start) start.onclick = async ()=>{
    const eventId = document.getElementById('officer-event-select').value;
    state.officerActiveEventId = eventId;
    state.officerRotating = true;
    await startQrRotation(eventId, state.currentUser.department, state.officerPhase);
  };
  document.querySelectorAll('.phase-tab').forEach(el=>{
    el.onclick = ()=>{
      if(state.officerRotating) return;
      state.officerPhase = el.dataset.phase;
      render();
    };
  });
  const stop = document.getElementById('stop-qr-btn');
  if(stop) stop.onclick = ()=>{
    stopQrRotation();
    state.officerRotating = false;
    state.officerToken = null;
    lastRenderedQrToken = null;
    render();
  };
  const attSel = document.getElementById('officer-att-event-select');
  if(attSel) attSel.onchange = ()=>{ state.officerActiveEventId = attSel.value; render(); };
  // only redraw the QR canvas when the token itself has actually changed, to avoid flicker on every countdown tick
  if(state.officerRotating && state.officerToken && lastRenderedQrToken !== state.officerToken){
    setTimeout(()=>{
      const holder = document.getElementById('qr-render');
      if(holder && window.QRCode){
        holder.innerHTML = '';
        new QRCode(holder, {text: state.officerToken, width:200, height:200, colorDark:'#1B2A4A', colorLight:'#ffffff'});
        lastRenderedQrToken = state.officerToken;
      }
    }, 30);
  }
  if(state.officerSubRoute==='profile') attachProfileHandlers();
}

/* ---------------- PROFILE (shared by all roles) ---------------- */
function renderProfile(){
  const u = state.currentUser;
  const roleLabel = u.role==='admin' ? 'System Admin' : u.role==='officer' ? 'Department officer' : 'Student';
  return `
  <div class="page-head"><h1>My Profile</h1><p>${roleLabel} account details.</p></div>
  <div class="card" style="max-width:440px; margin-bottom:24px;">
    <div class="field"><label>Full name</label><input id="prof-name" value="${u.name}"></div>
    ${u.role==='student' ? `
      <div class="field"><label>Student ID</label><input value="${u.id}" disabled style="background:var(--bg); color:var(--ink-soft);"></div>
      <div class="field"><label>Section</label><input id="prof-section" value="${u.section||''}"></div>
      <div class="field"><label>Department</label><select id="prof-dept">${DB.departments.map(dep=>`<option ${u.department===dep?'selected':''}>${dep}</option>`).join('')}</select></div>
      <div class="hint" style="margin-top:-8px; margin-bottom:14px;">Only your own department's QR code will check you in.</div>
    ` : ''}
    ${u.role==='officer' ? `
      <div class="field"><label>Username</label><input value="${u.username}" disabled style="background:var(--bg); color:var(--ink-soft);"></div>
      <div class="field"><label>Department</label><input value="${u.department}" disabled style="background:var(--bg); color:var(--ink-soft);"></div>
      <div class="hint" style="margin-top:-8px; margin-bottom:14px;">Department reassignment is handled by the system admin, under Manage Officers.</div>
    ` : ''}
    ${u.role==='admin' ? `
      <div class="field"><label>Username</label><input value="${u.username}" disabled style="background:var(--bg); color:var(--ink-soft);"></div>
    ` : ''}
    ${state.profileMsg==='saved' ? `<div class="pill green" style="margin-bottom:12px;">Details saved</div>` : ''}
    <button class="btn-primary" style="width:100%;" id="save-profile-btn">Save details</button>
  </div>
  <div class="section-title">Change password</div>
  <div class="card" style="max-width:440px;">
    <div class="field"><label>Current password</label><input id="prof-cur-pw" type="password"></div>
    <div class="field"><label>New password</label><input id="prof-new-pw" type="password"></div>
    <div class="field"><label>Confirm new password</label><input id="prof-confirm-pw" type="password"></div>
    ${state.err ? `<div class="err">${state.err}</div>` : ''}
    ${state.profileMsg==='pw-saved' ? `<div class="pill green" style="margin-bottom:12px;">Password updated</div>` : ''}
    <button class="btn-primary" style="width:100%;" id="save-password-btn">Update password</button>
  </div>`;
}
function attachProfileHandlers(){
  const save = document.getElementById('save-profile-btn');
  if(save) save.onclick = async ()=>{
    const u = state.currentUser;
    const nameEl = document.getElementById('prof-name');
    if(nameEl && nameEl.value.trim()) u.name = nameEl.value.trim();
    if(u.role==='student'){
      const secEl = document.getElementById('prof-section');
      if(secEl) u.section = secEl.value.trim();
      const deptEl = document.getElementById('prof-dept');
      if(deptEl) u.department = deptEl.value;
    }
    DB.users[u.id] = u;
    await saveKey('users', DB.users);
    state.profileMsg = 'saved';
    state.err = '';
    render();
  };
  const savePw = document.getElementById('save-password-btn');
  if(savePw) savePw.onclick = async ()=>{
    const u = state.currentUser;
    const cur = document.getElementById('prof-cur-pw').value;
    const next = document.getElementById('prof-new-pw').value;
    const confirm = document.getElementById('prof-confirm-pw').value;
    if(u.passwordHash !== hashPw(cur)){ state.err='Current password is incorrect.'; state.profileMsg=''; render(); return; }
    if(!next || next.length<4){ state.err='New password must be at least 4 characters.'; state.profileMsg=''; render(); return; }
    if(next !== confirm){ state.err='New passwords do not match.'; state.profileMsg=''; render(); return; }
    u.passwordHash = hashPw(next);
    DB.users[u.id] = u;
    await saveKey('users', DB.users);
    state.err = '';
    state.profileMsg = 'pw-saved';
    render();
  };
}

/* ---------------- ADMIN ---------------- */
function renderAdmin(){
  if(state.adminSubRoute==='overview') return renderAdminOverview();
  if(state.adminSubRoute==='events') return renderAdminEvents();
  if(state.adminSubRoute==='departments') return renderAdminDepartments();
  if(state.adminSubRoute==='officers') return renderAdminOfficers();
  if(state.adminSubRoute==='records') return renderAdminRecords();
  return renderProfile();
}
function renderAdminOverview(){
  const totalAtt = DB.attendance.length;
  const totalComplete = DB.attendance.filter(a=>a.timeIn && a.timeOut).length;
  const totalEvents = DB.events.length;
  const officerCount = Object.values(DB.users).filter(u=>u.role==='officer').length;
  const byEvent = {};
  DB.attendance.forEach(a=>{
    if(!byEvent[a.eventName]) byEvent[a.eventName] = {timedIn:0, complete:0};
    if(a.timeIn) byEvent[a.eventName].timedIn++;
    if(a.timeIn && a.timeOut) byEvent[a.eventName].complete++;
  });
  return `
  <div class="page-head"><h1>Admin Overview</h1><p>School-wide attendance summary, live across every department.</p></div>
  <div class="grid">
    <div class="stat"><div class="num">${totalEvents}</div><div class="lbl">Events this year</div></div>
    <div class="stat"><div class="num">${totalAtt}</div><div class="lbl">Total timed in</div></div>
    <div class="stat"><div class="num">${totalComplete}</div><div class="lbl">Completed (in &amp; out)</div></div>
    <div class="stat"><div class="num">${officerCount}</div><div class="lbl">Officer accounts</div></div>
  </div>
  <div class="section-title">Attendance by event</div>
  <div class="card" style="padding:0;">
    <table>
      <tr><th>Event</th><th>Timed in</th><th>Completed</th></tr>
      ${Object.keys(byEvent).length ? Object.entries(byEvent).map(([name,c])=>`<tr><td>${name}</td><td>${c.timedIn}</td><td>${c.complete}</td></tr>`).join('') : `<tr><td colspan="3" class="empty">No attendance recorded yet.</td></tr>`}
    </table>
  </div>`;
}
function renderAdminEvents(){
  const d = state.newEventDraft;
  return `
  <div class="page-head"><h1>Manage Events</h1><p>Create the events officers will generate QR codes for.</p></div>
  <div class="card" style="max-width:520px; margin-bottom:24px;">
    <div class="field"><label>Event name</label><input id="ev-name" value="${d.name}" placeholder="Foundation Week 2026"></div>
    <div class="field"><label>Date</label><input id="ev-date" type="date" value="${d.date}"></div>
    <div class="field">
      <label>Participating departments</label>
      ${DB.departments.map(dep=>`
        <label style="text-transform:none; font-weight:400; display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <input type="checkbox" style="width:auto;" class="dept-check" value="${dep}" ${d.departments.includes(dep)?'checked':''}> ${dep}
        </label>`).join('')}
    </div>
    ${state.err ? `<div class="err">${state.err}</div>` : ''}
    <button class="btn-primary" style="width:100%;" id="create-event-btn">Create event</button>
  </div>
  <div class="section-title">All events</div>
  <div class="card" style="padding:0;">
    <table>
      <tr><th>Event</th><th>Date</th><th>Departments</th><th></th></tr>
      ${DB.events.map(e=>`<tr><td>${e.name}</td><td>${e.date||'—'}</td><td>${e.departments.map(dp=>`<span class="badge-dept" style="margin-right:4px;">${dp}</span>`).join('')}</td><td><button class="btn-danger" data-del-event="${e.id}">Remove</button></td></tr>`).join('') || `<tr><td colspan="4" class="empty">No events yet.</td></tr>`}
    </table>
  </div>`;
}
function renderAdminDepartments(){
  const deps = DB.departments;
  const inUse = new Set();
  DB.events.forEach(e=>e.departments.forEach(dp=>inUse.add(dp)));
  return `
  <div class="page-head"><h1>Departments</h1><p>This list feeds the department options when creating events and officer accounts.</p></div>
  <div class="card" style="max-width:440px; margin-bottom:24px;">
    <div class="field"><label>Add a department</label><input id="new-dept-name" placeholder="e.g. Maritime Department"></div>
    ${state.err ? `<div class="err">${state.err}</div>` : ''}
    <button class="btn-primary" style="width:100%;" id="add-dept-btn">Add department</button>
  </div>
  <div class="section-title">Current departments</div>
  <div class="card" style="padding:0; max-width:440px;">
    <table>
      <tr><th>Department</th><th></th></tr>
      ${deps.map(dp=>`<tr><td>${dp} ${inUse.has(dp)?'<span class="pill gold" style="margin-left:6px;">in use</span>':''}</td><td><button class="btn-danger" data-del-dept="${dp}">Remove</button></td></tr>`).join('') || `<tr><td colspan="2" class="empty">No departments yet.</td></tr>`}
    </table>
  </div>`;
}
function renderAdminOfficers(){
  const d = state.newOfficerDraft;
  const officers = Object.values(DB.users).filter(u=>u.role==='officer');
  return `
  <div class="page-head"><h1>Manage Officers</h1><p>One account per department desk.</p></div>
  <div class="card" style="max-width:480px; margin-bottom:24px;">
    <div class="field"><label>Officer name</label><input id="of-name" value="${d.name}" placeholder="Maria Santos"></div>
    <div class="field"><label>Username</label><input id="of-user" value="${d.username}" placeholder="cs-officer"></div>
    <div class="field"><label>Password</label><input id="of-pw" type="password" placeholder="Set a password"></div>
    <div class="field">
      <label>Department</label>
      <select id="of-dept">${DB.departments.map(dep=>`<option ${d.department===dep?'selected':''}>${dep}</option>`).join('')}</select>
    </div>
    ${state.err ? `<div class="err">${state.err}</div>` : ''}
    <button class="btn-primary" style="width:100%;" id="create-officer-btn">Create officer account</button>
  </div>
  <div class="section-title">All officers</div>
  <div class="card" style="padding:0;">
    <table>
      <tr><th>Name</th><th>Username</th><th>Department</th><th></th></tr>
      ${officers.map(o=>`<tr><td>${o.name}</td><td class="mono">${o.username}</td><td><span class="badge-dept">${o.department}</span></td><td><button class="btn-danger" data-del-officer="${o.username}">Remove</button></td></tr>`).join('') || `<tr><td colspan="4" class="empty">No officer accounts yet.</td></tr>`}
    </table>
  </div>`;
}
function renderAdminRecords(){
  const events = ['all', ...DB.events.map(e=>e.name)];
  const depts = ['all', ...DB.departments];
  let rows = DB.attendance.slice().sort((a,b)=>(b.timeIn||0)-(a.timeIn||0));
  if(state.adminFilterEvent!=='all') rows = rows.filter(r=>r.eventName===state.adminFilterEvent);
  if(state.adminFilterDept!=='all') rows = rows.filter(r=>r.department===state.adminFilterDept);
  return `
  <div class="page-head"><h1>All Records</h1><p>Full attendance log across every event and department.</p></div>
  <div class="row" style="margin-bottom:18px; max-width:520px;">
    <div class="field" style="margin-bottom:0; flex:1;">
      <label>Event</label>
      <select id="filter-event">${events.map(e=>`<option ${state.adminFilterEvent===e?'selected':''}>${e}</option>`).join('')}</select>
    </div>
    <div class="field" style="margin-bottom:0; flex:1;">
      <label>Department</label>
      <select id="filter-dept">${depts.map(dp=>`<option ${state.adminFilterDept===dp?'selected':''}>${dp}</option>`).join('')}</select>
    </div>
  </div>
  <div class="card" style="padding:0;">
    <table>
      <tr><th>Student</th><th>Event</th><th>Department</th><th>Time in</th><th>Time out</th><th>Status</th></tr>
      ${rows.map(r=>`<tr><td>${r.studentName} <span style="color:var(--ink-soft);">(${r.studentId})</span></td><td>${r.eventName}</td><td><span class="badge-dept">${r.department}</span></td><td>${r.timeIn?fmtDate(r.timeIn):'—'}</td><td>${r.timeOut?fmtDate(r.timeOut):'—'}</td><td>${r.timeIn && r.timeOut ? '<span class="pill green">Present</span>' : '<span class="pill gold">Time-in only</span>'}</td></tr>`).join('') || `<tr><td colspan="6" class="empty">No records match this filter.</td></tr>`}
    </table>
  </div>`;
}
function attachAdminHandlers(){
  document.querySelectorAll('.dept-check').forEach(el=>{
    el.onchange = ()=>{
      const set = new Set(state.newEventDraft.departments);
      if(el.checked) set.add(el.value); else set.delete(el.value);
      state.newEventDraft.departments = [...set];
    };
  });
  const nameEl = document.getElementById('ev-name');
  if(nameEl) nameEl.oninput = ()=>{ state.newEventDraft.name = nameEl.value; };
  const dateEl = document.getElementById('ev-date');
  if(dateEl) dateEl.oninput = ()=>{ state.newEventDraft.date = dateEl.value; };
  const createEv = document.getElementById('create-event-btn');
  if(createEv) createEv.onclick = async ()=>{
    const d = state.newEventDraft;
    if(!d.name || d.departments.length===0){ state.err='Give the event a name and at least one department.'; render(); return; }
    DB.events.push({id: uid('evt'), name:d.name, date:d.date, departments:[...d.departments]});
    await saveKey('events', DB.events);
    state.newEventDraft = {name:'', date:'', departments:[...DB.departments]};
    state.err='';
    render();
  };
  document.querySelectorAll('[data-del-event]').forEach(el=>{
    el.onclick = async ()=>{
      DB.events = DB.events.filter(e=>e.id!==el.dataset.delEvent);
      await saveKey('events', DB.events);
      render();
    };
  });
  const ofName = document.getElementById('of-name');
  if(ofName) ofName.oninput = ()=>{ state.newOfficerDraft.name = ofName.value; };
  const ofUser = document.getElementById('of-user');
  if(ofUser) ofUser.oninput = ()=>{ state.newOfficerDraft.username = ofUser.value; };
  const ofDept = document.getElementById('of-dept');
  if(ofDept) ofDept.onchange = ()=>{ state.newOfficerDraft.department = ofDept.value; };
  const createOf = document.getElementById('create-officer-btn');
  if(createOf) createOf.onclick = async ()=>{
    const name = document.getElementById('of-name').value.trim();
    const username = document.getElementById('of-user').value.trim();
    const pw = document.getElementById('of-pw').value;
    const department = document.getElementById('of-dept').value;
    if(!name || !username || !pw){ state.err='Fill in every field.'; render(); return; }
    if(DB.users[username]){ state.err='That username is taken.'; render(); return; }
    DB.users[username] = {id:username, role:'officer', name, username, department, passwordHash:hashPw(pw)};
    await saveKey('users', DB.users);
    state.newOfficerDraft = {name:'', username:'', password:'', department:DB.departments[0]};
    state.err='';
    render();
  };
  document.querySelectorAll('[data-del-officer]').forEach(el=>{
    el.onclick = async ()=>{
      delete DB.users[el.dataset.delOfficer];
      await saveKey('users', DB.users);
      render();
    };
  });
  const fe = document.getElementById('filter-event');
  if(fe) fe.onchange = ()=>{ state.adminFilterEvent = fe.value; render(); };
  const fd = document.getElementById('filter-dept');
  if(fd) fd.onchange = ()=>{ state.adminFilterDept = fd.value; render(); };
  const addDept = document.getElementById('add-dept-btn');
  if(addDept) addDept.onclick = async ()=>{
    const nameEl = document.getElementById('new-dept-name');
    const name = nameEl.value.trim();
    if(!name){ state.err='Enter a department name.'; render(); return; }
    if(DB.departments.includes(name)){ state.err='That department already exists.'; render(); return; }
    DB.departments.push(name);
    await saveKey('departments', DB.departments);
    state.err='';
    render();
  };
  document.querySelectorAll('[data-del-dept]').forEach(el=>{
    el.onclick = async ()=>{
      DB.departments = DB.departments.filter(d=>d!==el.dataset.delDept);
      await saveKey('departments', DB.departments);
      render();
    };
  });
  if(state.adminSubRoute==='profile') attachProfileHandlers();
}

/* ---------------- init ---------------- */
function renderSetupNeeded(){
  return `
  <div class="center-screen">
    <div class="auth-shell">
      <div class="seal">AS</div>
      <div class="card">
        <h2 style="margin-top:0;">Backend not connected yet</h2>
        <p style="color:var(--ink-soft); font-size:13.5px; line-height:1.6;">
          This app needs a Supabase project before it can run. Open this HTML file, find
          <span class="mono">SUPABASE_URL</span> and <span class="mono">SUPABASE_ANON_KEY</span>
          near the top of the <span class="mono">&lt;script&gt;</span> section, and paste in your
          project's values from Supabase → Settings → API.
        </p>
        <p style="color:var(--ink-soft); font-size:13.5px;">See <strong>DEPLOYMENT-GUIDE.md</strong> for the full step-by-step setup.</p>
      </div>
    </div>
  </div>`;
}
(async function init(){
  document.getElementById('app').innerHTML = `<div class="center-screen"><p style="color:var(--ink-soft);">Loading…</p></div>`;
  if(!SUPABASE_CONFIGURED){
    document.getElementById('app').innerHTML = renderSetupNeeded();
    return;
  }
  await seedIfEmpty();
  render();
})();
