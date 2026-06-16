/**
 * layout.js — Tree layout algorithms and visibility management.
 *
 * Provides three layout modes (horizontal, radial, compact) plus helpers for:
 *  - Determining which nodes/links are visible given collapse state.
 *  - Focus mode: dimming nodes that are not descendants of the focused node.
 *  - Insertion zones: invisible hit regions used to determine drop targets
 *    when dragging a node.
 *  - Auto-numbering: dot-separated numbering (1., 1.1., 1.2., …) on every node.
 *  - Centring the viewport on the mindmap.
 */

import { showStatus } from "./state.js";

/**
 * Returns the single root node (the node with no parent), or null if the
 * node list is empty.
 *
 * @param {Object} state - App state.
 * @returns {Object|null}
 */
function getRootNode(state) {
  return state.nodes.find((n) => !n.parent) || null;
}

/**
 * Finds a node by its numeric id, or returns null if not found.
 *
 * @param {Object} state  - App state.
 * @param {number} nodeId - The id to look up.
 * @returns {Object|null}
 */
function getNodeById(state, nodeId) {
  return state.nodes.find((node) => node.id === nodeId) || null;
}

/**
 * Returns a node's children array, or an empty array if the node is collapsed.
 * This is the single gate for collapse logic — every traversal that should
 * respect collapsed state uses this function.
 *
 * @param {Object} node
 * @returns {Object[]}
 */
function getVisibleChildren(node) {
  if (node.collapsed) {
    return [];
  }
  return node.children;
}

/**
 * Returns true if `node` is the same as `ancestor` or is a descendant of it.
 * Used by focus mode to decide which nodes are in the focused subtree.
 *
 * @param {Object|null} node     - The node to test.
 * @param {Object|null} ancestor - The potential ancestor.
 * @returns {boolean}
 */
function isDescendantOrSelf(node, ancestor) {
  if (!node || !ancestor) {
    return false;
  }

  let current = node;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Depth-first traversal of the visible subtree rooted at `root`.
 * Respects collapsed nodes (collapsed nodes are visited but their children
 * are not).
 *
 * @param {Object|null} root          - The subtree root.
 * @param {(node: Object) => void} visit - Called for each visited node.
 */
function traverseVisible(root, visit) {
  if (!root) {
    return;
  }

  visit(root);
  for (const child of getVisibleChildren(root)) {
    traverseVisible(child, visit);
  }
}

/**
 * Counts the number of visible leaf nodes in a subtree.
 * A leaf is a node with no visible children (either it has no children or it
 * is collapsed). This is used by the layout algorithms to allocate vertical
 * space proportionally.
 *
 * @param {Object} node
 * @returns {number}
 */
function countVisibleLeaves(node) {
  const visibleChildren = getVisibleChildren(node);
  if (visibleChildren.length === 0) {
    return 1;
  }
  return visibleChildren.map(countVisibleLeaves).reduce((a, b) => a + b, 0);
}

/**
 * Returns an ordered array of all visible nodes in the tree (DFS pre-order),
 * starting from the root. Collapsed nodes are included; their children are not.
 *
 * @param {Object} state - App state.
 * @returns {Object[]}
 */
function collectVisibleNodes(state) {
  const root = getRootNode(state);
  const nodes = [];
  traverseVisible(root, (node) => nodes.push(node));
  return nodes;
}

/**
 * Returns an array of `{ from, to }` link objects for every visible
 * parent→child edge in the tree. Only edges where the parent is not collapsed
 * are included (a collapsed parent hides its children, so their edges should
 * not be drawn).
 *
 * @param {Object} state - App state.
 * @returns {{ from: Object, to: Object }[]}
 */
function collectVisibleLinks(state) {
  const links = [];
  const root = getRootNode(state);
  traverseVisible(root, (node) => {
    if (node.collapsed) {
      return;
    }
    for (const child of node.children) {
      links.push({ from: node, to: child });
    }
  });
  return links;
}

/**
 * Rebuilds the `visibleNodeIds` and `visibleLinkKeys` sets on `state`.
 * These caches are used by the renderer and insertion-zone calculator to
 * quickly skip hidden nodes/links without traversing the full tree each time.
 *
 * @param {Object} state - App state.
 * @returns {{ visibleNodes: Object[], visibleLinks: Object[] }}
 */
function rebuildVisibilityCaches(state) {
  const visibleNodes = collectVisibleNodes(state);
  const visibleLinks = collectVisibleLinks(state);
  state.visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  state.visibleLinkKeys = new Set(visibleLinks.map((link) => `${link.from.id}->${link.to.id}`));
  return { visibleNodes, visibleLinks };
}

/**
 * Positions nodes using a left-to-right hierarchy layout.
 *
 * Each node's X position is determined by its parent's right edge plus a
 * horizontal padding. Vertical positions are assigned leaf-first: leaves
 * consume a fixed `spacingY` slot, and parents are centred over their
 * visible children.
 *
 * Pinned nodes keep their current coordinates; only unpinned nodes are moved.
 *
 * @param {Object} state  - App state.
 * @param {Object} root   - The root node of the tree.
 * @param {{ spacingY: number, horizontalPadding: number, baseX: number }} options
 */
function layoutHorizontal(state, root, { spacingY, horizontalPadding, baseX }) {
  for (const node of state.nodes) {
    node.width = node.calculateWidth();
  }

  const canvasCenterY = state.canvas.height / 2;
  const visibleLeafCount = countVisibleLeaves(root);
  const yRef = {
    value: canvasCenterY - (visibleLeafCount * spacingY) / 2
  };

  function layoutNode(node, depth = 0) {
    if (!node.pinned) {
      if (node.parent) {
        node.x = node.parent.x + node.parent.width + horizontalPadding + depth * 2;
      } else {
        node.x = baseX;
      }
    }

    const visibleChildren = getVisibleChildren(node);

    if (visibleChildren.length === 0) {
      if (!node.pinned) {
        node.y = yRef.value;
      }
      yRef.value += node.height + spacingY;
      return node.y;
    }

    const childYs = visibleChildren.map((child) => layoutNode(child, depth + 1));
    const avgY = childYs.reduce((a, b) => a + b, 0) / childYs.length;
    if (!node.pinned) {
      node.y = avgY;
    }
    return node.y;
  }

  layoutNode(root);
}

/**
 * Positions nodes in a radial/circular layout.
 *
 * The root is placed at the canvas centre. Children are fanned out in a
 * configurable angular range, subdividing the arc proportionally to each
 * subtree's leaf count. Depth grows by a fixed radius step per level.
 *
 * Pinned nodes keep their current coordinates.
 *
 * @param {Object} state - App state.
 * @param {Object} root  - The root node.
 */
function layoutRadial(state, root) {
  for (const node of state.nodes) {
    node.width = node.calculateWidth();
  }

  const centerX = state.canvas.width * 0.45;
  const centerY = state.canvas.height * 0.5;
  const radiusStep = 120;

  function assignPolar(node, startAngle, endAngle, depth) {
    const angle = (startAngle + endAngle) / 2;
    const radius = depth * radiusStep;

    if (!node.pinned) {
      if (depth === 0) {
        node.x = centerX;
        node.y = centerY;
      } else {
        node.x = centerX + Math.cos(angle) * radius;
        node.y = centerY + Math.sin(angle) * radius;
      }
    }

    const visibleChildren = getVisibleChildren(node);
    if (visibleChildren.length === 0) {
      return;
    }

    const totalLeaves = visibleChildren.map((child) => countVisibleLeaves(child)).reduce((a, b) => a + b, 0);
    let cursor = startAngle;

    for (const child of visibleChildren) {
      const childLeaves = countVisibleLeaves(child);
      const span = ((endAngle - startAngle) * childLeaves) / totalLeaves;
      assignPolar(child, cursor, cursor + span, depth + 1);
      cursor += span;
    }
  }

  assignPolar(root, -Math.PI * 0.85, Math.PI * 0.85, 0);
}

/**
 * Dispatches to the appropriate layout function based on `state.layoutMode`.
 *
 * Modes:
 *  - "horizontal" (default): wide left-to-right tree.
 *  - "compact":  left-to-right tree with tighter spacing.
 *  - "radial":   circular/polar layout.
 *
 * @param {Object} state - App state.
 * @param {Object} root  - The root node.
 */
function runLayoutForMode(state, root) {
  if (state.layoutMode === "radial") {
    layoutRadial(state, root);
    return;
  }

  if (state.layoutMode === "compact") {
    layoutHorizontal(state, root, {
      spacingY: 36,
      horizontalPadding: 28,
      baseX: 90
    });
    return;
  }

  layoutHorizontal(state, root, {
    spacingY: 60,
    horizontalPadding: 40,
    baseX: 100
  });
}

/**
 * Numbering is disabled — clears any stored numbering string on every node.
 * Kept as a named function so `autoLayout` can call it without restructuring.
 *
 * @param {Object} state - App state.
 */
export function autoNumberNodes(state) {
  for (const node of state.nodes) {
    node.numbering = "";
  }
}

/**
 * Runs the full layout pipeline: position nodes, assign numbers, and rebuild
 * the visibility caches. Should be called after any structural change
 * (add, delete, collapse, reorder, move).
 *
 * @param {Object} state - App state.
 */
export function autoLayout(state) {
  const root = getRootNode(state);
  if (!root) {
    return;
  }

  runLayoutForMode(state, root);
  autoNumberNodes(state);
  rebuildVisibilityCaches(state);
}

/**
 * Calculates the invisible hit zones used to determine drop positions when
 * dragging a node.
 *
 * Zones are thin rectangles placed above ("before"), below ("after"), and
 * between ("extended-before") each visible sibling, plus a "child" zone to
 * the right of every leaf/collapsed node. Each zone records the target parent
 * and the child-array insertion index so `completeDrag` can immediately apply
 * the correct reparenting.
 *
 * @param {Object} state - App state (writes result to `state.nodeZones`).
 */
export function calculateInsertionZones(state) {
  rebuildVisibilityCaches(state);
  state.nodeZones = [];
  const childrenByParent = new Map();

  state.nodes.forEach((node) => {
    if (!state.visibleNodeIds.has(node.id)) {
      return;
    }
    if (node.parent) {
      if (node.parent.collapsed) {
        return;
      }
      if (!childrenByParent.has(node.parent)) {
        childrenByParent.set(node.parent, []);
      }
      childrenByParent.get(node.parent).push(node);
    }
  });

  childrenByParent.forEach((children, parent) => {
    const sortedChildren = [...children].sort((a, b) => a.y - b.y);
    const standardZoneHeight = 30;

    sortedChildren.forEach((child, index) => {
      const isLastChild = index === sortedChildren.length - 1;
      const isFirstChild = index === 0;
      const zoneWidth = child.x - (parent.x + parent.width) + child.width;

      state.nodeZones.push({
        type: "before",
        parent,
        targetNode: child,
        actualIndex: parent.children.indexOf(child),
        x: parent.x + parent.width,
        y: child.y - standardZoneHeight,
        width: zoneWidth,
        height: standardZoneHeight,
        color: "rgba(255, 0, 0, 0.2)"
      });

      if (!isFirstChild) {
        const prevChild = sortedChildren[index - 1];
        const gapStart = prevChild.y + prevChild.height + standardZoneHeight;
        const gapEnd = child.y - standardZoneHeight;

        if (gapEnd > gapStart) {
          state.nodeZones.push({
            type: "extended-before",
            parent,
            targetNode: child,
            actualIndex: parent.children.indexOf(child),
            x: parent.x + parent.width,
            y: gapStart,
            width: zoneWidth,
            height: gapEnd - gapStart,
            color: "rgba(255, 0, 0, 0.2)"
          });
        }
      }

      if (isLastChild) {
        state.nodeZones.push({
          type: "after",
          parent,
          targetNode: child,
          actualIndex: parent.children.length,
          x: parent.x + parent.width,
          y: child.y + child.height,
          width: zoneWidth,
          height: standardZoneHeight,
          color: "rgba(0, 255, 0, 0.2)"
        });
      }
    });
  });

  state.nodes.forEach((node) => {
    if (!state.visibleNodeIds.has(node.id)) {
      return;
    }

    if (node.children.length === 0 || node.collapsed) {
      state.nodeZones.push({
        type: "child",
        parent: node,
        targetNode: null,
        actualIndex: 0,
        x: node.x + node.width,
        y: node.y,
        width: node.width,
        height: node.height,
        color: "rgba(255, 255, 0, 0.15)"
      });
    }
  });
}

/** Returns an array of all currently visible nodes (respects collapse state). */
export function getVisibleNodes(state) {
  return collectVisibleNodes(state);
}

/** Returns an array of all currently visible links (respects collapse state). */
export function getVisibleLinks(state) {
  return collectVisibleLinks(state);
}

/**
 * Returns true when the link from `fromNode` to `toNode` is visible
 * (i.e. neither node is inside a collapsed branch).
 *
 * @param {Object} state
 * @param {Object} fromNode
 * @param {Object} toNode
 * @returns {boolean}
 */
export function isLinkVisible(state, fromNode, toNode) {
  return state.visibleLinkKeys.has(`${fromNode.id}->${toNode.id}`);
}

/**
 * Returns the node that is currently focused, or null if focus mode is off.
 *
 * @param {Object} state - App state.
 * @returns {Object|null}
 */
export function getFocusNode(state) {
  return state.focusNodeId === null ? null : getNodeById(state, state.focusNodeId);
}

/**
 * Returns true when focus mode is active AND `node` is not within the
 * focused subtree. Dimmed nodes are drawn at low opacity by the renderer.
 *
 * @param {Object} state - App state.
 * @param {Object} node  - The node to test.
 * @returns {boolean}
 */
export function isNodeDimmedByFocus(state, node) {
  const focusNode = getFocusNode(state);
  if (!focusNode) {
    return false;
  }
  return !isDescendantOrSelf(node, focusNode);
}

/**
 * Returns true when focus mode is active AND at least one endpoint of the link
 * (fromNode or toNode) is outside the focused subtree.
 *
 * @param {Object} state
 * @param {Object} fromNode
 * @param {Object} toNode
 * @returns {boolean}
 */
export function isLinkDimmedByFocus(state, fromNode, toNode) {
  const focusNode = getFocusNode(state);
  if (!focusNode) {
    return false;
  }
  return !(isDescendantOrSelf(fromNode, focusNode) && isDescendantOrSelf(toNode, focusNode));
}

/**
 * Counts every descendant of `node`, including children of collapsed subtrees.
 * Used by the collapsed-node summary badge to show the total number of hidden
 * items below a node.
 *
 * @param {Object} node - A mindmap node.
 * @returns {number} Total descendant count.
 */
export function countHiddenDescendants(node) {
  let total = 0;

  function walk(current) {
    for (const child of current.children) {
      total += 1;
      walk(child);
    }
  }

  walk(node);
  return total;
}

/**
 * Adjusts the viewport so the mindmap is centred on screen.
 *
 * The anchor point is the focused node when focus mode is active, otherwise
 * the root node. Horizontal position is set to 15 % of canvas width from the
 * left; vertical position centres the bounding box of all visible nodes.
 *
 * Also implements the "easter egg" debug toggle: clicking the centre button
 * five times within three seconds toggles insertion-zone debug rendering.
 *
 * @param {Object} state           - App state.
 * @param {Function} requestDrawFn - Callback to schedule a redraw (typically
 *   `() => requestDraw(state)`).
 */
export function centerMindmap(state, requestDrawFn) {
  if (state.nodes.length === 0) {
    return;
  }

  const rootNode = getRootNode(state);
  if (!rootNode) {
    return;
  }

  const focusNode = getFocusNode(state);
  const anchorNode = focusNode || rootNode;

  const visibleNodes = collectVisibleNodes(state);

  let minY = Infinity;
  let maxY = -Infinity;

  for (const node of visibleNodes) {
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y + node.height);
  }

  const mindmapCenterY = (minY + maxY) / 2;
  const canvasCenterY = state.canvas.height / 2;
  const leftPadding = state.canvas.width * 0.15;

  state.viewOffsetX = leftPadding - anchorNode.x * state.viewScale;
  state.viewOffsetY = canvasCenterY - mindmapCenterY * state.viewScale;
  requestDrawFn();

  const now = Date.now();
  state.centerButtonClicks.push(now);
  state.centerButtonClicks = state.centerButtonClicks.filter((timestamp) => now - timestamp < 3000);

  if (state.centerButtonClicks.length >= 5) {
    state.debugShowZones = !state.debugShowZones;
    state.centerButtonClicks = [];
    showStatus(state, state.debugShowZones ? "Debug zones enabled" : "Debug zones disabled");
    requestDrawFn();
  }
}
