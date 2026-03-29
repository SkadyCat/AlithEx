/* ===================== Canvas Editor App ===================== */

const GRID_SIZE = 20;
const SNAP_SIZE = 10;

// Dynamic canvas size — read from actual DOM dimensions
function canvasW() { return canvasRoot.offsetWidth  || 1200; }
function canvasH() { return canvasRoot.offsetHeight || 800; }

let boxes        = [];
let selectedId   = null;
let nextId       = 1;
let mode         = 'select';   // 'select' | 'draw'
let zoom         = 1.0;
let panX         = 0;
let panY         = 0;
let gridVisible  = true;
let snapEnabled  = true;
let currentWidgetType = 'CanvasPanel'; // default: CanvasPanel

let undoStack    = [];
let redoStack    = [];

let _rafRenderPending = false; // rAF debounce flag for renderAll()

let _globalLoadTree = null; // set by sidebar init, used by context menu

/* ───── Widget Type Definitions (loaded from /api/elements) ───── */
let WIDGET_CONTROLS = [];
let WIDGET_CONTAINERS = [];
let ALL_WIDGET_TYPES = [];

/* ───── Widget Theme (loaded from /api/theme, never stored in session) ───── */
let widgetTheme = { types: {} };

async function loadTheme(name = 'default') {
  try {
    const res = await fetch(`/api/theme?name=${encodeURIComponent(name)}`);
    const data = await res.json();
    if (data.success && data.theme) {
      widgetTheme = data.theme;
      renderAll();
    }
  } catch (_) {}
}

/** Apply theme overlay div to a box element — purely visual, never written to session JSON */
function applyThemeOverlay(el, box) {
  let ov = el.querySelector('.theme-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'theme-overlay';
    ov.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:0;overflow:hidden;border-radius:inherit;';
    el.insertBefore(ov, el.firstChild);
  }
  // In preview mode, invisible containers go transparent — hide overlay so the effect is visible
  const isInvisibleCtx = INVISIBLE_CONTAINER_TYPES && INVISIBLE_CONTAINER_TYPES.has(box.widgetType);
  const hideForPreview = _previewMode && isInvisibleCtx && box.id !== selectedId;
  if (hideForPreview) {
    ov.style.display = 'none';
  } else {
    ov.style.display = '';
    const t = (widgetTheme.types || {})[box.widgetType] || {};
    // Combine pattern + overlay as layered backgrounds
    const bgParts = [t.pattern, t.overlay].filter(Boolean);
    ov.style.background = bgParts.join(',');
    ov.style.boxShadow = t.innerShadow || '';
    ov.style.opacity = t.opacity != null ? String(t.opacity) : '1';
  }
  // wtype CSS class for CSS-override hooks
  Array.from(el.classList).forEach(c => { if (c.startsWith('wtype-')) el.classList.remove(c); });
  if (box.widgetType) el.classList.add('wtype-' + box.widgetType.toLowerCase().replace(/\s+/g, '-'));
}

/* Group mapping: type → category name */
const WIDGET_GROUPS = {
  TextBlock: '文本', RichTextBlock: '文本',
  EditableText: '文本', MultiLineEditableText: '文本',
  EditableTextBox: '文本', MultiLineEditableTextBox: '文本',
  Button: '输入', CheckBox: '输入', Slider: '输入',
  SpinBox: '输入', ComboBoxString: '输入', InputKeySelector: '输入',
  Image: '图像', ProgressBar: '图像', Throbber: '图像', CircularThrobber: '图像',
  ListView: '列表', TileView: '列表', TreeView: '列表',
  CanvasPanel: '容器', HorizontalBox: '容器', VerticalBox: '容器',
  GridPanel: '容器', UniformGridPanel: '容器', WrapBox: '容器',
  Overlay: '容器', Border: '容器', SizeBox: '容器', ScaleBox: '容器',
  ScrollBox: '容器', WidgetSwitcher: '容器', SafeZone: '容器',
  InvalidationBox: '容器', RetainerBox: '容器', NamedSlot: '容器',
  BackgroundBlur: '特殊', NativeWidgetHost: '特殊', MenuAnchor: '特殊',
  ExpandableArea: '特殊', WebBrowser: '特殊', Spacer: '特殊',
};
function getWidgetDef(type) { return ALL_WIDGET_TYPES.find(w => w.type === type) || null; }
// Parse box ID from string: keeps string IDs (e.g. "titleBar") as-is, numeric strings become numbers
function parseBoxId(s) { const n = Number(s); return Number.isFinite(n) && String(n) === s ? n : s; }

// Global toast — usable from any scope (the closure-internal showToast is not globally accessible)
function showToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:#1e2028;color:#e8eaf0;padding:8px 18px;border-radius:8px;font-size:13px;z-index:9999;border:1px solid rgba(255,255,255,0.12);box-shadow:0 4px 16px rgba(0,0,0,0.4);pointer-events:none;transition:opacity 0.4s;white-space:nowrap';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2200);
}

// Frontend clipboard copy with execCommand fallback (works on HTTP)
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch(e) {}
  document.body.removeChild(ta);
  return Promise.resolve();
}

async function loadElements() {
  try {
    const res = await fetch('/api/elements');
    const data = await res.json();
    if (data.success) {
      WIDGET_CONTROLS   = data.controls   || [];
      WIDGET_CONTAINERS = data.containers || [];
      ALL_WIDGET_TYPES  = [...WIDGET_CONTROLS, ...WIDGET_CONTAINERS];
    }
  } catch (_) {}
  // Rebuild palette after load
  buildPalette('palette-items',      WIDGET_CONTROLS);
  buildPalette('palette-containers', WIDGET_CONTAINERS);
}

/* ───── DOM Refs ───── */
const canvasRoot       = document.getElementById('canvas-root');
const canvasViewport   = document.getElementById('canvas-viewport');
const boxLayer         = document.getElementById('box-layer');
const selOverlay       = document.getElementById('selection-overlay');
const gridCanvas       = document.getElementById('grid-canvas');
const propPanel        = document.getElementById('prop-panel');
const layerList        = document.getElementById('layer-list');
const hierarchyList    = document.getElementById('hierarchy-list');
const consoleOutput    = document.getElementById('console-output');

const btnSelect  = document.getElementById('btn-select');
const btnDraw    = document.getElementById('btn-draw');
const btnDelete  = document.getElementById('btn-delete');
const btnClear   = document.getElementById('btn-clear');
const btnUndo    = document.getElementById('btn-undo');
const btnRedo    = document.getElementById('btn-redo');
const btnZoomIn  = document.getElementById('btn-zoom-in');
const btnZoomOut = document.getElementById('btn-zoom-out');
const btnZoomReset = document.getElementById('btn-zoom-reset');
const zoomLabel  = document.getElementById('zoom-label');

/* ───── Right Panel Tabs ───── */
(function () {
  const tabs = document.querySelectorAll('.right-tab');
  const panels = { props: document.getElementById('right-panel-props'), hierarchy: document.getElementById('right-panel-hierarchy') };
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      Object.entries(panels).forEach(([key, el]) => { if (el) el.style.display = key === tab.dataset.tab ? 'flex' : 'none'; });
    });
  });
})();
const toggleGrid = document.getElementById('toggle-grid');
const toggleSnap = document.getElementById('toggle-snap');
// Labels are always hidden on canvas; shown in right panel when selected

/* ───── Logging ───── */
function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-${type}`;
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  div.textContent = `[${ts}] ${msg}`;
  consoleOutput.appendChild(div);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}
document.getElementById('btn-clear-console').onclick = () => consoleOutput.innerHTML = '';

/* ───── Panel Layout Resizers ───── */
(function initLayoutResizers() {
  const root = document.documentElement;

  // Load saved layout from localStorage
  try {
    const saved = JSON.parse(localStorage.getItem('canvas-layout') || '{}');
    if (saved.leftW)    root.style.setProperty('--left-w',    saved.leftW    + 'px');
    if (saved.rightW)   root.style.setProperty('--right-w',   saved.rightW   + 'px');
    if (saved.consoleH) root.style.setProperty('--console-h', saved.consoleH + 'px');
  } catch (_) {}

  function saveLayout() {
    try {
      const cs = getComputedStyle(root);
      localStorage.setItem('canvas-layout', JSON.stringify({
        leftW:    parseInt(cs.getPropertyValue('--left-w')),
        rightW:   parseInt(cs.getPropertyValue('--right-w')),
        consoleH: parseInt(cs.getPropertyValue('--console-h')),
      }));
    } catch (_) {}
  }

  // Vertical resizer (left/right panels)
  function makeVResizer(id, cssVar, direction, min, max) {
    const el = document.getElementById(id);
    if (!el) return;
    let active = false, startX = 0, startVal = 0;
    el.addEventListener('mousedown', e => {
      active = true;
      startX = e.clientX;
      startVal = parseInt(getComputedStyle(root).getPropertyValue(cssVar)) || 0;
      el.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!active) return;
      const delta = (e.clientX - startX) * direction;
      root.style.setProperty(cssVar, Math.max(min, Math.min(max, startVal + delta)) + 'px');
    });
    document.addEventListener('mouseup', () => {
      if (!active) return;
      active = false;
      el.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveLayout();
    });
  }

  // Horizontal resizer (console panel — drag upward to enlarge)
  function makeHResizer(id, cssVar, min, max) {
    const el = document.getElementById(id);
    if (!el) return;
    let active = false, startY = 0, startVal = 0;
    el.addEventListener('mousedown', e => {
      active = true;
      startY = e.clientY;
      startVal = parseInt(getComputedStyle(root).getPropertyValue(cssVar)) || 0;
      el.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!active) return;
      const delta = startY - e.clientY; // drag up = increase height
      root.style.setProperty(cssVar, Math.max(min, Math.min(max, startVal + delta)) + 'px');
    });
    document.addEventListener('mouseup', () => {
      if (!active) return;
      active = false;
      el.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveLayout();
    });
  }

  makeVResizer('resizer-left',    '--left-w',    1, 120, 480);
  makeVResizer('resizer-right',   '--right-w',  -1, 160, 520);
  makeHResizer('resizer-console', '--console-h',    60, 500);
})();

/* ───── Console / Chat Tabs ───── */
function switchConsoleTab(tab) {
  const isChat = tab === 'chat';
  document.getElementById('console-pane').style.display = isChat ? 'none' : 'flex';
  document.getElementById('chat-pane').style.display    = isChat ? 'flex' : 'none';
  document.getElementById('tab-console').classList.toggle('active', !isChat);
  document.getElementById('tab-chat').classList.toggle('active',  isChat);
  if (isChat) {
    // Load sessions first, then history
    if (typeof window._chatSessionsLoaded === 'undefined') {
      window._chatSessionsLoaded = false;
    }
    if (!window._chatSessionsLoaded) {
      window.loadSessionsList && window.loadSessionsList();
    } else {
      window.loadChatHistory && window.loadChatHistory();
    }
  }
}

/* ───── Chat with Alice ───── */
(function initChat() {
  const sessionSelect = document.getElementById('chat-session-id');
  const refreshBtn    = document.getElementById('chat-session-refresh');
  const messagesEl    = document.getElementById('chat-messages');
  const inputEl       = document.getElementById('chat-input');
  const sendBtn       = document.getElementById('chat-send-btn');

  // Load and populate sessions list
  window.loadSessionsList = async function() {
    try {
      const res  = await fetch('/proxy/agent/sessions-list');
      const data = await res.json();
      if (!data.success) return;
      const saved = localStorage.getItem('chat-session-id') || '';
      sessionSelect.innerHTML = '';
      data.sessions.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.sessionId;
        opt.textContent = s.label || s.sessionId.replace(/\.md$/, '');
        if (s.sessionId === saved) opt.selected = true;
        sessionSelect.appendChild(opt);
      });
      // Fall back to first if saved not found
      if (!sessionSelect.value && data.sessions.length) {
        sessionSelect.value = data.sessions[0].sessionId;
      }
      if (sessionSelect.value) {
        localStorage.setItem('chat-session-id', sessionSelect.value);
      }
      window._chatSessionsLoaded = true;
      loadChatHistory();
    } catch (_) {}
  };

  sessionSelect.addEventListener('change', () => {
    localStorage.setItem('chat-session-id', sessionSelect.value);
    loadChatHistory();
  });
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    window._chatSessionsLoaded = false;
    window.loadSessionsList();
  });

  window.loadChatHistory = async function() {
    const sessionId = sessionSelect.value;
    if (!sessionId) return;
    try {
      const res = await fetch('/proxy/agent/chat-history?sessionId=' + encodeURIComponent(sessionId));
      const data = await res.json();
      // Clear and rebuild
      messagesEl.innerHTML = '';
      if (!data.success || !data.messages || !data.messages.length) {
        appendMsg('（暂无历史对话）', 'system');
      } else {
        appendMsg('── 历史对话 ──', 'system');
        data.messages.forEach(msg => {
          const div = document.createElement('div');
          div.className = 'chat-msg chat-msg-user';
          const ts = msg.time || '';
          div.innerHTML = `<span class="chat-ts">${ts}</span><span class="chat-text">${
            (msg.content || '').replace(/</g, '&lt;').replace(/\n/g, '<br>')
          }</span>`;
          messagesEl.appendChild(div);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        });
        appendMsg('── 以上为历史记录 ──', 'system');
      }
    } catch (err) {
      appendMsg('⚠ 加载历史失败：' + err.message, 'system');
    }
  };

  function appendMsg(text, type) {
    const div = document.createElement('div');
    div.className = 'chat-msg chat-msg-' + type;
    div.innerHTML = `<span class="chat-text">${text.replace(/</g, '&lt;')}</span>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  let pollTimer = null;
  function pollStatus(sessionId, resolve) {
    fetch('/proxy/agent/task-status?sessionId=' + encodeURIComponent(sessionId))
      .then(r => r.json())
      .then(d => {
        if (d.isDone || d.agentStatus === 'waiting') {
          sendBtn.disabled = false;
          appendMsg('✅ 任务已送达，爱丽丝处理完毕', 'system');
          resolve && resolve();
        } else {
          pollTimer = setTimeout(() => pollStatus(sessionId, resolve), 3000);
        }
      })
      .catch(() => { sendBtn.disabled = false; });
  }

  window.chatSend = async function() {
    const sessionId = sessionSelect.value;
    const task = inputEl.value.trim();
    if (!sessionId) { appendMsg('⚠ 请先选择 Session', 'system'); return; }
    if (!task) return;

    localStorage.setItem('chat-session-id', sessionId);
    appendMsg(task, 'user');
    inputEl.value = '';
    sendBtn.disabled = true;
    appendMsg('⏳ 发送中…', 'system');

    try {
      const res = await fetch('/proxy/agent/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, task }),
      });
      const data = await res.json();
      if (data.success) {
        appendMsg('📨 已加入队列，等待爱丽丝处理…', 'system');
        pollStatus(sessionId, () => loadChatHistory());
      } else {
        appendMsg('❌ 发送失败: ' + (data.error || ''), 'system');
        sendBtn.disabled = false;
      }
    } catch (e) {
      appendMsg('❌ 网络错误: ' + e.message, 'system');
      sendBtn.disabled = false;
    }
  };

  // Ctrl+Enter to send
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); chatSend(); }
  });
})();

/* ───── Grid ───── */
function drawGrid() {
  // Read from viewport (the true container), not from grid-canvas itself
  const w = canvasViewport.offsetWidth  || canvasW();
  const h = canvasViewport.offsetHeight || canvasH();
  gridCanvas.width  = w;
  gridCanvas.height = h;
  const ctx = gridCanvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  if (!gridVisible) return;

  // Minor grid lines (every 20px)
  ctx.beginPath();
  ctx.strokeStyle = '#2a2a40';
  ctx.lineWidth = 1;
  for (let x = 0.5; x < w; x += GRID_SIZE) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = 0.5; y < h; y += GRID_SIZE) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();

  // Major grid lines (every 100px)
  ctx.beginPath();
  ctx.strokeStyle = '#303050';
  ctx.lineWidth = 1;
  for (let x = 0.5; x < w; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = 0.5; y < h; y += 100) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
}

/* ───── Snap ───── */
function snap(v) {
  if (!snapEnabled) return v;
  return Math.round(v / SNAP_SIZE) * SNAP_SIZE;
}

/* ───── Edge-snap (align to sibling box edges while dragging) ───── */
const EDGE_SNAP_THRESHOLD = 12; // canvas units
function edgeSnap(box, dx_hint, dy_hint) {
  const siblings = boxes.filter(b => b.id !== box.id && b.parentId === box.parentId);
  let snapX = null, snapY = null;
  const boxL = box.x, boxR = box.x + box.w;
  const boxT = box.y, boxB = box.y + box.h;
  for (const sib of siblings) {
    const sL = sib.x, sR = sib.x + sib.w;
    const sT = sib.y, sB = sib.y + sib.h;
    if (snapX === null) {
      if (Math.abs(boxL - sL) <= EDGE_SNAP_THRESHOLD) snapX = sL;
      else if (Math.abs(boxL - sR) <= EDGE_SNAP_THRESHOLD) snapX = sR;
      else if (Math.abs(boxR - sL) <= EDGE_SNAP_THRESHOLD) snapX = sL - box.w;
      else if (Math.abs(boxR - sR) <= EDGE_SNAP_THRESHOLD) snapX = sR - box.w;
    }
    if (snapY === null) {
      if (Math.abs(boxT - sT) <= EDGE_SNAP_THRESHOLD) snapY = sT;
      else if (Math.abs(boxT - sB) <= EDGE_SNAP_THRESHOLD) snapY = sB;
      else if (Math.abs(boxB - sT) <= EDGE_SNAP_THRESHOLD) snapY = sT - box.h;
      else if (Math.abs(boxB - sB) <= EDGE_SNAP_THRESHOLD) snapY = sB - box.h;
    }
  }
  if (snapX !== null) box.x = snapX;
  if (snapY !== null) box.y = snapY;
}

/* ───── Undo / Redo ───── */
function saveState() {
  undoStack.push(JSON.stringify(boxes));
  if (undoStack.length > 50) undoStack.shift();
  redoStack = [];
  autoSave();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(boxes));
  boxes = JSON.parse(undoStack.pop());
  selectedId = null;
  renderAll();
  autoSave();
  log('撤销', 'dim');
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(boxes));
  boxes = JSON.parse(redoStack.pop());
  selectedId = null;
  renderAll();
  autoSave();
  log('重做', 'dim');
}

/* ───── Anchor System ───── */
// 4×4 preset grid: cols=H position (Left/Center/Right/H-Stretch), rows=V position (Top/Mid/Bot/V-Stretch)
const ANCHOR_PRESETS = [
  // row 0: Top
  {minX:0,   minY:0,   maxX:0,   maxY:0  }, {minX:0.5, minY:0,   maxX:0.5, maxY:0  }, {minX:1,   minY:0,   maxX:1,   maxY:0  }, {minX:0, minY:0, maxX:1, maxY:0  },
  // row 1: Middle
  {minX:0,   minY:0.5, maxX:0,   maxY:0.5}, {minX:0.5, minY:0.5, maxX:0.5, maxY:0.5}, {minX:1,   minY:0.5, maxX:1,   maxY:0.5}, {minX:0, minY:0.5, maxX:1, maxY:0.5},
  // row 2: Bottom
  {minX:0,   minY:1,   maxX:0,   maxY:1  }, {minX:0.5, minY:1,   maxX:0.5, maxY:1  }, {minX:1,   minY:1,   maxX:1,   maxY:1  }, {minX:0, minY:1, maxX:1, maxY:1  },
  // row 3: V-Stretch
  {minX:0,   minY:0,   maxX:0,   maxY:1  }, {minX:0.5, minY:0,   maxX:0.5, maxY:1  }, {minX:1,   minY:0,   maxX:1,   maxY:1  }, {minX:0, minY:0, maxX:1, maxY:1  },
];

const ANCHOR_LABELS = [
  '左上','上中','右上','水平拉伸-上',
  '左中','居中','右中','水平拉伸-中',
  '左下','下中','右下','水平拉伸-下',
  '竖直拉伸-左','竖直拉伸-中','竖直拉伸-右','全拉伸',
];

function anchorMatch(a, b) {
  return a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;
}

function buildAnchorPickerHTML(current) {
  // Draw a 4x4 grid; each cell is a mini preview showing anchor position
  const cells = ANCHOR_PRESETS.map((p, i) => {
    const active = anchorMatch(p, current) ? ' anc-active' : '';
    const hStretch = p.minX !== p.maxX;
    const vStretch = p.minY !== p.maxY;
    // Dot position in mini preview
    const dotX = hStretch ? 50 : p.minX * 100;
    const dotY = vStretch ? 50 : p.minY * 100;
    const dotW = hStretch ? 100 : 4;
    const dotH = vStretch ? 100 : 4;
    const dot = hStretch || vStretch
      ? `<div style="position:absolute;left:${Math.min(p.minX,p.maxX)*100}%;top:${Math.min(p.minY,p.maxY)*100}%;width:${dotW}%;height:${dotH}%;background:currentColor;opacity:0.7"></div>`
      : `<div style="position:absolute;left:calc(${dotX}% - 2px);top:calc(${dotY}% - 2px);width:4px;height:4px;border-radius:50%;background:currentColor"></div>`;
    return `<div class="anc-cell${active}" title="${ANCHOR_LABELS[i]}" data-anchor='${JSON.stringify(p)}'>
      <div style="position:relative;width:100%;height:100%">${dot}</div>
    </div>`;
  });
  return `<div class="anchor-picker">${cells.join('')}</div>`;
}

function refreshAnchorPicker(current) {
  document.querySelectorAll('.anc-cell').forEach((cell, i) => {
    cell.classList.toggle('anc-active', anchorMatch(ANCHOR_PRESETS[i], current));
  });
}

// Apply anchor preset: physically reposition (and optionally resize) the box relative to its parent.
// Point anchor: aligns the corresponding edge of the box to the anchor% of the parent.
//   minX=0 → left edge of box at left of parent
//   minX=0.5 → center of box at center of parent (horizontally)
//   minX=1 → right edge of box at right of parent
// Stretch anchor (minX≠maxX or minY≠maxY): resizes box to span that fraction of the parent.
function applyAnchorPreset(box, a) {
  const parent = box.parentId != null ? boxes.find(b => b.id === box.parentId) : null;
  const pw = parent ? parent.w : (canvasViewport.offsetWidth  || 800);
  const ph = parent ? parent.h : (canvasViewport.offsetHeight || 600);
  const px = parent ? parent.x : 0;
  const py = parent ? parent.y : 0;

  const hStretch = a.minX !== a.maxX;
  const vStretch = a.minY !== a.maxY;

  if (hStretch) {
    box.x = snap(px + a.minX * pw);
    box.w = Math.max(20, snap((a.maxX - a.minX) * pw));
  } else {
    // minX fraction: which edge of the box aligns to anchor% of parent width
    // box.x + a.minX * box.w = px + a.minX * pw
    box.x = snap(px + a.minX * pw - a.minX * box.w);
  }

  if (vStretch) {
    box.y = snap(py + a.minY * ph);
    box.h = Math.max(20, snap((a.maxY - a.minY) * ph));
  } else {
    box.y = snap(py + a.minY * ph - a.minY * box.h);
  }
}

/* ───── Box Model ───── */
function initWidgetProps(def) {
  if (!def || !def.props) return {};
  const wp = {};
  def.props.forEach(p => { wp[p.key] = p.default !== undefined ? p.default : ''; });
  return wp;
}

function createBox(x, y, w, h, label, widgetType) {
  const def = widgetType ? getWidgetDef(widgetType) : null;
  // Use short human-readable prefix for auto-generated labels
  const SHORT = {
    CanvasPanel:'Canvas', Border:'Border', HorizontalBox:'HBox', VerticalBox:'VBox',
    GridPanel:'Grid', ScrollBox:'Scroll', SizeBox:'SizeBox', Overlay:'Overlay',
    TileView:'TileView', ListView:'ListView', TreeView:'TreeView',
    UniformGridPanel:'UniformGrid', WrapBox:'WrapBox', ScaleBox:'ScaleBox',
    TextBlock:'TextBlock', Button:'Button', Image:'Image', ProgressBar:'ProgressBar',
    Slider:'Slider', EditableText:'EditText', EditableTextBox:'EditTextBox',
    CheckBox:'CheckBox', SpinBox:'SpinBox', ComboBox:'ComboBox', TextBox:'TextBox',
  };
  const typeName = widgetType ? (SHORT[widgetType] || def.label) : 'Box';
  // Per-type sequential label: count existing boxes of same type
  const sameTypeCount = boxes.filter(b => b.widgetType === (widgetType || null)).length;
  const autoLabel = `${typeName}_${sameTypeCount + 1}`;
  return {
    id: nextId++,
    x: snap(x), y: snap(y),
    w: Math.max(snap(w), 20),
    h: Math.max(snap(h), 20),
    label: label || autoLabel,
    borderColor: def ? def.color : '#7c6af7',
    bgColor: def ? def.bg : 'rgba(124,106,247,0.06)',
    borderWidth: 1,
    borderRadius: 0,
    boxShadow: '',
    opacity: 1.0,
    widgetType: widgetType || null,
    anchor: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    widgetProps: initWidgetProps(def),
    parentId: null
  };
}

/* TileView EntryClass: 当框类型设为 TileView/ListView/TreeView 时，自动在内部创建 EntryClass 子框 */
const ENTRY_CLASS_TYPES = ['TileView', 'ListView', 'TreeView'];

// O(1) lookup cache: rebuilt at the start of every renderAll()
let _boxById = {};
// Widget types that are invisible containers in UE4 UMG (no visual border/background by default)
const INVISIBLE_CONTAINER_TYPES = new Set([
  'CanvasPanel','HorizontalBox','VerticalBox','GridPanel','UniformGridPanel',
  'WrapBox','Overlay','SizeBox','ScaleBox'
]);
// Preview mode: hide layout container borders/backgrounds to simulate UE4 appearance
let _previewMode = false;
// UiData: flat map of { id → data-object } built from the loaded .uidata tree
let _uidataMap = {};

/* ── UiData helpers ── */
function _buildUidataMap(node, out) {
  if (!node) return;
  if (node.id && node.data && Object.keys(node.data).length) out[node.id] = node.data;
  (node.children || []).forEach(c => _buildUidataMap(c, out));
}
async function loadUiData(sessionName) {
  _uidataMap = {};
  try {
    const res = await fetch('/api/uidata/' + encodeURIComponent(sessionName));
    const json = await res.json();
    if (json.success && json.data && json.data.root) {
      _buildUidataMap(json.data.root, _uidataMap);
    }
  } catch (e) { /* no uidata — ok */ }
}
async function saveUiData(sessionName, rootNode) {
  const body = {
    version: '1.0', sessionName,
    savedAt: new Date().toISOString(), root: rootNode
  };
  await fetch('/api/uidata/' + encodeURIComponent(sessionName), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}
/* Build a uidata tree skeleton from the current boxes[], preserving existing data */
function buildUidataTree(existingRoot) {
  const existingMap = {};
  if (existingRoot) { (function walk(n){ if(n.id) existingMap[n.id]=n.data||{}; (n.children||[]).forEach(walk); })(existingRoot); }
  function makeNode(box) {
    const children = boxes.filter(b => b.parentId === box.id).map(makeNode);
    return { id: box.id, data: existingMap[box.id] || {}, children };
  }
  const roots = boxes.filter(b => b.parentId == null);
  return roots.length === 1 ? makeNode(roots[0]) : { id: '__root__', data: {}, children: roots.map(makeNode) };
}

function togglePreviewMode() {
  _previewMode = !_previewMode;
  const btn = document.getElementById('btn-preview-mode');
  if (btn) {
    btn.innerHTML = _previewMode ? '<span class="icon">🎮</span> 预览模式' : '<span class="icon">👁</span> 布局视图';
    btn.classList.toggle('active', _previewMode);
  }

  // Preview mode banner on canvas
  const existingBanner = document.getElementById('_preview-banner');
  if (existingBanner) existingBanner.remove();
  if (_previewMode) {
    const banner = document.createElement('div');
    banner.id = '_preview-banner';
    banner.textContent = '🎮 预览模式 — 按 P 返回布局视图';
    banner.style.cssText = 'position:fixed;top:88px;left:50%;transform:translateX(-50%);background:rgba(10,6,2,0.88);color:#f5c542;border:1px solid #f5c542;border-radius:4px;padding:4px 14px;font-size:12px;z-index:9999;pointer-events:none;letter-spacing:0.5px;';
    document.body.appendChild(banner);
  }

  // Hide/show editor chrome: labels, resize handles, selection indicators
  const styleId = '_preview-style';
  let styleEl = document.getElementById(styleId);
  if (_previewMode) {
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = styleId; document.head.appendChild(styleEl); }
    styleEl.textContent = `.box-label { display: none !important; } .resize-handle { display: none !important; } #sel-overlay { display: none !important; }`;
  } else {
    if (styleEl) styleEl.remove();
  }

  renderAll();
  if (_previewMode) {
    // Load uidata for current session when entering preview mode
    loadUiData(_sessionName).then(() => renderAll());
    // Show data editor button
    _showUidataBtn(true);
  } else {
    _uidataMap = {};
    _showUidataBtn(false);
  }
  // Inline toast (showToast is in a closure, use inline implementation here)
  const _t = document.createElement('div');
  _t.textContent = _previewMode ? '🎮 预览模式已开启' : '👁 布局视图已恢复';
  _t.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:#1e2028;color:#e8eaf0;padding:8px 18px;border-radius:8px;font-size:13px;z-index:9999;border:1px solid rgba(255,255,255,0.12);box-shadow:0 4px 16px rgba(0,0,0,0.4);pointer-events:none;transition:opacity 0.4s;white-space:nowrap';
  document.body.appendChild(_t);
  setTimeout(() => { _t.style.opacity = '0'; setTimeout(() => _t.remove(), 400); }, 2200);
}

function _showUidataBtn(show) {
  let btn = document.getElementById('_uidata-btn');
  if (!show) { if (btn) btn.remove(); return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = '_uidata-btn';
    btn.title = '编辑/查看 UiData 数据绑定';
    btn.textContent = '🗄 数据';
    btn.style.cssText = 'position:fixed;top:88px;right:280px;z-index:9998;background:#1e2028;color:#7c6af7;border:1px solid #7c6af7;border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer;';
    btn.onclick = showUidataEditor;
    document.body.appendChild(btn);
  }
}

function showUidataEditor() {
  const existing = document.getElementById('_uidata-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.id = '_uidata-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:#1a1d23;border:1px solid #3a3d4a;border-radius:8px;width:600px;max-height:80vh;display:flex;flex-direction:column;font-size:12px;color:#e8eaf0;overflow:hidden;';

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid #3a3d4a;gap:8px;';
  header.innerHTML = `<span style="font-weight:600;font-size:13px;">🗄 UiData — <span style="color:#7c6af7">${_sessionName}</span>.uidata</span>
    <span style="margin-left:auto;font-size:10px;color:#666;">在此编辑数据节点，预览模式实时映射到 Session</span>`;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'margin-left:8px;background:none;border:none;color:#888;cursor:pointer;font-size:14px;';
  closeBtn.onclick = () => overlay.remove();
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // Tree view
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto;padding:8px 0;';

  function renderNode(node, depth) {
    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;padding:3px 12px 3px ${12 + depth*16}px;gap:6px;cursor:pointer;`;
    row.onmouseenter = () => row.style.background = '#252830';
    row.onmouseleave = () => row.style.background = '';

    const hasData = node.data && Object.keys(node.data).length > 0;
    const idSpan = document.createElement('span');
    idSpan.textContent = node.id;
    idSpan.style.cssText = `color:${hasData ? '#7c6af7' : '#888'};font-family:monospace;`;

    const dataSpan = document.createElement('span');
    if (hasData) {
      dataSpan.style.cssText = 'color:#a0c4ff;font-family:monospace;font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      dataSpan.textContent = JSON.stringify(node.data);
    }
    const editBtn = document.createElement('button');
    editBtn.textContent = '✏';
    editBtn.style.cssText = 'margin-left:auto;background:none;border:none;color:#555;cursor:pointer;font-size:11px;';
    editBtn.onclick = (e) => { e.stopPropagation(); _editUidataNode(node, () => { overlay.remove(); showUidataEditor(); renderAll(); }); };

    row.appendChild(idSpan);
    row.appendChild(dataSpan);
    row.appendChild(editBtn);
    body.appendChild(row);
    (node.children || []).forEach(c => renderNode(c, depth + 1));
  }

  // Build current uidata tree from session + existing data
  (async () => {
    const res = await fetch('/api/uidata/' + encodeURIComponent(_sessionName));
    const json = await res.json();
    const existingRoot = json.success && json.data ? json.data.root : null;
    const tree = buildUidataTree(existingRoot);
    renderNode(tree, 0);

    // Footer buttons
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;padding:10px 16px;border-top:1px solid #3a3d4a;';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = '💾 保存 UiData';
    saveBtn.style.cssText = 'background:#7c6af7;border:none;color:#fff;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:12px;';
    saveBtn.onclick = async () => {
      await saveUiData(_sessionName, tree);
      await loadUiData(_sessionName);
      renderAll();
      overlay.remove();
      const t=document.createElement('div'); t.textContent='✅ UiData 已保存'; t.style.cssText='position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:#1e2028;color:#7c6af7;padding:8px 18px;border-radius:8px;font-size:13px;z-index:9999;border:1px solid #7c6af7;pointer-events:none;'; document.body.appendChild(t); setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),400);},2000);
    };
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = 'background:none;border:1px solid #3a3d4a;color:#888;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:12px;';
    cancelBtn.onclick = () => overlay.remove();
    footer.appendChild(saveBtn);
    footer.appendChild(cancelBtn);
    panel.appendChild(body);
    panel.appendChild(footer);
  })();

  overlay.appendChild(panel);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

function _editUidataNode(node, onSave) {
  const dlg = document.createElement('div');
  dlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:10001;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#1a1d23;border:1px solid #7c6af7;border-radius:8px;width:480px;padding:16px;font-size:12px;color:#e8eaf0;';
  box.innerHTML = `<div style="font-weight:600;margin-bottom:10px;color:#7c6af7;">编辑节点数据 — <code>${node.id}</code></div>
    <div style="color:#888;margin-bottom:6px;font-size:11px;">JSON 格式，如 {"text":"hello"} 或 {"percent":0.75}</div>`;
  const ta = document.createElement('textarea');
  ta.value = JSON.stringify(node.data || {}, null, 2);
  ta.style.cssText = 'width:100%;height:120px;background:#0d0f12;border:1px solid #3a3d4a;color:#a0c4ff;font-family:monospace;font-size:12px;padding:8px;border-radius:4px;resize:vertical;box-sizing:border-box;';
  box.appendChild(ta);
  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
  const ok = document.createElement('button');
  ok.textContent = '确定'; ok.style.cssText = 'background:#7c6af7;border:none;color:#fff;padding:5px 14px;border-radius:4px;cursor:pointer;';
  ok.onclick = () => {
    try {
      node.data = JSON.parse(ta.value);
      dlg.remove(); onSave();
    } catch(e) { ta.style.border='1px solid #f55'; ta.title=e.message; }
  };
  const cancel = document.createElement('button');
  cancel.textContent = '取消'; cancel.style.cssText = 'background:none;border:1px solid #3a3d4a;color:#888;padding:5px 14px;border-radius:4px;cursor:pointer;';
  cancel.onclick = () => dlg.remove();
  btns.appendChild(ok); btns.appendChild(cancel);
  box.appendChild(btns);
  dlg.appendChild(box);
  document.body.appendChild(dlg);
  ta.focus();
}

// ─────────────── Icon Picker ───────────────
const ICON_LIST = [
  // ── 状态属性 ──
  { name: 'health', label: '生命', path: '/assets/icons/colored/health.svg', group: '属性' },
  { name: 'mana', label: '魔力', path: '/assets/icons/colored/mana.svg', group: '属性' },
  { name: 'stamina', label: '耐力', path: '/assets/icons/colored/stamina.svg', group: '属性' },
  { name: 'str', label: '力量', path: '/assets/icons/colored/str.svg', group: '属性' },
  { name: 'dex', label: '敏捷', path: '/assets/icons/colored/dex.svg', group: '属性' },
  { name: 'int', label: '智力', path: '/assets/icons/colored/int.svg', group: '属性' },
  { name: 'vit', label: '体力', path: '/assets/icons/colored/vit.svg', group: '属性' },
  { name: 'atk', label: '攻击', path: '/assets/icons/colored/atk.svg', group: '属性' },
  { name: 'def2', label: '防御', path: '/assets/icons/colored/def2.svg', group: '属性' },
  // ── 元素 ──
  { name: 'fire', label: '火焰', path: '/assets/icons/colored/fire.svg', group: '元素' },
  { name: 'ice', label: '冰霜', path: '/assets/icons/colored/ice.svg', group: '元素' },
  { name: 'lightning', label: '闪电', path: '/assets/icons/colored/lightning.svg', group: '元素' },
  { name: 'poison', label: '毒素', path: '/assets/icons/colored/poison.svg', group: '元素' },
  // ── 物品 ──
  { name: 'arrow', label: '箭矢', path: '/assets/icons/colored/arrow.svg', group: '物品' },
  { name: 'bag', label: '背包', path: '/assets/icons/colored/bag.svg', group: '物品' },
  { name: 'coin', label: '金币', path: '/assets/icons/colored/coin.svg', group: '物品' },
  { name: 'gear', label: '齿轮', path: '/assets/icons/colored/gear.svg', group: '物品' },
  { name: 'gold', label: '黄金', path: '/assets/icons/colored/gold.svg', group: '物品' },
  { name: 'potion', label: '药水', path: '/assets/icons/colored/potion.svg', group: '物品' },
  { name: 'scroll', label: '卷轴', path: '/assets/icons/colored/scroll.svg', group: '物品' },
  { name: 'skull', label: '骷髅', path: '/assets/icons/colored/skull.svg', group: '物品' },
  // ── 装备 ──
  { name: 'boots', label: '靴子', path: '/assets/icons/colored/boots.svg', group: '装备' },
  { name: 'gloves', label: '手套', path: '/assets/icons/colored/gloves.svg', group: '装备' },
  { name: 'helmet', label: '头盔', path: '/assets/icons/colored/helmet.svg', group: '装备' },
  { name: 'ring', label: '戒指', path: '/assets/icons/colored/ring.svg', group: '装备' },
  { name: 'shield', label: '护盾', path: '/assets/icons/colored/shield.svg', group: '装备' },
  { name: 'sword', label: '剑', path: '/assets/icons/colored/sword.svg', group: '装备' },
  // ── 装备槽（深色风格）──
  { name: 'slot_weapon', label: '武器槽', path: '/assets/icons/slots/weapon.svg', group: '槽位' },
  { name: 'slot_shield', label: '副手槽', path: '/assets/icons/slots/shield.svg', group: '槽位' },
  { name: 'slot_head', label: '头盔槽', path: '/assets/icons/slots/head.svg', group: '槽位' },
  { name: 'slot_chest', label: '胸甲槽', path: '/assets/icons/slots/chest.svg', group: '槽位' },
  { name: 'slot_legs', label: '腿甲槽', path: '/assets/icons/slots/legs.svg', group: '槽位' },
  { name: 'slot_gloves', label: '手套槽', path: '/assets/icons/slots/gloves.svg', group: '槽位' },
  { name: 'slot_boots', label: '靴子槽', path: '/assets/icons/slots/boots.svg', group: '槽位' },
  { name: 'slot_belt', label: '腰带槽', path: '/assets/icons/slots/belt.svg', group: '槽位' },
  { name: 'slot_ring', label: '戒指槽', path: '/assets/icons/slots/ring.svg', group: '槽位' },
  { name: 'slot_amulet', label: '项链槽', path: '/assets/icons/slots/amulet.svg', group: '槽位' },
];

// Dynamic group filter for icon picker
let _iconPickerGroup = 'all';
let _iconPickerBox = null;

function openIconPicker(box) {
  _iconPickerBox = box;
  const overlay = document.getElementById('icon-picker-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  _iconPickerGroup = 'all';
  // Render group tabs
  const tabContainer = document.getElementById('icon-picker-tabs');
  if (tabContainer) {
    const groups = ['all', ...new Set(ICON_LIST.map(i => i.group).filter(Boolean))];
    const labels = { all: '全部' };
    tabContainer.innerHTML = groups.map(g => 
      `<button onclick="setIconGroup('${g}')" id="igtab_${g}" style="padding:3px 10px;font-size:11px;cursor:pointer;border-radius:3px;border:1px solid var(--border,#3a3a5c);background:${g==='all'?'#9b8af7':'var(--bg-dark,#12121a)'};color:${g==='all'?'#fff':'var(--text,#ccc)'};transition:all 0.15s">${labels[g]||g}</button>`
    ).join('');
  }
  renderIconGrid('');
  const search = document.getElementById('icon-picker-search');
  if (search) { search.value = ''; search.focus(); }
}

function closeIconPicker() {
  const overlay = document.getElementById('icon-picker-overlay');
  if (overlay) overlay.style.display = 'none';
  _iconPickerBox = null;
}

function setIconGroup(g) {
  _iconPickerGroup = g;
  // Update tab styles
  const groups = ['all', ...new Set(ICON_LIST.map(i => i.group).filter(Boolean))];
  groups.forEach(group => {
    const btn = document.getElementById(`igtab_${group}`);
    if (btn) {
      btn.style.background = group === g ? '#9b8af7' : 'var(--bg-dark,#12121a)';
      btn.style.color = group === g ? '#fff' : 'var(--text,#ccc)';
    }
  });
  const search = document.getElementById('icon-picker-search');
  renderIconGrid(search ? search.value.toLowerCase() : '');
}

function filterIconPicker(q) {
  renderIconGrid(q.toLowerCase());
}

// ─────────────── Image Browser ───────────────
let _imgBrowserBox = null;
let _imgBrowserProp = 'bgImage';
let _imgBrowserAllImages = [];
let _imgBrowserFolder = 'all';

async function openImgBrowser(box, prop) {
  _imgBrowserBox = box || null;
  _imgBrowserProp = prop || 'bgImage';
  const overlay = document.getElementById('img-browser-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  document.getElementById('img-browser-grid').innerHTML = '<div style="color:#666;font-size:12px;padding:20px;grid-column:1/-1;text-align:center">加载中…</div>';
  try {
    const r = await fetch('/api/images');
    const data = await r.json();
    _imgBrowserAllImages = data.images || [];
  } catch (e) {
    _imgBrowserAllImages = [];
  }
  _imgBrowserFolder = 'all';
  renderImgBrowserFolders();
  renderImgBrowserGrid('');
  const search = document.getElementById('img-browser-search');
  if (search) { search.value = ''; search.focus(); }
}

function closeImgBrowser() {
  const overlay = document.getElementById('img-browser-overlay');
  if (overlay) overlay.style.display = 'none';
  _imgBrowserBox = null;
}

function renderImgBrowserFolders() {
  const container = document.getElementById('img-browser-folders');
  if (!container) return;
  const dirs = ['all', ...new Set(_imgBrowserAllImages.map(i => i.dir))].sort();
  container.innerHTML = dirs.map(d => {
    const label = d === 'all' ? '全部' : d.replace(/^\//, '');
    const active = d === _imgBrowserFolder;
    return `<button onclick="setImgBrowserFolder('${d}')" style="padding:3px 10px;font-size:11px;cursor:pointer;border-radius:3px;border:1px solid var(--border,#3a3a5c);background:${active?'#56cfba':'var(--bg-dark,#12121a)'};color:${active?'#000':'var(--text,#ccc)'};transition:all 0.15s">${label}</button>`;
  }).join('');
}

function setImgBrowserFolder(dir) {
  _imgBrowserFolder = dir;
  renderImgBrowserFolders();
  const search = document.getElementById('img-browser-search');
  renderImgBrowserGrid(search ? search.value.toLowerCase() : '');
}

function filterImgBrowser(q) {
  renderImgBrowserGrid(q.toLowerCase());
}

function renderImgBrowserGrid(q) {
  const grid = document.getElementById('img-browser-grid');
  const status = document.getElementById('img-browser-status');
  if (!grid) return;
  let images = _imgBrowserAllImages;
  if (_imgBrowserFolder !== 'all') images = images.filter(i => i.dir === _imgBrowserFolder);
  if (q) images = images.filter(i => i.name.toLowerCase().includes(q));
  if (status) status.textContent = `共 ${_imgBrowserAllImages.length} 张 · 显示 ${images.length} 张 · 点击应用到选中框`;
  grid.innerHTML = images.map(img => {
    const ep = img.path.replace(/'/g, "\\'");
    return `<div onclick="applyImgBrowser('${ep}')" title="${img.path}" style="cursor:pointer;border:1px solid var(--border,#3a3a5c);border-radius:6px;overflow:hidden;background:var(--bg-dark,#12121a);transition:border-color 0.15s" onmouseover="this.style.borderColor='#56cfba'" onmouseout="this.style.borderColor='var(--border,#3a3a5c)'">
      <img src="${img.path}" style="width:100%;aspect-ratio:1;object-fit:contain;display:block;background:#0a0a14" onerror="this.style.opacity='0.2';this.style.minHeight='60px'"/>
      <div style="padding:4px 6px;font-size:9px;color:#888;overflow:hidden;white-space:nowrap;text-overflow:ellipsis" title="${img.name}">${img.name}</div>
    </div>`;
  }).join('') || '<div style="color:#666;font-size:12px;padding:20px;grid-column:1/-1;text-align:center">没有找到图片</div>';
}

function applyImgBrowser(path) {
  if (_imgBrowserBox) {
    saveState();
    if (_imgBrowserProp === 'bgImage') {
      _imgBrowserBox.bgImage = path;
      const el = document.getElementById('p-bgimg');
      if (el) el.value = path;
    } else {
      if (!_imgBrowserBox.widgetProps) _imgBrowserBox.widgetProps = {};
      _imgBrowserBox.widgetProps[_imgBrowserProp] = path;
    }
    renderAll();
    autoSave();
  } else {
    navigator.clipboard.writeText(path).then(() => showToast('✓ 已复制路径: ' + path));
  }
  closeImgBrowser();
}

function renderIconGrid(q) {
  const grid = document.getElementById('icon-picker-grid');
  if (!grid) return;
  let filtered = ICON_LIST;
  if (_iconPickerGroup && _iconPickerGroup !== 'all') filtered = filtered.filter(i => i.group === _iconPickerGroup);
  if (q) filtered = filtered.filter(i => i.name.includes(q) || i.label.includes(q));
  grid.innerHTML = filtered.map(icon => {
    const escapedPath = icon.path.replace(/'/g, "\\'");
    return `<div onclick="applyIcon('${escapedPath}')" title="${icon.path}" style="cursor:pointer;text-align:center;border:1px solid var(--border,#3a3a5c);border-radius:6px;padding:8px 4px;background:var(--bg-dark,#12121a);transition:border-color 0.15s" onmouseover="this.style.borderColor='#9b8af7'" onmouseout="this.style.borderColor='var(--border,#3a3a5c)'">
      <img src="${icon.path}" style="width:36px;height:36px;display:block;margin:0 auto 4px;object-fit:contain" onerror="this.style.opacity='0.3'"/>
      <span style="font-size:10px;color:var(--text-dim,#888)">${icon.label}</span>
    </div>`;
  }).join('') || `<div style="color:#666;font-size:12px;padding:20px;grid-column:1/-1;text-align:center">没有找到图标</div>`;
}

function applyIcon(path) {
  if (!_iconPickerBox) return;
  saveState();
  _iconPickerBox.bgImage = path;
  const el = document.getElementById('p-bgimg');
  if (el) el.value = path;
  renderAll();
  autoSave();
  closeIconPicker();
}
// ─────────────── Image Background Removal (扣图) ───────────────
/**
 * 前端扣图：用 canvas 采样四角颜色，进行洪泛填充删除背景
 * @param {string} url - 图片 URL
 * @param {number} tolerance - 容差 (0-255), 默认 30
 * @returns {Promise<string>} - 返回 data URL (PNG, 带透明通道)
 */
function removeImageBackground(url, tolerance = 30) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h);
      const px = data.data;

      // 采集四角颜色，取平均作为背景色
      function getPixel(x, y) {
        const i = (y * w + x) * 4;
        return [px[i], px[i+1], px[i+2], px[i+3]];
      }
      function colorDist(a, b) {
        return Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
      }

      const corners = [
        getPixel(0, 0), getPixel(w-1, 0),
        getPixel(0, h-1), getPixel(w-1, h-1)
      ];
      const bgColor = corners.reduce((acc, c) => [acc[0]+c[0]/4, acc[1]+c[1]/4, acc[2]+c[2]/4, 255], [0,0,0,255]);

      // BFS 洪泛：从四角开始，把相似颜色变透明
      const visited = new Uint8Array(w * h);
      const queue = [];
      [[0,0],[w-1,0],[0,h-1],[w-1,h-1]].forEach(([x,y]) => queue.push(y*w+x));

      while (queue.length > 0) {
        const idx = queue.pop();
        if (visited[idx]) continue;
        visited[idx] = 1;
        const pi = idx * 4;
        const c = [px[pi], px[pi+1], px[pi+2], px[pi+3]];
        if (c[3] < 10 || colorDist(c, bgColor) <= tolerance) {
          px[pi+3] = 0; // 设为透明
          const x = idx % w, y = Math.floor(idx / w);
          if (x > 0)   queue.push(idx - 1);
          if (x < w-1) queue.push(idx + 1);
          if (y > 0)   queue.push(idx - w);
          if (y < h-1) queue.push(idx + w);
        }
      }

      ctx.putImageData(data, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * 对当前选中框的 bgImage 进行扣图，替换为透明 PNG
 */
async function applyBgImageRemoveBg(box, tolerance) {
  if (!box || !box.bgImage) { showToast('请先设置背景图'); return; }
  showToast('扣图中…');
  try {
    const result = await removeImageBackground(box.bgImage, tolerance);
    saveState();
    box.bgImage = result;
    const el = document.getElementById('p-bgimg');
    if (el) el.value = '(data:image/png base64)';
    renderAll();
    autoSave();
    showToast('扣图完成 ✓');
  } catch(e) {
    showToast('扣图失败：' + e.message);
  }
}

function looksLikeSessionResource(v) {
  if (typeof v !== 'string' || v.trim().length < 3) return false;
  const value = v.trim();
  const urlRe = /^(https?:\/\/|data:image|\/|\.\/|\.\.\/)/i;
  const extRe = /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp|ttf|woff2?|otf|mp4|mp3|json)(\?.*)?$/i;
  return urlRe.test(value) || extRe.test(value);
}

function collectSessionResourceRefs() {
  const propType = { src: '图片 src', imagePath: '图片路径', bgImage: '背景图', content: '内容 URL', href: '链接' };
  const refs = [];
  for (const b of boxes) {
    if (b.entryClassRef)
      refs.push({ type: 'EntryClass模板', url: b.entryClassRef.trim(), label: b.label, id: b.id, widget: b.widgetType });
    if (b.bgImage && looksLikeSessionResource(b.bgImage))
      refs.push({ type: 'bgImage', url: b.bgImage.trim(), label: b.label, id: b.id, widget: b.widgetType });
    if (b.widgetProps) {
      for (const [key, val] of Object.entries(b.widgetProps)) {
        if (looksLikeSessionResource(val))
          refs.push({ type: propType[key] || key, url: val.trim(), label: b.label, id: b.id, widget: b.widgetType });
      }
    }
  }
  const seen = new Set();
  const deduped = refs.filter(r => {
    const k = r.url + '|' + r.id + '|' + r.type;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const byUrl = {};
  for (const r of deduped) {
    if (!byUrl[r.url]) byUrl[r.url] = [];
    byUrl[r.url].push(r);
  }
  const isImg = url => /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp)(\?.*)?$/i.test(url) || url.startsWith('data:image');
  const urls = Object.keys(byUrl).sort((a, b) => isImg(b) - isImg(a) || a.localeCompare(b));
  return { refs, deduped, byUrl, urls, isImg };
}

function sanitizeExportFileName(name, fallback = 'asset') {
  const cleaned = String(name || fallback).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_');
  return cleaned || fallback;
}

function guessFileNameFromUrl(url, fallbackBase) {
  if (url.startsWith('data:image/')) {
    const mime = url.slice(5, url.indexOf(';'));
    const ext = mime.split('/')[1] || 'png';
    return sanitizeExportFileName(`${fallbackBase}.${ext}`);
  }
  try {
    const parsed = new URL(url, window.location.origin);
    const raw = parsed.pathname.split('/').pop() || fallbackBase;
    return sanitizeExportFileName(raw.includes('.') ? raw : `${raw}.bin`);
  } catch (_) {
    return sanitizeExportFileName(`${fallbackBase}.bin`);
  }
}

function triggerBlobDownload(blob, fileName) {
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
}

async function exportSessionBackgroundAssets() {
  const { byUrl, isImg } = collectSessionResourceRefs();
  const imageUrls = Object.keys(byUrl).filter(url => {
    if (!isImg(url)) return false;
    return (byUrl[url] || []).some(item => item.type !== 'EntryClass模板');
  });
  if (!imageUrls.length) {
    showToast('当前 Session 没有可导出的控件图片资源');
    return;
  }

  const manifest = [];
  const failures = [];
  const sessionBase = sanitizeExportFileName(_sessionName || 'session');
  showToast(`开始导出 ${imageUrls.length} 个控件图片资源…`);

  const manifestBlob = new Blob([JSON.stringify({
    session: _sessionName,
    sessionPath: _sessionPath,
    exportedAt: new Date().toISOString(),
    assets: imageUrls.map((url, index) => ({
      index: index + 1,
      url,
      refs: (byUrl[url] || []).filter(item => item.type !== 'EntryClass模板').map(item => ({
        id: item.id,
        label: item.label,
        widget: item.widget,
        type: item.type
      }))
    }))
  }, null, 2)], { type: 'application/json' });
  triggerBlobDownload(manifestBlob, `${sessionBase}-control-image-assets.json`);

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const users = (byUrl[url] || []).filter(item => item.type !== 'EntryClass模板');
    const fallbackBase = `${sessionBase}-bg-${String(i + 1).padStart(2, '0')}`;
    const fileName = guessFileNameFromUrl(url, fallbackBase);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      triggerBlobDownload(blob, fileName);
      manifest.push({ fileName, url, count: users.length });
    } catch (e) {
      failures.push({ url, error: e.message });
    }
  }

  if (failures.length) {
    console.warn('[exportSessionBackgroundAssets] failed assets:', failures);
    showToast(`已导出 ${manifest.length} 个控件图片资源，${failures.length} 个失败`);
    log(`控件图片资源导出完成：成功 ${manifest.length}，失败 ${failures.length}`, 'warn');
  } else {
    showToast(`已导出 ${manifest.length} 个控件图片资源`);
    log(`控件图片资源导出完成：${manifest.length} 个文件`, 'ok');
  }
}

function openAssetsPanel() {
  const overlay = document.getElementById('assets-modal-overlay');
  const body = document.getElementById('assets-modal-body');
  if (!overlay || !body) return;

  overlay.style.display = 'flex';
  overlay.onclick = e => { if (e.target === overlay) closeAssetsPanel(); };

  // ── Collect session-referenced resources ──────────────────
  const { deduped, byUrl, urls, isImg } = collectSessionResourceRefs();

  // ── Tabs UI ──────────────────────────────────────────────
  const TAB_STYLE_ACT = 'padding:5px 14px;border-radius:5px 5px 0 0;border:1px solid var(--border,#3a3a5c);border-bottom:none;background:var(--bg-dark,#1e1e2e);color:var(--text,#cdd6f4);font-size:12px;cursor:pointer;font-family:inherit;';
  const TAB_STYLE_INV = 'padding:5px 14px;border-radius:5px 5px 0 0;border:1px solid transparent;background:transparent;color:var(--text-dim,#6e7891);font-size:12px;cursor:pointer;font-family:inherit;';

  function renderRefsTab() {
    if (urls.length === 0) {
      body.innerHTML = `<div style="color:#888;font-size:13px;padding:32px 0;text-align:center">
        当前界面没有引用任何外部资源。<br>
        <small style="color:#555;margin-top:6px;display:block">扫描：bgImage / widgetProps.src、imagePath 等 URL 值</small>
      </div>`;
      return;
    }
    body.innerHTML = `<div style="font-size:11px;color:#666;margin-bottom:10px">共 <b style="color:#9b8af7">${urls.length}</b> 个唯一资源，<b style="color:#56cfba">${deduped.length}</b> 处引用</div>
    ${urls.map(url => {
      const users = byUrl[url];
      const shortUrl = url.length > 72 ? url.slice(0, 69) + '…' : url;
      const preview = isImg(url)
        ? `<img src="${url}" loading="lazy" style="width:72px;height:72px;object-fit:contain;border:1px solid #333;border-radius:4px;background:#111;flex-shrink:0;cursor:zoom-in" onclick="window.open('${url.replace(/'/g,"\\'")}','_blank')" onerror="this.style.opacity=0.15;this.title='加载失败'" />`
        : `<div style="width:48px;height:48px;display:flex;align-items:center;justify-content:center;border:1px solid #2a2a3e;border-radius:4px;background:#111;flex-shrink:0;font-size:20px">${url.endsWith('.json') ? '📄' : '🔗'}</div>`;
      const typeTag = [...new Set(users.map(u => u.type))].map(t => `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:#1a2a3a;color:#56cfba">${t}</span>`).join(' ');
      const userList = users.map(u => `<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:#2a2a3e;color:#9b8af7">#${u.id} ${u.label}</span>`).join(' ');
      return `<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:1px solid #2a2a3e;border-radius:6px;margin-bottom:8px;background:#18182a">
        ${preview}
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">${typeTag}
            <button onclick="navigator.clipboard.writeText('${url.replace(/'/g,"\\'")}').then(()=>showToast('✓ 已复制'))" style="margin-left:auto;background:none;border:1px solid #333;border-radius:3px;color:#888;font-size:10px;padding:1px 6px;cursor:pointer">复制</button>
          </div>
          <div style="font-size:11px;font-family:monospace;color:#56cfba;word-break:break-all;margin-bottom:6px"><a href="${url}" target="_blank" style="color:#56cfba;text-decoration:none">${shortUrl}</a></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">${userList}</div>
        </div>
      </div>`;
    }).join('')}`;
  }

  function renderLibTab(filterQ) {
    body.innerHTML = `<div style="color:#888;font-size:12px;padding:16px 0;text-align:center">正在加载图标库…</div>`;
    fetch('/assets/icons/manifest.json').then(r => r.json()).then(manifest => {
      const q = (filterQ || '').toLowerCase();
      const list = (manifest.icons || []).filter(i => !q || i.name.toLowerCase().includes(q));
      const pngs = list.filter(i => i.type === 'png');
      const svgs = list.filter(i => i.type === 'svg');
      function renderSection(title, items) {
        if (!items.length) return '';
        const cards = items.map(i => {
          const url = '/' + i.file;
          return `<div onclick="navigator.clipboard.writeText('${url}').then(()=>showToast('✓ 已复制路径'))" title="${url}\n点击复制路径" style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 6px;border:1px solid #2a2a3e;border-radius:6px;background:#12121e;cursor:pointer;transition:border-color 0.15s;width:80px;flex-shrink:0" onmouseover="this.style.borderColor='#9b8af7'" onmouseout="this.style.borderColor='#2a2a3e'">
            <img src="${url}" loading="lazy" style="width:52px;height:52px;object-fit:contain;background:${i.type==='png'?'#0a0a14':'transparent'};border-radius:3px" onerror="this.parentElement.style.opacity='0.3'" />
            <span style="font-size:9px;color:#666;text-align:center;word-break:break-all;line-height:1.2;max-width:72px">${i.name}</span>
          </div>`;
        }).join('');
        return `<div style="margin-bottom:14px"><div style="font-size:11px;color:#666;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #2a2a3e">${title} (${items.length})</div><div style="display:flex;flex-wrap:wrap;gap:8px">${cards}</div></div>`;
      }
      const searchBar = `<div style="margin-bottom:12px"><input id="asset-lib-search" type="text" placeholder="搜索图标…" value="${filterQ||''}" oninput="window._assetLibSearch(this.value)" style="width:100%;padding:5px 10px;background:#0d0d1a;border:1px solid #3a3a5c;border-radius:5px;color:#cdd6f4;font-size:12px;outline:none;box-sizing:border-box" /></div>`;
      body.innerHTML = searchBar + (list.length === 0 ? '<div style="color:#666;text-align:center;padding:24px">无匹配图标</div>'
        : renderSection('🎮 游戏图标 (PNG)', pngs) + renderSection('⚡ 矢量图标 (SVG)', svgs));
      window._assetLibSearch = q => renderLibTab(q);
      const s = document.getElementById('asset-lib-search');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }).catch(() => {
      body.innerHTML = `<div style="color:#e05c6e;font-size:12px;padding:16px">无法加载图标库 (manifest.json 缺失)</div>`;
    });
  }

  // ── Tab header ─────────────────────────────────────────────
  const hdr = overlay.querySelector('[data-assets-tabs]') || (() => {
    const el = document.createElement('div');
    el.setAttribute('data-assets-tabs', '1');
    el.style.cssText = 'display:flex;gap:0;padding:0 16px;border-bottom:1px solid var(--border,#3a3a5c);flex-shrink:0;margin-bottom:8px';
    const modal = overlay.querySelector('#assets-modal');
    if (modal) modal.insertBefore(el, modal.querySelector('#assets-modal-body'));
    return el;
  })();

  let activeTab = 'refs';
  function setTab(t) {
    activeTab = t;
    hdr.innerHTML = `
      <button style="${t==='refs'?TAB_STYLE_ACT:TAB_STYLE_INV}" onclick="window._assetsTab('refs')">📌 引用资源 (${urls.length})</button>
      <button style="${t==='lib'?TAB_STYLE_ACT:TAB_STYLE_INV}" onclick="window._assetsTab('lib')">🖼 图标库</button>`;
    body.style.padding = '8px 16px';
    if (t === 'refs') renderRefsTab();
    else renderLibTab('');
  }
  window._assetsTab = t => setTab(t);
  setTab(urls.length > 0 ? 'refs' : 'lib');
}

function closeAssetsPanel() {
  const overlay = document.getElementById('assets-modal-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    // Remove tab header so it's rebuilt fresh next open
    const tabs = overlay.querySelector('[data-assets-tabs]');
    if (tabs) tabs.remove();
  }
}


// Returns true if this box is an EntryClass child inside a container type
// Matches both boxes labeled 'EntryClass' and boxes with isEntryClass:true
function isLockedEntryClass(box) {
  if (box.label !== 'EntryClass' && !box.isEntryClass) return false;
  const parent = _boxById[box.parentId] || boxes.find(b => b.id === box.parentId);
  return parent && ENTRY_CLASS_TYPES.includes(parent.widgetType);
}

// Returns the locked EntryClass ancestor of this box (if it's inside one), or null
function getLockedEntryClassAncestor(box) {
  const visited = new Set();
  let current = box;
  while (current && current.parentId != null) {
    if (visited.has(current.id)) break; // cycle guard
    visited.add(current.id);
    const parent = _boxById[current.parentId] || boxes.find(b => b.id === current.parentId);
    if (!parent) break;
    if (isLockedEntryClass(parent)) return parent;
    current = parent;
  }
  return null;
}

// Returns the isEntryClass-marked ancestor of this box (if it's inside one), or null
// Used to prevent dragging controls inside an entryclass box on the main canvas
// Note: only counts as locking if the isEntryClass box itself is NOT the root (has a parentId),
// i.e., it's embedded inside another container. Root-level isEntryClass boxes are standalone
// session roots and should NOT lock their children.
function getIsEntryClassAncestor(box) {
  const visited = new Set();
  let current = box;
  while (current && current.parentId != null) {
    if (visited.has(current.id)) break; // cycle guard
    visited.add(current.id);
    const parent = _boxById[current.parentId] || boxes.find(b => b.id === current.parentId);
    if (!parent) break;
    // Only lock if the isEntryClass box is itself inside another box (not session root)
    if (parent.isEntryClass && parent.parentId != null) return parent;
    current = parent;
  }
  return null;
}

function ensureTileViewEntry(box) {
  if (!box || !ENTRY_CLASS_TYPES.includes(box.widgetType)) return;
  // 已存在 EntryClass 子框则跳过（检查 label 或 isEntryClass 标记）
  const hasEntry = boxes.some(b => b.parentId === box.id && (b.label === 'EntryClass' || b.isEntryClass));
  if (hasEntry) return;
  const pad = 12;
  const ew = Math.max(Math.round(box.w * 0.6), 80);
  const eh = Math.max(Math.round(box.h * 0.4), 40);
  const ex = box.x + pad;
  const ey = box.y + pad;
  const entry = createBox(ex, ey, ew, eh, 'EntryClass', null);
  entry.borderColor = '#e8a020';
  entry.bgColor = 'rgba(232,160,32,0.08)';
  entry.parentId = box.id;
  // Sync entry dimensions to TileView widgetProps
  if (!box.widgetProps) box.widgetProps = {};
  if (!box.widgetProps.entryWidth)  box.widgetProps.entryWidth  = ew;
  if (!box.widgetProps.entryHeight) box.widgetProps.entryHeight = eh;
  boxes.push(entry);
}

/* Find the smallest existing box that fully contains the given rect, excluding excludeId.
   "Fully contains" means the candidate box's bounds completely wrap the child rect.
   This prevents a large parent from becoming a child of a smaller inner box. */
function findParentFor(x, y, w, h, excludeId) {
  let best = null, bestArea = Infinity;
  boxes.forEach(b => {
    if (b.id === excludeId) return;
    // Candidate must fully contain the child rect
    if (x >= b.x && (x + w) <= (b.x + b.w) && y >= b.y && (y + h) <= (b.y + b.h)) {
      const area = b.w * b.h;
      if (area < bestArea) { bestArea = area; best = b; }
    }
  });
  return best ? best.id : null;
}

// Recompute parentId for every box based on current positions.
// Call after draw or drag-end so hierarchy is always up-to-date.
function recomputeAllParents() {
  boxes.forEach(b => {
    b.parentId = findParentFor(b.x, b.y, b.w, b.h, b.id);
  });
  // Break any circular parentId chains (can form when overlapping same-size boxes)
  const byId = Object.fromEntries(boxes.map(b => [b.id, b]));
  boxes.forEach(b => {
    const visited = new Set();
    let cur = b;
    while (cur && cur.parentId != null) {
      if (visited.has(cur.id)) { cur.parentId = null; break; } // break cycle
      visited.add(cur.id);
      cur = byId[cur.parentId];
    }
  });
}

/* ───── Widget Content Renderer (data-driven) ───── */
function renderWidgetContent(box, el, def) {
  if (!def || !def.render) {
    const old = el.querySelector('.widget-render');
    if (old) old.remove();
    return;
  }
  // Merge uidata overrides in preview mode (non-destructive — box.widgetProps is NOT mutated)
  const _baseWp = box.widgetProps || {};
  const wp = (_previewMode && _uidataMap[box.id])
    ? Object.assign({}, _baseWp, _uidataMap[box.id])
    : _baseWp;
  const contentKey = `${box.widgetType}|${box.w}|${box.h}|${JSON.stringify(wp)}|${_previewMode}`;
  if (el.dataset.widgetContentKey === contentKey) return;
  el.dataset.widgetContentKey = contentKey;

  const old = el.querySelector('.widget-render');
  if (old) old.remove();

  const r = def.render;
  const wr = document.createElement('div');
  wr.className = 'widget-render';
  wr.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;display:flex;align-items:center;justify-content:center;box-sizing:border-box;';

  if (r.type === 'text' || r.type === 'richtext') {
    const txt = wp[r.src] ?? (def.props?.find(p=>p.key===r.src)?.default ?? '');
    const size = +wp[r.size] || 14;
    const color = wp[r.color] || '#fff';
    const align = (wp[r.align] || (r.align || 'center')).toLowerCase();
    const bold = wp[r.bold];
    const italic = wp[r.italic];
    const wrap = wp[r.wrap] !== false;
    wr.style.justifyContent = align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start';
    wr.style.alignItems = 'center';
    const _tPadV = Math.min(4, Math.max(0, Math.floor(box.h * 0.1)));
    const _tPadH = Math.min(6, Math.max(0, Math.floor(box.w * 0.05)));
    wr.style.padding = `${_tPadV}px ${_tPadH}px`;
    const _tFontSize = Math.min(size, (box.h - _tPadV * 2) * 0.9, box.h * 0.8);
    const span = document.createElement('span');
    span.style.cssText = `font-size:${Math.max(6, _tFontSize)}px;color:${color};font-weight:${bold?'bold':'normal'};font-style:${italic?'italic':'normal'};white-space:${wrap?'pre-wrap':'nowrap'};text-align:${align};word-break:break-word;max-width:100%;overflow:hidden;`;
    span.textContent = txt || '';
    wr.appendChild(span);

  } else if (r.type === 'progress') {
    const pct = Math.min(1, Math.max(0, +wp[r.src] || 0));
    const fillColor = wp[r.fill] || '#56cfba';
    const barColor = wp[r.bar] || 'rgba(255,255,255,0.1)';
    wr.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    wr.style.background = barColor;
    const fill = document.createElement('div');
    fill.style.cssText = `position:absolute;left:0;top:0;height:100%;width:${pct*100}%;background:${fillColor};transition:width 0.2s;`;
    wr.appendChild(fill);

  } else if (r.type === 'slider') {
    const val = +wp[r.src] || 0;
    const mn = +wp[r.min] || 0;
    const mx = +wp[r.max] || 1;
    const pct = mx !== mn ? (val - mn) / (mx - mn) : 0;
    wr.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:flex;align-items:center;padding:0 8px;box-sizing:border-box;';
    const track = document.createElement('div');
    track.style.cssText = 'width:100%;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;position:relative;';
    const thumb = document.createElement('div');
    thumb.style.cssText = `position:absolute;top:50%;transform:translate(-50%,-50%);left:${pct*100}%;width:12px;height:12px;background:#fff;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,0.5);`;
    const filled = document.createElement('div');
    filled.style.cssText = `position:absolute;left:0;top:0;height:100%;width:${pct*100}%;background:#7c6af7;border-radius:2px;`;
    track.appendChild(filled);
    track.appendChild(thumb);
    wr.appendChild(track);

  } else if (r.type === 'input') {
    const hint = wp[r.src] || '';
    const size = +wp[r.size] || 12;
    const color = wp[r.color] || '#aaa';
    wr.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:flex;align-items:center;padding:0 8px;box-sizing:border-box;';
    const span = document.createElement('span');
    span.style.cssText = `font-size:${size}px;color:${color};opacity:0.7;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
    span.textContent = hint;
    wr.appendChild(span);

  } else if (r.type === 'image') {
    const src = wp[r.src] || '';
    const tint = wp[r.tint] || '#ffffff';
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;pointer-events:none;';
      if (tint !== '#ffffff') img.style.filter = `sepia(1) saturate(2) hue-rotate(0deg) opacity(0.9)`;
      wr.appendChild(img);
    } else {
      wr.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(45deg,rgba(255,255,255,0.04) 0,rgba(255,255,255,0.04) 4px,transparent 4px,transparent 8px);';
      const label = document.createElement('span');
      label.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.3);';
      label.textContent = 'Image';
      wr.appendChild(label);
    }

  } else if (r.type === 'checkbox') {
    const checked = wp[r.src] === true || wp[r.src] === 'true';
    const labelText = wp[r.label] || '';
    wr.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:flex;align-items:center;padding:0 6px;gap:6px;box-sizing:border-box;';
    const box2 = document.createElement('div');
    box2.style.cssText = `width:14px;height:14px;flex-shrink:0;border:2px solid rgba(255,255,255,0.6);border-radius:2px;background:${checked?'rgba(106,247,167,0.5)':'transparent'};display:flex;align-items:center;justify-content:center;`;
    if (checked) { box2.innerHTML = '<span style="color:#fff;font-size:10px;line-height:1;">✓</span>'; }
    const lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    lbl.textContent = labelText;
    wr.appendChild(box2);
    wr.appendChild(lbl);

  } else if (r.type === 'spinbox') {
    const val = wp[r.src] !== undefined ? wp[r.src] : 0;
    wr.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:flex;align-items:center;padding:0 4px;box-sizing:border-box;gap:2px;';
    const inner = document.createElement('div');
    inner.style.cssText = 'flex:1;border:1px solid rgba(255,255,255,0.2);border-radius:3px;height:calc(100% - 6px);display:flex;align-items:center;padding:0 6px;';
    inner.innerHTML = `<span style="font-size:12px;color:#fff;">${val}</span>`;
    const arrows = document.createElement('div');
    arrows.style.cssText = 'display:flex;flex-direction:column;gap:1px;';
    arrows.innerHTML = '<div style="font-size:8px;color:rgba(255,255,255,0.5);line-height:1;">▲</div><div style="font-size:8px;color:rgba(255,255,255,0.5);line-height:1;">▼</div>';
    wr.appendChild(inner);
    wr.appendChild(arrows);

  } else if (r.type === 'combo') {
    const selected = wp[r.src] || '';
    wr.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:flex;align-items:center;padding:0 6px;justify-content:space-between;box-sizing:border-box;';
    const text = document.createElement('span');
    text.style.cssText = 'font-size:12px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;';
    text.textContent = selected;
    const arrow = document.createElement('span');
    arrow.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.5);flex-shrink:0;margin-left:4px;';
    arrow.textContent = '▾';
    wr.appendChild(text);
    wr.appendChild(arrow);
  }

  el.appendChild(wr);
}

/* ───── Render ───── */
function renderBox(box) {
  let el = document.getElementById(`box-${box.id}`);
  const def = box.widgetType ? getWidgetDef(box.widgetType) : null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'box-item';
    el.id = `box-${box.id}`;

    // Widget type badge
    const badge = document.createElement('div');
    badge.className = 'box-type-badge';
    el.appendChild(badge);

    // Label
    const lbl = document.createElement('div');
    lbl.className = 'box-label';
    lbl.textContent = box.label;
    el.appendChild(lbl);

    // Resize handles (shown when selected)
    ['nw','n','ne','e','se','s','sw','w'].forEach(dir => {
      const h = document.createElement('div');
      h.className = `resize-handle ${dir}`;
      h.dataset.dir = dir;
      h.style.display = 'none';
      el.appendChild(h);
      h.addEventListener('mousedown', onResizeStart);
    });

    boxLayer.appendChild(el);
    el.addEventListener('mousedown', onBoxMouseDown);
    el.addEventListener('contextmenu', e => {
      if (mode !== 'select') return;
      e.preventDefault();
      e.stopPropagation();
      // Locked EntryClass: show its own context menu (with 编辑EntryClass option)
      if (isLockedEntryClass(box)) {
        selectBox(box.id);
        renderAll();
        showBoxCtxMenu(e.clientX, e.clientY, box);
        return;
      }
      // Child of locked EntryClass: redirect to the EntryClass context menu
      const lockedEc = getLockedEntryClassAncestor(box);
      if (lockedEc) {
        selectBox(lockedEc.id);
        renderAll();
        showBoxCtxMenu(e.clientX, e.clientY, lockedEc);
        return;
      }
      // Child of an isEntryClass box: redirect to the isEntryClass box context menu
      const ecAncestor = getIsEntryClassAncestor(box);
      if (ecAncestor) {
        selectBox(ecAncestor.id);
        renderAll();
        showBoxCtxMenu(e.clientX, e.clientY, ecAncestor);
        return;
      }
      selectBox(box.id);
      renderAll();
      showBoxCtxMenu(e.clientX, e.clientY, box);
    });
  }

  el.style.left    = box.x + 'px';
  el.style.top     = box.y + 'px';
  el.style.width   = box.w + 'px';
  el.style.height  = box.h + 'px';
  // Declare isSelected early so preview-mode checks below can use it
  const isSelected = box.id === selectedId;
  // Preview mode: invisible containers show only a thin dashed guide (not selected)
  const isInvisibleContainer = INVISIBLE_CONTAINER_TYPES.has(box.widgetType);
  // Allow uidata to override bgImage in preview mode (keeps edit mode clean)
  const _bgImageOverride = (_previewMode && _uidataMap[box.id] && _uidataMap[box.id].bgImage) || null;
  const _activeBgImage = _bgImageOverride || box.bgImage;
  if (_previewMode && isInvisibleContainer && !isSelected && !_activeBgImage) {
    el.style.border = '1px dashed rgba(255,255,255,0.12)';
    el.style.background = 'transparent';
  } else {
    el.style.border = (_previewMode && isInvisibleContainer && !isSelected)
      ? '1px dashed rgba(255,255,255,0.12)'
      : `${box.borderWidth}px solid ${box.borderColor}`;
    if (_activeBgImage) {
      el.style.background = `url('${_activeBgImage}') no-repeat center/${box.bgSize || 'cover'}, ${box.bgColor}`;
    } else {
      el.style.background = box.bgColor;
    }
  }
  el.style.opacity = box.opacity;
  el.style.borderRadius = (box.borderRadius || 0) + 'px';
  el.style.boxShadow = (_previewMode && isInvisibleContainer && !isSelected) ? '' : (box.boxShadow || '');
  el.style.filter = box.filter || '';
  el.style.backdropFilter = box.backdropFilter || '';

  // Locked EntryClass (inside TileView/ListView/TreeView): selectable, pointer-events active
  const locked = isLockedEntryClass(box);
  const lockedByAncestor = !locked && !!getLockedEntryClassAncestor(box);
  const isEcAncestor = !locked && !lockedByAncestor && !!getIsEntryClassAncestor(box);
  if (locked) {
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.style.cursor = '';  // allow normal interaction (select/drag for scale editing)
    el.style.pointerEvents = 'auto';
    el.title = 'EntryClass — 点击选中，拖拽边框调整尺寸，右键可编辑';
  } else if (lockedByAncestor) {
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.style.cursor = 'not-allowed';
    el.style.pointerEvents = 'none'; // clicks fall through to the EntryClass parent
    el.title = '此控件在 EntryClass 内部，不可单独操作';
  } else if (isEcAncestor) {
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.style.cursor = 'not-allowed';
    el.style.pointerEvents = 'none'; // clicks fall through to the isEntryClass parent
    el.title = '此控件在 EntryClass 内部 — 右键 EntryClass 可单独打开编辑';
  } else {
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.style.cursor = '';
    el.style.pointerEvents = '';
    el.title = box.description || '';
  }
  // Preview mode: hide CSS outline for invisible containers (don't override locked EntryClass outline)
  if (_previewMode && isInvisibleContainer && !isSelected && !locked) {
    el.style.outline = 'none';
    el.style.outlineOffset = '';
  }
  // If description exists and title hasn't been set by the lock block, append it
  if (!locked && !lockedByAncestor && !isEcAncestor && box.description) {
    el.title = box.description;
  }
  // Children of locked EntryClass or isEntryClass boxes are truly locked (not the EntryClass itself)
  const isEffectivelyLocked = lockedByAncestor || isEcAncestor;
  // Label is always hidden on canvas; visible in right panel when node is selected
  const labelEl = el.querySelector('.box-label');
  if (labelEl) {
    labelEl.style.display = 'none';
    if (box.description) labelEl.title = `📝 ${box.description}`;
    else labelEl.removeAttribute('title');
  }

  const badge = el.querySelector('.box-type-badge');
  badge.style.display = 'none'; // type is now shown inline in the label

  // Ensure widgetProps defaults are populated before rendering (session may lack new props)
  if (def && def.props) {
    if (!box.widgetProps) box.widgetProps = {};
    def.props.forEach(p => {
      if (box.widgetProps[p.key] === undefined) {
        box.widgetProps[p.key] = p.default !== undefined ? p.default
          : (p.type === 'checkbox' ? false : p.type === 'number' ? 0 : '');
      }
    });
  }

  // Widget-specific content rendering (data-driven from elements.json)
  renderWidgetContent(box, el, def);

  // Theme overlay — purely visual, never stored in session JSON
  applyThemeOverlay(el, box);

  el.classList.toggle('selected', isSelected);
  // Show resize handles for selected boxes; locked EntryClass itself CAN be resized (it controls entry size),
  // but its children/descendants cannot.
  el.querySelectorAll('.resize-handle').forEach(h => {
    h.style.display = (isSelected && !lockedByAncestor) ? 'block' : 'none';
  });

  // Anchor indicator (shows on canvas when selected)
  let ancEl = el.querySelector('.anchor-indicator');
  if (isSelected) {
    if (!ancEl) {
      ancEl = document.createElement('div');
      ancEl.className = 'anchor-indicator';
      ancEl.style.cssText = 'position:absolute;pointer-events:none;z-index:10';
      el.appendChild(ancEl);
    }
    const a = box.anchor || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const hStretch = a.minX !== a.maxX;
    const vStretch = a.minY !== a.maxY;
    // Position the indicator relative to the box
    const ix = a.minX * box.w;
    const iy = a.minY * box.h;
    const iw = hStretch ? (a.maxX - a.minX) * box.w : 0;
    const ih = vStretch ? (a.maxY - a.minY) * box.h : 0;
    if (hStretch || vStretch) {
      ancEl.style.left   = ix + 'px';
      ancEl.style.top    = iy + 'px';
      ancEl.style.width  = (hStretch ? iw : 0) + 'px';
      ancEl.style.height = (vStretch ? ih : 0) + 'px';
      ancEl.style.border = '1.5px dashed rgba(255,220,60,0.75)';
      ancEl.style.borderRadius = '0';
      ancEl.innerHTML = '';
    } else {
      const S = 12;
      ancEl.style.left   = (ix - S / 2) + 'px';
      ancEl.style.top    = (iy - S / 2) + 'px';
      ancEl.style.width  = S + 'px';
      ancEl.style.height = S + 'px';
      ancEl.style.border = 'none';
      ancEl.innerHTML = `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">
        <polygon points="${S/2},1 ${S-1},${S/2} ${S/2},${S-1} 1,${S/2}" fill="rgba(255,220,60,0.9)" stroke="rgba(0,0,0,0.5)" stroke-width="0.8"/>
      </svg>`;
    }
    ancEl.style.display = '';
  } else if (ancEl) {
    ancEl.style.display = 'none';
  }

  // EntryClass preview — support both box.entryClassRef and widgetProps.entryClass
  const _ecPath = box.entryClassRef || (box.widgetProps && box.widgetProps.entryClass) || '';
  if (_ecPath) {
    const _ecBox = _ecPath === box.entryClassRef ? box : Object.assign({}, box, { entryClassRef: _ecPath });
    renderEntryClassPreview(_ecBox, el);
  } else {
    el.querySelectorAll('.ec-preview-box').forEach(x => x.remove());
  }

  // TileView / ListView grid preview
  if (box.widgetType === 'TileView' || box.widgetType === 'ListView') {
    renderTileViewGrid(box, el);
  } else {
    el.querySelectorAll('.tile-grid-item').forEach(x => x.remove());
  }
}

/* ───── EntryClass Editor Modal ───── */
function showEntryClassEditor(tileBox) {
  const entryBox = boxes.find(b => b.parentId === tileBox.id && (b.label === 'EntryClass' || b.isEntryClass));
  if (!entryBox) { showToast('⚠ 未找到 EntryClass 子节点'); log('未找到 EntryClass', 'warn'); return; }

  function getSubtree(pid, _seen = new Set()) {
    if (_seen.has(pid)) return [];
    _seen.add(pid);
    const ch = boxes.filter(b => b.parentId === pid);
    return ch.reduce((acc, c) => acc.concat(c, getSubtree(c.id, _seen)), []);
  }

  const ox = entryBox.x, oy = entryBox.y;
  const entryChildren = getSubtree(entryBox.id);
  // Deep copies: EntryClass at (8,8), children normalized relative to it
  const entryId0 = entryBox.id;
  let _ecBoxes = [
    { ...JSON.parse(JSON.stringify(entryBox)), x: 8, y: 8, parentId: null },
    ...entryChildren.map(c => ({ ...JSON.parse(JSON.stringify(c)), x: c.x - ox + 8, y: c.y - oy + 8, parentId: c.parentId === entryBox.id ? entryId0 : c.parentId }))
  ];

  let _ecSelId = null;
  let _ecNextId = Math.max(..._ecBoxes.map(b => b.id).filter(id => typeof id === 'number'), 1000) + 1;

  // ── Overlay ──
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9900;display:flex;flex-direction:column;';

  // Header
  const hdr = document.createElement('div');
  hdr.style.cssText = 'height:44px;background:#1a1a2e;border-bottom:1px solid #3a3a5c;display:flex;align-items:center;padding:0 14px;gap:10px;flex-shrink:0;';
  hdr.innerHTML = `<span style="color:#f5c542;font-weight:bold;font-size:14px;">✏ 编辑 EntryClass</span><span style="color:#666;font-size:11px;margin-right:8px;">${tileBox.label}</span><span style="color:#555;font-size:11px;">拖拽画布绘制 · 点击选择 · 右键设类型 · Del删除 · 金框=EntryClass可调整大小</span>`;
  const saveBtn = document.createElement('button');
  saveBtn.textContent = '💾 保存';
  saveBtn.style.cssText = 'margin-left:auto;padding:5px 16px;background:#4a7c59;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕ 取消';
  cancelBtn.style.cssText = 'padding:5px 12px;background:#333350;color:#ccc;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
  hdr.appendChild(saveBtn); hdr.appendChild(cancelBtn);
  overlay.appendChild(hdr);

  // Canvas
  const cvArea = document.createElement('div');
  cvArea.style.cssText = 'flex:1;overflow:auto;position:relative;background:#0d0d1e;';
  overlay.appendChild(cvArea);
  document.body.appendChild(overlay);

  // ── Render ──
  function _ecRender() {
    cvArea.innerHTML = '';
    _ecBoxes.forEach(b => {
      const isEntry = b.id === entryId0;
      const el = document.createElement('div');
      const def = getWidgetDef(b.widgetType);
      el.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border:${b.borderWidth||1}px solid ${b.borderColor||'#7c6af7'};background:${b.bgColor||'rgba(124,106,247,0.06)'};box-sizing:border-box;overflow:hidden;user-select:none;cursor:${isEntry?'se-resize':'move'};`;
      if (isEntry) {
        el.style.outline = ''; el.style.outlineOffset = '';
        el.title = 'EntryClass — 拖拽调整大小';
      } else if (b.id === _ecSelId) {
        el.style.outline = '2px solid #7c6af7';
      }
      const lbl = document.createElement('div');
      lbl.style.cssText = 'position:absolute;top:2px;left:4px;right:4px;font-size:10px;color:rgba(255,255,255,0.55);pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      lbl.textContent = def ? `${b.label} (${def.label})` : b.label;
      el.appendChild(lbl);

      // SE resize handle for selected non-entry boxes
      if (!isEntry && b.id === _ecSelId) {
        const rh = document.createElement('div');
        rh.style.cssText = 'position:absolute;right:0;bottom:0;width:10px;height:10px;background:#7c6af7;cursor:se-resize;z-index:1;';
        rh.addEventListener('mousedown', e => {
          e.stopPropagation();
          const sx = e.clientX, sy = e.clientY, ow = b.w, oh = b.h;
          const mv = e2 => { b.w = Math.max(20, ow + e2.clientX - sx); b.h = Math.max(20, oh + e2.clientY - sy); _ecRender(); };
          const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
          document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        });
        el.appendChild(rh);
      }

      el.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.stopPropagation();
        if (isEntry) {
          const sx = e.clientX, sy = e.clientY, ow = b.w, oh = b.h;
          // Snapshot children's original positions/sizes for proportional scaling
          const origSnap = _ecBoxes.slice(1).map(c => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h }));
          const mv = e2 => {
            const newW = Math.max(20, ow + e2.clientX - sx);
            const newH = Math.max(20, oh + e2.clientY - sy);
            const scX = newW / ow, scY = newH / oh;
            b.w = newW; b.h = newH;
            _ecBoxes.slice(1).forEach(c => {
              const o = origSnap.find(s => s.id === c.id); if (!o) return;
              c.x = 8 + (o.x - 8) * scX; c.y = 8 + (o.y - 8) * scY;
              c.w = Math.max(4, o.w * scX); c.h = Math.max(4, o.h * scY);
            });
            _ecRender();
          };
          const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
          document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        } else {
          _ecSelId = b.id; _ecRender();
          const sx = e.clientX - b.x, sy = e.clientY - b.y;
          const mv = e2 => { b.x = e2.clientX - sx; b.y = e2.clientY - sy; _ecRender(); };
          const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
          document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        }
      });

      el.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        if (isEntry) return;
        _ecSelId = b.id; _ecRender();
        const cm = document.createElement('div');
        cm.style.cssText = `position:fixed;left:${Math.min(e.clientX, window.innerWidth-180)}px;top:${Math.min(e.clientY, window.innerHeight-320)}px;background:#1a1a2e;border:1px solid #3a3a5c;border-radius:6px;padding:4px 0;z-index:10001;min-width:170px;max-height:340px;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,0.6);`;
        const delItem = document.createElement('div');
        delItem.style.cssText = 'padding:7px 14px;cursor:pointer;color:#ff6b6b;font-size:12px;';
        delItem.textContent = '🗑 删除此框';
        delItem.addEventListener('click', () => { _ecBoxes = _ecBoxes.filter(x => x.id !== b.id); _ecSelId = null; _ecRender(); cm.remove(); });
        cm.appendChild(delItem);
        const sep = document.createElement('div'); sep.style.cssText = 'margin:3px 0;border-top:1px solid #3a3a5c;'; cm.appendChild(sep);
        ALL_WIDGET_TYPES.forEach(w => {
          const wi = document.createElement('div');
          wi.style.cssText = `padding:5px 14px;cursor:pointer;font-size:12px;color:${w.color};`;
          wi.textContent = `${w.icon} ${w.label_zh || w.label}`;
          wi.addEventListener('click', () => { b.widgetType = w.type; b.borderColor = w.color; b.bgColor = w.bg; b.widgetProps = initWidgetProps(w); _ecRender(); cm.remove(); });
          cm.appendChild(wi);
        });
        document.body.appendChild(cm);
        const dismiss = e2 => { if (!cm.contains(e2.target)) { cm.remove(); document.removeEventListener('mousedown', dismiss); } };
        setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
      });

      cvArea.appendChild(el);
    });
  }

  _ecRender();

  // Draw on canvas background
  cvArea.addEventListener('mousedown', e => {
    if (e.target !== cvArea) return;
    _ecSelId = null;
    const rect = cvArea.getBoundingClientRect();
    const sx = e.clientX - rect.left + cvArea.scrollLeft;
    const sy = e.clientY - rect.top + cvArea.scrollTop;
    const prev = document.createElement('div');
    prev.style.cssText = `position:absolute;left:${sx}px;top:${sy}px;width:0;height:0;border:2px dashed #7c6af7;box-sizing:border-box;pointer-events:none;`;
    cvArea.appendChild(prev);
    const mv = e2 => {
      const cx = e2.clientX - rect.left + cvArea.scrollLeft, cy = e2.clientY - rect.top + cvArea.scrollTop;
      const l = Math.min(sx, cx), t = Math.min(sy, cy);
      prev.style.left = l + 'px'; prev.style.top = t + 'px';
      prev.style.width = Math.abs(cx - sx) + 'px'; prev.style.height = Math.abs(cy - sy) + 'px';
    };
    const up = e2 => {
      prev.remove();
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      const cx = e2.clientX - rect.left + cvArea.scrollLeft, cy = e2.clientY - rect.top + cvArea.scrollTop;
      const l = Math.round(Math.min(sx, cx)), t = Math.round(Math.min(sy, cy));
      const w = Math.round(Math.abs(cx - sx)), h = Math.round(Math.abs(cy - sy));
      if (w < 8 || h < 8) return;
      const nb = { id: _ecNextId++, x: l, y: t, w, h, label: `Box${_ecNextId-1}`, borderColor: '#7c6af7', bgColor: 'rgba(124,106,247,0.06)', borderWidth: 1, opacity: 1, widgetType: null, parentId: entryId0, anchor: {minX:0,minY:0,maxX:0,maxY:0}, widgetProps: {} };
      _ecBoxes.push(nb); _ecSelId = nb.id; _ecRender();
    };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });

  // Keyboard
  const onKey = e => {
    if (!overlay.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && _ecSelId && _ecSelId !== entryId0) {
      _ecBoxes = _ecBoxes.filter(b => b.id !== _ecSelId); _ecSelId = null; _ecRender();
    }
  };
  document.addEventListener('keydown', onKey);

  // Save
  saveBtn.addEventListener('click', () => {
    saveState();
    function allDesc(pid, _seen = new Set()) {
      if (_seen.has(pid)) return [];
      _seen.add(pid);
      const ch = boxes.filter(b => b.parentId === pid);
      return ch.reduce((a, c) => a.concat(c, allDesc(c.id, _seen)), []);
    }
    const toRemove = new Set(allDesc(entryBox.id).map(b => b.id));
    const kept = boxes.filter(b => !toRemove.has(b.id));
    // Update entryBox size
    entryBox.w = _ecBoxes[0].w; entryBox.h = _ecBoxes[0].h;
    // Restore children with offset
    const newChildren = _ecBoxes.slice(1).map(b => ({
      ...JSON.parse(JSON.stringify(b)),
      x: b.x - 8 + ox, y: b.y - 8 + oy,
      parentId: b.parentId === entryId0 ? entryBox.id : b.parentId
    }));
    boxes.length = 0;
    kept.forEach(b => boxes.push(b));
    newChildren.forEach(b => boxes.push(b));
    recomputeAllParents();
    renderAll(); autoSave();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    log('EntryClass 已保存', 'ok');
  });

  cancelBtn.addEventListener('click', () => { overlay.remove(); document.removeEventListener('keydown', onKey); });
}

/* ── Open EntryClass in a new browser tab as its own canvas session ── */
/* ── Open EntryClass in main canvas by directly switching canvas context (in-memory) ── */
// Stack to support returning to parent canvas after editing an EntryClass
const _canvasStack = [];

function _showReturnBar(label) {
  let bar = document.getElementById('ec-return-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ec-return-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99990;background:#1a2a1a;border-bottom:2px solid #4a7c59;display:flex;align-items:center;padding:0 14px;height:36px;gap:10px;font-size:13px;color:#cfe8cf;';
    bar.innerHTML = `<span style="color:#7fcc7f">✏ 正在编辑 EntryClass</span><span id="ec-return-label" style="color:#aaa;font-size:11px;"></span><button id="ec-return-btn" style="margin-left:auto;padding:4px 14px;background:#2d5e3a;color:#7fcc7f;border:1px solid #4a7c59;border-radius:4px;cursor:pointer;font-size:12px;">← 返回主画布</button>`;
    document.body.appendChild(bar);
    document.getElementById('ec-return-btn').addEventListener('click', _returnToParentCanvas);
  }
  const lbl = document.getElementById('ec-return-label');
  if (lbl) lbl.textContent = label ? `(${label})` : '';
  bar.style.display = 'flex';
}

function _hideReturnBar() {
  const bar = document.getElementById('ec-return-bar');
  if (bar) bar.style.display = 'none';
}

function _returnToParentCanvas() {
  if (!_canvasStack.length) { _hideReturnBar(); return; }
  const prev = _canvasStack.pop();

  // Sync EC edits back into prev.boxes:
  // current boxes[0] = the EntryClass (normalized to x:8, y:8)
  // remaining boxes = its descendants (also normalized)
  const editedEcBox = boxes[0]; // the EntryClass itself (parentId===null in EC edit mode)
  if (editedEcBox) {
    // Find original EC box in prev.boxes by ID
    const origEc = prev.boxes.find(b => b.id === editedEcBox.id);
    if (origEc) {
      const ox = origEc.x, oy = origEc.y;
      // Sync size changes
      origEc.w = editedEcBox.w; origEc.h = editedEcBox.h;
      // Remove all old descendants of EC from prev.boxes
      function allDescIds(pid, arr, _seen = new Set()) {
        if (_seen.has(pid)) return [];
        _seen.add(pid);
        const ch = arr.filter(b => b.parentId === pid);
        return ch.reduce((acc, c) => acc.concat(c.id, allDescIds(c.id, arr, _seen)), []);
      }
      const oldChildIds = new Set(allDescIds(origEc.id, prev.boxes));
      prev.boxes = prev.boxes.filter(b => !oldChildIds.has(b.id));
      // Re-add descendants with original coordinate offset restored
      const newChildren = boxes.slice(1).map(c => ({
        ...JSON.parse(JSON.stringify(c)),
        x: c.x - 8 + ox,
        y: c.y - 8 + oy
      }));
      newChildren.forEach(c => prev.boxes.push(c));
    }
  }

  // Restore parent canvas
  boxes.length = 0;
  prev.boxes.forEach(b => boxes.push(b));
  nextId = prev.nextId;
  selectedId = null;

  // Update session path BEFORE clearing ecEditMode so saveState→autoSave uses correct path
  setActiveSession(prev.sessionName, prev.sessionPath);
  _ecEditMode = false;

  saveState(); // saves to undo stack; autoSave() fires with correct _sessionPath
  renderAll();
  requestAnimationFrame(() => zoomToFit()); // Re-fit viewport after returning to parent canvas
  if (_canvasStack.length === 0) _hideReturnBar();
  else _showReturnBar(_canvasStack[_canvasStack.length - 1].ecLabel);
  log('已返回主画布（EC 修改已同步）', 'ok');
}

async function openEntryClassInCanvas(tileBox, entryBox) {
  const eb = entryBox || boxes.find(b => b.parentId === tileBox.id && (b.label === 'EntryClass' || b.isEntryClass));
  if (!eb) { showToast('⚠ 未找到 EntryClass 子节点'); log('未找到 EntryClass', 'warn'); return; }

  function getSubtree(pid, _seen = new Set()) {
    if (_seen.has(pid)) return [];
    _seen.add(pid);
    const ch = boxes.filter(b => b.parentId === pid);
    return ch.reduce((acc, c) => acc.concat(c, getSubtree(c.id, _seen)), []);
  }
  const ecChildren = getSubtree(eb.id);
  const ox = eb.x, oy = eb.y;

  // Push current canvas to stack before switching
  _canvasStack.push({
    boxes: JSON.parse(JSON.stringify(boxes)),
    nextId,
    sessionName: _sessionName,
    sessionPath: _sessionPath,
    ecLabel: tileBox.label || 'EntryClass'
  });

  // Build the EC canvas: EntryClass at (8,8), children normalized
  const newBoxes = [
    { ...JSON.parse(JSON.stringify(eb)), x: 8, y: 8, parentId: null },
    ...ecChildren.map(c => ({
      ...JSON.parse(JSON.stringify(c)),
      x: c.x - ox + 8, y: c.y - oy + 8,
      parentId: c.parentId
    }))
  ];

  boxes.length = 0;
  newBoxes.forEach(b => boxes.push(b));
  selectedId = null;
  _ecEditMode = true;
  saveState();
  renderAll();
  requestAnimationFrame(() => zoomToFit());

  _showReturnBar(tileBox.label || 'EntryClass');
  log(`🎨 正在编辑 EntryClass「${tileBox.label}」— 点击"← 返回主画布"完成`, 'ok');
}

async function openEntryClassInNewTab(tileBox, entryBox) {
  const eb = entryBox || boxes.find(b => b.parentId === tileBox.id && (b.label === 'EntryClass' || b.isEntryClass));
  if (!eb) { showToast('⚠ 未找到 EntryClass 子节点'); log('未找到 EntryClass', 'warn'); return; }

  function getSubtree(pid, _seen = new Set()) {
    if (_seen.has(pid)) return [];
    _seen.add(pid);
    const ch = boxes.filter(b => b.parentId === pid);
    return ch.reduce((acc, c) => acc.concat(c, getSubtree(c.id, _seen)), []);
  }
  const ecChildren = getSubtree(eb.id);
  const ox = eb.x, oy = eb.y;
  const ecBoxes = [
    { ...JSON.parse(JSON.stringify(eb)), x: 8, y: 8, parentId: null },
    ...ecChildren.map(c => ({
      ...JSON.parse(JSON.stringify(c)),
      x: c.x - ox + 8, y: c.y - oy + 8,
      parentId: c.parentId === eb.id ? eb.id : c.parentId
    }))
  ];
  const filePath = `sessions/entryclass/tmp_ec_${eb.id}.session`;
  const content = JSON.stringify({
    version: '1.1',
    boxes: serializeBoxes(ecBoxes),
    nextId: Math.max(...ecBoxes.map(b => b.id).filter(id => typeof id === 'number'), 0) + 1,
    isEntryClass: true,
    entryClassLabel: tileBox.label,
    savedAt: new Date().toISOString()
  }, null, 2);
  try {
    const res = await fetch('/docs/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: filePath, content })
    });
    const data = await res.json();
    if (data.success) {
      const url = location.pathname + '?ecload=' + encodeURIComponent(filePath);
      window.open(url, '_blank');
      log(`🔗 EntryClass 已在新标签页打开`, 'ok');
    } else {
      log('⚠ 无法保存临时 Session：' + (data.error || ''), 'err');
    }
  } catch (e) {
    log('⚠ 网络错误：' + e.message, 'err');
  }
}


const _ecCache = {};// path → {boxes, ts}
async function renderEntryClassPreview(box, el) {
  const path = box.entryClassRef;
  if (!path) return;
  try {
    if (!_ecCache[path] || Date.now() - _ecCache[path].ts > 5000) {
      const res = await fetch(`/docs/api/get?name=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!data.success) return;
      const session = JSON.parse(data.content);
      _ecCache[path] = { boxes: session.boxes || [], ts: Date.now() };
    }
    const ecBoxes = _ecCache[path].boxes;
    el.querySelectorAll('.ec-preview-box').forEach(x => x.remove());
    if (!ecBoxes.length) return;

    const minX = Math.min(...ecBoxes.map(b => b.x));
    const minY = Math.min(...ecBoxes.map(b => b.y));
    const maxX = Math.max(...ecBoxes.map(b => b.x + b.w));
    const maxY = Math.max(...ecBoxes.map(b => b.y + b.h));
    const srcW = maxX - minX || 1;
    const srcH = maxY - minY || 1;
    const pad = 4;
    const scale = Math.min((box.w - pad * 2) / srcW, (box.h - pad * 2) / srcH);

    ecBoxes.forEach(b => {
      const mini = document.createElement('div');
      mini.className = 'ec-preview-box';
      mini.style.cssText = `position:absolute;left:${(b.x-minX)*scale+pad}px;top:${(b.y-minY)*scale+pad}px;width:${b.w*scale}px;height:${b.h*scale}px;border:${Math.max(1,b.borderWidth*scale)}px solid ${b.borderColor};background:${b.bgColor};opacity:${b.opacity};pointer-events:none;box-sizing:border-box;font-size:${Math.max(6,10*scale)}px;color:rgba(255,255,255,0.7);overflow:hidden;`;
      el.appendChild(mini);
    });
  } catch(e) { console.warn('[EC preview]', e); }
}

/* ───── TileView Grid Preview ───── */
function renderTileViewGrid(box, el) {
  // Merge uidata overrides (same pattern as renderWidgetContent — non-destructive)
  const _baseWp = box.widgetProps || {};
  const wp = (_previewMode && _uidataMap[box.id])
    ? Object.assign({}, _baseWp, _uidataMap[box.id])
    : _baseWp;
  const count = Math.max(0, Math.floor(wp.gridPreviewNum || 0));
  if (!count) {
    el.querySelectorAll('.tile-grid-item').forEach(x => x.remove());
    delete el.dataset.tileGridKey;
    return;
  }

  const entry = boxes.find(b => b.parentId === box.id && (b.label === 'EntryClass' || b.isEntryClass));

  // Fallback dimensions from widgetProps when no inline EntryClass child exists
  const itemW = entry ? entry.w : (wp.entryWidth || 0);
  const itemH = entry ? entry.h : (wp.entryHeight || 0);
  if (itemW <= 0 || itemH <= 0) {
    el.querySelectorAll('.tile-grid-item').forEach(x => x.remove());
    delete el.dataset.tileGridKey;
    return;
  }

  const ph = wp.placeHolder || {};
  const gapX = Math.max(0, ph.x || 0);
  const gapY = Math.max(0, ph.y || 0);

  // Start position: from inline entry coords, or (0,0) relative to TileView when using fallback
  const startX = entry ? (entry.x - box.x) : 0;
  const startY = entry ? (entry.y - box.y) : 0;
  const entryBorderColor = entry ? entry.borderColor : null;
  const entryBgColor = entry ? entry.bgColor : null;

  // Rarity → background color for preview items
  const RARITY_BG = {
    normal: 'rgba(40,40,40,0.85)',
    magic:  'rgba(10,30,60,0.88)',
    rare:   'rgba(50,42,0,0.88)',
    unique: 'rgba(60,30,0,0.88)',
    set:    'rgba(10,50,20,0.88)',
  };
  const RARITY_BORDER = {
    normal: '#555',
    magic:  '#4477cc',
    rare:   '#ccaa00',
    unique: '#cc6600',
    set:    '#22aa44',
  };

  // Normalize rarity: uidata uses "common"/"uncommon", previewData uses "normal"/"magic" etc.
  const RARITY_ALIAS = { common: 'normal', uncommon: 'magic' };
  function resolveRarity(r) { const k = (r || 'normal').toLowerCase(); return RARITY_ALIAS[k] || k; }

  // Accept both uidata-level items overlay and session-level previewData (uidata takes priority)
  const rawItems = _previewMode ? (Array.isArray(wp.items)       && wp.items.length       ? wp.items :
                                   Array.isArray(wp.previewData) && wp.previewData.length ? wp.previewData : null) : null;
  const previewItems = rawItems;

  // Skip rebuild if nothing has changed (include preview state in key)
  const tileKey = `${count}|${itemW}|${itemH}|${startX}|${startY}|${gapX}|${gapY}|${box.w}|${box.h}|${entryBorderColor}|${entryBgColor}|${_previewMode}|${previewItems ? previewItems.length : 0}`;
  if (el.dataset.tileGridKey === tileKey) return;
  el.dataset.tileGridKey = tileKey;

  el.querySelectorAll('.tile-grid-item').forEach(x => x.remove());

  const cellW = itemW + gapX;
  const cellH = itemH + gapY;
  const cols = Math.max(1, Math.floor((box.w - startX + gapX) / cellW));

  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const tx = startX + col * cellW;
    const ty = startY + row * cellH;
    if (ty + itemH > box.h + 2) break;
    if (tx < 0 || tx + itemW > box.w + 2) continue; // skip tiles that overflow left/right

    const tile = document.createElement('div');
    tile.className = 'tile-grid-item';
    const isExternal = !entry && wp.entryClass;

    // Preview mode: render actual item data if previewData is provided
    if (previewItems && i < previewItems.length) {
      const item = previewItems[i];
      const rarity = resolveRarity(item.rarity);
      const bg = RARITY_BG[rarity] || RARITY_BG.normal;
      const bc = RARITY_BORDER[rarity] || RARITY_BORDER.normal;
      tile.style.cssText = `position:absolute;left:${tx}px;top:${ty}px;width:${itemW}px;height:${itemH}px;border:1px solid ${bc};background:${bg};opacity:1;pointer-events:none;box-sizing:border-box;border-radius:2px;overflow:hidden;`;
      if (item.icon) {
        const img = document.createElement('img');
        img.src = item.icon;
        img.style.cssText = `position:absolute;inset:4px;width:calc(100% - 8px);height:calc(100% - 8px);object-fit:contain;pointer-events:none;`;
        img.onerror = () => { img.style.display = 'none'; };
        tile.appendChild(img);
      }
      const cnt = parseInt(item.count, 10);
      if (cnt > 1) {
        const countEl = document.createElement('div');
        countEl.textContent = String(cnt);
        countEl.style.cssText = 'position:absolute;bottom:2px;right:3px;font-size:9px;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000;pointer-events:none;line-height:1;';
        tile.appendChild(countEl);
      }
      // Show hotkey badge (beltQuick-style items with "key" field)
      if (item.key) {
        const keyEl = document.createElement('div');
        keyEl.textContent = String(item.key);
        keyEl.style.cssText = 'position:absolute;top:2px;left:3px;font-size:8px;color:rgba(255,255,180,0.75);text-shadow:0 0 3px #000;pointer-events:none;line-height:1;';
        tile.appendChild(keyEl);
      }
    } else {
      tile.style.cssText = `position:absolute;left:${tx}px;top:${ty}px;width:${itemW}px;height:${itemH}px;border:1px dashed ${entryBorderColor || box.borderColor || '#888'};background:${entryBgColor || (isExternal ? 'rgba(124,106,247,0.07)' : 'rgba(255,255,255,0.04)')};opacity:${isExternal ? '0.55' : '0.45'};pointer-events:none;box-sizing:border-box;border-radius:2px;`;
      // Show entryClass name badge on first tile when using external session reference
      if (isExternal && i === 0) {
        const badge = document.createElement('div');
        badge.textContent = wp.entryClass;
        badge.style.cssText = 'position:absolute;bottom:2px;left:2px;right:2px;font-size:8px;color:rgba(200,180,255,0.6);text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;pointer-events:none;';
        tile.appendChild(badge);
      }
    }
    el.appendChild(tile);
  }
}

/* ───── Dynamic Widget Props (config-driven) ───── */
function renderWidgetProps(box) {
  const def = box.widgetType ? getWidgetDef(box.widgetType) : null;
  if (!def || !def.props || !def.props.length) return;

  if (!box.widgetProps) box.widgetProps = {};
  // Initialize defaults for any missing keys
  def.props.forEach(p => {
    if (box.widgetProps[p.key] === undefined) {
      box.widgetProps[p.key] = p.default !== undefined ? p.default : (p.type === 'checkbox' ? false : p.type === 'number' ? 0 : '');
    }
  });

  const section = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'prop-section-title';
  title.textContent = `${def.label_zh || def.label} 属性`;
  section.appendChild(title);

  def.props.forEach(prop => {
    const uid = `wp-${box.id}-${prop.key}`;
    const row = document.createElement('div');
    const val = box.widgetProps[prop.key];

    if (prop.type === 'vector2d') {
      row.className = 'prop-row';
      row.style.gap = '4px';
      const v = val || {x:0, y:0};
      row.innerHTML = `<label style="width:64px;flex-shrink:0">${prop.label}</label><span style="font-size:11px;color:#888">X</span><input type="number" id="${uid}-x" value="${v.x||0}" step="${prop.step||1}" min="${prop.min||0}" style="width:52px"/><span style="font-size:11px;color:#888">Y</span><input type="number" id="${uid}-y" value="${v.y||0}" step="${prop.step||1}" min="${prop.min||0}" style="width:52px"/>`;
    } else if (prop.type === 'textarea') {
      row.className = 'prop-row';
      row.style.alignItems = 'flex-start';
      row.innerHTML = `<label style="padding-top:3px">${prop.label}</label><textarea id="${uid}" rows="3" style="flex:1;background:var(--bg-dark);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:12px;padding:3px 5px;resize:vertical">${val||''}</textarea>`;
    } else if (prop.type === 'checkbox' || prop.type === 'boolean') {
      row.className = 'prop-row';
      row.innerHTML = `<label>${prop.label}</label><input type="checkbox" id="${uid}" ${val?'checked':''} style="width:16px;height:16px;cursor:pointer"/>`;
    } else if (prop.type === 'range') {
      row.className = 'prop-row';
      row.style.flexWrap = 'wrap';
      const mn = prop.min !== undefined ? prop.min : 0;
      const mx = prop.max !== undefined ? prop.max : 1;
      const st = prop.step !== undefined ? prop.step : 0.01;
      row.innerHTML = `<label>${prop.label}</label><input type="range" id="${uid}" value="${val!==undefined?val:mn}" min="${mn}" max="${mx}" step="${st}" style="flex:1"/><span id="${uid}-disp" style="font-size:11px;color:#aaa;min-width:36px;text-align:right;">${val!==undefined?+val.toFixed(3):mn}</span>`;
    } else if (prop.type === 'select') {
      row.className = 'prop-row';
      const opts = (prop.options||[]).map(o=>`<option value="${o}" ${val===o?'selected':''}>${o}</option>`).join('');
      row.innerHTML = `<label>${prop.label}</label><select id="${uid}" style="flex:1;background:var(--bg-dark);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:12px">${opts}</select>`;
    } else if (prop.type === 'color') {
      row.className = 'color-row';
      row.innerHTML = `<label>${prop.label}</label><input type="color" id="${uid}" value="${val||prop.default||'#ffffff'}"/>`;
    } else {
      row.className = 'prop-row';
      const isNum = prop.type === 'number';
      const isImgProp = !isNum && (prop.key === 'imagePath' || prop.key === 'src' || prop.key === 'bgImage');
      const extra = isNum ? `min="${prop.min!==undefined?prop.min:''}" max="${prop.max!==undefined?prop.max:''}" step="${prop.step||1}"` : '';
      row.innerHTML = `<label>${prop.label}</label><input type="${isNum?'number':'text'}" id="${uid}" value="${val!==undefined?val:''}" ${extra} style="flex:1;min-width:0"/>` +
        (isImgProp ? `<button onclick="openImgBrowser(window._rightPanelBox,'${prop.key}')" title="浏览图片" style="padding:2px 6px;font-size:11px;cursor:pointer;border-radius:3px;border:1px solid #56cfba;background:var(--bg-dark);color:#56cfba;flex-shrink:0">🖼️</button>` : '');
    }
    section.appendChild(row);
  });

  propPanel.appendChild(section);

  // Show _da* / _ue* meta annotations in widgetProps as info badges
  const metaKeys = Object.keys(box.widgetProps || {}).filter(k => k.startsWith('_'));
  if (metaKeys.length > 0) {
    const metaDiv = document.createElement('div');
    metaDiv.innerHTML = `<div class="prop-section-title" style="color:#d4a84b">🔗 UE 纹理注解</div>` +
      metaKeys.map(k => {
        const v = box.widgetProps[k];
        return `<div class="prop-row" style="flex-wrap:wrap;gap:2px">
          <span style="font-size:10px;color:#888;width:100%">${k}</span>
          <code style="font-size:10px;color:#d4a84b;word-break:break-all">${typeof v === 'string' ? v : JSON.stringify(v)}</code>
        </div>`;
      }).join('');
    propPanel.appendChild(metaDiv);
  }

  // Bind events
  def.props.forEach(prop => {
    const uid = `wp-${box.id}-${prop.key}`;
    if (prop.type === 'vector2d') {
      const ex = document.getElementById(`${uid}-x`);
      const ey = document.getElementById(`${uid}-y`);
      if (!box.widgetProps[prop.key]) box.widgetProps[prop.key] = {x:0,y:0};
      const update = () => {
        box.widgetProps[prop.key].x = +ex.value||0;
        box.widgetProps[prop.key].y = +ey.value||0;
        renderAll(); autoSave();
      };
      if (ex) ex.addEventListener('input', update);
      if (ey) ey.addEventListener('input', update);
    } else {
      const el = document.getElementById(uid);
      if (!el) return;
      const evType = (prop.type === 'checkbox' || prop.type === 'boolean') ? 'change' : 'input';
      el.addEventListener(evType, () => {
        let v;
        if (prop.type === 'checkbox' || prop.type === 'boolean') v = el.checked;
        else if (prop.type === 'number' || prop.type === 'range') {
          v = parseFloat(el.value);
          if (prop.min !== undefined) v = Math.max(prop.min, v);
          if (prop.max !== undefined) v = Math.min(prop.max, v);
          // Update range display
          const disp = document.getElementById(`${uid}-disp`);
          if (disp) disp.textContent = +v.toFixed(3);
        } else {
          v = el.value;
        }
        if (!box.widgetProps) box.widgetProps = {};
        box.widgetProps[prop.key] = v;
        renderAll();
        autoSave();
      });
    }
  });

  // Special: TileView/ListView/TreeView — EntryClass size controls
  if (ENTRY_CLASS_TYPES.includes(def.type)) {
    const entry = boxes.find(b => b.parentId === box.id && (b.label === 'EntryClass' || b.isEntryClass));
    if (entry) {
      const sec2 = document.createElement('div');
      const t2 = document.createElement('div');
      t2.className = 'prop-section-title';
      t2.textContent = 'EntryClass 尺寸';
      sec2.appendChild(t2);
      const wRow = document.createElement('div');
      wRow.className = 'prop-row';
      wRow.innerHTML = `<label>宽度</label><input type="number" id="ec-sz-w" value="${entry.w}" min="10" step="1" style="flex:1"/>`;
      const hRow = document.createElement('div');
      hRow.className = 'prop-row';
      hRow.innerHTML = `<label>高度</label><input type="number" id="ec-sz-h" value="${entry.h}" min="10" step="1" style="flex:1"/>`;
      sec2.appendChild(wRow);
      sec2.appendChild(hRow);
      propPanel.appendChild(sec2);
      const ecw = document.getElementById('ec-sz-w');
      const ech = document.getElementById('ec-sz-h');
      // Helper: get all descendants of a box
      function _ecAllDesc(pid, _seen = new Set()) {
        if (_seen.has(pid)) return [];
        _seen.add(pid);
        const ch = boxes.filter(b => b.parentId === pid);
        return ch.reduce((a, c) => a.concat(c, _ecAllDesc(c.id, _seen)), []);
      }
      if (ecw) ecw.addEventListener('input', () => {
        const newW = Math.max(10, +ecw.value || 10);
        const scX = newW / entry.w;
        _ecAllDesc(entry.id).forEach(c => {
          c.x = entry.x + (c.x - entry.x) * scX;
          c.w = Math.max(4, c.w * scX);
        });
        entry.w = newW;
        renderAll(); autoSave();
      });
      if (ech) ech.addEventListener('input', () => {
        const newH = Math.max(10, +ech.value || 10);
        const scY = newH / entry.h;
        _ecAllDesc(entry.id).forEach(c => {
          c.y = entry.y + (c.y - entry.y) * scY;
          c.h = Math.max(4, c.h * scY);
        });
        entry.h = newH;
        renderAll(); autoSave();
      });
    }
  }
}

/* ───── Box Context Menu ───── */
let _boxCtxMenu = null;
const GROUP_ORDER = ['文本', '按钮', '输入', '图像', '列表', '反馈', '工具', '容器', '特殊'];
const GROUP_ICONS = { '文本':'🔤','按钮':'🔘','输入':'⌨','图像':'🖼','列表':'📋','反馈':'📊','工具':'🔧','容器':'📦','特殊':'🔩' };

function showBoxCtxMenu(x, y, box) {
  if (_boxCtxMenu) { _boxCtxMenu.remove(); _boxCtxMenu = null; }

  // Group widgets by category
  const groups = {};
  ALL_WIDGET_TYPES.forEach(w => {
    const g = WIDGET_GROUPS[w.type] || '特殊';
    if (!groups[g]) groups[g] = [];
    groups[g].push(w);
  });

  const menu = document.createElement('div');
  menu.className = 'bctx-menu';
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:99999`;

  GROUP_ORDER.forEach(cat => {
    const items = groups[cat];
    if (!items || !items.length) return;

    const row = document.createElement('div');
    row.className = 'bctx-item has-sub';
    const icon = GROUP_ICONS[cat] || '◆';
    row.innerHTML = `<span class="bctx-cat-icon">${icon}</span><span class="bctx-cat-name">${cat}</span><span class="bctx-arrow">▶</span>`;

    const sub = document.createElement('div');
    sub.className = 'bctx-submenu';

    items.forEach(w => {
      const si = document.createElement('div');
      si.className = 'bctx-sub-item' + (box.widgetType === w.type ? ' active' : '');
      si.innerHTML = `<span class="bctx-dot" style="background:${w.color}"></span><span class="bctx-sub-label">${w.icon} ${w.label}</span><small class="bctx-sub-zh">${w.label_zh}</small>`;
      si.title = w.desc || w.label_zh;
      si.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
      });
      si.addEventListener('click', e => {
        e.stopPropagation();
        saveState();
        box.widgetType = w.type;
        box.borderColor = w.color;
        box.bgColor = w.bg;
        box.widgetProps = initWidgetProps(w);
        ensureTileViewEntry(box);
        renderAll();
        menu.remove(); _boxCtxMenu = null;
        log(`设为 <${w.label}>: ${box.label}`, 'ok');
      });
      sub.appendChild(si);
    });

    row.appendChild(sub);
    menu.appendChild(row);
  });

  // Divider
  const div1 = document.createElement('div');
  div1.className = 'bctx-divider';
  menu.appendChild(div1);

  // Bring to front (among siblings)
  const bringFront = document.createElement('div');
  bringFront.className = 'bctx-item';
  bringFront.innerHTML = '<span class="bctx-cat-icon">⬆</span><span>设为最表层</span>';
  bringFront.addEventListener('click', () => {
    saveState();
    const parentId = box.parentId;
    boxes = boxes.filter(b => b.id !== box.id);
    // Insert after the last sibling
    let insertIdx = boxes.length;
    for (let i = boxes.length - 1; i >= 0; i--) {
      if (boxes[i].parentId === parentId) { insertIdx = i + 1; break; }
    }
    boxes.splice(insertIdx, 0, box);
    renderAll(); autoSave();
    menu.remove(); _boxCtxMenu = null;
    log(`${box.label} 已置为最表层`, 'ok');
  });
  menu.appendChild(bringFront);

  // Reset sibling order (sort by creation id)
  const resetOrder = document.createElement('div');
  resetOrder.className = 'bctx-item';
  resetOrder.innerHTML = '<span class="bctx-cat-icon">↕</span><span>重置同层顺序</span>';
  resetOrder.addEventListener('click', () => {
    saveState();
    const parentId = box.parentId;
    const siblings = boxes.filter(b => b.parentId === parentId).sort((a, b) => a.id - b.id);
    const sibSet = new Set(siblings.map(b => b.id));
    const positions = [];
    boxes.forEach((b, i) => { if (sibSet.has(b.id)) positions.push(i); });
    positions.forEach((pos, i) => { boxes[pos] = siblings[i]; });
    renderAll(); autoSave();
    menu.remove(); _boxCtxMenu = null;
    log('同层节点顺序已重置', 'dim');
  });
  menu.appendChild(resetOrder);

  // Divider2
  const div2 = document.createElement('div');
  div2.className = 'bctx-divider';
  menu.appendChild(div2);

  // isEntryClass box(root entryclass in canvas): show "编辑 EntryClass" to open its session
  if (box.isEntryClass) {
    const div3 = document.createElement('div');
    div3.className = 'bctx-divider';
    menu.appendChild(div3);

    const ecOpenEdit = document.createElement('div');
    ecOpenEdit.className = 'bctx-item';
    ecOpenEdit.innerHTML = '<span class="bctx-cat-icon">✏️</span><span>编辑 EntryClass（打开 Session）</span>';
    ecOpenEdit.addEventListener('click', async () => {
      menu.remove(); _boxCtxMenu = null;
      // 1. 优先用已记录的 session 路径
      let sessionPath = box.entryClassSessionPath || box.entryClassRef || null;
      // 2. Fallback：用 label 构造标准路径
      if (!sessionPath && box.label) {
        const safeName = box.label.replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '_');
        sessionPath = `sessions/entryclass/${safeName}.session`;
      }
      if (sessionPath && window.loadSessionFile) {
        await window.loadSessionFile(sessionPath);
      } else {
        showToast('⚠ 未找到关联 Session，请重新保存为 EntryClass');
        log('entryclass session 路径未记录，请重新保存', 'err');
      }
    });
    menu.appendChild(ecOpenEdit);
  }

  // EntryClass binding (for EntryClass boxes labeled as such, or flagged with isEntryClass)
  if (box.label === 'EntryClass' || box.isEntryClass) {
    // 编辑EntryClass: 打开独立模态编辑器 (仅针对 TileView 内的锁定 EntryClass)
    if (isLockedEntryClass(box)) {
      const ecEdit = document.createElement('div');
      ecEdit.className = 'bctx-item';
      ecEdit.innerHTML = `<span class="bctx-cat-icon">✏️</span><span>编辑 EntryClass（加载到画布）</span>`;
      ecEdit.addEventListener('click', async () => {
        menu.remove(); _boxCtxMenu = null;
        const container = boxes.find(b => b.id === box.parentId);
        if (!container) return;
        // Extract EntryClass subtree and load into main canvas
        await openEntryClassInCanvas(container, box);
      });
      menu.appendChild(ecEdit);

      // Open EntryClass in new tab
      const ecTabEdit = document.createElement('div');
      ecTabEdit.className = 'bctx-item';
      ecTabEdit.innerHTML = '<span class="bctx-cat-icon">🔗</span><span>在新标签页编辑 EntryClass</span>';
      ecTabEdit.addEventListener('click', async () => {
        menu.remove(); _boxCtxMenu = null;
        const container = boxes.find(b => b.id === box.parentId);
        if (container) await openEntryClassInNewTab(container, box);
      });
      menu.appendChild(ecTabEdit);

      const ecDiv = document.createElement('div');
      ecDiv.className = 'bctx-divider';
      menu.appendChild(ecDiv);
    }

    const ecItem = document.createElement('div');
    ecItem.className = 'bctx-item';
    ecItem.innerHTML = `<span class="bctx-cat-icon">🔗</span><span>选择EntryClass模板${box.entryClassRef ? ' ✓' : ''}</span>`;
    ecItem.addEventListener('click', async () => {
      menu.remove(); _boxCtxMenu = null;
      await showEntryClassPicker(box, x, y);
    });
    menu.appendChild(ecItem);

    if (box.entryClassRef) {
      const ecClear = document.createElement('div');
      ecClear.className = 'bctx-item';
      ecClear.innerHTML = '<span class="bctx-cat-icon">⊗</span><span>清除EntryClass</span>';
      ecClear.addEventListener('click', () => {
        saveState();
        delete box.entryClassRef;
        renderAll(); autoSave();
        menu.remove(); _boxCtxMenu = null;
        log('EntryClass 已清除', 'dim');
      });
      menu.appendChild(ecClear);
    }
  }

  // Clear type
  const clr = document.createElement('div');
  clr.className = 'bctx-item';
  clr.innerHTML = '<span class="bctx-cat-icon">⊘</span><span>清除类型</span>';
  clr.addEventListener('click', () => {
    saveState();
    box.widgetType = null;
    box.borderColor = '#7c6af7';
    box.bgColor = 'rgba(124,106,247,0.06)';
    renderAll();
    menu.remove(); _boxCtxMenu = null;
    log('已清除控件类型', 'dim');
  });
  menu.appendChild(clr);

  // TileView/ListView/TreeView: "编辑 EntryClass" shortcut
  if (ENTRY_CLASS_TYPES.includes(box.widgetType)) {
    const ecEditDiv = document.createElement('div');
    ecEditDiv.className = 'bctx-divider';
    menu.appendChild(ecEditDiv);
    const ecEditBtn = document.createElement('div');
    ecEditBtn.className = 'bctx-item';
    ecEditBtn.innerHTML = '<span class="bctx-cat-icon">✏️</span><span>编辑 EntryClass</span>';
    ecEditBtn.addEventListener('click', () => {
      menu.remove(); _boxCtxMenu = null;
      showEntryClassEditor(box);
    });
    menu.appendChild(ecEditBtn);
  }

  // Rename
  const ren = document.createElement('div');
  ren.className = 'bctx-item';
  ren.innerHTML = '<span class="bctx-cat-icon">✏</span><span>重命名</span>';
  ren.addEventListener('click', () => {
    menu.remove(); _boxCtxMenu = null;
    // Focus the name input in right_info panel
    renderProps();
    requestAnimationFrame(() => {
      const labelInput = document.getElementById('p-label');
      if (labelInput) { labelInput.focus(); labelInput.select(); }
    });
  });
  menu.appendChild(ren);

  // Description
  const descItem = document.createElement('div');
  descItem.className = 'bctx-item';
  const descHasIcon = box.description ? '💬' : '📝';
  descItem.innerHTML = `<span class="bctx-cat-icon">${descHasIcon}</span><span>${box.description ? '编辑描述' : '添加描述'}</span>`;
  descItem.addEventListener('click', () => {
    menu.remove(); _boxCtxMenu = null;
    showDescriptionModal(box);
  });
  menu.appendChild(descItem);

  // Save as EntryClass
  const ecDiv = document.createElement('div');
  ecDiv.className = 'bctx-divider';
  menu.appendChild(ecDiv);

  const ecItem = document.createElement('div');
  ecItem.className = 'bctx-item';
  ecItem.innerHTML = '<span class="bctx-cat-icon">📐</span><span>设置为 EntryClass</span>';
  ecItem.addEventListener('click', () => {
    menu.remove(); _boxCtxMenu = null;
    showSaveEntryClassModal(box);
  });
  menu.appendChild(ecItem);

  // Load EntryClass template (apply to this box)
  const ecLoadItem = document.createElement('div');
  ecLoadItem.className = 'bctx-item';
  ecLoadItem.innerHTML = '<span class="bctx-cat-icon">🗂</span><span>加载 EntryClass 模板</span>';
  ecLoadItem.addEventListener('click', async () => {
    menu.remove(); _boxCtxMenu = null;
    await showEntryClassPicker(box, x, y);
  });
  menu.appendChild(ecLoadItem);

  // ── Layer order divider ──
  const divOrder = document.createElement('div');
  divOrder.className = 'bctx-divider';
  menu.appendChild(divOrder);

  // Bring to absolute front (last in boxes array → renders on top)
  const mkOrderItem = (icon, label, handler) => {
    const it = document.createElement('div');
    it.className = 'bctx-item';
    it.innerHTML = `<span class="bctx-cat-icon">${icon}</span><span>${label}</span>`;
    it.addEventListener('click', () => { saveState(); menu.remove(); _boxCtxMenu = null; handler(); syncZOrder(); renderAll(); autoSave(); });
    return it;
  };

  menu.appendChild(mkOrderItem('⬆⬆', '设置为最表层', () => {
    // Move box to very end of boxes array (renders on top of all)
    const idx = boxes.findIndex(b => b.id === box.id);
    if (idx !== -1 && idx !== boxes.length - 1) {
      boxes.splice(idx, 1);
      boxes.push(box);
      log(`${box.label} → 最表层`, 'ok');
    }
  }));

  menu.appendChild(mkOrderItem('⬆', '同层置顶', () => {
    // Move box to be last among its siblings in the boxes array (renders on top of siblings)
    const pid = box.parentId;
    // Find the last index occupied by a sibling
    let lastSibIdx = -1;
    for (let i = boxes.length - 1; i >= 0; i--) {
      if (boxes[i].parentId === pid && boxes[i].id !== box.id) { lastSibIdx = i; break; }
    }
    const curIdx = boxes.findIndex(b => b.id === box.id);
    if (curIdx !== -1 && lastSibIdx > curIdx) {
      boxes.splice(curIdx, 1);
      // After removal, lastSibIdx shifts by -1
      boxes.splice(lastSibIdx, 0, box);
    } else if (curIdx !== -1 && lastSibIdx === -1) {
      // No other siblings, bring to absolute front
      boxes.splice(curIdx, 1);
      boxes.push(box);
    }
    log(`${box.label} → 同层置顶`, 'ok');
  }));

  menu.appendChild(mkOrderItem('↺', '重置同层节点顺序', () => {
    // Sort siblings in-place by creation id, keeping their slots in the global array
    const pid = box.parentId;
    const siblingIndices = [];
    const sortedSiblings = [];
    boxes.forEach((b, i) => { if (b.parentId === pid) { siblingIndices.push(i); sortedSiblings.push(b); } });
    sortedSiblings.sort((a, b) => a.id - b.id);
    siblingIndices.forEach((pos, i) => { boxes[pos] = sortedSiblings[i]; });
    log('已重置同层节点顺序', 'ok');
  }));

  // Delete
  const del = document.createElement('div');
  del.className = 'bctx-item danger';
  del.innerHTML = '<span class="bctx-cat-icon">🗑</span><span>删除</span>';
  del.addEventListener('click', () => {
    try {
      saveState();
      const toDelete = new Set(collectDescendants(box.id));
      toDelete.forEach(id => document.getElementById(`box-${id}`)?.remove());
      boxes = boxes.filter(b => !toDelete.has(b.id));
      if (toDelete.has(selectedId)) selectedId = null;
      renderAll();
      menu.remove(); _boxCtxMenu = null;
      log('删除 ' + box.label + (toDelete.size > 1 ? ' 及 ' + (toDelete.size - 1) + ' 个子节点' : ''), 'warn');
    } catch(err) {
      log('删除失败: ' + err.message, 'error');
      console.error('[删除]', err);
    }
  });
  menu.appendChild(del);

  document.body.appendChild(menu);
  _boxCtxMenu = menu;

  // Flip if off-screen
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth)  menu.style.left = (x - r.width) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = (y - r.height) + 'px';
    // Mark submenus that need to open left
    menu.querySelectorAll('.bctx-item.has-sub').forEach(row => {
      row.addEventListener('mouseenter', () => {
        const sub = row.querySelector('.bctx-submenu');
        if (!sub) return;
        const sr = sub.getBoundingClientRect();
        if (sr.right > window.innerWidth) sub.classList.add('flip-left');
        else sub.classList.remove('flip-left');
      });
    });
  });

  const dismiss = e => {
    if (_boxCtxMenu && !_boxCtxMenu.contains(e.target)) {
      _boxCtxMenu.remove(); _boxCtxMenu = null;
      document.removeEventListener('mousedown', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
}


// Reorder DOM elements inside boxLayer to match boxes array (last = highest z-order)
function syncZOrder() {
  boxes.forEach(b => {
    const el = document.getElementById(`box-${b.id}`);
    if (el) boxLayer.appendChild(el); // appendChild moves existing node to end
  });
}

function renderAll() {
  if (_rafRenderPending) return;
  _rafRenderPending = true;
  requestAnimationFrame(() => {
    _rafRenderPending = false;
    _renderAllNow();
  });
}

function _renderAllNow() {
  // Rebuild O(1) id→box lookup cache used by ancestor-query functions
  _boxById = Object.fromEntries(boxes.map(b => [b.id, b]));

  // Remove deleted boxes from DOM
  const ids = new Set(boxes.map(b => b.id));
  boxLayer.querySelectorAll('.box-item').forEach(el => {
    if (!ids.has(parseBoxId(el.id.replace('box-', '')))) el.remove();
  });

  boxes.forEach(b => renderBox(b));
  syncZOrder(); // ensure children always appear above parents in the DOM
  renderLayers();
  renderProps();
}

// Fast render during drag: only update CSS positions, skip DOM rebuild
function renderPositionsOnly() {
  boxes.forEach(b => {
    const el = document.getElementById('box-' + b.id);
    if (!el) { renderBox(b); return; } // new box: full render
    el.style.left   = b.x + 'px';
    el.style.top    = b.y + 'px';
    el.style.width  = b.w + 'px';
    el.style.height = b.h + 'px';
    // Invalidate tile-grid cache so it rebuilds after drag ends (positions changed)
    delete el.dataset.tileGridKey;
  });
}

/* ───── Simple Context Menu (global, for hierarchy/layer panels) ───── */
let _simpleCtxMenu = null;
function showSimpleCtxMenu(x, y, items) {
  if (_simpleCtxMenu) { _simpleCtxMenu.remove(); _simpleCtxMenu = null; }
  const menu = document.createElement('div');
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;background:#1e2028;border:1px solid rgba(255,255,255,0.12);border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,0.5);z-index:99999;min-width:140px;overflow:hidden`;
  items.forEach(item => {
    if (item.divider) {
      const d = document.createElement('div');
      d.style.cssText = 'height:1px;background:rgba(255,255,255,0.08);margin:3px 0';
      menu.appendChild(d);
      return;
    }
    const btn = document.createElement('div');
    btn.style.cssText = 'padding:7px 14px;cursor:pointer;font-size:13px;color:#e8eaf0;white-space:nowrap;transition:background 0.1s';
    btn.textContent = item.label;
    btn.onmouseenter = () => btn.style.background = 'rgba(255,255,255,0.08)';
    btn.onmouseleave = () => btn.style.background = '';
    btn.addEventListener('click', () => { menu.remove(); _simpleCtxMenu = null; item.action(); });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  _simpleCtxMenu = menu;
  const dismiss = e => { if (!menu.contains(e.target)) { menu.remove(); _simpleCtxMenu = null; document.removeEventListener('mousedown', dismiss); } };
  setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
}

function renderLayers() {
  // Left sidebar layer list — event delegation (attach listener once)
  if (layerList) {
    if (!layerList._delegated) {
      layerList._delegated = true;
      layerList.addEventListener('click', e => {
        const li = e.target.closest('li[data-id]');
        if (!li) return;
        selectBox(parseBoxId(li.dataset.id)); renderAll();
      });
    }
    layerList.innerHTML = '';
    // Only show root-level boxes (no parent); nested items are visible in the hierarchy tree
    [...boxes].filter(b => !b.parentId).reverse().forEach(box => {
      const def = getWidgetDef(box.widgetType);
      const icon = def ? def.icon : '⬜';
      const typeStr = box.widgetType || 'CanvasPanel';
      const li = document.createElement('li');
      li.title = `${box.label} · ${typeStr} #${box.id}`;
      const displayLabel = box.label || typeStr;
      li.innerHTML = `<span style="color:${def ? def.color : 'var(--text-dim)'}">${icon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:2px">${displayLabel}</span><span style="color:var(--text-dim);font-size:10px;flex-shrink:0">(${typeStr})</span>`;
      li.dataset.id = box.id;
      if (box.id === selectedId) li.classList.add('selected');
      layerList.appendChild(li);
    });
    // Scroll selected item into view
    if (selectedId !== null) {
      const sel = layerList.querySelector('li.selected');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
  }

  // Right panel hierarchy list — tree view
  if (hierarchyList) {
    if (!hierarchyList._delegated) {
      hierarchyList._delegated = true;
      hierarchyList.addEventListener('click', e => {
        const li = e.target.closest('li[data-id]');
        if (!li) return;
        const clickedBox = _boxById[parseBoxId(li.dataset.id)];
        if (!clickedBox) return;
        const lockedEc = getLockedEntryClassAncestor(clickedBox);
        const target = lockedEc ? lockedEc : clickedBox;
        selectBox(target.id);
        renderAll();
        const propsTab = document.querySelector('.right-tab[data-tab="props"]');
        if (propsTab) propsTab.click();
      });
      hierarchyList.addEventListener('contextmenu', e => {
        const li = e.target.closest('li[data-id]');
        if (!li) return;
        e.preventDefault();
        const box = _boxById[parseBoxId(li.dataset.id)];
        if (!box) return;
        showSimpleCtxMenu(e.clientX, e.clientY, [
          { label: '📋 复制节点信息 (JSON)', action: () => {
            const info = { id: box.id, label: box.label, widgetType: box.widgetType,
              x: box.x, y: box.y, w: box.w, h: box.h,
              parentId: box.parentId || null, widgetProps: box.widgetProps || {} };
            copyToClipboard(JSON.stringify(info, null, 2))
              .then(() => showToast('📋 节点信息已复制'));
          }},
          { label: '📐 复制位置 (x,y,w,h)', action: () => {
            copyToClipboard(`x:${box.x} y:${box.y} w:${box.w} h:${box.h}`)
              .then(() => showToast('📐 位置已复制'));
          }},
          { label: '🏷 复制 ID', action: () => {
            copyToClipboard(String(box.id))
              .then(() => showToast('🏷 ID 已复制: ' + box.id));
          }},
        ]);
      });
    }
    hierarchyList.innerHTML = '';
    if (!boxes.length) {
      const li = document.createElement('li');
      li.style.color = 'var(--text-dim)';
      li.style.cursor = 'default';
      li.textContent = '暂无节点';
      hierarchyList.appendChild(li);
      return;
    }

    // Build parent→children map
    const childrenOf = {};
    boxes.forEach(b => {
      const pid = b.parentId || '__root__';
      if (!childrenOf[pid]) childrenOf[pid] = [];
      childrenOf[pid].push(b);
    });

    const renderedIds = new Set(); // cycle guard: each box rendered at most once
    function appendNodes(parentKey, depth) {
      if (depth > 64) return; // hard cap to prevent infinite recursion
      const children = childrenOf[parentKey] || [];
      // Render in reverse order (top of stack first)
      [...children].reverse().forEach(box => {
        if (renderedIds.has(box.id)) return; // cycle guard
        renderedIds.add(box.id);
        const def = getWidgetDef(box.widgetType);
        const icon = def ? def.icon : '⬜';
        const typeLabel = def ? `<${def.label}>` : '';
        const hasChildren = !!(childrenOf[box.id] && childrenOf[box.id].length);
        const li = document.createElement('li');
        li.dataset.id = box.id;
        li.style.paddingLeft = `${12 + depth * 14}px`;
        if (box.id === selectedId) li.classList.add('selected');
        // Label hidden from tree; shown in right-info props panel on selection
        const typeStr = box.widgetType || 'CanvasPanel';
        li.title = `${box.label} · ${typeStr} #${box.id}`;
        const displayLabel = box.label || typeStr;
        li.innerHTML = `<span style="color:var(--text-dim);margin-right:2px;font-size:10px">${hasChildren ? '▾' : '·'}</span><span style="color:${def ? def.color : 'var(--text-dim)'}">${icon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:4px">${displayLabel}</span><span style="color:var(--text-dim);font-size:10px;flex-shrink:0;margin-left:2px">(${typeStr})</span>`;
        hierarchyList.appendChild(li);
        appendNodes(box.id, depth + 1);
      });
    }
    appendNodes('__root__', 0);
    // Scroll selected item into view
    if (selectedId !== null) {
      requestAnimationFrame(() => {
        const sel = hierarchyList.querySelector('li.selected');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
      });
    }
  }
}

function renderProps() {
  if (!selectedId) {
    propPanel.innerHTML = '<div class="empty-hint">未选中任何元素</div>';
    return;
  }
  const box = boxes.find(b => b.id === selectedId);
  if (!box) { propPanel.innerHTML = '<div class="empty-hint">未选中任何元素</div>'; return; }
  window._rightPanelBox = box; // expose for inline onclick buttons (imagePath browser)

  // Locked EntryClass: show only position/size (scale editing only)
  if (isLockedEntryClass(box)) {
    propPanel.innerHTML = `
      <div class="prop-section-title">EntryClass — 整体尺寸</div>
      <div style="font-size:11px;color:var(--text-dim);padding:4px 10px 6px">仅允许调整位置与尺寸，内部控件不可单独编辑</div>
      <div class="prop-row"><label>X</label><input type="number" id="p-x" value="${box.x}" /></div>
      <div class="prop-row"><label>Y</label><input type="number" id="p-y" value="${box.y}" /></div>
      <div class="prop-row"><label>W</label><input type="number" id="p-w" value="${box.w}" /></div>
      <div class="prop-row"><label>H</label><input type="number" id="p-h" value="${box.h}" /></div>
    `;
    // Helper to collect all descendants of a box
    function collectAllDesc(parentId, _seen = new Set()) {
      if (_seen.has(parentId)) return [];
      _seen.add(parentId);
      return boxes.filter(b => b.parentId === parentId).reduce((acc, c) => {
        return acc.concat({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h }, collectAllDesc(c.id, _seen));
      }, []);
    }

    // Snapshot for proportional scaling via props inputs
    let ecSnap = null;
    function captureEcSnap() {
      ecSnap = { x: box.x, y: box.y, w: box.w, h: box.h, children: collectAllDesc(box.id) };
    }
    function applyEcScale() {
      if (!ecSnap || ecSnap.w === 0 || ecSnap.h === 0) return;
      const scaleX = box.w / ecSnap.w;
      const scaleY = box.h / ecSnap.h;
      ecSnap.children.forEach(orig => {
        const child = boxes.find(b => b.id === orig.id);
        if (!child) return;
        child.x = box.x + Math.round((orig.x - ecSnap.x) * scaleX);
        child.y = box.y + Math.round((orig.y - ecSnap.y) * scaleY);
        child.w = Math.max(Math.round(orig.w * scaleX), 10);
        child.h = Math.max(Math.round(orig.h * scaleY), 10);
      });
      // Sync parent widgetProps
      const parent = boxes.find(b => b.id === box.parentId);
      if (parent) {
        if (!parent.widgetProps) parent.widgetProps = {};
        parent.widgetProps.entryWidth  = box.w;
        parent.widgetProps.entryHeight = box.h;
      }
    }

    const bindEc = (id, prop, parse) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('focus', captureEcSnap);
      el.addEventListener('blur', () => { ecSnap = null; });
      el.addEventListener('input', () => {
        saveState();
        box[prop] = parse ? parse(el.value) : el.value;
        if (prop === 'w' || prop === 'h') applyEcScale();
        renderAll();
        autoSave();
      });
    };
    bindEc('p-x', 'x', v => snap(+v));
    bindEc('p-y', 'y', v => snap(+v));
    bindEc('p-w', 'w', v => Math.max(snap(+v), 20));
    bindEc('p-h', 'h', v => Math.max(snap(+v), 20));
    return;
  }

  propPanel.innerHTML = `
    <div style="padding:8px 10px 6px;border-bottom:1px solid var(--border);background:var(--bg-dark)">
      <input type="text" id="p-label" value="${box.label.replace(/"/g,'&quot;')}" style="width:100%;background:transparent;color:var(--accent2);border:none;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;padding:2px 0 4px;outline:none;box-sizing:border-box;" placeholder="节点名称" />
    </div>
    <div class="prop-section-title">控件类型</div>
    <div class="prop-row">
      <label>类型</label>
      <select id="p-widget" style="flex:1;background:var(--bg-dark);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:12px">
        <option value="">— 无 —</option>
        ${ALL_WIDGET_TYPES.map(w => `<option value="${w.type}" ${box.widgetType === w.type ? 'selected' : ''}>${w.icon} &lt;${w.label}&gt;</option>`).join('')}
      </select>
    </div>
    <div class="prop-section-title">位置 & 尺寸</div>
    <div class="prop-row"><label>X</label><input type="number" id="p-x" value="${box.x}" /></div>
    <div class="prop-row"><label>Y</label><input type="number" id="p-y" value="${box.y}" /></div>
    <div class="prop-row"><label>W</label><input type="number" id="p-w" value="${box.w}" /></div>
    <div class="prop-row"><label>H</label><input type="number" id="p-h" value="${box.h}" /></div>
    <div class="prop-section-title">锚点 (Anchor)</div>
    <div id="anchor-picker-wrap">${buildAnchorPickerHTML(box.anchor || {minX:0,minY:0,maxX:0,maxY:0})}</div>
    <div class="prop-row" style="gap:4px">
      <label style="width:60px;flex-shrink:0">最小</label>
      <span style="font-size:11px;color:#888">X</span>
      <input type="number" id="p-anc-minx" step="0.01" min="0" max="1" value="${(box.anchor||{}).minX||0}" style="width:52px"/>
      <span style="font-size:11px;color:#888">Y</span>
      <input type="number" id="p-anc-miny" step="0.01" min="0" max="1" value="${(box.anchor||{}).minY||0}" style="width:52px"/>
    </div>
    <div class="prop-row" style="gap:4px">
      <label style="width:60px;flex-shrink:0">最大</label>
      <span style="font-size:11px;color:#888">X</span>
      <input type="number" id="p-anc-maxx" step="0.01" min="0" max="1" value="${(box.anchor||{}).maxX||0}" style="width:52px"/>
      <span style="font-size:11px;color:#888">Y</span>
      <input type="number" id="p-anc-maxy" step="0.01" min="0" max="1" value="${(box.anchor||{}).maxY||0}" style="width:52px"/>
    </div>
    <div class="prop-section-title">样式</div>
    <div class="prop-row"><label>边框</label><input type="number" id="p-bw" value="${box.borderWidth}" min="0" max="10" /></div>
    <div class="color-row"><label>边框色</label><input type="color" id="p-bc" value="${box.borderColor}" /></div>
    <div class="color-row">
      <label>透明度</label>
      <input type="range" id="p-op" min="0.1" max="1" step="0.05" value="${box.opacity}" />
      <span id="p-op-val">${Math.round(box.opacity * 100)}%</span>
    </div>
    <div class="prop-section-title">CSS 效果</div>
    <div class="prop-row"><label>圆角 px</label><input type="number" id="p-br" value="${box.borderRadius || 0}" min="0" max="200" /></div>
    <div class="prop-row" style="flex-wrap:wrap;gap:4px">
      <label style="width:100%;margin-bottom:2px">阴影</label>
      <input type="text" id="p-bs" placeholder="如 0 4px 12px rgba(0,0,0,0.5)" value="${(box.boxShadow || '').replace(/"/g,'&quot;')}" style="flex:1;min-width:0;font-size:11px;font-family:monospace" />
    </div>
    <div class="prop-row" style="gap:4px;flex-wrap:wrap">
      <span style="font-size:10px;color:var(--text-dim);width:100%">快速阴影：</span>
      <button class="shadow-preset" data-v="" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">无</button>
      <button class="shadow-preset" data-v="0 2px 8px rgba(0,0,0,0.4)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">小</button>
      <button class="shadow-preset" data-v="0 4px 16px rgba(0,0,0,0.55)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">中</button>
      <button class="shadow-preset" data-v="0 8px 32px rgba(0,0,0,0.7)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">大</button>
      <button class="shadow-preset" data-v="0 0 12px 2px rgba(124,106,247,0.7)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">紫光</button>
      <button class="shadow-preset" data-v="0 0 12px 2px rgba(80,200,120,0.7)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">绿光</button>
    </div>
    <div class="prop-row" style="flex-wrap:wrap;gap:4px">
      <label style="width:100%;margin-bottom:2px">滤镜 (filter)</label>
      <input type="text" id="p-filter" placeholder="如 blur(4px) brightness(1.2)" value="${(box.filter || '').replace(/"/g,'&quot;')}" style="flex:1;min-width:0;font-size:11px;font-family:monospace" />
    </div>
    <div class="prop-row" style="gap:4px;flex-wrap:wrap">
      <span style="font-size:10px;color:var(--text-dim);width:100%">快速滤镜：</span>
      <button class="filter-preset" data-v="" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">无</button>
      <button class="filter-preset" data-v="blur(3px)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">模糊</button>
      <button class="filter-preset" data-v="brightness(1.5)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">提亮</button>
      <button class="filter-preset" data-v="grayscale(1)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">灰度</button>
      <button class="filter-preset" data-v="sepia(0.8)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">复古</button>
    </div>
    <div class="prop-row" style="flex-wrap:wrap;gap:4px">
      <label style="width:100%;margin-bottom:2px">背景虚化 (backdrop)</label>
      <input type="text" id="p-backdrop" placeholder="如 blur(8px)" value="${(box.backdropFilter || '').replace(/"/g,'&quot;')}" style="flex:1;min-width:0;font-size:11px;font-family:monospace" />
    </div>
    <div class="prop-row" style="gap:4px;flex-wrap:wrap">
      <span style="font-size:10px;color:var(--text-dim);width:100%">快速毛玻璃：</span>
      <button class="backdrop-preset" data-v="" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">无</button>
      <button class="backdrop-preset" data-v="blur(4px)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">轻</button>
      <button class="backdrop-preset" data-v="blur(10px)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">中</button>
      <button class="backdrop-preset" data-v="blur(20px)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">强</button>
      <button class="backdrop-preset" data-v="blur(12px) saturate(1.8)" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">玻璃</button>
    </div>
    <div class="prop-section-title">背景图片</div>
    <div class="prop-row" style="flex-wrap:wrap;gap:4px">
      <label style="width:100%;margin-bottom:2px">图片路径</label>
      <input type="text" id="p-bgimg" placeholder="如 /assets/bag/bg_main.png" value="${(box.bgImage || '').replace(/"/g,'&quot;')}" style="flex:1;min-width:0;font-size:11px;font-family:monospace" />
    </div>
    <div class="prop-row" style="gap:4px;flex-wrap:wrap">
      <span style="font-size:10px;color:var(--text-dim);width:100%">快速选择：</span>
      <button class="bgimg-preset" data-v="/assets/bag/bg_main.png" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">主背景</button>
      <button class="bgimg-preset" data-v="/assets/bag/bg_equip.png" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">装备栏</button>
      <button class="bgimg-preset" data-v="/assets/bag/bg_stat.png" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">属性栏</button>
      <button class="bgimg-preset" data-v="/assets/bag/slot_bg.png" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">物品槽</button>
      <button class="bgimg-preset" data-v="/assets/bag/equip_slot.png" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">装备槽</button>
      <button class="bgimg-preset" data-v="" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:var(--bg-dark);color:var(--text)">清除</button></div>
    <div class="prop-row" style="gap:4px;flex-wrap:wrap;margin-top:2px">
      <span style="font-size:10px;color:var(--text-dim);width:100%">图片工具：</span>
      <button id="btn-icon-picker" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid var(--accent2,#9b8af7);background:var(--bg-dark);color:var(--accent2,#9b8af7)">🎨 图标库</button>
      <button id="btn-img-browser" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid #56cfba;background:var(--bg-dark);color:#56cfba">🖼️ 浏览</button>
      <button id="btn-koutu" style="font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;border:1px solid #e74c3c;background:var(--bg-dark);color:#e74c3c" title="从四角检测背景色并消除">✂ 扣图</button>
    </div>
    <div class="prop-row" style="gap:4px">
      <label>填充方式</label>
      <select id="p-bgsize" style="flex:1;background:var(--bg-dark);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:12px">
        <option value="cover" ${(box.bgSize||'cover')==='cover'?'selected':''}>cover（铺满裁剪）</option>
        <option value="contain" ${(box.bgSize||'')==='contain'?'selected':''}>contain（完整显示）</option>
        <option value="100% 100%" ${(box.bgSize||'')==='100% 100%'?'selected':''}>100%×100%（拉伸）</option>
        <option value="auto" ${(box.bgSize||'')==='auto'?'selected':''}>auto（原始大小）</option>
      </select>
    </div>
  `;

  const bind = (id, prop, parse) => {
    const el = document.getElementById(id);
    if (!el) return;
    // `input`: live-update box property + visual refresh (RAF-debounced to avoid blocking on rapid keystrokes)
    let _bindRaf = null;
    el.addEventListener('input', () => {
      box[prop] = parse ? parse(el.value) : el.value;
      if (id === 'p-op') document.getElementById('p-op-val').textContent = Math.round(box.opacity * 100) + '%';
      if (_bindRaf === null) { _bindRaf = requestAnimationFrame(() => { _bindRaf = null; renderAll(); }); }
    });
    // `change`: commit to undo history when user finishes (releases slider, tabs out, etc.)
    el.addEventListener('change', () => { saveState(); });
  };
  bind('p-label', 'label');
  const labelEl2 = document.getElementById('p-label');
  if (labelEl2) {
    labelEl2.addEventListener('change', () => log(`重命名 → ${box.label}`, 'ok'));
    labelEl2.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); labelEl2.blur(); } });
  }
  bind('p-x', 'x', v => snap(+v));
  bind('p-y', 'y', v => snap(+v));
  bind('p-w', 'w', v => Math.max(snap(+v), 20));
  bind('p-h', 'h', v => Math.max(snap(+v), 20));
  bind('p-bw', 'borderWidth', v => Math.max(+v, 0));
  bind('p-bc', 'borderColor');
  bind('p-op', 'opacity', parseFloat);
  bind('p-br', 'borderRadius', v => Math.max(+v, 0));
  bind('p-bs', 'boxShadow');
  bind('p-filter', 'filter');
  bind('p-backdrop', 'backdropFilter');
  bind('p-bgimg', 'bgImage');
  bind('p-bgsize', 'bgSize');

  // Shadow preset buttons
  document.querySelectorAll('.shadow-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.v;
      saveState();
      box.boxShadow = v;
      const bsEl = document.getElementById('p-bs');
      if (bsEl) bsEl.value = v;
      renderAll();
      autoSave();
    });
  });

  // Filter preset buttons
  document.querySelectorAll('.filter-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.v;
      saveState();
      box.filter = v;
      const el = document.getElementById('p-filter');
      if (el) el.value = v;
      renderAll();
      autoSave();
    });
  });

  // Backdrop-filter preset buttons
  document.querySelectorAll('.backdrop-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.v;
      saveState();
      box.backdropFilter = v;
      const el = document.getElementById('p-backdrop');
      if (el) el.value = v;
      renderAll();
      autoSave();
    });
  });

  // Background image preset buttons
  document.querySelectorAll('.bgimg-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.v;
      saveState();
      box.bgImage = v || undefined;
      if (!box.bgImage) delete box.bgImage;
      const el = document.getElementById('p-bgimg');
      if (el) el.value = v;
      renderAll();
      autoSave();
    });
  });

  const iconPickerBtn = document.getElementById('btn-icon-picker');
  if (iconPickerBtn) {
    iconPickerBtn.addEventListener('click', () => openIconPicker(box));
  }
  const imgBrowserBtn = document.getElementById('btn-img-browser');
  if (imgBrowserBtn) {
    imgBrowserBtn.addEventListener('click', () => openImgBrowser(box, 'bgImage'));
  }
  
  const koutuBtn = document.getElementById('btn-koutu');
  if (koutuBtn) {
    koutuBtn.addEventListener('click', () => {
      const tol = parseInt(prompt('容差 (0-255, 默认30)', '30') || '30', 10);
      applyBgImageRemoveBg(box, isNaN(tol) ? 30 : tol);
    });
  }

  // Description textarea — set value safely via JS (avoids HTML injection issues)
  // Widget type change
  const widgetSel = document.getElementById('p-widget');
  if (widgetSel) {
    widgetSel.addEventListener('change', () => {
      saveState();
      const t = widgetSel.value || null;
      const def = t ? getWidgetDef(t) : null;
      box.widgetType = t;
      if (def) { box.borderColor = def.color; box.bgColor = def.bg; }
      else { box.borderColor = '#7c6af7'; box.bgColor = 'rgba(124,106,247,0.06)'; }
      // Reinitialize widgetProps for new type
      box.widgetProps = initWidgetProps(def);
      ensureTileViewEntry(box);
      renderAll();
    });
  }

  // Anchor binding
  if (!box.anchor) box.anchor = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const bindAnc = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      box.anchor[key] = Math.min(1, Math.max(0, parseFloat(el.value) || 0));
      refreshAnchorPicker(box.anchor);
      renderAll();
    });
  };
  bindAnc('p-anc-minx', 'minX'); bindAnc('p-anc-miny', 'minY');
  bindAnc('p-anc-maxx', 'maxX'); bindAnc('p-anc-maxy', 'maxY');

  // Anchor picker click — also physically repositions the box to match the anchor
  document.querySelectorAll('.anc-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const a = JSON.parse(cell.dataset.anchor);
      saveState();
      box.anchor = a;
      applyAnchorPreset(box, a);
      document.getElementById('p-anc-minx').value = a.minX;
      document.getElementById('p-anc-miny').value = a.minY;
      document.getElementById('p-anc-maxx').value = a.maxX;
      document.getElementById('p-anc-maxy').value = a.maxY;
      // Sync position/size inputs if visible
      const px = document.getElementById('p-x'); if (px) px.value = box.x;
      const py = document.getElementById('p-y'); if (py) py.value = box.y;
      const pw = document.getElementById('p-w'); if (pw) pw.value = box.w;
      const ph = document.getElementById('p-h'); if (ph) ph.value = box.h;
      refreshAnchorPicker(a);
      recomputeAllParents();
      renderAll();
      autoSave();
    });
  });

  // Dynamic widget-specific properties from elements.json
  renderWidgetProps(box);

  // DataAsset binding badge — show _daBinding / _daPath meta
  if (box._daBinding || box._daRef) {
    const daSection = document.createElement('div');
    daSection.innerHTML = `
      <div class="prop-section-title" style="color:#56cfba">📦 DataAsset 绑定</div>
      ${box._daRef ? `<div class="prop-row" style="flex-wrap:wrap;gap:2px"><span style="font-size:10px;color:#888;width:100%">DA 引用</span><code style="font-size:10px;color:#56cfba;word-break:break-all">${box._daRef}</code></div>` : ''}
      ${box._daBinding ? `<div class="prop-row" style="flex-wrap:wrap;gap:2px"><span style="font-size:10px;color:#888;width:100%">纹理绑定</span><code style="font-size:10px;color:#d4a84b;word-break:break-all">${box._daBinding}</code></div>` : ''}
      ${box._daPath ? `<div class="prop-row" style="flex-wrap:wrap;gap:2px"><span style="font-size:10px;color:#888;width:100%">图片路径</span><code style="font-size:10px;color:#56cfba;word-break:break-all">${box._daPath}</code></div>` : ''}
    `;
    propPanel.appendChild(daSection);
  }
}

/* ───── Selection ───── */
function selectBox(id) {
  selectedId = id;
}

function deselectAll() {
  selectedId = null;
}

/* ───── Box: Move ───── */
let dragState = null;
let _dragRafId = null; // requestAnimationFrame handle for drag throttling

function onBoxMouseDown(e) {
  if (mode !== 'select') return;
  if (e.target.classList.contains('resize-handle')) return;
  e.stopPropagation();
  e.preventDefault();
  // Blur any focused input (e.g. p-label in right panel) so keyboard shortcuts work
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();

  const el = e.currentTarget;
  const id = parseBoxId(el.id.replace('box-', ''));
  const box = boxes.find(b => b.id === id);

  // Locked EntryClass (inside TileView etc.): allow selection only, no independent drag
  if (box && isLockedEntryClass(box)) {
    selectBox(id);
    renderAll();
    return; // no drag — resize handles are the only way to adjust size
  }

  // Child boxes inside a locked EntryClass: redirect click to the EntryClass
  if (box) {
    const lockedEc = getLockedEntryClassAncestor(box);
    if (lockedEc) {
      selectBox(lockedEc.id); renderAll();
      return;
    }
  }

  // Child boxes inside an isEntryClass box: redirect click to the isEntryClass box
  if (box) {
    const ecAncestor = getIsEntryClassAncestor(box);
    if (ecAncestor) {
      selectBox(ecAncestor.id); renderAll();
      return;
    }
  }

  selectBox(id);
  renderAll();

  // Locked EntryClass: allow selection but prevent dragging
  if (isLockedEntryClass(box)) return;

  const rect = canvasRoot.getBoundingClientRect();

  // Collect all recursive descendants so they move with the parent (iterative BFS, O(n))
  function getDescendants(rootId) {
    const childrenOf = {};
    boxes.forEach(b => { if (b.parentId != null) { if (!childrenOf[b.parentId]) childrenOf[b.parentId] = []; childrenOf[b.parentId].push(b); } });
    const result = [];
    const visited = new Set([rootId]);
    const queue = [rootId];
    while (queue.length) {
      const cur = queue.shift();
      (childrenOf[cur] || []).forEach(c => {
        if (!visited.has(c.id)) { visited.add(c.id); result.push(c); queue.push(c.id); }
      });
    }
    return result;
  }
  const descendants = getDescendants(id);

  dragState = {
    type: 'move',
    id,
    startX: e.clientX,
    startY: e.clientY,
    origX: box.x,
    origY: box.y,
    origChildren: descendants.map(c => ({ id: c.id, x: c.x, y: c.y }))
  };
  saveState();
}

/* ───── Box: Resize ───── */
function onResizeStart(e) {
  if (mode !== 'select') return;
  e.stopPropagation();
  e.preventDefault();

  const dir = e.currentTarget.dataset.dir;
  const el  = e.currentTarget.closest('.box-item');
  const id  = parseBoxId(el.id.replace('box-', ''));
  const box = boxes.find(b => b.id === id);

  // Descendants of a locked EntryClass are locked (but the EntryClass itself can be resized)
  if (getLockedEntryClassAncestor(box)) return;
  // Descendants of an isEntryClass box are locked too
  if (getIsEntryClassAncestor(box)) return;

  saveState();

  // Capture initial EntryClass state (and its children) for proportional scaling
  let origEntry = null;
  let cachedEntryId = null;
  if (ENTRY_CLASS_TYPES.includes(box.widgetType)) {
    const entry = boxes.find(b => b.parentId === box.id && (b.label === 'EntryClass' || b.isEntryClass));
    if (entry) {
      cachedEntryId = entry.id;
      // Iterative BFS to collect all descendants of the EntryClass
      function collectDescIter(rootId) {
        const childrenOf = {};
        boxes.forEach(b => { if (b.parentId != null) { if (!childrenOf[b.parentId]) childrenOf[b.parentId] = []; childrenOf[b.parentId].push(b); } });
        const result = [];
        const visited = new Set([rootId]);
        const queue = [rootId];
        while (queue.length) {
          const cur = queue.shift();
          (childrenOf[cur] || []).forEach(c => {
            if (!visited.has(c.id)) { visited.add(c.id); result.push({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h }); queue.push(c.id); }
          });
        }
        return result;
      }
      origEntry = {
        x: entry.x, y: entry.y, w: entry.w, h: entry.h,
        children: collectDescIter(entry.id)
      };
    }
  }

  // If box IS an EntryClass, capture its children for proportional scaling
  let origEcChildren = null;
  if (isLockedEntryClass(box)) {
    function collectEcDesc(parentId, _seen = new Set()) {
      if (_seen.has(parentId)) return [];
      _seen.add(parentId);
      return boxes.filter(b => b.parentId === parentId).reduce((acc, c) => {
        return acc.concat({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h }, collectEcDesc(c.id, _seen));
      }, []);
    }
    origEcChildren = collectEcDesc(box.id);
  }

  dragState = {
    type: 'resize',
    id, dir,
    startX: e.clientX,
    startY: e.clientY,
    origX: box.x, origY: box.y,
    origW: box.w, origH: box.h,
    origEntry,
    entryId: cachedEntryId,
    origEcChildren, origEcX: box.x, origEcY: box.y, origEcW: box.w, origEcH: box.h
  };
}

/* ───── Draw Mode ───── */
let drawStart = null;
let drawPreview = null;

function getCanvasPos(e) {
  const rect = canvasRoot.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / zoom,
    y: (e.clientY - rect.top)  / zoom
  };
}

selOverlay.addEventListener('mousedown', (e) => {
  if (mode !== 'draw') {
    // In select mode, clicking empty canvas deselects
    if (e.target === selOverlay) {
      deselectAll(); renderAll();
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    }
    return;
  }
  e.preventDefault();
  const pos = getCanvasPos(e);

  // In draw mode: clicking near a box's BORDER (within 8px) selects it instead of drawing.
  // Clicking in the interior still draws a new child box.
  const BORDER_HIT = 8;
  const hit = [...boxes].reverse().find(b => {
    if (pos.x < b.x - BORDER_HIT || pos.x > b.x + b.w + BORDER_HIT) return false;
    if (pos.y < b.y - BORDER_HIT || pos.y > b.y + b.h + BORDER_HIT) return false;
    const nearLeft   = pos.x <= b.x + BORDER_HIT;
    const nearRight  = pos.x >= b.x + b.w - BORDER_HIT;
    const nearTop    = pos.y <= b.y + BORDER_HIT;  // also covers label area
    const nearBottom = pos.y >= b.y + b.h - BORDER_HIT;
    return nearLeft || nearRight || nearTop || nearBottom;
  });
  if (hit) {
    setMode('select');
    selectBox(hit.id);
    renderAll();
    return;
  }

  drawStart = pos;
  drawPreview = document.createElement('div');
  drawPreview.id = 'draw-preview';
  drawPreview.style.left   = pos.x + 'px';
  drawPreview.style.top    = pos.y + 'px';
  drawPreview.style.width  = '0px';
  drawPreview.style.height = '0px';
  canvasRoot.appendChild(drawPreview);
});

/* ───── Global Mouse Handlers ───── */
document.addEventListener('mousemove', (e) => {
  if (drawStart && drawPreview) {
    const pos = getCanvasPos(e);
    const x = Math.min(pos.x, drawStart.x);
    const y = Math.min(pos.y, drawStart.y);
    const w = Math.abs(pos.x - drawStart.x);
    const h = Math.abs(pos.y - drawStart.y);
    drawPreview.style.left   = x + 'px';
    drawPreview.style.top    = y + 'px';
    drawPreview.style.width  = w + 'px';
    drawPreview.style.height = h + 'px';
  }

  if (dragState) {
    const dx = (e.clientX - dragState.startX) / zoom;
    const dy = (e.clientY - dragState.startY) / zoom;
    const box = _boxById[dragState.id]; // O(1) lookup
    if (!box) return;

    if (dragState.type === 'move') {
      box.x = snap(dragState.origX + dx);
      box.y = snap(dragState.origY + dy);
      edgeSnap(box);
      box.x = Math.max(0, Math.min(box.x, canvasW() - box.w));
      box.y = Math.max(0, Math.min(box.y, canvasH() - box.h));
      // Move all descendants by the same delta
      if (dragState.origChildren) {
        dragState.origChildren.forEach(orig => {
          const child = _boxById[orig.id]; // O(1) lookup
          if (child) {
            child.x = snap(orig.x + dx);
            child.y = snap(orig.y + dy);
          }
        });
      }
    } else if (dragState.type === 'resize') {
      const d = dragState.dir;
      let { origX, origY, origW, origH } = dragState;
      if (d.includes('e')) box.w = Math.max(snap(origW + dx), 20);
      if (d.includes('s')) box.h = Math.max(snap(origH + dy), 20);
      if (d.includes('w')) {
        const nw = Math.max(snap(origW - dx), 20);
        box.x = snap(origX + (origW - nw));
        box.w = nw;
      }
      if (d.includes('n')) {
        const nh = Math.max(snap(origH - dy), 20);
        box.y = snap(origY + (origH - nh));
        box.h = nh;
      }
      // Auto-scale EntryClass (and its children) when its TileView parent is resized
      if (ENTRY_CLASS_TYPES.includes(box.widgetType) && dragState.origEntry) {
        const entry = dragState.entryId ? _boxById[dragState.entryId] : null; // O(1) using cached id
        if (entry) {
          const oe = dragState.origEntry;
          const scaleX = box.w / dragState.origW;
          const scaleY = box.h / dragState.origH;
          entry.w = Math.max(Math.round(oe.w * scaleX), 20);
          entry.h = Math.max(Math.round(oe.h * scaleY), 20);
          entry.x = box.x + Math.round((oe.x - dragState.origX) * scaleX);
          entry.y = box.y + Math.round((oe.y - dragState.origY) * scaleY);
          // Sync parent widgetProps entryWidth/entryHeight
          if (!box.widgetProps) box.widgetProps = {};
          box.widgetProps.entryWidth  = entry.w;
          box.widgetProps.entryHeight = entry.h;
          // Scale all descendant boxes inside the EntryClass proportionally
          (oe.children || []).forEach(orig => {
            const child = _boxById[orig.id]; // O(1) lookup
            if (!child) return;
            child.w = Math.max(Math.round(orig.w * scaleX), 10);
            child.h = Math.max(Math.round(orig.h * scaleY), 10);
            child.x = entry.x + Math.round((orig.x - oe.x) * scaleX);
            child.y = entry.y + Math.round((orig.y - oe.y) * scaleY);
          });
        }
      }
      // When the EntryClass box itself is resized, sync parent's widgetProps.entryWidth/entryHeight
      // and scale all children proportionally
      if (isLockedEntryClass(box)) {
        const parent = _boxById[box.parentId]; // O(1) lookup
        if (parent) {
          if (!parent.widgetProps) parent.widgetProps = {};
          parent.widgetProps.entryWidth  = box.w;
          parent.widgetProps.entryHeight = box.h;
        }
        // Scale children of EntryClass proportionally
        if (dragState.origEcChildren && dragState.origEcW > 0 && dragState.origEcH > 0) {
          const scaleX = box.w / dragState.origEcW;
          const scaleY = box.h / dragState.origEcH;
          dragState.origEcChildren.forEach(orig => {
            const child = _boxById[orig.id]; // O(1) lookup
            if (!child) return;
            child.x = box.x + Math.round((orig.x - dragState.origEcX) * scaleX);
            child.y = box.y + Math.round((orig.y - dragState.origEcY) * scaleY);
            child.w = Math.max(Math.round(orig.w * scaleX), 10);
            child.h = Math.max(Math.round(orig.h * scaleY), 10);
          });
        }
      }
    }
    // Throttle render to one frame — prevents 60 FPS × O(n) DOM writes
    if (_dragRafId === null) {
      _dragRafId = requestAnimationFrame(() => {
        _dragRafId = null;
        renderPositionsOnly();
      });
    }
  }
});

document.addEventListener('mouseup', (e) => {
  // Finish draw
  if (drawStart && drawPreview) {
    const pos = getCanvasPos(e);
    const x = Math.min(pos.x, drawStart.x);
    const y = Math.min(pos.y, drawStart.y);
    const w = Math.abs(pos.x - drawStart.x);
    const h = Math.abs(pos.y - drawStart.y);
    drawPreview.remove();
    drawPreview = null;
    drawStart = null;

    if (w > 10 && h > 10) {
      saveState();
      const box = createBox(x, y, w, h, null, currentWidgetType);
      boxes.push(box);
      recomputeAllParents(); // update parentId for new box AND existing children
      ensureTileViewEntry(box);
      selectBox(box.id);
      renderAll();
      const typeLabel = currentWidgetType ? `<${currentWidgetType}>` : 'Box';
      log(`绘制 ${typeLabel} ${box.label}  (${Math.round(x)}, ${Math.round(y)})  ${Math.round(box.w)}×${Math.round(box.h)}`, 'ok');
      autoSave(); // persist hierarchy immediately after drawing
      // Auto-switch to select mode so the new box can be dragged immediately
      setMode('select');
    }
  }

  if (dragState) {
    const box = _boxById[dragState.id]; // O(1) lookup
    if (box) {
      if (dragState.type === 'move') {
        recomputeAllParents(); // update parent for moved box AND any boxes now inside it
        log(`移动 ${box.label} → (${box.x}, ${box.y})`, 'dim');
      } else {
        recomputeAllParents(); // resize can also change containment
        log(`调整 ${box.label} → ${box.w}×${box.h}`, 'dim');
      }
      autoSave();
    }
    if (_dragRafId !== null) { cancelAnimationFrame(_dragRafId); _dragRafId = null; }
    dragState = null;
    renderAll(); // full sync after drag ends
  }
});

/* ───── Keyboard ───── */
document.addEventListener('keydown', (e) => {
  // Global shortcuts: work even when inputs are focused
  if (e.key === 'p' || e.key === 'P') { togglePreviewMode(); return; }
  if (e.key === 'f' || e.key === 'F') { zoomToFit(); return; }
  if ((e.key === 'r' || e.key === 'R') && e.shiftKey) { openAssetsPanel(); return; }
  if (e.key === 'Escape') { const ip=document.getElementById('icon-picker-overlay'); if(ip&&ip.style.display==='flex'){closeIconPicker();return;} deselectAll(); renderAll(); return; }

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  if (e.key === 'v' || e.key === 'V') {
    currentWidgetType = null;
    document.querySelectorAll('.palette-item').forEach(b => b.classList.remove('active'));
    setMode('select');
  }
  if (e.key === 'b' || e.key === 'B') setMode('draw');
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Z')) { e.preventDefault(); redo(); }

  // Arrow keys to nudge
  if (selectedId && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    const box = boxes.find(b => b.id === selectedId);
    if (!box) return;
    if (isLockedEntryClass(box)) return; // locked EntryClass: selection only, no nudge
    if (getLockedEntryClassAncestor(box)) return; // children of EntryClass: no arrow movement
    saveState();
    if (e.key === 'ArrowLeft')  box.x = Math.max(0, box.x - d);
    if (e.key === 'ArrowRight') box.x = Math.min(canvasW() - box.w, box.x + d);
    if (e.key === 'ArrowUp')    box.y = Math.max(0, box.y - d);
    if (e.key === 'ArrowDown')  box.y = Math.min(canvasH() - box.h, box.y + d);
    renderAll();
  }
});

/* ───── Mode Switch ───── */
function setMode(m) {
  mode = m;
  btnSelect.classList.toggle('active', m === 'select');
  btnDraw.classList.toggle('active', m === 'draw');
  selOverlay.style.cursor = m === 'draw' ? 'crosshair' : 'default';
  selOverlay.style.pointerEvents = m === 'draw' ? 'auto' : 'none';
  // Clear widget palette selection when manually entering select mode without a type
  if (m === 'select' && !currentWidgetType) {
    document.querySelectorAll('.palette-item').forEach(b => b.classList.remove('active'));
  }
  log(`切换模式: ${m === 'select' ? '选择' : '绘制'}`, 'info');
}

btnSelect.addEventListener('click', () => setMode('select'));
btnDraw.addEventListener('click',   () => setMode('draw'));

/* ───── EntryClass Template Loader ───── */
async function applyEntryClassTemplate(targetBox, templatePath) {
  try {
    const res = await fetch('/docs/api/get?name=' + encodeURIComponent(templatePath));
    const data = await res.json();
    if (!data.success) { showToast('⚠ 无法读取模板：' + (data.error || '')); return; }
    const parsed = JSON.parse(data.content);
    if (!Array.isArray(parsed.boxes) || !parsed.boxes.length) { showToast('⚠ 空模板'); return; }

    // Support both flat (v1.0) and nested-tree (v1.1+) formats
    const flatBoxes = (parsed.version && parsed.version !== '1.0')
      ? deserializeBoxes(parsed.boxes)
      : parsed.boxes;

    // Root = box with no parentId (or first box)
    const rootTpl = flatBoxes.find(b => !b.parentId) || flatBoxes[0];
    const scaleX = targetBox.w / Math.max(rootTpl.w, 1);
    const scaleY = targetBox.h / Math.max(rootTpl.h, 1);

    // Remove existing children of targetBox
    const existingChildIds = new Set(collectDescendants(targetBox.id));
    existingChildIds.delete(targetBox.id);
    existingChildIds.forEach(id => document.getElementById(`box-${id}`)?.remove());
    boxes = boxes.filter(b => !existingChildIds.has(b.id));

    // If targetBox is a locked EntryClass (parent is TileView/ListView/TreeView),
    // also purge stale sibling boxes under the TileView parent that are not targetBox.
    if (isLockedEntryClass(targetBox)) {
      const tileParent = boxes.find(b => b.id === targetBox.parentId);
      if (tileParent) {
        const staleIds = new Set(
          boxes
            .filter(b => b.parentId === tileParent.id && b.id !== targetBox.id)
            .flatMap(b => collectDescendants(b.id))
        );
        staleIds.forEach(id => document.getElementById(`box-${id}`)?.remove());
        boxes = boxes.filter(b => !staleIds.has(b.id));
      }
    }

    // Build ID map (old template id → new id)
    const idMap = {};
    flatBoxes.forEach(b => {
      idMap[b.id] = (b.id === rootTpl.id) ? targetBox.id : nextId++;
    });

    // Import non-root boxes as children of targetBox
    const newBoxes = flatBoxes
      .filter(b => b.id !== rootTpl.id)
      .map(b => ({
        ...b,
        id: idMap[b.id],
        x: Math.round(targetBox.x + b.x * scaleX),
        y: Math.round(targetBox.y + b.y * scaleY),
        w: Math.max(20, Math.round(b.w * scaleX)),
        h: Math.max(20, Math.round(b.h * scaleY)),
        parentId: idMap[b.parentId] ?? targetBox.id,
        anchor: b.anchor || { minX: 0, minY: 0, maxX: 0, maxY: 0 }
      }));

    boxes.push(...newBoxes);
    recomputeAllParents();
    saveState();
    renderAll();
    const tplName = templatePath.split('/').pop().replace(/\.session$/, '');
    log(`📐 EntryClass 模板已应用：${tplName} (${newBoxes.length} 个节点, 缩放 ${scaleX.toFixed(2)}×${scaleY.toFixed(2)})`, 'ok');
    showToast(`📐 已应用 EntryClass「${tplName}」`);
  } catch (e) {
    showToast('⚠ 加载失败：' + e.message);
  }
}

/* ───── Description Modal ───── */
function showDescriptionModal(box) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:200000;display:flex;align-items:center;justify-content:center';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:#1a1a2e;border:1px solid #3a3a5c;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.7);width:420px;max-width:95vw;padding:0;display:flex;flex-direction:column;overflow:hidden';

  const header = document.createElement('div');
  header.style.cssText = 'padding:12px 16px;border-bottom:1px solid #3a3a5c;display:flex;align-items:center;justify-content:space-between';
  header.innerHTML = `<span style="font-weight:600;font-size:14px;color:#ccc">📝 描述 — <em style="color:var(--accent);font-style:normal">${box.label}</em></span>`;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:#888;font-size:16px;cursor:pointer;padding:0 4px';
  closeBtn.onclick = () => overlay.remove();
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const body = document.createElement('div');
  body.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:10px';

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:2px';
  hint.textContent = '描述这个控件的用途，方便团队协作和后续维护。';
  body.appendChild(hint);

  const textarea = document.createElement('textarea');
  textarea.value = box.description || '';
  textarea.placeholder = '例如：显示背包物品格子，点击后触发物品详情弹窗...';
  textarea.style.cssText = 'width:100%;min-height:100px;resize:vertical;background:#0d0d1a;color:#e0e0e0;border:1px solid #3a3a5c;border-radius:6px;padding:8px;font-size:13px;line-height:1.5;outline:none;box-sizing:border-box;font-family:inherit';
  textarea.addEventListener('keydown', e => { if (e.key === 'Escape') overlay.remove(); e.stopPropagation(); });
  body.appendChild(textarea);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding:4px 0 0';

  if (box.description) {
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '🗑 清除';
    clearBtn.style.cssText = 'padding:6px 14px;border-radius:6px;border:1px solid #5a3a3a;background:#2a1a1a;color:#ff8888;cursor:pointer;font-size:13px';
    clearBtn.onclick = () => { saveState(); delete box.description; renderAll(); autoSave(); overlay.remove(); showToast('描述已清除'); };
    actions.appendChild(clearBtn);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = 'padding:6px 14px;border-radius:6px;border:1px solid #3a3a5c;background:#222;color:#ccc;cursor:pointer;font-size:13px';
  cancelBtn.onclick = () => overlay.remove();
  actions.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.textContent = '✅ 保存';
  saveBtn.style.cssText = 'padding:6px 14px;border-radius:6px;border:none;background:var(--accent);color:#000;cursor:pointer;font-size:13px;font-weight:600';
  saveBtn.onclick = () => {
    const v = textarea.value.trim();
    saveState();
    if (v) { box.description = v; showToast('📝 描述已保存'); }
    else { delete box.description; showToast('描述已清除'); }
    renderAll(); autoSave(); overlay.remove();
  };
  actions.appendChild(saveBtn);
  body.appendChild(actions);

  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  setTimeout(() => textarea.focus(), 60);
}

/* ───── Resources Panel ───── */
function showResourcesPanel() {
  // Collect all resource references from ALL boxes (recursive)
  const resources = [];
  const IMG_EXT = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)(\?.*)?$/i;
  const isUrl = v => typeof v === 'string' && v.trim().length > 3 &&
    (v.startsWith('http://') || v.startsWith('https://') || v.startsWith('data:image') ||
     /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|mp4|mp3|ogg|wav|atlas|xml)(\?.*)?$/i.test(v));

  function scanBox(box) {
    const def = getWidgetDef(box.widgetType);
    // Check render.src property (e.g. Image → imagePath)
    if (def && def.render && def.render.src) {
      const val = (box.widgetProps || {})[def.render.src];
      if (val && typeof val === 'string' && val.trim()) {
        resources.push({ boxId: box.id, label: box.label, widgetType: box.widgetType,
          icon: def.icon || '🖼️', color: def.color, key: def.render.src, value: val.trim(),
          isImage: IMG_EXT.test(val.trim()) || def.render.type === 'image' });
      }
    }
    // Scan all widgetProps for URL-like values
    if (box.widgetProps) {
      Object.entries(box.widgetProps).forEach(([key, val]) => {
        if (def && def.render && def.render.src === key) return; // already captured above
        if (isUrl(val)) {
          const alreadyAdded = resources.some(r => r.boxId === box.id && r.key === key);
          if (!alreadyAdded) {
            resources.push({ boxId: box.id, label: box.label, widgetType: box.widgetType,
              icon: def ? (def.icon || '⬜') : '⬜', color: def ? def.color : '#888', key, value: val.trim(),
              isImage: IMG_EXT.test(val.trim()) });
          }
        }
      });
    }
    // Recurse into children
    if (box.children && box.children.length) box.children.forEach(scanBox);
  }
  boxes.forEach(scanBox);

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200000;display:flex;align-items:center;justify-content:center';
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const modal = document.createElement('div');
  modal.style.cssText = 'background:#1a1a2e;border:1px solid #3a3a5c;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.7);width:620px;max-width:96vw;max-height:80vh;display:flex;flex-direction:column;overflow:hidden';

  const header = document.createElement('div');
  header.style.cssText = 'padding:12px 16px;border-bottom:1px solid #3a3a5c;display:flex;align-items:center;justify-content:space-between;flex-shrink:0';
  header.innerHTML = `<span style="font-weight:600;font-size:14px;color:#ccc">📦 资源引用 — <em style="color:var(--accent);font-style:normal">${resources.length} 个</em></span>`;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:#888;font-size:16px;cursor:pointer;padding:0 4px';
  closeBtn.onclick = () => overlay.remove();
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const body = document.createElement('div');
  body.style.cssText = 'overflow-y:auto;flex:1;padding:8px 0';

  if (resources.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:32px;text-align:center;color:#666;font-size:13px';
    empty.textContent = '当前界面没有引用任何资源（图片路径、URL 等）';
    body.appendChild(empty);
  } else {
    resources.forEach(r => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:8px 16px;border-bottom:1px solid rgba(255,255,255,0.05);transition:background 0.1s;cursor:default';
      row.addEventListener('mouseenter', () => row.style.background = 'rgba(255,255,255,0.04)');
      row.addEventListener('mouseleave', () => row.style.background = '');

      // Left: thumb or icon
      const thumb = document.createElement('div');
      thumb.style.cssText = 'width:48px;height:48px;flex-shrink:0;border-radius:5px;border:1px solid #333;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#111;font-size:20px';
      if (r.isImage) {
        const img = document.createElement('img');
        img.src = r.value;
        img.style.cssText = 'width:100%;height:100%;object-fit:contain';
        img.onerror = () => { img.remove(); thumb.textContent = r.icon || '🖼️'; };
        thumb.appendChild(img);
      } else {
        thumb.textContent = r.icon || '📄';
      }
      row.appendChild(thumb);

      // Middle: info
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px';
      const nameLine = document.createElement('div');
      nameLine.style.cssText = 'display:flex;align-items:center;gap:6px';
      nameLine.innerHTML = `<span style="color:${r.color||'#aaa'}">${r.icon}</span><span style="font-size:12px;font-weight:600;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px" title="${r.label}">${r.label}</span><span style="font-size:10px;color:#555;flex-shrink:0">#${r.boxId}</span>`;
      info.appendChild(nameLine);
      const keyLine = document.createElement('div');
      keyLine.style.cssText = 'font-size:10px;color:#666';
      keyLine.textContent = r.key;
      info.appendChild(keyLine);
      const valLine = document.createElement('div');
      valLine.style.cssText = 'font-size:11px;color:#9b8af7;word-break:break-all;line-height:1.4;margin-top:2px';
      valLine.textContent = r.value.length > 80 ? r.value.slice(0, 77) + '…' : r.value;
      valLine.title = r.value;
      info.appendChild(valLine);
      row.appendChild(info);

      // Right: copy button
      const copyBtn = document.createElement('button');
      copyBtn.textContent = '复制';
      copyBtn.style.cssText = 'flex-shrink:0;padding:4px 10px;border-radius:5px;border:1px solid #3a3a5c;background:#222;color:#aaa;cursor:pointer;font-size:11px;align-self:center';
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(r.value).then(() => {
          copyBtn.textContent = '✓';
          setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
        }).catch(() => {
          copyBtn.textContent = '✗';
          setTimeout(() => { copyBtn.textContent = '复制'; }, 1000);
        });
      };
      row.appendChild(copyBtn);

      body.appendChild(row);
    });
  }

  modal.appendChild(body);

  // Footer: summary
  const footer = document.createElement('div');
  footer.style.cssText = 'padding:8px 16px;border-top:1px solid #3a3a5c;flex-shrink:0;display:flex;align-items:center;justify-content:space-between';
  const summary = document.createElement('span');
  summary.style.cssText = 'font-size:11px;color:#555';
  const imgCount = resources.filter(r => r.isImage).length;
  summary.textContent = `图片: ${imgCount}  其他: ${resources.length - imgCount}  节点总数: ${boxes.length}`;
  footer.appendChild(summary);
  const closeFooter = document.createElement('button');
  closeFooter.textContent = '关闭';
  closeFooter.style.cssText = 'padding:5px 16px;border-radius:6px;border:1px solid #3a3a5c;background:#222;color:#ccc;cursor:pointer;font-size:12px';
  closeFooter.onclick = () => overlay.remove();
  footer.appendChild(closeFooter);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });
}

/* ───── Save EntryClass Modal (preview before saving) ───── */
function showSaveEntryClassModal(box) {
  // Collect subtree to preview
  const ids = new Set(collectDescendants(box.id));
  const subset = boxes.filter(b => ids.has(b.id));
  const ox = box.x, oy = box.y;
  const previewBoxes = subset.map(b => ({ ...b, x: b.x - ox, y: b.y - oy }));

  // Overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:200000;display:flex;align-items:center;justify-content:center';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:#1a1a2e;border:1px solid #3a3a5c;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.7);width:580px;max-width:95vw;display:flex;flex-direction:column;overflow:hidden';

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'padding:12px 16px;border-bottom:1px solid #3a3a5c;display:flex;align-items:center;justify-content:space-between;flex-shrink:0';
  header.innerHTML = '<span style="font-weight:600;font-size:14px;color:#ccc">📐 设置为 EntryClass 模板</span>';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:16px;padding:2px 6px;border-radius:3px';
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#fff'; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#888'; });
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Name input row
  const nameRow = document.createElement('div');
  nameRow.style.cssText = 'padding:12px 16px 8px;display:flex;align-items:center;gap:10px;flex-shrink:0;border-bottom:1px solid #2a2a3c';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = '存档名称：';
  nameLabel.style.cssText = 'font-size:12px;color:#999;white-space:nowrap';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = box.label || 'entryclass';
  nameInput.style.cssText = 'flex:1;background:#0d0f1a;border:1px solid #3a3a5c;border-radius:5px;padding:5px 10px;color:#e0e0e0;font-size:13px;outline:none';
  nameInput.addEventListener('focus', () => { nameInput.style.borderColor = '#7c6af7'; });
  nameInput.addEventListener('blur', () => { nameInput.style.borderColor = '#3a3a5c'; });
  nameRow.appendChild(nameLabel);
  nameRow.appendChild(nameInput);
  modal.appendChild(nameRow);

  // Preview area
  const previewWrap = document.createElement('div');
  previewWrap.style.cssText = 'flex:1;overflow:hidden;background:#12121f;position:relative;height:280px';

  const previewHint = document.createElement('div');
  previewHint.style.cssText = 'position:absolute;top:6px;left:10px;font-size:10px;color:#555;pointer-events:none;z-index:1';
  previewHint.textContent = `预览 — ${subset.length} 个节点`;
  previewWrap.appendChild(previewHint);

  // Render boxes into preview
  function renderSavePreview() {
    previewWrap.querySelectorAll('.ec-prev-box').forEach(e => e.remove());
    if (!previewBoxes.length) return;
    const minX = Math.min(...previewBoxes.map(b => b.x));
    const minY = Math.min(...previewBoxes.map(b => b.y));
    const maxX = Math.max(...previewBoxes.map(b => b.x + b.w));
    const maxY = Math.max(...previewBoxes.map(b => b.y + b.h));
    const natW = maxX - minX || 1;
    const natH = maxY - minY || 1;
    const pw = previewWrap.clientWidth || 520;
    const ph = previewWrap.clientHeight || 280;
    const pad = 20;
    const scale = Math.min((pw - pad * 2) / natW, (ph - pad * 2) / natH, 2);
    const offX = pad + (pw - pad * 2 - natW * scale) / 2 - minX * scale;
    const offY = pad + (ph - pad * 2 - natH * scale) / 2 - minY * scale;
    previewBoxes.forEach(b => {
      const el = document.createElement('div');
      el.className = 'ec-prev-box';
      const bc = b.borderColor || '#7c6af7';
      const bg = b.bgColor || 'rgba(124,106,247,0.06)';
      el.style.cssText = `position:absolute;
        left:${Math.round(offX + b.x * scale)}px;
        top:${Math.round(offY + b.y * scale)}px;
        width:${Math.max(2, Math.round(b.w * scale))}px;
        height:${Math.max(2, Math.round(b.h * scale))}px;
        border:${Math.max(1, Math.round((b.borderWidth || 2) * scale * 0.3))}px solid ${bc};
        background:${bg};
        box-sizing:border-box;overflow:hidden`;
      if (b.w * scale > 30 && b.h * scale > 14) {
        const lbl = document.createElement('div');
        lbl.style.cssText = `font-size:${Math.max(8, Math.min(11, Math.round(10 * scale)))}px;color:${bc};padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0.85`;
        lbl.textContent = b.label ? `${b.label} (${b.widgetType || 'Canvas'})` : '';
        el.appendChild(lbl);
      }
      previewWrap.appendChild(el);
    });
  }
  modal.appendChild(previewWrap);
  requestAnimationFrame(renderSavePreview);

  // Footer
  const footer = document.createElement('div');
  footer.style.cssText = 'padding:10px 16px;border-top:1px solid #3a3a5c;display:flex;justify-content:flex-end;gap:8px;flex-shrink:0';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = 'padding:6px 16px;border:1px solid #444;background:transparent;color:#aaa;border-radius:5px;cursor:pointer;font-size:12px';
  cancelBtn.addEventListener('click', () => overlay.remove());
  const saveBtn = document.createElement('button');
  saveBtn.textContent = '💾 保存为 EntryClass';
  saveBtn.style.cssText = 'padding:6px 16px;border:none;background:#7c6af7;color:#fff;border-radius:5px;cursor:pointer;font-size:12px';
  saveBtn.addEventListener('click', async () => {
    const safeName = nameInput.value.trim();
    if (!safeName) { nameInput.focus(); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    saveState();
    boxes.forEach(b => { b.isEntryClass = false; });
    box.isEntryClass = true;
    renderAll();
    autoSave();
    const content = JSON.stringify({ version: '1.1', boxes: serializeBoxes(previewBoxes), nextId: 1, savedAt: new Date().toISOString(), entryClassLabel: safeName, isEntryClass: true }, null, 2);
    try {
      const filePath = 'sessions/entryclass/' + safeName + '.session';
      const res = await fetch('/docs/api/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: filePath, content })
      });
      const data = await res.json();
      overlay.remove();
      if (data.success) {
        // Store the session path on the box so right-click "编辑" can open it
        box.entryClassSessionPath = filePath;
        autoSave();
        if (typeof _globalLoadTree === 'function') _globalLoadTree();
        log(`📐 EntryClass 已保存：sessions/entryclass/${safeName}.session`, 'ok');
        showToast(`📐 EntryClass 「${safeName}」已保存`);
      } else showToast('⚠ 保存失败：' + (data.error || ''));
    } catch (e) { overlay.remove(); showToast('⚠ 网络错误：' + e.message); }
  });
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  // Focus name input and select all
  requestAnimationFrame(() => { nameInput.focus(); nameInput.select(); });
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveBtn.click();
    if (e.key === 'Escape') overlay.remove();
  });
}

async function showEntryClassPicker(targetBox, anchorX, anchorY) {
  // Fetch tree and find sessions/entryclass items
  let templates = [];
  try {
    const res = await fetch('/docs/api/tree');
    const data = await res.json();
    if (data.success) {
      const findEntryClasses = (items) => {
        for (const item of items || []) {
          if (item.type === 'folder' && item.name === 'sessions') {
            for (const sub of item.children || []) {
              if (sub.type === 'folder' && sub.name === 'entryclass') {
                for (const f of sub.children || []) {
                  if (f.type === 'file' && f.name.endsWith('.session')) {
                    templates.push({ name: f.name.replace(/\.session$/, ''), path: f.path });
                  }
                }
              }
            }
          }
          if (item.children) findEntryClasses(item.children);
        }
      };
      findEntryClasses(data.tree);
    }
  } catch (err) { log('⚠ 获取模板列表失败：' + err.message, 'warn'); }

  if (!templates.length) { log('⚠ sessions/entryclass/ 下暂无模板', 'warn'); return; }

  // ── Modal overlay ──
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200000;display:flex;align-items:center;justify-content:center';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:#1a1a2e;border:1px solid #3a3a5c;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.7);width:640px;max-width:95vw;height:420px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden';

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'padding:12px 16px;border-bottom:1px solid #3a3a5c;display:flex;align-items:center;justify-content:space-between;flex-shrink:0';
  header.innerHTML = '<span style="font-weight:600;font-size:14px;color:#ccc">📐 选择 EntryClass 模板</span>';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:16px;padding:2px 6px;border-radius:3px';
  closeBtn.addEventListener('mouseenter', () => closeBtn.style.color = '#fff');
  closeBtn.addEventListener('mouseleave', () => closeBtn.style.color = '#888');
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Body: left list + right preview
  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex:1;overflow:hidden';

  // Left: template list
  const listPane = document.createElement('div');
  listPane.style.cssText = 'width:180px;flex-shrink:0;border-right:1px solid #3a3a5c;overflow-y:auto;padding:6px 0';

  // Right: preview area
  const previewPane = document.createElement('div');
  previewPane.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden';

  const previewLabel = document.createElement('div');
  previewLabel.style.cssText = 'padding:8px 14px;font-size:11px;color:#888;border-bottom:1px solid #2a2a3c;flex-shrink:0';
  previewLabel.textContent = '预览';

  const previewCanvas = document.createElement('div');
  previewCanvas.style.cssText = 'flex:1;position:relative;overflow:hidden;background:#12121f';

  previewPane.appendChild(previewLabel);
  previewPane.appendChild(previewCanvas);

  // Footer with apply button
  const footer = document.createElement('div');
  footer.style.cssText = 'padding:10px 16px;border-top:1px solid #3a3a5c;display:flex;justify-content:flex-end;gap:8px;flex-shrink:0';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = 'padding:6px 16px;border:1px solid #444;background:transparent;color:#aaa;border-radius:5px;cursor:pointer;font-size:12px';
  cancelBtn.addEventListener('click', () => overlay.remove());
  const applyBtn = document.createElement('button');
  applyBtn.textContent = '应用';
  applyBtn.disabled = true;
  applyBtn.style.cssText = 'padding:6px 16px;border:none;background:#7c6af7;color:#fff;border-radius:5px;cursor:pointer;font-size:12px;opacity:0.5';
  footer.appendChild(cancelBtn);
  footer.appendChild(applyBtn);

  body.appendChild(listPane);
  body.appendChild(previewPane);
  modal.appendChild(body);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  // Render preview of a template
  let selectedPath = null;
  const _tplCache = {};
  async function renderPreview(tpl) {
    previewLabel.textContent = '预览 — ' + tpl.name;
    if (!_tplCache[tpl.path]) {
      previewCanvas.innerHTML = '<div style="color:#555;font-size:12px;padding:16px">加载中…</div>';
      try {
        const r = await fetch('/docs/api/get?name=' + encodeURIComponent(tpl.path));
        const d = await r.json();
        if (d.success) {
          const parsed = JSON.parse(d.content);
          // Handle both flat (v1.0) and nested-tree (v1.1+) formats
          const rawBoxes = parsed.boxes || [];
          _tplCache[tpl.path] = (parsed.version && parsed.version !== '1.0')
            ? deserializeBoxes(rawBoxes)
            : rawBoxes;
        } else { _tplCache[tpl.path] = null; }
      } catch (e) { _tplCache[tpl.path] = null; }
    }
    const tplBoxes = _tplCache[tpl.path];
    if (!tplBoxes) { previewCanvas.innerHTML = '<div style="color:#f66;font-size:12px;padding:16px">⚠ 无法读取模板</div>'; return; }
    if (!tplBoxes.length) { previewCanvas.innerHTML = '<div style="color:#888;font-size:12px;padding:16px">空模板</div>'; return; }

    // Compute bounding box
    const minX = Math.min(...tplBoxes.map(b => b.x));
    const minY = Math.min(...tplBoxes.map(b => b.y));
    const maxX = Math.max(...tplBoxes.map(b => b.x + b.w));
    const maxY = Math.max(...tplBoxes.map(b => b.y + b.h));
    const natW = maxX - minX || 1;
    const natH = maxY - minY || 1;

    // Use getBoundingClientRect for accurate dimensions after layout
    const rect = previewCanvas.getBoundingClientRect();
    const pw = rect.width || previewCanvas.clientWidth || 400;
    const ph = rect.height || previewCanvas.clientHeight || 260;
    const pad = 16;
    const scale = Math.min((pw - pad * 2) / natW, (ph - pad * 2) / natH);
    const offX = pad + (pw - pad * 2 - natW * scale) / 2 - minX * scale;
    const offY = pad + (ph - pad * 2 - natH * scale) / 2 - minY * scale;

    previewCanvas.innerHTML = '';
    tplBoxes.forEach(b => {
      const el = document.createElement('div');
      const bc = b.borderColor || '#7c6af7';
      const bg = b.bgColor || 'rgba(124,106,247,0.06)';
      el.style.cssText = `
        position:absolute;
        left:${Math.round(offX + b.x * scale)}px;
        top:${Math.round(offY + b.y * scale)}px;
        width:${Math.max(2, Math.round(b.w * scale))}px;
        height:${Math.max(2, Math.round(b.h * scale))}px;
        border:${Math.max(1, Math.round((b.borderWidth||2) * scale * 0.3))}px solid ${bc};
        background:${bg};
        opacity:${b.opacity || 1};
        box-sizing:border-box;
        overflow:hidden;
      `;
      if (b.w * scale > 30 && b.h * scale > 14) {
        const lbl = document.createElement('div');
        lbl.style.cssText = `font-size:${Math.max(8, Math.min(11, Math.round(10 * scale)))}px;color:${bc};padding:1px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0.85`;
        lbl.textContent = b.label || '';
        el.appendChild(lbl);
      }
      previewCanvas.appendChild(el);
    });
  }

  // Populate list
  templates.forEach(tpl => {
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:12px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:2px solid transparent;transition:background 0.1s';
    row.title = tpl.name;
    row.textContent = '📐 ' + tpl.name;
    row.addEventListener('mouseenter', () => {
      if (selectedPath !== tpl.path) row.style.background = 'rgba(124,106,247,0.12)';
      renderPreview(tpl);  // preview on hover
    });
    row.addEventListener('mouseleave', () => {
      if (selectedPath !== tpl.path) row.style.background = '';
    });
    row.addEventListener('click', () => {
      listPane.querySelectorAll('div').forEach(r => {
        r.style.background = '';
        r.style.color = '#bbb';
        r.style.borderLeftColor = 'transparent';
      });
      row.style.background = 'rgba(124,106,247,0.3)';
      row.style.color = '#fff';
      row.style.borderLeftColor = '#7c6af7';
      selectedPath = tpl.path;
      applyBtn.disabled = false;
      applyBtn.style.opacity = '1';
      renderPreview(tpl);
    });
    listPane.appendChild(row);
  });

  applyBtn.addEventListener('click', () => {
    if (!selectedPath) return;
    overlay.remove();
    applyEntryClassTemplate(targetBox, selectedPath);
  });

  // Double-click list to apply immediately
  listPane.addEventListener('dblclick', () => {
    if (selectedPath) { overlay.remove(); applyEntryClassTemplate(targetBox, selectedPath); }
  });

  // Auto-select first after layout settles
  requestAnimationFrame(() => {
    const firstRow = listPane.querySelector('div');
    if (firstRow) firstRow.click();
  });
}

/* ───── Delete / Clear ───── */
function collectDescendants(id) {
  // Build parent→children map once O(n), then BFS O(descendants) — total O(n)
  const childrenOf = {};
  boxes.forEach(b => {
    if (b.parentId != null) {
      if (!childrenOf[b.parentId]) childrenOf[b.parentId] = [];
      childrenOf[b.parentId].push(b.id);
    }
  });
  const ids = [id];
  let i = 0;
  while (i < ids.length) {
    const cur = ids[i++];
    (childrenOf[cur] || []).forEach(childId => ids.push(childId));
  }
  return ids;
}

function deleteSelected() {
  if (!selectedId) {
    log('⚠ 请先选中一个节点再删除', 'warn');
    return;
  }
  const box = boxes.find(b => b.id === selectedId);
  if (!box) { selectedId = null; return; }
  try {
    saveState();
    const toDelete = new Set(collectDescendants(selectedId));
    toDelete.forEach(id => document.getElementById(`box-${id}`)?.remove());
    boxes = boxes.filter(b => !toDelete.has(b.id));
    deselectAll();
    renderAll();
    autoSave();
    log('删除 ' + box.label + (toDelete.size > 1 ? ' 及 ' + (toDelete.size - 1) + ' 个子节点' : ''), 'warn');
  } catch(err) {
    log('删除失败: ' + err.message, 'error');
    console.error('[deleteSelected]', err);
  }
}

btnDelete.addEventListener('click', () => { setMode('select'); deleteSelected(); });
btnClear.addEventListener('click', () => {
  if (!boxes.length) return;
  saveState();
  boxes = [];
  boxLayer.innerHTML = '';
  deselectAll();
  renderAll();
  log('画布已清空', 'warn');
});

/* ───── Undo / Redo buttons ───── */
btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);

/* ───── Zoom ───── */
function applyTransform() {
  canvasRoot.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

function setZoom(z) {
  zoom = Math.max(0.25, Math.min(3, z));
  applyTransform();
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  // Redraw grid at viewport size so it always fills center-area regardless of zoom
  drawGrid();
}

function zoomAroundPoint(newZ, screenX, screenY) {
  const oldZoom = zoom;
  zoom = Math.max(0.25, Math.min(3, newZ));
  panX = screenX - (screenX - panX) * (zoom / oldZoom);
  panY = screenY - (screenY - panY) * (zoom / oldZoom);
  applyTransform();
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  drawGrid();
}

// Zoom and pan to fit all boxes in the viewport
function zoomToFit(padding = 40) {
  if (!boxes.length) { panX = 0; panY = 0; setZoom(1); return; }
  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  const maxX = Math.max(...boxes.map(b => b.x + b.w));
  const maxY = Math.max(...boxes.map(b => b.y + b.h));
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const vpW = canvasViewport.offsetWidth  - padding * 2;
  const vpH = canvasViewport.offsetHeight - padding * 2;
  const scaleX = vpW / contentW;
  const scaleY = vpH / contentH;
  zoom = Math.max(0.25, Math.min(Math.min(scaleX, scaleY), 2));
  // Center content in viewport using pan
  const contentCenterX = (minX + maxX) / 2;
  const contentCenterY = (minY + maxY) / 2;
  panX = canvasViewport.offsetWidth  / 2 - contentCenterX * zoom;
  panY = canvasViewport.offsetHeight / 2 - contentCenterY * zoom;
  applyTransform();
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  drawGrid();
}
btnZoomIn.addEventListener('click',    () => zoomAroundPoint(zoom + 0.1, canvasViewport.offsetWidth / 2, canvasViewport.offsetHeight / 2));
btnZoomOut.addEventListener('click',   () => zoomAroundPoint(zoom - 0.1, canvasViewport.offsetWidth / 2, canvasViewport.offsetHeight / 2));
btnZoomReset.addEventListener('click', () => { panX = 0; panY = 0; setZoom(1); });

// Ctrl+Wheel zoom (toward cursor)
document.getElementById('canvas-viewport').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const rect = canvasViewport.getBoundingClientRect();
  const cursorX = e.clientX - rect.left;
  const cursorY = e.clientY - rect.top;
  zoomAroundPoint(zoom + (e.deltaY < 0 ? 0.1 : -0.1), cursorX, cursorY);
}, { passive: false });

// Middle-button / Space+drag pan on canvas
(function() {
  let isPanning = false, panStartX = 0, panStartY = 0, panStartPanX = 0, panStartPanY = 0;
  let spaceHeld = false;
  window.addEventListener('keydown', e => { if (e.code === 'Space' && !e.target.closest('input,textarea,select')) spaceHeld = true; }, true);
  window.addEventListener('keyup',   e => { if (e.code === 'Space') { spaceHeld = false; canvasViewport.style.cursor = ''; } }, true);
  canvasViewport.addEventListener('mousedown', e => {
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      isPanning = true;
      panStartX = e.clientX; panStartY = e.clientY;
      panStartPanX = panX; panStartPanY = panY;
      canvasViewport.style.cursor = 'grabbing';
    }
  });
  window.addEventListener('mousemove', e => {
    if (!isPanning) return;
    panX = panStartPanX + (e.clientX - panStartX);
    panY = panStartPanY + (e.clientY - panStartY);
    applyTransform();
  });
  window.addEventListener('mouseup', e => {
    if (isPanning && (e.button === 1 || e.button === 0)) {
      isPanning = false;
      canvasViewport.style.cursor = spaceHeld ? 'grab' : '';
    }
  });
})();

/* ───── Grid & Snap ───── */
toggleGrid.addEventListener('change', () => {
  gridVisible = toggleGrid.checked;
  drawGrid();
});
toggleSnap.addEventListener('change', () => { snapEnabled = toggleSnap.checked; });

/* ───── Preset shapes ───── */
document.querySelectorAll('.preset-item').forEach(item => {
  item.addEventListener('click', () => {
    const w = +item.dataset.w;
    const h = +item.dataset.h;
    const label = item.dataset.label;
    saveState();
    const box = createBox(
      Math.round(canvasW() / 2 - w / 2),
      Math.round(canvasH() / 2 - h / 2),
      w, h, label
    );
    boxes.push(box);
    selectBox(box.id);
    renderAll();
    log(`添加预设: ${label} (${w}×${h})`, 'ok');
  });
});

/* ───── Widget Palette Init ───── */
function buildPalette(containerId, items) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  items.forEach(def => {
    const btn = document.createElement('div');
    btn.className = 'palette-item';
    btn.dataset.type = def.type;
    btn.dataset.group = def.category || WIDGET_GROUPS[def.type] || '工具';
    btn.style.setProperty('--widget-color', def.color);
    btn.innerHTML = `<span class="pi-dot" style="background:${def.color}"></span>${def.icon} <code style="font-size:11px">&lt;${def.label}&gt;</code>`;
    btn.title = `<${def.label}> — 点击后绘制区域设为此控件`;
    btn.addEventListener('click', () => {
      const isActive = currentWidgetType === def.type;
      // Deactivate all
      document.querySelectorAll('.palette-item').forEach(b => b.classList.remove('active'));
      currentWidgetType = isActive ? null : def.type;
      if (currentWidgetType) {
        btn.classList.add('active');
        // If something is selected, change its type immediately
        if (selectedId) {
          const box = boxes.find(b => b.id === selectedId);
          if (box) {
            saveState();
            box.widgetType = def.type;
            box.borderColor = def.color;
            box.bgColor = def.bg;
            box.widgetProps = initWidgetProps(def);
            ensureTileViewEntry(box);
            renderAll();
            log(`设为 <${def.label}>: ${box.label}`, 'ok');
          }
        } else {
          // Auto-enter draw mode
          setMode('draw');
          log(`控件: <${def.label}> — 拖拽画布绘制区域`, 'info');
        }
      } else {
        log('控件类型已取消', 'dim');
      }
    });
    wrap.appendChild(btn);
  });
}

function applyPaletteFilter(group) {
  const showAll = !group || group === 'all';

  document.querySelectorAll('.palette-item').forEach(btn => {
    const match = showAll || btn.dataset.group === group;
    btn.style.display = match ? '' : 'none';
  });

  // Hide section labels/dividers when filtering to a single group
  const labelControls   = document.getElementById('palette-label-controls');
  const labelContainers = document.getElementById('palette-label-containers');
  const divControls     = document.getElementById('palette-div-controls');
  const divContainers   = document.getElementById('palette-div-containers');

  const hasControls   = showAll || group !== '容器';
  const hasContainers = showAll || group === '容器';
  if (labelControls)   labelControls.style.display   = hasControls   ? '' : 'none';
  if (divControls)     divControls.style.display      = hasControls   ? '' : 'none';
  if (labelContainers) labelContainers.style.display  = hasContainers ? '' : 'none';
  if (divContainers)   divContainers.style.display    = hasContainers ? '' : 'none';
}
/* ───── Session Persistence ───── */
let _sessionPath = 'sessions/default.session';
let _sessionName = 'default';
let _saveTimer = null;
let _ecEditMode = false; // true while openEntryClassInCanvas is active — blocks autoSave
let _lastNonEmptySnapshot = null; // JSON string of last non-empty save — used for backup

function setActiveSession(name, filePath) {
  _sessionName = name;
  _sessionPath = filePath || ('sessions/' + name + '.session');
  const lbl = document.getElementById('session-label');
  if (lbl) { lbl.textContent = '📂 ' + name; lbl.title = 'Session: ' + _sessionPath; }
}

/* ───── Hierarchical Serialization ───── */
function serializeBoxes(flatBoxes) {
  // Convert flat array with parentId → nested tree
  const map = {};
  flatBoxes.forEach(b => {
    const { parentId, ...rest } = b;   // drop parentId — it's implicit in nesting
    map[b.id] = { ...rest, children: [] };
  });
  const roots = [];
  flatBoxes.forEach(b => {
    if (b.parentId != null && map[b.parentId]) {
      map[b.parentId].children.push(map[b.id]);
    } else {
      roots.push(map[b.id]);
    }
  });
  // Remove empty children arrays to keep JSON clean; guard against any circular node refs
  const cleanSeen = new Set();
  function clean(node) {
    if (cleanSeen.has(node)) { delete node.children; return node; }
    cleanSeen.add(node);
    if (!node.children || !node.children.length) { delete node.children; }
    else { node.children.forEach(clean); if (!node.children.length) delete node.children; }
    return node;
  }
  return roots.map(clean);
}

function deserializeBoxes(nodes, parentId = null, out = []) {
  // Convert nested tree → flat array with parentId
  (nodes || []).forEach(n => {
    const { children, ...box } = n;
    box.parentId = parentId;
    if (!box.anchor) box.anchor = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    out.push(box);
    if (children && children.length) deserializeBoxes(children, box.id, out);
  });
  return out;
}

function sessionData() {
  return { version: '1.1', savedAt: new Date().toISOString(), nextId, boxes: serializeBoxes(boxes) };
}

function autoSave() {
  if (_ecEditMode) return; // don't overwrite parent session while editing an EntryClass
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      const data = sessionData();
      const json = JSON.stringify(data, null, 2);
      // Before saving an empty session, backup the last known non-empty state
      if (data.boxes.length === 0 && _lastNonEmptySnapshot) {
        const backupPath = _sessionPath.replace(/\.session$/, '') + '_backup.session';
        await fetch('/docs/api/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: backupPath, content: _lastNonEmptySnapshot })
        }).catch(() => {});
        log('⚠️ 画布已清空，已自动备份到 ' + backupPath.split('/').pop(), 'warn');
      }
      if (data.boxes.length > 0) _lastNonEmptySnapshot = json;
      await fetch('/docs/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: _sessionPath, content: json })
      });
      const ind = document.getElementById('save-indicator');
      if (ind) { ind.textContent = '✓ 已保存'; ind.style.opacity = '1'; setTimeout(() => ind.style.opacity = '0', 1500); }
    } catch (_) {}
  }, 1500);
}

// Detect and break parentId cycles in loaded session data to prevent infinite recursion
function sanitizeParentIds(boxArr) {
  const idSet = new Set(boxArr.map(b => b.id));
  // Remove invalid parentIds (pointing to non-existent boxes)
  boxArr.forEach(b => { if (b.parentId && !idSet.has(b.parentId)) b.parentId = null; });
  // Detect cycles using DFS coloring: 0=unvisited, 1=in-stack, 2=done
  const color = {};
  boxArr.forEach(b => { color[b.id] = 0; });
  function visit(id) {
    if (!color[id] || color[id] === 2) return;
    if (color[id] === 1) {
      // Cycle detected: break by clearing this box's parentId
      const b = boxArr.find(x => x.id === id);
      if (b) { b.parentId = null; log(`sanitize: 清除循环引用 parentId on ${id}`, 'warn'); }
      return;
    }
    color[id] = 1;
    const b = boxArr.find(x => x.id === id);
    if (b && b.parentId) visit(b.parentId);
    color[id] = 2;
  }
  boxArr.forEach(b => visit(b.id));
}

async function loadSession() {
  try {
    const res = await fetch('/docs/api/get?name=' + encodeURIComponent(_sessionPath));
    const json = await res.json();
    if (!json.success || !json.content) return false;
    const d = JSON.parse(json.content);
    if (d.nextId) nextId = d.nextId;
    if (Array.isArray(d.boxes)) {
      // v1.1+: nested tree; v1.0: flat array with parentId
      if (d.version && d.version !== '1.0') {
        boxes = deserializeBoxes(d.boxes);
      } else {
        boxes = d.boxes;
        boxes.forEach(b => { if (!b.anchor) b.anchor = { minX:0, minY:0, maxX:0, maxY:0 }; });
      }
      sanitizeParentIds(boxes);
    }
    renderAll();
    log(`会话已恢复 (${boxes.length} 个节点)`, 'ok');
    setActiveSession(_sessionName, _sessionPath);
    if (boxes.length > 0) requestAnimationFrame(() => requestAnimationFrame(() => zoomToFit()));
    return true;
  } catch (_) { return false; }
}

/* ───── Init ───── */
// Double-RAF ensures flexbox layout has settled before reading dimensions
requestAnimationFrame(() => requestAnimationFrame(() => drawGrid()));
setMode('draw');   // Start in draw mode
log('Canvas Editor 已启动  —  拖拽画布可绘制边框，V=选择，B=绘制，Del=删除', 'ok');
// Load widget palette from elements.json, then restore session
loadElements().then(async () => {
  const sel = document.getElementById('palette-group-select');
  if (sel) sel.addEventListener('change', () => applyPaletteFilter(sel.value));
  await loadSession();
  await loadTheme('default');
  // Mark CanvasPanel as the active palette item (default widget type)
  const canvasBtn = document.querySelector('.palette-item[data-type="CanvasPanel"]');
  if (canvasBtn) canvasBtn.classList.add('active');
});

// Redraw grid when canvas-viewport size changes (window resize)
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => requestAnimationFrame(() => drawGrid()))
    .observe(canvasViewport);
}

// ===== ZONE HIGHLIGHT MODE (Live Element Picker) =====
(function () {
  let active = false;
  let currentInfo = '';

  const PANEL_IDS = new Set(['zonePickResult','zonePickInfo','zonePickTitle','zonePickCopyBtn','zonePickClose','zoneOverlay','zoneLabel','zoneHighlightBtn']);

  function getOverlay() { return document.getElementById('zoneOverlay'); }
  function getLabel()   { return document.getElementById('zoneLabel'); }
  function getBtn()     { return document.getElementById('zoneHighlightBtn'); }
  function getPanel()   { return document.getElementById('zonePickResult'); }
  function getInfo()    { return document.getElementById('zonePickInfo'); }
  function getCopyBtn() { return document.getElementById('zonePickCopyBtn'); }

  function elInfo(el) {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    const id  = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim()
                ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
    const txt = (el.title || el.getAttribute('aria-label') || el.textContent || '')
                  .trim().replace(/\s+/g, ' ').slice(0, 50);
    return tag + id + cls + (txt ? ' "' + txt + '"' : '');
  }

  function isInPanel(el) {
    let node = el;
    while (node) {
      if (PANEL_IDS.has(node.id)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function setActive(on) {
    active = on;
    document.body.classList.toggle('zone-highlight-mode', on);
    const btn = getBtn();
    if (btn) btn.classList.toggle('active', on);
    const ov  = getOverlay();
    const lbl = getLabel();
    if (!on) {
      if (ov)  ov.style.display  = 'none';
      if (lbl) lbl.style.display = 'none';
    } else {
      const panel = getPanel();
      if (panel) panel.style.display = 'flex';
    }
  }

  window.toggleZoneHighlight = function () { setActive(!active); };

  // Copy button
  document.addEventListener('click', function (e) {
    const cb = getCopyBtn();
    if (!cb) return;
    if (e.target === cb || cb.contains(e.target)) {
      e.stopPropagation();
      if (!currentInfo) return;
      const text = currentInfo;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          flashCopied(cb);
        }).catch(function () { fallbackCopy(text, cb); });
      } else {
        fallbackCopy(text, cb);
      }
    }
  }, true);

  function fallbackCopy(text, btn) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); flashCopied(btn); } catch(e) {}
    document.body.removeChild(ta);
  }

  function flashCopied(btn) {
    if (!btn) return;
    btn.classList.add('copied');
    btn.textContent = '✓ 已复制';
    setTimeout(function () {
      btn.classList.remove('copied');
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制';
    }, 1500);
  }

  // Close button
  document.addEventListener('click', function (e) {
    const cl = document.getElementById('zonePickClose');
    if (cl && (e.target === cl || cl.contains(e.target))) {
      setActive(false);
      const panel = getPanel();
      if (panel) panel.style.display = 'none';
    }
  }, true);

  // Mouse move: update overlay + bubble
  window.addEventListener('mousemove', function (e) {
    if (!active) return;
    const ov  = getOverlay();
    const lbl = getLabel();
    const infoEl = getInfo();

    let el = document.elementFromPoint(e.clientX, e.clientY);
    while (el && isInPanel(el)) el = el.parentElement;
    if (!el || el === document.documentElement || el === document.body) {
      if (ov)  ov.style.display  = 'none';
      if (lbl) lbl.style.display = 'none';
      return;
    }

    const info = elInfo(el);
    currentInfo = info;

    if (ov) {
      const r = el.getBoundingClientRect();
      ov.style.top    = r.top    + 'px';
      ov.style.left   = r.left   + 'px';
      ov.style.width  = r.width  + 'px';
      ov.style.height = r.height + 'px';
      ov.style.display = 'block';
    }

    if (infoEl) infoEl.textContent = info;

    if (lbl) {
      const W = window.innerWidth, pad = 14;
      let left = e.clientX + pad;
      if (left + 200 > W) left = e.clientX - 200;
      lbl.style.left = left + 'px';
      lbl.style.top  = (e.clientY - 28) + 'px';
      lbl.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
      lbl.style.display = 'block';
    }
  }, false);

  // ESC: exit hover mode only (keep result panel visible)
  window.addEventListener('keydown', function (e) {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      setActive(false);
      // Keep panel visible so the last picked result stays on screen
    }
  }, true);

  window.addEventListener('mouseleave', function () {
    if (!active) return;
    const ov = getOverlay(), lbl = getLabel();
    if (ov)  ov.style.display  = 'none';
    if (lbl) lbl.style.display = 'none';
  });
})();

/* ═══════════════════════════════════════════════════════
   Batch Create Dialog — TileView/ListView quick-create
   ═══════════════════════════════════════════════════════ */
function openBatchCreateDialog() {
  // Remove any existing dialog
  const existing = document.getElementById('batch-create-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.id = 'batch-create-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:#1a1b26;border:1px solid rgba(255,255,255,0.15);border-radius:10px;padding:24px 28px;min-width:320px;max-width:400px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.6);font-size:13px;color:#e8eaf0';

  panel.innerHTML = `
    <div style="font-size:15px;font-weight:600;margin-bottom:18px;color:#c9b8ff">🔲 批量控件创建</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 16px">
      <label style="display:flex;flex-direction:column;gap:4px">
        <span style="color:#888;font-size:11px">容器类型</span>
        <select id="bc-type" style="background:#12121e;border:1px solid #333;border-radius:4px;color:#e8eaf0;padding:5px 8px;font-size:13px">
          <option value="TileView">TileView（网格）</option>
          <option value="ListView">ListView（列表）</option>
        </select>
      </label>
      <label style="display:flex;flex-direction:column;gap:4px">
        <span style="color:#888;font-size:11px">标签前缀</span>
        <input id="bc-label" type="text" placeholder="如 beltQuick" value="Item" style="background:#12121e;border:1px solid #333;border-radius:4px;color:#e8eaf0;padding:5px 8px;font-size:13px">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px">
        <span style="color:#888;font-size:11px">项目数量</span>
        <input id="bc-count" type="number" value="8" min="1" max="200" style="background:#12121e;border:1px solid #333;border-radius:4px;color:#e8eaf0;padding:5px 8px;font-size:13px">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px">
        <span style="color:#888;font-size:11px">列数（0=自动）</span>
        <input id="bc-cols" type="number" value="0" min="0" max="50" style="background:#12121e;border:1px solid #333;border-radius:4px;color:#e8eaf0;padding:5px 8px;font-size:13px">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px">
        <span style="color:#888;font-size:11px">项目宽 (px)</span>
        <input id="bc-iw" type="number" value="60" min="10" style="background:#12121e;border:1px solid #333;border-radius:4px;color:#e8eaf0;padding:5px 8px;font-size:13px">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px">
        <span style="color:#888;font-size:11px">项目高 (px)</span>
        <input id="bc-ih" type="number" value="60" min="10" style="background:#12121e;border:1px solid #333;border-radius:4px;color:#e8eaf0;padding:5px 8px;font-size:13px">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px">
        <span style="color:#888;font-size:11px">水平间距 (px)</span>
        <input id="bc-gx" type="number" value="4" min="0" style="background:#12121e;border:1px solid #333;border-radius:4px;color:#e8eaf0;padding:5px 8px;font-size:13px">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px">
        <span style="color:#888;font-size:11px">垂直间距 (px)</span>
        <input id="bc-gy" type="number" value="4" min="0" style="background:#12121e;border:1px solid #333;border-radius:4px;color:#e8eaf0;padding:5px 8px;font-size:13px">
      </label>
    </div>
    <div id="bc-preview-info" style="margin:14px 0 0;padding:8px 10px;background:#0d0d1a;border-radius:5px;color:#888;font-size:11px;line-height:1.6"></div>
    <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end">
      <button id="bc-cancel" style="padding:7px 18px;background:none;border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:13px">取消</button>
      <button id="bc-confirm" style="padding:7px 18px;background:#7c6af7;border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:13px;font-weight:600">创建</button>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const typeEl  = panel.querySelector('#bc-type');
  const labelEl = panel.querySelector('#bc-label');
  const countEl = panel.querySelector('#bc-count');
  const colsEl  = panel.querySelector('#bc-cols');
  const iwEl    = panel.querySelector('#bc-iw');
  const ihEl    = panel.querySelector('#bc-ih');
  const gxEl    = panel.querySelector('#bc-gx');
  const gyEl    = panel.querySelector('#bc-gy');
  const infoEl  = panel.querySelector('#bc-preview-info');

  function calcLayout() {
    const count = Math.max(1, parseInt(countEl.value) || 1);
    const iw = Math.max(10, parseInt(iwEl.value) || 60);
    const ih = Math.max(10, parseInt(ihEl.value) || 60);
    const gx = Math.max(0, parseInt(gxEl.value) || 0);
    const gy = Math.max(0, parseInt(gyEl.value) || 0);
    const userCols = parseInt(colsEl.value) || 0;
    const cols = userCols > 0 ? userCols : count; // 0=auto → single row
    const rows = Math.ceil(count / cols);
    const pw = 12 + cols * iw + Math.max(0, cols - 1) * gx + 12;
    const ph = 12 + rows * ih + Math.max(0, rows - 1) * gy + 12;
    return { count, iw, ih, gx, gy, cols, rows, pw, ph };
  }

  function updatePreview() {
    const { count, iw, ih, gx, gy, cols, rows, pw, ph } = calcLayout();
    infoEl.innerHTML = `容器尺寸: <b style="color:#9b8af7">${pw} × ${ph}</b>&nbsp;&nbsp;|&nbsp;&nbsp;${cols} 列 × ${rows} 行&nbsp;&nbsp;|&nbsp;&nbsp;每格 ${iw}×${ih}&nbsp;&nbsp;间距 ${gx}/${gy}&nbsp;&nbsp;共 <b style="color:#56cfba">${count}</b> 项`;
  }

  [typeEl, labelEl, countEl, colsEl, iwEl, ihEl, gxEl, gyEl].forEach(el => el.addEventListener('input', updatePreview));
  updatePreview();

  panel.querySelector('#bc-cancel').onclick = () => overlay.remove();
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });

  panel.querySelector('#bc-confirm').onclick = () => {
    const { count, iw, ih, gx, gy, cols, pw, ph } = calcLayout();
    const type  = typeEl.value;
    const label = (labelEl.value.trim() || 'Item') + count;

    saveState();

    // Place at canvas center (viewport mid, accounting for scroll/zoom)
    const canvas = document.getElementById('canvas');
    const vw = canvas ? canvas.clientWidth  : 800;
    const vh = canvas ? canvas.clientHeight : 600;
    const cx = Math.round((vw / 2 - pw / 2) / 8) * 8;
    const cy = Math.round((vh / 2 - ph / 2) / 8) * 8;

    const container = createBox(cx, cy, pw, ph, label, type);
    const def = getWidgetDef(type);
    if (def) { container.borderColor = def.color; container.bgColor = def.bg; }
    if (!container.widgetProps) container.widgetProps = {};
    container.widgetProps.gridPreviewNum = count;
    container.widgetProps.entryWidth  = iw;
    container.widgetProps.entryHeight = ih;
    container.widgetProps.placeHolder = { x: gx, y: gy };
    boxes.push(container);

    // Create EntryClass template child
    const pad = 12;
    const entry = createBox(cx + pad, cy + pad, iw, ih, 'EntryClass', null);
    entry.borderColor = '#e8a020';
    entry.bgColor = 'rgba(232,160,32,0.08)';
    entry.isEntryClass = true;
    entry.parentId = container.id;
    boxes.push(entry);

    recomputeAllParents();
    selectBox(container.id);
    renderAll();
    autoSave();
    overlay.remove();
    showToast(`🔲 已创建 ${type} "${label}" (${count} 项)`);
    log(`批量创建 ${type} "${label}" ${count}项, ${cols}列, 每格${iw}×${ih}`, 'ok');
  };

  // Focus count input
  setTimeout(() => countEl.select && countEl.select(), 50);
}

/* ═══════════════════════════════════════════════════════
   Document System — Alice Style (with folder support)
   API: /docs/api/{list|tree|get|save|delete|mkdir}
   Docs stored in: application/canvas-editor/data/docs/
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const API = '/docs/api';
  let allDocs    = [];   // flat list for sidebar
  let currentDoc = null; // { name, content }
  let isDirty    = false;
  let renderTimer = null;
  let modalMode   = 'doc'; // 'doc' | 'folder'
  let targetFolder = '';   // folder path prefix for new items

  /* ── DOM refs ── */
  const overlay       = document.getElementById('docs-overlay');
  const fileTree      = document.getElementById('docs-file-tree');
  const sidebarList   = document.getElementById('sidebar-doc-list');
  const searchInput   = document.getElementById('docs-search');
  const textarea      = document.getElementById('docs-textarea');
  const preview       = document.getElementById('docs-preview');
  const docTitle      = document.getElementById('docs-doc-title');
  const docArea       = document.getElementById('docs-doc-area');
  const welcome       = document.getElementById('docs-welcome');
  const modalOverlay  = document.getElementById('docs-modal-overlay');
  const modalInput    = document.getElementById('docs-modal-input');
  const modalHint     = document.getElementById('docs-modal-hint');
  const btnDocs       = document.getElementById('btn-docs');
  const btnNew        = document.getElementById('docs-btn-new');
  const btnRefresh    = document.getElementById('docs-btn-refresh');
  const btnClose      = document.getElementById('docs-btn-close');
  const btnSave       = document.getElementById('docs-btn-save');
  const btnDelete     = document.getElementById('docs-btn-delete');
  const btnWelcomeNew = document.getElementById('docs-welcome-new');
  const btnModalCancel  = document.getElementById('docs-modal-cancel');
  const btnModalConfirm = document.getElementById('docs-modal-confirm');
  const sidebarBtnNew   = document.getElementById('sidebar-doc-new');
  const modalTabs       = document.querySelectorAll('.docs-modal-tab');

  /* ── Open / Close overlay ── */
  window.toggleDocsPanel = openOverlay;

  function openOverlay() {
    overlay.classList.add('open');
    if (btnDocs) btnDocs.classList.add('active');
    loadTree();
  }
  function closeOverlay() {
    if (isDirty && !confirm('有未保存的更改，确定关闭？')) return;
    overlay.classList.remove('open');
    if (btnDocs) btnDocs.classList.remove('active');
  }

  btnClose.addEventListener('click', closeOverlay);

  /* ── Load tree ── */
  async function loadTree() {
    _globalLoadTree = loadTree; // expose for context menu
    fileTree.innerHTML = '<div class="docs-tree-empty">加载中…</div>';
    try {
      const res = await fetch(API + '/tree');
      const data = await res.json();
      if (data.success) {
        // Merge uidata files into the uidata folder node (server.js doesn't know .uidata ext yet)
        try {
          const udRes = await fetch('/api/uidatas');
          const udData = await udRes.json();
          if (udData.success && udData.uidatas && udData.uidatas.length) {
            const udFolder = data.tree.find(n => n.type === 'folder' && n.name === 'uidata');
            if (udFolder) {
              udFolder.children = udData.uidatas.map(u => ({
                type: 'file', name: u.name + '.uidata',
                path: 'uidata/' + u.name + '.uidata',
                displayName: u.name, ext: '.uidata', updatedAt: u.updatedAt, size: 0
              }));
            }
          }
        } catch (_) { /* uidata fetch failed — ok */ }

        renderTree(data.tree, fileTree, searchInput.value.toLowerCase());
        renderSidebarTree(data.tree);
        // Keep allDocs flat list for compatibility
        allDocs = [];
        function flattenDocs(items) {
          items.forEach(item => {
            if (item.type === 'folder') flattenDocs(item.children || []);
            else allDocs.push({ name: item.path, updatedAt: item.updatedAt });
          });
        }
        flattenDocs(data.tree);
      }
    } catch (e) {
      fileTree.innerHTML = '<div class="docs-tree-empty">加载失败，请刷新</div>';
    }
  }

  function renderTree(items, container, q) {
    container.innerHTML = '';
    const filtered = q ? flatFilter(items, q) : items;
    if (!filtered.length) {
      const d = document.createElement('div');
      d.className = 'docs-tree-empty';
      d.textContent = q ? '无匹配文档' : '暂无内容，点击 ＋ 新建';
      container.appendChild(d);
      return;
    }
    appendItems(filtered, container, q);
  }

  // Flatten tree for search
  function flatFilter(items, q) {
    const result = [];
    function walk(list) {
      list.forEach(item => {
        if (item.type === 'folder') walk(item.children || []);
        else if (item.name.toLowerCase().includes(q)) result.push(item);
      });
    }
    walk(items);
    return result;
  }

  /* ── Session file helpers ── */
  async function loadSessionFile(filePath) {
    try {
      const res = await fetch(API + '/get?name=' + encodeURIComponent(filePath));
      const data = await res.json();
      if (!data.success) { showToast('⚠ 无法读取存档：' + (data.error || '')); return; }
      // Strip UTF-8 BOM if present (0xFEFF) — can happen with Windows-encoded files
      const rawContent = (data.content || '').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(rawContent);
      if (parsed.nextId) nextId = parsed.nextId;
      if (Array.isArray(parsed.boxes)) {
        if (parsed.version && parsed.version !== '1.0') {
          boxes = deserializeBoxes(parsed.boxes);
        } else {
          boxes = parsed.boxes;
          boxes.forEach(b => { if (!b.anchor) b.anchor = { minX:0, minY:0, maxX:0, maxY:0 }; });
        }
      }
      saveState();
      renderAll();
      const name = filePath.split('/').pop().replace(/\.session$/, '');
      setActiveSession(name, filePath);
      log(`🎨 已加载画布存档「${name}」(${boxes.length} 个节点)`, 'ok');
      showToast(`🎨 已加载「${name}」`);
      // Close docs overlay to show the canvas
      isDirty = false;
      overlay.classList.remove('open');
      if (btnDocs) btnDocs.classList.remove('active');
      // Always zoom-to-fit so the user can clearly see the loaded content
      if (boxes.length > 0) {
        requestAnimationFrame(() => requestAnimationFrame(() => zoomToFit()));
      }
    } catch (e) {
      showToast('⚠ 加载失败：' + e.message);
    }
  }
  // Expose globally so canvas context menu can open sessions
  window.loadSessionFile = loadSessionFile;

  async function saveCanvasAsSession(folderPath) {
    const name = prompt('存档名称（不含扩展名）：', 'session-' + Date.now());
    if (!name) return;
    const filePath = (folderPath ? folderPath + '/' : 'sessions/') + name + '.session';
    const content = JSON.stringify(sessionData(), null, 2);
    try {
      const res = await fetch(API + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: filePath, content })
      });
      const data = await res.json();
      if (data.success) { loadTree(); showToast(`💾 已保存存档「${name}」`); }
      else showToast('⚠ 保存失败：' + (data.error || ''));
    } catch (e) {
      showToast('⚠ 网络错误：' + e.message);
    }
  }

  function appendItems(items, container, q) {
    items.forEach(item => {
      if (item.type === 'folder') {
        // Folder row
        const row = document.createElement('div');
        row.className = 'docs-tree-folder open';
        row.innerHTML = `<span class="docs-tree-chevron">▶</span><span>📁 ${esc(item.name)}</span>`;
        container.appendChild(row);

        // Children container
        const childWrap = document.createElement('div');
        childWrap.className = 'docs-tree-children';
        if (item.children && item.children.length) {
          appendItems(item.children, childWrap, q);
        } else {
          const empty = document.createElement('div');
          empty.className = 'docs-tree-empty';
          empty.style.paddingLeft = '14px';
          empty.textContent = '空文件夹';
          childWrap.appendChild(empty);
        }
        container.appendChild(childWrap);

        // Toggle
        row.addEventListener('click', () => {
          row.classList.toggle('open');
          childWrap.classList.toggle('hidden');
        });

        row.addEventListener('contextmenu', e => {
          e.preventDefault();
          showCtxMenu(e.clientX, e.clientY, [
            { label: '✏️ 重命名文件夹', action: () => {
              const newName = prompt('重命名文件夹：', item.name);
              if (!newName || newName === item.name) return;
              const parentPath = item.path.replace(/[^/]+$/, '');
              fetch(API + '/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oldName: item.path, newName: parentPath + newName })
              }).then(r => r.json()).then(data => {
                if (data.success) { loadTree(); showToast('✏️ 文件夹已重命名：' + newName); }
                else alert('重命名失败：' + (data.error || ''));
              });
            }},
            { label: '🗑 删除文件夹', action: async () => {
              if (!confirm(`确定删除文件夹「${item.name}」及其所有内容？`)) return;
              const res = await fetch(API + '/delete?name=' + encodeURIComponent(item.path), { method: 'DELETE' });
              const data = await res.json();
              if (data.success) { loadTree(); showToast('🗑 已删除文件夹：' + item.name); }
              else alert('删除失败：' + (data.error || ''));
            }}
          ]);
        });
      } else {
        // File row
        const isSession = item.name.endsWith('.session');
        const row = document.createElement('div');
        row.className = 'docs-tree-item' + (currentDoc && currentDoc.name === item.path ? ' active' : '');
        const d = new Date(item.updatedAt);
        const label = item.name;
        const icon = isSession ? '🎨' : '📄';
        row.innerHTML = `<span>${icon} ${esc(label)}</span><span class="docs-tree-meta">${d.getMonth()+1}/${d.getDate()}</span>`;

        if (isSession) {
          row.title = '单击加载到画布';
          row.addEventListener('click', () => loadSessionFile(item.path));
        } else {
          row.addEventListener('click', () => openDoc(item.path));
        }

        row.addEventListener('contextmenu', e => {
          e.preventDefault();
          const baseItems = [
            { label: '✏️ 重命名（含后缀）', action: () => {
              const newName = prompt('重命名（含后缀）：', item.name);
              if (!newName || newName === item.name) return;
              const parentPath = item.path.replace(/[^/]+$/, '');
              fetch(API + '/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oldName: item.path, newName: parentPath + newName })
              }).then(r => r.json()).then(data => {
                if (data.success) { loadTree(); showToast('✏️ 已重命名：' + newName); }
                else alert('重命名失败：' + (data.error || ''));
              });
            }},
            { label: '🗑 删除', action: async () => {
              if (!confirm(`确定删除「${item.name}」？`)) return;
              const res = await fetch(API + '/delete?name=' + encodeURIComponent(item.path), { method: 'DELETE' });
              const data = await res.json();
              if (data.success) {
                if (currentDoc && currentDoc.name === item.path) { currentDoc = null; textarea.value = ''; docTitle.textContent = '未选择'; }
                loadTree();
                showToast('🗑 已删除：' + item.name);
              } else { alert('删除失败：' + (data.error || '')); }
            }}
          ];
          if (isSession) {
            const backupPath = item.path.replace(/\.session$/, '') + '_backup.session';
            const menuItems = [{ label: '🎨 加载到画布', action: () => loadSessionFile(item.path) }, ...baseItems];
            // Check if backup exists then show restore option
            fetch(API + '/get?name=' + encodeURIComponent(backupPath))
              .then(r => r.json())
              .then(d => {
                if (d.success) menuItems.splice(1, 0, { label: '♻️ 从备份恢复', action: () => { if (confirm('将从备份还原画布，确定？')) loadSessionFile(backupPath); } });
                showCtxMenu(e.clientX, e.clientY, menuItems);
              })
              .catch(() => showCtxMenu(e.clientX, e.clientY, menuItems));
          } else {
            showCtxMenu(e.clientX, e.clientY, baseItems);
          }
        });
        container.appendChild(row);
      }
    });
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase();
    if (!q) { loadTree(); return; }
    // Flatten search
    fetch(API + '/tree').then(r => r.json()).then(data => {
      if (data.success) renderTree(data.tree, fileTree, q);
    }).catch(() => {});
  });

  btnRefresh.addEventListener('click', loadTree);

  function renderSidebarTree(items) {
    if (!sidebarList) return;
    sidebarList.innerHTML = '';
    let hasContent = false;

    function walk(list, depth, container) {
      container = container || sidebarList;
      list.forEach(item => {
        hasContent = true;
        if (item.type === 'folder') {
          // Wrapper li — valid HTML: ul > li > (div header + ul children)
          const li = document.createElement('li');
          li.className = 'sidebar-doc-folder-item';
          li.dataset.path = item.path;

          const header = document.createElement('div');
          header.className = 'sidebar-doc-folder';
          header.style.paddingLeft = (10 + depth * 10) + 'px';

          const chevron = document.createElement('span');
          chevron.className = 'sb-chevron';
          chevron.style.cssText = 'display:inline-block;font-size:9px;margin-right:4px;transition:transform 0.15s;transform:rotate(90deg)';
          chevron.textContent = '▶';

          const label = document.createElement('span');
          label.style.flex = '1';
          label.textContent = '📁 ' + item.name;

          const addBtn = document.createElement('button');
          addBtn.className = 'sb-folder-add';
          addBtn.title = '在此文件夹内新建';
          addBtn.textContent = '＋';
          addBtn.addEventListener('click', e => {
            e.stopPropagation();
            targetFolder = item.path;
            openModal('doc');
          });

          header.appendChild(chevron);
          header.appendChild(label);
          header.appendChild(addBtn);
          li.appendChild(header);

          // Children ul — inside li (valid HTML!)
          const childGroup = document.createElement('ul');
          childGroup.className = 'sb-children';
          li.appendChild(childGroup);

          if (item.children && item.children.length) {
            walk(item.children, depth + 1, childGroup);
          } else {
            const empty = document.createElement('li');
            empty.className = 'sidebar-doc-empty';
            empty.style.paddingLeft = (10 + (depth + 1) * 10) + 'px';
            empty.textContent = '空文件夹';
            childGroup.appendChild(empty);
          }

          header.addEventListener('click', () => {
            const nowOpen = chevron.style.transform === 'rotate(90deg)';
            chevron.style.transform = nowOpen ? '' : 'rotate(90deg)';
            childGroup.style.display = nowOpen ? 'none' : '';
          });

          header.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            const isSessionsFolder = item.name === 'sessions';
            const isUiDataFolder = item.name === 'uidata';
            const menuItems = [
              { label: '✏️ 重命名文件夹', action: () => {
                const newName = prompt('重命名文件夹：', item.name);
                if (!newName || newName === item.name) return;
                const parentPath = item.path.replace(/[^/]+$/, '');
                fetch(API + '/rename', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ oldName: item.path, newName: parentPath + newName })
                }).then(r => r.json()).then(data => {
                  if (data.success) { loadTree(); showToast('✏️ 文件夹已重命名：' + newName); }
                  else alert('重命名失败：' + (data.error || ''));
                });
              }},
              { label: '🗑 删除文件夹', action: async () => {
                if (!confirm(`确定删除文件夹「${item.name}」及其所有内容？`)) return;
                const res = await fetch(API + '/delete?name=' + encodeURIComponent(item.path), { method: 'DELETE' });
                const data = await res.json();
                if (data.success) { loadTree(); showToast('🗑 已删除文件夹：' + item.name); }
                else alert('删除失败：' + (data.error || ''));
              }}
            ];
            if (isSessionsFolder) {
              menuItems.unshift({ label: '💾 保存当前画布', action: () => saveCanvasAsSession(item.path) });
            }
            if (isUiDataFolder) {
              menuItems.unshift({ label: '🗄 为当前画布创建/更新 UiData', action: async () => {
                if (!_sessionName) { alert('请先加载一个画布 Session'); return; }
                const res = await fetch('/api/uidata/' + encodeURIComponent(_sessionName));
                const json = await res.json();
                const existingRoot = json.success && json.data ? json.data.root : null;
                const tree = buildUidataTree(existingRoot);
                await saveUiData(_sessionName, tree);
                await loadUiData(_sessionName);
                loadTree();
                showToast('🗄 UiData 已创建/更新：' + _sessionName + '.uidata');
              }});
            }
            showCtxMenu(e.clientX, e.clientY, menuItems);
          });

          container.appendChild(li);

        } else {
          const isSession = item.name.endsWith('.session');
          const isUiData = item.name.endsWith('.uidata');
          const li = document.createElement('li');
          li.style.cssText = `padding-left:${10 + depth * 10}px;display:flex;align-items:center;gap:4px;`;
          li.title = isSession ? '点击加载此画布存档' : isUiData ? '点击打开数据编辑器' : item.path;
          if (!isSession && !isUiData && currentDoc && currentDoc.name === item.path) li.classList.add('active');

          if (isSession) {
            const nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#56cfba;cursor:pointer';
            nameSpan.textContent = '🎨 ' + item.name;
            nameSpan.addEventListener('click', () => loadSessionFile(item.path));

            const viewBtn = document.createElement('button');
            viewBtn.textContent = '📄';
            viewBtn.title = '文档方式查看';
            viewBtn.style.cssText = 'background:none;border:none;cursor:pointer;padding:1px 4px;font-size:11px;color:#888;flex-shrink:0;border-radius:3px';
            viewBtn.addEventListener('mouseenter', () => viewBtn.style.color = '#ccc');
            viewBtn.addEventListener('mouseleave', () => viewBtn.style.color = '#888');
            viewBtn.addEventListener('click', e => {
              e.stopPropagation();
              openOverlay();
              openDoc(item.path);
            });

            li.appendChild(nameSpan);
            li.appendChild(viewBtn);
          } else if (isUiData) {
            const nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c89ef7;cursor:pointer';
            nameSpan.textContent = '🗄 ' + item.name;
            nameSpan.addEventListener('click', async () => {
              // Load uidata by name and open editor
              const udName = item.name.replace(/\.uidata$/, '');
              await loadUiData(udName);
              // Try to also load the matching session if exists
              const sessionPath = 'sessions/' + udName + '.session';
              const checkRes = await fetch('/docs/api/get?name=' + encodeURIComponent(sessionPath)).catch(() => null);
              if (checkRes) {
                const checkData = await checkRes.json().catch(() => null);
                if (checkData && checkData.success) {
                  await loadSessionFile(sessionPath);
                }
              }
              showUidataEditor();
            });

            const editBtn = document.createElement('button');
            editBtn.textContent = '✏';
            editBtn.title = '编辑数据绑定';
            editBtn.style.cssText = 'background:none;border:none;cursor:pointer;padding:1px 4px;font-size:11px;color:#888;flex-shrink:0;border-radius:3px';
            editBtn.addEventListener('mouseenter', () => editBtn.style.color = '#c89ef7');
            editBtn.addEventListener('mouseleave', () => editBtn.style.color = '#888');
            editBtn.addEventListener('click', async e => {
              e.stopPropagation();
              const udName = item.name.replace(/\.uidata$/, '');
              await loadUiData(udName);
              showUidataEditor();
            });

            li.appendChild(nameSpan);
            li.appendChild(editBtn);
          } else {
            li.textContent = '📄 ' + item.name;
            li.style.cursor = 'pointer';
            li.addEventListener('click', () => { openOverlay(); openDoc(item.path); });
          }
          li.addEventListener('contextmenu', e => {
            e.preventDefault();
            const baseItems = [
              ...(isSession ? [
                { label: '🎨 加载到画布', action: () => loadSessionFile(item.path) },
                { label: '📄 用文档打开', action: () => { openOverlay(); openDoc(item.path); } },
              ] : isUiData ? [
                { label: '🗄 打开数据编辑器', action: async () => {
                  const udName = item.name.replace(/\.uidata$/, '');
                  await loadUiData(udName);
                  showUidataEditor();
                }},
                { label: '📄 用文档查看原始JSON', action: () => { openOverlay(); openDoc(item.path); } },
              ] : [{ label: '✏️ 重命名', action: () => {
                const newName = prompt(`重命名（含后缀）：`, item.name);
                if (!newName || newName === item.name) return;
                fetch(API + '/rename', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ oldName: item.path, newName: item.path.replace(/[^/]+$/, '') + newName })
                }).then(r => r.json()).then(data => {
                  if (data.success) { loadTree(); showToast('✏️ 已重命名：' + newName); }
                  else alert('重命名失败：' + (data.error || ''));
                });
              }}]),
              { label: '🗑 删除', action: async () => {
                if (!confirm(`确定删除「${item.name}」？`)) return;
                const res = await fetch(API + '/delete?name=' + encodeURIComponent(item.path), { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                  if (!isSession && !isUiData && currentDoc && currentDoc.name === item.path) { currentDoc = null; textarea.value = ''; docTitle.textContent = '未选择'; }
                  loadTree();
                  showToast('🗑 已删除：' + item.name);
                } else { alert('删除失败：' + (data.error || '')); }
              }}
            ];
            if (isSession) {
              const backupPath = item.path.replace(/\.session$/, '') + '_backup.session';
              fetch(API + '/get?name=' + encodeURIComponent(backupPath))
                .then(r => r.json())
                .then(d => {
                  if (d.success) baseItems.splice(2, 0, { label: '♻️ 从备份恢复', action: () => { if (confirm('将从备份还原画布，确定？')) loadSessionFile(backupPath); } });
                  showCtxMenu(e.clientX, e.clientY, baseItems);
                })
                .catch(() => showCtxMenu(e.clientX, e.clientY, baseItems));
            } else {
              showCtxMenu(e.clientX, e.clientY, baseItems);
            }
          });
          container.appendChild(li);
        }
      });
    }

    walk(items, 0, sidebarList);

    if (!hasContent) {
      const li = document.createElement('li');
      li.className = 'sidebar-doc-empty';
      li.textContent = '暂无文档';
      sidebarList.appendChild(li);
    }
  }

  function renderSidebarList(docs) {
    if (!sidebarList) return;
    sidebarList.innerHTML = '';
    if (!docs.length) {
      const li = document.createElement('li');
      li.className = 'sidebar-doc-empty';
      li.textContent = '暂无文档';
      sidebarList.appendChild(li);
      return;
    }
    docs.forEach(doc => {
      const li = document.createElement('li');
      const shortName = doc.name.split('/').pop();
      li.textContent = '📄 ' + shortName;
      li.title = doc.name;
      if (currentDoc && currentDoc.name === doc.name) li.classList.add('active');
      li.addEventListener('click', () => { openOverlay(); openDoc(doc.name); });
      sidebarList.appendChild(li);
    });
  }

  /* ── Open document ── */
  async function openDoc(name) {
    if (isDirty && !confirm('有未保存的更改，确定切换？')) return;
    try {
      const res = await fetch(API + '/get?name=' + encodeURIComponent(name));
      const data = await res.json();
      if (!data.success) { alert('打开失败: ' + data.error); return; }
      currentDoc = { name: data.name, content: data.content, ext: data.ext || '.md' };
      isDirty = false;
      textarea.value = data.content;
      docTitle.textContent = data.name.split('/').pop();
      showDocArea();
      if (currentDoc.ext === '.json' || currentDoc.ext === '.session' || currentDoc.ext === '.uidata') {
        preview.textContent = data.content; // show raw for JSON/session/uidata
      } else {
        renderPreview(data.content);
      }
      // Refresh tree to update active state
      await loadTree();
    } catch (e) {
      alert('网络错误: ' + e.message);
    }
  }

  function showDocArea() { welcome.style.display = 'none'; docArea.style.display = 'flex'; }
  function showWelcome()  { welcome.style.display = ''; docArea.style.display = 'none'; }

  /* ── Live preview ── */
  function renderPreview(content) {
    if (typeof marked === 'undefined') { preview.textContent = content; return; }
    marked.setOptions({ breaks: true, gfm: true });
    preview.innerHTML = marked.parse(content || '');
    if (typeof hljs !== 'undefined') {
      preview.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
    }
  }

  textarea.addEventListener('input', () => {
    isDirty = true;
    docTitle.textContent = (currentDoc ? currentDoc.name.split('/').pop() : '未命名') + ' ●';
    clearTimeout(renderTimer);
    if (currentDoc && currentDoc.ext === '.json') {
      renderTimer = setTimeout(() => { preview.textContent = textarea.value; }, 300);
    } else {
      renderTimer = setTimeout(() => renderPreview(textarea.value), 300);
    }
  });

  /* ── Save ── */
  async function saveDoc() {
    if (!currentDoc) return;
    const content = textarea.value;
    try {
      const res = await fetch(API + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: currentDoc.name, content })
      });
      const data = await res.json();
      if (data.success) {
        currentDoc.content = content; isDirty = false;
        docTitle.textContent = currentDoc.name.split('/').pop();
        await loadTree();
      } else { alert('保存失败: ' + data.error); }
    } catch (e) { alert('网络错误: ' + e.message); }
  }
  btnSave.addEventListener('click', saveDoc);

  /* ── Delete ── */
  btnDelete.addEventListener('click', async () => {
    if (!currentDoc) return;
    if (!confirm(`确定删除「${currentDoc.name}」？`)) return;
    try {
      const res = await fetch(API + '/delete?name=' + encodeURIComponent(currentDoc.name), { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        currentDoc = null; isDirty = false;
        showWelcome(); await loadTree();
      } else { alert('删除失败: ' + data.error); }
    } catch (e) { alert('网络错误: ' + e.message); }
  });

  /* ── Modal: new doc / new folder ── */
  function openModal(mode) {
    modalMode = mode || 'doc';
    modalTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === modalMode));
    updateModalHint();
    // Pre-fill with target folder prefix if set
    modalInput.value = targetFolder ? targetFolder + '/' : '';
    modalOverlay.classList.add('open');
    setTimeout(() => { modalInput.focus(); modalInput.setSelectionRange(modalInput.value.length, modalInput.value.length); }, 50);
  }
  function updateModalHint() {
    if (modalMode === 'doc') {
      modalHint.innerHTML = '文档名（可用 / 指定路径，如 <code>项目/笔记</code>）';
      modalInput.placeholder = '文档名称…';
    } else {
      modalHint.innerHTML = '文件夹名（可用 / 嵌套，如 <code>项目/子目录</code>）';
      modalInput.placeholder = '文件夹名称…';
    }
  }

  modalTabs.forEach(tab => {
    tab.addEventListener('click', () => { modalMode = tab.dataset.mode; openModal(modalMode); });
  });

  async function confirmModal() {
    const name = modalInput.value.trim();
    if (!name) { modalInput.focus(); return; }
    if (modalMode === 'folder') {
      // Create folder
      try {
        const res = await fetch(API + '/mkdir', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.success) {
          targetFolder = '';
          modalOverlay.classList.remove('open');
          await loadTree();
          showToast('📁 文件夹已创建：' + name);
        } else { alert('创建失败: ' + data.error); }
      } catch (e) { alert('网络错误: ' + e.message); }
    } else {
      // Create document
      try {
        const res = await fetch(API + '/save', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, content: `# ${name.split('/').pop()}\n\n` })
        });
        const data = await res.json();
        if (data.success) {
          targetFolder = '';
          modalOverlay.classList.remove('open');
          await loadTree();
          if (!overlay.classList.contains('open')) openOverlay();
          await openDoc(name);
        } else { alert('创建失败: ' + data.error); }
      } catch (e) { alert('网络错误: ' + e.message); }
    }
  }

  btnNew.addEventListener('click', () => { targetFolder = ''; openModal('doc'); });
  btnWelcomeNew.addEventListener('click', () => { targetFolder = ''; openModal('doc'); });
  if (sidebarBtnNew) sidebarBtnNew.addEventListener('click', () => { targetFolder = ''; openModal('doc'); });
  btnModalCancel.addEventListener('click', () => { targetFolder = ''; modalOverlay.classList.remove('open'); });
  btnModalConfirm.addEventListener('click', confirmModal);
  modalInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmModal();
    if (e.key === 'Escape') { targetFolder = ''; modalOverlay.classList.remove('open'); }
  });

  /* ── Split divider resize ── */
  const divider     = document.getElementById('docs-split-divider');
  const editorPane  = document.getElementById('docs-editor-pane');
  const previewPane = document.getElementById('docs-preview-pane');
  let dragging = false, startX = 0, startW = 0;
  divider.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX;
    startW = editorPane.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const container = editorPane.parentElement.getBoundingClientRect().width;
    const newW = Math.max(200, Math.min(startW + e.clientX - startX, container - 204));
    const r = newW / container;
    editorPane.style.flex = `0 0 ${(r*100).toFixed(1)}%`;
    previewPane.style.flex = `0 0 ${((1-r)*100).toFixed(1)}%`;
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; }
  });

  /* ── Keyboard shortcuts ── */
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'd') { e.preventDefault(); overlay.classList.contains('open') ? closeOverlay() : openOverlay(); return; }
    if (!overlay.classList.contains('open')) return;
    if (e.key === 'Escape' && !modalOverlay.classList.contains('open')) { closeOverlay(); return; }
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveDoc(); return; }
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); openModal('doc'); return; }
  });

  /* ── Tab key in textarea ── */
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = textarea.selectionStart, end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, s) + '  ' + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = s + 2;
    }
  });

  /* ── Helpers ── */
  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function showToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:#1e2028;color:#e8eaf0;padding:8px 18px;border-radius:8px;font-size:13px;z-index:9999;border:1px solid rgba(255,255,255,0.12);box-shadow:0 4px 16px rgba(0,0,0,0.4);pointer-events:none;transition:opacity 0.4s;white-space:nowrap';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2200);
  }

  let _ctxMenu = null;
  function showCtxMenu(x, y, items) {
    if (_ctxMenu) _ctxMenu.remove();
    const menu = document.createElement('div');
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;background:#1e2028;border:1px solid rgba(255,255,255,0.12);border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,0.5);z-index:99999;min-width:120px;overflow:hidden`;
    items.forEach(item => {
      const btn = document.createElement('div');
      btn.style.cssText = 'padding:8px 14px;cursor:pointer;font-size:13px;color:#e8eaf0;white-space:nowrap;transition:background 0.1s';
      btn.textContent = item.label;
      btn.onmouseenter = () => btn.style.background = 'rgba(255,255,255,0.08)';
      btn.onmouseleave = () => btn.style.background = '';
      btn.addEventListener('click', () => { menu.remove(); _ctxMenu = null; item.action(); });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    _ctxMenu = menu;
    const dismiss = e => { if (!menu.contains(e.target)) { menu.remove(); _ctxMenu = null; document.removeEventListener('mousedown', dismiss); } };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  }

  /* ── Init sidebar on page load ── */
  (async function init() {
    try {
      const res = await fetch(API + '/tree');
      const data = await res.json();
      if (data.success) {
        // Merge uidata files into the uidata folder node
        try {
          const udRes = await fetch('/api/uidatas');
          const udData = await udRes.json();
          if (udData.success && udData.uidatas && udData.uidatas.length) {
            const udFolder = data.tree.find(n => n.type === 'folder' && n.name === 'uidata');
            if (udFolder) {
              udFolder.children = udData.uidatas.map(u => ({
                type: 'file', name: u.name + '.uidata',
                path: 'uidata/' + u.name + '.uidata',
                displayName: u.name, ext: '.uidata', updatedAt: u.updatedAt, size: 0
              }));
            }
          }
        } catch (_) {}
        renderSidebarTree(data.tree);
        allDocs = [];
        function flattenDocs(items) {
          items.forEach(item => {
            if (item.type === 'folder') flattenDocs(item.children || []);
            else allDocs.push({ name: item.path, updatedAt: item.updatedAt });
          });
        }
        flattenDocs(data.tree);
      }
    } catch (_) {}

    // Auto-load EntryClass session from URL param ?ecload=<path>
    const _ecLoadPath = new URLSearchParams(location.search).get('ecload');
    if (_ecLoadPath && window.loadSessionFile) {
      setTimeout(() => window.loadSessionFile(_ecLoadPath), 600);
    }
  })();
})();

/* ───── Console / Chat Tab ───── */
let _chatLastLoadedSession = null;

function switchConsoleTab(tab) {
  const consolePane = document.getElementById('console-pane');
  const chatPane    = document.getElementById('chat-pane');
  const tabBtns     = document.querySelectorAll('.console-tab');
  const clearBtn    = document.getElementById('btn-clear-console');

  tabBtns.forEach(btn => btn.classList.toggle('active', btn.id === 'tab-' + tab));
  if (tab === 'console') {
    consolePane.style.display = '';
    chatPane.style.display    = 'none';
    if (clearBtn) clearBtn.style.display = '';
  } else {
    consolePane.style.display = 'none';
    chatPane.style.display    = '';
    if (clearBtn) clearBtn.style.display = 'none';
    // Restore saved session ID
    const saved = localStorage.getItem('chat-session-id');
    const inp = document.getElementById('chat-session-id');
    if (inp && saved && !inp.value) inp.value = saved;
    document.getElementById('chat-input')?.focus();
    // Load session history on first open (or if session changed)
    const currentSession = inp?.value.trim() || '';
    if (currentSession && currentSession !== _chatLastLoadedSession) {
      _chatLastLoadedSession = currentSession;
      if (typeof window.loadChatHistory === 'function') window.loadChatHistory();
    }
  }
}

// Persist session ID on change
document.getElementById('chat-session-id')?.addEventListener('input', function() {
  localStorage.setItem('chat-session-id', this.value.trim());
});

// Ctrl+Enter sends message
document.getElementById('chat-input')?.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); chatSend(); }
});

function chatAddMsg(text, role) {
  const wrap = document.getElementById('chat-messages');
  if (!wrap) return;
  const div = document.createElement('div');
  div.className = 'chat-msg chat-msg-' + role;
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  div.innerHTML = `<span class="chat-ts">${ts}</span><span class="chat-text">${text.replace(/</g,'&lt;').replace(/\n/g,'<br>')}</span>`;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

async function chatSend() {
  const sessionInp = document.getElementById('chat-session-id');
  const textInp    = document.getElementById('chat-input');
  const sendBtn    = document.getElementById('chat-send-btn');
  const sessionId  = sessionInp?.value.trim();
  const task       = textInp?.value.trim();

  if (!sessionId) { sessionInp?.focus(); showToast('⚠ 请先填写 Session ID'); return; }
  if (!task)      { textInp?.focus(); return; }

  chatAddMsg(task, 'user');
  textInp.value = '';
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '发送中…'; }

  try {
    const res = await fetch('http://localhost:7439/agent/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, task })
    });
    const data = await res.json();
    if (data.success) {
      chatAddMsg('✅ 任务已送达，爱丽丝处理中…', 'system');
    } else {
      chatAddMsg('❌ 发送失败：' + (data.error || '未知错误'), 'system');
    }
  } catch (err) {
    chatAddMsg('❌ 网络错误：' + err.message, 'system');
  } finally {
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '发送'; }
  }
}

/* ═══════════════════════════════════════════════════════
   Assets Panel — 查看当前 session 引用的所有资源
   ═══════════════════════════════════════════════════════ */
(function initAssetsPanel() {
  const panel    = document.getElementById('assets-panel');
  const listEl   = document.getElementById('assets-list');
  const countEl  = document.getElementById('assets-count');
  const refreshBtn = document.getElementById('assets-refresh-btn');
  const closeBtn   = document.getElementById('assets-close-btn');
  const btnAssets  = document.getElementById('btn-assets');
  if (!panel || !listEl) return;

  // Resource type definitions — which widgetProps keys may contain asset paths/URLs
  const RESOURCE_KEYS = [
    { key: 'imagePath',  label: '图片',  icon: '🖼️',  type: 'image' },
    { key: 'src',        label: '图片',  icon: '🖼️',  type: 'image' },
    { key: 'bgImage',    label: '背景图',icon: '🖼️',  type: 'image' },
    { key: 'fontPath',   label: '字体',  icon: '🔤',  type: 'font'  },
    { key: 'soundPath',  label: '音效',  icon: '🔊',  type: 'audio' },
    { key: 'videoPath',  label: '视频',  icon: '🎬',  type: 'video' },
    { key: 'dataPath',   label: '数据',  icon: '📊',  type: 'data'  },
  ];

  function collectResources() {
    const results = []; // { boxId, boxLabel, key, value, icon, label }
    function scanBox(box) {
      const props = box.widgetProps || {};
      RESOURCE_KEYS.forEach(({ key, label, icon }) => {
        const val = props[key];
        if (val && typeof val === 'string' && val.trim()) {
          results.push({ boxId: box.id, boxLabel: box.label || `#${box.id}`, widgetType: box.widgetType || '', key, value: val.trim(), icon, label });
        }
      });
      // Also scan all string props for URL-like values (http/https/data:)
      Object.entries(props).forEach(([k, v]) => {
        if (typeof v === 'string' && v.trim() && (v.startsWith('http') || v.startsWith('data:') || v.match(/\.(png|jpg|jpeg|gif|svg|webp|mp3|wav|ogg|ttf|otf|woff)$/i))) {
          if (!RESOURCE_KEYS.find(r => r.key === k)) {
            results.push({ boxId: box.id, boxLabel: box.label || `#${box.id}`, widgetType: box.widgetType || '', key: k, value: v.trim(), icon: '📎', label: k });
          }
        }
      });
      if (box.children && box.children.length) box.children.forEach(scanBox);
    }
    boxes.forEach(scanBox);
    return results;
  }

  function renderResources() {
    const resources = collectResources();
    countEl.textContent = resources.length ? `(${resources.length})` : '';
    if (!resources.length) {
      listEl.innerHTML = '<div class="assets-empty">当前 session 没有引用任何资源<br><span style="font-size:10px;opacity:0.5">使用 Image 控件并填写图片路径后，资源会显示在这里</span></div>';
      return;
    }
    // Group by type (icon)
    const groups = {};
    resources.forEach(r => {
      const g = r.label;
      if (!groups[g]) groups[g] = [];
      groups[g].push(r);
    });
    listEl.innerHTML = '';
    Object.entries(groups).forEach(([groupName, items]) => {
      const header = document.createElement('div');
      header.className = 'assets-group-header';
      header.textContent = `${items[0].icon} ${groupName} (${items.length})`;
      listEl.appendChild(header);
      items.forEach(r => {
        const row = document.createElement('div');
        row.className = 'asset-item';
        const fileName = r.value.split(/[/\\]/).pop() || r.value;
        const isImg = /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp)(\?.*)?$/i.test(r.value) || r.value.startsWith('data:image');
        const thumbHtml = isImg
          ? `<img src="${r.value}" class="asset-thumb" title="${r.value}" style="width:48px;height:48px;object-fit:contain;border:1px solid #333;border-radius:4px;background:#111;flex-shrink:0" onerror="this.style.opacity='0.2'">`
          : `<div class="asset-item-icon">${r.icon}</div>`;
        row.innerHTML = `
          ${thumbHtml}
          <div class="asset-item-body">
            <div class="asset-item-label" title="${r.boxLabel} (${r.widgetType})">${r.boxLabel}</div>
            <div class="asset-item-path" title="${r.value}">${r.value}</div>
          </div>
          <button class="asset-copy-btn" data-val="${r.value.replace(/"/g,'&quot;')}">复制</button>
        `;
        // Click row → select the box
        row.addEventListener('click', e => {
          if (e.target.classList.contains('asset-copy-btn')) return;
          selectBox(r.boxId);
          renderAll();
          const propsTab = document.querySelector('.right-tab[data-tab="props"]');
          if (propsTab) propsTab.click();
        });
        // Copy button
        const copyBtn = row.querySelector('.asset-copy-btn');
        copyBtn.addEventListener('click', e => {
          e.stopPropagation();
          navigator.clipboard.writeText(r.value).then(() => {
            copyBtn.classList.add('copied');
            copyBtn.textContent = '✓';
            setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.textContent = '复制'; }, 1500);
          }).catch(() => {});
        });
        listEl.appendChild(row);
      });
    });
  }

  // Make panel draggable by header
  const header = document.getElementById('assets-panel-header');
  let _drag = null;
  header.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON') return;
    // Resolve centered position to absolute before dragging
    const rect = panel.getBoundingClientRect();
    panel.style.transform = 'none';
    panel.style.left = rect.left + 'px';
    panel.style.top  = rect.top  + 'px';
    _drag = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!_drag) return;
    panel.style.left = (_drag.origLeft + e.clientX - _drag.startX) + 'px';
    panel.style.top  = (_drag.origTop  + e.clientY - _drag.startY) + 'px';
  });
  document.addEventListener('mouseup', () => { _drag = null; });

  function openPanel() {
    // Reset to centered position each time it opens
    panel.style.left = '50%';
    panel.style.top = '50px';
    panel.style.transform = 'translateX(-50%)';
    panel.style.display = 'flex';
    if (btnAssets) btnAssets.classList.add('active');
    renderResources();
  }
  function closePanel() {
    panel.style.display = 'none';
    if (btnAssets) btnAssets.classList.remove('active');
  }

  refreshBtn.addEventListener('click', renderResources);
  closeBtn.addEventListener('click', closePanel);

  window.openAssetsPanel = () => {
    if (panel.style.display !== 'none') { closePanel(); return; }
    openPanel();
  };

})();
