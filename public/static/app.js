// SocraticAI v35 — compatibility bridge
// main.js is the only browser entrypoint. This file remains parse-safe for
// older cached HTML that may still request /static/app.js.
(function bootstrapCompatibilityBridge() {
  const bridge = window.SocraticAI || window.SocraticModules || {};
  window.SocraticAI = bridge;
  window.SocraticModules = bridge;
})();
