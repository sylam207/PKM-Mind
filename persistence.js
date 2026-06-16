/**
 * persistence.js — Save, load, undo, and autosave.
 *
 * Responsible for:
 *  - Undo/redo history (in-memory snapshots).
 *  - localStorage autosave so work survives accidental tab closes.
 *  - Serialising the live node tree to/from a portable JSON format.
 *  - Loading from and saving to GitHub Gists via a thin server-side API proxy.
 */

import {
  createNode,
  hideLoading,
  setUnsavedChanges,
  showLoading,
  showStatus,
  updateDeleteButton,
  updateUndoButton
} from "./state.js";
import { autoLayout, centerMindmap } from "./layout.js";
import { requestDraw } from "./rendering.js";
import { cloneJson, mergeHiddenBranchesById, normalizeJsonWithStableIds } from "./tree-utils.js";

// Schema version written into every autosave document. Bump this value
// (and update the read guard below) whenever the autosave format changes.
const AUTOSAVE_SCHEMA_VERSION = 1;
// Key used to read/write the autosave document in localStorage.
const AUTOSAVE_STORAGE_KEY = "mindmap.autosave.v1";

/**
 * Returns true when localStorage is available in the current browsing context.
 * Wrapped in a try/catch because access throws in some private-browsing modes
 * or when the storage quota is exhausted.
 *
 * @returns {boolean}
 */
function canUseLocalStorage() {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

/**
 * Builds the autosave document object that is written to localStorage.
 * Stores the current Gist id alongside the mindmap JSON so that the
 * connection can be restored after a browser reload.
 *
 * @param {Object} state - App state.
 * @returns {{ version: number, savedAt: number, gistId: string|null, mindmap: Object }}
 */
function buildAutosaveDocument(state) {
  return {
    version: AUTOSAVE_SCHEMA_VERSION,
    savedAt: Date.now(),
    gistId: state.currentGistId || null,
    mindmap: mindmapToJson(state)
  };
}

/**
 * Serialises the current mindmap to JSON and writes it to localStorage.
 * Silently swallows storage errors (quota exceeded, SecurityError) so the
 * UI is never blocked by persistence failures.
 *
 * @param {Object} state - App state.
 */
function writeAutosave(state) {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    const doc = buildAutosaveDocument(state);
    window.localStorage.setItem(AUTOSAVE_STORAGE_KEY, JSON.stringify(doc));
  } catch {
    // Ignore storage quota/security failures to keep UI responsive.
  }
}

/**
 * Reads and validates the autosave document from localStorage.
 * Returns null if localStorage is unavailable, the key is missing, the JSON
 * is malformed, or the schema version does not match.
 *
 * @returns {{ version: number, savedAt: number, gistId: string|null, mindmap: Object }|null}
 */
function readAutosaveDocument() {
  if (!canUseLocalStorage()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(AUTOSAVE_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== AUTOSAVE_SCHEMA_VERSION || !parsed.mindmap) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Pushes a snapshot of the current state onto the undo history stack and
 * triggers an autosave. The snapshot captures node data, links, viewport
 * transform, layout mode, theme, and selection.
 *
 * The stack is capped at `maxHistorySteps` entries; the oldest entry is
 * dropped when the cap is exceeded.
 *
 * @param {Object} state - App state.
 */
export function saveToHistory(state) {
  const snapshotNodes = state.nodes.map((node) => ({
    id: node.id,
    text: node.text,
    numbering: node.numbering,
    x: node.x,
    y: node.y,
    height: node.height,
    width: node.width,
    parentId: node.parent ? node.parent.id : null,
    childIds: node.children.map((child) => child.id),
    collapsed: !!node.collapsed,
    pinned: !!node.pinned
  }));

  const snapshotLinks = state.links.map((link) => ({
    fromId: link.from.id,
    toId: link.to.id
  }));

  state.history.push({
    nodes: snapshotNodes,
    links: snapshotLinks,
    selectedNodeId: state.selectedNode ? state.selectedNode.id : null,
    focusNodeId: state.focusNodeId,
    layoutMode: state.layoutMode,
    branchTheme: state.branchTheme,
    viewOffsetX: state.viewOffsetX,
    viewOffsetY: state.viewOffsetY,
    viewScale: state.viewScale,
    nextNodeId: state.nextNodeId
  });

  if (state.history.length > state.maxHistorySteps) {
    state.history = state.history.slice(1);
  }

  updateUndoButton(state);
  setUnsavedChanges(state, true);
  writeAutosave(state);
}

/**
 * Restores the mindmap from a history snapshot.
 * Rebuilds live node objects from the serialised data, relinks parent/child
 * references, and updates viewport and theme settings.
 * Triggers a redraw but does NOT push a new history entry.
 *
 * @param {Object} state    - App state.
 * @param {Object} snapshot - A history snapshot (as produced by `saveToHistory`).
 */
export function restoreFromHistory(state, snapshot) {
  const idToNode = new Map();

  for (const nodeSnapshot of snapshot.nodes) {
    const node = createNode(state, nodeSnapshot.text, nodeSnapshot.id);
    node.numbering = nodeSnapshot.numbering;
    node.x = nodeSnapshot.x;
    node.y = nodeSnapshot.y;
    node.height = nodeSnapshot.height;
    node.width = nodeSnapshot.width;
    node.parent = null;
    node.children = [];
    node.collapsed = !!nodeSnapshot.collapsed;
    node.pinned = !!nodeSnapshot.pinned;
    idToNode.set(node.id, node);
  }

  for (const nodeSnapshot of snapshot.nodes) {
    const node = idToNode.get(nodeSnapshot.id);
    if (nodeSnapshot.parentId !== null) {
      node.parent = idToNode.get(nodeSnapshot.parentId) || null;
    }
    node.children = (nodeSnapshot.childIds || []).map((childId) => idToNode.get(childId)).filter(Boolean);
  }

  state.nodes = snapshot.nodes.map((nodeSnapshot) => idToNode.get(nodeSnapshot.id));
  state.links = snapshot.links
    .map((linkSnapshot) => ({
      from: idToNode.get(linkSnapshot.fromId),
      to: idToNode.get(linkSnapshot.toId)
    }))
    .filter((link) => link.from && link.to);

  state.selectedNode = snapshot.selectedNodeId !== null ? idToNode.get(snapshot.selectedNodeId) || null : null;
  state.focusNodeId = snapshot.focusNodeId ?? null;
  state.layoutMode = snapshot.layoutMode || "horizontal";
  state.branchTheme = snapshot.branchTheme || "Calm";
  state.viewOffsetX = snapshot.viewOffsetX;
  state.viewOffsetY = snapshot.viewOffsetY;
  state.viewScale = snapshot.viewScale;
  state.nextNodeId = Math.max(state.nextNodeId, snapshot.nextNodeId || 1);

  requestDraw(state);
}

/**
 * Reverts the mindmap to the previous history snapshot.
 * Pops the top of the stack and restores from the entry below it.
 * Does nothing when there is only one history entry.
 *
 * @param {Object} state - App state.
 */
export function undo(state) {
  if (state.history.length <= 1) {
    return;
  }

  state.history.pop();
  const previousSnapshot = state.history[state.history.length - 1];
  restoreFromHistory(state, previousSnapshot);
  updateUndoButton(state);
  updateDeleteButton(state);
  setUnsavedChanges(state, true);
}

/**
 * Serialises the live node tree to a portable JSON object.
 *
 * Only nodes currently rendered (not hidden) are included in the output.
 * If the original loaded JSON contained hidden branches, those are re-merged
 * back via `mergeHiddenBranchesById` so they are preserved on save.
 *
 * @param {Object} state - App state.
 * @returns {Object} A JSON-serialisable mindmap document.
 */
export function mindmapToJson(state) {
  const root = state.nodes.find((n) => !n.parent);
  if (!root) {
    return { nodes: [] };
  }

  function buildNodeTree(node) {
    return {
      id: node.id,
      text: node.text,
      collapsed: !!node.collapsed,
      pinned: !!node.pinned,
      children: node.children.map((child) => buildNodeTree(child))
    };
  }

  const visibleData = {
    nodes: [buildNodeTree(root)],
    layoutMode: state.layoutMode,
    branchTheme: state.branchTheme,
    viewScale: state.viewScale,
    viewOffsetX: state.viewOffsetX,
    viewOffsetY: state.viewOffsetY
  };

  if (state.originalJsonData && state.originalJsonData.nodes) {
    return mergeHiddenBranchesById(visibleData, state.originalJsonData);
  }

  return visibleData;
}

/**
 * Loads a mindmap from a JSON document and replaces the current live state.
 *
 * Steps:
 *  1. Normalise node ids using `normalizeJsonWithStableIds`.
 *  2. Store a deep clone of the normalised JSON as `originalJsonData` so
 *     hidden branches can be re-merged on the next save.
 *  3. Recursively create live node objects, skipping nodes marked `hidden`.
 *  4. Restore viewport, layout, and theme settings when present.
 *  5. Run auto-layout, centre the view, and save an initial history entry.
 *
 * @param {Object} state    - App state.
 * @param {Object} jsonData - A raw mindmap JSON document (possibly un-normalised).
 */
export function jsonToMindmap(state, jsonData) {
  state.nextNodeId = 1;
  const { normalized, nextId } = normalizeJsonWithStableIds(jsonData, state.nextNodeId);
  state.nextNodeId = nextId;
  state.originalJsonData = cloneJson(normalized);
  state.nodes = [];
  state.links = [];

  function createNodesFromJson(nodeData, parent = null) {
    if (nodeData.hidden) {
      return null;
    }

    const node = createNode(state, nodeData.text, nodeData.id);
    node.parent = parent;
    node.collapsed = !!nodeData.collapsed;
    node.pinned = !!nodeData.pinned;
    state.nodes.push(node);

    if (parent) {
      parent.children.push(node);
      state.links.push({ from: parent, to: node });
    }

    const children = Array.isArray(nodeData.children) ? nodeData.children : [];
    children.forEach((childData) => {
      createNodesFromJson(childData, node);
    });

    return node;
  }

  (normalized.nodes || []).forEach((nodeData) => {
    createNodesFromJson(nodeData);
  });

  if (normalized.viewScale) {
    state.viewScale = normalized.viewScale;
  }
  if (normalized.layoutMode) {
    state.layoutMode = normalized.layoutMode;
  }
  if (normalized.branchTheme) {
    state.branchTheme = normalized.branchTheme;
  }
  if (normalized.viewOffsetX) {
    state.viewOffsetX = normalized.viewOffsetX;
  }
  if (normalized.viewOffsetY) {
    state.viewOffsetY = normalized.viewOffsetY;
  }

  autoLayout(state);
  requestDraw(state);
  setUnsavedChanges(state, false);
  saveToHistory(state);
  state.history = [state.history[0]];
  updateUndoButton(state);
  centerMindmap(state, () => requestDraw(state));
}

/**
 * Attempts to restore the mindmap from the localStorage autosave.
 * If a valid autosave document exists it is loaded via `jsonToMindmap`, the
 * Gist id is restored, and the root node is auto-selected.
 *
 * @param {Object} state - App state.
 * @returns {boolean} True when an autosave was found and loaded.
 */
export function recoverFromAutosave(state) {
  const autosaveDoc = readAutosaveDocument();
  if (!autosaveDoc) {
    return false;
  }

  jsonToMindmap(state, autosaveDoc.mindmap);
  state.currentGistId = autosaveDoc.gistId || null;
  // Auto-select root so toolbar actions work immediately after recovery.
  if (!state.selectedNode && state.nodes.length > 0) {
    state.selectedNode = state.nodes.find((n) => !n.parent) || state.nodes[0];
  }
  updateDeleteButton(state);
  setUnsavedChanges(state, true);
  showStatus(state, "Recovered from local autosave");
  return true;
}

/**
 * Fetches a mindmap from a GitHub Gist via the `/api/loadGist` proxy endpoint
 * and loads it into the app. Displays a loading overlay while the request is
 * in flight and shows a status message on success or failure.
 *
 * @param {Object} state   - App state.
 * @param {string} gistId  - The GitHub Gist id to load.
 * @returns {Promise<void>}
 */
export async function loadFromGist(state, gistId) {
  if (!gistId) {
    return;
  }

  state.currentGistId = gistId;
  showLoading(state, "Loading mindmap from GitHub...");

  try {
    const response = await fetch(`/api/loadGist?gistId=${gistId}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      }
    });

    const responseText = await response.text();
    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(`Failed to parse response as JSON. First 100 chars: ${responseText.substring(0, 100)}...`);
    }

    if (!data.files || !data.files["mindmap.json"]) {
      throw new Error("No mindmap.json file found in this Gist");
    }

    const mindmapContent = data.files["mindmap.json"].content;
    const mindmapData = JSON.parse(mindmapContent);
    jsonToMindmap(state, mindmapData);
    showStatus(state, "Mindmap loaded successfully");
  } catch (error) {
    showStatus(state, `Error: ${error.message}`, 5000);
  } finally {
    hideLoading(state);
  }
}

/**
 * Serialises the current mindmap and PATCHes it to the user's GitHub Gist via
 * the `/api/saveGist` proxy endpoint. Clears the unsaved-changes flag on
 * success. Displays a loading overlay during the request and a status message
 * on completion.
 *
 * @param {Object} state - App state.
 * @returns {Promise<void>}
 */
export async function saveToGist(state) {
  if (!state.currentGistId || state.nodes.length === 0) {
    showStatus(state, "Nothing to save or no Gist ID specified");
    return;
  }

  showLoading(state, "Saving mindmap to GitHub...");

  try {
    const mindmapData = mindmapToJson(state);

    const response = await fetch("/api/saveGist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        gistId: state.currentGistId,
        files: {
          "mindmap.json": {
            content: JSON.stringify(mindmapData, null, 2)
          }
        }
      })
    });

    if (!response.ok) {
      let errorMessage = response.statusText;
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        const text = await response.text();
        if (text.includes("<!DOCTYPE html>")) {
          errorMessage = "Received HTML instead of JSON. API endpoint may not exist.";
        } else {
          errorMessage = `${text.substring(0, 100)}...`;
        }
      }
      throw new Error(`Failed to save Gist: ${errorMessage}`);
    }

    await response.json();
    setUnsavedChanges(state, false);
    showStatus(state, "Mindmap saved successfully");
  } catch (error) {
    showStatus(state, `Error: ${error.message}`, 5000);
  } finally {
    hideLoading(state);
  }
}
