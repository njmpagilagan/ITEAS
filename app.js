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
const EMPTY_DEFAULTS = { users:{}, events:[], tokens:{}, attendance:[], departments:[], sections:{}, adminLog:[], sheetSettings:null };
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

/* ---------------- clock-skew correction ----------------
   QR expiry compares a timestamp created on one device (the officer's) against a check
   made on another (the scanning student's phone). If either device's clock is off, codes
   can look "expired" the instant they're generated even when scanned within a second.
   Fix: measure each device's own offset from the server's clock (via the Date header every
   HTTP response includes) and always use serverNow() — Date.now() corrected by that
   offset — for anything expiry-related, instead of the device's raw local clock. */
let serverTimeOffsetMs = 0;
async function syncServerTimeOffset(){
  if(!SUPABASE_CONFIGURED) return;
  try{
    const res = await fetch(SUPABASE_URL + '/rest/v1/', { method:'HEAD', headers:{ apikey: SUPABASE_ANON_KEY } });
    const dateHeader = res.headers.get('date');
    if(dateHeader){
      const serverTime = new Date(dateHeader).getTime();
      if(!isNaN(serverTime)) serverTimeOffsetMs = serverTime - Date.now();
    }
  }catch(e){ console.error('Could not sync server time — falling back to local device clock', e); }
}
function serverNow(){ return Date.now() + serverTimeOffsetMs; }
function todayStr(){
  // uses server-corrected time so a device with a wrong system date still defaults to the right event
  const d = new Date(serverNow());
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}
function defaultEventId(events, explicitId){
  if(explicitId) return explicitId;
  const today = events.find(e=>e.date===todayStr());
  return today ? today.id : (events[0] && events[0].id);
}

/* ---------------- admin action log ----------------
   Lightweight accountability trail for actions taken from the SAS admin panel —
   who did what, and when. Capped at 200 entries so it doesn't grow forever. */
async function logAdminAction(action, details){
  try{
    DB.adminLog = await fetchKey('adminLog', DB.adminLog || []);
    const actor = state.currentUser
      ? `${state.currentUser.name} (${state.currentUser.username || state.currentUser.id})`
      : 'Unknown';
    DB.adminLog.unshift({ id: uid('log'), timestamp: serverNow(), actor, action, details: details || '' });
    if(DB.adminLog.length > 200) DB.adminLog = DB.adminLog.slice(0, 200);
    await saveKey('adminLog', DB.adminLog);
  }catch(e){ console.error('Failed to record admin log entry', e); }
}

/* simple non-cryptographic hash - fine for a school demo, not production auth */
function hashPw(pw){
  pw = (pw || '').trim(); // guards against stray whitespace from typing/copy-paste breaking a match
  let h = 0;
  for(let i=0;i<pw.length;i++){ h = ((h<<5)-h + pw.charCodeAt(i))|0; }
  return 'h'+h.toString(36);
}
function uid(prefix){ return prefix+'_'+Math.random().toString(36).slice(2,9); }
function fmtDate(ts){ return new Date(ts).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
function normSection(s){ return (s||'').trim().toLowerCase(); }
function eventSessionType(ev){ return (ev && ev.sessionType) || 'full'; }
function scopeLabel(scope){ return scope==='ssg' ? 'SSG' : scope==='department' ? 'Department' : 'Section'; }
function scopePill(scope){
  const cls = scope==='ssg' ? 'gold' : scope==='department' ? 'navy' : 'green';
  return `<span class="pill ${cls}">${scopeLabel(scope)}</span>`;
}
const ADMIN_PAGE_SIZE = 10;
function getEventAttendees(eventId, session){
  if(!eventId || eventId==='none') return null;
  const byStudent = {};
  DB.attendance.forEach(r=>{
    if(r.eventId !== eventId) return;
    // for a whole-day event printed as two separate sheets, only include students who actually
    // showed up for that specific half of the day, not everyone who attended the event at all
    if(session==='am' && !r.amTimeIn) return;
    if(session==='pm' && !r.pmTimeIn) return;
    if(!byStudent[r.studentId]) byStudent[r.studentId] = { studentName:r.studentName, department:r.department, section:r.section, sex:(DB.users[r.studentId]||{}).sex || '' };
  });
  return Object.values(byStudent).sort((a,b)=>a.studentName.localeCompare(b.studentName));
}
function chunkArray(arr, size){
  const out = [];
  for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
}
function toTitleCase(str){
  if(!str) return str;
  return str.toLowerCase().split(' ').map(word => word ? word.charAt(0).toUpperCase() + word.slice(1) : word).join(' ');
}
function formatDateLong(dateStr){
  if(!dateStr) return '';
  const parts = dateStr.split('-');
  if(parts.length !== 3) return dateStr; // not in YYYY-MM-DD form — show as-is rather than guess
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const [y, m, day] = parts;
  const monthName = months[parseInt(m,10)-1];
  if(!monthName) return dateStr;
  return `${monthName} ${String(parseInt(day,10)).padStart(2,'0')}, ${y}`;
}
function paginate(list, page, pageSize){
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  const clampedPage = Math.min(Math.max(1, page || 1), totalPages);
  const start = (clampedPage-1)*pageSize;
  return { items: list.slice(start, start+pageSize), totalPages, page: clampedPage };
}
function paginationControls(page, totalPages, idPrefix){
  if(totalPages<=1) return '';
  return `
  <div class="pagination">
    <button class="btn-ghost" id="${idPrefix}-prev-btn" ${page<=1?'disabled':''}>Previous</button>
    <span class="page-info">Page ${page} of ${totalPages}</span>
    <button class="btn-ghost" id="${idPrefix}-next-btn" ${page>=totalPages?'disabled':''}>Next</button>
  </div>`;
}
function reRenderPreservingFocus(){
  const active = document.activeElement;
  const id = active && active.id;
  const selStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  const selEnd = active && typeof active.selectionEnd === 'number' ? active.selectionEnd : null;
  render();
  if(id){
    const el = document.getElementById(id);
    if(el){
      el.focus();
      if(selStart !== null && el.setSelectionRange){
        try{ el.setSelectionRange(selStart, selEnd); }catch(e){}
      }
    }
  }
}
function attendanceStatusPill(record, ev){
  const st = eventSessionType(ev);
  if(st==='am'){
    return (record.amTimeIn && record.amTimeOut) ? '<span class="pill green">Present</span>' : '<span class="pill gold">Time-in only</span>';
  }
  if(st==='pm'){
    return (record.pmTimeIn && record.pmTimeOut) ? '<span class="pill green">Present</span>' : '<span class="pill gold">Time-in only</span>';
  }
  const amDone = record.amTimeIn && record.amTimeOut;
  const pmDone = record.pmTimeIn && record.pmTimeOut;
  if(amDone && pmDone) return '<span class="pill green">Present (full day)</span>';
  if(amDone || pmDone) return '<span class="pill gold">Half day only</span>';
  return '<span class="pill gold">Incomplete</span>';
}
function generateTempPassword(){
  // TEMP-XXXX format: all uppercase (no case-sensitivity confusion when retyped),
  // avoids ambiguous chars (0/O, 1/I/L)
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for(let i=0;i<4;i++){ code += chars[Math.floor(Math.random()*chars.length)]; }
  return `TEMP-${code}`;
}

const DEFAULT_DEPTS = ['CS Department','Business Department','Engineering Department','Arts & Sciences','Nursing Department'];
const ROTATE_MS = 20000;   // how often the officer's QR auto-refreshes
const TOKEN_TTL_MS = 25000; // grace window past a refresh before a code stops working entirely
let qrRotateTimer = null;
let lastRenderedQrToken = null;

let DB = { users:{}, events:[], tokens:{}, attendance:[], departments:[], sections:{}, adminLog:[], sheetSettings:null };
let state = {
  route:'login',           // login | student | officer | admin
  authTab:'student',       // student | officer | admin
  authMode:'login',        // login | register
  officerForgotModalOpen:false,
  currentUser:null,
  err:'',
  studentSubRoute:'checkin',
  officerSubRoute:'generate',
  ssgSubRoute:'generate',
  adminSubRoute:'overview',
  checkinStep:'scan',      // scan | done
  lastPhase:'in',
  lastSession:'am',
  lastScope:'section',
  cameraOpen:false,
  officerActiveEventId:null,
  officerToken:null,
  officerTokenCreatedAt:null,
  officerRotating:false,
  officerPhase:'in',       // 'in' (time-in) or 'out' (time-out)
  officerSession:'am',     // 'am' or 'pm' (only relevant for whole-day events)
  newEventDraft:{name:'', date:'', departments:[...DEFAULT_DEPTS], sessionType:'full', sections:[], venue:'', amTime:'', pmTime:''},
  eventModalOpen:false,
  editingEventId:null,
  newOfficerDraft:{name:'', username:'', password:'', department:DEFAULT_DEPTS[0], section:'', type:'section'},
  adminFilterEvent:'all',
  logPage:1,
  analyticsPage:1,
  sheetSettingsDraft:null,
  sheetSettingsModalOpen:false,
  sheetDraft:{title:'', date:'', time:'', venue:'', rows:30, eventId:'none', session:null},
  sheetPreviewPage:0,
  sheetZoom:70,
  adminFilterDept:'all',
  adminFilterScope:'all',
  profileMsg:'',
  editingOfficerUsername:null,
  editingStudentId:null,
  studentSearch:'',
  studentDeptFilter:'all',
  studentSearchQuery:'',
  studentPage:1,
  officerTypeFilter:'all',
  officerModalOpen:false,
  officerPage:1,
  officerSearchQuery:'',
  recordsShown:false,
  showAttendanceStudentId:null,
  recordsPage:1,
  exportModalOpen:false,
  attendeesPage:1,
  lastResetPassword:null,
  lastOfficerResetPassword:null
};

const DEFAULT_SHEET_SETTINGS = {
  leftLogo: '', rightLogo: '', footerLogo: '',
  leftLogoSize: 126, leftLogoX: 0, leftLogoY: 0,
  rightLogoSize: 88, rightLogoX: 0, rightLogoY: 0,
  footerLogoWidth: 188, footerLogoHeight: 75, footerLogoX: 0, footerLogoY: 0,
  university: 'OCCIDENTAL MINDORO STATE UNIVERSITY',
  address: 'Lubang, Occidental Mindoro',
  website: 'www.omsc.edu.ph',
  email: 'cd.lubang@omsc.edu.ph',
  telfax: '(043) 457-0231',
  collegeUnit: '( Name of College/Unit )',
  refNo: 'OMSU-REC-OFC-03',
  effectivityDate: '',
  revisionNo: '',
  footerLabel: 'Certified True and Correct:',
  signatureLabel: 'Signature Over Printed Name'
};
async function seedIfEmpty(){
  DB = await loadAll();
  if(!DB.sections) DB.sections = {};
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
  if(!DB.sheetSettings) DB.sheetSettings = { ...DEFAULT_SHEET_SETTINGS };
  state.newEventDraft.departments = [...DB.departments];
  state.newOfficerDraft.department = DB.departments[0];
  state.sheetSettingsDraft = { ...DEFAULT_SHEET_SETTINGS, ...DB.sheetSettings };
}
function sectionsFor(dept){ return DB.sections[dept] || []; }
function sectionOptions(dept, selected){
  const list = sectionsFor(dept);
  if(list.length===0) return '<option value="">No sections yet — ask the admin</option>';
  return list.map(s=>`<option ${s===selected?'selected':''}>${s}</option>`).join('');
}

function render(){
  const app = document.getElementById('app');
  if(state.route==='login'){ app.innerHTML = renderLogin(); attachLoginHandlers(); return; }
  if(state.route==='student'){ app.innerHTML = renderShell(renderStudent()); attachShellHandlers(); attachStudentHandlers(); return; }
  if(state.route==='officer'){ app.innerHTML = renderShell(renderOfficer()); attachShellHandlers(); attachOfficerHandlers(); return; }
  if(state.route==='ssg'){ app.innerHTML = renderShell(renderSsg()); attachShellHandlers(); attachSsgHandlers(); return; }
  if(state.route==='admin'){ app.innerHTML = renderShell(renderAdmin()); attachShellHandlers(); attachAdminHandlers(); return; }
}

/* ---------------- LOGIN ---------------- */
function pwField(id, label, placeholder){
  return `<div class="field"><label>${label}</label>
    <div class="pw-wrap">
      <input id="${id}" type="password" placeholder="${placeholder||''}">
      <button type="button" class="pw-toggle" data-target="${id}" aria-label="Show password">Show</button>
    </div>
  </div>`;
}
function wirePasswordToggles(){
  document.querySelectorAll('.pw-toggle').forEach(btn=>{
    btn.onclick = ()=>{
      const input = document.getElementById(btn.dataset.target);
      if(!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show' : 'Hide';
    };
  });
}
function renderLogin(){
  const isAdminPage = (typeof PAGE_MODE !== 'undefined' && PAGE_MODE === 'admin');
  const tab = isAdminPage ? 'admin' : (['student','officer'].includes(state.authTab) ? state.authTab : 'student');
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
        <p class="form-sub">${isAdminPage ? 'Restricted access — system admin only.' : 'Check in to an event, or open your desk.'}</p>
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
      ${pwField('s-pw', 'Password', '••••••••')}
      <button class="btn-primary" style="width:100%" id="student-login-btn">Log in</button>
    ` : `
      <div class="field"><label>Full name</label><input id="r-name" placeholder="Juan Dela Cruz"></div>
      <div class="field"><label>Student ID</label><input id="r-id" placeholder="e.g. 2023-00451"></div>
      <div class="field"><label>Sex</label><select id="r-sex"><option value="">Select</option><option value="M">Male</option><option value="F">Female</option></select></div>
      <div class="field"><label>Department</label><select id="r-dept">${DB.departments.map(dep=>`<option>${dep}</option>`).join('')}</select></div>
      <div class="field"><label>Section</label><select id="r-section">${sectionOptions(DB.departments[0], null)}</select></div>
      ${pwField('r-pw', 'Password', 'Create a password')}
      <button class="btn-primary" style="width:100%" id="student-register-btn">Create account</button>
    `}
    <div class="hint">Your student ID doubles as your username. One account is used for every event this school year.</div>
  `;
}
function renderOfficerAuth(){
  return `
    <div class="field"><label>Officer username</label><input id="o-user" placeholder="set by the system admin"></div>
    ${pwField('o-pw', 'Password', '••••••••')}
    <button class="btn-primary" style="width:100%" id="officer-login-btn">Log in</button>
    <p style="text-align:center; margin:10px 0 0 0;"><a id="officer-forgot-pw-link" style="font-size:12.5px; color:var(--ink-soft); font-weight:600; cursor:pointer;">Forgot password?</a></p>
    <div class="hint">Officer accounts are created by the system admin — section officers cover one section, department officers cover a whole department, SSG officers cover every department.</div>
    ${state.officerForgotModalOpen ? renderOfficerForgotModal() : ''}
  `;
}
function renderOfficerForgotModal(){
  return `
  <div class="modal-overlay" id="officer-forgot-modal-overlay">
    <div class="modal-card">
      <button class="close-x" id="close-officer-forgot-modal-btn">&times;</button>
      <h3 style="margin-top:0;">Forgot your password?</h3>
      <p style="font-size:13.5px; color:var(--ink-soft); line-height:1.6;">
        Officer passwords can only be reset by the <strong>system admin</strong> — there's no email or SMS
        recovery for this app. Reach out to your SAS office and ask them to reset your account from
        <strong>Manage Officers</strong>. They'll give you a new temporary password to log in with, which
        you should change right away under <strong>My Profile</strong> once you're in.
      </p>
      <button class="btn-primary" style="width:100%; margin-top:8px;" id="close-officer-forgot-modal-btn-2">Got it</button>
    </div>
  </div>`;
}
function renderAdminAuth(){
  return `
    <div class="field"><label>Admin username</label><input id="a-user" placeholder="Enter your admin username"></div>
    ${pwField('a-pw', 'Password', '••••••••')}
    <button class="btn-primary" style="width:100%" id="admin-login-btn">Log in</button>
    <div class="hint">Default seed account: <span class="mono">sas-admin</span> / <span class="mono">ChangeMe123</span> — change this immediately after first login.</div>
  `;
}

function attachLoginHandlers(){
  document.querySelectorAll('.auth-tab').forEach(el=>{
    el.onclick = ()=>{ state.authTab = el.dataset.tab; state.err=''; state.officerForgotModalOpen=false; render(); };
  });
  document.querySelectorAll('.auth-sub a').forEach(el=>{
    el.onclick = ()=>{ state.authMode = el.dataset.mode; state.err=''; render(); };
  });
  const rDept = document.getElementById('r-dept');
  if(rDept) rDept.onchange = ()=>{
    const secSel = document.getElementById('r-section');
    if(secSel) secSel.innerHTML = sectionOptions(rDept.value, null);
  };
  const sLogin = document.getElementById('student-login-btn');
  if(sLogin) sLogin.onclick = async ()=>{
    const id = document.getElementById('s-id').value.trim();
    const pw = document.getElementById('s-pw').value;
    DB.users = await fetchKey('users', DB.users); // always check against the current account, not whatever loaded when this tab opened
    const u = DB.users[id];
    if(!u || u.role!=='student' || u.passwordHash!==hashPw(pw)){ state.err='Incorrect student ID or password.'; render(); return; }
    state.currentUser = u; state.route='student'; state.err=''; startBackgroundSync(); render();
  };
  const sReg = document.getElementById('student-register-btn');
  if(sReg) sReg.onclick = async ()=>{
    const name = document.getElementById('r-name').value.trim();
    const id = document.getElementById('r-id').value.trim();
    const sex = document.getElementById('r-sex').value;
    const section = document.getElementById('r-section').value.trim();
    const department = document.getElementById('r-dept').value;
    const pw = document.getElementById('r-pw').value;
    if(!name || !id || !sex || !section || !department || !pw){ state.err='Please fill in every field — if Section only shows "No sections yet," ask the admin to add one for your department first.'; render(); return; }
    DB.users = await fetchKey('users', DB.users);
    if(DB.users[id]){ state.err='An account with that student ID already exists.'; render(); return; }
    DB.users[id] = {id, role:'student', name, sex, section, department, passwordHash:hashPw(pw)};
    await saveKey('users', DB.users);
    state.currentUser = DB.users[id]; state.route='student'; state.err=''; startBackgroundSync(); render();
  };
  const oLogin = document.getElementById('officer-login-btn');
  if(oLogin) oLogin.onclick = async ()=>{
    const user = document.getElementById('o-user').value.trim();
    const pw = document.getElementById('o-pw').value;
    DB.users = await fetchKey('users', DB.users);
    const u = DB.users[user];
    if(!u || (u.role!=='officer' && u.role!=='ssg') || u.passwordHash!==hashPw(pw)){ state.err='Incorrect username or password.'; render(); return; }
    // refresh reference data too, in case this tab was open/loaded well before events were set up
    DB.events = await fetchKey('events', DB.events);
    DB.departments = await fetchKey('departments', DB.departments);
    DB.sections = await fetchKey('sections', DB.sections);
    state.currentUser = u; state.route = u.role; state.err=''; startBackgroundSync(); render();
  };
  const forgotLink = document.getElementById('officer-forgot-pw-link');
  if(forgotLink) forgotLink.onclick = ()=>{ state.officerForgotModalOpen = true; render(); };
  const closeForgot = ()=>{ state.officerForgotModalOpen = false; render(); };
  const closeForgotBtn1 = document.getElementById('close-officer-forgot-modal-btn');
  if(closeForgotBtn1) closeForgotBtn1.onclick = closeForgot;
  const closeForgotBtn2 = document.getElementById('close-officer-forgot-modal-btn-2');
  if(closeForgotBtn2) closeForgotBtn2.onclick = closeForgot;
  const forgotOverlay = document.getElementById('officer-forgot-modal-overlay');
  if(forgotOverlay) forgotOverlay.onclick = (e)=>{ if(e.target === forgotOverlay) closeForgot(); };
  const aLogin = document.getElementById('admin-login-btn');
  if(aLogin) aLogin.onclick = async ()=>{
    const user = document.getElementById('a-user').value.trim();
    const pw = document.getElementById('a-pw').value;
    DB.users = await fetchKey('users', DB.users);
    const u = DB.users[user];
    if(!u || u.role!=='admin' || u.passwordHash!==hashPw(pw)){ state.err='Incorrect username or password.'; render(); return; }
    state.currentUser = u; state.route='admin'; state.err=''; startBackgroundSync(); render();
  };
  wirePasswordToggles();
}

/* ---------------- SHELL ---------------- */
function renderShell(innerHtml){
  const u = state.currentUser;
  const role = u.role;
  const items = role==='student' ? [['checkin','Check In'],['history','My Attendance'],['profile','My Profile']]
              : role==='officer' ? [['generate','Generate QR'],['attendees','Attendees'],['profile','My Profile']]
              : role==='ssg' ? [['generate','Generate QR'],['attendees','Attendees'],['profile','My Profile']]
              : [['overview','Overview'],['analytics','Analytics'],['events','Manage Events'],['departments','Departments'],['students','Manage Students'],['officers','Manage Officers'],['records','All Records'],['sheet','Attendance Sheet'],['log','Activity Log'],['profile','My Profile']];
  const sub = role==='student' ? state.studentSubRoute : role==='officer' ? state.officerSubRoute : role==='ssg' ? state.ssgSubRoute : state.adminSubRoute;
  const roleLabel = role==='admin'?'System Admin':role==='officer'?(u.section?'Section Officer':'Department Officer'):role==='ssg'?'SSG Officer':'Student';
  return `
  <div class="shell">
    <div class="sidebar">
      <div class="sidebar-top">
        <div>
          <div class="brand">Attendance System</div>
          <div class="role-tag">${roleLabel}</div>
        </div>
        <button class="logout-chip" id="logout-btn">Log out</button>
      </div>
      <nav class="nav-strip">
        ${items.map(([key,label])=>`<button class="nav-item ${sub===key?'active':''}" data-sub="${key}">${label}</button>`).join('')}
      </nav>
      <div class="who-name">Signed in as<br><strong style="color:#fff;">${u.name}</strong></div>
    </div>
    <div class="main">${innerHtml}</div>
  </div>`;
}
function attachShellHandlers(){
  document.querySelectorAll('.nav-item[data-sub]').forEach(el=>{
    el.onclick = async ()=>{
      const role = state.currentUser.role;
      const sub = el.dataset.sub;
      if(role==='student'){ state.studentSubRoute = sub; state.checkinStep='scan'; }
      if(role==='officer'){
        if(sub !== 'generate'){ stopQrRotation(); state.officerRotating=false; }
        state.officerSubRoute = sub;
      }
      if(role==='ssg'){
        if(sub !== 'generate'){ stopQrRotation(); state.officerRotating=false; }
        state.ssgSubRoute = sub;
      }
      if(role==='admin'){ state.adminSubRoute = sub; }
      state.err=''; state.profileMsg=''; state.lastResetPassword=null; state.lastOfficerResetPassword=null; state.editingStudentId=null; state.editingOfficerUsername=null; state.recordsShown=false; state.showAttendanceStudentId=null; state.attendeesPage=1; state.eventModalOpen=false; state.editingEventId=null; state.sheetSettingsModalOpen=false; state.exportModalOpen=false;
      // an account's own department/section may have been changed by admin since login —
      // always refresh it so a stale, already-logged-in session doesn't keep enforcing old rules
      if(role==='officer' || role==='ssg' || role==='student'){
        DB.users = await fetchKey('users', DB.users);
        const fresh = DB.users[state.currentUser.id];
        if(fresh) state.currentUser = fresh;
      }
      // events/departments/sections are admin-editable reference data that any role's screen
      // may depend on (e.g. an officer's "Generate QR" event list) — always refresh on
      // navigation so a long-open tab doesn't keep enforcing a stale copy from page load
      DB.events = await fetchKey('events', DB.events);
      DB.departments = await fetchKey('departments', DB.departments);
      DB.sections = await fetchKey('sections', DB.sections);
      // views that show shared records should always reflect what's actually in the database right now,
      // not just whatever happened to be loaded when this tab was first opened
      if((role==='student' && sub==='history') || ((role==='officer'||role==='ssg') && sub==='attendees') || (role==='admin' && (sub==='overview' || sub==='records' || sub==='analytics' || sub==='sheet'))){
        DB.attendance = await fetchKey('attendance', DB.attendance);
      }
      if(role==='admin' && (sub==='officers' || sub==='sheet')){
        DB.users = await fetchKey('users', DB.users);
      }
      if(role==='admin' && sub==='log'){
        DB.adminLog = await fetchKey('adminLog', DB.adminLog || []);
        state.logPage = 1;
      }
      if(role==='admin' && sub==='analytics'){
        state.analyticsPage = 1;
      }
      render();
    };
  });
  const out = document.getElementById('logout-btn');
  if(out) out.onclick = ()=>{ stopQrRotation(); stopBackgroundSync(); state.officerRotating=false; state.currentUser=null; state.route='login'; state.err=''; render(); };
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
  const sessLabel = (state.lastSession || 'am').toUpperCase();
  const scopeLabel = state.lastScope==='ssg' ? 'SSG' : state.lastScope==='department' ? 'Department' : 'Section';
  return `
  <div class="stamp-wrap">
    <div class="stamp">${sessLabel} ${isIn ? 'TIME IN' : 'TIME OUT'}<br>${new Date().toLocaleDateString()}</div>
    <h2 style="margin-top:24px;">${isIn ? `You're timed in for ${sessLabel}` : `You're timed out for ${sessLabel}`}</h2>
    <p style="color:var(--ink-soft); text-align:center; max-width:340px;">Recorded via the <strong>${scopeLabel}</strong> desk. ${isIn ? 'Come back and scan again before you leave to complete this session.' : 'This session is now complete. If there\'s another session today, scan again when it starts.'}</p>
    <button class="btn-ghost" id="checkin-again-btn" style="margin-top:14px;">Back to check-in</button>
  </div>`;
}
function renderHistory(){
  const mine = DB.attendance.filter(a=>a.studentId===state.currentUser.id).sort((a,b)=>(b.amTimeIn||b.pmTimeIn||0)-(a.amTimeIn||a.pmTimeIn||0));
  if(mine.length===0) return `<div class="page-head"><h1>My Attendance</h1></div><div class="empty">No check-ins yet — scan a QR code at an event to get started.</div>`;
  return `
  <div class="page-head"><h1>My Attendance</h1><p>${mine.length} record${mine.length>1?'s':''} recorded this year — one row per desk you've checked in with (section, department, or SSG).</p></div>
  <div class="card" style="padding:0;">
    <table>
      <tr><th>Event</th><th>Via</th><th>Department</th><th>AM in</th><th>AM out</th><th>PM in</th><th>PM out</th><th>Status</th></tr>
      ${mine.map(a=>{
        const ev = DB.events.find(e=>e.id===a.eventId);
        const eventName = ev ? ev.name : a.eventName; // fall back to the stored snapshot only if the event itself was deleted
        return `<tr><td>${eventName}</td><td>${scopePill(a.scope)}</td><td><span class="badge-dept">${a.department}</span></td><td>${a.amTimeIn?fmtDate(a.amTimeIn):'—'}</td><td>${a.amTimeOut?fmtDate(a.amTimeOut):'—'}</td><td>${a.pmTimeIn?fmtDate(a.pmTimeIn):'—'}</td><td>${a.pmTimeOut?fmtDate(a.pmTimeOut):'—'}</td><td>${attendanceStatusPill(a, ev)}</td></tr>`;
      }).join('')}
    </table>
  </div>`;
}
function renderCameraModal(){
  return `
  <div class="camera-modal" id="camera-modal">
    <div class="camera-card">
      <button class="close-x" id="close-camera-btn">&times;</button>
      <h3 style="margin-top:0;">Point your camera at the QR code</h3>
      <div class="scan-frame">
        <video id="qr-video" playsinline muted></video>
        <div class="scan-reticle"></div>
      </div>
      <canvas id="qr-canvas" style="display:none;"></canvas>
      <p style="font-size:12px; color:var(--ink-soft);" id="camera-status">Requesting camera access…</p>
      <p style="font-size:11.5px; color:var(--ink-soft);">Hold steady, fill the square with the code, and avoid glare from the officer's screen.</p>
    </div>
  </div>`;
}
let cameraStream = null, cameraLoop = null;
/* ---------------- attendance sheet logo dragging ----------------
   A single pair of document-level listeners, registered once — not per render — so
   repeatedly opening/closing this page never accumulates duplicate handlers. */
let sheetDragState = null;
function handleSheetLogoDragMove(e){
  if(!sheetDragState) return;
  const point = e.touches ? e.touches[0] : e;
  const dx = point.clientX - sheetDragState.startX;
  const dy = point.clientY - sheetDragState.startY;
  const newX = Math.round(sheetDragState.origX + dx);
  const newY = Math.round(sheetDragState.origY + dy);
  if(state.sheetSettingsDraft){
    state.sheetSettingsDraft[sheetDragState.key+'LogoX'] = newX;
    state.sheetSettingsDraft[sheetDragState.key+'LogoY'] = newY;
  }
  // the same logo can appear on multiple printed pages — keep every instance in sync live, not just the one being dragged
  document.querySelectorAll(`.ps-draggable-logo[data-logo="${sheetDragState.key}"]`).forEach(img=>{
    img.style.transform = `translate(${newX}px, ${newY}px)`;
  });
  if(e.cancelable) e.preventDefault();
}
function handleSheetLogoDragEnd(){ sheetDragState = null; }
document.addEventListener('mousemove', handleSheetLogoDragMove);
document.addEventListener('touchmove', handleSheetLogoDragMove, {passive:false});
document.addEventListener('mouseup', handleSheetLogoDragEnd);
document.addEventListener('touchend', handleSheetLogoDragEnd);
function attachStudentHandlers(){
  const openCam = document.getElementById('open-camera-btn');
  if(openCam) openCam.onclick = ()=>{ state.cameraOpen=true; state.err=''; render(); };
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
  const fail = (msg)=>{
    state.err = msg;
    // close the camera on any validation failure — otherwise this error renders
    // invisibly underneath the still-open camera overlay, and scanning just silently
    // keeps re-rejecting the same code every frame with no visible feedback at all
    stopCamera();
    state.cameraOpen = false;
    render();
  };
  if(!rawCode){ fail('Enter or scan a code first.'); return; }
  const code = rawCode.trim().toUpperCase();
  // pull the latest codes from storage — the officer may have generated/rotated one since this tab loaded
  DB.tokens = await fetchKey('tokens', DB.tokens);
  const tok = DB.tokens[code];
  if(!tok){ fail('That code is not valid. Ask the officer for the current QR.'); return; }
  if((serverNow() - tok.createdAt) > TOKEN_TTL_MS){
    fail('This QR code has expired. It refreshes often — ask the officer to show the current one.');
    return;
  }
  if(tok.scope === 'section'){
    if(tok.department !== state.currentUser.department){
      fail(`This QR is for ${tok.department}. You're registered under ${state.currentUser.department}, so it can't be used to check you in.`);
      return;
    }
    if(normSection(tok.section) !== normSection(state.currentUser.section)){
      fail(`This QR is for section ${tok.section}. You're registered under ${state.currentUser.section}, so it can't be used to check you in.`);
      return;
    }
  } else if(tok.scope === 'department'){
    if(tok.department !== state.currentUser.department){
      fail(`This QR is for ${tok.department}. You're registered under ${state.currentUser.department}, so it can't be used to check you in.`);
      return;
    }
  }
  // scope === 'ssg' skips department/section checks entirely
  const u = state.currentUser;
  const ev = DB.events.find(e=>e.id===tok.eventId);
  if(!ev){ fail('This event no longer exists.'); return; }
  // pull the latest attendance log too, so duplicate/order checks reflect other devices
  DB.attendance = await fetchKey('attendance', DB.attendance);
  // one independent record per (event, student, scope) — a Section, Department, and SSG
  // check-in for the same event/student are tracked separately, not merged into one record
  let record = DB.attendance.find(a=>a.eventId===ev.id && a.studentId===u.id && a.scope===tok.scope);
  const session = tok.session === 'pm' ? 'pm' : 'am';
  const sessLabel = session.toUpperCase();
  const scopeLabel = tok.scope==='ssg' ? 'SSG' : tok.scope==='department' ? 'Department' : 'Section';
  const inField = session + 'TimeIn', outField = session + 'TimeOut';
  if(tok.phase==='out'){
    if(!record || !record[inField]){ fail(`You need to time in for ${sessLabel} (${scopeLabel}) first before you can time out.`); return; }
    if(record[outField]){ fail(`You already timed out for ${sessLabel} (${scopeLabel}) on this event.`); return; }
    record[outField] = Date.now();
    record.tokenUsed = code;
  } else {
    if(record && record[inField]){ fail(`You already timed in for ${sessLabel} (${scopeLabel}) on this event.`); return; }
    if(!record){
      record = {id: uid('att'), eventId:ev.id, eventName:ev.name, department:u.department, studentId:u.id, studentName:u.name, section:u.section, scope:tok.scope, amTimeIn:null, amTimeOut:null, pmTimeIn:null, pmTimeOut:null, tokenUsed:null};
      DB.attendance.push(record);
    }
    record[inField] = Date.now();
    record.tokenUsed = code;
  }
  await saveKey('attendance', DB.attendance);
  state.checkinStep = 'done';
  state.lastPhase = tok.phase;
  state.lastSession = session;
  state.lastScope = tok.scope;
  state.err = '';
  stopCamera();
  state.cameraOpen = false;
  render();
}
let scanningPaused = false;
async function startCamera(){
  if(cameraStream){ return; } // a stream is already running — don't start a second one on top of it
  setTimeout(async ()=>{
    const video = document.getElementById('qr-video');
    const statusEl = document.getElementById('camera-status');
    if(!video) return;
    if(cameraStream){ return; } // guard again in case two calls landed inside the same 50ms window
    if(typeof jsQR !== 'function'){
      if(statusEl) statusEl.textContent = 'The QR scanner failed to load (possibly blocked by an ad blocker or offline). Please use "Enter code manually" below instead.';
      return;
    }
    const constraintAttempts = [
      {video:{facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720}}},
      {video:{width:{ideal:1280}, height:{ideal:720}}},
      {video:true}
    ];
    let lastError = null;
    for(const constraints of constraintAttempts){
      try{
        cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        lastError = null;
        break;
      }catch(e){ lastError = e; }
    }
    if(!cameraStream){
      if(statusEl){
        statusEl.textContent = (lastError && lastError.name === 'NotAllowedError')
          ? 'Camera permission was denied. Allow camera access in your browser settings, or use "Enter code manually" below.'
          : 'Camera unavailable — close this and use "Enter code manually" instead.';
      }
      return;
    }
    video.srcObject = cameraStream;
    await video.play();
    if(statusEl) statusEl.textContent = 'Scanning…';
    const canvas = document.getElementById('qr-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    scanningPaused = false;
    cameraLoop = setInterval(()=>{
      if(scanningPaused) return;
      if(video.readyState !== video.HAVE_ENOUGH_DATA) return;
      try{
        if(canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
        if(canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
        ctx.drawImage(video,0,0,canvas.width,canvas.height);
        const img = ctx.getImageData(0,0,canvas.width,canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
        if(code && code.data){
          scanningPaused = true; // avoid firing the same frame's result multiple times while the async check runs
          tryUseToken(code.data.trim()).finally(()=>{ scanningPaused = false; });
        }
      }catch(e){
        console.error('QR scan frame failed', e);
      }
    }, 300);
  }, 50);
}
function stopCamera(){
  if(cameraLoop){ clearInterval(cameraLoop); cameraLoop=null; }
  if(cameraStream){ cameraStream.getTracks().forEach(t=>t.stop()); cameraStream=null; }
}

/* ---------------- OFFICER ---------------- */
let backgroundSyncTimer = null;
function startBackgroundSync(){
  stopBackgroundSync();
  backgroundSyncTimer = setInterval(async ()=>{
    if(!state.currentUser) return;
    // reference data (events, departments, sections) is admin-editable and can change while
    // someone is idly sitting on a screen with no nav clicks to trigger a refresh — this keeps
    // it self-healing within a few seconds instead of requiring a manual navigate-away-and-back
    const [freshEvents, freshDepartments, freshSections] = await Promise.all([
      fetchKey('events', DB.events),
      fetchKey('departments', DB.departments),
      fetchKey('sections', DB.sections)
    ]);
    const changed = JSON.stringify(freshEvents)!==JSON.stringify(DB.events)
      || JSON.stringify(freshDepartments)!==JSON.stringify(DB.departments)
      || JSON.stringify(freshSections)!==JSON.stringify(DB.sections);
    DB.events = freshEvents;
    DB.departments = freshDepartments;
    DB.sections = freshSections;
    if(changed && state.currentUser && !state.cameraOpen) render();
  }, 15000);
}
function stopBackgroundSync(){
  if(backgroundSyncTimer){ clearInterval(backgroundSyncTimer); backgroundSyncTimer=null; }
}
function stopQrRotation(){
  if(qrRotateTimer){ clearInterval(qrRotateTimer); qrRotateTimer=null; }
}
async function generateRotatingToken(eventId, department, section, phase, scope, session){
  const token = uid('qr').toUpperCase();
  DB.tokens[token] = {eventId, department, section, phase, scope: scope || 'section', session: session || 'am', createdAt: serverNow()};
  // prune this desk's old expired tokens so storage doesn't grow forever
  Object.keys(DB.tokens).forEach(t=>{
    const info = DB.tokens[t];
    if(info.eventId===eventId && info.department===department && normSection(info.section)===normSection(section) && t!==token && (serverNow()-info.createdAt)>TOKEN_TTL_MS){
      delete DB.tokens[t];
    }
  });
  await saveKey('tokens', DB.tokens);
  state.officerToken = token;
  state.officerTokenCreatedAt = serverNow();
}
async function startQrRotation(eventId, department, section, phase, scope, session){
  stopQrRotation();
  lastRenderedQrToken = null;
  await generateRotatingToken(eventId, department, section, phase, scope, session);
  render();
  qrRotateTimer = setInterval(()=>officerTick(eventId, department, section, phase, scope, session), 2000);
}
async function officerTick(eventId, department, section, phase, scope, session){
  if(!state.officerRotating || !state.officerToken) return;
  // pull the latest attendance log so we can tell if someone just used this code
  DB.attendance = await fetchKey('attendance', DB.attendance);
  const consumed = DB.attendance.some(a => a.tokenUsed === state.officerToken);
  const elapsed = serverNow() - state.officerTokenCreatedAt;
  if(consumed || elapsed >= ROTATE_MS){
    await generateRotatingToken(eventId, department, section, phase, scope, session);
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
  const myEvents = DB.events.filter(e=>{
    if(!e.departments.includes(u.department)) return false;
    // section officers only see events open to every section, or ones that specifically include their own
    if(u.section && e.sections && e.sections.length>0){
      return e.sections.some(s=>normSection(s)===normSection(u.section));
    }
    return true;
  });
  if(state.officerSubRoute==='generate') return renderOfficerGenerate(myEvents);
  if(state.officerSubRoute==='attendees') return renderOfficerAttendees(myEvents);
  return renderProfile();
}
function renderOfficerGenerate(myEvents){
  const activeId = defaultEventId(myEvents, state.officerActiveEventId);
  const activeEvent = myEvents.find(e=>e.id===activeId);
  const evSession = eventSessionType(activeEvent);
  const session = evSession==='full' ? (state.officerSession || 'am') : evSession;
  const remaining = state.officerRotating && state.officerTokenCreatedAt
    ? Math.max(0, Math.ceil((ROTATE_MS - (serverNow()-state.officerTokenCreatedAt))/1000)) : null;
  const mySection = state.currentUser.section;
  return `
  <div class="page-head"><h1>Generate check-in QR</h1><p><span class="badge-dept">${state.currentUser.department}</span> ${mySection ? `· Section <span class="badge-dept">${mySection}</span>` : `· <span class="pill gold">Whole department — every section</span>`}</p></div>
  ${myEvents.length===0 ? `<div class="empty">No events have been set up for your department yet. Ask the system admin to add one.</div>` : `
  <div class="card" style="max-width:480px;">
    <div class="field">
      <label>Event</label>
      <select id="officer-event-select" ${state.officerRotating?'disabled':''}>
        ${myEvents.map(e=>`<option value="${e.id}" ${e.id===activeId?'selected':''}>${e.name} — ${e.date}</option>`).join('')}
      </select>
    </div>
    ${evSession==='full' ? `
    <div class="field">
      <label>Session</label>
      <div class="auth-tabs" style="margin-bottom:0;">
        <div class="auth-tab session-tab ${session==='am'?'active':''}" data-session="am" style="${state.officerRotating?'pointer-events:none; opacity:0.6;':''}">AM</div>
        <div class="auth-tab session-tab ${session==='pm'?'active':''}" data-session="pm" style="${state.officerRotating?'pointer-events:none; opacity:0.6;':''}">PM</div>
      </div>
    </div>
    ` : `<p class="hint" style="margin-top:-6px; margin-bottom:10px;">This event is ${evSession.toUpperCase()}-only — every code here is for the ${evSession.toUpperCase()} session.</p>`}
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
      <div class="pill ${state.officerPhase==='in'?'green':'gold'}" style="margin-bottom:10px;">${session.toUpperCase()} ${state.officerPhase==='in'?'TIME IN':'TIME OUT'}</div>
      <div id="qr-render"></div>
      <div class="code-text">${state.officerToken}</div>
      <div class="pill gold" id="qr-countdown" style="margin-top:12px;">Refreshes in ${remaining}s</div>
      <p style="font-size:12px; color:var(--ink-soft); margin-top:12px;">Display this on a screen at your station. It updates itself as students check in — keep the tab open.</p>
    </div>
  ` : ''}
  `}`;
}
function renderOfficerAttendees(myEvents){
  const activeId = defaultEventId(myEvents, state.officerActiveEventId);
  const ev = myEvents.find(e=>e.id===activeId);
  const mySection = state.currentUser.section;
  const myScope = mySection ? 'section' : 'department';
  const rows = ev ? DB.attendance.filter(a=>a.eventId===ev.id && a.scope===myScope && a.department===state.currentUser.department && (!mySection || normSection(a.section)===normSection(mySection))).sort((a,b)=>(b.amTimeIn||b.pmTimeIn||0)-(a.amTimeIn||a.pmTimeIn||0)) : [];
  const complete = rows.filter(r=>(r.amTimeIn&&r.amTimeOut)||(r.pmTimeIn&&r.pmTimeOut)).length;
  const { items: pageRows, totalPages, page } = paginate(rows, state.attendeesPage, ADMIN_PAGE_SIZE);
  return `
  <div class="page-head"><h1>Attendees</h1><p>Live list for ${mySection ? "your section's desk" : "your whole department's desk"} — only check-ins made through your own QR, not other desks.</p></div>
  ${myEvents.length===0 ? `<div class="empty">No events yet.</div>` : `
  <div class="card" style="max-width:300px; margin-bottom:10px;">
    <div class="field" style="margin-bottom:0;">
      <label>Event</label>
      <select id="officer-att-event-select">
        ${myEvents.map(e=>`<option value="${e.id}" ${e.id===activeId?'selected':''}>${e.name}</option>`).join('')}
      </select>
    </div>
  </div>
  <div class="grid">
    <div class="stat"><div class="num">${rows.length}</div><div class="lbl">Timed in</div></div>
    <div class="stat"><div class="num">${complete}</div><div class="lbl">Completed at least one session</div></div>
  </div>
  <div style="margin-bottom:10px;">
    <button class="btn-danger" id="reset-event-attendance-btn" ${rows.length===0?'disabled':''}>Reset attendance for this event (${rows.length})</button>
    <p class="hint" style="margin-top:8px;">Clears check-ins made through ${mySection ? 'your section' : 'your department'}'s desk only — records from other desks for the same event are untouched. Students will need to scan in again from scratch.</p>
  </div>
  <div class="card" style="padding:0;">
    <table id="officer-att-table">
      <tr><th>Student</th><th>Section</th><th>AM in</th><th>AM out</th><th>PM in</th><th>PM out</th><th>Status</th><th></th></tr>
      ${pageRows.map(r=>`<tr><td>${r.studentName}</td><td>${r.section}</td><td>${r.amTimeIn?fmtDate(r.amTimeIn):'—'}</td><td>${r.amTimeOut?fmtDate(r.amTimeOut):'—'}</td><td>${r.pmTimeIn?fmtDate(r.pmTimeIn):'—'}</td><td>${r.pmTimeOut?fmtDate(r.pmTimeOut):'—'}</td><td>${attendanceStatusPill(r, ev)}</td><td><button class="btn-danger" data-remove-att="${r.id}">Remove</button></td></tr>`).join('') || `<tr><td colspan="8" class="empty">No check-ins yet for this event.</td></tr>`}
    </table>
  </div>
  ${paginationControls(page, totalPages, 'attendees')}
  `}`;
}
async function removeAttendanceRecord(recordId){
  DB.attendance = await fetchKey('attendance', DB.attendance);
  DB.attendance = DB.attendance.filter(a=>a.id!==recordId);
  await saveKey('attendance', DB.attendance);
}

/* ---------------- SSG (all-department attendance) ---------------- */
function renderSsg(){
  const allEvents = DB.events;
  if(state.ssgSubRoute==='generate') return renderSsgGenerate(allEvents);
  if(state.ssgSubRoute==='attendees') return renderSsgAttendees(allEvents);
  return renderProfile();
}
function renderSsgGenerate(allEvents){
  const activeId = defaultEventId(allEvents, state.officerActiveEventId);
  const activeEvent = allEvents.find(e=>e.id===activeId);
  const evSession = eventSessionType(activeEvent);
  const session = evSession==='full' ? (state.officerSession || 'am') : evSession;
  const remaining = state.officerRotating && state.officerTokenCreatedAt
    ? Math.max(0, Math.ceil((ROTATE_MS - (serverNow()-state.officerTokenCreatedAt))/1000)) : null;
  return `
  <div class="page-head"><h1>Generate check-in QR</h1><p><span class="pill gold">SSG — all departments &amp; sections</span></p></div>
  ${allEvents.length===0 ? `<div class="empty">No events have been set up yet. Ask the system admin to add one.</div>` : `
  <div class="card" style="max-width:480px;">
    <div class="field">
      <label>Event</label>
      <select id="officer-event-select" ${state.officerRotating?'disabled':''}>
        ${allEvents.map(e=>`<option value="${e.id}" ${e.id===activeId?'selected':''}>${e.name} — ${e.date}</option>`).join('')}
      </select>
    </div>
    ${evSession==='full' ? `
    <div class="field">
      <label>Session</label>
      <div class="auth-tabs" style="margin-bottom:0;">
        <div class="auth-tab session-tab ${session==='am'?'active':''}" data-session="am" style="${state.officerRotating?'pointer-events:none; opacity:0.6;':''}">AM</div>
        <div class="auth-tab session-tab ${session==='pm'?'active':''}" data-session="pm" style="${state.officerRotating?'pointer-events:none; opacity:0.6;':''}">PM</div>
      </div>
    </div>
    ` : `<p class="hint" style="margin-top:-6px; margin-bottom:10px;">This event is ${evSession.toUpperCase()}-only — every code here is for the ${evSession.toUpperCase()} session.</p>`}
    <div class="field">
      <label>Which check-in is this?</label>
      <div class="auth-tabs" style="margin-bottom:0;">
        <div class="auth-tab phase-tab ${state.officerPhase==='in'?'active':''}" data-phase="in" style="${state.officerRotating?'pointer-events:none; opacity:0.6;':''}">Before event (time in)</div>
        <div class="auth-tab phase-tab ${state.officerPhase==='out'?'active':''}" data-phase="out" style="${state.officerRotating?'pointer-events:none; opacity:0.6;':''}">Before they leave (time out)</div>
      </div>
    </div>
    ${!state.officerRotating ? `
      <button class="btn-gold" style="width:100%; margin-top:16px;" id="start-qr-btn">Start live check-in</button>
      <p class="hint">Any student from any department or section can use this code — it's not restricted like a department desk's. It refreshes the instant someone checks in, and also on its own every ${ROTATE_MS/1000}s if idle.</p>
    ` : `
      <button class="btn-ghost" style="width:100%; margin-top:16px;" id="stop-qr-btn">Stop live check-in</button>
    `}
  </div>
  ${state.officerRotating && state.officerToken ? `
    <div class="qr-box" style="max-width:320px; margin-top:20px;">
      <div class="pill ${state.officerPhase==='in'?'green':'gold'}" style="margin-bottom:10px;">${session.toUpperCase()} ${state.officerPhase==='in'?'TIME IN':'TIME OUT'}</div>
      <div id="qr-render"></div>
      <div class="code-text">${state.officerToken}</div>
      <div class="pill gold" id="qr-countdown" style="margin-top:12px;">Refreshes in ${remaining}s</div>
      <p style="font-size:12px; color:var(--ink-soft); margin-top:12px;">Display this on a screen at your station. It updates itself as students check in — keep the tab open.</p>
    </div>
  ` : ''}
  `}`;
}
function renderSsgAttendees(allEvents){
  const activeId = defaultEventId(allEvents, state.officerActiveEventId);
  const ev = allEvents.find(e=>e.id===activeId);
  const rows = ev ? DB.attendance.filter(a=>a.eventId===ev.id && a.scope==='ssg').sort((a,b)=>(b.amTimeIn||b.pmTimeIn||0)-(a.amTimeIn||a.pmTimeIn||0)) : [];
  const complete = rows.filter(r=>(r.amTimeIn&&r.amTimeOut)||(r.pmTimeIn&&r.pmTimeOut)).length;
  const { items: pageRows, totalPages, page } = paginate(rows, state.attendeesPage, ADMIN_PAGE_SIZE);
  return `
  <div class="page-head"><h1>Attendees</h1><p>Live list across every department and section for this event — only check-ins made through the SSG desk, not individual department/section desks.</p></div>
  ${allEvents.length===0 ? `<div class="empty">No events yet.</div>` : `
  <div class="card" style="max-width:300px; margin-bottom:10px;">
    <div class="field" style="margin-bottom:0;">
      <label>Event</label>
      <select id="officer-att-event-select">
        ${allEvents.map(e=>`<option value="${e.id}" ${e.id===activeId?'selected':''}>${e.name}</option>`).join('')}
      </select>
    </div>
  </div>
  <div class="grid">
    <div class="stat"><div class="num">${rows.length}</div><div class="lbl">Timed in</div></div>
    <div class="stat"><div class="num">${complete}</div><div class="lbl">Completed at least one session</div></div>
  </div>
  <div style="margin-bottom:10px;">
    <button class="btn-danger" id="reset-event-attendance-btn" ${rows.length===0?'disabled':''}>Reset attendance for this event (${rows.length})</button>
    <p class="hint" style="margin-top:8px;">Clears SSG check-ins across every department for this event — section and department desk records are untouched. Students will need to scan in again from scratch.</p>
  </div>
  <div class="card" style="padding:0;">
    <table id="officer-att-table">
      <tr><th>Student</th><th>Department</th><th>Section</th><th>AM in</th><th>AM out</th><th>PM in</th><th>PM out</th><th>Status</th><th></th></tr>
      ${pageRows.map(r=>`<tr><td>${r.studentName}</td><td><span class="badge-dept">${r.department}</span></td><td>${r.section}</td><td>${r.amTimeIn?fmtDate(r.amTimeIn):'—'}</td><td>${r.amTimeOut?fmtDate(r.amTimeOut):'—'}</td><td>${r.pmTimeIn?fmtDate(r.pmTimeIn):'—'}</td><td>${r.pmTimeOut?fmtDate(r.pmTimeOut):'—'}</td><td>${attendanceStatusPill(r, ev)}</td><td><button class="btn-danger" data-remove-att="${r.id}">Remove</button></td></tr>`).join('') || `<tr><td colspan="9" class="empty">No check-ins yet for this event.</td></tr>`}
    </table>
  </div>
  ${paginationControls(page, totalPages, 'attendees')}
  `}`;
}
function attachSsgHandlers(){
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
    const ev = DB.events.find(e=>e.id===eventId);
    const evSession = eventSessionType(ev);
    const session = evSession==='full' ? (state.officerSession || 'am') : evSession;
    await startQrRotation(eventId, null, null, state.officerPhase, 'ssg', session);
  };
  document.querySelectorAll('.session-tab').forEach(el=>{
    el.onclick = ()=>{
      if(state.officerRotating) return;
      state.officerSession = el.dataset.session;
      render();
    };
  });
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
  if(attSel) attSel.onchange = ()=>{ state.officerActiveEventId = attSel.value; state.attendeesPage = 1; render(); };
  if(state.officerRotating && state.officerToken && lastRenderedQrToken !== state.officerToken){
    setTimeout(()=>{
      const holder = document.getElementById('qr-render');
      if(!holder) return;
      if(window.QRCode){
        holder.innerHTML = '';
        new QRCode(holder, {text: state.officerToken, width:200, height:200, colorDark:'#1B2A4A', colorLight:'#ffffff'});
        lastRenderedQrToken = state.officerToken;
      } else {
        holder.innerHTML = '<p style="font-size:12px; color:var(--danger);">QR image failed to load — students can still use the code below.</p>';
      }
    }, 30);
  }
  document.querySelectorAll('[data-remove-att]').forEach(el=>{
    el.onclick = async ()=>{
      if(!confirm('Remove this attendance record? The student will need to scan again from scratch.')) return;
      await removeAttendanceRecord(el.dataset.removeAtt);
      render();
    };
  });
  const resetEventBtn = document.getElementById('reset-event-attendance-btn');
  if(resetEventBtn) resetEventBtn.onclick = async ()=>{
    const eventSelect = document.getElementById('officer-att-event-select');
    const eventId = eventSelect ? eventSelect.value : state.officerActiveEventId;
    if(!eventId) return;
    DB.attendance = await fetchKey('attendance', DB.attendance);
    const toRemove = DB.attendance.filter(a => a.eventId===eventId && a.scope==='ssg');
    if(toRemove.length===0){ render(); return; }
    if(!confirm(`Reset attendance for this event? This permanently removes ${toRemove.length} SSG record${toRemove.length===1?'':'s'} across every department — section and department desk records for the same event are untouched. Students will need to scan in again from scratch.`)) return;
    DB.attendance = DB.attendance.filter(a => !(a.eventId===eventId && a.scope==='ssg'));
    await saveKey('attendance', DB.attendance);
    render();
  };
  const attendeesPrevBtn = document.getElementById('attendees-prev-btn');
  if(attendeesPrevBtn) attendeesPrevBtn.onclick = ()=>{ state.attendeesPage = Math.max(1, (state.attendeesPage||1)-1); render(); };
  const attendeesNextBtn = document.getElementById('attendees-next-btn');
  if(attendeesNextBtn) attendeesNextBtn.onclick = ()=>{ state.attendeesPage = (state.attendeesPage||1)+1; render(); };
  if(state.ssgSubRoute==='profile') attachProfileHandlers();
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
    // re-check against fresh data in case admin changed this event's section restriction
    // since this page last loaded — closes the gap the periodic background sync leaves open
    DB.events = await fetchKey('events', DB.events);
    const ev = DB.events.find(e=>e.id===eventId);
    if(!ev){ state.err='This event no longer exists. Pick another one.'; render(); return; }
    const mySection = state.currentUser.section;
    if(mySection && ev.sections && ev.sections.length>0 && !ev.sections.some(s=>normSection(s)===normSection(mySection))){
      state.err='This event is no longer open to your section. Refresh the page to see the current event list.';
      render(); return;
    }
    state.officerActiveEventId = eventId;
    state.officerRotating = true;
    const scope = state.currentUser.section ? 'section' : 'department';
    const evSession = eventSessionType(ev);
    const session = evSession==='full' ? (state.officerSession || 'am') : evSession;
    await startQrRotation(eventId, state.currentUser.department, state.currentUser.section || null, state.officerPhase, scope, session);
  };
  document.querySelectorAll('.session-tab').forEach(el=>{
    el.onclick = ()=>{
      if(state.officerRotating) return;
      state.officerSession = el.dataset.session;
      render();
    };
  });
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
  if(attSel) attSel.onchange = ()=>{ state.officerActiveEventId = attSel.value; state.attendeesPage = 1; render(); };
  // only redraw the QR canvas when the token itself has actually changed, to avoid flicker on every countdown tick
  if(state.officerRotating && state.officerToken && lastRenderedQrToken !== state.officerToken){
    setTimeout(()=>{
      const holder = document.getElementById('qr-render');
      if(!holder) return;
      if(window.QRCode){
        holder.innerHTML = '';
        new QRCode(holder, {text: state.officerToken, width:200, height:200, colorDark:'#1B2A4A', colorLight:'#ffffff'});
        lastRenderedQrToken = state.officerToken;
      } else {
        holder.innerHTML = '<p style="font-size:12px; color:var(--danger);">QR image failed to load — students can still use the code below.</p>';
      }
    }, 30);
  }
  document.querySelectorAll('[data-remove-att]').forEach(el=>{
    el.onclick = async ()=>{
      if(!confirm('Remove this attendance record? The student will need to scan again from scratch.')) return;
      await removeAttendanceRecord(el.dataset.removeAtt);
      render();
    };
  });
  const resetEventBtn = document.getElementById('reset-event-attendance-btn');
  if(resetEventBtn) resetEventBtn.onclick = async ()=>{
    const eventSelect = document.getElementById('officer-att-event-select');
    const eventId = eventSelect ? eventSelect.value : state.officerActiveEventId;
    if(!eventId) return;
    const dept = state.currentUser.department;
    const section = state.currentUser.section;
    const myScope = section ? 'section' : 'department';
    const matches = a => a.eventId===eventId && a.scope===myScope && a.department===dept && (!section || normSection(a.section)===normSection(section));
    DB.attendance = await fetchKey('attendance', DB.attendance);
    const toRemove = DB.attendance.filter(matches);
    if(toRemove.length===0){ render(); return; }
    if(!confirm(`Reset attendance for this event? This permanently removes ${toRemove.length} record${toRemove.length===1?'':'s'} made through ${section ? 'your section' : 'your department'}'s desk — records from other desks are untouched. Students will need to scan in again from scratch.`)) return;
    DB.attendance = DB.attendance.filter(a => !matches(a));
    await saveKey('attendance', DB.attendance);
    render();
  };
  const attendeesPrevBtn = document.getElementById('attendees-prev-btn');
  if(attendeesPrevBtn) attendeesPrevBtn.onclick = ()=>{ state.attendeesPage = Math.max(1, (state.attendeesPage||1)-1); render(); };
  const attendeesNextBtn = document.getElementById('attendees-next-btn');
  if(attendeesNextBtn) attendeesNextBtn.onclick = ()=>{ state.attendeesPage = (state.attendeesPage||1)+1; render(); };
  if(state.officerSubRoute==='profile') attachProfileHandlers();
}

/* ---------------- PROFILE (shared by all roles) ---------------- */
function renderProfile(){
  const u = state.currentUser;
  const roleLabel = u.role==='admin' ? 'System Admin' : u.role==='officer' ? 'Department officer' : u.role==='ssg' ? 'SSG officer' : 'Student';
  return `
  <div class="page-head"><h1>My Profile</h1><p>${roleLabel} account details.</p></div>
  <div class="card" style="max-width:440px; margin-bottom:16px;">
    <div class="field"><label>Full name</label><input id="prof-name" value="${u.name}"></div>
    ${u.role==='student' ? `
      <div class="field"><label>Student ID</label><input value="${u.id}" disabled style="background:var(--bg); color:var(--ink-soft);"></div>
      <div class="field"><label>Sex</label><select id="prof-sex"><option value="">Select</option><option value="M" ${u.sex==='M'?'selected':''}>Male</option><option value="F" ${u.sex==='F'?'selected':''}>Female</option></select></div>
      <div class="field"><label>Department</label><select id="prof-dept">${DB.departments.map(dep=>`<option ${u.department===dep?'selected':''}>${dep}</option>`).join('')}</select></div>
      <div class="field"><label>Section</label><select id="prof-section">${sectionOptions(u.department, u.section)}</select></div>
      <div class="hint" style="margin-top:-8px; margin-bottom:10px;">Only your own department and section's QR code will check you in.</div>
    ` : ''}
    ${u.role==='officer' ? `
      <div class="field"><label>Username</label><input value="${u.username}" disabled style="background:var(--bg); color:var(--ink-soft);"></div>
      <div class="field"><label>Department</label><input value="${u.department}" disabled style="background:var(--bg); color:var(--ink-soft);"></div>
      <div class="field"><label>Section</label><input value="${u.section || 'All sections (department officer)'}" disabled style="background:var(--bg); color:var(--ink-soft);"></div>
      <div class="hint" style="margin-top:-8px; margin-bottom:10px;">Department/section reassignment is handled by the system admin, under Manage Officers.</div>
    ` : ''}
    ${u.role==='ssg' ? `
      <div class="field"><label>Username</label><input value="${u.username}" disabled style="background:var(--bg); color:var(--ink-soft);"></div>
      <div class="hint" style="margin-top:-8px; margin-bottom:10px;">SSG accounts can take attendance across every department and section — no department/section assignment applies.</div>
    ` : ''}
    ${u.role==='admin' ? `
      <div class="field"><label>Username</label><input value="${u.username}" disabled style="background:var(--bg); color:var(--ink-soft);"></div>
    ` : ''}
    ${state.profileMsg==='saved' ? `<div class="pill green" style="margin-bottom:10px;">Details saved</div>` : ''}
    <button class="btn-primary" style="width:100%;" id="save-profile-btn">Save details</button>
  </div>
  <div class="section-title">Change password</div>
  <div class="card" style="max-width:440px;">
    ${pwField('prof-cur-pw', 'Current password')}
    ${pwField('prof-new-pw', 'New password')}
    ${pwField('prof-confirm-pw', 'Confirm new password')}
    ${state.err ? `<div class="err">${state.err}</div>` : ''}
    ${state.profileMsg==='pw-saved' ? `<div class="pill green" style="margin-bottom:10px;">Password updated</div>` : ''}
    <button class="btn-primary" style="width:100%;" id="save-password-btn">Update password</button>
  </div>`;
}
function attachProfileHandlers(){
  const profDept = document.getElementById('prof-dept');
  if(profDept) profDept.onchange = ()=>{
    const secSel = document.getElementById('prof-section');
    if(secSel) secSel.innerHTML = sectionOptions(profDept.value, null);
  };
  const save = document.getElementById('save-profile-btn');
  if(save) save.onclick = async ()=>{
    const u = state.currentUser;
    const nameEl = document.getElementById('prof-name');
    if(nameEl && nameEl.value.trim()) u.name = nameEl.value.trim();
    if(u.role==='student'){
      const deptEl = document.getElementById('prof-dept');
      if(deptEl) u.department = deptEl.value;
      const secEl = document.getElementById('prof-section');
      if(secEl) u.section = secEl.value;
      const sexEl = document.getElementById('prof-sex');
      if(sexEl) u.sex = sexEl.value;
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
  wirePasswordToggles();
}

/* ---------------- ADMIN ---------------- */
function renderAdmin(){
  if(state.adminSubRoute==='overview') return renderAdminOverview();
  if(state.adminSubRoute==='analytics') return renderAdminAnalytics();
  if(state.adminSubRoute==='events') return renderAdminEvents();
  if(state.adminSubRoute==='departments') return renderAdminDepartments();
  if(state.adminSubRoute==='students') return renderAdminStudents();
  if(state.adminSubRoute==='officers') return renderAdminOfficers();
  if(state.adminSubRoute==='records') return renderAdminRecords();
  if(state.adminSubRoute==='log') return renderAdminLog();
  if(state.adminSubRoute==='sheet') return renderAdminSheet();
  return renderProfile();
}
function renderAdminOverview(){
  const totalAtt = DB.attendance.length;
  const totalComplete = DB.attendance.filter(a=>(a.amTimeIn&&a.amTimeOut)||(a.pmTimeIn&&a.pmTimeOut)).length;
  const totalEvents = DB.events.length;
  const officerCount = Object.values(DB.users).filter(u=>u.role==='officer' || u.role==='ssg').length;
  const byEvent = {};
  DB.attendance.forEach(a=>{
    if(!byEvent[a.eventId]) byEvent[a.eventId] = {timedIn:0, complete:0};
    if(a.amTimeIn || a.pmTimeIn) byEvent[a.eventId].timedIn++;
    if((a.amTimeIn&&a.amTimeOut)||(a.pmTimeIn&&a.pmTimeOut)) byEvent[a.eventId].complete++;
  });
  return `
  <div class="page-head"><h1>Admin Overview</h1><p>School-wide attendance summary, live across every department.</p></div>
  <div class="grid">
    <div class="stat"><div class="num">${totalEvents}</div><div class="lbl">Events this year</div></div>
    <div class="stat"><div class="num">${totalAtt}</div><div class="lbl">Total timed in</div></div>
    <div class="stat"><div class="num">${totalComplete}</div><div class="lbl">Completed at least one session</div></div>
    <div class="stat"><div class="num">${officerCount}</div><div class="lbl">Officer accounts</div></div>
  </div>
  <div class="section-title">Attendance by event</div>
  <div class="card" style="padding:0;">
    <table>
      <tr><th>Event</th><th>Timed in</th><th>Completed</th></tr>
      ${Object.keys(byEvent).length ? Object.entries(byEvent).map(([id,c])=>{
        const ev = DB.events.find(e=>e.id===id);
        const name = ev ? ev.name : (DB.attendance.find(a=>a.eventId===id)||{}).eventName || 'Deleted event';
        return `<tr><td>${name}</td><td>${c.timedIn}</td><td>${c.complete}</td></tr>`;
      }).join('') : `<tr><td colspan="3" class="empty">No attendance recorded yet.</td></tr>`}
    </table>
  </div>`;
}
function renderAdminAnalytics(){
  const records = DB.attendance;
  const totalRecords = records.length;
  const isComplete = a => (a.amTimeIn&&a.amTimeOut)||(a.pmTimeIn&&a.pmTimeOut);
  const totalComplete = records.filter(isComplete).length;
  const overallRate = totalRecords ? Math.round((totalComplete/totalRecords)*100) : 0;
  const distinctStudents = new Set(records.map(r=>r.studentId)).size;

  const byDept = {};
  records.forEach(r=>{
    if(!byDept[r.department]) byDept[r.department] = {total:0, complete:0};
    byDept[r.department].total++;
    if(isComplete(r)) byDept[r.department].complete++;
  });
  const deptRows = Object.entries(byDept)
    .map(([dept,c])=>({dept, total:c.total, complete:c.complete, rate: c.total ? Math.round((c.complete/c.total)*100) : 0}))
    .sort((a,b)=>b.total-a.total);

  const byScope = {section:0, department:0, ssg:0};
  records.forEach(r=>{ byScope[r.scope] = (byScope[r.scope]||0) + 1; });

  const byEvent = {};
  records.forEach(a=>{
    if(!byEvent[a.eventId]) byEvent[a.eventId] = {total:0, complete:0};
    byEvent[a.eventId].total++;
    if(isComplete(a)) byEvent[a.eventId].complete++;
  });
  const eventRows = Object.entries(byEvent).map(([id,c])=>{
    const ev = DB.events.find(e=>e.id===id);
    const name = ev ? ev.name : (records.find(a=>a.eventId===id)||{}).eventName || 'Deleted event';
    const date = ev ? ev.date : '';
    return { id, name, date, total:c.total, complete:c.complete, rate: c.total ? Math.round((c.complete/c.total)*100) : 0 };
  }).sort((a,b)=>(b.date||'').localeCompare(a.date||''));

  const { items: pageEvents, totalPages, page } = paginate(eventRows, state.analyticsPage, ADMIN_PAGE_SIZE);
  const rateClass = r => r>=75 ? 'green' : r>=40 ? 'gold' : 'danger';

  return `
  <div class="page-head"><h1>Analytics</h1><p>Deeper breakdown of attendance completion across departments, desks, and events.</p></div>
  <div class="grid">
    <div class="stat"><div class="num">${totalRecords}</div><div class="lbl">Total check-in records</div></div>
    <div class="stat"><div class="num">${overallRate}%</div><div class="lbl">Overall completion rate</div></div>
    <div class="stat"><div class="num">${distinctStudents}</div><div class="lbl">Distinct students engaged</div></div>
    <div class="stat"><div class="num">${DB.events.length}</div><div class="lbl">Events this year</div></div>
  </div>
  <div class="analytics-grid" style="margin-bottom:16px;">
    <div class="card">
      <div class="section-title" style="margin-top:0;">Completion rate by department</div>
      ${deptRows.length ? deptRows.map(d=>{
        const barColor = d.rate>=75 ? 'var(--success)' : d.rate>=40 ? 'var(--accent)' : 'var(--danger)';
        return `
        <div class="bar-row">
          <div class="bar-label">${d.dept}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${d.rate}%; background:${barColor};"></div></div>
          <div class="bar-value">${d.rate}% (${d.total})</div>
        </div>`;
      }).join('') : `<div class="empty">No attendance recorded yet.</div>`}
    </div>
    <div class="card">
      <div class="section-title" style="margin-top:0;">Check-ins by desk type</div>
      ${['section','department','ssg'].map(sc=>{
        const count = byScope[sc]||0;
        const pct = totalRecords ? Math.round((count/totalRecords)*100) : 0;
        const cls = sc==='department' ? 'navy' : sc==='ssg' ? '' : 'green';
        return `
        <div class="bar-row">
          <div class="bar-label">${scopeLabel(sc)}</div>
          <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
          <div class="bar-value">${pct}% (${count})</div>
        </div>`;
      }).join('')}
    </div>
  </div>
  <div class="section-title">Completion rate by event</div>
  <div class="card" style="padding:0;">
    <table>
      <tr><th>Event</th><th>Date</th><th>Timed in</th><th>Completed</th><th>Rate</th></tr>
      ${pageEvents.map(e=>`<tr><td>${e.name}</td><td>${e.date||'—'}</td><td>${e.total}</td><td>${e.complete}</td><td><span class="pill ${rateClass(e.rate)}">${e.rate}%</span></td></tr>`).join('') || `<tr><td colspan="5" class="empty">No attendance recorded yet.</td></tr>`}
    </table>
  </div>
  ${paginationControls(page, totalPages, 'analytics')}
  `;
}
function renderEventModal(){
  const d = state.newEventDraft;
  const editing = state.editingEventId;
  const sessionType = d.sessionType || 'full';
  return `
  <div class="modal-overlay" id="event-modal-overlay">
    <div class="modal-card">
      <button class="close-x" id="close-event-modal-btn">&times;</button>
      ${editing ? `<div class="pill gold" style="margin-bottom:10px;">Editing event</div>` : `<h3 style="margin-top:0;">Add event</h3>`}
      <div class="field"><label>Event name</label><input id="ev-name" value="${d.name}" placeholder="Foundation Week 2026"></div>
      <div class="row">
        <div class="field" style="flex:1;"><label>Date</label><input id="ev-date" type="date" value="${d.date}"></div>
        <div class="field" style="flex:1;"><label>Venue</label><input id="ev-venue" value="${d.venue||''}" placeholder="Gymnasium"></div>
      </div>
      <div class="field">
        <label>Duration</label>
        <div class="auth-tabs" style="margin-bottom:0;">
          <div class="auth-tab ev-session-tab ${sessionType==='full'?'active':''}" data-session="full">Whole day (AM + PM)</div>
          <div class="auth-tab ev-session-tab ${sessionType==='am'?'active':''}" data-session="am">AM only</div>
          <div class="auth-tab ev-session-tab ${sessionType==='pm'?'active':''}" data-session="pm">PM only</div>
        </div>
        <p class="hint">${sessionType==='full' ? 'Students scan 4 times: AM time in/out, then PM time in/out.' : `Students scan 2 times: ${sessionType.toUpperCase()} time in and time out.`}</p>
      </div>
      ${sessionType==='full' ? `
      <div class="row">
        <div class="field" style="flex:1;"><label>Morning time</label><input id="ev-am-time" value="${d.amTime||''}" placeholder="8:00 AM - 12:00 PM"></div>
        <div class="field" style="flex:1;"><label>Afternoon time</label><input id="ev-pm-time" value="${d.pmTime||''}" placeholder="1:00 PM - 5:00 PM"></div>
      </div>
      ` : sessionType==='am' ? `
      <div class="field"><label>Time</label><input id="ev-am-time" value="${d.amTime||''}" placeholder="8:00 AM - 12:00 PM"></div>
      ` : `
      <div class="field"><label>Time</label><input id="ev-pm-time" value="${d.pmTime||''}" placeholder="1:00 PM - 5:00 PM"></div>
      `}
      <div class="field">
        <label>Participating departments</label>
        ${DB.departments.map(dep=>`
          <label style="text-transform:none; font-weight:400; display:flex; align-items:center; gap:8px; margin-bottom:6px;">
            <input type="checkbox" style="width:auto;" class="dept-check" value="${dep}" ${d.departments.includes(dep)?'checked':''}> ${dep}
          </label>`).join('')}
      </div>
      <div class="field">
        <label>Restrict to specific sections (optional)</label>
        <p class="hint" style="margin-top:-4px;">Leave everything unchecked to open this event to every section in the departments above. Check specific sections to limit it — only officers of those sections will see this event.</p>
        ${d.departments.length===0 ? `<p class="hint">Pick a department above first.</p>` : d.departments.map(dep=>{
          const secs = sectionsFor(dep);
          if(secs.length===0) return '';
          return `<div style="margin-bottom:8px;">
            <div style="font-size:11.5px; font-weight:700; color:var(--ink-soft); margin-bottom:4px;">${dep}</div>
            ${secs.map(sec=>`
              <label style="text-transform:none; font-weight:400; display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <input type="checkbox" style="width:auto;" class="ev-section-check" value="${sec}" ${d.sections.includes(sec)?'checked':''}> ${sec}
              </label>`).join('')}
          </div>`;
        }).join('')}
      </div>
      ${state.err ? `<div class="err">${state.err}</div>` : ''}
      <button class="btn-primary" style="width:100%;" id="create-event-btn">${editing ? 'Save changes' : 'Create event'}</button>
      <button class="btn-ghost" style="width:100%; margin-top:8px;" id="close-event-modal-btn-2">Cancel</button>
    </div>
  </div>`;
}
function renderAdminEvents(){
  const modalOpen = state.eventModalOpen || !!state.editingEventId;
  return `
  <div class="page-head-row">
    <div class="page-head" style="margin-bottom:0;"><h1>Manage Events</h1><p>Create the events officers will generate QR codes for.</p></div>
    <button class="btn-gold" id="open-add-event-btn">+ Add event</button>
  </div>
  <div class="section-title">All events</div>
  <div class="card" style="padding:0;">
    <table>
      <tr><th>Event</th><th>Date</th><th>Duration</th><th>Departments</th><th>Sections</th><th></th></tr>
      ${DB.events.map(e=>`<tr><td>${e.name}</td><td>${e.date||'—'}</td><td>${e.sessionType==='am'?'AM only':e.sessionType==='pm'?'PM only':'Whole day'}</td><td>${e.departments.map(dp=>`<span class="badge-dept" style="margin-right:4px;">${dp}</span>`).join('')}</td><td>${e.sections && e.sections.length ? e.sections.map(s=>`<span class="pill gold" style="margin-right:4px;">${s}</span>`).join('') : '<span class="pill green">All sections</span>'}</td><td><button class="btn-ghost" data-edit-event="${e.id}" style="margin-right:6px;">Edit</button><button class="btn-danger" data-del-event="${e.id}">Remove</button></td></tr>`).join('') || `<tr><td colspan="6" class="empty">No events yet.</td></tr>`}
    </table>
  </div>
  ${modalOpen ? renderEventModal() : ''}
  `;
}
function renderAdminDepartments(){
  const deps = DB.departments;
  const deptInUse = new Set();
  DB.events.forEach(e=>e.departments.forEach(dp=>deptInUse.add(dp)));
  const sectionInUse = new Set(Object.values(DB.users).filter(u=>u.role==='student' || u.role==='officer').map(u=>normSection(u.section)));
  return `
  <div class="page-head"><h1>Departments</h1><p>Manage departments and the sections within each one — everything students and officers pick from.</p></div>
  <div class="card" style="max-width:440px; margin-bottom:16px;">
    <div class="field"><label>Add a department</label><input id="new-dept-name" placeholder="e.g. Maritime Department"></div>
    ${state.err ? `<div class="err">${state.err}</div>` : ''}
    <button class="btn-primary" style="width:100%;" id="add-dept-btn">Add department</button>
  </div>
  <div class="section-title">All departments</div>
  ${deps.length===0 ? `<div class="empty">No departments yet.</div>` : deps.map(dept=>{
    const sections = sectionsFor(dept);
    return `
    <div class="card" style="max-width:560px; margin-bottom:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <div style="font-weight:700; font-size:15px;">${dept} ${deptInUse.has(dept)?'<span class="pill gold" style="margin-left:6px;">in use</span>':''}</div>
        <button class="btn-danger" data-del-dept="${dept}">Remove department</button>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
        ${sections.length ? sections.map(s=>`
          <span class="section-chip">${s} ${sectionInUse.has(normSection(s))?'<span class="pill gold" style="margin-left:4px;">in use</span>':''}
            <button class="chip-x" data-del-section-dept="${dept}" data-del-section-name="${s}" aria-label="Remove section">&times;</button>
          </span>`).join('') : `<span class="hint" style="margin:0;">No sections yet for this department.</span>`}
      </div>
      <div class="row" style="gap:8px; margin-bottom:0;">
        <input class="add-section-input" data-dept="${dept}" placeholder="Add a section, e.g. BSCS 3-A" style="flex:1;">
        <button class="btn-ghost add-section-btn" data-dept="${dept}" style="flex-shrink:0;">Add section</button>
      </div>
    </div>`;
  }).join('')}`;
}
function renderAdminStudents(){
  const allStudents = Object.values(DB.users).filter(u=>u.role==='student').sort((a,b)=>a.name.localeCompare(b.name));
  const deptFilter = state.studentDeptFilter || 'all';
  let students = deptFilter==='all' ? allStudents : allStudents.filter(s=>s.department===deptFilter);
  const q = (state.studentSearchQuery||'').trim().toLowerCase();
  if(q) students = students.filter(s=>(s.name+' '+s.id).toLowerCase().includes(q));
  const editing = state.editingStudentId;
  const editingUser = editing ? DB.users[editing] : null;
  const reset = state.lastResetPassword;
  const { items: pageStudents, totalPages, page } = paginate(students, state.studentPage, ADMIN_PAGE_SIZE);
  return `
  <div class="page-head"><h1>Manage Students</h1><p>Update account details or reset a student's password.</p></div>
  ${reset ? `
    <div class="card" style="max-width:480px; margin-bottom:10px; border-color:var(--accent);">
      <div class="pill gold" style="margin-bottom:10px;">Password reset</div>
      <p style="font-size:13.5px; margin:0 0 10px 0;">New temporary password for <strong>${reset.name}</strong> (<span class="mono">${reset.studentId}</span>):</p>
      <div style="display:flex; align-items:center; gap:10px;">
        <div class="code-text" style="font-size:16px;">${reset.plaintext}</div>
        <button class="btn-ghost" id="copy-reset-pw-btn" data-pw="${reset.plaintext}">Copy</button>
      </div>
      <p class="hint">Copy and send this directly rather than retyping it by hand — it's all uppercase, but copy-paste avoids any mix-ups. It won't be shown again after you leave this page.</p>
      <button class="btn-ghost" style="width:100%; margin-top:10px;" id="dismiss-reset-btn">Dismiss</button>
    </div>
  ` : ''}
  ${editingUser ? `
  <div class="card" style="max-width:480px; margin-bottom:16px;">
    <div class="pill gold" style="margin-bottom:10px;">Editing ${editingUser.id}</div>
    <div class="field"><label>Full name</label><input id="stu-edit-name" value="${editingUser.name}"></div>
    <div class="field"><label>Sex</label><select id="stu-edit-sex"><option value="">Select</option><option value="M" ${editingUser.sex==='M'?'selected':''}>Male</option><option value="F" ${editingUser.sex==='F'?'selected':''}>Female</option></select></div>
    <div class="field"><label>Department</label><select id="stu-edit-dept">${DB.departments.map(dep=>`<option ${editingUser.department===dep?'selected':''}>${dep}</option>`).join('')}</select></div>
    <div class="field"><label>Section</label><select id="stu-edit-section">${sectionOptions(editingUser.department, editingUser.section)}</select></div>
    ${state.err ? `<div class="err">${state.err}</div>` : ''}
    <button class="btn-primary" style="width:100%;" id="save-student-edit-btn">Save changes</button>
    <button class="btn-ghost" style="width:100%; margin-top:8px;" id="cancel-student-edit-btn">Cancel</button>
  </div>
  ` : ''}
  <div class="card student-toolbar">
    <div class="dept-chip-row">
      <button class="dept-chip ${deptFilter==='all'?'active':''}" data-dept="all">All students <span class="chip-count">${allStudents.length}</span></button>
      ${DB.departments.map(dep=>{
        const count = allStudents.filter(s=>s.department===dep).length;
        return `<button class="dept-chip ${deptFilter===dep?'active':''}" data-dept="${dep}">${dep} <span class="chip-count">${count}</span></button>`;
      }).join('')}
    </div>
    <div class="field student-search-field">
      <label>Search ${deptFilter==='all'?'all departments':'in ' + deptFilter}</label>
      <input id="student-search" value="${state.studentSearchQuery||''}" placeholder="Name or student ID">
    </div>
  </div>
  <div class="section-title">${deptFilter==='all' ? 'All students' : deptFilter} <span class="pill gold">${students.length}</span></div>
  <div class="card" style="padding:0;">
    <table id="student-table">
      <tr><th>Name</th><th>ID</th><th style="width:50px;">Sex</th><th>Department</th><th>Section</th><th></th></tr>
      ${pageStudents.map(s=>`<tr><td>${s.name}</td><td class="mono">${s.id}</td><td>${s.sex || '<span class="pill gold">—</span>'}</td><td><span class="badge-dept">${s.department}</span></td><td>${s.section||'—'}</td><td><button class="btn-ghost" data-edit-student="${s.id}" style="margin-right:6px;">Edit</button><button class="btn-danger" data-reset-student="${s.id}">Reset password</button></td></tr>`).join('') || `<tr><td colspan="6" class="empty">No students in ${deptFilter==='all'?'the system':'this department'} yet.</td></tr>`}
    </table>
  </div>
  ${paginationControls(page, totalPages, 'student')}
  `;
}
function renderOfficerModal(){
  const d = state.newOfficerDraft;
  const editing = state.editingOfficerUsername;
  const type = d.type || 'section';
  return `
  <div class="modal-overlay" id="officer-modal-overlay">
    <div class="modal-card">
      <button class="close-x" id="close-officer-modal-btn">&times;</button>
      ${editing ? `<div class="pill gold" style="margin-bottom:10px;">Editing ${editing}</div>` : `<h3 style="margin-top:0;">Add officer account</h3>`}
      <div class="field">
        <label>Officer type</label>
        <div class="auth-tabs" style="margin-bottom:0;">
          <div class="auth-tab officer-type-tab ${type==='section'?'active':''}" data-type="section" style="${editing?'pointer-events:none; opacity:0.6;':''}">Section</div>
          <div class="auth-tab officer-type-tab ${type==='department'?'active':''}" data-type="department" style="${editing?'pointer-events:none; opacity:0.6;':''}">Department</div>
          <div class="auth-tab officer-type-tab ${type==='ssg'?'active':''}" data-type="ssg" style="${editing?'pointer-events:none; opacity:0.6;':''}">SSG</div>
        </div>
      </div>
      <div class="field" style="margin-top:16px;"><label>Officer name</label><input id="of-name" value="${d.name}" placeholder="Maria Santos"></div>
      <div class="field"><label>Username</label><input id="of-user" value="${d.username}" placeholder="${type==='ssg'?'ssg-officer1':type==='department'?'cs-dept-officer':'cs-officer'}" ${editing?'disabled style="background:var(--bg); color:var(--ink-soft);"':''}></div>
      ${pwField('of-pw', 'Password', editing ? 'Leave blank to keep current password' : 'Set a password')}
      ${type==='section' ? `
      <div class="field">
        <label>Department</label>
        <select id="of-dept">${DB.departments.map(dep=>`<option ${d.department===dep?'selected':''}>${dep}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label>Section</label>
        <select id="of-section">${sectionOptions(d.department || DB.departments[0], d.section)}</select>
      </div>
      ` : type==='department' ? `
      <div class="field">
        <label>Department</label>
        <select id="of-dept">${DB.departments.map(dep=>`<option ${d.department===dep?'selected':''}>${dep}</option>`).join('')}</select>
      </div>
      <p class="hint" style="margin-top:-6px;">This officer's QR works for every section in that department — no single section is assigned.</p>
      ` : `<p class="hint" style="margin-top:-6px;">SSG officers aren't tied to a department or section — their QR works for any student, anywhere.</p>`}
      ${state.err ? `<div class="err">${state.err}</div>` : ''}
      <button class="btn-primary" style="width:100%;" id="create-officer-btn">${editing ? 'Save changes' : 'Create officer account'}</button>
      <button class="btn-ghost" style="width:100%; margin-top:8px;" id="close-officer-modal-btn-2">Cancel</button>
    </div>
  </div>`;
}
function renderAdminOfficers(){
  const modalOpen = state.officerModalOpen || !!state.editingOfficerUsername;
  const allOfficers = Object.values(DB.users).filter(u=>u.role==='officer' || u.role==='ssg');
  const typedOfficers = allOfficers.map(o=>({...o, oType: o.role==='ssg' ? 'ssg' : (o.section ? 'section' : 'department')}));
  const typeFilter = state.officerTypeFilter || 'all';
  let filtered = typeFilter==='all' ? typedOfficers : typedOfficers.filter(o=>o.oType===typeFilter);
  const q = (state.officerSearchQuery||'').trim().toLowerCase();
  if(q) filtered = filtered.filter(o=>(o.name+' '+o.username).toLowerCase().includes(q));
  const countFor = t => t==='all' ? typedOfficers.length : typedOfficers.filter(o=>o.oType===t).length;
  const pillFor = t => t==='ssg' ? '<span class="pill gold">SSG</span>' : t==='department' ? '<span class="pill navy">Department</span>' : '<span class="pill green">Section</span>';
  const { items: officers, totalPages, page } = paginate(filtered, state.officerPage, ADMIN_PAGE_SIZE);
  const reset = state.lastOfficerResetPassword;
  return `
  <div class="page-head-row">
    <div class="page-head" style="margin-bottom:0;"><h1>Manage Officers</h1><p>Section officers cover one section; department officers cover every section in a department; SSG officers cover the whole school.</p></div>
    <button class="btn-gold" id="open-add-officer-btn">+ Add officer</button>
  </div>
  ${reset ? `
    <div class="card" style="max-width:480px; margin-bottom:10px; border-color:var(--accent);">
      <div class="pill gold" style="margin-bottom:10px;">Password reset</div>
      <p style="font-size:13.5px; margin:0 0 10px 0;">New temporary password for <strong>${reset.name}</strong> (<span class="mono">${reset.username}</span>):</p>
      <div style="display:flex; align-items:center; gap:10px;">
        <div class="code-text" style="font-size:16px;">${reset.plaintext}</div>
        <button class="btn-ghost" id="copy-officer-reset-pw-btn" data-pw="${reset.plaintext}">Copy</button>
      </div>
      <p class="hint">Copy and send this directly rather than retyping it by hand — it won't be shown again after you leave this page.</p>
      <button class="btn-ghost" style="width:100%; margin-top:10px;" id="dismiss-officer-reset-btn">Dismiss</button>
    </div>
  ` : ''}
  <div class="card student-toolbar">
    <div class="dept-chip-row">
      <button class="officer-type-filter-btn dept-chip ${typeFilter==='all'?'active':''}" data-type="all">All officers <span class="chip-count">${countFor('all')}</span></button>
      <button class="officer-type-filter-btn dept-chip ${typeFilter==='section'?'active':''}" data-type="section">Section <span class="chip-count">${countFor('section')}</span></button>
      <button class="officer-type-filter-btn dept-chip ${typeFilter==='department'?'active':''}" data-type="department">Department <span class="chip-count">${countFor('department')}</span></button>
      <button class="officer-type-filter-btn dept-chip ${typeFilter==='ssg'?'active':''}" data-type="ssg">SSG <span class="chip-count">${countFor('ssg')}</span></button>
    </div>
    <div class="field student-search-field">
      <label>Search</label>
      <input id="officer-search" value="${state.officerSearchQuery||''}" placeholder="Name or username">
    </div>
  </div>
  <div class="section-title">${typeFilter==='all' ? 'All officers' : scopeLabel(typeFilter)} <span class="pill gold">${filtered.length}</span></div>
  <div class="card" style="padding:0;">
    <table id="officer-table">
      <tr><th>Name</th><th>Username</th><th>Type</th><th>Department</th><th>Section</th><th></th></tr>
      ${officers.map(o=>`<tr><td>${o.name}</td><td class="mono">${o.username}</td><td>${pillFor(o.oType)}</td><td>${o.oType==='ssg'?'—':`<span class="badge-dept">${o.department}</span>`}</td><td>${o.oType==='section' ? (o.section||'<span class="pill gold">not set</span>') : (o.oType==='department' ? '<span class="pill gold">all sections</span>' : '—')}</td><td><button class="btn-ghost" data-edit-officer="${o.username}" style="margin-right:6px;">Edit</button><button class="btn-ghost" data-reset-officer="${o.username}" style="margin-right:6px;">Reset password</button><button class="btn-danger" data-del-officer="${o.username}">Remove</button></td></tr>`).join('') || `<tr><td colspan="6" class="empty">No officers match this filter.</td></tr>`}
    </table>
  </div>
  ${paginationControls(page, totalPages, 'officer')}
  ${modalOpen ? renderOfficerModal() : ''}
  `;
}
function renderStudentAttendanceModal(){
  const sid = state.showAttendanceStudentId;
  if(!sid) return '';
  const scopeFilter = state.adminFilterScope || 'all';
  let rows = DB.attendance.filter(a=>a.studentId===sid);
  if(state.adminFilterEvent!=='all') rows = rows.filter(r=>r.eventId===state.adminFilterEvent);
  if(state.adminFilterDept!=='all') rows = rows.filter(r=>r.department===state.adminFilterDept);
  if(scopeFilter!=='all') rows = rows.filter(r=>r.scope===scopeFilter);
  rows = rows.sort((a,b)=>(b.amTimeIn||b.pmTimeIn||0)-(a.amTimeIn||a.pmTimeIn||0));
  const sample = DB.attendance.find(a=>a.studentId===sid);
  const name = sample ? sample.studentName : sid;
  const filterEventLabel = state.adminFilterEvent==='all' ? 'all events' : ((DB.events.find(e=>e.id===state.adminFilterEvent)||{}).name || 'this event');
  return `
  <div class="modal-overlay" id="student-attendance-modal-overlay">
    <div class="modal-card">
      <button class="close-x" id="close-student-attendance-modal-btn">&times;</button>
      <h3 style="margin-top:0; margin-bottom:2px;">${name}</h3>
      <p class="hint" style="margin-top:0;">
        <span class="mono">${sid}</span> — ${filterEventLabel}${state.adminFilterDept!=='all' ? `, ${state.adminFilterDept}` : ''}${scopeFilter!=='all' ? `, ${scopeLabel(scopeFilter)} desk` : ''} — ${rows.length} record${rows.length===1?'':'s'}
      </p>
      ${rows.length===0 ? `<div class="empty">No records match the current filters for this student.</div>` : rows.map(r=>{
        const ev = DB.events.find(e=>e.id===r.eventId);
        const eventName = ev ? ev.name : r.eventName; // fall back to the stored snapshot only if the event itself was deleted
        return `
        <div class="card" style="margin-bottom:10px; padding:16px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:10px;">
            <div>
              <strong style="font-size:14px;">${eventName}</strong><br>
              <span style="margin-top:4px; display:inline-block;">${scopePill(r.scope)}</span>
            </div>
            ${attendanceStatusPill(r, ev)}
          </div>
          <table style="font-size:12.5px;">
            <tr><th>AM in</th><th>AM out</th><th>PM in</th><th>PM out</th></tr>
            <tr><td>${r.amTimeIn?fmtDate(r.amTimeIn):'—'}</td><td>${r.amTimeOut?fmtDate(r.amTimeOut):'—'}</td><td>${r.pmTimeIn?fmtDate(r.pmTimeIn):'—'}</td><td>${r.pmTimeOut?fmtDate(r.pmTimeOut):'—'}</td></tr>
          </table>
          <button class="btn-danger" data-remove-att="${r.id}" style="margin-top:10px;">Remove this record</button>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}
function renderAdminRecords(){
  const events = [{id:'all', name:'all'}, ...DB.events.map(e=>({id:e.id, name:e.name}))];
  const depts = ['all', ...DB.departments];
  const scopes = ['all', 'section', 'department', 'ssg'];
  const scopeFilter = state.adminFilterScope || 'all';
  let rows = DB.attendance.slice();
  if(state.adminFilterEvent!=='all') rows = rows.filter(r=>r.eventId===state.adminFilterEvent);
  if(state.adminFilterDept!=='all') rows = rows.filter(r=>r.department===state.adminFilterDept);
  if(scopeFilter!=='all') rows = rows.filter(r=>r.scope===scopeFilter);
  const canBulkReset = state.adminFilterEvent !== 'all';
  const filterEventName = state.adminFilterEvent==='all' ? 'all' : ((DB.events.find(e=>e.id===state.adminFilterEvent)||{}).name || 'this event');
  // group the filtered records by student — the row-level detail lives in the modal
  const byStudent = {};
  rows.forEach(r=>{
    if(!byStudent[r.studentId]) byStudent[r.studentId] = { studentId:r.studentId, studentName:r.studentName, department:r.department, section:r.section, scopes:new Set(), latest:0 };
    byStudent[r.studentId].scopes.add(r.scope);
    byStudent[r.studentId].latest = Math.max(byStudent[r.studentId].latest, r.amTimeIn||0, r.pmTimeIn||0);
  });
  const studentRows = Object.values(byStudent).sort((a,b)=>b.latest-a.latest);
  const { items: pageStudents, totalPages, page } = paginate(studentRows, state.recordsPage, ADMIN_PAGE_SIZE);
  return `
  <div class="page-head"><h1>All Records</h1><p>Full attendance log across every event, department, and desk (section, department, or SSG).</p></div>
  <div class="card" style="max-width:760px; margin-bottom:10px;">
    <div class="row">
      <div class="field" style="margin-bottom:0; flex:1;">
        <label>Event</label>
        <select id="filter-event">${events.map(e=>`<option value="${e.id}" ${state.adminFilterEvent===e.id?'selected':''}>${e.name}</option>`).join('')}</select>
      </div>
      <div class="field" style="margin-bottom:0; flex:1;">
        <label>Department</label>
        <select id="filter-dept">${depts.map(dp=>`<option ${state.adminFilterDept===dp?'selected':''}>${dp}</option>`).join('')}</select>
      </div>
      <div class="field" style="margin-bottom:0; flex:1;">
        <label>Via</label>
        <select id="filter-scope">${scopes.map(s=>`<option value="${s}" ${scopeFilter===s?'selected':''}>${s==='all'?'all':scopeLabel(s)}</option>`).join('')}</select>
      </div>
    </div>
  </div>
  <div style="margin-bottom:10px; display:flex; flex-wrap:wrap; gap:10px; align-items:center;">
    ${canBulkReset ? `<button class="btn-gold" id="export-attendees-btn" ${studentRows.length===0?'disabled':''}>Export attendee list (${studentRows.length})</button>` : ''}
    ${canBulkReset ? `<button class="btn-danger" id="bulk-reset-records-btn" ${rows.length===0?'disabled':''}>Reset all ${rows.length} record${rows.length===1?'':'s'} shown below</button>` : ''}
  </div>
  <div style="margin-bottom:10px;">
    ${canBulkReset ? `
      <p class="hint">Clears attendance for <strong>${filterEventName}</strong>${state.adminFilterDept!=='all'?` in ${state.adminFilterDept}`:' across every department'}${scopeFilter!=='all'?` (${scopeLabel(scopeFilter)} desk only)`:''} — students will need to scan in again from scratch.</p>
    ` : `
      <p class="hint">Select a specific event above to export its attendee list or reset all of its attendance at once.</p>
    `}
  </div>
  <div class="section-title">Students with matching records <span class="pill gold">${studentRows.length}</span></div>
  <div class="card" style="padding:0;">
    <table>
      <tr><th>Student</th><th>Department</th><th>Recorded via</th><th></th></tr>
      ${pageStudents.map(s=>`<tr><td>${s.studentName} <span style="color:var(--ink-soft);">(${s.studentId})</span></td><td><span class="badge-dept">${s.department}</span></td><td>${[...s.scopes].map(sc=>scopePill(sc)).join(' ')}</td><td><button class="btn-gold" data-show-attendance="${s.studentId}">Show Attendance</button></td></tr>`).join('') || `<tr><td colspan="4" class="empty">No records match this filter.</td></tr>`}
    </table>
  </div>
  ${paginationControls(page, totalPages, 'records')}
  ${renderStudentAttendanceModal()}
  ${state.exportModalOpen ? renderExportModal(studentRows, filterEventName) : ''}
  `;
}
function renderExportModal(studentRows, eventName){
  const sorted = [...studentRows].sort((a,b)=>a.studentName.localeCompare(b.studentName));
  const lines = sorted.map(s=>`${s.studentName}\tStudent\t${s.department}${s.section?(' - '+s.section):''}`);
  const text = `Name\tPosition/Rank\tOffice\n${lines.join('\n')}`;
  return `
  <div class="modal-overlay" id="export-modal-overlay">
    <div class="modal-card" style="max-width:640px;">
      <button class="close-x" id="close-export-modal-btn">&times;</button>
      <h3 style="margin-top:0;">Export attendee list</h3>
      <p class="hint" style="margin-top:-6px;">${sorted.length} student${sorted.length===1?'':'s'} for <strong>${eventName}</strong>. Copy this list to paste elsewhere, or download it as a spreadsheet-ready CSV.</p>
      <textarea id="export-textarea" readonly rows="10" style="width:100%; font-family:'JetBrains Mono',monospace; font-size:12px; padding:10px; border-radius:8px; border:1px solid var(--border);">${text}</textarea>
      <button class="btn-primary" style="width:100%; margin-top:10px;" id="copy-export-btn">Copy to clipboard</button>
      <button class="btn-gold" style="width:100%; margin-top:8px;" id="download-export-btn">Download as CSV</button>
      <button class="btn-ghost" style="width:100%; margin-top:8px;" id="close-export-modal-btn-2">Close</button>
    </div>
  </div>`;
}
function renderSheetSettingsModal(){
  const s = state.sheetSettingsDraft || DEFAULT_SHEET_SETTINGS;
  return `
  <div class="modal-overlay" id="sheet-settings-modal-overlay">
    <div class="modal-card" style="max-width:640px;">
      <button class="close-x" id="close-sheet-settings-btn">&times;</button>
      <h3 style="margin-top:0;">Sheet header &amp; footer</h3>
      <p class="hint" style="margin-top:-6px;">Saved once and reused for every sheet you print — you won't need to re-enter this.</p>
      <div class="section-title" style="margin-top:14px;">Header</div>
      <div class="row">
        <div class="field" style="flex:1;">
          <label>Left logo</label>
          ${s.leftLogo ? `<img src="${s.leftLogo}" style="height:44px; display:block; margin-bottom:6px;">` : ''}
          <input type="file" id="left-logo-input" accept="image/*">
          ${s.leftLogo ? `
          <div style="margin-top:8px;">
            <label style="margin-bottom:2px;">Size (${s.leftLogoSize}px)</label>
            <input type="range" id="left-logo-size" min="30" max="500" value="${s.leftLogoSize}" style="width:100%;">
          </div>
          <button class="btn-ghost" id="remove-left-logo-btn" style="margin-top:6px;">Remove</button>
          <button class="btn-ghost" id="reset-left-logo-pos-btn" style="margin-top:6px;">Reset position</button>
          ` : ''}
        </div>
        <div class="field" style="flex:1;">
          <label>Right logo</label>
          ${s.rightLogo ? `<img src="${s.rightLogo}" style="height:44px; display:block; margin-bottom:6px;">` : ''}
          <input type="file" id="right-logo-input" accept="image/*">
          ${s.rightLogo ? `
          <div style="margin-top:8px;">
            <label style="margin-bottom:2px;">Size (${s.rightLogoSize}px)</label>
            <input type="range" id="right-logo-size" min="30" max="500" value="${s.rightLogoSize}" style="width:100%;">
          </div>
          <button class="btn-ghost" id="remove-right-logo-btn" style="margin-top:6px;">Remove</button>
          <button class="btn-ghost" id="reset-right-logo-pos-btn" style="margin-top:6px;">Reset position</button>
          ` : ''}
        </div>
      </div>
      <div class="row">
        <div class="field" style="flex:1;"><label>University / institution name</label><input id="sh-university" value="${s.university}"></div>
      </div>
      <div class="field"><label>Address</label><input id="sh-address" value="${s.address}"></div>
      <div class="row">
        <div class="field" style="flex:1;"><label>Website</label><input id="sh-website" value="${s.website}"></div>
        <div class="field" style="flex:1;"><label>Email</label><input id="sh-email" value="${s.email}"></div>
        <div class="field" style="flex:1;"><label>Tel/Fax</label><input id="sh-telfax" value="${s.telfax}"></div>
      </div>
      <div class="field"><label>College / unit name</label><input id="sh-collegeunit" value="${s.collegeUnit}" placeholder="( Name of College/Unit )"></div>
      <div class="row">
        <div class="field" style="flex:1;"><label>Reference No.</label><input id="sh-refno" value="${s.refNo}"></div>
        <div class="field" style="flex:1;"><label>Effectivity date</label><input id="sh-effdate" value="${s.effectivityDate}" placeholder="e.g. June 29, 2026"></div>
        <div class="field" style="flex:1;"><label>Revision No.</label><input id="sh-revno" value="${s.revisionNo}"></div>
      </div>
      <div class="section-title">Footer</div>
      <div class="field">
        <label>Footer logo</label>
        <p class="hint" style="margin-top:-4px;">A separate logo from the header — e.g. an ISO certification mark or similar badge. Real-world reference size: 1.98cm tall × 4.98cm wide (a wide badge shape, not square).</p>
        ${s.footerLogo ? `<img src="${s.footerLogo}" style="height:50px; display:block; margin-bottom:6px;">` : ''}
        <input type="file" id="footer-logo-input" accept="image/*">
        ${s.footerLogo ? `
        <div class="row" style="margin-top:8px; max-width:400px;">
          <div class="field" style="flex:1; margin-bottom:0;">
            <label style="margin-bottom:2px;">Width (${s.footerLogoWidth}px)</label>
            <input type="range" id="footer-logo-width" min="40" max="320" value="${s.footerLogoWidth}" style="width:100%;">
          </div>
          <div class="field" style="flex:1; margin-bottom:0;">
            <label style="margin-bottom:2px;">Height (${s.footerLogoHeight}px)</label>
            <input type="range" id="footer-logo-height" min="20" max="160" value="${s.footerLogoHeight}" style="width:100%;">
          </div>
        </div>
        <button class="btn-ghost" id="remove-footer-logo-btn" style="margin-top:6px;">Remove</button>
        <button class="btn-ghost" id="reset-footer-logo-pos-btn" style="margin-top:6px;">Reset position</button>
        ` : ''}
      </div>
      <div class="row">
        <div class="field" style="flex:1;"><label>Footer label</label><input id="sh-footerlabel" value="${s.footerLabel}"></div>
        <div class="field" style="flex:1;"><label>Signature line label</label><input id="sh-siglabel" value="${s.signatureLabel}"></div>
      </div>
      ${state.err ? `<div class="err">${state.err}</div>` : ''}
      <button class="btn-primary" style="width:100%;" id="save-sheet-settings-btn">Save header &amp; footer</button>
      <button class="btn-ghost" style="width:100%; margin-top:8px;" id="close-sheet-settings-btn-2">Close</button>
    </div>
  </div>`;
}
function renderOneSheet(s, d, attendeesChunk, pageIndex, isActive){
  const rowCount = attendeesChunk ? 30 : Math.max(1, Math.min(60, parseInt(d.rows,10) || 30));
  const rows = Array.from({length: rowCount}, (_, i) => i+1);
  return `
    <div class="print-sheet${isActive ? '' : ' ps-preview-hidden'}">
      <div class="ps-topline"><span>Reference No.: ${s.refNo}</span><span>Effectivity Date: ${s.effectivityDate}</span><span>Revision No. ${s.revisionNo}</span></div>
      <div class="ps-header">
        <div class="ps-logo left">${s.leftLogo ? `<img class="ps-draggable-logo" data-logo="left" data-page="${pageIndex}" src="${s.leftLogo}" style="width:${s.leftLogoSize}px; height:${s.leftLogoSize}px; transform:translate(${s.leftLogoX}px, ${s.leftLogoY}px);">` : ''}</div>
        <div class="ps-headtext">
          <div class="ps-republic">Republic of the Philippines</div>
          <div class="ps-university">${s.university}</div>
          <div class="ps-address">${s.address}</div>
          <div class="ps-contact">Website: ${s.website} &nbsp; Email address: ${s.email}</div>
          <div class="ps-contact">Tele/Fax: ${s.telfax}</div>
        </div>
        <div class="ps-logo right">${s.rightLogo ? `<img class="ps-draggable-logo" data-logo="right" data-page="${pageIndex}" src="${s.rightLogo}" style="width:${s.rightLogoSize}px; height:${s.rightLogoSize}px; transform:translate(${s.rightLogoX}px, ${s.rightLogoY}px);">` : ''}</div>
      </div>
      <div class="ps-collegeunit">${s.collegeUnit}</div>
      <div class="ps-divider"><div class="ps-divider-thick"></div><div class="ps-divider-thin"></div></div>
      <div class="ps-title">COLLEGE/OFFICE ACTIVITY/SEMINAR ATTENDANCE SHEET</div>
      <div class="ps-fields">
        <div>Nature/Title of Meeting/Activity/Seminar: <span class="ps-fill wide">${d.title}</span></div>
        <div class="ps-fields-row">
          <span>Date: <span class="ps-fill short">${d.date}</span></span>
          <span>Time: <span class="ps-fill short">${d.time}</span></span>
          <span>Venue: <span class="ps-fill">${d.venue}</span></span>
        </div>
      </div>
      <table class="ps-table">
        <tr><th>Name</th><th style="width:60px; text-align:center;">Sex</th><th style="width:110px; text-align:center;">Position/Rank</th><th style="width:100px; text-align:center;">Office</th><th style="width:130px;">Signature</th></tr>
        ${rows.map(n=>{
          const att = attendeesChunk ? attendeesChunk[n-1] : null;
          const name = att ? toTitleCase(att.studentName) : '';
          const office = att ? att.department : '';
          return `<tr><td>${n}. ${name}</td><td style="text-align:center;">${att?(att.sex||''):''}</td><td style="text-align:center;">${att?'Student':''}</td><td style="text-align:center;">${office}</td><td></td></tr>`;
        }).join('')}
      </table>
      <div class="ps-footer">
        <div class="ps-footer-row">
          <div class="ps-sig-block">
            <div>${s.footerLabel}</div>
            <div class="ps-sigline"></div>
            <div class="ps-siglabel">${s.signatureLabel}</div>
          </div>
          ${s.footerLogo ? `<div class="ps-footer-logo"><img class="ps-draggable-logo" data-logo="footer" data-page="${pageIndex}" src="${s.footerLogo}" style="width:${s.footerLogoWidth}px; height:${s.footerLogoHeight}px; transform:translate(${s.footerLogoX}px, ${s.footerLogoY}px);"></div>` : ''}
        </div>
      </div>
    </div>`;
}
function renderAdminSheet(){
  const s = state.sheetSettingsDraft || DEFAULT_SHEET_SETTINGS;
  const d = state.sheetDraft;
  const eventId = d.eventId || 'none';
  const selectedEvent = eventId!=='none' ? DB.events.find(e=>e.id===eventId) : null;
  const isWholeDay = selectedEvent && (selectedEvent.sessionType||'full')==='full';
  const session = isWholeDay ? (d.session || 'am') : null;
  const attendees = getEventAttendees(eventId, session);
  const chunks = attendees ? chunkArray(attendees, 30) : [null];
  const activePage = Math.max(0, Math.min(chunks.length-1, state.sheetPreviewPage||0));
  return `
  <div class="page-head-row">
    <div class="page-head" style="margin-bottom:0;"><h1>Attendance Sheet</h1><p>A printable, editable paper attendance sheet — for meetings, seminars, or events that need a signed hard copy.</p></div>
    <button class="btn-ghost" id="open-sheet-settings-btn">Header &amp; footer settings</button>
  </div>

  <div class="sheet-layout">
    <div class="card sheet-form-col">
      <div class="field">
        <label>Event (optional — fills in real attendee names)</label>
        <select id="sh-event">
          <option value="none" ${eventId==='none'?'selected':''}>None — blank sheet</option>
          ${DB.events.map(e=>`<option value="${e.id}" ${eventId===e.id?'selected':''}>${e.name}</option>`).join('')}
        </select>
      </div>
      ${isWholeDay ? `
      <div class="field">
        <label>Session</label>
        <select id="sh-session">
          <option value="am" ${session==='am'?'selected':''}>Morning</option>
          <option value="pm" ${session==='pm'?'selected':''}>Afternoon</option>
        </select>
      </div>` : ''}
      ${isWholeDay ? `<p class="hint">This is a whole-day event, so morning and afternoon get their own separate attendance sheets — switch the Session above to print the other one.</p>` : ''}
      ${attendees ? `<p class="hint">${attendees.length} student${attendees.length===1?'':'s'} checked in${isWholeDay ? ` for the ${session==='am'?'morning':'afternoon'} session` : ''} — split across <strong>${chunks.length}</strong> sheet${chunks.length===1?'':'s'} (30 per page, same header/footer repeated on each).</p>` : ''}
      <div class="field"><label>Nature/Title of Meeting/Activity/Seminar</label><input id="sh-title" value="${d.title}"></div>
      ${!attendees ? `<div class="field"><label>Rows</label><input id="sh-rows" type="number" min="1" max="60" value="${Math.max(1, Math.min(60, parseInt(d.rows,10) || 30))}"></div>` : ''}
      <div class="field"><label>Date</label><input id="sh-date" value="${d.date}"></div>
      <div class="field"><label>Time</label><input id="sh-time" value="${d.time}"></div>
      <div class="field"><label>Venue</label><input id="sh-venue" value="${d.venue}"></div>
      <button class="btn-gold" style="width:100%;" id="print-sheet-btn">Print / Save as PDF</button>
      <p class="hint">Opens your browser's print dialog — choose "Save as PDF" there if you want a digital copy instead of printing. Each sheet prints on its own page.</p>
    </div>

    <div class="sheet-preview-col">
      <div class="section-title" style="margin-top:0; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
        <span>Preview <span class="hint" style="font-weight:400; text-transform:none; letter-spacing:0;">— drag a logo to reposition it, use the settings modal to resize</span></span>
        ${chunks.length>1 ? `
        <span style="display:flex; align-items:center; gap:10px; text-transform:none; letter-spacing:0; font-weight:400;">
          <button class="btn-ghost" id="sheet-preview-prev-btn" ${activePage<=0?'disabled':''}>&larr; Prev</button>
          <span class="hint" style="margin:0;">Page ${activePage+1} of ${chunks.length}</span>
          <button class="btn-ghost" id="sheet-preview-next-btn" ${activePage>=chunks.length-1?'disabled':''}>Next &rarr;</button>
        </span>` : ''}
      </div>
      <div class="card sheet-zoom-bar" style="display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-bottom:10px; padding:8px 14px;">
        <button class="btn-ghost" id="sheet-zoom-out-btn" style="padding:4px 12px;">&minus;</button>
        <span class="hint" style="margin:0; min-width:40px; text-align:center;">${state.sheetZoom}%</span>
        <button class="btn-ghost" id="sheet-zoom-in-btn" style="padding:4px 12px;">+</button>
        <button class="btn-ghost" id="sheet-zoom-reset-btn" style="margin-left:6px;">Reset</button>
      </div>
      <div class="card sheet-preview-viewport">
        <div class="print-sheet-container" id="print-sheet" style="display:flex; flex-direction:column; align-items:center; gap:28px; zoom:${state.sheetZoom}%;">
          ${chunks.map((chunk, idx)=>renderOneSheet(s, d, chunk, idx, idx===activePage)).join('')}
        </div>
      </div>
    </div>
  </div>
  ${state.sheetSettingsModalOpen ? renderSheetSettingsModal() : ''}
  `;
}
function renderAdminLog(){
  const log = DB.adminLog || [];
  const { items: pageEntries, totalPages, page } = paginate(log, state.logPage, ADMIN_PAGE_SIZE);
  return `
  <div class="page-head"><h1>Activity Log</h1><p>A record of actions taken from the admin panel — who did what, and when. Keeps the most recent 200 entries.</p></div>
  <div class="card" style="padding:0;">
    <table>
      <tr><th>When</th><th>Admin</th><th>Action</th><th>Details</th></tr>
      ${pageEntries.map(l=>`<tr><td style="white-space:nowrap;">${fmtDate(l.timestamp)}</td><td>${l.actor}</td><td>${l.action}</td><td style="color:var(--ink-soft);">${l.details||'—'}</td></tr>`).join('') || `<tr><td colspan="4" class="empty">No admin actions recorded yet.</td></tr>`}
    </table>
  </div>
  ${paginationControls(page, totalPages, 'log')}
  `;
}
function attachAdminHandlers(){
  document.querySelectorAll('.dept-check').forEach(el=>{
    el.onchange = ()=>{
      const set = new Set(state.newEventDraft.departments);
      if(el.checked) set.add(el.value); else set.delete(el.value);
      state.newEventDraft.departments = [...set];
      // drop any checked sections that no longer belong to a still-checked department
      const allowedSections = new Set();
      state.newEventDraft.departments.forEach(dep=>{ sectionsFor(dep).forEach(s=>allowedSections.add(s)); });
      state.newEventDraft.sections = state.newEventDraft.sections.filter(s=>allowedSections.has(s));
      render();
    };
  });
  document.querySelectorAll('.ev-section-check').forEach(el=>{
    el.onchange = ()=>{
      const set = new Set(state.newEventDraft.sections);
      if(el.checked) set.add(el.value); else set.delete(el.value);
      state.newEventDraft.sections = [...set];
    };
  });
  const nameEl = document.getElementById('ev-name');
  if(nameEl) nameEl.oninput = ()=>{ state.newEventDraft.name = nameEl.value; };
  const dateEl = document.getElementById('ev-date');
  if(dateEl) dateEl.oninput = ()=>{ state.newEventDraft.date = dateEl.value; };
  const venueEl = document.getElementById('ev-venue');
  if(venueEl) venueEl.oninput = ()=>{ state.newEventDraft.venue = venueEl.value; };
  const amTimeEl = document.getElementById('ev-am-time');
  if(amTimeEl) amTimeEl.oninput = ()=>{ state.newEventDraft.amTime = amTimeEl.value; };
  const pmTimeEl = document.getElementById('ev-pm-time');
  if(pmTimeEl) pmTimeEl.oninput = ()=>{ state.newEventDraft.pmTime = pmTimeEl.value; };
  document.querySelectorAll('.ev-session-tab').forEach(el=>{
    el.onclick = ()=>{
      state.newEventDraft.sessionType = el.dataset.session;
      render();
    };
  });
  const openAddEvent = document.getElementById('open-add-event-btn');
  if(openAddEvent) openAddEvent.onclick = ()=>{
    state.eventModalOpen = true;
    state.newEventDraft = {name:'', date:'', departments:[...DB.departments], sessionType:'full', sections:[], venue:'', amTime:'', pmTime:''};
    state.err='';
    render();
  };
  const closeEventModal = ()=>{
    state.eventModalOpen = false;
    state.editingEventId = null;
    state.newEventDraft = {name:'', date:'', departments:[...DB.departments], sessionType:'full', sections:[], venue:'', amTime:'', pmTime:''};
    state.err='';
    render();
  };
  const closeEventBtn1 = document.getElementById('close-event-modal-btn');
  if(closeEventBtn1) closeEventBtn1.onclick = closeEventModal;
  const closeEventBtn2 = document.getElementById('close-event-modal-btn-2');
  if(closeEventBtn2) closeEventBtn2.onclick = closeEventModal;
  const eventModalOverlay = document.getElementById('event-modal-overlay');
  if(eventModalOverlay) eventModalOverlay.onclick = (e)=>{ if(e.target === eventModalOverlay) closeEventModal(); };
  const createEv = document.getElementById('create-event-btn');
  if(createEv) createEv.onclick = async ()=>{
    const d = state.newEventDraft;
    const editing = state.editingEventId;
    if(!d.name || d.departments.length===0){ state.err='Give the event a name and at least one department.'; render(); return; }
    if(editing){
      const idx = DB.events.findIndex(e=>e.id===editing);
      if(idx===-1){ state.err='This event no longer exists.'; state.editingEventId=null; render(); return; }
      DB.events[idx] = {...DB.events[idx], name:d.name, date:d.date, departments:[...d.departments], sessionType: d.sessionType || 'full', sections:[...d.sections], venue:d.venue||'', amTime:d.amTime||'', pmTime:d.pmTime||''};
      await saveKey('events', DB.events);
      await logAdminAction('Edited event', d.name);
    } else {
      DB.events.push({id: uid('evt'), name:d.name, date:d.date, departments:[...d.departments], sessionType: d.sessionType || 'full', sections:[...d.sections], venue:d.venue||'', amTime:d.amTime||'', pmTime:d.pmTime||''});
      await saveKey('events', DB.events);
      await logAdminAction('Created event', d.name);
    }
    state.eventModalOpen = false;
    state.editingEventId = null;
    state.newEventDraft = {name:'', date:'', departments:[...DB.departments], sessionType:'full', sections:[], venue:'', amTime:'', pmTime:''};
    state.err='';
    render();
  };
  document.querySelectorAll('[data-edit-event]').forEach(el=>{
    el.onclick = ()=>{
      const ev = DB.events.find(e=>e.id===el.dataset.editEvent);
      if(!ev) return;
      state.editingEventId = ev.id;
      state.newEventDraft = {name:ev.name, date:ev.date||'', departments:[...ev.departments], sessionType: ev.sessionType || 'full', sections:[...(ev.sections||[])], venue:ev.venue||'', amTime:ev.amTime||'', pmTime:ev.pmTime||''};
      state.err='';
      render();
    };
  });
  document.querySelectorAll('[data-del-event]').forEach(el=>{
    el.onclick = async ()=>{
      const ev = DB.events.find(e=>e.id===el.dataset.delEvent);
      if(!confirm(`Remove "${ev ? ev.name : 'this event'}"? This does not delete existing attendance records for it.`)) return;
      DB.events = DB.events.filter(e=>e.id!==el.dataset.delEvent);
      await saveKey('events', DB.events);
      await logAdminAction('Deleted event', ev ? ev.name : el.dataset.delEvent);
      render();
    };
  });
  const ofName = document.getElementById('of-name');
  if(ofName) ofName.oninput = ()=>{ state.newOfficerDraft.name = ofName.value; };
  const ofUser = document.getElementById('of-user');
  if(ofUser) ofUser.oninput = ()=>{ state.newOfficerDraft.username = ofUser.value; };
  const ofDept = document.getElementById('of-dept');
  if(ofDept) ofDept.onchange = ()=>{
    state.newOfficerDraft.department = ofDept.value;
    const secSel = document.getElementById('of-section');
    if(secSel) secSel.innerHTML = sectionOptions(ofDept.value, null);
  };
  document.querySelectorAll('.officer-type-tab').forEach(el=>{
    el.onclick = ()=>{
      if(state.editingOfficerUsername) return; // type can't change mid-edit
      state.newOfficerDraft.type = el.dataset.type;
      state.err='';
      render();
    };
  });
  const openAddOfficer = document.getElementById('open-add-officer-btn');
  if(openAddOfficer) openAddOfficer.onclick = ()=>{
    state.officerModalOpen = true;
    state.newOfficerDraft = {name:'', username:'', password:'', department:DB.departments[0], section:'', type:'section'};
    state.err='';
    render();
  };
  const closeOfficerModal = ()=>{
    state.officerModalOpen = false;
    state.editingOfficerUsername = null;
    state.newOfficerDraft = {name:'', username:'', password:'', department:DB.departments[0], section:'', type:'section'};
    state.err='';
    render();
  };
  const closeOfficerBtn1 = document.getElementById('close-officer-modal-btn');
  if(closeOfficerBtn1) closeOfficerBtn1.onclick = closeOfficerModal;
  const closeOfficerBtn2 = document.getElementById('close-officer-modal-btn-2');
  if(closeOfficerBtn2) closeOfficerBtn2.onclick = closeOfficerModal;
  const officerModalOverlay = document.getElementById('officer-modal-overlay');
  if(officerModalOverlay) officerModalOverlay.onclick = (e)=>{ if(e.target === officerModalOverlay) closeOfficerModal(); };
  const createOf = document.getElementById('create-officer-btn');
  if(createOf) createOf.onclick = async ()=>{
    const name = document.getElementById('of-name').value.trim();
    const username = document.getElementById('of-user').value.trim();
    const pw = document.getElementById('of-pw').value;
    const editing = state.editingOfficerUsername;
    const type = state.newOfficerDraft.type || 'section';
    const needsDept = (type==='section' || type==='department');
    const needsSection = type==='section';
    const deptEl = document.getElementById('of-dept');
    const secEl = document.getElementById('of-section');
    const department = needsDept ? (deptEl ? deptEl.value : state.newOfficerDraft.department) : null;
    const section = needsSection ? (secEl ? secEl.value : '') : null;
    if(!name || !username || (needsSection && !section) || (!editing && !pw)){ state.err='Fill in every field — if Section only shows "No sections yet," add one under Sections first.'; render(); return; }
    if(editing){
      const existing = DB.users[editing];
      if(!existing){ state.err='This officer no longer exists.'; state.editingOfficerUsername=null; render(); return; }
      existing.name = name;
      if(existing.role==='officer'){ existing.department = department; existing.section = section; }
      if(pw) existing.passwordHash = hashPw(pw);
      DB.users[editing] = existing;
      await saveKey('users', DB.users);
      await logAdminAction('Edited officer', `${name} (${editing})`);
    } else {
      if(DB.users[username]){ state.err='That username is taken.'; render(); return; }
      if(type==='ssg'){
        DB.users[username] = {id:username, role:'ssg', name, username, passwordHash:hashPw(pw)};
      } else {
        DB.users[username] = {id:username, role:'officer', name, username, department, section, passwordHash:hashPw(pw)};
      }
      await saveKey('users', DB.users);
      await logAdminAction('Created officer', `${name} (${username}), ${scopeLabel(type)}`);
    }
    state.officerModalOpen = false;
    state.newOfficerDraft = {name:'', username:'', password:'', department:DB.departments[0], section:'', type:'section'};
    state.editingOfficerUsername = null;
    state.err='';
    render();
  };
  document.querySelectorAll('[data-edit-officer]').forEach(el=>{
    el.onclick = ()=>{
      const o = DB.users[el.dataset.editOfficer];
      if(!o) return;
      state.editingOfficerUsername = o.username;
      state.newOfficerDraft = {name:o.name, username:o.username, password:'', department:o.department || DB.departments[0], section:o.section || '', type: o.role==='ssg' ? 'ssg' : (o.section ? 'section' : 'department')};
      state.err='';
      render();
    };
  });
  document.querySelectorAll('[data-del-officer]').forEach(el=>{
    el.onclick = async ()=>{
      const o = DB.users[el.dataset.delOfficer];
      if(!confirm(`Remove officer account "${o ? o.name : el.dataset.delOfficer}"? This cannot be undone.`)) return;
      delete DB.users[el.dataset.delOfficer];
      await saveKey('users', DB.users);
      await logAdminAction('Deleted officer', o ? `${o.name} (${el.dataset.delOfficer})` : el.dataset.delOfficer);
      render();
    };
  });
  document.querySelectorAll('[data-reset-officer]').forEach(el=>{
    el.onclick = async ()=>{
      const username = el.dataset.resetOfficer;
      const u = DB.users[username];
      if(!u) return;
      if(!confirm(`Reset the password for ${u.name} (${username})? Their current password will stop working immediately.`)) return;
      const temp = generateTempPassword();
      u.passwordHash = hashPw(temp);
      DB.users[username] = u;
      await saveKey('users', DB.users);
      await logAdminAction('Reset officer password', `${u.name} (${username})`);
      state.lastOfficerResetPassword = { username, name:u.name, plaintext: temp };
      render();
    };
  });
  const dismissOfficerReset = document.getElementById('dismiss-officer-reset-btn');
  if(dismissOfficerReset) dismissOfficerReset.onclick = ()=>{ state.lastOfficerResetPassword=null; render(); };
  const copyOfficerResetBtn = document.getElementById('copy-officer-reset-pw-btn');
  if(copyOfficerResetBtn) copyOfficerResetBtn.onclick = async ()=>{
    try{
      await navigator.clipboard.writeText(copyOfficerResetBtn.dataset.pw);
      copyOfficerResetBtn.textContent = 'Copied!';
      setTimeout(()=>{ copyOfficerResetBtn.textContent = 'Copy'; }, 1500);
    }catch(e){
      copyOfficerResetBtn.textContent = 'Copy failed — select manually';
    }
  };
  document.querySelectorAll('.officer-type-filter-btn').forEach(el=>{
    el.onclick = ()=>{
      state.officerTypeFilter = el.dataset.type;
      state.officerPage = 1;
      render();
    };
  });
  const officerSearch = document.getElementById('officer-search');
  if(officerSearch) officerSearch.oninput = ()=>{
    state.officerSearchQuery = officerSearch.value;
    state.officerPage = 1;
    reRenderPreservingFocus();
  };
  const officerPrevBtn = document.getElementById('officer-prev-btn');
  if(officerPrevBtn) officerPrevBtn.onclick = ()=>{ state.officerPage = Math.max(1, (state.officerPage||1)-1); render(); };
  const officerNextBtn = document.getElementById('officer-next-btn');
  if(officerNextBtn) officerNextBtn.onclick = ()=>{ state.officerPage = (state.officerPage||1)+1; render(); };
  const fe = document.getElementById('filter-event');
  if(fe) fe.onchange = async ()=>{ state.adminFilterEvent = fe.value; state.recordsPage = 1; DB.attendance = await fetchKey('attendance', DB.attendance); render(); };
  const fd = document.getElementById('filter-dept');
  if(fd) fd.onchange = ()=>{ state.adminFilterDept = fd.value; state.recordsPage = 1; render(); };
  const fs = document.getElementById('filter-scope');
  if(fs) fs.onchange = ()=>{ state.adminFilterScope = fs.value; state.recordsPage = 1; render(); };
  document.querySelectorAll('[data-show-attendance]').forEach(el=>{
    el.onclick = ()=>{
      state.showAttendanceStudentId = el.dataset.showAttendance;
      render();
    };
  });
  const closeStudentAttModal = ()=>{ state.showAttendanceStudentId = null; render(); };
  const closeStudentAttBtn = document.getElementById('close-student-attendance-modal-btn');
  if(closeStudentAttBtn) closeStudentAttBtn.onclick = closeStudentAttModal;
  const studentAttOverlay = document.getElementById('student-attendance-modal-overlay');
  if(studentAttOverlay) studentAttOverlay.onclick = (e)=>{ if(e.target === studentAttOverlay) closeStudentAttModal(); };
  const recordsPrevBtn = document.getElementById('records-prev-btn');
  if(recordsPrevBtn) recordsPrevBtn.onclick = ()=>{ state.recordsPage = Math.max(1, (state.recordsPage||1)-1); render(); };
  const recordsNextBtn = document.getElementById('records-next-btn');
  if(recordsNextBtn) recordsNextBtn.onclick = ()=>{ state.recordsPage = (state.recordsPage||1)+1; render(); };
  const addDept = document.getElementById('add-dept-btn');
  if(addDept) addDept.onclick = async ()=>{
    const nameEl = document.getElementById('new-dept-name');
    const name = nameEl.value.trim();
    if(!name){ state.err='Enter a department name.'; render(); return; }
    if(DB.departments.includes(name)){ state.err='That department already exists.'; render(); return; }
    DB.departments.push(name);
    await saveKey('departments', DB.departments);
    await logAdminAction('Added department', name);
    state.err='';
    render();
  };
  document.querySelectorAll('[data-del-dept]').forEach(el=>{
    el.onclick = async ()=>{
      const dept = el.dataset.delDept;
      if(!confirm(`Remove ${dept}? Its sections list will be removed too.`)) return;
      DB.departments = DB.departments.filter(d=>d!==dept);
      delete DB.sections[dept];
      await saveKey('departments', DB.departments);
      await saveKey('sections', DB.sections);
      await logAdminAction('Deleted department', dept);
      render();
    };
  });
  document.querySelectorAll('.add-section-input').forEach(input=>{
    input.onkeydown = (e)=>{ if(e.key==='Enter'){ e.preventDefault(); addSectionFor(input.dataset.dept, input.value); } };
  });
  document.querySelectorAll('.add-section-btn').forEach(btn=>{
    btn.onclick = ()=>{
      const input = document.querySelector(`.add-section-input[data-dept="${CSS.escape(btn.dataset.dept)}"]`);
      addSectionFor(btn.dataset.dept, input ? input.value : '');
    };
  });
  async function addSectionFor(dept, rawName){
    const name = (rawName||'').trim();
    if(!name){ state.err='Enter a section name.'; render(); return; }
    if(!DB.sections[dept]) DB.sections[dept] = [];
    if(DB.sections[dept].some(s=>normSection(s)===normSection(name))){ state.err='That section already exists for this department.'; render(); return; }
    DB.sections[dept].push(name);
    await saveKey('sections', DB.sections);
    await logAdminAction('Added section', `${name} (${dept})`);
    state.err='';
    render();
  }
  document.querySelectorAll('[data-del-section-dept]').forEach(el=>{
    el.onclick = async ()=>{
      const dept = el.dataset.delSectionDept;
      const name = el.dataset.delSectionName;
      DB.sections[dept] = (DB.sections[dept]||[]).filter(s=>s!==name);
      await saveKey('sections', DB.sections);
      await logAdminAction('Deleted section', `${name} (${dept})`);
      render();
    };
  });
  const studentSearchEl = document.getElementById('student-search');
  if(studentSearchEl) studentSearchEl.oninput = ()=>{
    state.studentSearchQuery = studentSearchEl.value;
    state.studentPage = 1;
    reRenderPreservingFocus();
  };
  document.querySelectorAll('.dept-chip:not(.officer-type-filter-btn)').forEach(el=>{
    el.onclick = ()=>{
      state.studentDeptFilter = el.dataset.dept;
      state.studentPage = 1;
      render();
    };
  });
  const studentPrevBtn = document.getElementById('student-prev-btn');
  if(studentPrevBtn) studentPrevBtn.onclick = ()=>{ state.studentPage = Math.max(1, (state.studentPage||1)-1); render(); };
  const studentNextBtn = document.getElementById('student-next-btn');
  if(studentNextBtn) studentNextBtn.onclick = ()=>{ state.studentPage = (state.studentPage||1)+1; render(); };
  document.querySelectorAll('[data-edit-student]').forEach(el=>{
    el.onclick = ()=>{
      state.editingStudentId = el.dataset.editStudent;
      state.err = '';
      render();
    };
  });
  const stuEditDept = document.getElementById('stu-edit-dept');
  if(stuEditDept) stuEditDept.onchange = ()=>{
    const secSel = document.getElementById('stu-edit-section');
    if(secSel) secSel.innerHTML = sectionOptions(stuEditDept.value, null);
  };
  const saveStudentEdit = document.getElementById('save-student-edit-btn');
  if(saveStudentEdit) saveStudentEdit.onclick = async ()=>{
    const id = state.editingStudentId;
    const u = DB.users[id];
    if(!u){ state.err='This student no longer exists.'; state.editingStudentId=null; render(); return; }
    const name = document.getElementById('stu-edit-name').value.trim();
    const sex = document.getElementById('stu-edit-sex').value;
    const department = document.getElementById('stu-edit-dept').value;
    const section = document.getElementById('stu-edit-section').value;
    if(!name || !section){ state.err='Fill in every field.'; render(); return; }
    u.name = name; u.sex = sex; u.department = department; u.section = section;
    DB.users[id] = u;
    await saveKey('users', DB.users);
    await logAdminAction('Edited student', `${name} (${id})`);
    state.editingStudentId = null;
    state.err = '';
    render();
  };
  const cancelStudentEdit = document.getElementById('cancel-student-edit-btn');
  if(cancelStudentEdit) cancelStudentEdit.onclick = ()=>{ state.editingStudentId=null; state.err=''; render(); };
  document.querySelectorAll('[data-reset-student]').forEach(el=>{
    el.onclick = async ()=>{
      const id = el.dataset.resetStudent;
      const u = DB.users[id];
      if(!u) return;
      if(!confirm(`Reset the password for ${u.name} (${id})? Their current password will stop working immediately.`)) return;
      const temp = generateTempPassword();
      u.passwordHash = hashPw(temp);
      DB.users[id] = u;
      await saveKey('users', DB.users);
      await logAdminAction('Reset student password', `${u.name} (${id})`);
      state.lastResetPassword = { studentId:id, name:u.name, plaintext: temp };
      render();
    };
  });
  const dismissReset = document.getElementById('dismiss-reset-btn');
  if(dismissReset) dismissReset.onclick = ()=>{ state.lastResetPassword=null; render(); };
  const copyResetBtn = document.getElementById('copy-reset-pw-btn');
  if(copyResetBtn) copyResetBtn.onclick = async ()=>{
    try{
      await navigator.clipboard.writeText(copyResetBtn.dataset.pw);
      copyResetBtn.textContent = 'Copied!';
      setTimeout(()=>{ copyResetBtn.textContent = 'Copy'; }, 1500);
    }catch(e){
      copyResetBtn.textContent = 'Copy failed — select manually';
    }
  };
  document.querySelectorAll('[data-remove-att]').forEach(el=>{
    el.onclick = async ()=>{
      if(!confirm('Remove this attendance record? This clears both time-in and time-out for that student on this event.')) return;
      await removeAttendanceRecord(el.dataset.removeAtt);
      await logAdminAction('Removed attendance record', el.dataset.removeAtt);
      render();
    };
  });
  const bulkResetBtn = document.getElementById('bulk-reset-records-btn');
  if(bulkResetBtn) bulkResetBtn.onclick = async ()=>{
    const eventId = state.adminFilterEvent;
    const dept = state.adminFilterDept;
    const eventName = (DB.events.find(e=>e.id===eventId)||{}).name || 'this event';
    DB.attendance = await fetchKey('attendance', DB.attendance);
    const toRemove = DB.attendance.filter(a => a.eventId===eventId && (dept==='all' || a.department===dept));
    if(toRemove.length===0){ render(); return; }
    if(!confirm(`Reset attendance for ${eventName}${dept!=='all'?` (${dept})`:''}? This permanently removes ${toRemove.length} record${toRemove.length===1?'':'s'} — students will need to scan in again from scratch.`)) return;
    DB.attendance = DB.attendance.filter(a => !(a.eventId===eventId && (dept==='all' || a.department===dept)));
    await saveKey('attendance', DB.attendance);
    await logAdminAction('Bulk-reset attendance', `${toRemove.length} record(s) for ${eventName}${dept!=='all'?` (${dept})`:''}`);
    render();
  };
  const exportBtn = document.getElementById('export-attendees-btn');
  if(exportBtn) exportBtn.onclick = ()=>{ state.exportModalOpen = true; render(); };
  const closeExportModal = ()=>{ state.exportModalOpen = false; render(); };
  const closeExportBtn1 = document.getElementById('close-export-modal-btn');
  if(closeExportBtn1) closeExportBtn1.onclick = closeExportModal;
  const closeExportBtn2 = document.getElementById('close-export-modal-btn-2');
  if(closeExportBtn2) closeExportBtn2.onclick = closeExportModal;
  const exportModalOverlay = document.getElementById('export-modal-overlay');
  if(exportModalOverlay) exportModalOverlay.onclick = (e)=>{ if(e.target === exportModalOverlay) closeExportModal(); };
  const copyExportBtn = document.getElementById('copy-export-btn');
  if(copyExportBtn) copyExportBtn.onclick = async ()=>{
    const ta = document.getElementById('export-textarea');
    try{
      await navigator.clipboard.writeText(ta.value);
      copyExportBtn.textContent = 'Copied!';
      setTimeout(()=>{ copyExportBtn.textContent = 'Copy to clipboard'; }, 1500);
    }catch(e){
      ta.select();
      copyExportBtn.textContent = 'Select the text above and copy manually';
    }
  };
  const downloadExportBtn = document.getElementById('download-export-btn');
  if(downloadExportBtn) downloadExportBtn.onclick = async ()=>{
    const ta = document.getElementById('export-textarea');
    const lines = ta.value.split('\n').map(line => line.split('\t'));
    const csv = lines.map(cols => cols.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const eventName = state.adminFilterEvent==='all' ? 'attendees' : ((DB.events.find(e=>e.id===state.adminFilterEvent)||{}).name || 'attendees');
    a.href = url;
    a.download = `${eventName.replace(/[^a-z0-9]+/gi,'-')}-attendees.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    await logAdminAction('Exported attendee list', eventName);
  };
  const logPrevBtn = document.getElementById('log-prev-btn');
  if(logPrevBtn) logPrevBtn.onclick = ()=>{ state.logPage = Math.max(1, (state.logPage||1)-1); render(); };
  const logNextBtn = document.getElementById('log-next-btn');
  if(logNextBtn) logNextBtn.onclick = ()=>{ state.logPage = (state.logPage||1)+1; render(); };
  const analyticsPrevBtn = document.getElementById('analytics-prev-btn');
  if(analyticsPrevBtn) analyticsPrevBtn.onclick = ()=>{ state.analyticsPage = Math.max(1, (state.analyticsPage||1)-1); render(); };
  const analyticsNextBtn = document.getElementById('analytics-next-btn');
  if(analyticsNextBtn) analyticsNextBtn.onclick = ()=>{ state.analyticsPage = (state.analyticsPage||1)+1; render(); };

  /* ---------------- Attendance Sheet ---------------- */
  function readImageAsDataUrl(file, cb){
    if(!file) return;
    if(file.size > 1.5*1024*1024){ state.err = 'That image is a bit large — please use one under 1.5MB.'; render(); return; }
    const reader = new FileReader();
    reader.onload = ()=>{ cb(reader.result); render(); };
    reader.readAsDataURL(file);
  }
  const leftLogoInput = document.getElementById('left-logo-input');
  if(leftLogoInput) leftLogoInput.onchange = ()=>{
    readImageAsDataUrl(leftLogoInput.files[0], (dataUrl)=>{ state.sheetSettingsDraft.leftLogo = dataUrl; });
  };
  const rightLogoInput = document.getElementById('right-logo-input');
  if(rightLogoInput) rightLogoInput.onchange = ()=>{
    readImageAsDataUrl(rightLogoInput.files[0], (dataUrl)=>{ state.sheetSettingsDraft.rightLogo = dataUrl; });
  };
  const removeLeftLogo = document.getElementById('remove-left-logo-btn');
  if(removeLeftLogo) removeLeftLogo.onclick = ()=>{ state.sheetSettingsDraft.leftLogo = ''; render(); };
  const removeRightLogo = document.getElementById('remove-right-logo-btn');
  if(removeRightLogo) removeRightLogo.onclick = ()=>{ state.sheetSettingsDraft.rightLogo = ''; render(); };
  const footerLogoInput = document.getElementById('footer-logo-input');
  if(footerLogoInput) footerLogoInput.onchange = ()=>{
    readImageAsDataUrl(footerLogoInput.files[0], (dataUrl)=>{ state.sheetSettingsDraft.footerLogo = dataUrl; });
  };
  const removeFooterLogo = document.getElementById('remove-footer-logo-btn');
  if(removeFooterLogo) removeFooterLogo.onclick = ()=>{ state.sheetSettingsDraft.footerLogo = ''; render(); };
  // logo size sliders — update the live preview + label directly, no re-render, so a mid-drag
  // render() never interrupts the browser's native slider-dragging state
  [['left-logo-size','leftLogoSize','left'], ['right-logo-size','rightLogoSize','right']].forEach(([id, field, key])=>{
    const slider = document.getElementById(id);
    if(!slider) return;
    slider.oninput = ()=>{
      const val = parseInt(slider.value, 10);
      state.sheetSettingsDraft[field] = val;
      document.querySelectorAll(`.ps-draggable-logo[data-logo="${key}"]`).forEach(img=>{
        img.style.width = val+'px'; img.style.height = val+'px';
      });
      const label = slider.previousElementSibling;
      if(label) label.textContent = `Size (${val}px)`;
    };
  });
  // footer logo is a wide rectangular badge shape, not square — width and height adjust independently
  const footerWidthSlider = document.getElementById('footer-logo-width');
  if(footerWidthSlider) footerWidthSlider.oninput = ()=>{
    const val = parseInt(footerWidthSlider.value, 10);
    state.sheetSettingsDraft.footerLogoWidth = val;
    document.querySelectorAll('.ps-draggable-logo[data-logo="footer"]').forEach(img=>{ img.style.width = val+'px'; });
    const label = footerWidthSlider.previousElementSibling;
    if(label) label.textContent = `Width (${val}px)`;
  };
  const footerHeightSlider = document.getElementById('footer-logo-height');
  if(footerHeightSlider) footerHeightSlider.oninput = ()=>{
    const val = parseInt(footerHeightSlider.value, 10);
    state.sheetSettingsDraft.footerLogoHeight = val;
    document.querySelectorAll('.ps-draggable-logo[data-logo="footer"]').forEach(img=>{ img.style.height = val+'px'; });
    const label = footerHeightSlider.previousElementSibling;
    if(label) label.textContent = `Height (${val}px)`;
  };
  [['reset-left-logo-pos-btn','left'], ['reset-right-logo-pos-btn','right'], ['reset-footer-logo-pos-btn','footer']].forEach(([id, key])=>{
    const btn = document.getElementById(id);
    if(btn) btn.onclick = ()=>{
      state.sheetSettingsDraft[key+'LogoX'] = 0;
      state.sheetSettingsDraft[key+'LogoY'] = 0;
      render();
    };
  });
  document.querySelectorAll('.ps-draggable-logo').forEach(img=>{
    const key = img.dataset.logo;
    img.style.cursor = 'grab';
    const startDrag = (e)=>{
      const point = e.touches ? e.touches[0] : e;
      sheetDragState = {
        key, img,
        startX: point.clientX, startY: point.clientY,
        origX: (state.sheetSettingsDraft && state.sheetSettingsDraft[key+'LogoX']) || 0,
        origY: (state.sheetSettingsDraft && state.sheetSettingsDraft[key+'LogoY']) || 0
      };
      if(e.cancelable) e.preventDefault();
    };
    img.onmousedown = startDrag;
    img.ontouchstart = startDrag;
  });
  [
    ['sh-university','university'], ['sh-address','address'], ['sh-website','website'],
    ['sh-email','email'], ['sh-telfax','telfax'], ['sh-collegeunit','collegeUnit'],
    ['sh-refno','refNo'], ['sh-effdate','effectivityDate'], ['sh-revno','revisionNo'],
    ['sh-footerlabel','footerLabel'], ['sh-siglabel','signatureLabel']
  ].forEach(([id,field])=>{
    const el = document.getElementById(id);
    if(el) el.oninput = ()=>{ state.sheetSettingsDraft[field] = el.value; reRenderPreservingFocus(); };
  });
  [
    ['sh-title','title'], ['sh-date','date'], ['sh-time','time'], ['sh-venue','venue'], ['sh-rows','rows']
  ].forEach(([id,field])=>{
    const el = document.getElementById(id);
    if(el) el.oninput = ()=>{ state.sheetDraft[field] = el.value; reRenderPreservingFocus(); };
  });
  const sheetEventSelect = document.getElementById('sh-event');
  if(sheetEventSelect) sheetEventSelect.onchange = async ()=>{
    const eventId = sheetEventSelect.value;
    state.sheetDraft.eventId = eventId;
    state.sheetPreviewPage = 0;
    if(eventId !== 'none'){
      DB.attendance = await fetchKey('attendance', DB.attendance);
      const ev = DB.events.find(e=>e.id===eventId);
      if(ev){
        if(!state.sheetDraft.title) state.sheetDraft.title = ev.name;
        if(!state.sheetDraft.date && ev.date) state.sheetDraft.date = formatDateLong(ev.date);
        if(!state.sheetDraft.venue && ev.venue) state.sheetDraft.venue = ev.venue;
        const isWholeDay = (ev.sessionType||'full')==='full';
        state.sheetDraft.session = isWholeDay ? (state.sheetDraft.session || 'am') : null;
        const relevantTime = ev.sessionType==='pm' ? ev.pmTime : (isWholeDay ? (state.sheetDraft.session==='pm' ? ev.pmTime : ev.amTime) : ev.amTime);
        if(!state.sheetDraft.time && relevantTime) state.sheetDraft.time = relevantTime;
      }
    }
    render();
  };
  const sheetSessionSelect = document.getElementById('sh-session');
  if(sheetSessionSelect) sheetSessionSelect.onchange = ()=>{
    state.sheetDraft.session = sheetSessionSelect.value;
    state.sheetPreviewPage = 0;
    const ev = DB.events.find(e=>e.id===state.sheetDraft.eventId);
    if(ev){
      const relevantTime = state.sheetDraft.session==='pm' ? ev.pmTime : ev.amTime;
      if(relevantTime) state.sheetDraft.time = relevantTime; // switching session updates the shown time to match
    }
    render();
  };
  const sheetPrevPageBtn = document.getElementById('sheet-preview-prev-btn');
  if(sheetPrevPageBtn) sheetPrevPageBtn.onclick = ()=>{ state.sheetPreviewPage = Math.max(0, (state.sheetPreviewPage||0)-1); render(); };
  const sheetNextPageBtn = document.getElementById('sheet-preview-next-btn');
  if(sheetNextPageBtn) sheetNextPageBtn.onclick = ()=>{ state.sheetPreviewPage = (state.sheetPreviewPage||0)+1; render(); };
  const sheetZoomOutBtn = document.getElementById('sheet-zoom-out-btn');
  if(sheetZoomOutBtn) sheetZoomOutBtn.onclick = ()=>{ state.sheetZoom = Math.max(30, (state.sheetZoom||70)-10); render(); };
  const sheetZoomInBtn = document.getElementById('sheet-zoom-in-btn');
  if(sheetZoomInBtn) sheetZoomInBtn.onclick = ()=>{ state.sheetZoom = Math.min(150, (state.sheetZoom||70)+10); render(); };
  const sheetZoomResetBtn = document.getElementById('sheet-zoom-reset-btn');
  if(sheetZoomResetBtn) sheetZoomResetBtn.onclick = ()=>{ state.sheetZoom = 70; render(); };
  const openSheetSettingsBtn = document.getElementById('open-sheet-settings-btn');
  if(openSheetSettingsBtn) openSheetSettingsBtn.onclick = ()=>{ state.sheetSettingsModalOpen = true; state.err=''; render(); };
  const closeSheetSettings = ()=>{ state.sheetSettingsModalOpen = false; state.err=''; render(); };
  const closeSheetBtn1 = document.getElementById('close-sheet-settings-btn');
  if(closeSheetBtn1) closeSheetBtn1.onclick = closeSheetSettings;
  const closeSheetBtn2 = document.getElementById('close-sheet-settings-btn-2');
  if(closeSheetBtn2) closeSheetBtn2.onclick = closeSheetSettings;
  const sheetModalOverlay = document.getElementById('sheet-settings-modal-overlay');
  if(sheetModalOverlay) sheetModalOverlay.onclick = (e)=>{ if(e.target === sheetModalOverlay) closeSheetSettings(); };
  const saveSheetSettingsBtn = document.getElementById('save-sheet-settings-btn');
  if(saveSheetSettingsBtn) saveSheetSettingsBtn.onclick = async ()=>{
    DB.sheetSettings = { ...state.sheetSettingsDraft };
    await saveKey('sheetSettings', DB.sheetSettings);
    await logAdminAction('Updated attendance sheet header/footer', '');
    state.sheetSettingsModalOpen = false;
    state.err = '';
    render();
  };
  const printSheetBtn = document.getElementById('print-sheet-btn');
  if(printSheetBtn) printSheetBtn.onclick = ()=>{ window.print(); };

  if(state.adminSubRoute==='profile') attachProfileHandlers();
  wirePasswordToggles();
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
  // if the browser restores this page from its back/forward cache (common on mobile after a
  // "refresh" gesture), force a real reload so data is fetched fresh instead of showing a stale snapshot
  window.addEventListener('pageshow', function(event){
    if(event.persisted){ window.location.reload(); }
  });
  document.getElementById('app').innerHTML = `<div class="center-screen"><p style="color:var(--ink-soft);">Loading…</p></div>`;
  if(!SUPABASE_CONFIGURED){
    document.getElementById('app').innerHTML = renderSetupNeeded();
    return;
  }
  await seedIfEmpty();
  await syncServerTimeOffset();
  render();
})();
