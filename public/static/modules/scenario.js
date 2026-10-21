// Compatibility shim for saved links and older globals. Scenario is Training's constructed mode.
(function initializeScenarioCompatibility(S) {
  function openConstructedTraining() {
    window.switchTab?.('training');
    window.setTrainingMode?.('constructed');
  }

  function loadScenarioTab() { openConstructedTraining(); }
  function startScenario() { openConstructedTraining(); }
  function submitScenarioResponse() { return window.submitTrainingMessage?.(); }
  function endScenario() { return window.resetTrainingUI?.(); }

  Object.assign(window, { loadScenarioTab, startScenario, submitScenarioResponse, endScenario });
  S.loadScenarioTab = loadScenarioTab;
})(window.SocraticAI);
