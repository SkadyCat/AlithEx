// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  workspaces: [],
  currentWorkspace: "",
  currentSummary: null,
  selectedItem: null,
  refreshTimer: null,
  contextMenu: null,
  openDraft: null,
  draggedDraft: null,
};

const DEV_WORKSPACE = "Alith";
const pageMode = document.body?.dataset?.page || "";
const isDevPage = pageMode === "dev" || window.location.pathname.toLowerCase() === "/dev";

// ─── DOM refs ────────────────────────────────────────────────────────────────
const workspaceList        = document.getElementById("workspace_list");
const workspaceForm        = document.getElementById("workspace_form");
const workspaceInput       = document.getElementById("workspace_name");
const currentWorkspaceName = document.getElementById("current_workspace_name");
const refreshButton        = document.getElementById("refresh_button");
const runAgentButton       = document.getElementById("run_agent_button");
const saveModelButton      = document.getElementById("save_model_button");
const modelInput           = document.getElementById("model_input");
const newDraftButton       = document.getElementById("new_draft_button");
const chatForm             = document.getElementById("chat_form");
const chatInput            = document.getElementById("chat_input");
const searchInput          = document.getElementById("search_input");
const searchButton         = document.getElementById("search_button");
const searchResults        = document.getElementById("search_results");
const detailPanel          = document.getElementById("detail_panel");
const detailTitle          = document.getElementById("detail_title");
const toast                = document.getElementById("toast");
const draftModal           = document.getElementById("draft_modal");
const draftCloseButton     = document.getElementById("draft_close_button");
const draftSaveButton      = document.getElementById("draft_save_button");
const draftPromoteButton   = document.getElementById("draft_promote_button");
const draftEditorInput     = document.getElementById("draft_editor_input");
const draftPreview         = document.getElementById("draft_preview");
const draftModalMeta       = document.getElementById("draft_modal_meta");

const contextMenu = document.createElement("div");
contextMenu.className = "context-menu hidden";
contextMenu.hidden = true;
document.body.appendChild(contextMenu);

const bucketContainers = {
  drafts:    document.getElementById("drafts_cards"),
  sessions:  document.getElementById("sessions_cards"),
  inprocess: document.getElementById("inprocess_cards"),
  processed: document.getElementById("processed_cards"),
};
const countEls = {
  drafts:    document.getElementById("count_drafts"),
  sessions:  document.getElementById("count_sessions"),
  inprocess: document.getElementById("count_inprocess"),
  processed: document.getElementById("count_processed"),
};
const statEls = {
  drafts:    document.getElementById("stat_drafts"),
  sessions:  document.getElementById("stat_sessions"),
  inprocess: document.getElementById("stat_inprocess"),
  processed: document.getElementById("stat_processed"),
  docs:      document.getElementById("stat_docs"),
};

// ─── Utilities ───────────────────────────────────────────────────────────────
async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败。");
  return data;
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function extractDraftTitle(content, fallback) {
  const lines = String(content || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => line.startsWith("#"));
  if (heading) {
    return heading.replace(/^#+\s*/, "").trim() || fallback;
  }
  return lines[0] || fallback;
}

function renderInlineMarkdown(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderMarkdown(markdown) {
  const source = String(markdown || "").replace(/\r/g, "");
  if (!source.trim()) {
    return "";
  }

  const lines = source.split("\n");
  let html = "";
  let inCode = false;
  let codeBuffer = [];
  let listType = "";
  let listBuffer = [];
  let paragraph = [];
  let blockquote = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    html += `<p>${paragraph.map((line) => renderInlineMarkdown(line)).join("<br />")}</p>`;
    paragraph = [];
  }

  function flushList() {
    if (!listType || !listBuffer.length) return;
    const tag = listType === "ol" ? "ol" : "ul";
    html += `<${tag}>${listBuffer.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${tag}>`;
    listBuffer = [];
    listType = "";
  }

  function flushBlockquote() {
    if (!blockquote.length) return;
    html += `<blockquote>${blockquote.map((line) => renderInlineMarkdown(line)).join("<br />")}</blockquote>`;
    blockquote = [];
  }

  function flushCode() {
    if (!inCode) return;
    html += `<pre><code>${esc(codeBuffer.join("\n"))}</code></pre>`;
    codeBuffer = [];
    inCode = false;
  }

  lines.forEach((line) => {
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      flushBlockquote();
      if (inCode) {
        flushCode();
      } else {
        inCode = true;
      }
      return;
    }

    if (inCode) {
      codeBuffer.push(line);
      return;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushBlockquote();
      return;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushBlockquote();
      const level = heading[1].length;
      html += `<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`;
      return;
    }

    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushBlockquote();
      html += "<hr />";
      return;
    }

    const unordered = line.match(/^\s*[-*]\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      flushBlockquote();
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      listBuffer.push(unordered[1]);
      return;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      flushBlockquote();
      if (listType && listType !== "ol") {
        flushList();
      }
      listType = "ol";
      listBuffer.push(ordered[1]);
      return;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      blockquote.push(quote[1]);
      return;
    }

    flushList();
    flushBlockquote();
    paragraph.push(line);
  });

  flushParagraph();
  flushList();
  flushBlockquote();
  flushCode();
  return html;
}

async function copyText(value) {
  const text = String(value || "");
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "readonly");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  document.body.removeChild(input);
}

function hideContextMenu() {
  state.contextMenu = null;
  contextMenu.hidden = true;
  contextMenu.classList.add("hidden");
  contextMenu.innerHTML = "";
}

function showContextMenu(event, items = []) {
  const visibleItems = items.filter((item) => !item.hidden);
  if (!visibleItems.length) {
    hideContextMenu();
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  contextMenu.innerHTML = "";
  visibleItems.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `context-menu-item${item.danger ? " danger" : ""}`;
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    if (!item.disabled) {
      button.addEventListener("click", async () => {
        hideContextMenu();
        await item.onSelect();
      });
    }
    contextMenu.appendChild(button);
  });

  contextMenu.hidden = false;
  contextMenu.classList.remove("hidden");
  contextMenu.style.left = "0px";
  contextMenu.style.top = "0px";

  const menuWidth = contextMenu.offsetWidth;
  const menuHeight = contextMenu.offsetHeight;
  const maxLeft = window.innerWidth - menuWidth - 8;
  const maxTop = window.innerHeight - menuHeight - 8;
  const left = Math.max(8, Math.min(event.clientX, maxLeft));
  const top = Math.max(8, Math.min(event.clientY, maxTop));
  contextMenu.style.left = `${left}px`;
  contextMenu.style.top = `${top}px`;
  state.contextMenu = { left, top };
}

function updateDraftPreview() {
  if (!draftPreview || !draftEditorInput) return;
  const html = renderMarkdown(draftEditorInput.value);
  if (!html) {
    draftPreview.innerHTML = "Markdown 预览会显示在这里。";
    draftPreview.classList.add("empty");
    return;
  }
  draftPreview.innerHTML = html;
  draftPreview.classList.remove("empty");
}

function openDraftModal(detail) {
  if (!draftModal || !draftEditorInput || !draftModalMeta) return;
  state.openDraft = {
    fileName: detail.fileName,
    content: detail.content || "",
  };
  draftEditorInput.value = detail.content || "";
  draftModalMeta.textContent = `${detail.fileName} · Markdown 草稿`;
  updateDraftPreview();
  draftModal.hidden = false;
  draftModal.classList.remove("hidden");
  draftEditorInput.focus();
}

function closeDraftModal() {
  state.openDraft = null;
  if (!draftModal) return;
  draftModal.hidden = true;
  draftModal.classList.add("hidden");
}

function canDeleteWorkspace(workspaceName) {
  return !isDevPage && workspaceName !== DEV_WORKSPACE && workspaceName !== "test";
}

async function deleteWorkspaceByName(workspaceName) {
  const confirmed = window.confirm(`确认删除 Workspace「${workspaceName}」吗？`);
  if (!confirmed) return;

  await fetchJson(`/api/workspaces/${encodeURIComponent(workspaceName)}`, {
    method: "DELETE",
  });

  const nextWorkspace = state.currentWorkspace === workspaceName ? "" : state.currentWorkspace;
  await refreshWorkspaceList(nextWorkspace);
  showToast(`🗑️ 已删除 Workspace「${workspaceName}」。`);
}

async function deleteCardItem(bucket, fileName) {
  const confirmed = window.confirm(`确认删除 ${bucket} / ${fileName} 吗？`);
  if (!confirmed || !state.currentWorkspace) return;

  await fetchJson(
    `/api/workspaces/${encodeURIComponent(state.currentWorkspace)}/item?bucket=${encodeURIComponent(bucket)}&file=${encodeURIComponent(fileName)}`,
    { method: "DELETE" }
  );

  if (
    state.selectedItem &&
    state.selectedItem.bucket === bucket &&
    state.selectedItem.fileName === fileName
  ) {
    state.selectedItem = null;
    renderDetail(null);
  }

  if (state.openDraft?.fileName === fileName) {
    closeDraftModal();
  }

  await loadWorkspace(state.currentWorkspace);
  showToast(`🗑️ 已删除 ${fileName}。`);
}

async function createDraft() {
  if (!state.currentWorkspace) {
    showToast("请先选择 Workspace。", "error");
    return;
  }
  try {
    const result = await fetchJson(
      `/api/workspaces/${encodeURIComponent(state.currentWorkspace)}/drafts`,
      { method: "POST", body: JSON.stringify({ content: "" }) }
    );
    await loadWorkspace(state.currentWorkspace);
    await openDraftEditor(result.fileName);
    showToast(`📝 已创建草稿 ${result.fileName}`);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function saveDraft() {
  if (!state.currentWorkspace || !state.openDraft || !draftEditorInput) return;
  try {
    const result = await fetchJson(
      `/api/workspaces/${encodeURIComponent(state.currentWorkspace)}/item?bucket=drafts&file=${encodeURIComponent(state.openDraft.fileName)}`,
      { method: "PUT", body: JSON.stringify({ content: draftEditorInput.value }) }
    );
    state.openDraft.content = result.content;
    await loadWorkspace(state.currentWorkspace);
    showToast(`💾 已保存草稿 ${state.openDraft.fileName}`);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function promoteDraftToSessions(fileName = state.draggedDraft || state.openDraft?.fileName) {
  if (!state.currentWorkspace || !fileName) return;
  try {
    const result = await fetchJson(
      `/api/workspaces/${encodeURIComponent(state.currentWorkspace)}/drafts/${encodeURIComponent(fileName)}/promote`,
      { method: "POST" }
    );
    if (state.openDraft?.fileName === fileName) {
      closeDraftModal();
    }
    if (state.selectedItem?.bucket === "drafts" && state.selectedItem.fileName === fileName) {
      state.selectedItem = { bucket: "sessions", fileName: result.targetFileName };
    }
    await loadWorkspace(state.currentWorkspace);
    showToast(`🚀 已将草稿投递到待处理：${result.targetFileName}`);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    state.draggedDraft = null;
    bucketContainers.sessions?.classList.remove("drop-target");
  }
}

let toastTimer;
function showToast(message, type = "info") {
  toast.textContent = message;
  toast.className   = `toast toast-${type}`;
  toast.hidden      = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
}

// ─── Workspace List ───────────────────────────────────────────────────────────
function renderWorkspaces() {
  workspaceList.innerHTML = "";
  if (!state.workspaces.length) {
    workspaceList.innerHTML = `<div class="ws-empty">暂无 Workspace，请创建一个。</div>`;
    return;
  }
  const visibleWorkspaces = isDevPage
    ? state.workspaces.filter((ws) => ws.name === DEV_WORKSPACE)
    : state.workspaces;
  if (!visibleWorkspaces.length) {
    workspaceList.innerHTML = `<div class="ws-empty">未找到 Workspace「${esc(DEV_WORKSPACE)}」。</div>`;
    return;
  }
  visibleWorkspaces.forEach((ws) => {
    const btn = document.createElement("button");
    btn.type      = "button";
    btn.className = `ws-btn${ws.name === state.currentWorkspace ? " active" : ""}`;
    btn.innerHTML = `
      <span class="ws-name">${esc(ws.name)}</span>
      <span class="ws-meta">
        <span class="dot dot-draft"></span>${ws.counts.drafts || 0}
        <span class="dot dot-pending"></span>${ws.counts.sessions}
        <span class="dot dot-active"></span>${ws.counts.inprocess}
        <span class="dot dot-done"></span>${ws.counts.processed}
      </span>`;
    if (!isDevPage) {
      btn.addEventListener("click", () => loadWorkspace(ws.name));
    } else {
      btn.disabled = true;
    }
    btn.addEventListener("contextmenu", (event) => {
      showContextMenu(event, [
        {
          label: "复制名称",
          onSelect: async () => {
            await copyText(ws.name);
            showToast(`📋 已复制 Workspace 名称：${ws.name}`);
          },
        },
        {
          label: "删除 Workspace",
          danger: true,
          disabled: !canDeleteWorkspace(ws.name),
          onSelect: async () => {
            await deleteWorkspaceByName(ws.name);
          },
        },
      ]);
    });
    workspaceList.appendChild(btn);
  });
}

// ─── Top Menu ────────────────────────────────────────────────────────────────
function renderTopMenu() {
  const ws = state.currentWorkspace || "未选择";
  currentWorkspaceName.textContent = ws;

  const summary  = state.currentSummary;
  const presets  = summary?.settings?.presets || [];
  const current  = summary?.settings?.model   || "";

  modelInput.innerHTML = `<option value="">使用默认</option>`;
  presets.forEach((p) => {
    const opt = document.createElement("option");
    opt.value       = p;
    opt.textContent = p;
    if (p === current) opt.selected = true;
    modelInput.appendChild(opt);
  });
  if (current && !presets.includes(current)) {
    modelInput.value = current;
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────────
function renderStats() {
  const summary = state.currentSummary;
  if (!summary) {
    Object.values(statEls).forEach((el) => { if (el) el.textContent = "0"; });
    return;
  }
  const b = summary.buckets || {};
  const drafts = b.drafts || [];
  const sessions = b.sessions || [];
  const inprocess = b.inprocess || [];
  const processed = b.processed || [];
  if (statEls.drafts) statEls.drafts.textContent = drafts.length;
  if (statEls.sessions) statEls.sessions.textContent = sessions.length;
  if (statEls.inprocess) statEls.inprocess.textContent = inprocess.length;
  if (statEls.processed) statEls.processed.textContent = processed.length;
  if (statEls.docs) statEls.docs.textContent = (summary.docs || []).length;
}

// ─── Cards ───────────────────────────────────────────────────────────────────
function buildCard(item, bucket) {
  const isSelected =
    state.selectedItem &&
    state.selectedItem.bucket   === bucket &&
    state.selectedItem.fileName === item.fileName;

  const card = document.createElement("div");
  card.className = `card${isSelected ? " selected" : ""}${bucket === "drafts" ? " card-draft" : ""}`;
  if (bucket === "drafts") {
    card.draggable = true;
  }

  const timeStr = formatTime(item.updatedAt);
  const title = bucket === "drafts"
    ? extractDraftTitle(item.preview === "(empty document)" ? "" : item.preview, item.fileName)
    : item.fileName;

  let docBtn = "";
  if (bucket === "processed" && item.hasLinkedDoc) {
    docBtn = `<button type="button" class="btn-doc" data-doc="${esc(item.linkedDocName)}" data-bucket="doc">📄 查看文档</button>`;
  }

  card.innerHTML = `
    <div class="card-body">
      <div class="card-title">${esc(title)}</div>
      <div class="card-preview">${esc(item.preview)}</div>
      <div class="card-footer">
        <span class="card-time">${esc(timeStr)}</span>
        ${docBtn}
      </div>
    </div>`;

  card.addEventListener("click", (e) => {
    if (e.target.closest(".btn-doc")) return;
    if (bucket === "drafts") {
      openDraftEditor(item.fileName);
      return;
    }
    loadItem(bucket, item.fileName);
  });

  card.addEventListener("contextmenu", (event) => {
    showContextMenu(event, [
      {
        label: "复制名称",
        onSelect: async () => {
          await copyText(item.fileName);
          showToast(`📋 已复制卡片名称：${item.fileName}`);
        },
      },
      {
        label: bucket === "drafts" ? "删除草稿" : "删除卡片",
        danger: true,
        onSelect: async () => {
          await deleteCardItem(bucket, item.fileName);
        },
      },
    ]);
  });

  if (bucket === "drafts") {
    card.addEventListener("dragstart", (event) => {
      state.draggedDraft = item.fileName;
      card.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.fileName);
    });
    card.addEventListener("dragend", () => {
      state.draggedDraft = null;
      card.classList.remove("dragging");
      bucketContainers.sessions?.classList.remove("drop-target");
    });
  }

  const docButton = card.querySelector(".btn-doc");
  if (docButton) {
    docButton.addEventListener("click", (e) => {
      e.stopPropagation();
      loadItem("doc", item.linkedDocName, true);
    });
  }

  return card;
}

function renderBuckets() {
  const summary = state.currentSummary;
  Object.entries(bucketContainers).forEach(([bucket, container]) => {
    const items = summary?.buckets?.[bucket] || [];
    if (countEls[bucket]) {
      countEls[bucket].textContent = items.length;
    }
    if (!container) return;
    container.innerHTML = "";
    if (!items.length) {
      container.innerHTML = `<div class="card-empty">${bucket === "drafts" ? "暂无草稿，点击右上角“新建草稿”开始。" : "暂无文档"}</div>`;
      return;
    }
    items.forEach((item) => container.appendChild(buildCard(item, bucket)));
  });
}

// ─── Detail Panel ────────────────────────────────────────────────────────────
function renderDetail(detail) {
  if (!detail) {
    detailTitle.textContent = "📄 文档详情";
    detailPanel.innerHTML   = `<p class="muted">点击卡片或搜索结果查看文档内容。</p>`;
    return;
  }

  detailTitle.textContent = `📄 ${detail.bucket} / ${detail.fileName}`;

  if (detail.bucket === "doc") {
    detailPanel.innerHTML = `
      <div class="detail-block">
        <div class="detail-filename">${esc(detail.fileName)}</div>
        <pre class="detail-content">${esc(detail.content)}</pre>
      </div>`;
    return;
  }

  const docBlock = detail.linkedDocName
    ? `<div class="detail-block detail-doc">
        <div class="detail-filename">🔗 关联文档: ${esc(detail.linkedDocName)}</div>
        <pre class="detail-content">${esc(detail.linkedDocContent || "(文档未找到)")}</pre>
       </div>`
    : "";

  detailPanel.innerHTML = `
    <div class="detail-block">
      <div class="detail-filename">${esc(detail.bucket)} / ${esc(detail.fileName)}</div>
      <pre class="detail-content">${esc(detail.content)}</pre>
    </div>
    ${docBlock}`;
}

// ─── Load Data ────────────────────────────────────────────────────────────────
async function loadItem(bucket, fileName, isDoc = false) {
  if (!state.currentWorkspace) return;

  if (bucket === "drafts") {
    await openDraftEditor(fileName);
    return;
  }

  if (!isDoc) {
    state.selectedItem = { bucket, fileName };
  }

  try {
    const detail = await fetchJson(
      `/api/workspaces/${encodeURIComponent(state.currentWorkspace)}/item?bucket=${encodeURIComponent(bucket)}&file=${encodeURIComponent(fileName)}`
    );
    renderDetail(detail);
    renderBuckets();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function openDraftEditor(fileName) {
  if (!state.currentWorkspace) return;
  state.selectedItem = { bucket: "drafts", fileName };
  renderBuckets();
  try {
    const detail = await fetchJson(
      `/api/workspaces/${encodeURIComponent(state.currentWorkspace)}/item?bucket=drafts&file=${encodeURIComponent(fileName)}`
    );
    openDraftModal(detail);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function loadWorkspace(name) {
  const targetWorkspace = isDevPage ? DEV_WORKSPACE : name;
  state.currentWorkspace = targetWorkspace;
  renderWorkspaces();
  renderTopMenu();

  try {
    const summary = await fetchJson(`/api/workspaces/${encodeURIComponent(targetWorkspace)}`);
    state.currentSummary = summary;
    renderTopMenu();
    renderStats();
    renderBuckets();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function refreshWorkspaceList(preferredWorkspace = state.currentWorkspace) {
  try {
    const data = await fetchJson("/api/workspaces");
    const allWorkspaces = data.workspaces || [];
    state.workspaces = isDevPage
      ? allWorkspaces.filter((w) => w.name === DEV_WORKSPACE)
      : allWorkspaces;
    renderWorkspaces();

    if (!state.workspaces.length) {
      state.currentWorkspace = "";
      state.currentSummary   = null;
      renderTopMenu();
      renderStats();
      renderBuckets();
      renderDetail(null);
      return;
    }

    const target = isDevPage
      ? DEV_WORKSPACE
      : state.workspaces.some((w) => w.name === preferredWorkspace)
        ? preferredWorkspace
        : state.workspaces[0].name;

    if (target !== state.currentWorkspace) {
      await loadWorkspace(target);
    } else if (state.currentWorkspace) {
      await loadWorkspace(state.currentWorkspace);
    }
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────
async function performSearch() {
  const q = searchInput.value.trim();
  if (!q) {
    searchResults.innerHTML = "";
    searchResults.classList.add("hidden");
    return;
  }
  if (!state.currentWorkspace) {
    showToast("请先选择 Workspace。", "error");
    return;
  }

  try {
    const data = await fetchJson(
      `/api/workspaces/${encodeURIComponent(state.currentWorkspace)}/search?q=${encodeURIComponent(q)}`
    );
    const results = data.results || [];
    searchResults.classList.remove("hidden");

    if (!results.length) {
      searchResults.innerHTML = `<div class="search-empty">未找到包含「${esc(q)}」的文档。</div>`;
      return;
    }

    searchResults.innerHTML = results
      .map(
        (r) => `
      <div class="search-item" data-bucket="${esc(r.bucket)}" data-file="${esc(r.fileName)}">
        <span class="search-bucket">${esc(r.bucket)}</span>
        <span class="search-name">${esc(r.fileName)}</span>
        <span class="search-preview">${esc(r.preview)}</span>
      </div>`
      )
      .join("");

    searchResults.querySelectorAll(".search-item").forEach((el) => {
      el.addEventListener("click", () => {
        const bucket   = el.dataset.bucket;
        const fileName = el.dataset.file;
        if (bucket === "drafts") {
          openDraftEditor(fileName);
          return;
        }
        loadItem(bucket, fileName, bucket === "doc");
      });
    });
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ─── Model ───────────────────────────────────────────────────────────────────
async function persistModel() {
  if (!state.currentWorkspace) {
    showToast("请先选择 Workspace。", "error");
    return;
  }
  const model = modelInput.value.trim();
  try {
    const result = await fetchJson(
      `/api/workspaces/${encodeURIComponent(state.currentWorkspace)}/settings`,
      { method: "PUT", body: JSON.stringify({ model }) }
    );
    state.currentSummary = { ...state.currentSummary, settings: result.settings };
    renderTopMenu();
    showToast(model ? `✅ 模型已切换为 ${model}，run.bat 已更新。` : "✅ 已重置为默认模型。");
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────
if (workspaceForm && workspaceInput) {
  workspaceForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isDevPage) {
      showToast(`开发页仅允许使用 Workspace「${DEV_WORKSPACE}」。`, "error");
      return;
    }
    const name = workspaceInput.value.trim();
    if (!name) { showToast("请输入 Workspace 名称。", "error"); return; }
    try {
      await fetchJson("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) });
      workspaceInput.value = "";
      await refreshWorkspaceList(name);
      showToast(`✅ Workspace「${name}」已从 test 复制创建。`);
    } catch (error) {
      showToast(error.message, "error");
    }
  });
}

if (newDraftButton) {
  newDraftButton.addEventListener("click", createDraft);
}

saveModelButton.addEventListener("click", persistModel);
modelInput.addEventListener("change", persistModel);

runAgentButton.addEventListener("click", async () => {
  if (!state.currentWorkspace) { showToast("请先选择 Workspace。", "error"); return; }
  try {
    const model = modelInput.value.trim();
    await fetchJson(
      `/api/workspaces/${encodeURIComponent(state.currentWorkspace)}/run-agent`,
      { method: "POST", body: JSON.stringify({ model }) }
    );
    showToast(`✅ Agent 已在 ${state.currentWorkspace} 中启动${model ? `（模型: ${model}）` : ""}。`);
  } catch (error) {
    showToast(error.message, "error");
  }
});

refreshButton.addEventListener("click", async () => {
  await refreshWorkspaceList(state.currentWorkspace);
  showToast("✅ 已刷新。");
});

searchButton.addEventListener("click", performSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); performSearch(); }
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".context-menu")) {
    hideContextMenu();
  }
});

document.addEventListener("contextmenu", (event) => {
  if (!event.target.closest(".ws-btn") && !event.target.closest(".card")) {
    hideContextMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!draftModal?.hidden) {
      closeDraftModal();
      return;
    }
    hideContextMenu();
  }
});

window.addEventListener("resize", hideContextMenu);
window.addEventListener("scroll", hideContextMenu, true);

if (draftModal) {
  draftModal.addEventListener("click", (event) => {
    if (event.target === draftModal) {
      closeDraftModal();
    }
  });
}

if (draftEditorInput) {
  draftEditorInput.addEventListener("input", updateDraftPreview);
}

if (draftCloseButton) {
  draftCloseButton.addEventListener("click", closeDraftModal);
}

if (draftSaveButton) {
  draftSaveButton.addEventListener("click", saveDraft);
}

if (draftPromoteButton) {
  draftPromoteButton.addEventListener("click", () => promoteDraftToSessions());
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.currentWorkspace) { showToast("请先选择 Workspace。", "error"); return; }
  const content = chatInput.value.trim();
  if (!content) { showToast("内容不能为空。", "error"); return; }
  try {
    const result = await fetchJson(
      `/api/workspaces/${encodeURIComponent(state.currentWorkspace)}/tasks`,
      { method: "POST", body: JSON.stringify({ content }) }
    );
    chatInput.value = "";
    await loadWorkspace(state.currentWorkspace);
    showToast(`✅ 已创建 ${result.fileName}`);
  } catch (error) {
    showToast(error.message, "error");
  }
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event("submit"));
  }
});

if (bucketContainers.sessions) {
  bucketContainers.sessions.addEventListener("dragover", (event) => {
    if (!state.draggedDraft) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    bucketContainers.sessions.classList.add("drop-target");
  });
  bucketContainers.sessions.addEventListener("dragleave", (event) => {
    if (!bucketContainers.sessions.contains(event.relatedTarget)) {
      bucketContainers.sessions.classList.remove("drop-target");
    }
  });
  bucketContainers.sessions.addEventListener("drop", async (event) => {
    event.preventDefault();
    const fileName = event.dataTransfer.getData("text/plain") || state.draggedDraft;
    bucketContainers.sessions.classList.remove("drop-target");
    await promoteDraftToSessions(fileName);
  });
}

// ─── Polling ──────────────────────────────────────────────────────────────────
function startPolling() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (state.currentWorkspace) {
      loadWorkspace(state.currentWorkspace).catch(() => {});
      refreshWorkspaceList(state.currentWorkspace).catch(() => {});
    }
  }, 6000);
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function initialize() {
  try {
    if (isDevPage) {
      state.currentWorkspace = DEV_WORKSPACE;
      if (workspaceInput) {
        workspaceInput.value = DEV_WORKSPACE;
        workspaceInput.disabled = true;
      }
      if (workspaceForm) {
        const workspaceSection = workspaceForm.closest(".panel-section");
        if (workspaceSection) {
          workspaceSection.hidden = true;
        }
        const workspaceButton = workspaceForm.querySelector("button");
        if (workspaceButton) {
          workspaceButton.disabled = true;
        }
      }
      document.title = "alith / dev";
      renderTopMenu();
      await loadWorkspace(DEV_WORKSPACE);
    }
    await refreshWorkspaceList(isDevPage ? DEV_WORKSPACE : state.currentWorkspace);
    startPolling();
  } catch (error) {
    showToast(error.message, "error");
  }
}

initialize();
