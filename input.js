/**
 * input.js — User interaction: pointer events, keyboard shortcuts, toolbar,
 *             and all node-manipulation commands.
 *
 * Exports:
 *  - `setupCanvasEvents`    — mouse / touch / wheel listeners on the canvas.
 *  - `setupToolbar`         — toolbar toggle and virtual-keyboard handling.
 *  - `setupKeyboardShortcuts` — global keydown shortcuts.
 *  - `bindControls`         — toolbar button click handlers.
 *  - `showRenameInput`      — shows the floating inline rename text field.
 *  - `initializeFromQuery`  — loads data from URL params, autosave, or defaults.
 */

import { autoLayout, centerMindmap } from "./layout.js";
import { requestDraw } from "./rendering.js";
import { loadFromGist, recoverFromAutosave, saveToGist, saveToHistory, undo } from "./persistence.js";
import {
  createNode,
  findNodeAt,
  setCanvasSize,
  setUnsavedChanges,
  showStatus,
  toCanvasCoords,
  updateDeleteButton
} from "./state.js";

/**
 * Converts a client-space pointer position (from a mouse or touch event) into
 * three coordinate representations used throughout the input handlers.
 *
 * @param {Object} state    - App state.
 * @param {number} clientX  - Horizontal client coordinate.
 * @param {number} clientY  - Vertical client coordinate.
 * @returns {{ x: number, y: number, canvasCoords: { x: number, y: number } }}
 *   `x`/`y` are relative to the canvas element's top-left corner (screen space).
 *   `canvasCoords` are the same point transformed into logical canvas space
 *   (accounts for pan offset and zoom scale).
 */
function getCanvasRelativeCoords(state, clientX, clientY) {
  const rect = state.canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  return {
    x,
    y,
    canvasCoords: toCanvasCoords(state, x, y)
  };
}

/**
 * Returns the Euclidean distance between the two touch points in a
 * two-finger touch event. Used to detect pinch-to-zoom gestures.
 *
 * @param {TouchEvent} e - A touch event with at least two active touches.
 * @returns {number} Distance in CSS pixels.
 */
function getTouchDistance(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Handles the start of a pointer interaction (mousedown or touchstart).
 *
 * - Begins a panning gesture by recording the start offset.
 * - If the pointer hits a node, cancels panning and instead begins drag
 *   tracking on that node, making it the new selection.
 * - When `allowDoubleTapRename` is true (touch-only), also detects a
 *   double-tap (two taps within 400 ms on the same node) and opens the
 *   inline rename field.
 *
 * @param {Object} state    - App state.
 * @param {number} screenX  - Pointer X in screen/client space (used for panning).
 * @param {number} screenY  - Pointer Y in screen/client space.
 * @param {number} mx       - Pointer X in logical canvas space.
 * @param {number} my       - Pointer Y in logical canvas space.
 * @param {{ allowDoubleTapRename?: boolean }} [options]
 */
function beginInteraction(state, screenX, screenY, mx, my, options = {}) {
  const { allowDoubleTapRename = false } = options;

  state.isPanning = true;
  state.panStartX = screenX - state.viewOffsetX;
  state.panStartY = screenY - state.viewOffsetY;

  const hitNode = findNodeAt(state, mx, my);
  if (!hitNode) {
    state.lastPointerDownNodeId = null;
    return;
  }

  state.lastPointerDownNodeId = hitNode.id;

  const dragX = Number.isFinite(hitNode.renderX) ? hitNode.renderX : hitNode.x;
  const dragY = Number.isFinite(hitNode.renderY) ? hitNode.renderY : hitNode.y;
  state.offsetX = mx - dragX;
  state.offsetY = my - dragY;
  state.draggingNode = hitNode;
  state.ghostX = dragX;
  state.ghostY = dragY;
  state.isDragging = false;
  state.selectedNode = hitNode;
  updateDeleteButton(state);
  state.isPanning = false;

  if (!allowDoubleTapRename) {
    return;
  }

  const now = Date.now();
  if (state.lastTapNode === hitNode && now - state.lastTapTime < 400) {
    showRenameInput(state, hitNode);
  }
  state.lastTapNode = hitNode;
  state.lastTapTime = now;
}

/**
 * Updates the viewport pan offset while a panning gesture is active.
 * Does nothing if `state.isPanning` is false.
 *
 * @param {Object} state   - App state.
 * @param {number} screenX - Current pointer X in screen/client space.
 * @param {number} screenY - Current pointer Y in screen/client space.
 */
function updatePan(state, screenX, screenY) {
  if (!state.isPanning) {
    return;
  }

  state.viewOffsetX = screenX - state.panStartX;
  state.viewOffsetY = screenY - state.panStartY;
  requestDraw(state);
}

/**
 * Scans the insertion-zone list to find the zone that contains the current
 * pointer position and sets `state.potentialParent` and `state.insertPosition`
 * accordingly. Falls back to checking whether the pointer is directly over any
 * node body (which would make it a child drop at the end of that node's list).
 *
 * A small `touchPadding` value can be passed to expand the hit area on touch
 * devices, compensating for imprecise finger input.
 *
 * @param {Object} state           - App state.
 * @param {number} mx              - Pointer X in canvas space.
 * @param {number} my              - Pointer Y in canvas space.
 * @param {number} [touchPadding=0] - Extra hit-area padding in px.
 */
function handlePointerMove(state, mx, my, touchPadding = 0) {
  state.insertPosition = -1;
  state.potentialParent = null;

  for (const zone of state.nodeZones) {
    if (zone.targetNode === state.draggingNode || zone.parent === state.draggingNode) {
      continue;
    }

    if (
      mx >= zone.x - touchPadding &&
      mx <= zone.x + zone.width + touchPadding &&
      my >= zone.y - touchPadding &&
      my <= zone.y + zone.height + touchPadding
    ) {
      state.potentialParent = zone.parent;

      if (zone.type === "before" || zone.type === "extended-before") {
        state.insertPosition = zone.actualIndex;
      } else if (zone.type === "after") {
        state.insertPosition = zone.actualIndex;
      } else if (zone.type === "child") {
        state.insertPosition = 0;
      }
      return;
    }
  }

  for (const node of state.nodes) {
    if (node !== state.draggingNode && node.isInside(mx, my)) {
      state.potentialParent = node;
      state.insertPosition = node.children.length;
      return;
    }
  }
}

/**
 * Advances the drag state while the pointer is moving with a node grabbed.
 * Initiates the drag once the pointer has moved more than 3 px from its
 * starting position, updates the ghost position, and calls `handlePointerMove`
 * to refresh the drop-target highlight.
 *
 * @param {Object} state            - App state.
 * @param {number} mx               - Current pointer X in canvas space.
 * @param {number} my               - Current pointer Y in canvas space.
 * @param {number} [touchPadding=0] - Passed through to `handlePointerMove`.
 */
function updateDrag(state, mx, my, touchPadding = 0) {
  if (!state.draggingNode) {
    return;
  }

  const dx = mx - state.ghostX;
  const dy = my - state.ghostY;

  if (!state.isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
    state.isDragging = true;
    state.showGhostNode = true;
  }

  if (!state.isDragging) {
    return;
  }

  state.ghostX = mx - state.offsetX;
  state.ghostY = my - state.offsetY;
  handlePointerMove(state, mx, my, touchPadding);
  requestDraw(state);
}

/**
 * Finalises a drag-and-drop operation when the pointer is released.
 *
 * If a valid drop target (`potentialParent`) exists:
 *  - Removes the dragged node from its current parent.
 *  - Inserts it under `potentialParent` at `insertPosition`.
 *  - Updates the links array to reflect the new edge.
 *  - Runs auto-layout and saves a history snapshot.
 *
 * Regardless of whether a valid drop occurred, all drag tracking flags are
 * reset and a redraw is requested.
 *
 * @param {Object} state - App state.
 */
function completeDrag(state) {
  const wasDragging = state.isDragging;

  if (!state.isDragging || !state.draggingNode) {
    state.potentialParent = null;
    state.insertPosition = -1;
    state.showGhostNode = false;
    state.draggingNode = null;
    state.isDragging = false;
    requestDraw(state);
    updateDeleteButton(state);
    return;
  }

  if (state.potentialParent) {
    let adjustedInsertPosition = state.insertPosition;

    if (state.draggingNode.parent === state.potentialParent) {
      const originalIndex = state.potentialParent.children.indexOf(state.draggingNode);
      if (originalIndex < adjustedInsertPosition) {
        adjustedInsertPosition -= 1;
      }
    }

    if (state.draggingNode.parent) {
      state.draggingNode.parent.children = state.draggingNode.parent.children.filter((c) => c !== state.draggingNode);
    }

    state.draggingNode.parent = state.potentialParent;

    if (adjustedInsertPosition >= 0 && adjustedInsertPosition <= state.potentialParent.children.length) {
      state.potentialParent.children.splice(adjustedInsertPosition, 0, state.draggingNode);
    } else {
      state.potentialParent.children.push(state.draggingNode);
    }

    state.links = state.links.filter((l) => l.to !== state.draggingNode);
    state.links.push({ from: state.potentialParent, to: state.draggingNode });
    autoLayout(state);
    saveToHistory(state);
  }

  state.potentialParent = null;
  state.insertPosition = -1;
  state.showGhostNode = false;
  state.draggingNode = null;
  state.isDragging = false;
  state.lastDragEndAt = wasDragging ? Date.now() : state.lastDragEndAt;
  requestDraw(state);
  updateDeleteButton(state);
}

/**
 * Handles a two-finger pinch-to-zoom gesture on a touch device.
 * Computes the zoom delta from the change in distance between the two touch
 * points since the last event, and adjusts the viewport scale and offset so
 * that the midpoint between the fingers remains stationary on screen.
 *
 * @param {Object}     state - App state.
 * @param {TouchEvent} e     - The current touchmove event.
 * @returns {boolean} True when a pinch was handled, false otherwise.
 */
function handlePinchZoom(state, e) {
  if (e.touches.length !== 2 || !state.lastTouchDist) {
    return false;
  }

  const newDist = getTouchDistance(e);
  const zoomAmount = newDist / state.lastTouchDist;
  const rect = state.canvas.getBoundingClientRect();
  const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
  const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
  const mouse = toCanvasCoords(state, midX, midY);
  const newScale = Math.min(Math.max(state.viewScale * zoomAmount, 0.1), 4);

  state.viewOffsetX -= mouse.x * newScale - mouse.x * state.viewScale;
  state.viewOffsetY -= mouse.y * newScale - mouse.y * state.viewScale;
  state.viewScale = newScale;
  state.lastTouchDist = newDist;
  requestDraw(state);
  return true;
}

/**
 * Adds a new child node to the currently selected node.
 *
 * Special cases:
 *  - If the canvas is empty, creates the first (root) node.
 *  - If nothing is selected, auto-selects the root node so the action always
 *    succeeds without forcing the user to click first.
 *  - Expands a collapsed parent before appending the new child.
 *  - Opens the inline rename field immediately after adding.
 *
 * @param {Object} state - App state.
 */
function addNode(state) {
  if (state.nodes.length === 0) {
    const node = createNode(state, "New node");
    state.nodes.push(node);
    state.selectedNode = node;
    autoLayout(state);
    requestDraw(state);
    updateDeleteButton(state);
    saveToHistory(state);

    setTimeout(() => {
      node.width = node.calculateWidth();
      showRenameInput(state, node);
    }, 10);
    return;
  }

  // If nothing selected, auto-select root so Add always works.
  if (!state.selectedNode) {
    const root = state.nodes.find((n) => !n.parent);
    if (root) {
      state.selectedNode = root;
      updateDeleteButton(state);
    } else {
      showStatus(state, "Click a node first to add a child");
      return;
    }
  }

  const node = createNode(state, "New node");
  if (state.selectedNode.collapsed) {
    state.selectedNode.collapsed = false;
  }
  node.parent = state.selectedNode;
  state.selectedNode.children.push(node);
  state.links.push({ from: state.selectedNode, to: node });

  state.nodes.push(node);
  state.selectedNode = node;

  autoLayout(state);
  requestDraw(state);
  updateDeleteButton(state);
  saveToHistory(state);
  showRenameInput(state, node);
}

/**
 * Deletes the currently selected node and all its descendants.
 * Removes the node from its parent's children list, removes all related links,
 * clears focus if the deleted node was focused, then re-runs auto-layout.
 *
 * @param {Object} state - App state.
 */
function deleteNode(state) {
  if (!state.selectedNode) {
    showStatus(state, "Select a node first");
    return;
  }

  if (state.selectedNode.parent) {
    state.selectedNode.parent.children = state.selectedNode.parent.children.filter((child) => child !== state.selectedNode);
  }

  function removeNodeAndDescendants(node) {
    for (const child of [...node.children]) {
      removeNodeAndDescendants(child);
    }

    state.links = state.links.filter((link) => link.from !== node && link.to !== node);

    const nodeIndex = state.nodes.indexOf(node);
    if (nodeIndex > -1) {
      state.nodes.splice(nodeIndex, 1);
    }
  }

  removeNodeAndDescendants(state.selectedNode);
  if (state.focusNodeId === state.selectedNode?.id) {
    state.focusNodeId = null;
  }
  state.selectedNode = null;

  autoLayout(state);
  requestDraw(state);
  updateDeleteButton(state);
  saveToHistory(state);
}

/**
 * Toggles the collapsed/expanded state of the selected node.
 * Collapsed nodes hide their entire subtree. Does nothing if the node has no
 * children.
 *
 * @param {Object} state - App state.
 */
function toggleCollapseSelected(state) {
  if (!state.selectedNode) {
    showStatus(state, "Select a node first");
    return;
  }

  if (state.selectedNode.children.length === 0) {
    showStatus(state, "Selected node has no children");
    return;
  }

  state.selectedNode.collapsed = !state.selectedNode.collapsed;
  autoLayout(state);
  requestDraw(state);
  saveToHistory(state);
}

/**
 * Toggles the pinned state of the selected node.
 * Pinned nodes are not repositioned by the auto-layout algorithm; they keep
 * whatever coordinates they were last dragged to.
 *
 * @param {Object} state - App state.
 */
function togglePinSelected(state) {
  if (!state.selectedNode) {
    showStatus(state, "Select a node first");
    return;
  }

  state.selectedNode.pinned = !state.selectedNode.pinned;
  autoLayout(state);
  requestDraw(state);
  saveToHistory(state);
}

/**
 * Cycles through the available layout modes: horizontal → radial → compact.
 * Triggers a smooth transition animation and centres the viewport.
 *
 * @param {Object} state - App state.
 */
function cycleLayoutMode(state) {
  const modes = ["horizontal", "radial", "compact"];
  const idx = modes.indexOf(state.layoutMode);
  state.layoutMode = modes[(idx + 1) % modes.length];
  state.layoutTransitionActive = true;

  autoLayout(state);
  centerMindmap(state, () => requestDraw(state));
  requestDraw(state);
  saveToHistory(state);
  showStatus(state, `Layout: ${state.layoutMode}`);
}

/**
 * Cycles through the available branch colour themes: Calm → Vivid → Minimal.
 *
 * @param {Object} state - App state.
 */
function cycleBranchTheme(state) {
  const themes = ["Calm", "Vivid", "Minimal"];
  const idx = themes.indexOf(state.branchTheme);
  state.branchTheme = themes[(idx + 1) % themes.length];
  requestDraw(state);
  saveToHistory(state);
  showStatus(state, `Theme: ${state.branchTheme}`);
}

/**
 * Toggles focus mode for `node`. When focus is activated, all nodes that are
 * not descendants of the focused node are dimmed. Calling again with the same
 * node clears focus.
 *
 * @param {Object}      state - App state.
 * @param {Object|null} node  - The node to focus, or null (no-op).
 */
function toggleFocusForNode(state, node) {
  if (!node) {
    return;
  }

  state.focusNodeId = state.focusNodeId === node.id ? null : node.id;
  centerMindmap(state, () => requestDraw(state));
  requestDraw(state);
  showStatus(state, state.focusNodeId ? "Focus mode enabled" : "Focus mode cleared");
}

/**
 * Toggles focus mode for the currently selected node.
 * Shows a status message if nothing is selected.
 *
 * @param {Object} state - App state.
 */
function toggleFocusSelected(state) {
  if (!state.selectedNode) {
    showStatus(state, "Select a node first");
    return;
  }
  toggleFocusForNode(state, state.selectedNode);
}

/**
 * Removes all nodes and links from the canvas and resets selection and focus.
 *
 * @param {Object} state - App state.
 */
function clearNodes(state) {
  state.nodes = [];
  state.links = [];
  state.selectedNode = null;
  state.focusNodeId = null;
  requestDraw(state);
  updateDeleteButton(state);
  saveToHistory(state);
  showStatus(state, "Canvas cleared");
}

/**
 * Moves the selected node one position earlier in its parent's children array.
 * Does nothing if the node is already the first sibling.
 *
 * @param {Object} state - App state.
 */
function moveNodeUp(state) {
  if (!state.selectedNode || !state.selectedNode.parent) {
    return;
  }

  const siblings = state.selectedNode.parent.children;
  const idx = siblings.indexOf(state.selectedNode);
  if (idx > 0) {
    [siblings[idx - 1], siblings[idx]] = [siblings[idx], siblings[idx - 1]];
    autoLayout(state);
    requestDraw(state);
    saveToHistory(state);
  }
}

/**
 * Moves the selected node one position later in its parent's children array.
 * Does nothing if the node is already the last sibling.
 *
 * @param {Object} state - App state.
 */
function moveNodeDown(state) {
  if (!state.selectedNode || !state.selectedNode.parent) {
    return;
  }

  const siblings = state.selectedNode.parent.children;
  const idx = siblings.indexOf(state.selectedNode);
  if (idx < siblings.length - 1) {
    [siblings[idx], siblings[idx + 1]] = [siblings[idx + 1], siblings[idx]];
    autoLayout(state);
    requestDraw(state);
    saveToHistory(state);
  }
}

/**
 * Positions and shows the floating text `<input>` over the given node so the
 * user can rename it inline. The input is sized and placed to exactly overlay
 * the node rectangle, accounting for the current viewport transform.
 *
 * On blur, the new text is applied if it differs from the original; on Escape
 * the original text is restored. In both cases the input is hidden.
 *
 * @param {Object} state - App state.
 * @param {Object} node  - The node to rename.
 */
export function showRenameInput(state, node) {
  const scale = state.viewScale;
  node.width = node.calculateWidth();

  const x = node.x * scale + state.viewOffsetX;
  const y = node.y * scale + state.viewOffsetY;

  state.renameInput.style.display = "block";
  state.renameInput.value = node.text;
  state.renameInput.style.left = `${x}px`;
  state.renameInput.style.top = `${y}px`;
  state.renameInput.style.width = `${node.width * scale}px`;
  state.renameInput.style.height = `${node.height * scale}px`;
  state.renameInput.style.fontSize = `${14 * scale}px`;
  state.renameInput.style.lineHeight = `${node.height * scale}px`;
  state.renameInput.style.borderRadius = `${10 * scale}px`;
  state.renameInput.style.paddingLeft = `${10 * scale}px`;
  state.renameInput.style.paddingRight = `${10 * scale}px`;

  setTimeout(() => {
    state.renameInput.focus();
    state.renameInput.select();
  }, 10);

  const originalText = node.text;

  state.renameInput.onblur = () => {
    const newText = state.renameInput.value.trim() || node.text;
    state.renameInput.style.display = "none";

    if (newText !== originalText) {
      node.text = newText;
      autoLayout(state);
      requestDraw(state);
      saveToHistory(state);
    }
  };

  state.renameInput.onkeydown = (event) => {
    if (event.key === "Enter") {
      state.renameInput.blur();
    } else if (event.key === "Escape") {
      state.renameInput.value = originalText;
      state.renameInput.blur();
    }
  };
}

/**
 * Attaches all canvas pointer, touch, wheel, and resize event listeners.
 *
 * Events handled:
 *  - `mousedown` / `touchstart`   — begin pan or drag
 *  - `mousemove` / `touchmove`    — update pan, drag, or pinch-zoom
 *  - `mouseup`  / `touchend`      — finalise drag
 *  - `click`                      — select / deselect a node
 *  - `dblclick`                   — open inline rename
 *  - `wheel`                      — zoom in/out centred on cursor
 *  - `resize`                     — resize canvas to match window
 *
 * @param {Object} state - App state.
 */
export function setupCanvasEvents(state) {
  state.canvas.addEventListener("mousedown", (e) => {
    const { canvasCoords } = getCanvasRelativeCoords(state, e.clientX, e.clientY);
    beginInteraction(state, e.clientX, e.clientY, canvasCoords.x, canvasCoords.y);
  });

  state.canvas.addEventListener("mousemove", (e) => {
    const { canvasCoords } = getCanvasRelativeCoords(state, e.clientX, e.clientY);
    updatePan(state, e.clientX, e.clientY);
    updateDrag(state, canvasCoords.x, canvasCoords.y);
  });

  state.canvas.addEventListener("mouseup", () => {
    state.isPanning = false;
    completeDrag(state);
  });

  state.canvas.addEventListener("click", (e) => {
    if (Date.now() - state.lastDragEndAt < 150) {
      return;
    }

    const { canvasCoords } = getCanvasRelativeCoords(state, e.clientX, e.clientY);
    const hitNode = findNodeAt(state, canvasCoords.x, canvasCoords.y);

    // Clicking empty canvas deselects the current node.
    if (!hitNode) {
      state.selectedNode = null;
      updateDeleteButton(state);
      requestDraw(state);
      return;
    }

    state.selectedNode = hitNode;
    updateDeleteButton(state);
    requestDraw(state);
  });

  state.canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const zoomAmount = -e.deltaY * 0.001;
      const { x, y, canvasCoords } = getCanvasRelativeCoords(state, e.clientX, e.clientY);
      const newScale = Math.min(Math.max(state.viewScale * (1 + zoomAmount), 0.1), 4);

      state.viewOffsetX -= canvasCoords.x * newScale - canvasCoords.x * state.viewScale;
      state.viewOffsetY -= canvasCoords.y * newScale - canvasCoords.y * state.viewScale;
      state.viewScale = newScale;
      requestDraw(state);
    },
    { passive: false }
  );

  state.canvas.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        state.lastTouchDist = getTouchDistance(e);
        return;
      }

      const touch = e.touches[0];
      const { canvasCoords } = getCanvasRelativeCoords(state, touch.clientX, touch.clientY);
      beginInteraction(state, touch.clientX, touch.clientY, canvasCoords.x, canvasCoords.y, {
        allowDoubleTapRename: true
      });
    },
    { passive: false }
  );

  state.canvas.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();

      if (handlePinchZoom(state, e)) {
        return;
      }

      if (e.touches.length === 0) {
        return;
      }

      const touch = e.touches[0];
      const { canvasCoords } = getCanvasRelativeCoords(state, touch.clientX, touch.clientY);
      updatePan(state, touch.clientX, touch.clientY);
      updateDrag(state, canvasCoords.x, canvasCoords.y, 10);
    },
    { passive: false }
  );

  state.canvas.addEventListener("touchend", () => {
    state.isPanning = false;
    state.lastTouchDist = null;
    completeDrag(state);
  });

  state.canvas.addEventListener("dblclick", (e) => {
    const { canvasCoords } = getCanvasRelativeCoords(state, e.clientX, e.clientY);
    const hitNode = findNodeAt(state, canvasCoords.x, canvasCoords.y);
    if (hitNode) {
      showRenameInput(state, hitNode);
    }
  });

  window.addEventListener("resize", () => {
    setCanvasSize(state);
    requestDraw(state);
  });
}

/**
 * Sets up the collapsible toolbar for mobile viewports.
 *
 * - On narrow screens (≤ 600 px) a toggle button shows/hides the toolbar.
 * - On wide screens the toggle is hidden and the toolbar is always visible.
 * - Detects virtual-keyboard appearance (via `visualViewport` or focus events)
 *   and adds the `keyboard-active` class so CSS can move the toolbar above
 *   the keyboard.
 *
 * @param {Object} state - App state.
 */
export function setupToolbar(state) {
  function updateToolbarToggle() {
    if (window.innerWidth <= 600) {
      state.toolbarToggle.style.display = "inline-flex";
    } else {
      state.toolbarToggle.style.display = "none";
      state.toolbar.classList.remove("hidden");
    }
  }

  updateToolbarToggle();
  window.addEventListener("resize", updateToolbarToggle);

  state.toolbarToggle.addEventListener("click", () => {
    state.toolbar.classList.toggle("hidden");
    if (window.feather && typeof window.feather.replace === "function") {
      window.feather.replace();
    }
  });

  if ("visualViewport" in window) {
    window.visualViewport.addEventListener("resize", () => {
      const keyboardVisible = window.visualViewport.height < window.innerHeight * 0.8;
      state.toolbar.classList.toggle("keyboard-active", keyboardVisible);
    });
  } else {
    document.addEventListener("focusin", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
        state.toolbar.classList.add("keyboard-active");
      }
    });

    document.addEventListener("focusout", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
        state.toolbar.classList.remove("keyboard-active");
      }
    });
  }
}

/**
 * Registers global `keydown` shortcuts. Shortcuts are ignored when the user
 * is typing inside an `<input>`, `<textarea>`, or a contenteditable element.
 *
 * Shortcut map:
 *  - Ctrl/Cmd + Z  — undo
 *  - Delete / Backspace — delete selected node
 *  - N — add node
 *  - C — centre view
 *  - L — cycle layout mode
 *  - F — toggle focus mode
 *  - P — toggle pin
 *  - X — toggle collapse
 *  - T — cycle theme
 *
 * @param {Object} state - App state.
 */
export function setupKeyboardShortcuts(state) {
  document.addEventListener("keydown", (e) => {
    const targetTag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "";
    const typing = targetTag === "input" || targetTag === "textarea" || e.target.isContentEditable;

    if (typing) {
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo(state);
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteNode(state);
      return;
    }

    if (e.key.toLowerCase() === "n") {
      e.preventDefault();
      addNode(state);
      return;
    }

    if (e.key.toLowerCase() === "c") {
      e.preventDefault();
      centerMindmap(state, () => requestDraw(state));
      return;
    }

    if (e.key.toLowerCase() === "l") {
      e.preventDefault();
      cycleLayoutMode(state);
      return;
    }

    if (e.key.toLowerCase() === "f") {
      e.preventDefault();
      toggleFocusSelected(state);
      return;
    }

    if (e.key.toLowerCase() === "p") {
      e.preventDefault();
      togglePinSelected(state);
      return;
    }

    if (e.key.toLowerCase() === "x") {
      e.preventDefault();
      toggleCollapseSelected(state);
      return;
    }

    if (e.key.toLowerCase() === "t") {
      e.preventDefault();
      cycleBranchTheme(state);
    }
  });
}

/**
 * Binds all toolbar button click handlers and the reorder arrow buttons to
 * their corresponding command functions. Also exposes `moveNodeUp` and
 * `moveNodeDown` on `window` for use by mobile button elements rendered in
 * the HTML.
 *
 * @param {Object} state - App state.
 */
export function bindControls(state) {
  state.addBtn.addEventListener("click", () => addNode(state));
  state.deleteBtn.addEventListener("click", () => deleteNode(state));
  state.centerBtn.addEventListener("click", () => centerMindmap(state, () => requestDraw(state)));
  state.undoBtn.addEventListener("click", () => undo(state));
  state.clearBtn.addEventListener("click", () => clearNodes(state));
  state.saveBtn.addEventListener("click", () => saveToGist(state));
  state.collapseBtn.addEventListener("click", () => toggleCollapseSelected(state));
  state.focusBtn.addEventListener("click", () => toggleFocusSelected(state));
  state.layoutBtn.addEventListener("click", () => cycleLayoutMode(state));
  state.pinBtn.addEventListener("click", () => togglePinSelected(state));
  state.themeBtn.addEventListener("click", () => cycleBranchTheme(state));

  state.reorderUp.addEventListener("click", () => moveNodeUp(state));
  state.reorderDown.addEventListener("click", () => moveNodeDown(state));

  window.moveNodeUp = () => moveNodeUp(state);
  window.moveNodeDown = () => moveNodeDown(state);
}

/**
 * Determines the initial data source and loads it:
 *  1. If a `gistId` query parameter is present in the URL, loads from that Gist.
 *  2. Otherwise, attempts to recover from a localStorage autosave.
 *  3. If neither source has data, creates a default "My Mindmap" root node.
 *
 * @param {Object} state - App state.
 */
export function initializeFromQuery(state) {
  const urlParams = new URLSearchParams(window.location.search);
  const gistId = urlParams.get("gistId");

  if (gistId) {
    loadFromGist(state, gistId);
    return;
  }

  if (recoverFromAutosave(state)) {
    return;
  }

  // No saved data — create a default root node so the canvas isn't blank.
  const rootNode = createNode(state, "My Mindmap");
  state.nodes.push(rootNode);
  state.selectedNode = rootNode;
  autoLayout(state);
  centerMindmap(state, () => requestDraw(state));
  saveToHistory(state);
  state.history = [state.history[state.history.length - 1]];
  setUnsavedChanges(state, false);
  updateDeleteButton(state);
}
