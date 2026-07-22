export const STORAGE_KEYS = Object.freeze({
  SETTINGS: "settings",
  RUNTIME_STATE: "runtimeState",
});

export const TARGETS = Object.freeze({
  SERVICE_WORKER: "service-worker",
  OFFSCREEN: "offscreen",
});

export const MESSAGE_TYPES = Object.freeze({
  GET_STATE: "popup:get-state",
  SAVE_SETTINGS: "popup:save-settings",
  START: "popup:start",
  STOP: "popup:stop",
  OFFSCREEN_START: "offscreen:start",
  OFFSCREEN_STOP: "offscreen:stop",
  OFFSCREEN_CAPTION: "offscreen:caption",
  OFFSCREEN_PROGRESS: "offscreen:progress",
  OFFSCREEN_ERROR: "offscreen:error",
  OFFSCREEN_STOPPED: "offscreen:stopped",
  CONTENT_PING: "content:ping",
  CONTENT_CONFIGURE: "content:configure",
  CONTENT_STATUS: "content:status",
  CONTENT_CAPTION: "content:caption",
  CONTENT_CLEAR: "content:clear",
});

export const SESSION_STATUS = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  ERROR: "error",
});

export const OFFSCREEN_DOCUMENT_PATH = "src/offscreen/offscreen.html";

export const RESTRICTED_URL_PREFIXES = Object.freeze([
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
  "view-source:",
  "devtools://",
  "file://",
]);
