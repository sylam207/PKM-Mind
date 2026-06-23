/**
 * rendering.js — Canvas drawing pipeline.
 *
 * Exports a single public function `requestDraw` that schedules a
 * `requestAnimationFrame` draw cycle. All drawing logic lives in `drawAll`,
 * which is called each frame. Smooth animated layout transitions are also
 * driven from here via `updateLayoutTransition`.
 */

import {
  calculateInsertionZones,
  countHiddenDescendants,
  getVisibleLinks,
  getVisibleNodes,
  isLinkDimmedByFocus,
  isNodeDimmedByFocus
} from "./layout.js";
import { getBranchTheme } from "./state.js";

/**
 * Draws a rounded rectangle path onto `ctx`.
 * The radius is clamped to at most half the shorter side so the shape is
 * always valid. Does not call `fill()` or `stroke()` — the caller decides.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x      - Left edge.
 * @param {number} y      - Top edge.
 * @param {number} width
 * @param {number} height
 * @param {number} radius - Desired corner radius.
 */
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

/**
 * Returns the render position of a node, preferring the animated `renderX`/
 * `renderY` values over the logical `x`/`y` when they are finite.
 * This ensures hit-tests and drawings always use the visually current position
 * during a layout transition.
 *
 * @param {Object} node - A mindmap node.
 * @returns {{ x: number, y: number }}
 */
function getNodeRenderPosition(node) {
  return {
    x: Number.isFinite(node.renderX) ? node.renderX : node.x,
    y: Number.isFinite(node.renderY) ? node.renderY : node.y
  };
}

/**
 * Advances the smooth layout transition by lerping each node's rendered
 * position (renderX/renderY) 22 % of the remaining distance toward its target
 * (x/y) each frame. Once all nodes are within 0.35 px of their targets the
 * transition is marked complete and `layoutTransitionActive` is set to false.
 *
 * When `layoutTransitionActive` is false, nodes are snapped directly to their
 * logical positions with no interpolation.
 *
 * @param {Object} state - App state.
 * @returns {boolean} True while at least one node is still moving.
 */
function updateLayoutTransition(state) {
  let stillMoving = false;

  for (const node of state.nodes) {
    if (!Number.isFinite(node.renderX)) {
      node.renderX = node.x;
    }
    if (!Number.isFinite(node.renderY)) {
      node.renderY = node.y;
    }

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

/**
 * Draws a bezier curve connecting the right-centre of `from` to the
 * left-centre of `to`, representing a parent→child link. The curve's
 * control-point offset is fixed at 40 px on each side, giving a gentle S-shape.
 * Link colour is taken from the branch theme at `from`'s depth.
 *
 * @param {Object}  state           - App state.
 * @param {Object}  from            - Parent node.
 * @param {Object}  to              - Child node.
 * @param {boolean} [dimmed=false]  - When true the link is rendered very faintly
 *   (used in focus mode).
 */
function drawLine(state, from, to, dimmed = false) {
  const fromPos = getNodeRenderPosition(from);
  const toPos = getNodeRenderPosition(to);
  const x1 = fromPos.x + from.width;
  const y1 = fromPos.y + from.height / 2;
  const x2 = toPos.x;
  const y2 = toPos.y + to.height / 2;
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

/**
 * Draws the child-count badge on a collapsed (or non-leaf) node.
 * A blue circle containing the direct child count appears at the top-right
 * corner of the node. When the node is collapsed, a short text preview of its
 * first two child labels is also drawn to the right of the node.
 *
 * @param {Object} state - App state.
 * @param {Object} node  - The node to annotate.
 */
function drawNodeSummary(state, node) {
  if (node.children.length === 0) {
    return;
  }

  const nodePos = getNodeRenderPosition(node);
  const badgeX = nodePos.x + node.width - 8;
  const badgeY = nodePos.y - 8;
  const childCountLabel = `${node.children.length}`;

  state.ctx.fillStyle = "#1d4ed8";
  state.ctx.beginPath();
  state.ctx.arc(badgeX, badgeY, 9, 0, Math.PI * 2);
  state.ctx.fill();

  state.ctx.fillStyle = "#fff";
  state.ctx.font = "700 10px Manrope";
  state.ctx.textAlign = "center";
  state.ctx.textBaseline = "middle";
  state.ctx.fillText(childCountLabel, badgeX, badgeY + 0.5);

  if (!node.collapsed) {
    return;
  }

  const previewItems = node.children.slice(0, 2).map((child) => child.text);
  const hiddenDescendants = countHiddenDescendants(node);
  const moreCount = Math.max(hiddenDescendants - previewItems.length, 0);
  const previewText = `${previewItems.join(", ")}${moreCount > 0 ? ` +${moreCount}` : ""}`;

  state.ctx.fillStyle = "rgba(30, 41, 59, 0.84)";
  state.ctx.font = "600 11px Manrope";
  state.ctx.textAlign = "left";
  state.ctx.textBaseline = "middle";
  state.ctx.fillText(previewText, nodePos.x + node.width + 10, nodePos.y + node.height / 2);
}

/**
 * Draws a small "P" marker in the top-left corner of a pinned node so the
 * user can identify which nodes have their position locked.
 *
 * @param {Object} state - App state.
 * @param {Object} node  - The node to annotate.
 */
function drawPinnedMarker(state, node) {
  if (!node.pinned) {
    return;
  }

  state.ctx.fillStyle = "#0f766e";
  state.ctx.font = "700 12px Manrope";
  state.ctx.textAlign = "left";
  state.ctx.textBaseline = "top";
  const nodePos = getNodeRenderPosition(node);
  state.ctx.fillText("P", nodePos.x + 6, nodePos.y + 4);
}

/**
 * Positions the floating ▲ / ▼ reorder buttons next to the currently selected
 * node. Hides them when there is no selection or while a drag is in progress.
 * Buttons are placed in screen space (not canvas space) so they must account
 * for the viewport transform.
 *
 * @param {Object} state - App state.
 */
function updateReorderButtons(state) {
  if (!state.selectedNode || state.isDragging) {
    state.reorderUp.style.display = "none";
    state.reorderDown.style.display = "none";
    return;
  }

  const x = state.selectedNode.x * state.viewScale + state.viewOffsetX + state.selectedNode.width * state.viewScale + 5;
  const y = state.selectedNode.y * state.viewScale + state.viewOffsetY;

  state.reorderUp.style.display = "block";
  state.reorderDown.style.display = "block";
  state.reorderUp.style.left = `${x}px`;
  state.reorderUp.style.top = `${y}px`;
  state.reorderDown.style.left = `${x}px`;
  state.reorderDown.style.top = `${y + 20}px`;
}

/**
 * Performs a full redraw of the canvas for the current frame.
 *
 * Draw order:
 *  1. Advance layout transition interpolation.
 *  2. Clear the canvas and apply the viewport transform.
 *  3. (Optional) Render debug insertion-zone rectangles.
 *  4. Draw all visible links.
 *  5. Draw all visible nodes (dimmed if focus mode is active).
 *  6. Draw node summary badges and pinned markers.
 *  7. If dragging, draw the ghost node and dashed preview link.
 *  8. Reset transform and draw the layout-mode tag in screen space.
 *  9. Update reorder button positions.
 *
 * @param {Object} state - App state.
 * @returns {boolean} True if a follow-up frame should be requested (i.e. the
 *   layout transition is still running).
 */
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
    if (dimmed) {
      state.ctx.globalAlpha = 0.2;
    }
    node.draw(false);
    state.ctx.globalAlpha = 1;
    drawNodeSummary(state, node);
    drawPinnedMarker(state, node);
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
      const startY = state.potentialParent.y + state.potentialParent.height / 2;
      const endX = state.ghostX;
      const endY = state.ghostY + state.draggingNode.height / 2;
      const cp1x = startX + 40;
      const cp2x = endX - 40;

      state.ctx.beginPath();
      state.ctx.moveTo(startX, startY);
      state.ctx.bezierCurveTo(cp1x, startY, cp2x, endY, endX, endY);
      state.ctx.stroke();
      state.ctx.setLineDash([]);
    }
  }

  state.ctx.setTransform(1, 0, 0, 1, 0, 0);

  updateReorderButtons(state);

  return transitioning;
}

/**
 * Schedules a draw on the next animation frame, coalescing multiple calls
 * within the same frame into a single redraw. If `drawAll` reports that the
 * layout transition is still in progress, another frame is requested
 * automatically to keep the animation running.
 *
 * @param {Object} state - App state.
 */
export function requestDraw(state) {
  if (state.animationFrameRequested) {
    return;
  }

  state.animationFrameRequested = true;
  requestAnimationFrame(() => {
    const shouldContinue = drawAll(state);
    state.animationFrameRequested = false;
    if (shouldContinue) {
      requestDraw(state);
    }
  });
}
