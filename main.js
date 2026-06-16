/**
 * main.js — Application entry point.
 *
 * Bootstraps the mindmap app by wiring up state, event handlers, and the
 * initial render. All other modules are orchestrated from here.
 */

import { bindControls, initializeFromQuery, setupCanvasEvents, setupKeyboardShortcuts, setupToolbar } from "./input.js";
import { requestDraw } from "./rendering.js";
import { createAppState, setCanvasSize, updateDeleteButton } from "./state.js";

// state is created inside init() so DOM elements exist when getElementById is called.
let state;

/**
 * Initialises the entire application.
 * Creates shared state, sizes the canvas, attaches all event listeners,
 * and kicks off the first draw / data load.
 */
function init() {
  state = createAppState();
  setCanvasSize(state);

  // Warn the user before navigating away when there are unsaved changes.
  window.addEventListener("beforeunload", (e) => {
    if (!state.hasUnsavedChanges) {
      return;
    }
    const message = "You have unsaved changes. Are you sure you want to leave?";
    e.returnValue = message;
    return message;
  });

  // Wire up toolbar buttons, keyboard shortcuts, and canvas pointer/touch events.
  bindControls(state);
  setupToolbar(state);
  setupKeyboardShortcuts(state);
  setupCanvasEvents(state);

  // Load from a Gist URL param, local autosave, or create a blank default node.
  initializeFromQuery(state);
  updateDeleteButton(state);
  requestDraw(state);
}

// DOMContentLoaded fires before load and guarantees the HTML is parsed.
// Fallback to running immediately if already parsed (file:// fast-load edge case).
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
