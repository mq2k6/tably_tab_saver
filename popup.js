// Tably Tab Saver — popup UI

const GROUP_COLORS = {
  grey: "#5f6368", blue: "#1a73e8", red: "#d93025", yellow: "#f9ab00",
  green: "#188038", pink: "#d01884", purple: "#a142f4", cyan: "#007b83",
  orange: "#fa903e"
};

const $ = id => document.getElementById(id);
const isFullPage = new URLSearchParams(location.search).has("full");
const openPreviews = new Set();
let messageTimer;

// ---------- helpers ----------

function send(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, error: "No response from background." });
      }
    });
  });
}

function showMessage(text, type = "info") {
  const box = $("messageBox");
  box.textContent = text;
  box.className = type;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { box.textContent = ""; box.className = ""; }, 5000);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "style") Object.assign(node.style, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function normalize(session) {
  if (Array.isArray(session?.windows)) return session;
  if (Array.isArray(session?.tabData)) {
    return { savedAt: session.savedAt || 0, windows: [{ tabs: session.tabData, groups: session.groupData || [] }] };
  }
  return null;
}

function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", pageUrl);
  u.searchParams.set("size", "16");
  return u.toString();
}

function timeAgo(ms) {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function dot(color) {
  return el("span", { class: "dot", style: { background: GROUP_COLORS[color] || GROUP_COLORS.grey } });
}

// ---------- rendering ----------

async function render() {
  const { sessions = {} } = await chrome.storage.local.get("sessions");
  const filter = $("filter").value.trim().toLowerCase();
  const list = $("sessionList");
  list.replaceChildren();

  const entries = Object.entries(sessions)
    .map(([name, s]) => [name, normalize(s)])
    .filter(([, s]) => s)
    .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));

  const visible = entries.filter(([name, s]) =>
    !filter ||
    name.toLowerCase().includes(filter) ||
    s.windows.some(w => w.tabs.some(t =>
      (t.title || "").toLowerCase().includes(filter) || (t.url || "").toLowerCase().includes(filter)))
  );

  $("empty").hidden = entries.length > 0;
  $("export").disabled = entries.length === 0;
  $("filter").hidden = entries.length < 4;

  for (const [name, session] of visible) list.append(renderSession(name, session));

  if (entries.length && !visible.length) {
    list.append(el("li", { class: "muted" }, "No sessions match."));
  }
}

function renderSession(name, session) {
  const tabCount = session.windows.reduce((n, w) => n + w.tabs.length, 0);
  const groups = session.windows.flatMap(w => w.groups || []);

  const meta = el("div", { class: "session-meta" },
    `${tabCount} tab${tabCount === 1 ? "" : "s"}`,
    groups.length ? ` · ${groups.length} group${groups.length === 1 ? "" : "s"}` : "",
    session.windows.length > 1 ? ` · ${session.windows.length} windows` : "",
    session.savedAt ? ` · ${timeAgo(session.savedAt)}` : ""
  );
  if (groups.length) {
    meta.append(el("span", { class: "dots" }, ...groups.slice(0, 8).map(g => dot(g.color))));
  }

  const nameBtn = el("button", {
    class: "session-name", textContent: name, title: "Show tabs",
    onclick: () => togglePreview(name)
  });

  const info = el("div", { class: "session-info" }, nameBtn, meta);

  const restoreBtn = el("button", {
    class: "primary", textContent: "Restore",
    onclick: async () => {
      restoreBtn.disabled = true;
      const res = await send({ action: "restoreSession", name });
      // The popup usually closes when the new window takes focus; this is for when it doesn't.
      restoreBtn.disabled = false;
      if (!res.ok) return showMessage(res.error, "error");
      showMessage(`Restored ${res.restored} tab${res.restored === 1 ? "" : "s"}` +
        (res.skipped ? ` (${res.skipped} skipped)` : "") + ".");
    }
  });

  const deleteBtn = el("button", { class: "danger", textContent: "Delete" });
  let armTimer;
  deleteBtn.onclick = async () => {
    if (!deleteBtn.classList.contains("armed")) {
      deleteBtn.classList.add("armed");
      deleteBtn.textContent = "Confirm";
      armTimer = setTimeout(() => {
        deleteBtn.classList.remove("armed");
        deleteBtn.textContent = "Delete";
      }, 3000);
      return;
    }
    clearTimeout(armTimer);
    const res = await send({ action: "deleteSession", name });
    if (!res.ok) return showMessage(res.error, "error");
    openPreviews.delete(name);
    showMessage(`Deleted "${name}".`);
    render();
  };

  const renameBtn = el("button", { textContent: "Rename", onclick: () => startRename(li, info, name) });
  const previewBtn = el("button", {
    textContent: openPreviews.has(name) ? "Hide" : "Tabs",
    onclick: () => togglePreview(name)
  });

  const li = el("li", { class: "session" },
    el("div", { class: "session-head" }, info),
    el("div", { class: "actions" }, restoreBtn, previewBtn, renameBtn, deleteBtn)
  );

  if (openPreviews.has(name)) li.append(renderPreview(session));
  return li;
}

function renderPreview(session) {
  const ul = el("ul", { class: "preview" });
  const multiWindow = session.windows.length > 1;

  session.windows.forEach((win, i) => {
    if (multiWindow) ul.append(el("li", { class: "win" }, `Window ${i + 1}`));
    const groupsById = new Map((win.groups || []).map(g => [g.id, g]));
    let lastGroup = null;

    for (const tab of win.tabs) {
      const gid = tab.groupId ?? -1;
      const group = groupsById.get(gid);
      if (group && gid !== lastGroup) {
        ul.append(el("li", { class: "grp" }, dot(group.color), group.title || "Untitled group"));
      }
      lastGroup = group ? gid : null;

      const link = el("a", {
        href: tab.url, textContent: (tab.pinned ? "📌 " : "") + (tab.title || tab.url),
        title: tab.url,
        onclick: e => { e.preventDefault(); chrome.tabs.create({ url: tab.url }); }
      });
      ul.append(el("li", { class: "tab" + (group ? " in-group" : "") },
        el("img", { src: faviconUrl(tab.url), alt: "" }), link));
    }
  });
  return ul;
}

function togglePreview(name) {
  openPreviews.has(name) ? openPreviews.delete(name) : openPreviews.add(name);
  render();
}

function startRename(li, info, oldName) {
  const input = el("input", { type: "text", value: oldName, maxLength: 80 });
  const finish = async commit => {
    const newName = input.value.trim();
    if (!commit || !newName || newName === oldName) return render();
    const res = await send({ action: "renameSession", oldName, newName });
    if (!res.ok) { showMessage(res.error, "error"); return render(); }
    if (openPreviews.delete(oldName)) openPreviews.add(newName);
    render();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  const box = el("div", { class: "rename" }, input,
    el("button", { class: "primary", textContent: "OK", onclick: () => finish(true) }));
  info.replaceWith(el("div", { class: "session-info" }, box));
  input.focus();
  input.select();
}

// ---------- save ----------

async function save() {
  const input = $("sessionName");
  const name = input.value.trim();
  if (!name) { input.focus(); return showMessage("Enter a name for this session.", "error"); }

  const { sessions = {} } = await chrome.storage.local.get("sessions");
  const saveBtn = $("save");
  if (sessions[name] && saveBtn.dataset.confirm !== name) {
    saveBtn.dataset.confirm = name;
    saveBtn.textContent = "Overwrite?";
    showMessage(`"${name}" already exists. Click again to overwrite.`, "error");
    return;
  }
  delete saveBtn.dataset.confirm;
  saveBtn.textContent = "Save";

  const scope = document.querySelector('input[name="scope"]:checked').value;
  const current = await chrome.windows.getCurrent();
  const res = await send({ action: "saveSession", name, scope, windowId: current.id });
  if (!res.ok) return showMessage(res.error, "error");

  input.value = "";
  showMessage(`Saved ${res.tabCount} tab${res.tabCount === 1 ? "" : "s"}` +
    (res.windowCount > 1 ? ` from ${res.windowCount} windows` : "") + ` as "${res.name}".`);
  render();
}

// ---------- export / import ----------

async function exportSessions() {
  const { sessions = {} } = await chrome.storage.local.get("sessions");
  const blob = new Blob(
    [JSON.stringify({ app: "tably", version: 2, exportedAt: new Date().toISOString(), sessions }, null, 2)],
    { type: "application/json" }
  );
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  el("a", { href: url, download: `tably-sessions-${stamp}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function startImport() {
  // File pickers close the popup on some systems, so import runs in a full tab.
  if (!isFullPage) {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?full&import") });
    window.close();
    return;
  }
  $("importFile").click();
}

async function handleImportFile(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return showMessage("That file isn't valid JSON.", "error");
  }
  const res = await send({ action: "importSessions", data });
  if (!res.ok) return showMessage(res.error, "error");
  showMessage(`Imported ${res.imported} session${res.imported === 1 ? "" : "s"}.`);
  render();
}

// ---------- init ----------

document.addEventListener("DOMContentLoaded", () => {
  if (isFullPage) document.body.classList.add("full");

  $("save").addEventListener("click", save);
  $("sessionName").addEventListener("keydown", e => { if (e.key === "Enter") save(); });
  $("sessionName").addEventListener("input", () => {
    const btn = $("save");
    if (btn.dataset.confirm) { delete btn.dataset.confirm; btn.textContent = "Save"; }
  });
  $("filter").addEventListener("input", render);
  $("export").addEventListener("click", exportSessions);
  $("import").addEventListener("click", startImport);
  $("importFile").addEventListener("change", handleImportFile);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.sessions) render();
  });

  render();
  $("sessionName").focus();

  if (isFullPage && new URLSearchParams(location.search).has("import")) {
    showMessage("Click Import below and pick a Tably export file (.json).");
  }
});
