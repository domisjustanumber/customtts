document.addEventListener("DOMContentLoaded", async () => {
  const elements = {
    apiUrlInput: document.getElementById("apiUrl"),
    apiKeyInput: document.getElementById("apiKey"),
    speedInput: document.getElementById("speed"),
    voiceInput: document.getElementById("voice"),
    modelInput: document.getElementById("model"),
    streamingModeInput: document.getElementById("streamingMode"),
    downloadModeInput: document.getElementById("downloadMode"),
    volumeInput: document.getElementById("volume"),
    streamingWarning: document.getElementById("streamingWarning"),
    downloadWarning: document.getElementById("downloadWarning"),
    saveButton: document.getElementById("saveButton"),
    stopButton: document.getElementById("stopButton"),
    playButton: document.getElementById("playButton"),
    pauseButton: document.getElementById("pauseButton"),
    readPageButton: document.getElementById("readPageButton"),
    downloadProgress: document.getElementById("downloadProgress"),
    downloadProgressMessage: document.getElementById("downloadProgressMessage"),
    downloadProgressBar: document.getElementById("downloadProgressBar"),
    tabButtons: document.querySelectorAll(".tab-button"),
    tabPanels: document.querySelectorAll(".tab-panel")
  };

  // Initialize UI with saved settings
  await initializeUI(elements);

  // Setup mode exclusivity
  setupModeExclusivity(elements);

  // Save settings
  elements.saveButton.addEventListener("click", () => handleSave(elements));

  // Stop playback
  elements.stopButton.addEventListener("click", handleStopPlayback);

  // Read current page in Firefox Reader View
  elements.readPageButton.addEventListener("click", async () => {
    await browser.runtime.sendMessage({ action: "readCurrentPage" });
    await updateTransportState();
  });

  async function updateTransportState() {
    try {
      const { playbackState } = (await browser.runtime.sendMessage({ action: "getPlaybackState" })) || { playbackState: "idle" };
      setTransportButtons(playbackState);
    } catch (e) {
      setTransportButtons("idle");
    }
  }

  async function updateDownloadProgressState() {
    try {
      const { downloadProgress } = (await browser.runtime.sendMessage({ action: "getDownloadProgress" })) || {};
      renderDownloadProgress(downloadProgress);
    } catch (e) {
      renderDownloadProgress({ active: false, percent: 0, message: "" });
    }
  }

  function renderDownloadProgress(progress) {
    const active = progress && progress.active;
    const percent = Math.max(0, Math.min(100, Math.round((progress && progress.percent) || 0)));
    const message = (progress && progress.message) || "Preparing download...";
    const indeterminate = Boolean(progress && progress.indeterminate);

    elements.downloadProgress.classList.toggle("active", Boolean(active));
    elements.downloadProgressMessage.textContent = message;
    elements.downloadProgressBar.classList.toggle("indeterminate", indeterminate);
    elements.downloadProgressBar.style.width = indeterminate ? "" : `${percent}%`;
  }

  function setTransportButtons(state) {
    const playDisabled = state !== "paused";
    const pauseDisabled = state !== "playing";
    const stopDisabled = state === "idle";
    elements.playButton.disabled = playDisabled;
    elements.pauseButton.disabled = pauseDisabled;
    elements.stopButton.disabled = stopDisabled;
  }

  // Stop playback
  elements.stopButton.addEventListener("click", async () => {
    await browser.runtime.sendMessage({ action: "stopPlayback" });
    setTransportButtons("idle");
  });

  // Play (resume)
  elements.playButton.addEventListener("click", async () => {
    await browser.runtime.sendMessage({ action: "resumePlayback" });
    await updateTransportState();
  });

  // Pause
  elements.pauseButton.addEventListener("click", async () => {
    await browser.runtime.sendMessage({ action: "pausePlayback" });
    await updateTransportState();
  });

  // Tab switching
  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const targetTab = button.dataset.tab;

      elements.tabButtons.forEach((b) => b.classList.toggle("active", b === button));
      elements.tabPanels.forEach((panel) => {
        panel.classList.toggle("active", panel.id === `${targetTab}Tab`);
      });

      if (targetTab === "play") {
        updateTransportState();
      }
    });
  });

  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "downloadProgressChanged") {
      renderDownloadProgress(message.downloadProgress);
    }
  });

  // Initial transport state
  updateTransportState();
  updateDownloadProgressState();
});
