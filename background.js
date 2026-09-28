// Tably Tab Saver — background service worker
//
// Storage layout (chrome.storage.local):
//   sessions: {
//     [name]: {
//       savedAt: <ms timestamp>,
//       windows: [
//         { tabs:   [{ url, title, pinned, groupId }],
//           groups: [{ id, title, color, collapsed }] }
//       ]
//     }
//   }
// Sessions saved by v1 ({ tabData, groupData }) are read transparently.

const NO_GROUP = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

// ---------- storage helpers ----------

async function getSessions() {
  const { sessions } = await chrome.storage.local.get("sessions");
  return sessions || {};
}

async function setSessions(sessions) {
  await chrome.storage.local.set({ sessions });
}

// Convert a v1 session to the current shape.
function normalize(session) {
  if (!session) return null;
  if (Array.isArray(session.windows)) return session;
  if (Array.isArray(session.tabData)) {
    return {
      savedAt: session.savedAt || 0,
      windows: [{ tabs: session.tabData, groups: session.groupData || [] }]
    };
  }
  return null;
}

// ---------- save ----------

async function snapshotWindow(windowId) {
  const ownPrefix = chrome.runtime.getURL("");
  const tabs = (await chrome.tabs.query({ windowId }))
    .filter(t => !(t.url || t.pendingUrl || "").startsWith(ownPrefix));
  const groups = await chrome.tabGroups.query({ windowId });
  return {
    tabs: tabs.map(t => ({
      url: t.url || t.pendingUrl || "",
      title: t.title || t.url || "",
      pinned: !!t.pinned,
      groupId: t.groupId ?? NO_GROUP
    })),
    groups: groups.map(g => ({
      id: g.id,
      title: g.title || "",
      color: g.color,
      collapsed: !!g.collapsed
    }))
  };
}

async function saveSession({ name, scope, windowId }) {
  name = (name || "").trim();
  if (!name) throw new Error("Session name is required.");

  let windowIds;
  if (scope === "all") {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    windowIds = wins.map(w => w.id);
  } else {
    windowIds = [windowId ?? (await chrome.windows.getLastFocused()).id];
  }

  const windows = [];
  for (const id of windowIds) {
    const snap = await snapshotWindow(id);
    if (snap.tabs.length) windows.push(snap);
  }
  if (!windows.length) throw new Error("No tabs to save.");

  const sessions = await getSessions();
  sessions[name] = { savedAt: Date.now(), windows };
  await setSessions(sessions);

  const tabCount = windows.reduce((n, w) => n + w.tabs.length, 0);
  return { name, tabCount, windowCount: windows.length };
}

// ---------- restore ----------

function isRestorable(url) {
  return !!url && !/^(javascript|data|blob):/i.test(url);
}

async function restoreWindow(win) {
  // Start with a blank window, add tabs, then close the placeholder tab.
  const newWin = await chrome.windows.create({ focused: true });
  const placeholderId = newWin.tabs?.[0]?.id;

  const created = []; // { id, oldGroupId }
  let skipped = 0;

  for (const tab of win.tabs) {
    if (!isRestorable(tab.url)) { skipped++; continue; }
    try {
      const t = await chrome.tabs.create({
        windowId: newWin.id,
        url: tab.url,
        pinned: !!tab.pinned,
        active: false
      });
      created.push({ id: t.id, oldGroupId: tab.groupId ?? NO_GROUP, pinned: !!tab.pinned });
    } catch (e) {
      console.warn("Tably: could not open", tab.url, e);
      skipped++;
    }
  }

  // Recreate groups (pinned tabs can't be grouped).
  for (const group of win.groups || []) {
    const tabIds = created
      .filter(c => c.oldGroupId === group.id && !c.pinned)
      .map(c => c.id);
    if (!tabIds.length) continue;
    try {
      const gid = await chrome.tabs.group({ tabIds, createProperties: { windowId: newWin.id } });
      const props = { title: group.title || "", collapsed: !!group.collapsed };
      if (group.color) props.color = group.color;
      await chrome.tabGroups.update(gid, props);
    } catch (e) {
      console.warn("Tably: could not recreate group", group.title, e);
    }
  }

  if (created.length) {
    await chrome.tabs.update(created[0].id, { active: true });
    if (placeholderId != null) {
      try { await chrome.tabs.remove(placeholderId); } catch (_) {}
    }
  }

  return { restored: created.length, skipped };
}

async function restoreSession({ name }) {
  const session = normalize((await getSessions())[name]);
  if (!session) throw new Error(`Session "${name}" not found or unreadable.`);

  let restored = 0, skipped = 0;
  for (const win of session.windows) {
    const r = await restoreWindow(win);
    restored += r.restored;
    skipped += r.skipped;
  }
  return { restored, skipped, windowCount: session.windows.length };
}

// ---------- delete / rename / import ----------

async function deleteSession({ name }) {
  const sessions = await getSessions();
  delete sessions[name];
  await setSessions(sessions);
  return {};
}

async function renameSession({ oldName, newName }) {
  newName = (newName || "").trim();
  if (!newName) throw new Error("New name is required.");
  const sessions = await getSessions();
  if (!sessions[oldName]) throw new Error(`Session "${oldName}" not found.`);
  if (sessions[newName] && newName !== oldName) throw new Error(`"${newName}" already exists.`);
  sessions[newName] = sessions[oldName];
  if (newName !== oldName) delete sessions[oldName];
  await setSessions(sessions);
  return {};
}

async function importSessions({ data }) {
  const incoming = data?.sessions ?? data;
  if (!incoming || typeof incoming !== "object") throw new Error("Not a Tably export file.");

  const sessions = await getSessions();
  let imported = 0;
  for (const [rawName, s] of Object.entries(incoming)) {
    const session = normalize(s);
    if (!session) continue;
    let name = rawName, i = 2;
    while (sessions[name]) name = `${rawName} (${i++})`;
    sessions[name] = session;
    imported++;
  }
  if (!imported) throw new Error("No valid sessions found in file.");
  await setSessions(sessions);
  return { imported };
}

// ---------- message router ----------

const handlers = {
  saveSession,
  restoreSession,
  deleteSession,
  renameSession,
  importSessions,
  // v1 action names, kept for compatibility
  saveTabs: msg => saveSession({ ...msg, scope: "all" }),
  restoreTabs: restoreSession
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.action];
  if (!handler) return false;
  handler(msg)
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // keep the channel open for the async response
});
