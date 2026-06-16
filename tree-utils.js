/**
 * tree-utils.js — Pure helper utilities for working with the mindmap JSON tree.
 *
 * These functions operate on plain JSON objects (no live node references) and
 * are used when saving, loading, and normalising mindmap data.
 */

/**
 * Deep-clones any JSON-serialisable value using JSON round-trip.
 * Used to produce isolated snapshots that cannot accidentally mutate live state.
 *
 * @param {*} value - The value to clone.
 * @returns {*} A fully independent deep copy.
 */
export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Recursively walks a single node tree and ensures every node has a stable
 * integer `id`. Nodes without an id (or with a non-integer id) are assigned
 * the next available id from `nextIdRef`. The counter is advanced past any
 * existing ids to prevent collisions.
 *
 * @param {Object} nodeData  - Raw node object from JSON (may lack an `id`).
 * @param {{value: number}} nextIdRef - Mutable counter shared across the recursion.
 * @returns {Object} New node object with a guaranteed integer id and normalised children.
 */
function normalizeNodeWithIds(nodeData, nextIdRef) {
  const normalized = { ...nodeData };

  if (!Number.isInteger(normalized.id)) {
    normalized.id = nextIdRef.value;
    nextIdRef.value += 1;
  } else {
    nextIdRef.value = Math.max(nextIdRef.value, normalized.id + 1);
  }

  const children = Array.isArray(normalized.children) ? normalized.children : [];
  normalized.children = children.map((child) => normalizeNodeWithIds(child, nextIdRef));
  return normalized;
}

/**
 * Normalises an entire mindmap JSON document so that every node has a stable
 * integer id. Nodes that already carry integer ids are kept as-is; the counter
 * is always advanced past the highest existing id to avoid future collisions.
 *
 * @param {Object} jsonData  - Raw mindmap JSON (may contain nodes without ids).
 * @param {number} [startId=1] - The lowest id value to start allocating from.
 * @returns {{ normalized: Object, nextId: number }} The normalised document and
 *   the next available id for subsequent node creation.
 */
export function normalizeJsonWithStableIds(jsonData, startId = 1) {
  const normalized = cloneJson(jsonData || {});
  const nextIdRef = { value: Math.max(1, startId) };
  const rootNodes = Array.isArray(normalized.nodes) ? normalized.nodes : [];
  normalized.nodes = rootNodes.map((node) => normalizeNodeWithIds(node, nextIdRef));

  return {
    normalized,
    nextId: nextIdRef.value
  };
}

/**
 * Recursively collects every node in a JSON node list into a Map keyed by id.
 * Used to build a fast lookup table when merging visible and hidden branches.
 *
 * @param {Object[]} [nodeList] - Array of JSON node objects (may contain nested children).
 * @param {Map<number, Object>} [targetMap] - Accumulator map; pass an existing map to merge
 *   multiple lists into the same table.
 * @returns {Map<number, Object>} The populated id → node map.
 */
export function collectNodesById(nodeList, targetMap = new Map()) {
  for (const node of nodeList || []) {
    targetMap.set(node.id, node);
    if (Array.isArray(node.children) && node.children.length > 0) {
      collectNodesById(node.children, targetMap);
    }
  }
  return targetMap;
}

/**
 * Merges hidden branches from the original (full) JSON back into the visible
 * JSON snapshot before saving. This preserves branches that were hidden via the
 * `hidden` flag and therefore never loaded into live state — they must not be
 * lost when the user saves a partial view.
 *
 * @param {Object} visibleData  - The JSON built from the current live node tree
 *   (only contains nodes that were rendered).
 * @param {Object} originalData - The full JSON loaded at startup, which may
 *   contain `hidden: true` nodes not present in `visibleData`.
 * @returns {Object} A merged document containing both visible and hidden nodes,
 *   along with viewport settings from `visibleData`.
 */
export function mergeHiddenBranchesById(visibleData, originalData) {
  const originalById = collectNodesById(originalData.nodes || []);

  function mergeNode(visibleNode) {
    const mergedChildren = (visibleNode.children || []).map((child) => mergeNode(child));
    const visibleChildIds = new Set(mergedChildren.map((child) => child.id));

    const originalNode = originalById.get(visibleNode.id);
    const hiddenChildren = originalNode && Array.isArray(originalNode.children)
      ? originalNode.children.filter((child) => child.hidden && !visibleChildIds.has(child.id))
      : [];

    return {
      id: visibleNode.id,
      text: visibleNode.text,
      children: [...mergedChildren, ...cloneJson(hiddenChildren)]
    };
  }

  return {
    nodes: (visibleData.nodes || []).map((node) => mergeNode(node)),
    viewScale: visibleData.viewScale,
    viewOffsetX: visibleData.viewOffsetX,
    viewOffsetY: visibleData.viewOffsetY
  };
}
