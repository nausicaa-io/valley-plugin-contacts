const CSS = `
/* A group that comes from Preferences is shared with every other plugin — the
   tag says so, because editing that row changes it everywhere. */
.contacts-group-scope {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--surface-color-alt);
  color: var(--text-tertiary);
  font-size: var(--smaller-font-size);
}

/* ---- Left sidebar panel ---------------------------------------------- */
.ct-panel { display:flex; flex-direction:column; height:100%; min-height:0; }
.ct-iconbtn { display:grid; place-items:center; width:26px; height:26px; border:none; border-radius:6px;
  background:none; color:var(--text-secondary); cursor:pointer; -webkit-app-region:no-drag; }
.ct-iconbtn:hover { background:var(--hover-bg); color:var(--text-color); }
.ct-iconbtn svg { width:15px; height:15px; }
.ct-header-actions { display:inline-flex; align-items:center; gap:5px; }
.ct-group-filter-btn { display:flex; align-items:center; justify-content:center; width:auto; min-width:38px; height:26px;
  gap:3px; padding:0 5px; border:none; border-radius:var(--radius-sm); background:transparent;
  color:var(--text-tertiary); font-size:var(--smaller-font-size); font-variant-numeric:tabular-nums;
  cursor:pointer; -webkit-app-region:no-drag; }
.ct-group-filter-btn:hover { background:var(--hover-bg); color:var(--title-color); }
.ct-group-filter-btn.active { background:var(--tree-active-bg); color:var(--accent-color); }
.ct-group-filter-btn svg { width:15px; height:15px; }

.ct-group-filter-popover { width:min(244px, calc(100vw - 16px)); padding:var(--space-1);
  border-color:var(--border-light); border-radius:var(--radius-sm); background:var(--container-color);
  box-shadow:0 10px 28px rgba(0,0,0,.2); }
.ct-group-filter-popover-body { display:flex; flex-direction:column; }
.ct-group-filter-popover-head { display:flex; align-items:center; justify-content:space-between; min-height:28px;
  padding:0 var(--space-2) var(--space-1); border-bottom:1px solid var(--border-light); }
.ct-group-filter-popover-title, .ct-group-filter-popover-all { padding:2px 4px; border:none;
  border-radius:var(--radius-sm); background:transparent; font:inherit; font-size:var(--small-font-size); }
.ct-group-filter-popover-title { color:var(--accent-color); font-weight:var(--font-semi-bold); cursor:pointer; }
.ct-group-filter-popover-all { color:var(--text-tertiary); font-size:var(--smaller-font-size); cursor:pointer; }
.ct-group-filter-popover-title:hover, .ct-group-filter-popover-all:hover { background:var(--hover-bg); color:var(--title-color); }
.ct-group-filter-list { display:flex; flex-direction:column; min-width:148px; max-height:320px;
  padding-top:var(--space-1); overflow-y:auto; }
.ct-group-filter-option { display:flex; align-items:center; gap:7px; width:100%; min-height:28px;
  padding:0 var(--space-2); border:none; border-radius:var(--radius-sm); background:transparent;
  color:var(--text-color); font:inherit; font-size:var(--small-font-size); text-align:left; cursor:pointer; }
.ct-group-filter-option:hover { background:var(--hover-bg); color:var(--text-color); }
.ct-group-filter-option.active { border-radius:0; background:var(--hover-bg); color:var(--title-color); }
.ct-group-filter-option.active.selection-run-start { border-top-left-radius:var(--radius-sm); border-top-right-radius:var(--radius-sm); }
.ct-group-filter-option.active.selection-run-end { border-bottom-right-radius:var(--radius-sm); border-bottom-left-radius:var(--radius-sm); }
.ct-group-filter-option.active:hover { background:color-mix(in srgb, var(--title-color) 14%, transparent); }
.ct-group-filter-option.active:has(+ .ct-group-filter-option:hover),
.ct-group-filter-option:hover:has(+ .ct-group-filter-option.active) { border-bottom-right-radius:0; border-bottom-left-radius:0; }
.ct-group-filter-option.active + .ct-group-filter-option:hover,
.ct-group-filter-option:hover + .ct-group-filter-option.active { border-top-left-radius:0; border-top-right-radius:0; }
.ct-group-filter-check { display:grid; place-items:center; width:14px; height:14px; flex:0 0 14px;
  color:var(--accent-color); font-size:.75rem; font-weight:var(--font-semi-bold); }
.ct-group-filter-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
.ct-group-filter-dot.no-group { background:var(--text-tertiary); }
.ct-group-filter-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ct-group-filter-count { margin-left:auto; color:var(--text-tertiary); font-size:var(--smaller-font-size);
  font-variant-numeric:tabular-nums; }
.ct-group-filter-empty { padding:6px 8px; color:var(--text-tertiary); font-size:var(--small-font-size); }


.ct-list { flex:1; display:flex; flex-direction:column; gap:3px; padding:0 5px 14px; overflow-y:auto; min-height:0; }
.ct-list-sep { padding:8px 10px 4px; font-size:0.65625rem; font-weight:650; text-transform:uppercase;
  letter-spacing:.04em; color:var(--text-tertiary); }
.ct-row { display:flex; align-items:center; gap:9px; width:100%; padding:5px; border:none; background:none;
  border-radius:6px; cursor:pointer; text-align:left; }
.ct-row:hover { background:var(--hover-bg); }
.ct-row:hover .ct-row-name { color:var(--text-color); }
.ct-row.active { background:var(--accent-tint-bg); }
.ct-row.active .ct-row-name { color:var(--accent-color); }
.ct-avatar { position:relative; overflow:hidden; width:28px; height:28px; border-radius:50%; flex-shrink:0;
  display:grid; place-items:center; background:#8f969f; color:#fff; font-size:0.6875rem; font-weight:650; text-transform:uppercase; }
.ct-avatar-img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; border-radius:inherit; }
.ct-row-meta { flex:1; min-width:0; display:flex; flex-direction:column; }
.ct-row-name { font-size:0.8125rem; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ct-row-sub { font-size:0.6875rem; color:var(--text-tertiary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ct-empty { padding:16px 14px; color:var(--text-secondary); font-size:0.75rem; line-height:1.5; }
.ct-empty.compact { padding:6px 10px; font-size:0.71875rem; }

/* ---- Main workspace page --------------------------------------------- */
.ct-page { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--surface-color-alt); }
.ct-page-head { position:relative; display:flex; align-items:center; gap:8px; flex:0 0 auto;
  height:var(--app-bar-height); box-sizing:border-box; padding:0 calc(var(--plugin-actions-offset, 0px) + 10px) 0 calc(var(--plugin-navigation-offset, 0px) + 10px); border-bottom:1px solid var(--border-light);
  background:var(--surface-color-alt); }
.ct-page-nav-btn { display:grid; place-items:center; width:26px; height:26px; padding:0; border:none;
  border-radius:6px; background:transparent; color:var(--text-secondary); cursor:pointer; }
.ct-page-nav-btn:hover:not(:disabled) { background:var(--hover-bg); color:var(--text-color); }
.ct-page-nav-btn svg { width:15px; height:15px; }
.ct-page-title { margin:0; font-size:0.875rem; font-weight:650; color:var(--title-color, var(--text-color));
  position:absolute; left:50%; transform:translateX(-50%); max-width:max(0px, calc(100% - 300px));
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; text-align:center; }
.ct-page-actions { display:flex; align-items:center; gap:8px; flex:0 1 auto; min-width:0; margin-left:auto; z-index:1; }
.ct-page-actions .ct-btn { min-width:0; padding:5px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ct-tab { padding:5px 12px; border:none; border-radius:6px; background:none; color:var(--text-secondary);
  font-size:0.78125rem; font-weight:600; cursor:pointer; }
.ct-tab:hover { background:var(--hover-bg); color:var(--text-color); }
.ct-tab.active { background:var(--accent-tint-bg); color:var(--accent-color); }
.ct-btn { display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border-radius:6px;
  border:1px solid var(--border-medium, rgba(128,128,128,.3)); background:none; color:var(--text-secondary);
  font-size:0.75rem; font-weight:600; cursor:pointer; }
.ct-btn:hover { background:var(--hover-bg); color:var(--text-color); }
.ct-btn.primary { background:var(--accent-color); color:#fff; border-color:transparent; }
.ct-btn.primary:hover { filter:brightness(1.08); background:var(--accent-color); color:#fff; }
.ct-btn.danger { color:var(--tint-red-text, #b91c1c); border-color:var(--tint-red-text, #b91c1c); }
.ct-btn svg { width:14px; height:14px; }
.ct-page-body { flex:1; min-height:0; overflow-y:auto; }

/* ---- Detail view ------------------------------------------------------ */
.ct-detail { max-width:720px; margin:0 auto; padding:28px 30px 54px; }
.ct-detail-head { display:flex; align-items:center; gap:18px; margin-bottom:14px; }
.ct-detail-avatar { position:relative; overflow:hidden; width:70px; height:70px; border-radius:50%; flex-shrink:0;
  display:grid; place-items:center; background:#8f969f; color:#fff; font-size:1.5rem; font-weight:650; text-transform:uppercase; }
.ct-detail-names { flex:1; min-width:0; }
.ct-detail-name { font-size:1.4375rem; font-weight:700; color:var(--text-color); margin:0; overflow-wrap:anywhere; }
.ct-detail-sub { font-size:0.8125rem; color:var(--text-secondary); margin:2px 0 0; }

.ct-chips { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:24px; min-height:26px; }
.ct-chips.saving { opacity:.82; }
.ct-chip { display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border:1px solid transparent;
  border-radius:999px; background:var(--accent-tint-bg); color:var(--accent-tint-text, var(--accent-color)); font-size:0.71875rem;
  font-weight:600; text-transform:capitalize; }
.ct-chip button { display:grid; place-items:center; border:none; background:none; color:inherit; cursor:pointer;
  padding:0; opacity:.6; }
.ct-chip button:hover { opacity:1; }
.ct-chip button svg { width:11px; height:11px; }
.ct-chip-add { display:inline-flex; align-items:center; gap:4px; padding:3px 9px; border-radius:999px;
  border:1px dashed var(--border-medium, rgba(128,128,128,.4)); background:none; color:var(--text-secondary);
  font-size:0.71875rem; font-weight:600; cursor:pointer; }
.ct-chip-add:hover { color:var(--text-color); border-color:var(--text-secondary); }
.ct-chip-picker { position:relative; display:inline-flex; align-items:center; z-index:3; }
.ct-chip-input { height:24px; padding:2px 10px; border-radius:999px; border:1px solid var(--accent-color);
  background:var(--surface-color-alt); color:var(--text-color); font-size:0.71875rem; outline:none; width:150px;
  box-shadow:0 0 0 2px color-mix(in srgb, var(--accent-color) 13%, transparent); }
.ct-chip-popover { position:absolute; left:0; top:calc(100% + 6px); min-width:210px; max-width:min(280px, 70vw);
  display:flex; flex-direction:column; gap:2px; padding:5px; border-radius:8px;
  border:1px solid var(--border-light); background:var(--surface-color-alt);
  box-shadow:0 12px 30px rgba(0,0,0,.16); color:var(--text-color); }
.ct-chip-option { display:flex; align-items:center; gap:8px; width:100%; min-height:28px; padding:5px 8px;
  border:none; border-radius:6px; background:none; color:var(--text-secondary); font-size:0.75rem; text-align:left;
  cursor:pointer; }
.ct-chip-option:hover, .ct-chip-option.active { background:var(--accent-tint-bg); color:var(--accent-color); }
.ct-chip-option-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
.ct-chip-option-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ct-chip-option.create svg { width:13px; height:13px; flex:0 0 auto; }
.ct-chip-empty { padding:8px 9px; color:var(--text-tertiary); font-size:0.75rem; }

.ct-section { margin-bottom:24px; }
.ct-section-title { font-size:0.6875rem; font-weight:650; text-transform:uppercase; letter-spacing:.04em;
  color:var(--text-tertiary); margin-bottom:8px; }
.ct-field { display:flex; align-items:flex-start; gap:12px; padding:7px 0; }
.ct-field-icon { width:20px; flex-shrink:0; display:grid; place-items:center; color:var(--text-tertiary); margin-top:1px; }
.ct-field-icon svg { width:15px; height:15px; }
.ct-field-body { flex:1; min-width:0; }
.ct-field-value { font-size:0.84375rem; color:var(--text-color); overflow-wrap:anywhere; }
.ct-field-value a, .ct-field-link { color:var(--accent-color); text-decoration:none; }
.ct-field-value a:hover, .ct-field-link:hover { text-decoration:underline; }
.ct-field-link { display:inline; padding:0; border:none; background:none; font:inherit; text-align:left;
  cursor:pointer; }
.ct-field-link:focus-visible { outline:2px solid color-mix(in srgb, var(--accent-color) 45%, transparent);
  outline-offset:2px; border-radius:3px; }
.ct-field-label { font-size:0.6875rem; color:var(--text-tertiary); text-transform:capitalize; margin-top:1px; }

.ct-rel { display:flex; align-items:center; gap:9px; padding:6px 0; }
.ct-rel-dot { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
.ct-rel-name { font-size:0.84375rem; color:var(--accent-color); cursor:pointer; }
.ct-rel-name:hover { text-decoration:underline; }
.ct-rel-name.dead { color:var(--text-color); cursor:default; }
.ct-rel-name.dead:hover { text-decoration:none; }
.ct-rel-badge { font-size:0.6875rem; padding:1px 7px; border-radius:999px; color:#fff; text-transform:capitalize; }
.ct-rel-role { font-size:0.75rem; color:var(--text-tertiary); }

/* ---- Form ------------------------------------------------------------- */
.ct-form { max-width:680px; margin:0 auto; padding:22px 26px 48px; display:flex; flex-direction:column; gap:18px; }
.ct-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.ct-form-field { display:flex; flex-direction:column; gap:4px; }
.ct-form-field.full { grid-column:1 / -1; }
.ct-form-field label { font-size:0.6875rem; font-weight:600; text-transform:uppercase; letter-spacing:.03em;
  color:var(--text-tertiary); }
.ct-input, .ct-select { width:100%; padding:7px 10px; border-radius:6px;
  border:1px solid var(--border-medium, rgba(128,128,128,.3)); background:var(--container-color-alt);
  color:var(--text-color); font-size:0.8125rem; outline:none; }
.ct-input:focus, .ct-select:focus { border-color:var(--accent-color); }
.ct-file-name { display:flex; align-items:center; gap:7px; }
.ct-file-name .ct-input { flex:1; }
.ct-file-ext { flex-shrink:0; font-size:0.75rem; color:var(--text-tertiary); }
.ct-group-editor { display:flex; flex-direction:column; gap:7px; }
.ct-group-pills { display:flex; flex-wrap:wrap; gap:6px; min-height:24px; }
.ct-group-pill { display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border:1px solid transparent;
  border-radius:999px; font-size:0.71875rem; font-weight:600; text-transform:capitalize; cursor:grab; user-select:none; }
.ct-group-pill:active { cursor:grabbing; }
.ct-group-pill button { display:grid; place-items:center; border:none; background:none; color:inherit; cursor:pointer; padding:0; opacity:.65; }
.ct-group-pill button:hover { opacity:1; }
.ct-group-pill button svg { width:11px; height:11px; }
.ct-group-add { display:flex; gap:7px; align-items:center; }
.ct-group-add .ct-input { flex:1; }
.ct-group-add .ct-rep-add { flex-shrink:0; }
.ct-rep { display:flex; flex-direction:column; gap:7px; }
.ct-rep-row { display:flex; gap:7px; align-items:center; }
.ct-rep-row .ct-input { flex:1; }
.ct-rep-row .ct-select { flex:0 0 130px; }
/* The relation-type picker is the shared SelectField; it owns its own frame, so
   only the row footprint is set here. */
.ct-select.select-field { width:100%; min-height:32px; }
.ct-rep-del { display:grid; place-items:center; width:30px; height:30px; border:none; border-radius:6px;
  background:none; color:var(--text-tertiary); cursor:pointer; flex-shrink:0; }
.ct-rep-del:hover { background:var(--hover-bg); color:var(--tint-red-text, #b91c1c); }
.ct-rep-del svg { width:14px; height:14px; }
.ct-rep-add { align-self:flex-start; display:inline-flex; align-items:center; gap:5px; padding:4px 9px;
  border:1px dashed var(--border-medium, rgba(128,128,128,.4)); border-radius:6px; background:none;
  color:var(--text-secondary); font-size:0.75rem; cursor:pointer; }
.ct-rep-add:hover { color:var(--text-color); border-color:var(--text-secondary); }
.ct-rep-add svg { width:13px; height:13px; }
.ct-form-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:4px; }
.ct-form-delete { margin-right:auto; }
.ct-delete-confirm { display:flex; align-items:center; gap:8px; margin-right:auto; }
.ct-form-section-title { font-size:0.6875rem; font-weight:650; text-transform:uppercase; letter-spacing:.04em;
  color:var(--text-tertiary); margin-bottom:-4px; }
.ct-rep-row .ct-rep-type { flex:0 0 130px; }
.ct-form-status { min-height:1em; font-size:0.6875rem; color:var(--text-tertiary); }
.ct-form-error { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:0; font-size:0.75rem;
  color:var(--tint-red-text, #b91c1c); }
/* The Properties sidebar: one column, rows wrap instead of overflowing. */
.ct-form-compact { max-width:none; margin:0; padding:8px 12px 24px; gap:14px; }
.ct-form-compact .ct-form-grid { grid-template-columns:minmax(0,1fr); gap:10px; }
.ct-form-compact .ct-rep-row, .ct-form-compact .ct-group-add { flex-wrap:wrap; }
.ct-form-compact .ct-rep-row > * { min-width:0; }
.ct-form-compact .ct-rep-row .ct-input { flex:1 1 120px; }
.ct-form-compact .ct-rep-row .ct-rep-type { flex:0 1 96px; }
.ct-form-compact .ct-rep-row .ct-select { flex:1 1 110px; }
.ct-file-page { height:100%; overflow:auto; }
.ct-social-icon { display:grid; place-items:center; width:26px; height:30px; flex-shrink:0;
  color:var(--text-secondary); }
.ct-platform-icon { display:inline-flex; align-items:center; justify-content:center; width:1em; height:1em; }
.ct-platform-icon svg { width:100%; height:100%; }
.ct-social-icon-button { padding:0; border:0; background:transparent; cursor:pointer; border-radius:var(--radius); }
.ct-social-icon-button:hover { background:var(--hover-bg); }
.ct-social-icon-button:focus-visible { outline:2px solid var(--accent-color); outline-offset:2px; }
.ct-social-icon svg { width:16px; height:16px; }
.ct-social-row .ct-social-icon { width:20px; height:20px; }
.ct-social-row .ct-social-label { flex:0 0 130px; }
.ct-social-settings { --ct-social-row-gap:var(--space-3); display:flex; flex-direction:column; gap:var(--ct-social-row-gap); }
.ct-social-setting-row, .ct-social-setting-head { display:grid;
  grid-template-columns:22px 20px minmax(0,.45fr) minmax(0,1fr) 28px; align-items:center; gap:var(--space-2);
  padding:var(--space-2); border:1px solid transparent; }
.ct-social-setting-head { padding-block:0; color:var(--text-tertiary); font-size:var(--smaller-font-size); }
.ct-social-setting-row { position:relative; border-color:var(--border-light); border-radius:var(--radius); background:var(--container-color); }
.ct-social-setting-row .ct-social-icon { align-self:center; width:20px; height:20px; color:var(--text-secondary); }
.ct-social-setting-field { display:grid; gap:4px; min-width:0; color:var(--text-tertiary); font-size:var(--smaller-font-size); }
.ct-social-setting-field .settings-control { width:100%; min-width:0; }
/* The add row ends in a labelled button, not the 28px remove glyph the rows
   above end in — give that last column its own width or the button is crushed
   to a clipped black chip. */
.ct-social-setting-add { background:var(--hover-bg);
  grid-template-columns:22px 20px minmax(0,.45fr) minmax(0,1fr) auto; }

/* ---- Social platforms: reorder + icon picker ------------------------- */
/* The grip is the kit's own .settings-reorder-handle; this only places it. */
.ct-social-grip { align-self:center; width:20px; height:24px; margin-left:0; font-size:16px;
  color:var(--text-tertiary); cursor:grab; }
.ct-social-grip:active { cursor:grabbing; }
.ct-social-grip svg { width:16px; height:16px; }
.ct-social-settings-grip { display:inline-flex; align-items:center; justify-content:center;
  width:22px; height:22px; min-height:22px; padding:0; border:0; background:transparent; }
.ct-social-settings-grip svg { width:14px; height:14px; }
.ct-social-drag-ghost { position:fixed; top:-9999px; left:-9999px; pointer-events:none;
  background:transparent; box-shadow:none; outline:none; }
.ct-social-edit-row { position:relative; }
/* Drag-to-reorder seam — the app's shared --drop-* spec, restated under our
   own prefix (a plugin never renders another module's class). */
.ct-social-setting-row.drop-before::before,
.ct-social-setting-row.drop-after::before,
.ct-social-edit-row.drop-before::before,
.ct-social-edit-row.drop-after::before {
  content:''; position:absolute; left:0; right:0; height:var(--drop-knob);
  margin-top:var(--drop-indicator-inset); margin-bottom:var(--drop-indicator-inset);
  background:var(--drop-indicator-fill); pointer-events:none; }
.ct-social-setting-row.drop-before::before { top:calc((var(--ct-social-row-gap) + var(--drop-line)) / -2 - 1px); }
.ct-social-setting-row.drop-after::before { bottom:calc((var(--ct-social-row-gap) + var(--drop-line)) / -2 - 1px); }
.ct-social-edit-row.drop-before::before { top:0; }
.ct-social-edit-row.drop-after::before { bottom:0; }

.ct-social-pick { display:grid; place-items:center; flex:0 0 30px; width:30px; height:30px; padding:0;
  border:1px solid var(--border-light); border-radius:6px; background:var(--control-bg);
  color:var(--text-secondary); cursor:pointer; transition:color .12s ease, border-color .12s ease; }
.ct-social-pick:hover { color:var(--text-color); border-color:var(--text-secondary); }
.ct-social-pick.empty { border-style:dashed; color:var(--text-tertiary); }
.ct-social-pick svg { width:17px; height:17px; }
.ct-social-picker-body { display:grid; gap:8px; width:264px; }
.ct-social-picker-search { width:100%; }
.ct-social-picker-grid { display:grid; grid-template-columns:repeat(6, 1fr); gap:4px;
  max-height:212px; overflow-y:auto; }
.ct-social-picker-tile { display:grid; place-items:center; width:100%; aspect-ratio:1; padding:0;
  border:1px solid transparent; border-radius:6px; background:none; color:var(--text-secondary); cursor:pointer; }
.ct-social-picker-tile:hover { background:var(--hover-bg); color:var(--text-color); }
.ct-social-picker-tile.selected { border-color:var(--accent-color); color:var(--text-color); }
.ct-social-picker-tile svg { width:17px; height:17px; }
.ct-social-picker-custom { padding:6px 8px; border:1px dashed var(--border-medium); border-radius:6px;
  background:none; color:var(--text-secondary); font-size:0.75rem; text-align:left; cursor:pointer; }
.ct-social-picker-custom:hover { color:var(--text-color); border-color:var(--text-secondary); }

/* ---- Settings: group remove (X -> confirm trash) --------------------- */
.ct-group-remove { display:grid; place-items:center; width:24px; height:24px; flex-shrink:0; padding:0;
  border:none; border-radius:6px; background:none; color:var(--text-tertiary); cursor:pointer;
  transition:color .12s ease, background .12s ease; }
.ct-group-remove:hover { background:var(--hover-bg); color:var(--text-secondary); }
.ct-group-remove svg { width:15px; height:15px; }
.ct-group-remove.confirm { color:var(--tint-red-text, #dc2626);
  background:color-mix(in srgb, var(--tint-red-text, #dc2626) 14%, transparent); }
.ct-group-remove.confirm:hover { background:color-mix(in srgb, var(--tint-red-text, #dc2626) 22%, transparent);
  color:var(--tint-red-text, #dc2626); }
.ct-group-remove.confirm svg { width:16px; height:16px; }

.ct-notes-editor { min-width:0; }
.ct-notes-read { font-family:var(--body-font); font-size:0.8125rem; line-height:1.55; color:var(--text-color); overflow-wrap:anywhere; }
.ct-notes-read.markdown-body > :first-child { margin-top:0; }
.ct-notes-read.markdown-body > :last-child { margin-bottom:0; }
.ct-notes-empty { font-size:0.78125rem; color:var(--text-tertiary); }

/* ---- Graph ------------------------------------------------------------ */
.ct-graph { position:relative; width:100%; height:100%; }
.ct-graph canvas { display:block; width:100%; height:100%; }
.ct-graph-legend { position:absolute; left:14px; bottom:14px; display:flex; flex-wrap:wrap; gap:5px;
  max-width:60%; padding:8px 10px; border-radius:8px; background:var(--container-color-alt);
  border:1px solid var(--border-light); box-shadow:0 4px 16px rgba(0,0,0,.12); }
.ct-legend-item { display:inline-flex; align-items:center; gap:5px; padding:2px 7px; border-radius:999px;
  font-size:0.6875rem; cursor:pointer; color:var(--text-secondary); user-select:none; }
.ct-legend-item.off { opacity:.4; }
.ct-legend-dot { width:9px; height:9px; border-radius:50%; }
.ct-graph-modes { position:absolute; right:14px; top:14px; display:flex; gap:4px; padding:4px;
  border-radius:8px; background:var(--container-color-alt); border:1px solid var(--border-light); }
`

const STYLE_ID = 'notes-contacts-styles'

/** Inject (or refresh, on hot reload) the plugin stylesheet. */
export function injectStyles(): () => void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = CSS
  return () => {
    if (document.getElementById(STYLE_ID) === el) el.remove()
  }
}
