/**
 * state.js — Centralised application state and core node/UI utilities.
 *
 * `createAppState` builds the single shared state object that is passed to
 * every other module. All DOM element references, viewport transform values,
 * drag tracking, history, and per-node data live here.
 *
 * Utility functions (showStatus, findNodeAt, etc.) are exported from this
 * module because they read from or write to the state object.
 */

/**
 * Creates and returns the initial application state object.
 * This must be called after the DOM is ready (inside DOMContentLoaded or later)
 * because it calls `document.getElementById` to resolve UI element references.
 *
 * The returned object is the single source of truth for:
 *  - DOM element handles (canvas, toolbar buttons, inputs)
 *  - All mindmap nodes and links
 *  - Viewport transform (pan/zoom)
 *  - Drag & drop tracking
 *  - Undo history
 *  - Layout and theme settings
 *
 * @returns {Object} The fully initialised app state.
 */
export function createAppState() {
  const canvas = document.getElementById("mindmap");
  const ctx = canvas.getContext("2d");

  return {
    // ── DOM element references ─────────────────────────────────────────────
    canvas,
    ctx,
    renameInput: document.getElementById("renameInput"),
    reorderUp: document.getElementById("reorderUp"),
    reorderDown: document.getElementById("reorderDown"),
    statusMessage: document.getElementById("statusMessage"),
    loadingIndicator: document.getElementById("loadingIndicator"),
    loadingText: document.getElementById("loadingText"),
    toolbar: document.getElementById("toolbar"),
    toolbarToggle: document.getElementById("toolbarToggle"),
    saveBtn: document.getElementById("saveBtn"),
    addBtn: document.getElementById("addBtn"),
    deleteBtn: document.getElementById("deleteBtn"),
    centerBtn: document.getElementById("centerBtn"),
    undoBtn: document.getElementById("undoBtn"),
    clearBtn: document.getElementById("clearBtn"),
    collapseBtn: document.getElementById("collapseBtn"),
    focusBtn: document.getElementById("focusBtn"),
    layoutBtn: document.getElementById("layoutBtn"),
    pinBtn: document.getElementById("pinBtn"),
    themeBtn: document.getElementById("themeBtn"),

    // ── Mindmap data ───────────────────────────────────────────────────────
    // `originalJsonData` retains the full JSON from the last load so that
    // hidden branches (nodes with `hidden: true`) can be re-merged on save.
    originalJsonData: null,
    nodes: [],
    links: [],
    selectedNode: null,
    draggingNode: null,
    ghostX: 0,
    ghostY: 0,
    offsetX: 0,
    offsetY: 0,
    isDragging: false,
    showGhostNode: false,
    debugShowZones: false,
    nodeZones: [],

    // ── Viewport transform ─────────────────────────────────────────────────
    // Canvas is panned/zoomed via a CSS-like transform matrix.
    // viewOffsetX/Y shift the origin; viewScale multiplies all coordinates.
    viewOffsetX: 0,
    viewOffsetY: 0,
    viewScale: 1,
    isPanning: false,
    panStartX: 0,
    panStartY: 0,

    // ── Touch gesture tracking ─────────────────────────────────────────────
    // `lastTouchDist` tracks the pinch distance across touchmove events so the
    // zoom delta can be computed. `lastTapTime` / `lastTapNode` detect double-tap
    // to trigger inline rename on mobile.
    lastTouchDist: null,
    lastTapTime: 0,
    lastTapNode: null,

    // ── Drag & drop drop-target tracking ────────────────────────────────────
    // While dragging, `potentialParent` is the node the ghost would be attached
    // to, and `insertPosition` is the child-array index it would be placed at.
    potentialParent: null,
    insertPosition: -1,

    // ── Undo history ───────────────────────────────────────────────────────
    // Each entry is a full snapshot of nodes, links and viewport state.
    // Capped at `maxHistorySteps` to bound memory use.
    history: [],
    maxHistorySteps: 20,

    currentGistId: null,
    hasUnsavedChanges: false,
    centerButtonClicks: [],

    // ── Rendering flags ────────────────────────────────────────────────────
    // `animationFrameRequested` prevents scheduling more than one pending rAF.
    // `nextNodeId` is a monotonically increasing counter for stable node ids.
    animationFrameRequested: false,
    nextNodeId: 1,

    // ── Layout & focus ─────────────────────────────────────────────────────
    // `layoutMode` controls the tree-positioning algorithm (horizontal / radial / compact).
    // `focusNodeId` (when set) dims all nodes that are not descendants of the focused node.
    layoutMode: "horizontal",
    focusNodeId: null,
    visibleNodeIds: new Set(),
    visibleLinkKeys: new Set(),
    lastDragEndAt: 0,
    lastPointerDownNodeId: null,

    branchTheme: "Calm",
    layoutTransitionActive: false
  };
}

/**
 * Colour palettes applied to nodes and links, indexed by subtree depth.
 * Each theme provides arrays for fill, border, text, and link colours;
 * the depth of a node determines which palette entry is used (wraps around).
 */
const BRANCH_THEMES = {
  Calm: {
    nodeFills: ["#eef2ff", "#e0f2fe", "#dcfce7", "#fef3c7", "#ffe4e6", "#ede9fe"],
    nodeBorders: ["#4f46e5", "#0284c7", "#16a34a", "#d97706", "#e11d48", "#7c3aed"],
    nodeTexts: ["#312e81", "#0c4a6e", "#14532d", "#7c2d12", "#881337", "#4c1d95"],
    linkColors: ["#6366f1", "#0284c7", "#16a34a", "#d97706", "#e11d48", "#7c3aed"]
  },
  Vivid: {
    nodeFills: ["#dbeafe", "#cffafe", "#d9f99d", "#fed7aa", "#fecdd3", "#ddd6fe"],
    nodeBorders: ["#2563eb", "#0e7490", "#65a30d", "#ea580c", "#e11d48", "#7c3aed"],
    nodeTexts: ["#1e3a8a", "#164e63", "#365314", "#7c2d12", "#9f1239", "#5b21b6"],
    linkColors: ["#2563eb", "#06b6d4", "#65a30d", "#f97316", "#f43f5e", "#8b5cf6"]
  },
  Minimal: {
    nodeFills: ["#f8fafc", "#f1f5f9", "#e2e8f0", "#f1f5f9", "#f8fafc", "#e2e8f0"],
    nodeBorders: ["#334155", "#475569", "#64748b", "#475569", "#334155", "#64748b"],
    nodeTexts: ["#0f172a", "#0f172a", "#0f172a", "#0f172a", "#0f172a", "#0f172a"],
    linkColors: ["#334155", "#475569", "#64748b", "#475569", "#334155", "#64748b"]
  }
};

/**
 * Returns the active branch theme colour palette.
 * Falls back to "Calm" if `state.branchTheme` is unrecognised.
 *
 * @param {Object} state - App state.
 * @returns {{ nodeFills: string[], nodeBorders: string[], nodeTexts: string[], linkColors: string[] }}
 */
export function getBranchTheme(state) {
  return BRANCH_THEMES[state.branchTheme] || BRANCH_THEMES.Calm;
}

/**
 * Resizes the canvas to fill the entire browser window.
 * Should be called on init and whenever a `resize` event fires.
 *
 * @param {Object} state - App state.
 */
export function setCanvasSize(state) {
  state.canvas.width = window.innerWidth;
  state.canvas.height = window.innerHeight;
}

/**
 * Creates a new mindmap node with all required fields.
 * The node carries its own drawing and hit-testing methods so the canvas
 * rendering code can call `node.draw()` / `node.isInside()` directly.
 *
 * @param {Object} state       - App state (needed for canvas context and theme).
 * @param {string} text        - Display text for the node.
 * @param {number|null} [explicitId] - If provided, the node is assigned this id
 *   (used when restoring a snapshot). Otherwise the next available id is used.
 * @returns {Object} A fully initialised node object.
 */
export function createNode(state, text, explicitId = null) {
  // Allow an explicit id (e.g. when loading from JSON) while ensuring the
  // global counter always stays ahead of any assigned id.
  const resolvedId = explicitId ?? state.nextNodeId;
  state.nextNodeId = Math.max(state.nextNodeId, resolvedId + 1);

  const node = {
    id: resolvedId,
    text,
    numbering: "",
    x: 0,
    y: 0,
    renderX: 0,
    renderY: 0,
    height: 40,
    width: 100,
    parent: null,
    children: [],
    collapsed: false,
    pinned: false,
    /**
     * Measures the rendered label width and returns the appropriate node width.
     * Adds horizontal padding of 20 px around the text. Minimum width is 100 px.
     */
    calculateWidth() {
      state.ctx.font = "600 14px Manrope";
      const label = this.numbering ? `${this.numbering} ${this.text}` : this.text;
      return Math.max(100, state.ctx.measureText(label).width + 20);
    },
    /**
     * Draws this node onto the canvas.
     * Colour is determined by the active branch theme and the node's depth in
     * the tree. If `isGhost` is true the node is rendered semi-transparently at
     * the current ghost drag position instead of its real position.
     *
     * @param {boolean} [isGhost=false] - When true, draw at ghost drag position.
     */
    draw(isGhost = false) {
      const theme = getBranchTheme(state);

      let depth = 0;
      let current = this.parent;
      while (current) {
        depth += 1;
        current = current.parent;
      }

      const paletteIndex = depth % theme.nodeFills.length;
      const palette = {
        fill: theme.nodeFills[paletteIndex],
        border: theme.nodeBorders[paletteIndex],
        text: theme.nodeTexts[paletteIndex]
      };
      this.width = this.calculateWidth();
      const label = this.numbering ? `${this.numbering} ${this.text}` : this.text;

      if (!Number.isFinite(this.renderX)) {
        this.renderX = this.x;
      }
      if (!Number.isFinite(this.renderY)) {
        this.renderY = this.y;
      }

      state.ctx.globalAlpha = isGhost ? 0.4 : 1;
      const isSelected = this === state.selectedNode && !isGhost;
      state.ctx.fillStyle = isSelected ? "#2563eb" : palette.fill;
      state.ctx.strokeStyle = isSelected ? "#1d4ed8" : palette.border;
      state.ctx.lineWidth = isSelected ? 2.2 : this.collapsed ? 2 : 1.6;
      const radius = 10;

      const x = isGhost ? state.ghostX : this.renderX;
      const y = isGhost ? state.ghostY : this.renderY;

      state.ctx.beginPath();
      state.ctx.moveTo(x + radius, y);
      state.ctx.lineTo(x + this.width - radius, y);
      state.ctx.quadraticCurveTo(x + this.width, y, x + this.width, y + radius);
      state.ctx.lineTo(x + this.width, y + this.height - radius);
      state.ctx.quadraticCurveTo(x + this.width, y + this.height, x + this.width - radius, y + this.height);
      state.ctx.lineTo(x + radius, y + this.height);
      state.ctx.quadraticCurveTo(x, y + this.height, x, y + this.height - radius);
      state.ctx.lineTo(x, y + radius);
      state.ctx.quadraticCurveTo(x, y, x + radius, y);
      state.ctx.closePath();

      state.ctx.shadowColor = isSelected ? "rgba(37, 99, 235, 0.38)" : "rgba(15, 23, 42, 0.08)";
      state.ctx.shadowBlur = isSelected ? 12 : 5;
      state.ctx.shadowOffsetY = isSelected ? 3 : 2;
      state.ctx.fill();
      state.ctx.shadowColor = "transparent";
      state.ctx.stroke();

      state.ctx.fillStyle = isSelected ? "#ffffff" : palette.text;
      state.ctx.font = "600 14px Manrope";
      state.ctx.textAlign = "center";
      state.ctx.textBaseline = "middle";
      state.ctx.fillText(label, x + this.width / 2, y + this.height / 2);

      if (this.pinned && !isGhost) {
        state.ctx.fillStyle = "#0f766e";
        state.ctx.beginPath();
        state.ctx.arc(x + 10, y + 10, 4, 0, Math.PI * 2);
        state.ctx.fill();
      }

      state.ctx.globalAlpha = 1;
    },
    /**
     * Returns true when the canvas-space point (mx, my) is inside this node's
     * bounding rectangle. Uses `renderX`/`renderY` (animated position) when
     * available, falling back to the logical `x`/`y`.
     *
     * @param {number} mx - X coordinate in canvas (logical) space.
     * @param {number} my - Y coordinate in canvas (logical) space.
     * @returns {boolean}
     */
    isInside(mx, my) {
      const hitX = Number.isFinite(this.renderX) ? this.renderX : this.x;
      const hitY = Number.isFinite(this.renderY) ? this.renderY : this.y;
      return mx >= hitX && mx <= hitX + this.width && my >= hitY && my <= hitY + this.height;
    }
  };

  node.width = node.calculateWidth();
  node.renderX = node.x;
  node.renderY = node.y;
  return node;
}

/**
 * Converts a screen-space point (relative to the canvas element's top-left
 * corner) into logical canvas coordinates, accounting for the current
 * pan offset and zoom scale.
 *
 * @param {Object} state - App state.
 * @param {number} x - Screen x in CSS pixels.
 * @param {number} y - Screen y in CSS pixels.
 * @returns {{ x: number, y: number }} The equivalent canvas-space coordinates.
 */
export function toCanvasCoords(state, x, y) {
  return {
    x: (x - state.viewOffsetX) / state.viewScale,
    y: (y - state.viewOffsetY) / state.viewScale
  };
}

/**
 * Briefly displays a status message in the status bar overlay, then hides it.
 *
 * @param {Object} state    - App state.
 * @param {string} message  - Text to display.
 * @param {number} [duration=3000] - How long the message stays visible in ms.
 */
export function showStatus(state, message, duration = 3000) {
  state.statusMessage.textContent = message;
  state.statusMessage.classList.add("visible");

  setTimeout(() => {
    state.statusMessage.classList.remove("visible");
  }, duration);
}

/**
 * Shows the full-screen loading overlay with an optional custom message.
 *
 * @param {Object} state   - App state.
 * @param {string} [text]  - Loading message. Defaults to "Loading...".
 */
export function showLoading(state, text) {
  state.loadingText.textContent = text || "Loading...";
  state.loadingIndicator.style.display = "block";
}

/**
 * Hides the loading overlay.
 *
 * @param {Object} state - App state.
 */
export function hideLoading(state) {
  state.loadingIndicator.style.display = "none";
}

/**
 * Enables or disables the Undo button depending on whether there is more than
 * one history entry. (The first entry is the initial state; undo requires at
 * least two entries so there is something to revert to.)
 *
 * @param {Object} state - App state.
 */
export function updateUndoButton(state) {
  state.undoBtn.disabled = state.history.length <= 1;
}

/**
 * Syncs the enabled/disabled state of several toolbar buttons (Delete, Focus,
 * Pin, Collapse) with the current selection. Called whenever the selection
 * changes or a node is added/removed.
 *
 * @param {Object} state - App state.
 */
export function updateDeleteButton(state) {
  const hasSelection = !!state.selectedNode;
  state.deleteBtn.disabled = !hasSelection;
  state.focusBtn.disabled = !hasSelection;
  state.pinBtn.disabled = !hasSelection;
  state.collapseBtn.disabled = !hasSelection || state.selectedNode.children.length === 0;
}

/**
 * Sets the unsaved-changes flag and updates the Save button appearance.
 * When `value` is true, the Save button receives the "highlight" CSS class to
 * draw the user's attention to pending changes.
 *
 * @param {Object}  state - App state.
 * @param {boolean} value - Whether there are unsaved changes.
 */
export function setUnsavedChanges(state, value) {
  state.hasUnsavedChanges = value;
  state.saveBtn.classList.toggle("highlight", state.hasUnsavedChanges);
}

/**
 * Returns the first node whose bounding rectangle contains the canvas-space
 * point (mx, my), or null if no node is hit.
 * Iterates in array order, so later nodes (drawn on top) could be obscured by
 * earlier ones — in practice the list order matches the render order.
 *
 * @param {Object} state - App state.
 * @param {number} mx    - X in canvas (logical) space.
 * @param {number} my    - Y in canvas (logical) space.
 * @returns {Object|null} The hit node, or null.
 */
export function findNodeAt(state, mx, my) {
  for (const node of state.nodes) {
    if (node.isInside(mx, my)) {
      return node;
    }
  }
  return null;
}
