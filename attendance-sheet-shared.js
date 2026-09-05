/* ====================================================================
   ATTENDANCE SHEET — SHARED CODE
   Used by all three role-specific files:
     - attendance-sheet-admin.js       (SAS Admin)
     - attendance-sheet-department.js  (Department Officer)
     - attendance-sheet-ssg.js         (SSG Officer)
   Load this file AFTER app.js and BEFORE the three files above, in both
   index.html and admin.html.
   Contains: default settings, data-fetching helpers, the actual sheet
   markup renderer, the settings/preview modals, logo drag-and-resize
   logic, and the handler wiring shared by every role.
   ==================================================================== */

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

/* eventId + optional session ('am'|'pm', for whole-day events split into two sheets) +
   optional scopeFilter ('section'|'department'|'ssg') + optional departmentFilter (exact
   department name) — passing scope/department lets a Department or SSG officer's sheet only
   include the attendees who checked in through their own kind of desk, instead of everyone
   who attended the event via any desk (which is what Admin's sheet intentionally still shows). */
function getEventAttendees(eventId, session, scopeFilter, departmentFilter){
  if(!eventId || eventId==='none') return null;
  const byStudent = {};
  DB.attendance.forEach(r=>{
    if(r.eventId !== eventId) return;
    // for a whole-day event printed as two separate sheets, only include students who actually
    // showed up for that specific half of the day, not everyone who attended the event at all
    if(session==='am' && !r.amTimeIn) return;
    if(session==='pm' && !r.pmTimeIn) return;
    if(scopeFilter && r.scope !== scopeFilter) return;
    if(departmentFilter && r.department !== departmentFilter) return;
    if(!byStudent[r.studentId]) byStudent[r.studentId] = { studentName:r.studentName, department:r.department, section:r.section, sex:(DB.users[r.studentId]||{}).sex || '' };
  });
  return Object.values(byStudent).sort((a,b)=>a.studentName.localeCompare(b.studentName));
}
function chunkArray(arr, size){
  const out = [];
  for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
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
function computeFitZoom(){
  const viewport = document.querySelector('.sheet-preview-viewport');
  if(!viewport) return null;
  const paddingAllowance = 56; // roughly the viewport's own left+right padding
  const availableWidth = viewport.clientWidth - paddingAllowance;
  const naturalWidthPx = 8.5 * 96; // .print-sheet is fixed at 8.5in
  if(availableWidth <= 0) return null;
  let zoom = Math.floor((availableWidth / naturalWidthPx) * 100);
  return Math.max(30, Math.min(150, zoom));
}
function applySheetZoom(pct){
  state.sheetZoom = pct;
  const container = document.getElementById('print-sheet');
  if(container) container.style.zoom = pct + '%';
  const label = document.getElementById('sheet-zoom-label');
  if(label) label.textContent = pct + '%';
}
// true whenever the person is currently looking at ANY of the three role-specific sheet pages —
// used to scope the auto-fit-zoom recalculation (on render and on window resize) so it doesn't
// do unnecessary work while the person is elsewhere in the app
function isOnSheetPage(){
  const role = state.route;
  return (role==='admin' && state.adminSubRoute==='sheet')
      || (role==='officer' && state.officerSubRoute==='sheet')
      || (role==='ssg' && state.ssgSubRoute==='sheet');
}

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
let sheetResizeDebounce = null;
window.addEventListener('resize', ()=>{
  if(!(isOnSheetPage() && state.sheetZoomAuto && state.sheetPreviewModalOpen)) return;
  clearTimeout(sheetResizeDebounce);
  sheetResizeDebounce = setTimeout(()=>{
    const fitZoom = computeFitZoom();
    if(fitZoom) applySheetZoom(fitZoom);
  }, 150);
});

function renderSheetSettingsModal(){
  const s = state.sheetSettingsDraft || DEFAULT_SHEET_SETTINGS;
  return `
  <div class="modal-overlay" id="sheet-settings-modal-overlay">
    <div class="modal-card" style="max-width:640px;">
      <button class="close-x" id="close-sheet-settings-btn">&times;</button>
      <h3 style="margin-top:0;">Sheet header &amp; footer</h3>
      <p class="hint" style="margin-top:-6px;">Saved once and reused for every sheet anyone prints — Admin, Department, and SSG all share the same header/footer.</p>
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
        <div>Nature/Title of Meeting/Activity/Seminar: <span class="ps-fill wide ps-fill-title">${d.title}</span></div>
        <div class="ps-fields-row">
          <span>Date: <span class="ps-fill short ps-fill-date">${d.date}</span></span>
          <span>Time: <span class="ps-fill short ps-fill-time">${d.time}</span></span>
          <span>Venue: <span class="ps-fill ps-fill-venue">${d.venue}</span></span>
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

function renderSheetPreviewModal(s, d, chunks, activePage){
  return `
  <div class="modal-overlay sheet-preview-overlay" id="sheet-preview-modal-overlay">
    <div class="modal-card sheet-preview-card" style="max-width:95vw; width:auto;">
      <button class="close-x" id="close-sheet-preview-btn">&times;</button>
      <div class="section-title" style="margin-top:0; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
        <span>Preview <span class="hint" style="font-weight:400; text-transform:none; letter-spacing:0;">— drag a logo to reposition it, use the settings modal to resize</span></span>
        ${chunks.length>1 ? `
        <span style="display:flex; align-items:center; gap:10px; text-transform:none; letter-spacing:0; font-weight:400;">
          <button class="btn-ghost" id="sheet-preview-prev-btn" ${activePage<=0?'disabled':''}>&larr; Prev</button>
          <span class="hint" id="sheet-page-label" style="margin:0;">Page ${activePage+1} of ${chunks.length}</span>
          <button class="btn-ghost" id="sheet-preview-next-btn" ${activePage>=chunks.length-1?'disabled':''}>Next &rarr;</button>
        </span>` : ''}
      </div>
      <div class="sheet-zoom-bar" style="display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-bottom:10px;">
        <button class="btn-ghost" id="sheet-zoom-out-btn" style="padding:4px 12px;">&minus;</button>
        <span class="hint" id="sheet-zoom-label" style="margin:0; min-width:40px; text-align:center;">${state.sheetZoom}%</span>
        <button class="btn-ghost" id="sheet-zoom-in-btn" style="padding:4px 12px;">+</button>
        <button class="btn-ghost" id="sheet-zoom-reset-btn" style="margin-left:6px;">Reset</button>
        <button class="btn-gold" id="print-sheet-btn-modal" style="margin-left:auto;">Print / Save as PDF</button>
      </div>
      <div class="sheet-preview-viewport">
        <div class="print-sheet-container" id="print-sheet" style="display:flex; flex-direction:column; align-items:center; gap:28px; zoom:${state.sheetZoom}%;">
          ${chunks.map((chunk, idx)=>renderOneSheet(s, d, chunk, idx, idx===activePage)).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

/* ---------------- shared handler wiring ----------------
   Wires up everything common to all three role-specific sheet pages: the settings modal
   (logos, university info, footer), the preview modal (zoom, paging, print). Each role-specific
   file calls this once, then wires its own page's unique fields (event/session pickers etc.)
   on top of it. */
function attachSheetCommonHandlers(){
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
  // title/date/time/venue only affect small text spans repeated across every printed page —
  // patch them directly instead of a full re-render, which is what caused flicker on every keystroke
  [
    ['sh-title','title','ps-fill-title'], ['sh-date','date','ps-fill-date'],
    ['sh-time','time','ps-fill-time'], ['sh-venue','venue','ps-fill-venue']
  ].forEach(([id,field,cls])=>{
    const el = document.getElementById(id);
    if(el) el.oninput = ()=>{
      state.sheetDraft[field] = el.value;
      document.querySelectorAll('.'+cls).forEach(span=>{ span.textContent = el.value; });
    };
  });
  // row count changes the table structure itself, which genuinely needs a re-render
  const sheetRowsEl = document.getElementById('sh-rows');
  if(sheetRowsEl) sheetRowsEl.oninput = ()=>{ state.sheetDraft.rows = sheetRowsEl.value; reRenderPreservingFocus(); };
  const goToSheetPage = (newPage)=>{
    const sheets = document.querySelectorAll('#print-sheet .print-sheet');
    const totalPages = sheets.length;
    const clamped = Math.max(0, Math.min(totalPages-1, newPage));
    state.sheetPreviewPage = clamped;
    sheets.forEach((sheet, idx)=>{ sheet.classList.toggle('ps-preview-hidden', idx !== clamped); });
    const pageLabel = document.getElementById('sheet-page-label');
    if(pageLabel) pageLabel.textContent = `Page ${clamped+1} of ${totalPages}`;
    if(sheetPrevPageBtn) sheetPrevPageBtn.disabled = clamped<=0;
    if(sheetNextPageBtn) sheetNextPageBtn.disabled = clamped>=totalPages-1;
  };
  const sheetPrevPageBtn = document.getElementById('sheet-preview-prev-btn');
  if(sheetPrevPageBtn) sheetPrevPageBtn.onclick = ()=>{ goToSheetPage((state.sheetPreviewPage||0)-1); };
  const sheetNextPageBtn = document.getElementById('sheet-preview-next-btn');
  if(sheetNextPageBtn) sheetNextPageBtn.onclick = ()=>{ goToSheetPage((state.sheetPreviewPage||0)+1); };
  const sheetZoomOutBtn = document.getElementById('sheet-zoom-out-btn');
  if(sheetZoomOutBtn) sheetZoomOutBtn.onclick = ()=>{ state.sheetZoomAuto = false; applySheetZoom(Math.max(30, (state.sheetZoom||70)-10)); };
  const sheetZoomInBtn = document.getElementById('sheet-zoom-in-btn');
  if(sheetZoomInBtn) sheetZoomInBtn.onclick = ()=>{ state.sheetZoomAuto = false; applySheetZoom(Math.min(150, (state.sheetZoom||70)+10)); };
  const sheetZoomResetBtn = document.getElementById('sheet-zoom-reset-btn');
  if(sheetZoomResetBtn) sheetZoomResetBtn.onclick = ()=>{
    state.sheetZoomAuto = true;
    applySheetZoom(computeFitZoom() || 70);
  };
  // while auto-fit is on, keep recalculating against the actual rendered viewport — covers the
  // first visit, window resizes, and switching monitors/resolutions, without ever overriding a
  // manual +/-/ adjustment (which turns auto-fit off until Reset is pressed again)
  if(isOnSheetPage() && state.sheetZoomAuto && state.sheetPreviewModalOpen){
    const fitZoom = computeFitZoom();
    if(fitZoom && fitZoom !== state.sheetZoom) applySheetZoom(fitZoom);
  }
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
    if(state.currentUser.role==='admin'){
      await logAdminAction('Updated attendance sheet header/footer', '');
    }
    state.sheetSettingsModalOpen = false;
    state.err = '';
    render();
  };
  const printSheetBtn = document.getElementById('print-sheet-btn');
  if(printSheetBtn) printSheetBtn.onclick = ()=>{ window.print(); };
  const printSheetBtnModal = document.getElementById('print-sheet-btn-modal');
  if(printSheetBtnModal) printSheetBtnModal.onclick = ()=>{ window.print(); };
  const openSheetPreviewBtn = document.getElementById('open-sheet-preview-btn');
  if(openSheetPreviewBtn) openSheetPreviewBtn.onclick = ()=>{ state.sheetPreviewModalOpen = true; render(); };
  const closeSheetPreviewBtn = document.getElementById('close-sheet-preview-btn');
  if(closeSheetPreviewBtn) closeSheetPreviewBtn.onclick = ()=>{ state.sheetPreviewModalOpen = false; render(); };
  const sheetPreviewModalOverlay = document.getElementById('sheet-preview-modal-overlay');
  if(sheetPreviewModalOverlay) sheetPreviewModalOverlay.onclick = (e)=>{ if(e.target === sheetPreviewModalOverlay){ state.sheetPreviewModalOpen = false; render(); } };
}
