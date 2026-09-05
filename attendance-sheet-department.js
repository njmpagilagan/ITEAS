/* ====================================================================
   ATTENDANCE SHEET — DEPARTMENT OFFICER
   Requires attendance-sheet-shared.js to be loaded first.
   Only available to officers with no section set (i.e. Department-type
   officers, not Section-type). Section officers don't get this tab — see
   the nav-items list in app.js.
   Only includes students who checked in through THIS officer's own
   department desk for the selected event, not everyone who attended via
   any desk (that fuller picture is Admin's sheet, not this one).
   ==================================================================== */

function renderDeptOfficerSheet(){
  const u = state.currentUser;
  const s = state.sheetSettingsDraft || DEFAULT_SHEET_SETTINGS;
  const d = state.sheetDraft;
  // same event-visibility rule officers already use for Generate QR / Attendees
  const myEvents = DB.events.filter(e=>e.departments.includes(u.department));
  const eventId = d.eventId || 'none';
  const selectedEvent = eventId!=='none' ? myEvents.find(e=>e.id===eventId) : null;
  const isWholeDay = selectedEvent && (selectedEvent.sessionType||'full')==='full';
  const session = isWholeDay ? (d.session || 'am') : null;
  const attendees = getEventAttendees(eventId, session, null, u.department);
  const chunks = (attendees && attendees.length>0) ? chunkArray(attendees, 30) : [null];
  const activePage = Math.max(0, Math.min(chunks.length-1, state.sheetPreviewPage||0));
  return `
  <div class="page-head-row">
    <div class="page-head" style="margin-bottom:0;"><h1>Attendance Sheet</h1><p>A printable attendance sheet for <strong>${u.department}</strong> — includes every student from your department who attended, regardless of which desk (section or department) checked them in.</p></div>
    <button class="btn-ghost" id="open-sheet-settings-btn">Header &amp; footer settings</button>
  </div>

  <div class="card" style="max-width:640px; margin-bottom:14px;">
    <div class="field">
      <label>Event (optional — fills in real attendee names)</label>
      <select id="sh-event">
        <option value="none" ${eventId==='none'?'selected':''}>None — blank sheet</option>
        ${myEvents.map(e=>`<option value="${e.id}" ${eventId===e.id?'selected':''}>${e.name}</option>`).join('')}
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
    ${attendees ? `<p class="hint">${attendees.length} student${attendees.length===1?'':'s'} from ${u.department} checked in${isWholeDay ? ` for the ${session==='am'?'morning':'afternoon'} session` : ''} — split across <strong>${chunks.length}</strong> sheet${chunks.length===1?'':'s'} (30 per page, same header/footer repeated on each).</p>` : ''}
    <div class="field"><label>Nature/Title of Meeting/Activity/Seminar</label><input id="sh-title" value="${d.title}"></div>
    ${!attendees ? `<div class="field"><label>Rows</label><input id="sh-rows" type="number" min="1" max="60" value="${Math.max(1, Math.min(60, parseInt(d.rows,10) || 30))}"></div>` : ''}
    <div class="field"><label>Date</label><input id="sh-date" value="${d.date}"></div>
    <div class="field"><label>Time</label><input id="sh-time" value="${d.time}"></div>
    <div class="field"><label>Venue</label><input id="sh-venue" value="${d.venue}"></div>
    <button class="btn-ghost" style="width:100%; margin-bottom:8px;" id="open-sheet-preview-btn">Preview</button>
    <button class="btn-gold" style="width:100%;" id="print-sheet-btn">Print / Save as PDF</button>
    <p class="hint">Opens your browser's print dialog — choose "Save as PDF" there if you want a digital copy instead of printing. Each sheet prints on its own page.</p>
  </div>

  ${state.sheetPreviewModalOpen ? renderSheetPreviewModal(s, d, chunks, activePage) : ''}
  ${state.sheetSettingsModalOpen ? renderSheetSettingsModal() : ''}
  `;
}

function attachDeptOfficerSheetHandlers(){
  const u = state.currentUser;
  const myEvents = DB.events.filter(e=>e.departments.includes(u.department));
  const sheetEventSelect = document.getElementById('sh-event');
  if(sheetEventSelect) sheetEventSelect.onchange = async ()=>{
    const eventId = sheetEventSelect.value;
    state.sheetDraft.eventId = eventId;
    state.sheetPreviewPage = 0;
    if(eventId !== 'none'){
      DB.attendance = await fetchKey('attendance', DB.attendance);
      const ev = myEvents.find(e=>e.id===eventId);
      if(ev){
        state.sheetDraft.title = ev.name || '';
        state.sheetDraft.date = ev.date ? formatDateLong(ev.date) : '';
        state.sheetDraft.venue = ev.venue || '';
        const isWholeDay = (ev.sessionType||'full')==='full';
        state.sheetDraft.session = isWholeDay ? 'am' : null;
        const relevantTime = ev.sessionType==='pm' ? ev.pmTime : (isWholeDay ? ev.amTime : ev.amTime);
        state.sheetDraft.time = relevantTime || '';
      }
    } else {
      state.sheetDraft.title = '';
      state.sheetDraft.date = '';
      state.sheetDraft.venue = '';
      state.sheetDraft.time = '';
      state.sheetDraft.session = null;
    }
    render();
  };
  const sheetSessionSelect = document.getElementById('sh-session');
  if(sheetSessionSelect) sheetSessionSelect.onchange = ()=>{
    state.sheetDraft.session = sheetSessionSelect.value;
    state.sheetPreviewPage = 0;
    const ev = myEvents.find(e=>e.id===state.sheetDraft.eventId);
    if(ev){
      const relevantTime = state.sheetDraft.session==='pm' ? ev.pmTime : ev.amTime;
      state.sheetDraft.time = relevantTime || '';
    }
    render();
  };
  attachSheetCommonHandlers();
}
