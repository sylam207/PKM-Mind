// mindmap-bundle.js — single-file bundle (no ES modules, works on file://)
(function () {
  "use strict";

  // ── tree-utils.js ──────────────────────────────────────────────────────────

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

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

  function normalizeJsonWithStableIds(jsonData, startId = 1) {
    const normalized = cloneJson(jsonData || {});
    const nextIdRef = { value: Math.max(1, startId) };
    const rootNodes = Array.isArray(normalized.nodes) ? normalized.nodes : [];
    normalized.nodes = rootNodes.map((node) => normalizeNodeWithIds(node, nextIdRef));
    return { normalized, nextId: nextIdRef.value };
  }

  function collectNodesById(nodeList, targetMap = new Map()) {
    for (const node of nodeList || []) {
      targetMap.set(node.id, node);
      if (Array.isArray(node.children) && node.children.length > 0) {
        collectNodesById(node.children, targetMap);
      }
    }
    return targetMap;
  }

  function mergeHiddenBranchesById(visibleData, originalData) {
    const originalById = collectNodesById(originalData.nodes || []);

    function mergeNode(visibleNode) {
      const mergedChildren = (visibleNode.children || []).map((child) => mergeNode(child));
      const visibleChildIds = new Set(mergedChildren.map((child) => child.id));
      const originalNode = originalById.get(visibleNode.id);
      const hiddenChildren =
        originalNode && Array.isArray(originalNode.children)
          ? originalNode.children.filter((child) => child.hidden && !visibleChildIds.has(child.id))
          : [];
      // Preserve ALL fields from visibleNode — only replace children.
      return {
        ...visibleNode,
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

  // ── state.js ───────────────────────────────────────────────────────────────

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

  function getBranchTheme(state) {
    return BRANCH_THEMES[state.branchTheme] || BRANCH_THEMES.Calm;
  }

  function createAppState() {
    const canvas = document.getElementById("mindmap");
    const ctx = canvas.getContext("2d");
    return {
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

      viewOffsetX: 0,
      viewOffsetY: 0,
      viewScale: 1,
      isPanning: false,
      panStartX: 0,
      panStartY: 0,

      lastTouchDist: null,
      lastTapTime: 0,
      lastTapNode: null,

      potentialParent: null,
      insertPosition: -1,

      history: [],
      maxHistorySteps: 20,

      currentGistId: null,
      hasUnsavedChanges: false,
      centerButtonClicks: [],

      animationFrameRequested: false,
      nextNodeId: 1,

      layoutMode: "horizontal",
      focusNodeId: null,
      visibleNodeIds: new Set(),
      visibleLinkKeys: new Set(),
      lastDragEndAt: 0,
      lastPointerDownNodeId: null,

      branchTheme: "Calm",
      layoutTransitionActive: false,
      searchMatchIds: new Set(),

      // ── Multi-map ──────────────────────────────────────────────────────────
      maps: [],         // [{id, name, rootId}]
      activeMapId: null,

      // ── Relationship lines ─────────────────────────────────────────────────
      relLines: [],
      relLinePickMode: false,
      relLineSourceId: null,
      relLineMouseX: null,
      relLineMouseY: null,
      selectedRelLineId: null,
      draggingRelLabel: null,
      draggingRelLine: null,
      _relLineDragMoved: false,
      _relLabelRects: new Map(),
      _relCtrlPtRects: new Map(),
      _relPanelOpts: null,

      savePartBtn: document.getElementById("savePartBtn"),
      pushPartBtn: document.getElementById("pushPartBtn"),
      partsBtn: document.getElementById("partsBtn"),
      pinRefBtn: document.getElementById("pinRefBtn"),
      tagBtn: document.getElementById("tagBtn"),
      attachBtn: document.getElementById("attachBtn"),
      noteBtn: document.getElementById("noteBtn"),
      relLinkBtn: document.getElementById("relLinkBtn"),
      loadBtn: document.getElementById("loadBtn"),
      toolbarMinBtn: document.getElementById("toolbarMinBtn"),
      toolbarRevealBtn: document.getElementById("toolbarRevealBtn"),
      newMapBtn: document.getElementById("newMapBtn"),
      mapsBtn: document.getElementById("mapsBtn"),
      nodeContextPanel: document.getElementById("nodeContextPanel")
    };
  }

  function setCanvasSize(state) {
    state.canvas.width = window.innerWidth;
    state.canvas.height = window.innerHeight;
  }

  function createNode(state, text, explicitId = null) {
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
      tags: [],
      attachments: [],
      instanceState: "live",
      pinnedSnapshot: null,
      calculateWidth() {
        state.ctx.font = "600 14px Manrope";
        const label = this.numbering ? `${this.numbering} ${this.text}` : this.text;
        const textW = Math.max(100, state.ctx.measureText(label).width + 20);
        // If an image attachment is loaded, width = max(text width, image width).
        const imgInfo = getNodeFirstLoadedImage(this);
        if (imgInfo) {
          const { img } = imgInfo;
          const scale = Math.min(IMG_NODE_MAX_W / img.naturalWidth, IMG_NODE_MAX_H / img.naturalHeight, 1);
          return Math.max(textW, Math.round(img.naturalWidth * scale));
        }
        return textW;
      },
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
        const TEXT_BOX_H = 40;  // text box is always 40px; node.height may be taller if images attached

        if (!Number.isFinite(this.renderX)) this.renderX = this.x;
        if (!Number.isFinite(this.renderY)) this.renderY = this.y;

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
        state.ctx.lineTo(x + this.width, y + TEXT_BOX_H - radius);
        state.ctx.quadraticCurveTo(x + this.width, y + TEXT_BOX_H, x + this.width - radius, y + TEXT_BOX_H);
        state.ctx.lineTo(x + radius, y + TEXT_BOX_H);
        state.ctx.quadraticCurveTo(x, y + TEXT_BOX_H, x, y + TEXT_BOX_H - radius);
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
        state.ctx.fillText(label, x + this.width / 2, y + TEXT_BOX_H / 2);

        if (this.pinned && !isGhost) {
          state.ctx.fillStyle = "#0f766e";
          state.ctx.beginPath();
          state.ctx.arc(x + 10, y + 10, 4, 0, Math.PI * 2);
          state.ctx.fill();
        }
        state.ctx.globalAlpha = 1;
      },
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

  function toCanvasCoords(state, x, y) {
    return {
      x: (x - state.viewOffsetX) / state.viewScale,
      y: (y - state.viewOffsetY) / state.viewScale
    };
  }

  function showStatus(state, message, duration = 3000) {
    state.statusMessage.textContent = message;
    state.statusMessage.classList.add("visible");
    setTimeout(() => {
      state.statusMessage.classList.remove("visible");
    }, duration);
  }

  function showLoading(state, text) {
    state.loadingText.textContent = text || "Loading...";
    state.loadingIndicator.style.display = "block";
  }

  function hideLoading(state) {
    state.loadingIndicator.style.display = "none";
  }

  function updateUndoButton(state) {
    state.undoBtn.disabled = state.history.length <= 1;
  }

  function updateDeleteButton(state) {
    const hasSelection = !!state.selectedNode;
    if (state.deleteBtn) state.deleteBtn.disabled = !hasSelection;
    if (state.focusBtn) state.focusBtn.disabled = !hasSelection;
    if (state.pinBtn) state.pinBtn.disabled = !hasSelection;
    if (state.collapseBtn) state.collapseBtn.disabled = !hasSelection || state.selectedNode.children.length === 0;
    updatePartButtons(state);
  }

  function updatePartButtons(state) {
    const node = state.selectedNode;
    if (state.savePartBtn) state.savePartBtn.disabled = !node || !!node.resolvedFromPart;
    if (state.pushPartBtn) state.pushPartBtn.disabled = !node || (!node.isGlobalPartSource && (!node.linkedPartId || !!node.resolvedFromPart || node.instanceState === "pinned"));
    if (state.pinRefBtn) {
      state.pinRefBtn.disabled = !node || !node.linkedPartId || !!node.resolvedFromPart;
      const isPinned = node && node.instanceState === "pinned";
      state.pinRefBtn.classList.toggle("pinned-active", !!isPinned);
      const lbl = state.pinRefBtn.querySelector(".button-label");
      if (lbl) lbl.textContent = isPinned ? "Unpin" : "Pin Ref";
    }
    if (state.tagBtn) state.tagBtn.disabled = !node;
    if (state.attachBtn) state.attachBtn.disabled = !node;
    if (state.noteBtn) state.noteBtn.disabled = !node;
    if (state.relLinkBtn) state.relLinkBtn.disabled = !node;
  }

  function setUnsavedChanges(state, value) {
    state.hasUnsavedChanges = value;
    state.saveBtn.classList.toggle("highlight", state.hasUnsavedChanges);
  }

  function findNodeAt(state, mx, my) {
    for (const node of state.nodes) {
      if (node.isInside(mx, my)) return node;
    }
    return null;
  }

  // ── layout.js ──────────────────────────────────────────────────────────────

  // ── Multi-map helpers ─────────────────────────────────────────────────────

  function getActiveMap(state) {
    return state.maps.find((m) => m.id === state.activeMapId) || state.maps[0] || null;
  }

  function getActiveMapRoot(state) {
    const map = getActiveMap(state);
    if (!map) return null;
    return state.nodes.find((n) => n.id === map.rootId) || null;
  }

  function getNodeRootId(node) {
    let cur = node;
    while (cur.parent) cur = cur.parent;
    return cur.id;
  }

  function getMapForNode(state, node) {
    const rootId = getNodeRootId(node);
    return state.maps.find((m) => m.rootId === rootId) || null;
  }

  function getAllMapRoots(state) {
    return state.maps
      .map((m) => state.nodes.find((n) => n.id === m.rootId))
      .filter(Boolean);
  }

  function getRootNode(state) {
    return getActiveMapRoot(state) || state.nodes.find((n) => !n.parent) || null;
  }

  function getNodeById(state, nodeId) {
    return state.nodes.find((node) => node.id === nodeId) || null;
  }

  function getVisibleChildren(node) {
    return node.collapsed ? [] : node.children;
  }

  function isDescendantOrSelf(node, ancestor) {
    if (!node || !ancestor) return false;
    let current = node;
    while (current) {
      if (current === ancestor) return true;
      current = current.parent;
    }
    return false;
  }

  function traverseVisible(root, visit) {
    if (!root) return;
    visit(root);
    for (const child of getVisibleChildren(root)) {
      traverseVisible(child, visit);
    }
  }

  function countVisibleLeaves(node) {
    const visibleChildren = getVisibleChildren(node);
    if (visibleChildren.length === 0) return 1;
    return visibleChildren.map(countVisibleLeaves).reduce((a, b) => a + b, 0);
  }

  function collectVisibleNodes(state) {
    const nodes = [];
    const roots = state.maps.length > 0 ? getAllMapRoots(state) : [state.nodes.find((n) => !n.parent)].filter(Boolean);
    for (const root of roots) traverseVisible(root, (node) => nodes.push(node));
    return nodes;
  }

  function collectVisibleLinks(state) {
    const links = [];
    const roots = state.maps.length > 0 ? getAllMapRoots(state) : [state.nodes.find((n) => !n.parent)].filter(Boolean);
    for (const root of roots) {
      traverseVisible(root, (node) => {
        if (node.collapsed) return;
        for (const child of node.children) links.push({ from: node, to: child });
      });
    }
    return links;
  }

  function rebuildVisibilityCaches(state) {
    const visibleNodes = collectVisibleNodes(state);
    const visibleLinks = collectVisibleLinks(state);
    state.visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    state.visibleLinkKeys = new Set(visibleLinks.map((link) => `${link.from.id}->${link.to.id}`));
    return { visibleNodes, visibleLinks };
  }

  function layoutHorizontal(state, root, { spacingY, horizontalPadding, baseX, centerY }) {
    // Before computing positions, sync every node's height from the image cache
    // and file badge count. When resolveLinkedNodes tears down old resolved nodes
    // and creates new ones, the new nodes start with height=40. The images are
    // already in _imgCache so img.onload never fires again — we must update the
    // height here synchronously. recomputeNodeHeight covers images + file badges.
    for (const node of state.nodes) {
      if (node.attachments && node.attachments.length > 0) recomputeNodeHeight(node);
    }
    for (const node of state.nodes) {
      node.width = node.calculateWidth();
    }
    const useCenterY = Number.isFinite(centerY) ? centerY : state.canvas.height / 2;

    // Sum actual leaf heights (including images) for accurate initial centering
    function totalLeafHeight(node) {
      const children = getVisibleChildren(node);
      if (children.length === 0) return node.height + spacingY;
      return children.reduce((sum, child) => sum + totalLeafHeight(child), 0);
    }
    const yRef = { value: useCenterY - totalLeafHeight(root) / 2 };

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
        if (!node.pinned) node.y = yRef.value;
        yRef.value += node.height + spacingY;
        return node.y;
      }
      const childYs = visibleChildren.map((child) => layoutNode(child, depth + 1));
      const avgY = childYs.reduce((a, b) => a + b, 0) / childYs.length;
      if (!node.pinned) node.y = avgY;
      // If this internal node has an image that extends below its children's space,
      // push yRef down so the next sibling subtree clears the image bottom.
      const nodeBottom = node.y + node.height + spacingY;
      if (nodeBottom > yRef.value) yRef.value = nodeBottom;
      return node.y;
    }
    layoutNode(root);
  }

  function layoutRadial(state, root) {
    for (const node of state.nodes) {
      node.width = node.calculateWidth();
      if (node.attachments && node.attachments.length > 0) recomputeNodeHeight(node);
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
      if (visibleChildren.length === 0) return;
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

  function runLayoutForMode(state, root, centerY) {
    if (state.layoutMode === "radial") {
      layoutRadial(state, root);
      return;
    }
    if (state.layoutMode === "compact") {
      layoutHorizontal(state, root, { spacingY: 36, horizontalPadding: 28, baseX: 90, centerY });
      return;
    }
    layoutHorizontal(state, root, { spacingY: 60, horizontalPadding: 40, baseX: 100, centerY });
  }

  function autoNumberNodes(state) {
    // Numbering system disabled — clear any stored numbering on all nodes.
    for (const node of state.nodes) {
      node.numbering = "";
    }
  }

  // Vertical slot height per map on the canvas (px in world coords)
  const MAP_SLOT_HEIGHT = 900;

  function autoLayout(state) {
    resolveLinkedNodes(state);
    if (state.maps.length > 0) {
      for (let i = 0; i < state.maps.length; i++) {
        const map = state.maps[i];
        const root = state.nodes.find((n) => n.id === map.rootId);
        if (!root) continue;
        const centerY = (i + 0.5) * MAP_SLOT_HEIGHT;
        runLayoutForMode(state, root, centerY);
      }
    } else {
      // Legacy single-map fallback
      const root = state.nodes.find((n) => !n.parent);
      if (root) runLayoutForMode(state, root, state.canvas.height / 2);
    }
    autoNumberNodes(state);
    rebuildVisibilityCaches(state);
  }

  function calculateInsertionZones(state) {
    rebuildVisibilityCaches(state);
    state.nodeZones = [];
    const childrenByParent = new Map();

    state.nodes.forEach((node) => {
      if (!state.visibleNodeIds.has(node.id)) return;
      if (node.parent) {
        if (node.parent.collapsed) return;
        if (!childrenByParent.has(node.parent)) childrenByParent.set(node.parent, []);
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
      if (!state.visibleNodeIds.has(node.id)) return;
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

  function getVisibleNodes(state) {
    return collectVisibleNodes(state);
  }

  function getVisibleLinks(state) {
    return collectVisibleLinks(state);
  }

  function getFocusNode(state) {
    return state.focusNodeId === null ? null : getNodeById(state, state.focusNodeId);
  }

  function isNodeDimmedByFocus(state, node) {
    const focusNode = getFocusNode(state);
    if (!focusNode) return false;
    return !isDescendantOrSelf(node, focusNode);
  }

  function isLinkDimmedByFocus(state, fromNode, toNode) {
    const focusNode = getFocusNode(state);
    if (!focusNode) return false;
    return !(isDescendantOrSelf(fromNode, focusNode) && isDescendantOrSelf(toNode, focusNode));
  }

  function countHiddenDescendants(node) {
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

  function centerMindmap(state, requestDrawFn) {
    if (state.nodes.length === 0) return;
    const rootNode = getRootNode(state);
    if (!rootNode) return;
    const focusNode = getFocusNode(state);
    const anchorNode = focusNode || rootNode;
    // Collect visible nodes for active map only (for Y-range calculation)
    const activeMapNodes = [];
    traverseVisible(rootNode, (n) => activeMapNodes.push(n));
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of activeMapNodes) {
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

  // ── rendering.js ───────────────────────────────────────────────────────────

  function drawRoundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function getNodeRenderPosition(node) {
    return {
      x: Number.isFinite(node.renderX) ? node.renderX : node.x,
      y: Number.isFinite(node.renderY) ? node.renderY : node.y
    };
  }

  function updateLayoutTransition(state) {
    let stillMoving = false;
    for (const node of state.nodes) {
      if (!Number.isFinite(node.renderX)) node.renderX = node.x;
      if (!Number.isFinite(node.renderY)) node.renderY = node.y;
      if (!state.layoutTransitionActive) {
        node.renderX = node.x;
        node.renderY = node.y;
        continue;
      }
      const dx = node.x - node.renderX;
      const dy = node.y - node.renderY;
      if (Math.abs(dx) < 0.35 && Math.abs(dy) < 0.35) {
        node.renderX = node.x;
        node.renderY = node.y;
        continue;
      }
      node.renderX += dx * 0.22;
      node.renderY += dy * 0.22;
      stillMoving = true;
    }
    if (state.layoutTransitionActive && !stillMoving) {
      state.layoutTransitionActive = false;
    }
    return stillMoving;
  }

  function drawLine(state, from, to, dimmed = false) {
    const fromPos = getNodeRenderPosition(from);
    const toPos = getNodeRenderPosition(to);
    const TEXT_BOX_H = 40;
    const x1 = fromPos.x + from.width;
    const y1 = fromPos.y + TEXT_BOX_H / 2;
    const x2 = toPos.x;
    const y2 = toPos.y + TEXT_BOX_H / 2;
    const cp1x = x1 + 40;
    const cp2x = x2 - 40;
    // Compute depth via parent traversal so link colours work without numbering.
    let fromDepth = 0;
    let depthCursor = from.parent;
    while (depthCursor) { fromDepth++; depthCursor = depthCursor.parent; }
    const theme = getBranchTheme(state);
    state.ctx.strokeStyle = dimmed
      ? "rgba(148, 163, 184, 0.2)"
      : theme.linkColors[fromDepth % theme.linkColors.length];
    state.ctx.lineWidth = dimmed ? 1 : 2.3;
    state.ctx.beginPath();
    state.ctx.moveTo(x1, y1);
    state.ctx.bezierCurveTo(cp1x, y1, cp2x, y2, x2, y2);
    state.ctx.stroke();
  }

  function drawNodeSummary(state, node) {
    if (node.children.length === 0 || !node.collapsed) return;
    const nodePos = getNodeRenderPosition(node);
    const previewItems = node.children.slice(0, 2).map((child) => child.text);
    const hiddenDescendants = countHiddenDescendants(node);
    const moreCount = Math.max(hiddenDescendants - previewItems.length, 0);
    const previewText = `${previewItems.join(", ")}${moreCount > 0 ? ` +${moreCount}` : ""}`;
    state.ctx.fillStyle = "rgba(30, 41, 59, 0.84)";
    state.ctx.font = "600 11px Manrope";
    state.ctx.textAlign = "left";
    state.ctx.textBaseline = "middle";
    state.ctx.fillText(previewText, nodePos.x + node.width + 10, nodePos.y + 20);
  }

  function drawPinnedMarker(state, node) {
    if (!node.pinned) return;
    state.ctx.fillStyle = "#0f766e";
    state.ctx.font = "700 12px Manrope";
    state.ctx.textAlign = "left";
    state.ctx.textBaseline = "top";
    const nodePos = getNodeRenderPosition(node);
    state.ctx.fillText("P", nodePos.x + 6, nodePos.y + 4);
  }

  // Cache for decoded HTMLImageElement objects keyed by attachment id.
  const _imgCache = new Map();

  // ── IndexedDB store for attachment data (bypasses ~5 MB localStorage quota) ──
  const _idb = (() => {
    const DB_NAME = "mindmap_attach_v1";
    const STORE = "data";
    let _dbPromise = null;
    function open() {
      if (_dbPromise) return _dbPromise;
      _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => { _dbPromise = null; reject(req.error); };
      });
      return _dbPromise;
    }
    return {
      put(id, data) {
        open().then((db) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put({ id, data });
        }).catch(() => {});
      },
      remove(id) {
        open().then((db) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(id);
        }).catch(() => {});
      },
      getAll() {
        return open().then((db) => new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).getAll();
          req.onsuccess = () => {
            const map = new Map();
            for (const entry of req.result) map.set(entry.id, entry.data);
            resolve(map);
          };
          req.onerror = () => reject(req.error);
        })).catch(() => new Map());
      }
    };
  })();

  // ── Attachment data persistence ─────────────────────────────────────────
  // Primary: per-key localStorage (synchronous, survives refresh instantly).
  // Fallback: IndexedDB (async, for files too large for localStorage quota).

  function _attachKey(id) { return "mindmap.att." + id; }

  function _persistAttach(id, data) {
    // Try localStorage first — synchronous and reliable.
    try {
      if (canUseLocalStorage()) {
        window.localStorage.setItem(_attachKey(id), data);
        return;
      }
    } catch { /* QuotaExceededError — fall through to IDB */ }
    _idb.put(id, data);
  }

  function _dropAttach(id) {
    try { if (canUseLocalStorage()) window.localStorage.removeItem(_attachKey(id)); } catch {}
    _idb.remove(id);
  }

  // Restore att.data for all stripped attachments after loading from autosave.
  // Synchronous for localStorage hits; also fires an async IDB sweep for any
  // large files that were stored there instead.
  function reinflateAttachments(state) {
    let changed = false;
    for (const node of state.nodes) {
      if (!node.attachments) continue;
      for (const att of node.attachments) {
        if (att.data) continue;
        let data = null;
        try { if (canUseLocalStorage()) data = window.localStorage.getItem(_attachKey(att.id)); } catch {}
        if (data) {
          _imgCache.delete(att.id);
          att.data = data;
          changed = true;
        }
      }
    }
    if (changed) { autoLayout(state); requestDraw(state); }
    // Async IDB sweep for anything still missing (files that exceeded localStorage quota).
    _idb.getAll().then((dataMap) => {
      if (dataMap.size === 0) return;
      let idbChanged = false;
      for (const node of state.nodes) {
        if (!node.attachments) continue;
        for (const att of node.attachments) {
          if (!att.data && dataMap.has(att.id)) {
            _imgCache.delete(att.id);
            att.data = dataMap.get(att.id);
            idbChanged = true;
          }
        }
      }
      if (idbChanged) { autoLayout(state); requestDraw(state); }
    });
  }

  // Max dimensions for an image-mode node (image replaces the text box).
  const IMG_NODE_MAX_W = 300;
  const IMG_NODE_MAX_H = 240;

  // File badge geometry (non-image attachments drawn below the text box / images).
  const FILE_BADGE_H = 26;         // height of each badge pill
  const FILE_BADGE_GAP = 4;        // gap between consecutive badges
  const FILE_ATTACH_TOP_GAP = 8;   // gap between last image (or text box) and first badge

  // Returns all non-image attachments for a node.
  function getNodeFileAtts(node) {
    if (!node.attachments || node.attachments.length === 0) return [];
    return node.attachments.filter((a) => a.type && !a.type.startsWith("image/"));
  }

  // Extra height contributed by file badges (0 when none).
  function getNodeFileBadgesHeight(node) {
    const count = getNodeFileAtts(node).length;
    if (count === 0) return 0;
    return FILE_ATTACH_TOP_GAP + count * FILE_BADGE_H + (count - 1) * FILE_BADGE_GAP;
  }

  // Recomputes node.height from currently-cached images and file badges.
  // Call whenever image cache changes or file attachments are added/removed.
  function recomputeNodeHeight(node) {
    const TEXT_H = 40;
    const IMG_GAP = 8;
    let h = TEXT_H;
    if (node.attachments && node.attachments.length > 0) {
      const imageAtts = node.attachments.filter((a) => a.type && a.type.startsWith("image/"));
      for (const att of imageAtts) {
        const img = _imgCache.get(att.id);
        if (!img || !img.complete || img.naturalWidth === 0) continue;
        const scale = Math.min(IMG_NODE_MAX_W / img.naturalWidth, IMG_NODE_MAX_H / img.naturalHeight, 1);
        h += IMG_GAP + Math.round(img.naturalHeight * scale);
      }
      h += getNodeFileBadgesHeight(node);
    }
    node.height = h;
  }

  // Returns {img, att} for the first image attachment that is fully loaded,
  // or null if none exists or the first image attachment hasn't loaded yet.
  function getNodeFirstLoadedImage(node) {
    if (!node.attachments || node.attachments.length === 0) return null;
    for (const att of node.attachments) {
      if (!att.type || !att.type.startsWith("image/")) continue;
      const img = _imgCache.get(att.id);
      if (img && img.complete && img.naturalWidth > 0) return { img, att };
      return null; // first image att found but not yet decoded
    }
    return null;
  }

  function _getCachedImg(state, att) {
    if (!att.data) return null;  // data not yet inflated — do not cache a broken image
    if (_imgCache.has(att.id)) return _imgCache.get(att.id);
    const img = new Image();
    img.onload = () => {
      const ownerNode = state.nodes.find(
        (n) => n.attachments && n.attachments.some((a) => a.id === att.id)
      );
      if (ownerNode) {
        recomputeNodeHeight(ownerNode);
      }
      autoLayout(state);
      requestDraw(state);
    };
    img.src = att.data;
    _imgCache.set(att.id, img);
    return img;
  }

  function drawNodeAttachmentImages(state, node) {
    if (!node.attachments || node.attachments.length === 0) return;
    const imageAtts = node.attachments.filter((a) => a.type && a.type.startsWith("image/"));
    if (imageAtts.length === 0) return;

    const nodePos = getNodeRenderPosition(node);
    const IMG_GAP = 8;       // gap between text box and image
    const TEXT_H = 40;       // fixed height of the text box
    const RADIUS = 8;
    const MAX_W = IMG_NODE_MAX_W;
    const MAX_H = IMG_NODE_MAX_H;

    // Draw images stacked below the text box, each centered under the node
    let stackY = nodePos.y + TEXT_H + IMG_GAP;

    for (const att of imageAtts) {
      const img = _getCachedImg(state, att);
      if (!img || !img.complete || img.naturalWidth === 0) continue;

      const scale = Math.min(MAX_W / img.naturalWidth, MAX_H / img.naturalHeight, 1);
      const iw = Math.round(img.naturalWidth * scale);
      const ih = Math.round(img.naturalHeight * scale);

      // Center horizontally under the text box
      const ix = nodePos.x + (node.width - iw) / 2;

      // Clip to rounded rect and draw image
      state.ctx.save();
      drawRoundedRectPath(state.ctx, ix, stackY, iw, ih, RADIUS);
      state.ctx.clip();
      state.ctx.drawImage(img, ix, stackY, iw, ih);
      state.ctx.restore();

      // Thin border
      state.ctx.save();
      state.ctx.strokeStyle = "rgba(15, 23, 42, 0.15)";
      state.ctx.lineWidth = 1;
      drawRoundedRectPath(state.ctx, ix, stackY, iw, ih, RADIUS);
      state.ctx.stroke();
      state.ctx.restore();

      stackY += ih + IMG_GAP;
    }
  }

  function drawNodeFileAttachments(state, node) {
    const fileAtts = getNodeFileAtts(node);
    if (fileAtts.length === 0) return;

    const nodePos = getNodeRenderPosition(node);
    const TEXT_H = 40;
    const IMG_GAP = 8;

    // Compute Y after all loaded images (same stacking as drawNodeAttachmentImages)
    let stackY = nodePos.y + TEXT_H;
    if (node.attachments) {
      const imageAtts = node.attachments.filter((a) => a.type && a.type.startsWith("image/"));
      for (const att of imageAtts) {
        const img = _imgCache.get(att.id);
        if (!img || !img.complete || img.naturalWidth === 0) continue;
        const scale = Math.min(IMG_NODE_MAX_W / img.naturalWidth, IMG_NODE_MAX_H / img.naturalHeight, 1);
        stackY += IMG_GAP + Math.round(img.naturalHeight * scale);
      }
    }
    stackY += FILE_ATTACH_TOP_GAP;

    // Icon background colour by MIME type
    function badgeIconColor(type) {
      if (!type) return "#475569";
      if (type === "application/pdf") return "#dc2626";
      if (type.includes("spreadsheet") || type.includes("excel") || type === "text/csv") return "#16a34a";
      if (type.includes("wordprocessing") || type === "application/msword") return "#2563eb";
      if (type.includes("presentation") || type.includes("powerpoint")) return "#ea580c";
      if (type.startsWith("text/")) return "#6b7280";
      if (type.startsWith("video/")) return "#7c3aed";
      if (type.startsWith("audio/")) return "#0891b2";
      return "#475569";
    }

    const ICON_W = 36;
    const RADIUS = 6;
    const ctx = state.ctx;

    for (const att of fileAtts) {
      const bx = nodePos.x;
      const by = stackY;
      const bw = node.width;

      // Badge background
      ctx.save();
      ctx.fillStyle = "#f8fafc";
      ctx.strokeStyle = "rgba(15,23,42,0.12)";
      ctx.lineWidth = 1;
      drawRoundedRectPath(ctx, bx, by, bw, FILE_BADGE_H, RADIUS);
      ctx.fill();
      ctx.stroke();

      // Icon square (left side)
      const iconColor = badgeIconColor(att.type);
      ctx.fillStyle = iconColor;
      drawRoundedRectPath(ctx, bx + 4, by + 3, ICON_W - 4, FILE_BADGE_H - 6, 4);
      ctx.fill();

      // Extension label inside icon
      const ext = att.name ? att.name.split(".").pop().toUpperCase().slice(0, 4) : "FILE";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 9px Manrope, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(ext, bx + 4 + (ICON_W - 4) / 2, by + FILE_BADGE_H / 2);

      // Filename (truncated to fit remaining width)
      const textX = bx + ICON_W + 6;
      const maxTextW = bw - ICON_W - 14;
      ctx.fillStyle = "#1e293b";
      ctx.font = "500 11px Manrope, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      // Truncate to fit
      let label = att.name || ("file_" + att.id);
      while (label.length > 4 && ctx.measureText(label).width > maxTextW) {
        label = label.slice(0, -4) + "\u2026";
      }
      ctx.fillText(label, textX, by + FILE_BADGE_H / 2);
      ctx.restore();

      stackY += FILE_BADGE_H + FILE_BADGE_GAP;
    }
  }

  function updateReorderButtons(state) {
    if (!state.selectedNode || state.isDragging) {
      state.reorderUp.style.display = "none";
      state.reorderDown.style.display = "none";
      if (state.nodeContextPanel) state.nodeContextPanel.classList.remove("visible");
      return;
    }
    const x =
      state.selectedNode.x * state.viewScale +
      state.viewOffsetX +
      state.selectedNode.width * state.viewScale +
      5;
    const y = state.selectedNode.y * state.viewScale + state.viewOffsetY;
    state.reorderUp.style.display = "block";
    state.reorderDown.style.display = "block";
    state.reorderUp.style.left = `${x}px`;
    state.reorderUp.style.top = `${y}px`;
    state.reorderDown.style.left = `${x}px`;
    state.reorderDown.style.top = `${y + 20}px`;

    // Position the node context panel centered above the selected node
    if (state.nodeContextPanel) {
      const nodeScreenX = state.selectedNode.x * state.viewScale + state.viewOffsetX + (state.selectedNode.width * state.viewScale) / 2;
      const nodeScreenY = state.selectedNode.y * state.viewScale + state.viewOffsetY;
      state.nodeContextPanel.style.left = `${nodeScreenX}px`;
      state.nodeContextPanel.style.top = `${nodeScreenY}px`;
      state.nodeContextPanel.classList.add("visible");
    }
  }

  function drawAll(state) {
    const transitioning = updateLayoutTransition(state);
    state.ctx.setTransform(state.viewScale, 0, 0, state.viewScale, state.viewOffsetX, state.viewOffsetY);
    state.ctx.clearRect(
      -state.viewOffsetX / state.viewScale,
      -state.viewOffsetY / state.viewScale,
      state.canvas.width / state.viewScale,
      state.canvas.height / state.viewScale
    );

    calculateInsertionZones(state);

    if (state.debugShowZones) {
      for (const zone of state.nodeZones) {
        state.ctx.fillStyle = zone.color;
        state.ctx.fillRect(zone.x, zone.y, zone.width, zone.height);
        state.ctx.fillStyle = "black";
        state.ctx.font = "10px sans-serif";
        state.ctx.textAlign = "center";
        state.ctx.fillText(zone.type, zone.x + zone.width / 2, zone.y + zone.height / 2);
      }
    }

    const visibleLinks = getVisibleLinks(state);
    for (const link of visibleLinks) {
      const linkDimmed = isLinkDimmedByFocus(state, link.from, link.to);
      drawLine(state, link.from, link.to, linkDimmed);
    }

    const visibleNodes = getVisibleNodes(state);
    for (const node of visibleNodes) {
      const dimmed = isNodeDimmedByFocus(state, node);
      if (state.searchMatchIds.size > 0 && state.searchMatchIds.has(node.id)) {
        const pos = getNodeRenderPosition(node);
        const pad = 4;
        state.ctx.save();
        state.ctx.strokeStyle = "#f59e0b";
        state.ctx.lineWidth = 2.5;
        state.ctx.shadowColor = "rgba(245, 158, 11, 0.6)";
        state.ctx.shadowBlur = 10;
        drawRoundedRectPath(state.ctx, pos.x - pad, pos.y - pad, node.width + pad * 2, 40 + pad * 2, 14);
        state.ctx.stroke();
        state.ctx.restore();
      }
      if (dimmed) state.ctx.globalAlpha = 0.2;
      node.draw(false);
      state.ctx.globalAlpha = 1;
      if (!node.isGlobalPartSource && !node.linkedPartId) {
        drawNodeSummary(state, node);
      }
      drawPinnedMarker(state, node);

      // Global part visual indicators
      const gpos = getNodeRenderPosition(node);
      if (node.isGlobalPartSource || node.linkedPartId) {
        const isPinned = node.instanceState === "pinned";
        const color = node.isGlobalPartSource ? "#16a34a" : (isPinned ? "#d97706" : "#16a34a");
        const borderColor = isPinned ? "#d97706" : "#16a34a";
        if (node.linkedPartId) {
          state.ctx.save();
          state.ctx.strokeStyle = borderColor;
          state.ctx.lineWidth = 1.8;
          state.ctx.setLineDash([4, 3]);
          drawRoundedRectPath(state.ctx, gpos.x - 3, gpos.y - 3, node.width + 6, 40 + 6, 13);
          state.ctx.stroke();
          state.ctx.setLineDash([]);
          state.ctx.restore();
        } else {
          state.ctx.save();
          state.ctx.strokeStyle = color;
          state.ctx.lineWidth = 2;
          state.ctx.shadowColor = "rgba(22, 163, 74, 0.45)";
          state.ctx.shadowBlur = 8;
          drawRoundedRectPath(state.ctx, gpos.x - 3, gpos.y - 3, node.width + 6, 40 + 6, 13);
          state.ctx.stroke();
          state.ctx.restore();
        }
      }
      if (node.resolvedFromPart) {
        state.ctx.fillStyle = "rgba(22, 163, 74, 0.75)";
        state.ctx.beginPath();
        state.ctx.arc(gpos.x + node.width - 6, gpos.y + 6, 3.5, 0, Math.PI * 2);
        state.ctx.fill();
      }
      // Tag indicator: small amber dot at top-left if node has tags
      if (node.tags && node.tags.length > 0) {
        state.ctx.fillStyle = "#f59e0b";
        state.ctx.beginPath();
        state.ctx.arc(gpos.x + 7, gpos.y + 7, 3.5, 0, Math.PI * 2);
        state.ctx.fill();
      }
      // Attachment indicator: small purple dot at bottom-right of text box if node has attachments
      if (node.attachments && node.attachments.length > 0) {
        state.ctx.fillStyle = "#7c3aed";
        state.ctx.beginPath();
        state.ctx.arc(gpos.x + node.width - 7, gpos.y + 40 - 7, 3.5, 0, Math.PI * 2);
        state.ctx.fill();
      }
      // Note indicator: small teal dot at top-right if node has a note
      if (node.note) {
        state.ctx.fillStyle = "#0891b2";
        state.ctx.beginPath();
        state.ctx.arc(gpos.x + node.width - 7, gpos.y + 7, 3.5, 0, Math.PI * 2);
        state.ctx.fill();
      }
      // Links indicator: small orange dot above note dot if node has URL links
      if (node.links && node.links.length > 0) {
        state.ctx.fillStyle = "#ea580c";
        state.ctx.beginPath();
        state.ctx.arc(gpos.x + node.width - 16, gpos.y + 7, 3.5, 0, Math.PI * 2);
        state.ctx.fill();
      }
      // Draw image attachments below the text box
      drawNodeAttachmentImages(state, node);
      // Draw non-image file badges below images
      drawNodeFileAttachments(state, node);
      // Warm the image cache for image attachments (triggers async decode + layout update).
      if (node.attachments) {
        for (const att of node.attachments) {
          if (att.data && att.type && att.type.startsWith("image/")) _getCachedImg(state, att);
        }
      }
    }

    // Relationship lines drawn on top of all nodes so they are always visible
    drawRelLines(state);

    // Live green drawing preview while in pick mode
    if (state.relLinePickMode && state.relLineSourceId != null && state.relLineMouseX != null) {
      const srcNode = state.nodes.find((n) => n.id === state.relLineSourceId);
      if (srcNode) {
        const fp = getNodeRenderPosition(srcNode);
        const mx = state.relLineMouseX;
        const my = state.relLineMouseY;
        const fcx = fp.x + srcNode.width / 2;
        const fcy = fp.y + srcNode.height / 2;
        const dx = mx - fcx, dy = my - fcy;
        const adx = Math.abs(dx), ady = Math.abs(dy);
        let fx, fy;
        if (adx > ady * (srcNode.width / 40)) {
          fx = dx >= 0 ? fp.x + srcNode.width : fp.x;
          fy = fcy;
        } else {
          fx = fcx;
          fy = dy >= 0 ? fp.y + srcNode.height : fp.y;
        }
        const ldx = mx - fx, ldy = my - fy;
        const ldist = Math.sqrt(ldx * ldx + ldy * ldy) || 1;
        const arcH = Math.min(ldist * 0.5, 250);
        const cpx = (fx + mx) / 2 + (ldy / ldist) * arcH;
        const cpy = (fy + my) / 2 + (-ldx / ldist) * arcH;
        state.ctx.save();
        state.ctx.strokeStyle = "#16a34a";
        state.ctx.lineWidth = 2.2;
        state.ctx.setLineDash([9, 5]);
        state.ctx.lineCap = "round";
        state.ctx.globalAlpha = 0.82;
        state.ctx.shadowColor = "rgba(22, 163, 74, 0.45)";
        state.ctx.shadowBlur = 6;
        state.ctx.beginPath();
        state.ctx.moveTo(fx, fy);
        state.ctx.quadraticCurveTo(cpx, cpy, mx, my);
        state.ctx.stroke();
        state.ctx.setLineDash([]);
        state.ctx.shadowBlur = 0;
        drawArrowhead(state.ctx, mx, my, mx - cpx, my - cpy, 10, "#16a34a");
        state.ctx.restore();
      }
    }

    if (state.isDragging && state.draggingNode && state.showGhostNode) {
      state.ctx.globalAlpha = 0.5;
      state.draggingNode.draw(true);
      state.ctx.globalAlpha = 1;
      if (state.potentialParent) {
        state.ctx.strokeStyle = "#007bff";
        state.ctx.lineWidth = 2;
        state.ctx.setLineDash([5, 3]);
        const startX = state.potentialParent.x + state.potentialParent.width;
        const startY = state.potentialParent.y + 20;
        const endX = state.ghostX;
        const endY = state.ghostY + 20;
        const cp1x = startX + 40;
        const cp2x = endX - 40;
        state.ctx.beginPath();
        state.ctx.moveTo(startX, startY);
        state.ctx.bezierCurveTo(cp1x, startY, cp2x, endY, endX, endY);
        state.ctx.stroke();
        state.ctx.setLineDash([]);
      }
    }

    // Draw map name banners above each map's root node
    if (state.maps.length > 1) {
      for (const map of state.maps) {
        const mapRoot = state.nodes.find((n) => n.id === map.rootId);
        if (!mapRoot) continue;
        const rpos = getNodeRenderPosition(mapRoot);
        const isActive = map.id === state.activeMapId;
        const label = map.name;
        state.ctx.save();
        state.ctx.font = "700 13px Manrope";
        const labelW = state.ctx.measureText(label).width + 24;
        const bannerX = rpos.x;
        const bannerY = rpos.y - 46;
        state.ctx.fillStyle = isActive ? "rgba(79,70,229,0.12)" : "rgba(148,163,184,0.10)";
        drawRoundedRectPath(state.ctx, bannerX, bannerY, labelW, 28, 8);
        state.ctx.fill();
        state.ctx.strokeStyle = isActive ? "rgba(79,70,229,0.55)" : "rgba(148,163,184,0.35)";
        state.ctx.lineWidth = 1.2;
        state.ctx.stroke();
        state.ctx.fillStyle = isActive ? "#4f46e5" : "#64748b";
        state.ctx.textAlign = "left";
        state.ctx.textBaseline = "middle";
        state.ctx.fillText(label, bannerX + 12, bannerY + 14);
        state.ctx.restore();
      }
    }

    state.ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Pick-mode banner
    if (state.relLinePickMode) {
      state.ctx.fillStyle = "rgba(37, 99, 235, 0.92)";
      state.ctx.fillRect(0, 0, state.canvas.width, 38);
      state.ctx.fillStyle = "#ffffff";
      state.ctx.font = "600 13px Manrope";
      state.ctx.textAlign = "center";
      state.ctx.textBaseline = "middle";
      state.ctx.fillText("Click the target node to connect — Esc to cancel", state.canvas.width / 2, 19);
    }

    updateReorderButtons(state);
    return transitioning;
  }

  function requestDraw(state) {
    if (state.animationFrameRequested) return;
    state.animationFrameRequested = true;
    requestAnimationFrame(() => {
      const shouldContinue = drawAll(state);
      state.animationFrameRequested = false;
      if (shouldContinue) requestDraw(state);
    });
  }

  // ── persistence.js ─────────────────────────────────────────────────────────

  const AUTOSAVE_SCHEMA_VERSION = 1;
  const AUTOSAVE_STORAGE_KEY = "mindmap.autosave.v1";  // legacy key (migration only)
  const MAP_REGISTRY_KEY = "mindmap.maps.v1";           // global list of all maps
  const mapStorageKey = (id) => `mindmap.map.${id}.v1`; // per-map autosave key

  function canUseLocalStorage() {
    try {
      return typeof window !== "undefined" && !!window.localStorage;
    } catch {
      return false;
    }
  }

  // ── Map registry helpers (shared across all pages/tabs) ───────────────────

  function readRegistry() {
    try {
      if (!canUseLocalStorage()) return [];
      const raw = window.localStorage.getItem(MAP_REGISTRY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function writeRegistry(maps) {
    try {
      if (!canUseLocalStorage()) return;
      window.localStorage.setItem(MAP_REGISTRY_KEY, JSON.stringify(maps));
    } catch {}
  }

  function updateRegistryEntry(id, name) {
    const reg = readRegistry();
    const idx = reg.findIndex((m) => m.id === id);
    if (idx >= 0) { reg[idx].name = name; }
    else { reg.push({ id, name, created: Date.now() }); }
    writeRegistry(reg);
  }

  function removeFromRegistry(id) {
    writeRegistry(readRegistry().filter((m) => m.id !== id));
    try {
      if (canUseLocalStorage()) window.localStorage.removeItem(mapStorageKey(id));
    } catch {}
  }

  function mindmapToJson(state, stripAttachData = false) {
    function buildNodeTree(node) {
      return {
        id: node.id,
        text: node.text,
        collapsed: !!node.collapsed,
        pinned: !!node.pinned,
        linkedPartId: node.linkedPartId || undefined,
        isGlobalPartSource: node.isGlobalPartSource || undefined,
        tags: (node.tags && node.tags.length > 0) ? node.tags : undefined,
        attachments: (node.attachments && node.attachments.length > 0)
          ? (stripAttachData
            ? node.attachments.map(({ id, type, name, size }) => ({ id, type, name, size }))
            : node.attachments)
          : undefined,
        note: node.note || undefined,
        links: (node.links && node.links.length > 0) ? node.links : undefined,
        instanceState: (node.instanceState && node.instanceState !== "live") ? node.instanceState : undefined,
        pinnedSnapshot: node.pinnedSnapshot || undefined,
        children: node.children
          .filter((c) => !c.resolvedFromPart)
          .map((child) => buildNodeTree(child))
      };
    }

    // Build multi-map format
    const mapsData = state.maps.map((map) => {
      const root = state.nodes.find((n) => n.id === map.rootId);
      return {
        id: map.id,
        name: map.name,
        nodes: root ? [buildNodeTree(root)] : []
      };
    });

    const visibleData = {
      maps: mapsData,
      activeMapId: state.activeMapId,
      relLines: (state.relLines && state.relLines.length > 0) ? state.relLines.map((rl) => ({ ...rl })) : undefined,
      layoutMode: state.layoutMode,
      branchTheme: state.branchTheme,
      viewScale: state.viewScale,
      viewOffsetX: state.viewOffsetX,
      viewOffsetY: state.viewOffsetY
    };

    // Merge hidden branches from original data
    if (state.originalJsonData) {
      if (state.originalJsonData.maps) {
        for (let i = 0; i < visibleData.maps.length; i++) {
          const origMap = state.originalJsonData.maps.find((m) => m.id === visibleData.maps[i].id);
          if (origMap) {
            const merged = mergeHiddenBranchesById({ nodes: visibleData.maps[i].nodes }, { nodes: origMap.nodes });
            visibleData.maps[i].nodes = merged.nodes;
          }
        }
      } else if (state.originalJsonData.nodes && visibleData.maps.length === 1) {
        const merged = mergeHiddenBranchesById({ nodes: visibleData.maps[0].nodes }, state.originalJsonData);
        visibleData.maps[0].nodes = merged.nodes;
      }
    }

    return visibleData;
  }

  function buildAutosaveDocument(state) {
    return {
      version: AUTOSAVE_SCHEMA_VERSION,
      savedAt: Date.now(),
      gistId: state.currentGistId || null,
      mindmap: mindmapToJson(state, true)  // strip attachment data — stored separately in IndexedDB
    };
  }

  function writeAutosave(state) {
    if (!canUseLocalStorage() || !state.activeMapId) return;
    try {
      const doc = buildAutosaveDocument(state);
      window.localStorage.setItem(mapStorageKey(state.activeMapId), JSON.stringify(doc));
      const map = state.maps[0];
      if (map) updateRegistryEntry(state.activeMapId, map.name);
    } catch {}
  }

  function readAutosaveDocument(mapId) {
    if (!canUseLocalStorage() || !mapId) return null;
    try {
      const raw = window.localStorage.getItem(mapStorageKey(mapId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== AUTOSAVE_SCHEMA_VERSION || !parsed.mindmap) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function saveToHistory(state) {
    const snapshotNodes = state.nodes
      .filter((node) => !node.resolvedFromPart)
      .map((node) => ({
      id: node.id,
      text: node.text,
      numbering: node.numbering,
      x: node.x,
      y: node.y,
      height: node.height,
      width: node.width,
      parentId: node.parent ? node.parent.id : null,
      childIds: node.children.filter((c) => !c.resolvedFromPart).map((child) => child.id),
      collapsed: !!node.collapsed,
      pinned: !!node.pinned,
      linkedPartId: node.linkedPartId || null,
      isGlobalPartSource: node.isGlobalPartSource || null,
      tags: node.tags || [],
      attachments: node.attachments || [],
      note: node.note || null,
      links: node.links || [],
      instanceState: node.instanceState || "live",
      pinnedSnapshot: node.pinnedSnapshot || null
    }));

    const snapshotRelLines = (state.relLines || []).map((rl) => ({ ...rl }));

    const snapshotLinks = state.links.map((link) => ({
      fromId: link.from.id,
      toId: link.to.id
    }));

    state.history.push({
      nodes: snapshotNodes,
      links: snapshotLinks,
      relLines: snapshotRelLines,
      selectedNodeId: state.selectedNode ? state.selectedNode.id : null,
      focusNodeId: state.focusNodeId,
      layoutMode: state.layoutMode,
      branchTheme: state.branchTheme,
      viewOffsetX: state.viewOffsetX,
      viewOffsetY: state.viewOffsetY,
      viewScale: state.viewScale,
      nextNodeId: state.nextNodeId,
      maps: state.maps.map((m) => ({ id: m.id, name: m.name, rootId: m.rootId })),
      activeMapId: state.activeMapId
    });

    if (state.history.length > state.maxHistorySteps) {
      state.history = state.history.slice(1);
    }

    updateUndoButton(state);
    setUnsavedChanges(state, true);
    writeAutosave(state);
    autoSyncGlobalParts(state);
  }

  function restoreFromHistory(state, snapshot) {
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
      node.linkedPartId = nodeSnapshot.linkedPartId || null;
      node.isGlobalPartSource = nodeSnapshot.isGlobalPartSource || null;
      node.tags = nodeSnapshot.tags || [];
      node.attachments = nodeSnapshot.attachments || [];
      node.note = nodeSnapshot.note || null;
      node.links = nodeSnapshot.links || [];
      node.instanceState = nodeSnapshot.instanceState || "live";
      node.pinnedSnapshot = nodeSnapshot.pinnedSnapshot || null;
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
    state.maps = snapshot.maps || [];
    state.activeMapId = snapshot.activeMapId || (state.maps[0] && state.maps[0].id) || null;
    state.relLines = (snapshot.relLines || []).map((rl) => ({ ...rl }));
    resolveLinkedNodes(state);
    requestDraw(state);
  }

  function undo(state) {
    if (state.history.length <= 1) return;
    state.history.pop();
    const previousSnapshot = state.history[state.history.length - 1];
    restoreFromHistory(state, previousSnapshot);
    updateUndoButton(state);
    updateDeleteButton(state);
    setUnsavedChanges(state, true);
  }

  function jsonToMindmap(state, jsonData) {
    state.nextNodeId = 1;
    state.nodes = [];
    state.links = [];
    state.maps = [];
    state.selectedNode = null;
    state.focusNodeId = null;

    function createNodesFromJson(nodeData, parent = null) {
      if (nodeData.hidden) return null;
      const node = createNode(state, nodeData.text, nodeData.id);
      node.parent = parent;
      node.collapsed = !!nodeData.collapsed;
      node.pinned = !!nodeData.pinned;
      node.linkedPartId = nodeData.linkedPartId || null;
      node.isGlobalPartSource = nodeData.isGlobalPartSource || null;
      node.tags = nodeData.tags || [];
      node.attachments = nodeData.attachments || [];
      node.note = nodeData.note || null;
      node.links = nodeData.links || [];
      node.instanceState = nodeData.instanceState || "live";
      node.pinnedSnapshot = nodeData.pinnedSnapshot || null;
      state.nodes.push(node);
      if (parent) {
        parent.children.push(node);
        state.links.push({ from: parent, to: node });
      }
      const children = Array.isArray(nodeData.children) ? nodeData.children : [];
      children.forEach((childData) => createNodesFromJson(childData, node));
      return node;
    }

    if (jsonData.maps && Array.isArray(jsonData.maps)) {
      // ── New multi-map format ──────────────────────────────────────────────
      // Normalize IDs across all maps with a shared counter
      let nextIdRef = { value: 1 };
      function normalizeNodeIds(nd) {
        if (nd.id === undefined || nd.id === null) nd.id = nextIdRef.value;
        nextIdRef.value = Math.max(nextIdRef.value, nd.id + 1);
        (nd.children || []).forEach(normalizeNodeIds);
      }
      const cloned = cloneJson(jsonData);
      for (const mapData of cloned.maps) {
        (mapData.nodes || []).forEach(normalizeNodeIds);
      }
      state.nextNodeId = nextIdRef.value;
      state.originalJsonData = cloned;

      for (const mapData of cloned.maps) {
        const rootNodeData = mapData.nodes && mapData.nodes[0];
        if (!rootNodeData) continue;
        const root = createNodesFromJson(rootNodeData, null);
        if (root) {
          state.maps.push({ id: mapData.id, name: mapData.name, rootId: root.id });
        }
      }
      state.activeMapId = jsonData.activeMapId || (state.maps[0] && state.maps[0].id) || null;
    } else {
      // ── Legacy single-map format ──────────────────────────────────────────
      const { normalized, nextId } = normalizeJsonWithStableIds(jsonData, state.nextNodeId);
      state.nextNodeId = nextId;
      state.originalJsonData = cloneJson(normalized);
      (normalized.nodes || []).forEach((nodeData) => createNodesFromJson(nodeData));
      const root = state.nodes.find((n) => !n.parent);
      if (root) {
        const mapId = "map_" + Date.now();
        state.maps.push({ id: mapId, name: root.text, rootId: root.id });
        state.activeMapId = mapId;
      }
    }

    if (jsonData.viewScale) state.viewScale = jsonData.viewScale;
    if (jsonData.layoutMode) state.layoutMode = jsonData.layoutMode;
    if (jsonData.branchTheme) state.branchTheme = jsonData.branchTheme;
    if (jsonData.viewOffsetX) state.viewOffsetX = jsonData.viewOffsetX;
    if (jsonData.viewOffsetY) state.viewOffsetY = jsonData.viewOffsetY;
    state.relLines = (jsonData.relLines || []).map((rl) => ({ ...rl }));

    autoLayout(state);
    requestDraw(state);
    setUnsavedChanges(state, false);
    saveToHistory(state);
    state.history = [state.history[0]];
    updateUndoButton(state);
    centerMindmap(state, () => requestDraw(state));
  }

  function recoverFromAutosave(state) {
    const autosaveDoc = readAutosaveDocument(state.activeMapId);
    if (!autosaveDoc) return false;
    jsonToMindmap(state, autosaveDoc.mindmap);
    state.currentGistId = autosaveDoc.gistId || null;
    if (!state.selectedNode && state.nodes.length > 0) {
      state.selectedNode = getActiveMapRoot(state) || state.nodes.find((n) => !n.parent) || state.nodes[0];
    }
    const mapName = (state.maps[0] && state.maps[0].name) || "Mindmap";
    document.title = mapName + " — Mindmap Tool";
    updateDeleteButton(state);
    setUnsavedChanges(state, true);
    // Run layout immediately so resolveLinkedNodes cleans up any stale resolved
    // children that were incorrectly persisted (e.g. from the old duplicate bug).
    autoLayout(state);
    centerMindmap(state, () => requestDraw(state));
    reinflateAttachments(state);  // sync localStorage read + async IDB sweep
    showStatus(state, "Recovered from local autosave");
    return true;
  }

  async function loadFromGist(state, gistId) {
    if (!gistId) return;
    state.currentGistId = gistId;
    showLoading(state, "Loading mindmap from GitHub...");
    try {
      const response = await fetch(`/api/loadGist?gistId=${gistId}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" }
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

  function saveAsLocalFile(state) {
    if (state.nodes.length === 0) { showStatus(state, "Nothing to save"); return; }
    const mindmapData = mindmapToJson(state);
    const json = JSON.stringify(mindmapData, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mindmap.json";
    a.click();
    URL.revokeObjectURL(url);
    setUnsavedChanges(state, false);
    showStatus(state, "Mindmap downloaded as mindmap.json");
  }

  // ── MindMeister import converter ─────────────────────────────────────────
  // Converts a MindMeister v3 export JSON (map_version + root) into the app's
  // native multi-map format so it can be passed directly to jsonToMindmap.
  // attachmentDataMap: Map<string id, base64-data-URL> populated when loading
  // from a .mind ZIP archive (images/ and attachments/ directories inside it).
  function importMindMeister(mmJson, attachmentDataMap = new Map()) {
    // Guess MIME type from a filename extension.
    function guessMime(name) {
      if (!name) return "application/octet-stream";
      const ext = name.split(".").pop().toLowerCase();
      const map = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
        pdf: "application/pdf",
        txt: "text/plain", csv: "text/csv", md: "text/markdown",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        zip: "application/zip", rar: "application/x-rar-compressed",
        mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
        mp3: "audio/mpeg", wav: "audio/wav",
        json: "application/json", xml: "application/xml"
      };
      return map[ext] || "application/octet-stream";
    }
    // Extract MIME from a data URL (data:{mime};base64,...).
    function mimeFromDataUrl(dataUrl) {
      const m = dataUrl && dataUrl.match(/^data:([^;]+);/);
      return m ? m[1] : "application/octet-stream";
    }

    // Build metadata lookups from top-level arrays.
    // images[i].id and attachments[i].id are the file IDs that match ZIP filenames.
    const imageMetaById = new Map();
    for (const img of (mmJson.images || [])) {
      if (img.id != null) imageMetaById.set(String(img.id), {
        name: img.filename || ("image_" + img.id),
        type: img.contentType || guessMime(img.filename || "")
      });
    }
    // Top-level attachments: build a metadata lookup AND a per-node lookup.
    // MindMeister uses several different field names across export versions to
    // link an attachment to its node: idea_id, mind_map_idea_id, node_id.
    // We try all of them so no attachment is silently dropped.
    const attachMetaById = new Map();
    const attachByIdeaId = new Map();   // nodeId (string) → [{fileId, attId, name, type, apiUrl}]
    const unlinkedAtts = [];            // attachments with no node link at all
    for (const att of (mmJson.attachments || [])) {
      if (att.id == null) continue;
      const fileId = att.file_id != null ? String(att.file_id) : String(att.id);
      const attId  = String(att.id);
      const name   = att.filename || ("file_" + fileId);
      const type   = att.contentType || guessMime(name);
      const apiUrl = att.api_url || att.url || null;
      const meta   = { name, type, apiUrl };
      attachMetaById.set(attId, meta);
      if (fileId !== attId) attachMetaById.set(fileId, meta);

      // Try every field name MindMeister has used across versions.
      const nodeId = att.idea_id ?? att.mind_map_idea_id ?? att.node_id ?? att.parent_id ?? null;
      if (nodeId != null) {
        const key = String(nodeId);
        if (!attachByIdeaId.has(key)) attachByIdeaId.set(key, []);
        attachByIdeaId.get(key).push({ fileId, attId, name, type, apiUrl });
      } else {
        // No node link found — collect for fallback onto the root node.
        unlinkedAtts.push({ fileId, attId, name, type, apiUrl });
      }
    }

    // Top-level links array: each entry links a URL (or external reference) to a node.
    // Fields: idea_id / mind_map_idea_id / node_id link to the node; url is the href.
    const linksByIdeaId = new Map(); // nodeId → [{label, url}]
    for (const lnk of (mmJson.links || [])) {
      const nodeId = lnk.idea_id ?? lnk.mind_map_idea_id ?? lnk.node_id ?? null;
      if (nodeId == null) continue;
      const key = String(nodeId);
      if (!linksByIdeaId.has(key)) linksByIdeaId.set(key, []);
      linksByIdeaId.get(key).push({
        label: lnk.title || lnk.label || lnk.url || "Link",
        url:   lnk.url || lnk.href || null
      });
    }

    // Try every plausible ZIP key for a given attachment and return the first hit.
    // MindMeister may name ZIP entries by file_id, record id, or original filename.
    function resolveZipData(fileId, attId, filename) {
      const keysToTry = [];
      if (fileId) keysToTry.push(String(fileId));
      if (attId && String(attId) !== String(fileId)) keysToTry.push(String(attId));
      if (filename) {
        keysToTry.push(filename);                          // "paper.pdf"
        const bare = filename.replace(/\.[^.]+$/, "");
        if (bare !== filename) keysToTry.push(bare);       // "paper"
      }
      for (const key of keysToTry) {
        const d = attachmentDataMap.get(key);
        if (d) return d;
      }
      return null;
    }

    let nextId = 1;
    // extraRootAtts: unlinked top-level attachments that get placed on the root node.
    // Populated after all nodes are converted (root id is known at that point).
    let rootNodeRef = null;
    function convertNode(mmNode) {
      const id = nextId++;
      const children = (mmNode.children || [])
        .slice()
        .sort((a, b) => ((a.rank || 0) - (b.rank || 0)))
        .map(convertNode);

      const appAttachments = [];

      // ── Node image ───────────────────────────────────────────────────────
      if (mmNode.image) {
        const fileId = mmNode.image.image_file_id != null
          ? String(mmNode.image.image_file_id)
          : (mmNode.image.id != null ? String(mmNode.image.id) : null);
        const attId = mmNode.image.id != null ? String(mmNode.image.id) : null;
        const filename = mmNode.image.filename || mmNode.image.name || null;
        if (fileId || attId) {
          const dataUrl = resolveZipData(fileId, attId, filename);
          const meta = imageMetaById.get(fileId) || imageMetaById.get(attId) || null;
          const name = (meta && meta.name) || filename || ("image_" + (fileId || attId));
          const type = dataUrl ? mimeFromDataUrl(dataUrl) : ((meta && meta.type) || guessMime(name));
          const entry = { id: "mm_img_" + (fileId || attId), name, type };
          if (dataUrl) {
            entry.data = dataUrl;
            entry.size = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
          }
          appAttachments.push(entry);
        }
      }

      // ── Note (rich text) ────────────────────────────────────────────────
      // MindMeister stores notes as HTML in node.note or node.notes.
      const rawNote = mmNode.note || mmNode.notes || null;
      const noteHtml = rawNote ? (typeof rawNote === "string" ? rawNote : (rawNote.html || rawNote.text || String(rawNote))) : null;

      // ── URL link attached to this node ───────────────────────────────
      // node.link is a single URL string; linksByIdeaId holds top-level link records.
      const nodeLinks = [];
      if (mmNode.link) {
        const href = typeof mmNode.link === "string" ? mmNode.link : (mmNode.link.url || mmNode.link.href || null);
        const label = (typeof mmNode.link === "object" && (mmNode.link.title || mmNode.link.label)) || href;
        if (href) nodeLinks.push({ label: label || href, url: href });
      }
      for (const lnk of (linksByIdeaId.get(String(mmNode.id)) || [])) {
        if (lnk.url && !nodeLinks.some((l) => l.url === lnk.url)) nodeLinks.push(lnk);
      }

      // ── File attachments ─────────────────────────────────────────────────
      // Build a merged, deduplicated list from BOTH the node's own `attachments`
      // array AND the top-level `attachments` array (keyed by idea_id). MindMeister
      // may put the full metadata in one source and partial info in the other.
      // We use a Map keyed by a stable id so each attachment appears only once.
      const attSourceMap = new Map(); // stableKey → {fileId, attId, filename, type, apiUrl, meta}

      // 1. Node-level attachments (may lack file_id or contentType)
      for (const att of (mmNode.attachments || [])) {
        const attId  = att.id != null ? String(att.id) : null;
        const fileId = att.file_id != null ? String(att.file_id) : attId;
        const key = fileId || attId;
        if (!key) continue;
        const topMeta = attachMetaById.get(fileId) || attachMetaById.get(attId) || null;
        attSourceMap.set(key, {
          fileId, attId,
          name:   (topMeta && topMeta.name)   || att.filename || att.name || ("file_" + key),
          type:   (topMeta && topMeta.type)   || att.contentType || guessMime(att.filename || att.name || ""),
          apiUrl: (topMeta && topMeta.apiUrl) || att.api_url || att.url || null
        });
      }

      // 2. Top-level attachments linked to this node via idea_id / mind_map_idea_id etc.
      for (const rec of (attachByIdeaId.get(String(mmNode.id)) || [])) {
        const key = rec.fileId || rec.attId;
        if (!key) continue;
        if (attSourceMap.has(key)) {
          const ex = attSourceMap.get(key);
          if (!ex.apiUrl && rec.apiUrl) ex.apiUrl = rec.apiUrl;
        } else {
          attSourceMap.set(key, rec);
        }
      }

      for (const { fileId, attId, name, type, apiUrl } of attSourceMap.values()) {
        const dataUrl = resolveZipData(fileId, attId, name);
        const stableId = "mm_att_" + (fileId || attId);
        if (appAttachments.some((a) => a.id === stableId)) continue;
        const entry = { id: stableId, name, type };
        if (dataUrl) {
          entry.data = dataUrl;
          entry.size = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
        } else if (apiUrl) {
          // No embedded data — store the CDN URL so the badge can open it in a new tab.
          entry.url = apiUrl;
        }
        appAttachments.push(entry);
      }

      const node = { id, text: (mmNode.title || "Untitled").trim(), children };
      if (appAttachments.length > 0) node.attachments = appAttachments;
      if (noteHtml) node.note = noteHtml;
      if (nodeLinks.length > 0) node.links = nodeLinks;
      if (!rootNodeRef) rootNodeRef = node; // first node converted is always the root
      return node;
    }
    const root = convertNode(mmJson.root);

    // Attach unlinked top-level attachments to the root node so they are visible
    // even when MindMeister omitted idea_id from the export.
    if (unlinkedAtts.length > 0) {
      if (!root.attachments) root.attachments = [];
      for (const { fileId, attId, name, type, apiUrl } of unlinkedAtts) {
        const stableId = "mm_att_" + (fileId || attId);
        if (root.attachments.some((a) => a.id === stableId)) continue;
        const dataUrl = resolveZipData(fileId, attId, name);
        const entry = { id: stableId, name, type };
        if (dataUrl) {
          entry.data = dataUrl;
          entry.size = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
        } else if (apiUrl) {
          entry.url = apiUrl;
        }
        root.attachments.push(entry);
      }
    }
    const mapId = "map_" + Date.now();
    return {
      maps: [{ id: mapId, name: root.text, nodes: [root] }],
      activeMapId: mapId,
      layoutMode: "horizontal",
      branchTheme: "Calm",
      viewScale: 1,
      viewOffsetX: 0,
      viewOffsetY: 0
    };
  }

  // ── MindMeister .mind ZIP loader ─────────────────────────────────────────
  // A .mind file is a ZIP containing map.json plus attachments/ and images/
  // directories (files named by their numeric ID, with the original filename
  // given by the id→name mapping inside map.json).
  async function loadMindFile(zipArrayBuffer) {
    const JSZip = window.JSZip;
    if (!JSZip) throw new Error("JSZip not loaded — cannot open .mind file");

    const zip = await JSZip.loadAsync(zipArrayBuffer);

    // Find map.json (may be at root or one level deep inside a folder)
    let mapEntry = zip.file("map.json");
    if (!mapEntry) {
      const found = zip.file(/\/map\.json$/)[0] || zip.file(/^map\.json$/)[0];
      mapEntry = found || null;
    }
    if (!mapEntry) throw new Error("No map.json found inside .mind archive");

    const mapText = await mapEntry.async("text");
    const mmJson = JSON.parse(mapText);

    // Build a lookup of all non-JSON files by their bare filename (the numeric ID).
    // MindMeister stores files as  attachments/{id}  or  images/{id}  or  {id}.{ext}
    // We index every file under both its bare name (sans extension) and full name.
    const attachmentDataMap = new Map(); // id string → data URL

    const filePromises = [];
    zip.forEach((relativePath, zipEntry) => {
      if (zipEntry.dir) return;
      if (/map\.json$/i.test(relativePath)) return;

      filePromises.push((async () => {
        const bare = relativePath.replace(/^.*\//, "").replace(/\.[^.]+$/, ""); // strip dir + ext
        const fullName = relativePath.replace(/^.*\//, "");                      // strip dir only

        const uint8 = await zipEntry.async("uint8array");

        // Determine MIME type: prefer magic-byte sniffing so files without extensions work.
        function sniffMime(bytes, filename) {
          if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
          if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
          if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
          // WebP: RIFF????WEBP
          if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
              bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
          if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
          // OLE2 Compound Document (legacy .xls, .doc, .ppt)
          if (bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) {
            const ext = filename.split(".").pop().toLowerCase();
            if (ext === "xls") return "application/vnd.ms-excel";
            if (ext === "ppt") return "application/vnd.ms-powerpoint";
            return "application/msword"; // .doc or unknown OLE2
          }
          // ZIP-based Office formats (XLSX, DOCX, PPTX all start with PK)
          // — fall through to extension lookup so the correct subtype is used.
          // Fall back to extension-based guess
          const ext = filename.split(".").pop().toLowerCase();
          const mimeMap = {
            jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
            gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
            pdf: "application/pdf",
            txt: "text/plain", csv: "text/csv", md: "text/markdown",
            doc: "application/msword",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            xls: "application/vnd.ms-excel",
            xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ppt: "application/vnd.ms-powerpoint",
            pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            zip: "application/zip", rar: "application/x-rar-compressed",
            mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
            mp3: "audio/mpeg", wav: "audio/wav",
            json: "application/json", xml: "application/xml"
          };
          return mimeMap[ext] || "application/octet-stream";
        }
        const mime = sniffMime(uint8, fullName);
        // Convert Uint8Array → base64 safely (avoids call-stack overflow for large files)
        let binary = "";
        const chunkSize = 8192;
        for (let i = 0; i < uint8.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, uint8.subarray(i, i + chunkSize));
        }
        const dataUrl = "data:" + mime + ";base64," + btoa(binary);
        attachmentDataMap.set(bare, dataUrl);
        if (fullName !== bare) attachmentDataMap.set(fullName, dataUrl);
      })());
    });

    await Promise.all(filePromises);

    // ── Diagnostic: log ZIP contents and JSON structure to browser console ──
    console.group("[MindMeister .mind load]");
    console.log("Files in ZIP:", Object.keys(zip.files).filter(p => !zip.files[p].dir));
    console.log("attachmentDataMap keys:", [...attachmentDataMap.keys()]);
    console.log("Top-level images count:", (mmJson.images || []).length, "— sample:", JSON.stringify((mmJson.images || [])[0], null, 2));
    console.log("Top-level attachments count:", (mmJson.attachments || []).length, "— sample:", JSON.stringify((mmJson.attachments || [])[0], null, 2));
    console.log("Top-level links count:", (mmJson.links || []).length, "— sample:", JSON.stringify((mmJson.links || [])[0], null, 2));
    function findNodesWithMedia(node, results = []) {
      if ((node.image && node.image !== null) || (node.attachments && node.attachments.length > 0)
          || node.note || node.notes || node.link) {
        results.push({ title: node.title, id: node.id, image: !!node.image,
          attachments: node.attachments, note: !!(node.note || node.notes), link: node.link });
      }
      for (const c of (node.children || [])) findNodesWithMedia(c, results);
      return results;
    }
    const mediaNodes = findNodesWithMedia(mmJson.root);
    console.log("Nodes with media/note/link data (" + mediaNodes.length + "):");
    mediaNodes.forEach(n => console.log("  node id=" + n.id + " \"" + n.title + "\"",
      "image:", n.image, "atts:", JSON.stringify(n.attachments), "note:", n.note, "link:", JSON.stringify(n.link)));
    console.groupEnd();
    // ───────────────────────────────────────────────────────────────────────

    return { mmJson, attachmentDataMap };
  }

  function loadFromFile(state) {
    const input = document.getElementById("loadFileInput");
    if (!input) return;
    // Reset so the same file can be re-selected after a first load
    input.value = "";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;

      // Helper: finish loading once we have the final json and know if it came from MindMeister
      function finishLoad(json, isMindMeister) {
        jsonToMindmap(state, json);
        // Persist any attachment data that came with the file so page refreshes retain images.
        for (const node of state.nodes) {
          if (!node.attachments) continue;
          for (const att of node.attachments) {
            if (att.data) _persistAttach(att.id, att.data);
          }
        }
        // In the per-page architecture each map lives on its own URL.
        // If the file contains multiple maps, store the extras as separate pages
        // and keep only the active map on this canvas.
        if (state.maps.length > 1) {
          const fullJson = mindmapToJson(state);
          for (const mapData of fullJson.maps) {
            if (mapData.id !== state.activeMapId) {
              const extraDoc = {
                version: AUTOSAVE_SCHEMA_VERSION,
                savedAt: Date.now(),
                gistId: null,
                mindmap: {
                  maps: [mapData],
                  activeMapId: mapData.id,
                  layoutMode: fullJson.layoutMode,
                  branchTheme: fullJson.branchTheme,
                  viewScale: 1, viewOffsetX: 0, viewOffsetY: 0
                }
              };
              window.localStorage.setItem(mapStorageKey(mapData.id), JSON.stringify(extraDoc));
              updateRegistryEntry(mapData.id, mapData.name || "Map");
            }
          }
          // Trim state to active map only
          const activeMapEntry = state.maps.find((m) => m.id === state.activeMapId) || state.maps[0];
          const keepIds = new Set();
          const activeRoot = state.nodes.find((n) => n.id === activeMapEntry.rootId);
          (function gatherIds(node) {
            keepIds.add(node.id);
            for (const c of node.children) gatherIds(c);
          })(activeRoot || { id: -1, children: [] });
          state.nodes = state.nodes.filter((n) => keepIds.has(n.id));
          state.links = state.links.filter((l) => keepIds.has(l.from.id) && keepIds.has(l.to.id));
          state.maps = [activeMapEntry];
          state.activeMapId = activeMapEntry.id;
          autoLayout(state);
        }
        // Update URL and registry to match the loaded map's ID
        if (state.activeMapId) {
          history.replaceState(null, "", "?map=" + state.activeMapId);
          updateRegistryEntry(state.activeMapId, (state.maps[0] && state.maps[0].name) || "Map");
          document.title = ((state.maps[0] && state.maps[0].name) || "Map") + " — Mindmap Tool";
        }
        reinflateAttachments(state);
        centerMindmap(state, () => requestDraw(state));
        const attCount = state.nodes.reduce((s, n) => s + ((n.attachments && n.attachments.length) || 0), 0);
        const attNote = attCount > 0 ? ` (${attCount} attachment${attCount !== 1 ? "s" : ""} loaded)` : "";
        showStatus(state, (isMindMeister ? `Imported MindMeister map: ${file.name}` : `Loaded: ${file.name}`) + attNote);
      }

      const isMindFile = file.name.toLowerCase().endsWith(".mind");

      if (isMindFile) {
        // ── .mind ZIP path ─────────────────────────────────────────────────
        try {
          const arrayBuffer = await file.arrayBuffer();
          const { mmJson, attachmentDataMap } = await loadMindFile(arrayBuffer);
          const json = importMindMeister(mmJson, attachmentDataMap);
          finishLoad(json, true);
        } catch (err) {
          showStatus(state, "Failed to load .mind file: " + err.message, 5000);
        }
      } else {
        // ── Plain JSON path ────────────────────────────────────────────────
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            let json = JSON.parse(evt.target.result);
            let isMindMeister = false;
            if (json.map_version && json.root && json.root.title !== undefined) {
              json = importMindMeister(json);
              isMindMeister = true;
            }
            finishLoad(json, isMindMeister);
          } catch {
            showStatus(state, "Failed to load: invalid JSON file", 4000);
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  }

  async function saveToGist(state) {
    if (!state.currentGistId) {
      saveAsLocalFile(state);
      return;
    }
    if (state.nodes.length === 0) {
      showStatus(state, "Nothing to save");
      return;
    }
    showLoading(state, "Saving mindmap to GitHub...");
    try {
      const mindmapData = mindmapToJson(state);
      const response = await fetch("/api/saveGist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gistId: state.currentGistId,
          files: { "mindmap.json": { content: JSON.stringify(mindmapData, null, 2) } }
        })
      });
      if (!response.ok) {
        let errorMessage = response.statusText;
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch {
          const text = await response.text();
          errorMessage = text.includes("<!DOCTYPE html>")
            ? "Received HTML instead of JSON. API endpoint may not exist."
            : `${text.substring(0, 100)}...`;
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

  // ── input.js ───────────────────────────────────────────────────────────────

  function getCanvasRelativeCoords(state, clientX, clientY) {
    const rect = state.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return { x, y, canvasCoords: toCanvasCoords(state, x, y) };
  }

  function getTouchDistance(e) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

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
    // Switch active map to the one containing the clicked node
    const hitNodeMap = getMapForNode(state, hitNode);
    if (hitNodeMap && hitNodeMap.id !== state.activeMapId) {
      state.activeMapId = hitNodeMap.id;
    }
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
    updatePartButtons(state);
    if (!allowDoubleTapRename) return;
    const now = Date.now();
    if (state.lastTapNode === hitNode && now - state.lastTapTime < 400) {
      showRenameInput(state, hitNode);
    }
    state.lastTapNode = hitNode;
    state.lastTapTime = now;
  }

  function updatePan(state, screenX, screenY) {
    if (!state.isPanning) return;
    state.viewOffsetX = screenX - state.panStartX;
    state.viewOffsetY = screenY - state.panStartY;
    requestDraw(state);
  }

  function handlePointerMove(state, mx, my, touchPadding = 0) {
    state.insertPosition = -1;
    state.potentialParent = null;
    for (const zone of state.nodeZones) {
      if (zone.targetNode === state.draggingNode || zone.parent === state.draggingNode) continue;
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

  function updateDrag(state, mx, my, touchPadding = 0) {
    if (!state.draggingNode) return;
    const dx = mx - state.ghostX;
    const dy = my - state.ghostY;
    if (!state.isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      state.isDragging = true;
      state.showGhostNode = true;
    }
    if (!state.isDragging) return;
    state.ghostX = mx - state.offsetX;
    state.ghostY = my - state.offsetY;
    handlePointerMove(state, mx, my, touchPadding);
    requestDraw(state);
  }

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
        if (originalIndex < adjustedInsertPosition) adjustedInsertPosition -= 1;
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

  function handlePinchZoom(state, e) {
    if (e.touches.length !== 2 || !state.lastTouchDist) return false;
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

  function addNode(state) {
    if (state.nodes.length === 0) {
      const mapId = state.activeMapId || "map_" + Date.now();
      const node = createNode(state, "New node");
      state.nodes.push(node);
      if (state.maps.length === 0) {
        state.maps.push({ id: mapId, name: node.text, rootId: node.id });
        state.activeMapId = mapId;
      }
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
    if (!state.selectedNode) {
      const root = getActiveMapRoot(state) || state.nodes.find((n) => !n.parent);
      if (root) {
        state.selectedNode = root;
        updateDeleteButton(state);
      } else {
        showStatus(state, "Click a node first to add a child");
        return;
      }
    }
    const node = createNode(state, "New node");
    if (state.selectedNode.collapsed) state.selectedNode.collapsed = false;
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

  function deleteNode(state) {
    if (!state.selectedNode) {
      showStatus(state, "Select a node first");
      return;
    }
    // Prevent deleting a map root via the delete button — use Delete Map in the Maps panel
    if (!state.selectedNode.parent) {
      showStatus(state, "To delete an entire map, use the Maps panel (Maps button → trash icon).");
      return;
    }
    // For resolved nodes, capture the linked-reference root BEFORE removing the
    // node so we can write the post-deletion subtree to the registry before
    // autoLayout's resolveLinkedNodes call would otherwise restore it.
    const deletingResolved = !!state.selectedNode.resolvedFromPart;
    const refRoot = deletingResolved ? findLinkedRefRoot(state.selectedNode) : null;
    state.selectedNode.parent.children = state.selectedNode.parent.children.filter(
      (child) => child !== state.selectedNode
    );
    function removeNodeAndDescendants(node) {
      for (const child of [...node.children]) removeNodeAndDescendants(child);
      state.links = state.links.filter((link) => link.from !== node && link.to !== node);
      const nodeIndex = state.nodes.indexOf(node);
      if (nodeIndex > -1) state.nodes.splice(nodeIndex, 1);
    }
    removeNodeAndDescendants(state.selectedNode);
    if (state.focusNodeId === state.selectedNode?.id) state.focusNodeId = null;
    state.selectedNode = null;
    // Sync the registry with the deletion NOW — before autoLayout calls
    // resolveLinkedNodes which would rebuild from the (stale) registry.
    if (refRoot) syncLinkedRefToRegistry(state, refRoot);
    autoLayout(state);
    requestDraw(state);
    updateDeleteButton(state);
    saveToHistory(state);
  }

  function toggleCollapseSelected(state) {
    if (!state.selectedNode) { showStatus(state, "Select a node first"); return; }
    if (state.selectedNode.children.length === 0) { showStatus(state, "Selected node has no children"); return; }
    state.selectedNode.collapsed = !state.selectedNode.collapsed;
    autoLayout(state);
    requestDraw(state);
    saveToHistory(state);
  }

  function togglePinSelected(state) {
    if (!state.selectedNode) { showStatus(state, "Select a node first"); return; }
    state.selectedNode.pinned = !state.selectedNode.pinned;
    autoLayout(state);
    requestDraw(state);
    saveToHistory(state);
  }

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

  function cycleBranchTheme(state) {
    const themes = ["Calm", "Vivid", "Minimal"];
    const idx = themes.indexOf(state.branchTheme);
    state.branchTheme = themes[(idx + 1) % themes.length];
    requestDraw(state);
    saveToHistory(state);
    showStatus(state, `Theme: ${state.branchTheme}`);
  }

  function toggleFocusForNode(state, node) {
    if (!node) return;
    state.focusNodeId = state.focusNodeId === node.id ? null : node.id;
    centerMindmap(state, () => requestDraw(state));
    requestDraw(state);
    showStatus(state, state.focusNodeId ? "Focus mode enabled" : "Focus mode cleared");
  }

  function toggleFocusSelected(state) {
    if (!state.selectedNode) { showStatus(state, "Select a node first"); return; }
    toggleFocusForNode(state, state.selectedNode);
  }

  function clearNodes(state) {
    state.nodes = [];
    state.links = [];
    state.maps = [];
    state.activeMapId = null;
    state.selectedNode = null;
    state.focusNodeId = null;
    requestDraw(state);
    updateDeleteButton(state);
    saveToHistory(state);
    showStatus(state, "Canvas cleared");
  }

  function moveNodeUp(state) {
    if (!state.selectedNode || !state.selectedNode.parent) return;
    const siblings = state.selectedNode.parent.children;
    const idx = siblings.indexOf(state.selectedNode);
    if (idx > 0) {
      [siblings[idx - 1], siblings[idx]] = [siblings[idx], siblings[idx - 1]];
      autoLayout(state);
      requestDraw(state);
      saveToHistory(state);
    }
  }

  function moveNodeDown(state) {
    if (!state.selectedNode || !state.selectedNode.parent) return;
    const siblings = state.selectedNode.parent.children;
    const idx = siblings.indexOf(state.selectedNode);
    if (idx < siblings.length - 1) {
      [siblings[idx], siblings[idx + 1]] = [siblings[idx + 1], siblings[idx]];
      autoLayout(state);
      requestDraw(state);
      saveToHistory(state);
    }
  }

  function showRenameInput(state, node) {
    const scale = state.viewScale;
    node.width = node.calculateWidth();
    const x = node.x * scale + state.viewOffsetX;
    const y = node.y * scale + state.viewOffsetY;
    state.renameInput.style.display = "block";
    state.renameInput.value = node.text;
    state.renameInput.style.left = `${x}px`;
    state.renameInput.style.top = `${y}px`;
    state.renameInput.style.width = `${node.width * scale}px`;
    state.renameInput.style.height = `${40 * scale}px`;
    state.renameInput.style.fontSize = `${14 * scale}px`;
    state.renameInput.style.lineHeight = `${40 * scale}px`;
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
        // Sync map name if this node is a map root
        const nodeMap = getMapForNode(state, node);
        if (nodeMap && nodeMap.rootId === node.id) nodeMap.name = newText;
        // For resolved nodes, write the rename to the registry BEFORE autoLayout
        // so resolveLinkedNodes rebuilds with the new text, not the old one.
        if (node.resolvedFromPart) {
          const refRoot = findLinkedRefRoot(node);
          if (refRoot) syncLinkedRefToRegistry(state, refRoot);
        }
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
   * Returns the image attachment whose drawn rectangle contains the canvas-space
   * point (mx, my), using the same stacking geometry as drawNodeAttachmentImages.
   * Returns null when the point is not over any drawn image.
   */
  function getClickedImageAtt(node, mx, my) {
    if (!node.attachments || node.attachments.length === 0) return null;
    const imageAtts = node.attachments.filter((a) => a.type && a.type.startsWith("image/"));
    if (imageAtts.length === 0) return null;

    const nodeX = Number.isFinite(node.renderX) ? node.renderX : node.x;
    const nodeY = Number.isFinite(node.renderY) ? node.renderY : node.y;
    const TEXT_H = 40;
    const IMG_GAP = 8;
    let stackY = nodeY + TEXT_H + IMG_GAP;

    for (const att of imageAtts) {
      const img = _imgCache.get(att.id);
      if (!img || !img.complete || img.naturalWidth === 0) continue;
      const scale = Math.min(IMG_NODE_MAX_W / img.naturalWidth, IMG_NODE_MAX_H / img.naturalHeight, 1);
      const iw = Math.round(img.naturalWidth * scale);
      const ih = Math.round(img.naturalHeight * scale);
      const ix = nodeX + (node.width - iw) / 2;
      if (mx >= ix && mx <= ix + iw && my >= stackY && my <= stackY + ih) return att;
      stackY += ih + IMG_GAP;
    }
    return null;
  }

  // Returns the file-badge attachment under canvas-space point (mx, my), or null.
  function getClickedFileAtt(node, mx, my) {
    const fileAtts = getNodeFileAtts(node);
    if (fileAtts.length === 0) return null;

    const nodeX = Number.isFinite(node.renderX) ? node.renderX : node.x;
    const nodeY = Number.isFinite(node.renderY) ? node.renderY : node.y;
    const TEXT_H = 40;
    const IMG_GAP = 8;

    let stackY = nodeY + TEXT_H;
    if (node.attachments) {
      const imageAtts = node.attachments.filter((a) => a.type && a.type.startsWith("image/"));
      for (const att of imageAtts) {
        const img = _imgCache.get(att.id);
        if (!img || !img.complete || img.naturalWidth === 0) continue;
        const scale = Math.min(IMG_NODE_MAX_W / img.naturalWidth, IMG_NODE_MAX_H / img.naturalHeight, 1);
        stackY += IMG_GAP + Math.round(img.naturalHeight * scale);
      }
    }
    stackY += FILE_ATTACH_TOP_GAP;

    for (const att of fileAtts) {
      if (mx >= nodeX && mx <= nodeX + node.width && my >= stackY && my <= stackY + FILE_BADGE_H) {
        return att;
      }
      stackY += FILE_BADGE_H + FILE_BADGE_GAP;
    }
    return null;
  }

  // ── Relationship lines ─────────────────────────────────────────────────────

  const REL_COLORS = ["#16a34a", "#22c55e", "#6366f1", "#e11d48", "#d97706", "#0891b2", "#7c3aed", "#475569"];

  function getRelLineBezier(state, rl) {
    const fromNode = state.nodes.find((n) => n.id === rl.fromId);
    const toNode = state.nodes.find((n) => n.id === rl.toId);
    if (!fromNode || !toNode) return null;
    const fp = getNodeRenderPosition(fromNode);
    const tp = getNodeRenderPosition(toNode);
    // Node text-box centers
    const fcx = fp.x + fromNode.width / 2;
    const fcy = fp.y + 20;
    const tcx = tp.x + toNode.width / 2;
    const tcy = tp.y + 20;
    const dx = tcx - fcx, dy = tcy - fcy;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    // Exit edge on fromNode
    let fx, fy;
    if (adx > ady * (fromNode.width / 40)) {
      fx = dx >= 0 ? fp.x + fromNode.width : fp.x;
      fy = fcy;
    } else {
      fx = fcx;
      fy = dy >= 0 ? fp.y + 40 : fp.y;
    }
    // Entry edge on toNode
    let tx, ty;
    if (adx > ady * (toNode.width / 40)) {
      tx = dx >= 0 ? tp.x : tp.x + toNode.width;
      ty = tcy;
    } else {
      tx = tcx;
      ty = dy >= 0 ? tp.y : tp.y + 40;
    }
    // Quadratic bezier control point — arc bows clockwise-perpendicular
    const ldx = tx - fx, ldy = ty - fy;
    const ldist = Math.sqrt(ldx * ldx + ldy * ldy) || 1;
    const arcH = Math.min(ldist * 0.55, 280);
    const cx = (fx + tx) / 2 + (ldy / ldist) * arcH + (rl.cpOffsetX || 0);
    const cy = (fy + ty) / 2 + (-ldx / ldist) * arcH + (rl.cpOffsetY || 0);
    return { fx, fy, cx, cy, tx, ty };
  }

  function getQBezierPoint(t, fx, fy, cx, cy, tx, ty) {
    const mt = 1 - t;
    return { x: mt * mt * fx + 2 * mt * t * cx + t * t * tx,
             y: mt * mt * fy + 2 * mt * t * cy + t * t * ty };
  }

  function drawArrowhead(ctx, tipX, tipY, dirX, dirY, size, color) {
    const len = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
    const ux = dirX / len, uy = dirY / len;
    const px = -uy, py = ux;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * size + px * size * 0.45, tipY - uy * size + py * size * 0.45);
    ctx.lineTo(tipX - ux * size - px * size * 0.45, tipY - uy * size - py * size * 0.45);
    ctx.closePath();
    ctx.fill();
  }

  function drawRelLines(state) {
    if (!state.relLines || state.relLines.length === 0) return;
    state._relLabelRects.clear();
    state._relCtrlPtRects.clear();
    const ctx = state.ctx;
    const ARROW = 10;
    for (const rl of state.relLines) {
      const bz = getRelLineBezier(state, rl);
      if (!bz) continue;
      const { fx, fy, cx, cy, tx, ty } = bz;
      const color = rl.color || "#6366f1";
      const sel = rl.id === state.selectedRelLineId;
      // Solid curved line (like MindMeister relationship lines)
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = sel ? 3 : 2.2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (sel) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.quadraticCurveTo(cx, cy, tx, ty);
      ctx.stroke();
      ctx.restore();
      // Arrowheads (always solid, no dash)
      ctx.save();
      if (sel) { ctx.shadowColor = color; ctx.shadowBlur = 6; }
      if (rl.direction !== "backward") {
        drawArrowhead(ctx, tx, ty, tx - cx, ty - cy, ARROW, color);
      }
      if (rl.direction === "backward" || rl.direction === "both") {
        drawArrowhead(ctx, fx, fy, fx - cx, fy - cy, ARROW, color);
      }
      ctx.restore();
      // Label pill at midpoint if label exists; otherwise just a small invisible hit area
      const mid = getQBezierPoint(0.5, fx, fy, cx, cy, tx, ty);
      const lx = mid.x + (rl.labelOffsetX || 0);
      const ly = mid.y + (rl.labelOffsetY || 0);
      if (rl.label) {
        ctx.save();
        ctx.font = "600 11px Manrope";
        const tw = ctx.measureText(rl.label).width;
        const rw = tw + 18, rh = 22;
        const rx = lx - rw / 2, ry = ly - rh / 2;
        state._relLabelRects.set(rl.id, { x: rx, y: ry, w: rw, h: rh });
        ctx.fillStyle = sel ? color : "#fff";
        drawRoundedRectPath(ctx, rx, ry, rw, rh, 9);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        drawRoundedRectPath(ctx, rx, ry, rw, rh, 9);
        ctx.stroke();
        ctx.fillStyle = sel ? "#fff" : color;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(rl.label, lx, ly);
        ctx.restore();
      } else {
        // No label: invisible hit area along the midpoint of the curve for click/drag
        const HIT = 10;
        state._relLabelRects.set(rl.id, { x: lx - HIT, y: ly - HIT, w: HIT * 2, h: HIT * 2 });
      }
      // When selected: draw a dashed guide line to the control point + a draggable handle circle
      if (sel) {
        const CP_R = 7;
        state._relCtrlPtRects.set(rl.id, { x: cx - CP_R, y: cy - CP_R, w: CP_R * 2, h: CP_R * 2 });
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 4]);
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo((fx + tx) / 2, (fy + ty) / 2);
        ctx.lineTo(cx, cy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#fff";
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(cx, cy, CP_R, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.2;
        ctx.stroke();
        ctx.restore();
      } else {
        state._relCtrlPtRects.delete(rl.id);
      }
    }
  }

  function hitTestRelLabel(state, mx, my) {
    for (const [lineId, r] of state._relLabelRects) {
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
        return (state.relLines || []).find((rl) => rl.id === lineId) || null;
      }
    }
    return null;
  }

  function hitTestRelLine(state, mx, my) {
    const THRESH = 9;
    for (const rl of (state.relLines || [])) {
      const bz = getRelLineBezier(state, rl);
      if (!bz) continue;
      const { fx, fy, cx, cy, tx, ty } = bz;
      for (let t = 0; t <= 1; t += 0.04) {
        const mt = 1 - t;
        const px = mt * mt * fx + 2 * mt * t * cx + t * t * tx;
        const py = mt * mt * fy + 2 * mt * t * cy + t * t * ty;
        if (Math.hypot(px - mx, py - my) < THRESH) return rl;
      }
    }
    return null;
  }

  function hitTestRelCtrlPt(state, mx, my) {
    for (const [lineId, r] of (state._relCtrlPtRects || new Map())) {
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
        return (state.relLines || []).find((rl) => rl.id === lineId) || null;
      }
    }
    return null;
  }

  function startRelLinePickMode(state) {
    if (!state.selectedNode) { showStatus(state, "Select a source node first"); return; }
    // Open the manage panel — from there the user can add new or edit existing relationships
    openRelManagePanel(state);
  }

  function cancelRelLinePickMode(state) {
    state.relLinePickMode = false;
    state.relLineSourceId = null;
    state.relLineMouseX = null;
    state.relLineMouseY = null;
    state.canvas.style.cursor = "";
    requestDraw(state);
  }

  function setupCanvasEvents(state) {
    state.canvas.addEventListener("mousedown", (e) => {
      const { canvasCoords } = getCanvasRelativeCoords(state, e.clientX, e.clientY);
      // Intercept rel label drag before normal node drag
      const hitLabel = hitTestRelLabel(state, canvasCoords.x, canvasCoords.y);
      if (hitLabel) {
        state.draggingRelLabel = {
          lineId: hitLabel.id,
          startMX: canvasCoords.x,
          startMY: canvasCoords.y,
          origOffsetX: hitLabel.labelOffsetX || 0,
          origOffsetY: hitLabel.labelOffsetY || 0
        };
        return;
      }
      // Check control-point handle drag (only visible when a line is selected)
      const hitCtrlPt = hitTestRelCtrlPt(state, canvasCoords.x, canvasCoords.y);
      if (hitCtrlPt) {
        state.draggingRelLine = {
          lineId: hitCtrlPt.id,
          startMX: canvasCoords.x,
          startMY: canvasCoords.y,
          origCpOffsetX: hitCtrlPt.cpOffsetX || 0,
          origCpOffsetY: hitCtrlPt.cpOffsetY || 0,
          moved: false
        };
        state._relLineDragMoved = false;
        return;
      }
      // Check dragging the line body itself to reshape it
      const hitLineBody = hitTestRelLine(state, canvasCoords.x, canvasCoords.y);
      if (hitLineBody) {
        state.draggingRelLine = {
          lineId: hitLineBody.id,
          startMX: canvasCoords.x,
          startMY: canvasCoords.y,
          origCpOffsetX: hitLineBody.cpOffsetX || 0,
          origCpOffsetY: hitLineBody.cpOffsetY || 0,
          moved: false
        };
        state._relLineDragMoved = false;
        return;
      }
      beginInteraction(state, e.clientX, e.clientY, canvasCoords.x, canvasCoords.y);
    });
    state.canvas.addEventListener("mousemove", (e) => {
      const { canvasCoords } = getCanvasRelativeCoords(state, e.clientX, e.clientY);
      // Rel label drag
      if (state.draggingRelLabel) {
        const drl = state.draggingRelLabel;
        const rl = (state.relLines || []).find((r) => r.id === drl.lineId);
        if (rl) {
          rl.labelOffsetX = drl.origOffsetX + (canvasCoords.x - drl.startMX);
          rl.labelOffsetY = drl.origOffsetY + (canvasCoords.y - drl.startMY);
          requestDraw(state);
        }
        return;
      }
      // Rel line control-point drag
      if (state.draggingRelLine) {
        const drl = state.draggingRelLine;
        const rl = (state.relLines || []).find((r) => r.id === drl.lineId);
        if (rl) {
          rl.cpOffsetX = drl.origCpOffsetX + (canvasCoords.x - drl.startMX);
          rl.cpOffsetY = drl.origCpOffsetY + (canvasCoords.y - drl.startMY);
          if (Math.hypot(canvasCoords.x - drl.startMX, canvasCoords.y - drl.startMY) > 4) {
            drl.moved = true;
            state._relLineDragMoved = true;
          }
          state.canvas.style.cursor = "grabbing";
          requestDraw(state);
        }
        return;
      }
      updatePan(state, e.clientX, e.clientY);
      updateDrag(state, canvasCoords.x, canvasCoords.y);
      if (state.relLinePickMode) {
        state.relLineMouseX = canvasCoords.x;
        state.relLineMouseY = canvasCoords.y;
        requestDraw(state);
      }
      if (!state.isDragging) {
        if (state.relLinePickMode) {
          state.canvas.style.cursor = "crosshair";
        } else {
          const hoverNode = findNodeAt(state, canvasCoords.x, canvasCoords.y);
          const overRelLabel = !hoverNode ? hitTestRelLabel(state, canvasCoords.x, canvasCoords.y) : null;
          const overRelLine = !hoverNode && !overRelLabel ? hitTestRelLine(state, canvasCoords.x, canvasCoords.y) : null;
          const overCtrlPt = !hoverNode && !overRelLabel ? hitTestRelCtrlPt(state, canvasCoords.x, canvasCoords.y) : null;
          const overImg = hoverNode ? getClickedImageAtt(hoverNode, canvasCoords.x, canvasCoords.y) : null;
          const overFile = !overImg && hoverNode ? getClickedFileAtt(hoverNode, canvasCoords.x, canvasCoords.y) : null;
          state.canvas.style.cursor = overCtrlPt ? "grab" : (overRelLabel || overRelLine) ? "pointer" : (overImg || overFile) ? (overImg ? "zoom-in" : "pointer") : "";
        }
      }
    });
    state.canvas.addEventListener("mouseup", () => {
      state.isPanning = false;
      if (state.draggingRelLabel) {
        state.draggingRelLabel = null;
        saveToHistory(state);
        return;
      }
      if (state.draggingRelLine) {
        const moved = state.draggingRelLine.moved;
        state.draggingRelLine = null;
        if (moved) {
          saveToHistory(state);
          state.lastDragEndAt = Date.now();
        }
        state.canvas.style.cursor = "";
        return;
      }
      completeDrag(state);
    });
    state.canvas.addEventListener("click", (e) => {
      if (Date.now() - state.lastDragEndAt < 150) return;
      if (state._relLineDragMoved) { state._relLineDragMoved = false; return; }
      const { canvasCoords } = getCanvasRelativeCoords(state, e.clientX, e.clientY);
      // Pick mode: user clicked to select target node
      if (state.relLinePickMode) {
        const tgt = findNodeAt(state, canvasCoords.x, canvasCoords.y);
        const sourceId = state.relLineSourceId; // capture before cancel clears it
        cancelRelLinePickMode(state);
        if (tgt && tgt.id !== sourceId) {
          openRelPanel(state, { isNew: true, fromId: sourceId, toId: tgt.id });
        }
        return;
      }
      // Relationship line label/line click
      const hitRelLabel = hitTestRelLabel(state, canvasCoords.x, canvasCoords.y);
      const hitRelLine = !hitRelLabel ? hitTestRelLine(state, canvasCoords.x, canvasCoords.y) : null;
      if (hitRelLabel || hitRelLine) {
        const rl = hitRelLabel || hitRelLine;
        state.selectedRelLineId = rl.id;
        openRelPanel(state, { isNew: false, rl });
        requestDraw(state);
        return;
      }
      state.selectedRelLineId = null;
      const hitNode = findNodeAt(state, canvasCoords.x, canvasCoords.y);
      if (!hitNode) {
        state.selectedNode = null;
        updateDeleteButton(state);
        requestDraw(state);
        closeRelPanel(state);
        const attachPanel = document.getElementById("attachPanel");
        if (attachPanel) { attachPanel.classList.remove("visible"); if (state.attachBtn) state.attachBtn.classList.remove("active"); }
        updatePartButtons(state);
        return;
      }
      // If the click landed on a drawn image attachment, open the lightbox.
      const clickedAtt = getClickedImageAtt(hitNode, canvasCoords.x, canvasCoords.y);
      if (clickedAtt) {
        state.selectedNode = hitNode;
        updateDeleteButton(state);
        requestDraw(state);
        openAttachLightbox(clickedAtt);
        return;
      }
      // If the click landed on a file badge, download/open that file.
      const clickedFile = getClickedFileAtt(hitNode, canvasCoords.x, canvasCoords.y);
      if (clickedFile) {
        state.selectedNode = hitNode;
        updateDeleteButton(state);
        requestDraw(state);
        if (clickedFile.data) {
          downloadAttachment(clickedFile);
        } else if (clickedFile.url) {
          window.open(clickedFile.url, "_blank", "noopener");
        }
        return;
      }
      state.selectedNode = hitNode;
      updateDeleteButton(state);
      requestDraw(state);
      refreshAttachPanelIfOpen(state);
      refreshNotePanelIfOpen(state);
      updatePartButtons(state);
    });
    state.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const zoomAmount = -e.deltaY * 0.001;
        const { canvasCoords } = getCanvasRelativeCoords(state, e.clientX, e.clientY);
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
        if (handlePinchZoom(state, e)) return;
        if (e.touches.length === 0) return;
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
      if (hitNode) showRenameInput(state, hitNode);
    });
    window.addEventListener("resize", () => {
      setCanvasSize(state);
      requestDraw(state);
    });
  }

  function setupToolbar(state) {
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

  function setupKeyboardShortcuts(state) {
    document.addEventListener("keydown", (e) => {
      const targetTag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "";
      const typing = targetTag === "input" || targetTag === "textarea" || e.target.isContentEditable;
      if (typing) return;
      if (e.key === "Escape") { if (state.relLinePickMode) { cancelRelLinePickMode(state); e.preventDefault(); return; } }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(state); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteNode(state); return; }
      if (e.key.toLowerCase() === "n") { e.preventDefault(); addNode(state); return; }
      if (e.key.toLowerCase() === "c") { e.preventDefault(); centerMindmap(state, () => requestDraw(state)); return; }
      if (e.key.toLowerCase() === "l") { e.preventDefault(); cycleLayoutMode(state); return; }
      if (e.key.toLowerCase() === "f") { e.preventDefault(); toggleFocusSelected(state); return; }
      if (e.key.toLowerCase() === "p") { e.preventDefault(); togglePinSelected(state); return; }
      if (e.key.toLowerCase() === "x") { e.preventDefault(); toggleCollapseSelected(state); return; }
      if (e.key.toLowerCase() === "t") { e.preventDefault(); cycleBranchTheme(state); }
      if (e.key.toLowerCase() === "o") { e.preventDefault(); toggleNotePanel(state); }
      if (e.key.toLowerCase() === "r") { e.preventDefault(); startRelLinePickMode(state); }
    });
  }

  // ── Attachment panel ────────────────────────────────────────────────────────

  const ATTACH_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function getFileExt(name) {
    const parts = name.split(".");
    return parts.length > 1 ? parts[parts.length - 1].toUpperCase().slice(0, 4) : "FILE";
  }

  function isImageType(type) {
    return type && type.startsWith("image/");
  }

  function openAttachLightbox(att) {
    const lb = document.getElementById("attachLightbox");
    const img = document.getElementById("attachLightboxImg");
    const fname = document.getElementById("attachLightboxFilename");
    if (!lb || !img) return;
    img.src = att.data;
    img.alt = att.name;
    if (fname) fname.textContent = att.name;
    lb.classList.add("visible");
  }

  function closeAttachLightbox() {
    const lb = document.getElementById("attachLightbox");
    if (lb) lb.classList.remove("visible");
  }

  function downloadAttachment(att) {
    const a = document.createElement("a");
    a.href = att.data;
    a.download = att.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function renderAttachList(state) {
    const listEl = document.getElementById("attachList");
    if (!listEl) return;
    const node = state.selectedNode;
    const atts = (node && node.attachments) ? node.attachments : [];
    if (atts.length === 0) {
      listEl.innerHTML = "<div class=\"attach-empty\">No attachments yet.</div>";
      return;
    }
    listEl.innerHTML = "";
    for (const att of atts) {
      const item = document.createElement("div");
      item.className = "attach-item";
      // Thumbnail or icon
      let thumbHtml;
      if (isImageType(att.type)) {
        thumbHtml = `<img class="attach-item-thumb" src="${escHtml(att.data)}" alt="${escHtml(att.name)}" />`;
      } else {
        thumbHtml = `<div class="attach-item-icon">${escHtml(getFileExt(att.name))}</div>`;
      }
      item.innerHTML = `
        ${thumbHtml}
        <div class="attach-item-info">
          <div class="attach-item-name" title="${escHtml(att.name)}">${escHtml(att.name)}</div>
          <div class="attach-item-size">${att.size != null ? formatBytes(att.size) : ""}</div>
        </div>
        <div class="attach-item-actions">
          <button class="attach-view-btn" data-id="${escHtml(att.id)}" aria-label="View" title="View / Download"${(att.data || att.url) ? "" : " disabled"}>
            <svg viewBox="0 0 24 24" fill="none" width="13" height="13"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/></svg>
          </button>
          <button class="attach-remove-btn" data-id="${escHtml(att.id)}" aria-label="Remove">
            <svg viewBox="0 0 24 24" fill="none" width="12" height="12"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
          </button>
        </div>`;
      listEl.appendChild(item);
    }
    // Bind view and remove
    listEl.querySelectorAll(".attach-view-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const att = (node.attachments || []).find((a) => a.id === id);
        if (!att) return;
        if (isImageType(att.type)) {
          openAttachLightbox(att);
        } else if (att.data) {
          downloadAttachment(att);
        } else if (att.url) {
          window.open(att.url, "_blank", "noopener");
        }
      });
    });
    listEl.querySelectorAll(".attach-remove-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        if (!node) return;
        _imgCache.delete(id);
        _dropAttach(id);  // remove from localStorage + IDB
        node.attachments = (node.attachments || []).filter((a) => a.id !== id);
        renderAttachList(state);
        requestDraw(state);
        saveToHistory(state);
      });
    });
  }

  function handleAttachFiles(state, files) {
    const node = state.selectedNode;
    if (!node) return;
    let added = 0;
    let skipped = 0;
    const process = (file) => new Promise((resolve) => {
      if (file.size > ATTACH_MAX_BYTES) {
        skipped++;
        resolve();
        return;
      }
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (!node.attachments) node.attachments = [];
        const att = {
          id: "att_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          data: evt.target.result
        };
        node.attachments.push(att);
        _persistAttach(att.id, att.data);  // persist to localStorage (falls back to IDB for large files)
        added++;
        resolve();
      };
      reader.readAsDataURL(file);
    });
    Promise.all(Array.from(files).map(process)).then(() => {
      renderAttachList(state);
      requestDraw(state);
      saveToHistory(state);
      if (skipped > 0) {
        showStatus(state, `${skipped} file(s) skipped — exceeds 25 MB limit`);
      } else if (added > 0) {
        showStatus(state, `${added} attachment(s) added`);
      }
    });
  }

  function setupAttachPanel(state) {
    const panel = document.getElementById("attachPanel");
    const closeBtn = document.getElementById("attachPanelClose");
    const fileInput = document.getElementById("attachFileInput");
    const dropZone = document.getElementById("attachDropZone");
    const lbClose = document.getElementById("attachLightboxClose");
    const lbBackdrop = document.getElementById("attachLightboxBackdrop");
    if (!panel) return;

    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        panel.classList.remove("visible");
        if (state.attachBtn) state.attachBtn.classList.remove("active");
      });
    }
    if (fileInput) {
      fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files.length > 0) {
          handleAttachFiles(state, fileInput.files);
          fileInput.value = "";
        }
      });
    }
    if (dropZone) {
      dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
      });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
      dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer && e.dataTransfer.files.length > 0) {
          handleAttachFiles(state, e.dataTransfer.files);
        }
      });
    }
    if (lbClose) lbClose.addEventListener("click", closeAttachLightbox);
    if (lbBackdrop) lbBackdrop.addEventListener("click", closeAttachLightbox);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAttachLightbox();
    });
  }

  function toggleAttachPanel(state) {
    const panel = document.getElementById("attachPanel");
    if (!panel) return;
    const node = state.selectedNode;
    if (!node) { showStatus(state, "Select a node first"); return; }
    const isOpen = panel.classList.contains("visible");
    if (isOpen) {
      panel.classList.remove("visible");
      if (state.attachBtn) state.attachBtn.classList.remove("active");
    } else {
      const title = document.getElementById("attachPanelTitle");
      if (title) title.textContent = `Attachments — ${node.text}`;
      renderAttachList(state);
      panel.classList.add("visible");
      if (state.attachBtn) state.attachBtn.classList.add("active");
    }
  }

  function refreshAttachPanelIfOpen(state) {
    const panel = document.getElementById("attachPanel");
    if (panel && panel.classList.contains("visible")) {
      const node = state.selectedNode;
      const title = document.getElementById("attachPanelTitle");
      if (title && node) title.textContent = `Attachments — ${node.text}`;
      renderAttachList(state);
    }
  }

  function refreshNotePanelIfOpen(state) {
    const panel = document.getElementById("notePanel");
    if (!panel || !panel.classList.contains("visible")) return;
    const node = state.selectedNode;
    if (!node) { closeNotePanel(state); return; }
    const title = document.getElementById("notePanelTitle");
    const editor = document.getElementById("noteEditor");
    if (title) title.textContent = node.text.length > 28 ? node.text.slice(0, 28) + "\u2026" : node.text;
    if (editor) editor.innerHTML = node.note || "";
    renderNodeLinks(state);
  }

  function bindControls(state) {
    if (state.addBtn) state.addBtn.addEventListener("click", () => addNode(state));
    if (state.deleteBtn) state.deleteBtn.addEventListener("click", () => deleteNode(state));
    state.centerBtn.addEventListener("click", () => centerMindmap(state, () => requestDraw(state)));
    state.undoBtn.addEventListener("click", () => undo(state));
    state.clearBtn.addEventListener("click", () => clearNodes(state));
    state.saveBtn.addEventListener("click", () => saveToGist(state));
    if (state.loadBtn) state.loadBtn.addEventListener("click", () => loadFromFile(state));
    if (state.collapseBtn) state.collapseBtn.addEventListener("click", () => toggleCollapseSelected(state));
    if (state.focusBtn) state.focusBtn.addEventListener("click", () => toggleFocusSelected(state));
    if (state.layoutBtn) state.layoutBtn.addEventListener("click", () => cycleLayoutMode(state));
    if (state.pinBtn) state.pinBtn.addEventListener("click", () => togglePinSelected(state));
    if (state.themeBtn) state.themeBtn.addEventListener("click", () => cycleBranchTheme(state));
    if (state.savePartBtn) state.savePartBtn.addEventListener("click", () => saveAsGlobalPart(state));
    if (state.pushPartBtn) state.pushPartBtn.addEventListener("click", () => pushPartUpdate(state));
    if (state.partsBtn) state.partsBtn.addEventListener("click", () => togglePartsPanel(state));
    if (state.pinRefBtn) state.pinRefBtn.addEventListener("click", () => pinRefInstance(state));
    if (state.tagBtn) state.tagBtn.addEventListener("click", () => toggleTagPanel(state));
    if (state.attachBtn) state.attachBtn.addEventListener("click", () => toggleAttachPanel(state));
    if (state.noteBtn) state.noteBtn.addEventListener("click", () => toggleNotePanel(state));
    if (state.relLinkBtn) state.relLinkBtn.addEventListener("click", () => startRelLinePickMode(state));
    if (state.toolbarMinBtn) {
      state.toolbarMinBtn.addEventListener("click", () => {
        state.toolbar.classList.add("minimized");
        if (state.toolbarRevealBtn) state.toolbarRevealBtn.classList.add("visible");
      });
    }
    if (state.toolbarRevealBtn) {
      state.toolbarRevealBtn.addEventListener("click", () => {
        state.toolbar.classList.remove("minimized");
        state.toolbarRevealBtn.classList.remove("visible");
      });
    }
    if (state.newMapBtn) state.newMapBtn.addEventListener("click", () => addNewMap(state));
    if (state.mapsBtn) state.mapsBtn.addEventListener("click", () => toggleMapsPanel(state));
    state.reorderUp.addEventListener("click", () => moveNodeUp(state));
    state.reorderDown.addEventListener("click", () => moveNodeDown(state));
    window.moveNodeUp = () => moveNodeUp(state);
    window.moveNodeDown = () => moveNodeDown(state);
  }

  // Migrate legacy single-key autosave → per-map storage (runs once on first load)
  function migrateOldAutosave() {
    if (!canUseLocalStorage()) return;
    try {
      const oldRaw = window.localStorage.getItem(AUTOSAVE_STORAGE_KEY);
      if (!oldRaw) return;
      const oldDoc = JSON.parse(oldRaw);
      if (!oldDoc || !oldDoc.mindmap) return;
      const maps = oldDoc.mindmap.maps || [];
      if (maps.length === 0) return;
      for (const mapData of maps) {
        const singleDoc = {
          version: oldDoc.version,
          savedAt: oldDoc.savedAt,
          gistId: oldDoc.gistId || null,
          mindmap: {
            maps: [mapData],
            activeMapId: mapData.id,
            layoutMode: oldDoc.mindmap.layoutMode,
            branchTheme: oldDoc.mindmap.branchTheme,
            viewScale: oldDoc.mindmap.viewScale,
            viewOffsetX: oldDoc.mindmap.viewOffsetX,
            viewOffsetY: oldDoc.mindmap.viewOffsetY
          }
        };
        window.localStorage.setItem(mapStorageKey(mapData.id), JSON.stringify(singleDoc));
        updateRegistryEntry(mapData.id, mapData.name || "Map");
      }
      window.localStorage.removeItem(AUTOSAVE_STORAGE_KEY);
    } catch {}
  }

  function initializeFromQuery(state) {
    setupAttachPanel(state);
    migrateOldAutosave();
    const urlParams = new URLSearchParams(window.location.search);
    const gistId = urlParams.get("gistId");
    if (gistId) { loadFromGist(state, gistId); return; }

    let mapId = urlParams.get("map");
    if (!mapId) {
      // No map in URL — redirect to first registered map, or create a default
      const registry = readRegistry();
      if (registry.length > 0) {
        window.location.href = "?map=" + registry[0].id;
        return;
      }
      mapId = "map_" + Date.now();
      history.replaceState(null, "", "?map=" + mapId);
    }

    state.activeMapId = mapId;
    if (recoverFromAutosave(state)) return;

    // No autosave for this map ID — create fresh content
    const registry = readRegistry();
    const entry = registry.find((m) => m.id === mapId);
    const mapName = entry ? entry.name : "My Mindmap";
    const rootNode = createNode(state, mapName);
    state.nodes.push(rootNode);
    state.maps = [{ id: mapId, name: mapName, rootId: rootNode.id }];
    state.activeMapId = mapId;
    state.selectedNode = rootNode;
    updateRegistryEntry(mapId, mapName);
    document.title = mapName + " — Mindmap Tool";
    autoLayout(state);
    centerMindmap(state, () => requestDraw(state));
    saveToHistory(state);
    state.history = [state.history[state.history.length - 1]];
    setUnsavedChanges(state, false);
    updateDeleteButton(state);
  }

  // ── global-map-parts ────────────────────────────────────────────────────────

  const GLOBAL_PARTS_KEY = "mindmap.globalParts.v1";

  function loadGlobalParts() {
    try {
      if (!canUseLocalStorage()) return {};
      const raw = window.localStorage.getItem(GLOBAL_PARTS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  function saveGlobalPartsToStorage(parts) {
    if (!canUseLocalStorage()) return;
    // Strip attachment data from global parts before saving — image data URLs can
    // be hundreds of KB each and easily blow the localStorage quota.  Attachment
    // data is persisted separately under mindmap.att.<id> (same as map autosaves).
    // _persistAttach calls are done BEFORE the try block so a quota error on the
    // attachment key does not silently abort the GLOBAL_PARTS_KEY write.
    function persistSubtreeAttachments(node) {
      if (node.attachments) {
        for (const att of node.attachments) {
          if (att.data) _persistAttach(att.id, att.data);
        }
      }
      for (const child of (node.children || [])) persistSubtreeAttachments(child);
    }
    function stripSubtree(node) {
      return {
        text: node.text,
        attachments: (node.attachments && node.attachments.length > 0)
          ? node.attachments.map((att) => ({ id: att.id, type: att.type, name: att.name, size: att.size }))
          : node.attachments,
        children: (node.children || []).map(stripSubtree)
      };
    }
    // Persist all attachment data first (outside the try so a quota error there
    // does not prevent the registry JSON from being written).
    for (const part of Object.values(parts)) {
      if (part.subtree) persistSubtreeAttachments(part.subtree);
    }
    try {
      const stripped = {};
      for (const [id, part] of Object.entries(parts)) {
        stripped[id] = Object.assign({}, part, {
          subtree: part.subtree ? stripSubtree(part.subtree) : part.subtree
        });
      }
      window.localStorage.setItem(GLOBAL_PARTS_KEY, JSON.stringify(stripped));
    } catch {}
  }

  // Build a plain-object subtree from a node (excludes resolved children)
  function buildSubtree(node) {
    return {
      text: node.text,
      attachments: (node.attachments && node.attachments.length > 0) ? node.attachments : undefined,
      children: node.children
        .filter((c) => !c.resolvedFromPart)
        .map((c) => buildSubtree(c))
    };
  }

  // Build subtree from ALL children (for pinned snapshot)
  // For SOURCE pushes: excludes resolvedFromPart children so the registry only
  // stores user-authored content (avoids capturing stale resolved nodes).
  function buildSubtreeAll(node) {
    return {
      text: node.text,
      attachments: (node.attachments && node.attachments.length > 0) ? node.attachments : undefined,
      children: node.children.filter((c) => !c.resolvedFromPart).map((c) => buildSubtreeAll(c))
    };
  }

  // For REFERENCE pushes: includes ALL children (resolved ones ARE the canonical
  // content the user is promoting — filtering them would empty the registry).
  function buildSubtreeAllRaw(node) {
    return {
      text: node.text,
      attachments: (node.attachments && node.attachments.length > 0) ? node.attachments : undefined,
      children: node.children.map((c) => buildSubtreeAllRaw(c))
    };
  }

  function createNodesFromPartData(state, nodeData, parent) {
    const node = createNode(state, nodeData.text);
    node.parent = parent;
    node.resolvedFromPart = true;
    if (nodeData.attachments && nodeData.attachments.length > 0) {
      node.attachments = nodeData.attachments;
      // Ensure attachment data is persisted so images survive refresh
      for (const att of node.attachments) {
        if (att.data) _persistAttach(att.id, att.data);
      }
    }
    state.nodes.push(node);
    if (parent) {
      parent.children.push(node);
      state.links.push({ from: parent, to: node });
    }
    for (const childData of (nodeData.children || [])) {
      createNodesFromPartData(state, childData, node);
    }
    return node;
  }

  function removeSubtreeFromState(state, node) {
    for (const child of [...node.children]) {
      removeSubtreeFromState(state, child);
    }
    state.links = state.links.filter((l) => l.from !== node && l.to !== node);
    const idx = state.nodes.indexOf(node);
    if (idx > -1) state.nodes.splice(idx, 1);
  }

  function resolveLinkedNodes(state) {
    // Collect attachments added by the user to resolved nodes (keyed by node text),
    // so they survive the tear-down/rebuild cycle that happens on every autoLayout.
    function collectResolvedAttachments(nodes) {
      const map = new Map(); // text -> attachments[]
      function walk(n) {
        if (n.attachments && n.attachments.length > 0) {
          const existing = map.get(n.text);
          if (existing) {
            // Merge, deduplicate by id
            const ids = new Set(existing.map((a) => a.id));
            for (const a of n.attachments) { if (!ids.has(a.id)) existing.push(a); }
          } else {
            map.set(n.text, [...n.attachments]);
          }
        }
        for (const child of n.children) walk(child);
      }
      for (const n of nodes) walk(n);
      return map;
    }

    // After rebuilding, merge saved attachments back into the new resolved nodes.
    // If a saved attachment has the same ID as one already on the node (stripped
    // version from the registry), REPLACE it — the saved copy has the full data.
    function mergeResolvedAttachments(nodes, savedMap) {
      function walk(n) {
        if (savedMap.has(n.text)) {
          const saved = savedMap.get(n.text);
          if (!n.attachments) n.attachments = [];
          for (const a of saved) {
            const idx = n.attachments.findIndex((x) => x.id === a.id);
            if (idx >= 0) {
              // Replace the stripped registry version with the full-data version.
              n.attachments[idx] = a;
            } else {
              n.attachments.push(a);
            }
          }
        }
        for (const child of n.children) walk(child);
      }
      for (const n of nodes) walk(n);
    }

    const parts = loadGlobalParts();

    // Cleanup: source nodes are user-authoritative. If any of their children were
    // incorrectly flagged as resolvedFromPart (by the old duplicate bug), DEMOTE
    // them back to regular user-authored children — never delete them, because they
    // ARE the canonical content (e.g. Jack, Cold Showers on the Healthy Living source).
    function demoteResolvedSubtree(node) {
      node.resolvedFromPart = false;
      for (const child of node.children) demoteResolvedSubtree(child);
    }
    for (const node of state.nodes) {
      if (node.isGlobalPartSource) {
        for (const child of node.children) {
          if (child.resolvedFromPart) demoteResolvedSubtree(child);
        }
      }
    }

    // Skip nodes that ARE the Global Part source — their children are user-authored
    // and must never have resolved children injected alongside them.
    const linkedNodes = state.nodes.filter((n) => n.linkedPartId && !n.isGlobalPartSource);
    for (const node of linkedNodes) {
      const resolvedChildren = node.children.filter((c) => c.resolvedFromPart);
      // Save user-added attachments before tearing down
      const savedAttachments = collectResolvedAttachments(resolvedChildren);
      // Track the selected node so we can re-point after rebuild
      const selectedWasResolved = state.selectedNode && resolvedChildren.some(
        (c) => c === state.selectedNode || c.children.some(function findIn(n) {
          return n === state.selectedNode || n.children.some(findIn);
        })
      );
      const selectedText = selectedWasResolved && state.selectedNode ? state.selectedNode.text : null;
      // Before teardown: extract user-authored children from resolved nodes so
      // removeSubtreeFromState can't delete them.  We'll re-attach them after
      // the resolved subtree is rebuilt from the registry.
      // Map: resolvedNode.text → [user-authored direct children of that node]
      const savedUserChildren = new Map();
      function extractUserChildren(resolvedNode) {
        const userKids = resolvedNode.children.filter((c) => !c.resolvedFromPart);
        if (userKids.length > 0) {
          if (!savedUserChildren.has(resolvedNode.text)) savedUserChildren.set(resolvedNode.text, []);
          for (const k of userKids) savedUserChildren.get(resolvedNode.text).push(k);
          // Detach so removeSubtreeFromState does not recurse into them
          resolvedNode.children = resolvedNode.children.filter((c) => c.resolvedFromPart);
        }
        for (const child of resolvedNode.children) extractUserChildren(child);
      }
      for (const rc of resolvedChildren) extractUserChildren(rc);
      for (const child of resolvedChildren) removeSubtreeFromState(state, child);
      node.children = node.children.filter((c) => !c.resolvedFromPart);
      // Pinned instances use their stored snapshot; live instances use the registry
      let subtreeData;
      if (node.instanceState === "pinned" && node.pinnedSnapshot) {
        subtreeData = node.pinnedSnapshot;
      } else {
        const part = parts[node.linkedPartId];
        if (!part) continue;
        subtreeData = part.subtree;
      }
      for (const childData of (subtreeData.children || [])) {
        createNodesFromPartData(state, childData, node);
      }
      // Dedup: if a user-added child has the same text as a freshly resolved child,
      // remove the user-added copy. This handles the case where a child was saved as
      // user-authored on a reference node (e.g. Frost on Sports) and the registry
      // now also supplies the same child — preventing the "1.1 Frost / 1.2 Frost" duplicate.
      const resolvedTexts = new Set(node.children.filter((c) => c.resolvedFromPart).map((c) => c.text));
      const userDups = node.children.filter((c) => !c.resolvedFromPart && resolvedTexts.has(c.text));
      for (const dup of userDups) removeSubtreeFromState(state, dup);
      node.children = node.children.filter((c) => c.resolvedFromPart || !resolvedTexts.has(c.text));
      // Restore user-added attachments into the newly created resolved nodes
      if (savedAttachments.size > 0) {
        const newResolved = node.children.filter((c) => c.resolvedFromPart);
        mergeResolvedAttachments(newResolved, savedAttachments);
      }
      // Re-attach user-authored children that were detached before teardown
      if (savedUserChildren.size > 0) {
        function reattachUserChildren(resolvedNode) {
          const userKids = savedUserChildren.get(resolvedNode.text);
          if (userKids) {
            for (const kid of userKids) {
              kid.parent = resolvedNode;
              resolvedNode.children.push(kid);
              state.links.push({ from: resolvedNode, to: kid });
              // kid and its subtree are already in state.nodes (they were detached,
              // not removed from state), so no push to state.nodes is needed.
            }
          }
          for (const child of resolvedNode.children.filter((c) => c.resolvedFromPart)) {
            reattachUserChildren(child);
          }
        }
        for (const nr of node.children.filter((c) => c.resolvedFromPart)) {
          reattachUserChildren(nr);
        }
      }
      // Re-point selectedNode to the new counterpart (matched by text)
      if (selectedText !== null) {
        function findByText(nodes, text) {
          for (const n of nodes) {
            if (n.text === text) return n;
            const found = findByText(n.children, text);
            if (found) return found;
          }
          return null;
        }
        const newSel = findByText(node.children.filter((c) => c.resolvedFromPart), selectedText);
        if (newSel) state.selectedNode = newSel;
      }
    }
  }

  // Returns { live, pinned, total, nodes } for dependency tracking
  function getPartDependencies(state, partId) {
    const refs = state.nodes.filter((n) => n.linkedPartId === partId);
    const live = refs.filter((n) => n.instanceState !== "pinned");
    const pinned = refs.filter((n) => n.instanceState === "pinned");
    return { live: live.length, pinned: pinned.length, total: refs.length, nodes: refs };
  }

  function getNodeBreadcrumb(node) {
    const parts = [];
    let cur = node;
    while (cur) { parts.unshift(cur.text); cur = cur.parent; }
    return parts.join(" › ");
  }

  // Walks up the parent chain from node and returns the nearest ancestor (or
  // self) that is a live linked-part reference (has linkedPartId, is not a
  // source, and is not pinned). Returns null if none is found.
  function findLinkedRefRoot(node) {
    let cur = node;
    while (cur) {
      if (cur.linkedPartId && !cur.isGlobalPartSource && cur.instanceState !== "pinned") return cur;
      cur = cur.parent;
    }
    return null;
  }

  // Writes the current subtree of refNode to the registry immediately — BEFORE
  // autoLayout runs — so that resolveLinkedNodes reads the up-to-date registry
  // instead of restoring the stale version (e.g. bringing back a just-deleted node).
  // Also marks the entire subtree as resolvedFromPart so the subsequent
  // resolveLinkedNodes rebuild produces no duplicates.
  function syncLinkedRefToRegistry(state, refNode) {
    const partId = refNode.linkedPartId;
    if (!partId || refNode.instanceState === "pinned") return;
    const parts = loadGlobalParts();
    if (!parts[partId]) return;
    parts[partId].subtree = buildSubtreeAllRaw(refNode);
    parts[partId].updatedAt = Date.now();
    saveGlobalPartsToStorage(parts);
    function markResolved(n) { n.resolvedFromPart = true; n.children.forEach(markResolved); }
    refNode.children.forEach(markResolved);
  }

  // Silently syncs global-part changes to the registry whenever a source or
  // reference node's subtree is modified. Called automatically at the end of
  // saveToHistory so any add / attachment-change propagates to every live reference
  // (in the same tab immediately; other tabs receive the storage event).
  // Delete and rename use syncLinkedRefToRegistry directly (before autoLayout)
  // so they are already handled by the time this function runs.
  function autoSyncGlobalParts(state) {
    const parts = loadGlobalParts();
    if (Object.keys(parts).length === 0) return;
    let anyChanged = false;

    // Shape comparison includes text, attachment IDs (not data), and children
    // recursively. Attachment data URLs are excluded to avoid false positives
    // from reinflateAttachments.
    function shapeOf(node) {
      const attIds = (node.attachments || []).map((a) => a.id).join(",");
      const kids = (node.children || []).map(shapeOf).join("|");
      return node.text + (attIds ? "{" + attIds + "}" : "") + (kids ? "[" + kids + "]" : "");
    }

    // Recursively marks a node and its ENTIRE subtree as resolvedFromPart = true
    // so that resolveLinkedNodes teardown + rebuild runs cleanly with no duplicates.
    function markResolved(node) {
      node.resolvedFromPart = true;
      node.children.forEach(markResolved);
    }

    // 1. Sync from SOURCE nodes — user-authored children are always canonical.
    for (const sourceNode of state.nodes) {
      if (!sourceNode.isGlobalPartSource || sourceNode.resolvedFromPart) continue;
      const partId = sourceNode.isGlobalPartSource;
      if (!parts[partId]) continue;
      const newSubtree = buildSubtreeAll(sourceNode);
      if (shapeOf(parts[partId].subtree) !== shapeOf(newSubtree)) {
        parts[partId].subtree = newSubtree;
        parts[partId].updatedAt = Date.now();
        anyChanged = true;
      }
    }

    // 2. Sync from REFERENCE nodes whose live children differ from the registry.
    //    Compares only the children subtree (not the reference root's own text)
    //    so that user-renamed reference labels don't cause spurious syncs.
    //    Covers: new child nodes added at any depth, attachment add/remove on any
    //    resolved node. Delete and rename are handled by syncLinkedRefToRegistry
    //    (pre-autoLayout) so the registry is already up-to-date for those cases.
    for (const refNode of state.nodes) {
      if (!refNode.linkedPartId || refNode.isGlobalPartSource || refNode.instanceState === "pinned") continue;
      const partId = refNode.linkedPartId;
      if (!parts[partId]) continue;
      const liveChildrenShape = refNode.children.map(shapeOf).join("|");
      const registryChildrenShape = (parts[partId].subtree.children || []).map(shapeOf).join("|");
      if (liveChildrenShape !== registryChildrenShape) {
        parts[partId].subtree = buildSubtreeAllRaw(refNode);
        parts[partId].updatedAt = Date.now();
        // Mark the entire subtree as resolved so resolveLinkedNodes teardown +
        // rebuild produces no duplicates at any depth.
        refNode.children.forEach(markResolved);
        anyChanged = true;
      }
    }

    if (anyChanged) {
      saveGlobalPartsToStorage(parts);
      // autoLayout internally calls resolveLinkedNodes, rebuilding all live
      // references in this tab from the freshly written registry.
      autoLayout(state);
      requestDraw(state);
      renderPartsList(state);
    }
  }

  function saveAsGlobalPart(state) {
    if (!state.selectedNode) { showStatus(state, "Select a node first"); return; }
    if (state.selectedNode.resolvedFromPart) {
      showStatus(state, "Cannot save a linked child as a Global Part");
      return;
    }
    const name = window.prompt("Name for this Global Part:", state.selectedNode.text);
    if (!name || !name.trim()) return;
    const partId = "part_" + Date.now();
    const parts = loadGlobalParts();
    parts[partId] = {
      id: partId,
      name: name.trim(),
      subtree: buildSubtreeAll(state.selectedNode),
      tags: [],
      createdAt: Date.now()
    };
    saveGlobalPartsToStorage(parts);
    state.selectedNode.isGlobalPartSource = partId;
    saveToHistory(state);
    requestDraw(state);
    updatePartButtons(state);
    renderPartsList(state);
    showStatus(state, "Saved \"" + name.trim() + "\" as a Global Part");
  }

  function insertGlobalPartReference(state, partId) {
    const parts = loadGlobalParts();
    const part = parts[partId];
    if (!part) { showStatus(state, "Global Part not found"); return; }
    if (!state.selectedNode) { showStatus(state, "Select a parent node first"); return; }
    if (state.selectedNode.resolvedFromPart) {
      showStatus(state, "Cannot insert reference inside a linked reference");
      return;
    }
    const node = createNode(state, part.name);
    node.parent = state.selectedNode;
    node.linkedPartId = partId;
    node.instanceState = "live";
    node.pinnedSnapshot = null;
    if (state.selectedNode.collapsed) state.selectedNode.collapsed = false;
    state.selectedNode.children.push(node);
    state.links.push({ from: state.selectedNode, to: node });
    state.nodes.push(node);
    state.selectedNode = node;
    autoLayout(state);
    requestDraw(state);
    updateDeleteButton(state);
    saveToHistory(state);
    showStatus(state, "Inserted linked reference to \"" + part.name + "\"");
  }

  // Toggle pin/unpin for the selected linked-reference node
  function pinRefInstance(state) {
    const node = state.selectedNode;
    if (!node || !node.linkedPartId) {
      showStatus(state, "Select a linked reference node to pin/unpin");
      return;
    }
    if (node.instanceState === "pinned") {
      node.instanceState = "live";
      node.pinnedSnapshot = null;
      resolveLinkedNodes(state);
      autoLayout(state);
      requestDraw(state);
      updatePartButtons(state);
      saveToHistory(state);
      showStatus(state, "\"" + node.text + "\" is now live-linked — updates with source");
    } else {
      const parts = loadGlobalParts();
      const part = parts[node.linkedPartId];
      if (!part) { showStatus(state, "Global Part not found"); return; }
      node.instanceState = "pinned";
      node.pinnedSnapshot = JSON.parse(JSON.stringify(part.subtree));
      requestDraw(state);
      updatePartButtons(state);
      saveToHistory(state);
      showStatus(state, "\"" + node.text + "\" pinned at current version");
    }
  }

  // Show impact preview modal, then call onConfirm if user proceeds
  function showImpactModal(state, partId, onConfirm) {
    const parts = loadGlobalParts();
    const part = parts[partId];
    if (!part) return;
    const deps = getPartDependencies(state, partId);
    const modal = document.getElementById("impactModal");
    const titleEl = document.getElementById("impactModalTitle");
    const body = document.getElementById("impactModalBody");
    const confirmBtn = document.getElementById("impactConfirmBtn");
    const cancelBtn = document.getElementById("impactCancelBtn");
    if (!modal) { onConfirm(); return; }

    if (titleEl) titleEl.textContent = "Push Update: " + part.name;

    let html = "";
    if (deps.live > 0) {
      html += "<div class=\"impact-group impact-live\">";
      html += "<span class=\"impact-group-label\">Will update (" + deps.live + " live-linked)</span><ul>";
      deps.nodes.filter((n) => n.instanceState !== "pinned").forEach((n) => {
        html += "<li>" + escHtml(getNodeBreadcrumb(n)) + "</li>";
      });
      html += "</ul></div>";
    } else {
      html += "<p class=\"impact-no-live\">No live-linked instances — nothing to update.</p>";
    }
    if (deps.pinned > 0) {
      html += "<div class=\"impact-group impact-pinned\">";
      html += "<span class=\"impact-group-label\">Will NOT update (" + deps.pinned + " pinned)</span><ul>";
      deps.nodes.filter((n) => n.instanceState === "pinned").forEach((n) => {
        html += "<li>" + escHtml(getNodeBreadcrumb(n)) + "</li>";
      });
      html += "</ul></div>";
    }
    if (body) body.innerHTML = html;
    modal.classList.add("visible");

    const cleanup = () => modal.classList.remove("visible");
    if (confirmBtn) confirmBtn.onclick = () => { cleanup(); onConfirm(); };
    if (cancelBtn) cancelBtn.onclick = () => { cleanup(); showStatus(state, "Push cancelled"); };
  }

  function pushPartUpdate(state) {
    const node = state.selectedNode;
    if (!node) { showStatus(state, "Select a node first"); return; }
    let partId;
    let isPushFromReference = false;
    if (node.isGlobalPartSource) {
      partId = node.isGlobalPartSource;
    } else if (node.linkedPartId && !node.resolvedFromPart && node.instanceState !== "pinned") {
      partId = node.linkedPartId;
      isPushFromReference = true;
    } else {
      showStatus(state, "Select a Global Part source or live reference node first");
      return;
    }
    const parts = loadGlobalParts();
    if (!parts[partId]) { showStatus(state, "Global Part not found in registry"); return; }
    showImpactModal(state, partId, () => {
      const freshParts = loadGlobalParts();
      if (!freshParts[partId]) return;
      // Source push: filter resolved children (user-authored only).
      // Reference push: capture ALL children — the resolved nodes are the content.
      freshParts[partId].subtree = isPushFromReference ? buildSubtreeAllRaw(node) : buildSubtreeAll(node);
      freshParts[partId].updatedAt = Date.now();
      saveGlobalPartsToStorage(freshParts);
      // Verify the registry write actually landed before mutating node state.
      // If the write silently failed, the registry still has the old subtree and
      // tearing down user-added children would leave the node permanently empty.
      const writtenParts = loadGlobalParts();
      // updatedAt was just set to Date.now(); if it round-trips through JSON
      // correctly, the save succeeded.  A mismatch means the setItem silently threw.
      const writeOk = writtenParts[partId] &&
        writtenParts[partId].updatedAt === freshParts[partId].updatedAt;
      // When pushing from a linked reference, any user-added (non-resolved) children
      // must be flagged as resolvedFromPart so autoLayout's resolveLinkedNodes call
      // tears them all down and rebuilds cleanly — preventing duplicates.
      // Only flag if we confirmed the write succeeded — otherwise leave them as
      // user-authored so they survive the resolveLinkedNodes rebuild.
      if (isPushFromReference && writeOk) {
        for (const child of node.children) child.resolvedFromPart = true;
      }
      autoLayout(state);
      reinflateAttachments(state);
      requestDraw(state);
      renderPartsList(state);
      showStatus(state, "Updated all live references to \"" + freshParts[partId].name + "\"");
    });
  }

  function deleteGlobalPart(state, partId) {
    const parts = loadGlobalParts();
    if (!parts[partId]) return;
    const name = parts[partId].name;
    delete parts[partId];
    saveGlobalPartsToStorage(parts);
    for (const node of state.nodes) {
      if (node.isGlobalPartSource === partId) node.isGlobalPartSource = null;
      if (node.linkedPartId === partId) node.linkedPartId = null;
    }
    resolveLinkedNodes(state);
    autoLayout(state);
    requestDraw(state);
    updatePartButtons(state);
    renderPartsList(state);
    showStatus(state, "Deleted Global Part \"" + name + "\"");
  }

  // ── Part tags ──

  function addTagToPart(state, partId, tag) {
    const t = tag.trim().toLowerCase();
    if (!t) return;
    const parts = loadGlobalParts();
    if (!parts[partId]) return;
    if (!parts[partId].tags) parts[partId].tags = [];
    if (!parts[partId].tags.includes(t)) {
      parts[partId].tags.push(t);
      saveGlobalPartsToStorage(parts);
      renderPartsList(state);
    }
  }

  function removeTagFromPart(state, partId, tag) {
    const parts = loadGlobalParts();
    if (!parts[partId]) return;
    parts[partId].tags = (parts[partId].tags || []).filter((t) => t !== tag);
    saveGlobalPartsToStorage(parts);
    renderPartsList(state);
  }

  // ── HTML/panel helpers ──

  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderPartsList(state) {
    const container = document.getElementById("partsList");
    if (!container) return;
    const parts = loadGlobalParts();
    const partIds = Object.keys(parts);
    if (partIds.length === 0) {
      container.innerHTML = "<div class=\"parts-empty\">No global parts yet.<br>Select a node and click <strong>Save Part</strong>.</div>";
      return;
    }
    container.innerHTML = partIds.map((id) => {
      const part = parts[id];
      const deps = getPartDependencies(state, id);
      const depText = deps.total === 0 ? "No references" :
        (deps.live > 0 ? deps.live + " live" : "") +
        (deps.live > 0 && deps.pinned > 0 ? " · " : "") +
        (deps.pinned > 0 ? deps.pinned + " pinned" : "");
      const tagsHtml = (part.tags || []).length > 0
        ? "<div class=\"part-tags\">" +
          (part.tags || []).map((t) =>
            "<span class=\"part-tag-chip\" data-tag=\"" + escHtml(t) + "\" data-part=\"" + id + "\">" +
            escHtml(t) + "<button class=\"part-tag-remove\" aria-label=\"Remove\">×</button></span>"
          ).join("") + "</div>"
        : "";
      // Show thumbnail if root subtree node has an image attachment with data
      const rootAtts = part.subtree && part.subtree.attachments;
      const imgAtt = rootAtts && rootAtts.find((a) => a.type && a.type.startsWith("image/") && a.data);
      const thumbHtml = imgAtt
        ? "<img class=\"part-item-thumb\" src=\"" + escHtml(imgAtt.data) + "\" alt=\"" + escHtml(part.name) + "\" />"
        : "";
      return "<div class=\"part-item\">" +
        thumbHtml +
        "<div class=\"part-item-info\">" +
          "<span class=\"part-item-name\">" + escHtml(part.name) + "</span>" +
          "<span class=\"part-item-meta\">" + depText + "</span>" +
          tagsHtml +
          "<div class=\"part-tag-add-row\">" +
            "<input type=\"text\" class=\"part-tag-input\" data-part=\"" + id + "\" placeholder=\"+ tag\" maxlength=\"20\" autocomplete=\"off\"/>" +
          "</div>" +
        "</div>" +
        "<div class=\"part-item-actions\">" +
          "<button type=\"button\" class=\"part-insert-btn\" data-part-id=\"" + id + "\">" +
            "<svg viewBox=\"0 0 24 24\" fill=\"none\" width=\"11\" height=\"11\"><path d=\"M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/><path d=\"M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>" +
            "Insert Ref" +
          "</button>" +
          "<button type=\"button\" class=\"part-delete-btn\" data-part-id=\"" + id + "\" title=\"Delete Part\">" +
            "<svg viewBox=\"0 0 24 24\" fill=\"none\" width=\"11\" height=\"11\"><path d=\"M18 6L6 18M6 6l12 12\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\"/></svg>" +
          "</button>" +
        "</div>" +
      "</div>";
    }).join("");
    container.querySelectorAll(".part-insert-btn").forEach((btn) => {
      btn.addEventListener("click", () => insertGlobalPartReference(state, btn.dataset.partId));
    });
    container.querySelectorAll(".part-delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const part = loadGlobalParts()[btn.dataset.partId];
        if (part && window.confirm("Delete Global Part \"" + part.name + "\"?\nAll linked references will be unlinked.")) {
          deleteGlobalPart(state, btn.dataset.partId);
        }
      });
    });
    container.querySelectorAll(".part-tag-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const chip = btn.parentElement;
        removeTagFromPart(state, chip.dataset.part, chip.dataset.tag);
      });
    });
    container.querySelectorAll(".part-tag-input").forEach((input) => {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          addTagToPart(state, input.dataset.part, input.value);
          input.value = "";
        }
      });
    });
  }

  function togglePartsPanel(state) {
    const panel = document.getElementById("partsPanel");
    const isVisible = panel.classList.toggle("visible");
    state.partsBtn.classList.toggle("active", isVisible);
    if (isVisible) renderPartsList(state);
  }

  // ── Multi-map operations ────────────────────────────────────────────────────

  function addNewMap(state) {
    const registry = readRegistry();
    const name = window.prompt("Name for the new map:", "Map " + (registry.length + 1));
    if (!name || !name.trim()) return;
    const mapId = "map_" + Date.now();
    // Persist current state before opening the new map
    writeAutosave(state);
    // Register the new map so it appears in the panel on every page
    updateRegistryEntry(mapId, name.trim());
    // Open the new map in a new tab
    window.open("?map=" + mapId, "_blank");
  }

  function deleteActiveMap(state) {
    const registry = readRegistry();
    if (registry.length <= 1) { showStatus(state, "Cannot delete the last map"); return; }
    const map = state.maps[0];
    if (!map) return;
    if (!window.confirm(`Delete map "${map.name}" and all its nodes?`)) return;
    removeFromRegistry(state.activeMapId);
    const remaining = readRegistry();
    window.location.href = remaining.length > 0 ? ("?map=" + remaining[0].id) : window.location.pathname;
  }

  function renameActiveMap(state) {
    const map = state.maps[0];
    if (!map) return;
    const newName = window.prompt("Rename map:", map.name);
    if (!newName || !newName.trim()) return;
    map.name = newName.trim();
    // Also rename the root node
    const mapRoot = state.nodes.find((n) => n.id === map.rootId);
    if (mapRoot) mapRoot.text = newName.trim();
    updateRegistryEntry(state.activeMapId, newName.trim());
    document.title = newName.trim() + " — Mindmap Tool";
    autoLayout(state);
    requestDraw(state);
    saveToHistory(state);
    renderMapsList(state);
    showStatus(state, "Map renamed to: " + newName.trim());
  }

  function switchToMap(state, mapId, inNewTab = false) {
    if (mapId === state.activeMapId) { closeMapsPanel(state); return; }
    writeAutosave(state);
    const url = "?map=" + mapId;
    if (inNewTab) { window.open(url, "_blank"); }
    else { window.location.href = url; }
  }

  function renderMapsList(state) {
    const list = document.getElementById("mapsList");
    if (!list) return;
    list.innerHTML = "";
    const registry = readRegistry();
    if (registry.length === 0) {
      list.innerHTML = '<p class="maps-list-empty">No maps yet.</p>';
      return;
    }
    for (const entry of registry) {
      const isActive = entry.id === state.activeMapId;
      const item = document.createElement("div");
      item.className = "map-item" + (isActive ? " active" : "");

      const label = document.createElement("span");
      label.className = "map-item-name";
      label.textContent = entry.name;
      label.addEventListener("click", () => switchToMap(state, entry.id));

      const actions = document.createElement("div");
      actions.className = "map-item-actions";

      const openBtn = document.createElement("button");
      openBtn.className = "map-action-btn map-action-btn--open";
      openBtn.title = "Open in new tab";
      openBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
      openBtn.addEventListener("click", (e) => { e.stopPropagation(); switchToMap(state, entry.id, true); });

      const renameBtn = document.createElement("button");
      renameBtn.className = "map-action-btn";
      renameBtn.title = "Rename map";
      renameBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isActive) {
          renameActiveMap(state);
        } else {
          const newName = window.prompt("Rename map:", entry.name);
          if (!newName || !newName.trim()) return;
          updateRegistryEntry(entry.id, newName.trim());
          renderMapsList(state);
        }
      });

      const delBtn = document.createElement("button");
      delBtn.className = "map-action-btn map-action-btn--delete";
      delBtn.title = "Delete map";
      delBtn.disabled = registry.length <= 1;
      delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isActive) {
          deleteActiveMap(state);
        } else {
          if (readRegistry().length <= 1) { showStatus(state, "Cannot delete the last map"); return; }
          if (!window.confirm(`Delete map "${entry.name}"?`)) return;
          removeFromRegistry(entry.id);
          renderMapsList(state);
          showStatus(state, `Deleted map "${entry.name}"`);
        }
      });

      actions.appendChild(openBtn);
      actions.appendChild(renameBtn);
      actions.appendChild(delBtn);
      item.appendChild(label);
      item.appendChild(actions);
      list.appendChild(item);
    }
  }

  function closeMapsPanel(state) {
    const panel = document.getElementById("mapsPanel");
    if (panel) panel.classList.remove("visible");
    if (state.mapsBtn) state.mapsBtn.classList.remove("active");
  }

  function toggleMapsPanel(state) {
    const panel = document.getElementById("mapsPanel");
    if (!panel) return;
    if (panel.classList.contains("visible")) {
      closeMapsPanel(state);
    } else {
      renderMapsList(state);
      panel.classList.add("visible");
      if (state.mapsBtn) state.mapsBtn.classList.add("active");
    }
  }

  function setupMapsPanel(state) {
    const closeBtn = document.getElementById("mapsPanelClose");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => closeMapsPanel(state));
    }
    const addInPanelBtn = document.getElementById("mapsPanelAddBtn");
    if (addInPanelBtn) {
      addInPanelBtn.addEventListener("click", () => addNewMap(state));
    }
    // Close when clicking outside the panel
    document.addEventListener("pointerdown", (e) => {
      const panel = document.getElementById("mapsPanel");
      if (!panel || !panel.classList.contains("visible")) return;
      if (!panel.contains(e.target) && e.target !== state.mapsBtn && !state.mapsBtn?.contains(e.target)) {
        closeMapsPanel(state);
      }
    }, { capture: true });
    renderMapsList(state);
  }

  function setupGlobalPartsPanel(state) {
    const closeBtn = document.getElementById("partsPanelClose");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        document.getElementById("partsPanel").classList.remove("visible");
        state.partsBtn.classList.remove("active");
      });
    }
    renderPartsList(state);
  }

  // ── Node tag panel ──

  function openTagPanel(state) {
    if (!state.selectedNode) { showStatus(state, "Select a node to add tags"); return; }
    renderTagChips(state);
    document.getElementById("tagPanel").classList.add("visible");
    state.tagBtn.classList.add("active");
    const input = document.getElementById("tagInput");
    if (input) { input.value = ""; input.focus(); }
  }

  function closeTagPanel(state) {
    document.getElementById("tagPanel").classList.remove("visible");
    state.tagBtn.classList.remove("active");
  }

  function toggleTagPanel(state) {
    const panel = document.getElementById("tagPanel");
    if (panel.classList.contains("visible")) closeTagPanel(state); else openTagPanel(state);
  }

  function renderTagChips(state) {
    const node = state.selectedNode;
    const title = document.getElementById("tagPanelTitle");
    const chips = document.getElementById("tagChips");
    if (!chips) return;
    if (!node) { if (chips) chips.innerHTML = "<span class=\"tag-chips-empty\">No node selected</span>"; return; }
    if (title) {
      const t = node.text.length > 22 ? node.text.slice(0, 22) + "…" : node.text;
      title.textContent = "Tags: " + t;
    }
    const tags = node.tags || [];
    if (tags.length === 0) {
      chips.innerHTML = "<span class=\"tag-chips-empty\">No tags — type below and press Enter</span>";
    } else {
      chips.innerHTML = tags.map((tag) =>
        "<span class=\"tag-chip\" data-tag=\"" + escHtml(tag) + "\">" +
        escHtml(tag) +
        "<button class=\"tag-chip-remove\" aria-label=\"Remove tag\">×</button></span>"
      ).join("");
      chips.querySelectorAll(".tag-chip-remove").forEach((btn) => {
        btn.addEventListener("click", () => {
          const tag = btn.parentElement.dataset.tag;
          if (state.selectedNode) {
            state.selectedNode.tags = (state.selectedNode.tags || []).filter((t) => t !== tag);
            renderTagChips(state);
            requestDraw(state);
            saveToHistory(state);
          }
        });
      });
    }
  }

  // ── Relationship panel ─────────────────────────────────────────────────────

  function _getNodeLabel(state, id) {
    const n = state.nodes.find((nd) => nd.id === id);
    return n ? (n.text.length > 22 ? n.text.slice(0, 22) + "…" : n.text) : "Unknown";
  }

  function _showRelView(manageVisible) {
    const mv = document.getElementById("relManageView");
    const ev = document.getElementById("relEditView");
    if (mv) mv.style.display = manageVisible ? "flex" : "none";
    if (ev) ev.style.display = manageVisible ? "none" : "flex";
  }

  function openRelManagePanel(state) {
    const panel = document.getElementById("relPanel");
    if (!panel) return;
    const node = state.selectedNode;
    const titleEl = document.getElementById("relPanelTitle");
    const listEl = document.getElementById("relManageList");
    if (titleEl) titleEl.textContent = node ? `Relationships — ${node.text.length > 18 ? node.text.slice(0, 18) + "…" : node.text}` : "Relationships";
    if (listEl) {
      listEl.innerHTML = "";
      const rels = (state.relLines || []).filter((r) => node && (r.fromId === node.id || r.toId === node.id));
      if (rels.length === 0) {
        const empty = document.createElement("div");
        empty.className = "rel-manage-empty";
        empty.textContent = "No relationships yet.";
        listEl.appendChild(empty);
      } else {
        rels.forEach((rl) => {
          const otherId = rl.fromId === (node && node.id) ? rl.toId : rl.fromId;
          const otherLabel = _getNodeLabel(state, otherId);
          const dirSymbol = rl.direction === "both" ? "↔" : (rl.fromId === (node && node.id) ? "→" : "←");
          const item = document.createElement("div");
          item.className = "rel-manage-item";
          const dot = document.createElement("span");
          dot.className = "rel-manage-item-dot";
          dot.style.background = rl.color || "#6366f1";
          const lbl = document.createElement("span");
          lbl.className = "rel-manage-item-label";
          lbl.textContent = rl.label ? rl.label : otherLabel;
          lbl.title = rl.label ? `${rl.label} (${dirSymbol} ${otherLabel})` : `${dirSymbol} ${otherLabel}`;
          const dir = document.createElement("span");
          dir.className = "rel-manage-item-dir";
          dir.textContent = dirSymbol;
          const editBtn = document.createElement("button");
          editBtn.type = "button";
          editBtn.className = "rel-manage-item-edit";
          editBtn.textContent = "Edit";
          editBtn.addEventListener("click", () => { openRelPanel(state, { isNew: false, rl }); });
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "rel-manage-item-del";
          delBtn.textContent = "Delete";
          delBtn.addEventListener("click", () => {
            state.relLines = (state.relLines || []).filter((r) => r.id !== rl.id);
            if (state.selectedRelLineId === rl.id) state.selectedRelLineId = null;
            saveToHistory(state);
            requestDraw(state);
            openRelManagePanel(state); // refresh the list
          });
          item.appendChild(dot);
          item.appendChild(lbl);
          item.appendChild(dir);
          item.appendChild(editBtn);
          item.appendChild(delBtn);
          listEl.appendChild(item);
        });
      }
    }
    _showRelView(true);
    panel.classList.add("visible");
  }

  function openRelPanel(state, opts) {
    // opts: { isNew: true, fromId, toId } or { isNew: false, rl }
    const panel = document.getElementById("relPanel");
    if (!panel) return;
    state._relPanelOpts = opts;
    const titleEl = document.getElementById("relPanelTitle");
    const labelInput = document.getElementById("relLabelInput");
    const saveBtn = document.getElementById("relSaveBtn");
    const deleteBtn = document.getElementById("relDeleteBtn");
    const colorRow = document.getElementById("relColorRow");
    if (titleEl) titleEl.textContent = opts.isNew ? "New Relationship" : "Edit Relationship";
    if (labelInput) labelInput.value = opts.isNew ? "" : (opts.rl.label || "");
    const currentDir = opts.isNew ? "forward" : (opts.rl.direction || "forward");
    document.querySelectorAll(".rel-dir-btn").forEach((b) => b.classList.toggle("active", b.dataset.dir === currentDir));
    const currentColor = opts.isNew ? REL_COLORS[0] : (opts.rl.color || REL_COLORS[0]);
    if (colorRow) {
      colorRow.innerHTML = "";
      REL_COLORS.forEach((c) => {
        const sw = document.createElement("button");
        sw.type = "button";
        sw.className = "rel-color-swatch" + (c === currentColor ? " active" : "");
        sw.style.background = c;
        sw.dataset.color = c;
        sw.setAttribute("aria-label", c);
        sw.addEventListener("click", () => {
          colorRow.querySelectorAll(".rel-color-swatch").forEach((s) => s.classList.remove("active"));
          sw.classList.add("active");
        });
        colorRow.appendChild(sw);
      });
    }
    if (saveBtn) saveBtn.textContent = opts.isNew ? "Add" : "Save";
    if (deleteBtn) deleteBtn.classList.toggle("show", !opts.isNew);
    _showRelView(false);
    panel.classList.add("visible");
    if (labelInput) labelInput.focus();
  }

  function closeRelPanel(state) {
    const panel = document.getElementById("relPanel");
    if (panel) panel.classList.remove("visible");
    state._relPanelOpts = null;
  }

  function setupRelPanel(state) {
    const closeBtn = document.getElementById("relPanelClose");
    const saveBtn = document.getElementById("relSaveBtn");
    const deleteBtn = document.getElementById("relDeleteBtn");
    const labelInput = document.getElementById("relLabelInput");
    const addNewBtn = document.getElementById("relAddNewBtn");
    const backBtn = document.getElementById("relBackBtn");
    if (closeBtn) closeBtn.addEventListener("click", () => closeRelPanel(state));
    // Back button: return to manage view
    if (backBtn) backBtn.addEventListener("click", () => {
      state._relPanelOpts = null;
      openRelManagePanel(state);
    });
    // New Relationship button: start pick mode then close panel temporarily
    if (addNewBtn) addNewBtn.addEventListener("click", () => {
      if (!state.selectedNode) { showStatus(state, "Select a source node first"); return; }
      closeRelPanel(state);
      state.relLinePickMode = true;
      state.relLineSourceId = state.selectedNode.id;
      state.canvas.style.cursor = "crosshair";
      requestDraw(state);
    });
    // Direction buttons — toggle active on click
    document.querySelectorAll(".rel-dir-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".rel-dir-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });
    if (saveBtn) saveBtn.addEventListener("click", () => {
      const opts = state._relPanelOpts;
      if (!opts) return;
      const label = (labelInput ? labelInput.value.trim() : "");
      const dirBtn = document.querySelector(".rel-dir-btn.active");
      const direction = dirBtn ? dirBtn.dataset.dir : "forward";
      const colorSwatch = document.querySelector(".rel-color-swatch.active");
      const color = colorSwatch ? colorSwatch.dataset.color : REL_COLORS[0];
      if (opts.isNew) {
        state.relLines.push({
          id: "rl_" + Date.now(),
          fromId: opts.fromId, toId: opts.toId,
          label, color, direction,
          labelOffsetX: 0, labelOffsetY: 0
        });
        closeRelPanel(state);
      } else {
        const rl = (state.relLines || []).find((r) => r.id === opts.rl.id);
        if (rl) { rl.label = label; rl.direction = direction; rl.color = color; }
        // Return to manage view after saving edit
        openRelManagePanel(state);
      }
      state.selectedRelLineId = null;
      saveToHistory(state);
      requestDraw(state);
    });
    if (deleteBtn) deleteBtn.addEventListener("click", () => {
      const opts = state._relPanelOpts;
      if (!opts || opts.isNew) return;
      state.relLines = (state.relLines || []).filter((r) => r.id !== opts.rl.id);
      state.selectedRelLineId = null;
      // Return to manage view after delete
      openRelManagePanel(state);
      saveToHistory(state);
      requestDraw(state);
    });
    if (labelInput) {
      labelInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveBtn && saveBtn.click(); }
        if (e.key === "Escape") { e.preventDefault(); closeRelPanel(state); }
      });
    }
  }

  // ── Note panel ─────────────────────────────────────────────────────────────

  function closeNotePanel(state) {
    const panel = document.getElementById("notePanel");
    if (panel) panel.classList.remove("visible");
    if (state.noteBtn) state.noteBtn.classList.remove("active");
  }

  function renderNodeLinks(state) {
    const container = document.getElementById("noteLinksList");
    if (!container) return;
    container.innerHTML = "";
    const node = state.selectedNode;
    const links = (node && node.links) ? node.links : [];
    if (links.length === 0) return;
    const header = document.createElement("div");
    header.className = "note-links-header";
    header.textContent = "Links";
    container.appendChild(header);
    links.forEach((link) => {
      const url = link.url || link.href || (typeof link === "string" ? link : null);
      const label = link.title || link.label || link.text || url;
      if (!url) return;
      const chip = document.createElement("a");
      chip.className = "note-link-chip";
      chip.href = url;
      chip.target = "_blank";
      chip.rel = "noopener noreferrer";
      chip.innerHTML = `<svg viewBox="0 0 16 16" fill="none" width="11" height="11" style="flex-shrink:0"><path d="M6.5 9.5a4 4 0 005.5-5.5L10.5 2.5a4 4 0 00-5.5 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9.5 6.5a4 4 0 00-5.5 5.5L5.5 13.5a4 4 0 005.5-5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>${escapeHtml(label)}</span>`;
      container.appendChild(chip);
    });
  }

  function openNotePanel(state) {
    const node = state.selectedNode;
    if (!node) return;
    const panel = document.getElementById("notePanel");
    const editor = document.getElementById("noteEditor");
    const title = document.getElementById("notePanelTitle");
    if (!panel || !editor) return;
    const shortTitle = node.text.length > 28 ? node.text.slice(0, 28) + "\u2026" : node.text;
    if (title) title.textContent = shortTitle;
    editor.innerHTML = node.note || "";
    renderNodeLinks(state);
    panel.classList.add("visible");
    if (state.noteBtn) state.noteBtn.classList.add("active");
    editor.focus();
  }

  function toggleNotePanel(state) {
    const panel = document.getElementById("notePanel");
    if (panel && panel.classList.contains("visible")) {
      closeNotePanel(state);
    } else {
      openNotePanel(state);
    }
  }

  function setupNotePanel(state) {
    const closeBtn = document.getElementById("notePanelClose");
    if (closeBtn) closeBtn.addEventListener("click", () => closeNotePanel(state));

    const editor = document.getElementById("noteEditor");
    if (editor) {
      editor.addEventListener("input", () => {
        if (state.selectedNode) {
          const html = editor.innerHTML;
          state.selectedNode.note = (html === "<br>" || html === "") ? null : html;
          setUnsavedChanges(state, true);
        }
      });
      editor.addEventListener("blur", () => {
        if (state.selectedNode) {
          saveToHistory(state);
        }
      });
    }

    // Toolbar format buttons
    const toolbar = document.querySelector(".note-toolbar");
    if (toolbar) {
      toolbar.addEventListener("mousedown", (e) => {
        const btn = e.target.closest("[data-cmd]");
        if (!btn) return;
        e.preventDefault();
        const cmd = btn.dataset.cmd;
        const val = btn.dataset.val || null;
        document.execCommand(cmd, false, val);
        if (editor) editor.focus();
      });
    }
  }

  function setupTagPanel(state) {
    const closeBtn = document.getElementById("tagPanelClose");
    const input = document.getElementById("tagInput");
    if (closeBtn) closeBtn.addEventListener("click", () => closeTagPanel(state));
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          const tag = input.value.trim().toLowerCase().replace(/[,#]/g, "");
          if (tag && state.selectedNode) {
            if (!state.selectedNode.tags) state.selectedNode.tags = [];
            if (!state.selectedNode.tags.includes(tag)) {
              state.selectedNode.tags.push(tag);
              renderTagChips(state);
              requestDraw(state);
              saveToHistory(state);
            }
            input.value = "";
          }
        }
        if (e.key === "Escape") closeTagPanel(state);
      });
    }
    document.addEventListener("keydown", (ev) => {
      const tag2 = ev.target && ev.target.tagName ? ev.target.tagName.toLowerCase() : "";
      const typing = tag2 === "input" || tag2 === "textarea" || ev.target.isContentEditable;
      if (!typing && ev.key === "t") { ev.preventDefault(); toggleTagPanel(state); }
    });
    document.addEventListener("click", (ev) => {
      const panel = document.getElementById("tagPanel");
      if (panel && panel.classList.contains("visible")) {
        if (!panel.contains(ev.target) && !state.tagBtn.contains(ev.target)) closeTagPanel(state);
      }
    });
  }

  // ── search ─────────────────────────────────────────────────────────────────

  function setupSearch(state) {
    const searchInput = document.getElementById("searchInput");
    const searchClear = document.getElementById("searchClear");
    const searchResults = document.getElementById("searchResults");

    function escapeHtml(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function getNodePath(node) {
      const parts = [];
      let current = node.parent;
      while (current) {
        parts.unshift(current.text);
        current = current.parent;
      }
      return parts;
    }

    function navigateToResult(id) {
      const node = state.nodes.find((n) => n.id === id);
      if (!node) return;
      state.selectedNode = node;
      updateDeleteButton(state);
      centerMindmap(state, () => requestDraw(state));
    }

    function renderResults(matches, partMatches, query) {
      const hasNodes = matches.length > 0;
      const hasParts = partMatches.length > 0;

      if (!hasNodes && !hasParts) {
        searchResults.innerHTML = `<div class="search-empty">No results for "${escapeHtml(query)}"</div>`;
        searchResults.classList.add("visible");
        return;
      }

      const totalCount = matches.length + partMatches.length;
      let html = `<div class="search-count">${totalCount} result${totalCount !== 1 ? "s" : ""}</div>`;

      if (hasNodes) {
        html += matches.map((n) => {
          const nodePath = getNodePath(n);
          const badge = n.resolvedFromPart
            ? `<span class="search-badge search-badge-resolved">linked</span>`
            : n.linkedPartId
              ? `<span class="search-badge search-badge-ref">ref</span>`
              : "";
          const pathHtml =
            nodePath.length > 0
              ? `<span class="search-path">${nodePath.map(escapeHtml).join(" › ")}</span>`
              : "";
          const label = n.numbering ? `${n.numbering} ${n.text}` : n.text;
          return `<div class="search-result-item" data-id="${n.id}" role="option" tabindex="0">
            <span class="search-text">${escapeHtml(label)}</span>${badge}
            ${pathHtml}
          </div>`;
        }).join("");
      }

      if (hasParts) {
        html += `<div class="search-section-label">Global Parts</div>`;
        html += partMatches.map((part) => {
          const sourceNode = state.nodes.find((n) => n.isGlobalPartSource === part.id);
          const hint = sourceNode
            ? `<span class="search-path">Source on canvas</span>`
            : `<span class="search-path">Not on canvas — insert a reference</span>`;
          return `<div class="search-result-item search-result-part" data-part-id="${escapeHtml(part.id)}" role="option" tabindex="0">
            <span class="search-text">${escapeHtml(part.name)}</span><span class="search-badge search-badge-part">part</span>
            ${hint}
          </div>`;
        }).join("");
      }

      searchResults.innerHTML = html;
      searchResults.classList.add("visible");

      searchResults.querySelectorAll(".search-result-item:not(.search-result-part)").forEach((el) => {
        const id = parseInt(el.dataset.id, 10);
        const handler = () => navigateToResult(id);
        el.addEventListener("click", handler);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(); }
        });
      });

      searchResults.querySelectorAll(".search-result-part").forEach((el) => {
        const partId = el.dataset.partId;
        const handler = () => {
          const sourceNode = state.nodes.find((n) => n.isGlobalPartSource === partId);
          if (sourceNode) {
            navigateToResult(sourceNode.id);
          } else {
            showStatus(state, "Source not on canvas — select a node and use Insert Ref from the Parts panel.");
          }
          searchResults.classList.remove("visible");
        };
        el.addEventListener("click", handler);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(); }
        });
      });
    }

    function doSearch(query) {
      const q = query.trim().toLowerCase();
      state.searchMatchIds.clear();

      if (!q) {
        searchResults.innerHTML = "";
        searchResults.classList.remove("visible");
        searchClear.style.display = "none";
        requestDraw(state);
        return;
      }

      searchClear.style.display = "flex";

      // Search canvas nodes (includes resolvedFromPart children already in state.nodes)
      // Tag filter: #tag syntax
      let matches;
      if (q.startsWith("#")) {
        const tagQuery = q.slice(1);
        matches = tagQuery ? state.nodes.filter((n) => (n.tags || []).some((t) => t.includes(tagQuery))) : [];
      } else {
        matches = state.nodes.filter((n) => n.text.toLowerCase().includes(q));
      }
      matches.forEach((n) => state.searchMatchIds.add(n.id));

      // Also search the Global Parts registry by part name
      const allParts = loadGlobalParts();
      const partMatches = q.startsWith("#")
        ? Object.values(allParts).filter((p) => (p.tags || []).some((t) => t.includes(q.slice(1))))
        : Object.values(allParts).filter((p) => p.name.toLowerCase().includes(q));

      requestDraw(state);
      renderResults(matches, partMatches, query);
    }

    searchInput.addEventListener("input", (e) => doSearch(e.target.value));

    searchInput.addEventListener("focus", () => {
      if (searchInput.value.trim()) {
        searchResults.classList.add("visible");
      }
    });

    searchClear.addEventListener("click", () => {
      searchInput.value = "";
      doSearch("");
      searchInput.focus();
    });

    document.addEventListener("click", (e) => {
      const bar = document.getElementById("searchBar");
      if (!bar.contains(e.target) && !searchResults.contains(e.target)) {
        searchResults.classList.remove("visible");
      }
    });

    document.addEventListener("keydown", (e) => {
      const targetTag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "";
      const typing = targetTag === "input" || targetTag === "textarea" || e.target.isContentEditable;
      if (!typing && e.key === "/") {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
        return;
      }
      if (e.key === "Escape" && document.activeElement === searchInput) {
        searchInput.value = "";
        doSearch("");
        searchInput.blur();
      }
    });
  }

  // ── main ───────────────────────────────────────────────────────────────────

  function init() {
    const state = createAppState();
    setCanvasSize(state);
    window.addEventListener("beforeunload", (e) => {
      if (state.hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
    bindControls(state);
    setupToolbar(state);
    setupKeyboardShortcuts(state);
    setupSearch(state);
    setupGlobalPartsPanel(state);
    setupMapsPanel(state);
    setupTagPanel(state);
    setupRelPanel(state);
    setupNotePanel(state);
    setupCanvasEvents(state);
    initializeFromQuery(state);
    updateDeleteButton(state);
    requestDraw(state);

    // Cross-tab sync: when another page updates global parts or the map registry,
    // refresh this page's resolved nodes and maps list.
    window.addEventListener("storage", (e) => {
      if (e.key === GLOBAL_PARTS_KEY) {
        autoLayout(state);
        reinflateAttachments(state);
        requestDraw(state);
      }
      if (e.key === MAP_REGISTRY_KEY) {
        renderMapsList(state);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
