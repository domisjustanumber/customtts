// Import configuration
// Note: config.js and notifications.js need to be loaded in manifest.json

/**
 * @typedef {Object} AppState
 * @property {string} apiUrl
 * @property {string} apiKey
 * @property {number} speechSpeed
 * @property {string} voice
 * @property {string} model
 * @property {boolean} streamingMode
 * @property {boolean} downloadMode
 * @property {boolean} isMobile
 */

// Settings state
let apiUrl = "";
let apiKey = "";
let speechSpeed = 1.0;
let voice = "af_bella+af_sky";
let model = "kokoro";
let streamingMode = false;
let downloadMode = false;
let isMobile = false;

// Audio playback state
let currentAudio = null;
let audioContext = null;
let gainNode = null;
let pcmStreamStopped = false;
let pcmPlaybackTime = 0;
let playbackState = "idle"; // idle | playing | paused

// Queue management
let audioQueue = [];
let isPlaying = false;
let stopRequested = false;
let currentAbortController = null;

// Download progress state for the extension popup
let downloadProgress = {
  active: false,
  percent: 0,
  message: "",
  indeterminate: false,
};

function setPlaybackState(state) {
  playbackState = state;
}

browser.runtime.getPlatformInfo().then((info) => {
  isMobile = info.os === "android";
  initializeExtension();
});

function initializeExtension() {
  if (isMobile) {
    browser.browserAction.setPopup({ popup: "" });
    browser.browserAction.onClicked.addListener(handleMobileClick);
  } else {
    createContextMenu();
    browser.runtime.onInstalled.addListener(createContextMenu);
  }
}

function handleMobileClick(tab) {
  browser.tabs
    .executeScript({
      code: "window.getSelection().toString();",
    })
    .then((results) => {
      const selectedText = results[0];
      if (selectedText) {
        if (downloadMode && isMobile) {
          processMobileDownload(selectedText);
        } else {
          processText(selectedText);
        }
      }
    });
}

/**
 * Initialize settings from storage
 */
(async function initializeSettings() {
  try {
    const data = await browser.storage.local.get([
      "apiUrl", "apiKey", "speechSpeed", "voice", 
      "model", "streamingMode", "downloadMode", "outputVolume"
    ]);
    
    apiUrl = data.apiUrl || CONFIG.DEFAULT_API_URL;
    apiKey = data.apiKey || CONFIG.DEFAULT_API_KEY;
    speechSpeed = data.speechSpeed || CONFIG.DEFAULT_SPEED;
    voice = data.voice || CONFIG.DEFAULT_VOICE;
    model = data.model || CONFIG.DEFAULT_MODEL;
    streamingMode = data.streamingMode || false;
    downloadMode = data.downloadMode || false;
    if (gainNode) gainNode.gain.value = data.outputVolume ?? CONFIG.DEFAULT_VOLUME;
  } catch (error) {
    console.error('Failed to initialize settings:', error);
  }
})();

browser.storage.onChanged.addListener((changes) => {
  if (changes.apiUrl) apiUrl = changes.apiUrl.newValue;
  if (changes.apiKey) apiKey = changes.apiKey.newValue;
  if (changes.speechSpeed) speechSpeed = changes.speechSpeed.newValue;
  if (changes.voice) voice = changes.voice.newValue;
  if (changes.model) model = changes.model.newValue;
  if (changes.streamingMode) streamingMode = changes.streamingMode.newValue;
  if (changes.downloadMode) downloadMode = changes.downloadMode.newValue;
  if (changes.outputVolume && gainNode) gainNode.gain.value = changes.outputVolume.newValue;
});

browser.runtime.onMessage.addListener((message) => {
  if (message.action === "stopPlayback") {
    stopRequested = true;
    pcmStreamStopped = true;
    
    audioQueue.forEach(url => URL.revokeObjectURL(url));
    audioQueue = [];
    isPlaying = false;
    setPlaybackState("idle");
    
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
  }

  if (message.action === "pausePlayback") {
    if (streamingMode && audioContext && playbackState === "playing") {
      audioContext.suspend().catch(() => {});
      setPlaybackState("paused");
    } else if (currentAudio && !currentAudio.paused) {
      currentAudio.pause();
      setPlaybackState("paused");
    }
  }

  if (message.action === "resumePlayback") {
    if (streamingMode && audioContext && playbackState === "paused") {
      audioContext.resume().catch(() => {});
      setPlaybackState("playing");
    } else if (currentAudio && currentAudio.paused) {
      currentAudio.play().catch(() => {});
      setPlaybackState("playing");
    }
  }

  if (message.action === "getPlaybackState") {
    return Promise.resolve({ playbackState });
  }

  if (message.action === "getDownloadProgress") {
    return Promise.resolve({ downloadProgress });
  }

  if (message.action === "readCurrentPage") {
    return readCurrentPageInReaderMode();
  }
});

function createContextMenu() {
  browser.contextMenus.removeAll(() => {
    browser.contextMenus.create(
      {
        id: "readText",
        title: "Read Selected Text",
        contexts: ["selection"],
      },
      () => {},
    );
    browser.contextMenus.create(
      {
        id: "readPage",
        title: "Read Current Page in Reader View",
        contexts: ["page"],
      },
      () => {},
    );
  });
}

browser.runtime.onInstalled.addListener(() => {
  createContextMenu();
});

browser.contextMenus.onShown.addListener((info) => {
  createContextMenu();
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "readText" && info.selectionText) {
    processText(info.selectionText);
  }

  if (info.menuItemId === "readPage") {
    readCurrentPageInReaderMode(tab);
  }
});

async function readCurrentPageInReaderMode(tab) {
  try {
    const targetTab = await getTargetTab(tab);

    if (downloadMode) {
      showDownloadProgress(
        isReaderModeTab(targetTab) ? "Reading Reader View..." : "Opening Reader View..."
      );
    }

    if (isReaderInternalUrl(targetTab.url)) {
      const originalUrl = getOriginalUrlFromReaderUrl(targetTab.url);

      if (!originalUrl) {
        throw new Error("Could not find the original page URL from Reader View.");
      }

      if (downloadMode) {
        updateDownloadProgress(1, "Loading original page...");
      }

      const originalTab = await loadTabUrl(targetTab.id, originalUrl);
      const text = await extractReadablePageText(originalTab.id);
      const downloadFilenameBase = originalTab.title;

      if (!text) {
        throw new Error("No readable text was found on the original page.");
      }

      if (downloadMode) {
        updateDownloadProgress(2, "Opening Reader View...");
      }

      await ensureReaderMode(originalTab);
      processText(text, downloadFilenameBase);
      return;
    }

    const fallbackText = isReaderModeTab(targetTab)
      ? ""
      : await extractReadablePageText(targetTab.id).catch(() => "");
    const readerTab = await ensureReaderMode(targetTab);
    let text = "";

    if (downloadMode) {
      updateDownloadProgress(2, "Reading Reader View...");
    }

    try {
      text = await extractReaderText(readerTab.id);
    } catch (error) {
      if (!fallbackText) throw error;
    }

    text = text || fallbackText;
    const readerTitle = await extractReaderTitle(readerTab.id).catch(() => "");
    const downloadFilenameBase = readerTitle || targetTab.title;

    if (!text) {
      throw new Error("No readable text was found in Reader View.");
    }

    processText(text, downloadFilenameBase);
  } catch (error) {
    if (downloadMode) {
      failDownloadProgress(error.message || "Could not read Reader View");
    }
    logError('READER_VIEW', error);
  }
}

async function getTargetTab(tab) {
  if (tab && tab.id) {
    return tab;
  }

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function isReaderModeTab(tab) {
  return Boolean(
    tab && (
      tab.isInReaderMode ||
      isReaderInternalUrl(tab.url)
    )
  );
}

function isReaderInternalUrl(url) {
  return (url || "").startsWith("about:reader");
}

function getOriginalUrlFromReaderUrl(readerUrl) {
  try {
    const queryString = (readerUrl || "").split("?")[1] || "";
    return new URLSearchParams(queryString).get("url") || "";
  } catch (error) {
    return "";
  }
}

function loadTabUrl(tabId, url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let timeoutId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      browser.tabs.onUpdated.removeListener(handleUpdated);
    };

    const handleUpdated = (updatedTabId, changeInfo, updatedTab) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;

      cleanup();
      resolve(updatedTab);
    };

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Original page did not finish loading."));
    }, timeoutMs);

    browser.tabs.onUpdated.addListener(handleUpdated);
    browser.tabs.update(tabId, { url }).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

async function ensureReaderMode(tab) {
  const targetTab = await getTargetTab(tab);

  if (!targetTab || !targetTab.id) {
    throw new Error("No active tab found.");
  }

  if (isReaderModeTab(targetTab)) {
    return targetTab;
  }

  if (targetTab.isArticle === false) {
    throw new Error("Reader View is not available for this page.");
  }

  await browser.tabs.toggleReaderMode(targetTab.id);
  return waitForReaderMode(targetTab.id);
}

function waitForReaderMode(tabId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let timeoutId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      browser.tabs.onUpdated.removeListener(handleUpdated);
    };

    const resolveIfReaderMode = (tab) => {
      if (isReaderModeTab(tab) && tab.status === "complete") {
        cleanup();
        resolve(tab);
      }
    };

    const handleUpdated = (updatedTabId, changeInfo, updatedTab) => {
      if (updatedTabId !== tabId) return;

      if (
        changeInfo.status === "complete" ||
        updatedTab.isInReaderMode ||
        isReaderInternalUrl(updatedTab.url)
      ) {
        browser.tabs.get(tabId).then(resolveIfReaderMode).catch((error) => {
          cleanup();
          reject(error);
        });
      }
    };

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Reader View did not finish loading."));
    }, timeoutMs);

    browser.tabs.onUpdated.addListener(handleUpdated);
    browser.tabs.get(tabId).then(resolveIfReaderMode).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

function executeScriptWithTimeout(tabId, details, timeoutMs = 5000) {
  return Promise.race([
    browser.tabs.executeScript(tabId, details),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Timed out reading Reader View.")), timeoutMs);
    }),
  ]);
}

async function extractReaderText(tabId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const results = await executeScriptWithTimeout(tabId, {
      code: `
        (function() {
          const title =
            document.querySelector('#reader-title') ||
            document.querySelector('.reader-title') ||
            document.querySelector('h1');
          const byline =
            document.querySelector('#reader-credits') ||
            document.querySelector('.reader-byline');
          const article =
            document.querySelector('#moz-reader-content') ||
            document.querySelector('#readability-page-1') ||
            document.querySelector('article') ||
            document.body;

          const titleText = title && title.innerText.trim();
          const bylineText = byline && byline.innerText.trim();
          const articleText = article && article.innerText.trim();
          const parts = [];

          if (titleText) parts.push(titleText);
          if (bylineText) parts.push(bylineText);
          if (articleText) parts.push(articleText);

          return parts.join('\\n\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
        })();
      `,
    });
    const text = results && results[0] ? results[0] : "";

    if (text) {
      return text;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return "";
}

async function extractReaderTitle(tabId) {
  const results = await executeScriptWithTimeout(tabId, {
    code: `
      (function() {
        const title =
          document.querySelector('#reader-title') ||
          document.querySelector('.reader-title') ||
          document.querySelector('h1') ||
          document.querySelector('title');

        return title ? (title.innerText || title.textContent || "").trim() : "";
      })();
    `,
  });

  return results && results[0] ? results[0] : "";
}

async function extractReadablePageText(tabId) {
  const results = await executeScriptWithTimeout(tabId, {
    code: `
      (function() {
        const article =
          document.querySelector('article') ||
          document.querySelector('main') ||
          document.querySelector('[role="main"]') ||
          document.body;
        const title = document.querySelector('h1') || document.querySelector('title');
        const parts = [];
        const titleText = title && (title.innerText || title.textContent || "").trim();
        const articleText = article && article.innerText && article.innerText.trim();

        if (titleText) parts.push(titleText);
        if (articleText) parts.push(articleText);

        return parts.join('\\n\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
      })();
    `,
  });

  return results && results[0] ? results[0] : "";
}

function getTimestampFilenameBase() {
  const now = new Date();
  return now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + '_' +
    String(now.getHours()).padStart(2, '0') + '-' +
    String(now.getMinutes()).padStart(2, '0') + '-' +
    String(now.getSeconds()).padStart(2, '0');
}

function sanitizeWindowsFilename(filenameBase) {
  const sanitized = (filenameBase || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 150);

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
    return "";
  }

  return sanitized;
}

function createDownloadFilename(filenameBase) {
  const safeFilenameBase = sanitizeWindowsFilename(filenameBase);
  return `${safeFilenameBase || `tts-audio-${getTimestampFilenameBase()}`}.mp3`;
}

function notifyDownloadProgress() {
  browser.runtime.sendMessage({
    action: "downloadProgressChanged",
    downloadProgress,
  }).catch(() => {});
}

function openProgressPopup() {
  if (isMobile || !browser.browserAction.openPopup) return;

  browser.browserAction.openPopup().catch((error) => {
    console.error('Failed to open extension popup:', error);
  });
}

function setDownloadProgress(percent, message, active = true, indeterminate = false) {
  const clampedPercent = Math.max(0, Math.min(100, Math.round(percent)));

  downloadProgress = {
    active,
    percent: clampedPercent,
    message,
    indeterminate,
  };

  notifyDownloadProgress();
}

function showDownloadProgress(message = "Preparing download...") {
  setDownloadProgress(0, message);
  openProgressPopup();
}

function updateDownloadProgress(percent, message, indeterminate = false) {
  setDownloadProgress(percent, message, true, indeterminate);
}

function finishDownloadProgress(message = "Download started") {
  setDownloadProgress(100, message, true, false);

  setTimeout(() => {
    if (downloadProgress.message !== message) return;
    setDownloadProgress(100, message, false, false);
  }, 3000);
}

function failDownloadProgress(message = "Download failed") {
  setDownloadProgress(downloadProgress.percent || 0, message, true, false);

  setTimeout(() => {
    if (downloadProgress.message !== message) return;
    setDownloadProgress(downloadProgress.percent || 0, message, false, false);
  }, 5000);
}

function formatByteCount(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function readResponseBlobWithProgress(response, onProgress) {
  const reader = response.body && response.body.getReader && response.body.getReader();

  if (!reader) {
    onProgress(10, "Receiving audio...", true);
    return response.blob();
  }

  const contentLength = Number(response.headers.get("Content-Length"));
  const chunks = [];
  let receivedLength = 0;
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    receivedLength += value.length;
    chunkCount++;

    if (contentLength > 0) {
      const percent = 10 + ((receivedLength / contentLength) * 85);
      onProgress(percent, `Downloading audio... ${Math.min(100, Math.round((receivedLength / contentLength) * 100))}%`);
    } else {
      onProgress(
        50,
        `Receiving audio... ${formatByteCount(receivedLength)} in ${chunkCount} chunks`,
        true,
      );
    }
  }

  return new Blob(chunks, {
    type: response.headers.get("Content-Type") || "audio/mpeg",
  });
}

/**
 * Split text into sentences for processing
 * Handles English (.), Chinese (。), and line breaks (\n)
 * @param {string} text - Text to split
 * @returns {string[]} Array of sentences
 */
function splitTextIntoSentences(text) {
  const sentences = [];
  let match;
  
  while ((match = CONFIG.SENTENCE_REGEX.exec(text)) !== null) {
    const sentence = match[0].trim();
    if (sentence) {
      sentences.push(sentence);
    }
  }
  
  // Reset regex lastIndex for reuse
  CONFIG.SENTENCE_REGEX.lastIndex = 0;
  
  return sentences;
}

/**
 * Play next audio in queue
 * @returns {Promise<void>}
 */
async function playNextAudio() {
  if (isPlaying || audioQueue.length === 0) {
    return;
  }
  
  isPlaying = true;
  setPlaybackState("playing");
  const audioUrl = audioQueue.shift();
  
  try {
    currentAudio = new Audio(audioUrl);
    const storedVolume = (await browser.storage.local.get("outputVolume")).outputVolume ?? CONFIG.DEFAULT_VOLUME;
    currentAudio.volume = storedVolume;
    
    await currentAudio.play();
    
    currentAudio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
      isPlaying = false;
      if (audioQueue.length === 0) {
        setPlaybackState("idle");
      }
      playNextAudio();
    };
    
    currentAudio.onerror = (error) => {
      logError('AUDIO_PLAYBACK', error);
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
      isPlaying = false;
      if (audioQueue.length === 0) {
        setPlaybackState("idle");
      }
      playNextAudio();
    };
  } catch (error) {
    logError('AUDIO_PLAYBACK', error);
    URL.revokeObjectURL(audioUrl);
    isPlaying = false;
    if (audioQueue.length === 0) {
      setPlaybackState("idle");
    }
    playNextAudio();
  }
}

/**
 * Fetch audio for a single sentence
 * @param {string} sentence - Text to convert to speech
 * @param {AbortSignal} signal - Abort signal for cancellation
 * @returns {Promise<string>} Object URL for audio blob
 */
async function fetchSentenceAudio(sentence, signal) {
  const payload = {
    model: model,
    input: sentence,
    voice: voice,
    response_format: "mp3",
    speed: speechSpeed,
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const endpoint = apiUrl.endsWith("/")
    ? apiUrl + "audio/speech"
    : apiUrl + "/audio/speech";

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
      signal: signal,
    });

    if (!response.ok) {
      const error = new Error(`API request failed with status: ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw error; // Don't log aborted requests
    }
    logError('API_REQUEST', error);
    throw error;
  }
}

/**
 * Process selected text and generate speech
 * @param {string} text - Text to convert to speech
 * @param {string} downloadFilenameBase - Optional filename base for download mode
 */
function processText(text, downloadFilenameBase = "") {
  if (!apiUrl) return;

  stopRequested = false;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  pcmStreamStopped = false;
  
  audioQueue.forEach(url => URL.revokeObjectURL(url));
  audioQueue = [];
  isPlaying = false;
  
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }

  if (streamingMode) {
    const payload = {
      model: model,
      input: text,
      voice: voice,
      response_format: "pcm",
      speed: speechSpeed,
    };

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    const endpoint = apiUrl.endsWith("/")
      ? apiUrl + "audio/speech"
      : apiUrl + "/audio/speech";

    const controller = new AbortController();
    currentAbortController = controller;

    setPlaybackState("playing");
    fetch(endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          const error = new Error(`API request failed with status: ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return processPCMStream(response);
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          logError('API_REQUEST', error);
        }
      });
  } 
  else if (downloadMode) {
    if (isMobile) {
      processMobileDownload(text, downloadFilenameBase);
    } else {
      const payload = {
        model: model,
        input: text,
        voice: voice,
        response_format: "mp3",
        speed: speechSpeed,
      };

      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };

      const endpoint = apiUrl.endsWith("/")
        ? apiUrl + "audio/speech"
        : apiUrl + "/audio/speech";

      const controller = new AbortController();
      currentAbortController = controller;

      showDownloadProgress();
      updateDownloadProgress(3, "Sending text to TTS server...");

      fetch(endpoint, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then((response) => {
          if (!response.ok) {
            const error = new Error(`API request failed with status: ${response.status}`);
            error.status = response.status;
            throw error;
          }
          updateDownloadProgress(10, "Receiving audio...");
          return readResponseBlobWithProgress(response, updateDownloadProgress);
        })
        .then(async (blob) => {
          const url = URL.createObjectURL(blob);
          updateDownloadProgress(95, "Starting download...");
          await browser.downloads.download({
            url: url,
            filename: createDownloadFilename(downloadFilenameBase),
            conflictAction: "overwrite",
            saveAs: true
          });
          finishDownloadProgress();
        })
        .catch((error) => {
          if (error.name !== 'AbortError') {
            logError('API_REQUEST', error);
          }
          finishDownloadProgress("Download failed");
        });
    }
  } 
  // split text mode
  else {
    const TEXT_LENGTH_THRESHOLD = CONFIG.TEXT_LENGTH_THRESHOLD;
    
    if (text.length > TEXT_LENGTH_THRESHOLD) {
      const sentences = splitTextIntoSentences(text);
      
      currentAbortController = new AbortController();
      
      const processSentences = async () => {
        for (const sentence of sentences) {
          if (stopRequested) break; 
          
          try {
            const audioUrl = await fetchSentenceAudio(sentence, currentAbortController.signal);
            audioQueue.push(audioUrl);
            playNextAudio(); 
          } catch (error) {
            if (error.name !== 'AbortError') {
              console.error("Error processing sentence:", error);
              // Continue with next sentence instead of stopping completely
            }
          }
        }
        currentAbortController = null;
      };
      
      processSentences();
    } else {
      const payload = {
        model: model,
        input: text,
        voice: voice,
        response_format: "mp3",
        speed: speechSpeed,
      };

      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };

      const endpoint = apiUrl.endsWith("/")
        ? apiUrl + "audio/speech"
        : apiUrl + "/audio/speech";

      const controller = new AbortController();
      currentAbortController = controller;

      fetch(endpoint, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then((response) => {
          if (!response.ok)
            throw new Error(`API request failed with status: ${response.status}`);
          return response.blob();
        })
        .then(async (blob) => {
          const url = URL.createObjectURL(blob);
          currentAudio = new Audio(url);
          const storedVolume = (await browser.storage.local.get("outputVolume")).outputVolume ?? CONFIG.DEFAULT_VOLUME;
          currentAudio.volume = storedVolume;
          setPlaybackState("playing");
          await currentAudio.play();
        })
        .catch((error) => {
          if (error.name !== 'AbortError') {
            logError('API_REQUEST', error);
          }
        });
    }
  }
}

function processMobileDownload(text, downloadFilenameBase = "") {
  if (!apiUrl) return;

  const payload = {
    model: model,
    input: text,
    voice: voice,
    response_format: "mp3",
    speed: speechSpeed,
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const endpoint = apiUrl.endsWith("/")
    ? apiUrl + "audio/speech"
    : apiUrl + "/audio/speech";
  const downloadFilename = createDownloadFilename(downloadFilenameBase);

  browser.tabs.executeScript({
    code: `
      let toast = document.getElementById('tts-download-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'tts-download-toast';
        toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:280px;background:#1f1f1f;color:#ffffff;padding:14px 16px;border:1px solid #00bcd4;border-radius:6px;z-index:10000;font-family:Arial,sans-serif;font-size:14px;box-shadow:0 4px 14px rgba(0,0,0,0.35);pointer-events:none;';
        toast.innerHTML = '<div id="tts-download-message" style="margin-bottom:10px;">Preparing download...</div><div style="width:100%;height:8px;background:#404040;border-radius:999px;overflow:hidden;"><div id="tts-download-progress-bar" style="width:0%;height:100%;background:#00bcd4;transition:width 0.2s ease;"></div></div>';
        document.body.appendChild(toast);
      }
    `
  });

  browser.tabs.query({active: true, currentWindow: true}).then((tabs) => {
    const currentTab = tabs[0];
    
    browser.tabs.executeScript(currentTab.id, {
      code: `
        (async function() {
          try {
            const payload = ${JSON.stringify(payload)};
            const headers = ${JSON.stringify(headers)};
            const endpoint = '${endpoint}';
            const updateProgress = (percent, message) => {
              const messageEl = document.getElementById('tts-download-message');
              const progressEl = document.getElementById('tts-download-progress-bar');
              const clampedPercent = Math.max(0, Math.min(100, Math.round(percent)));
              if (messageEl) messageEl.textContent = message;
              if (progressEl) progressEl.style.width = clampedPercent + '%';
            };
            const readBlobWithProgress = async (response) => {
              const reader = response.body && response.body.getReader && response.body.getReader();
              if (!reader) {
                updateProgress(10, 'Receiving audio...');
                return response.blob();
              }

              const contentLength = Number(response.headers.get('Content-Length'));
              const chunks = [];
              let receivedLength = 0;
              let chunkCount = 0;

              while (true) {
                const result = await reader.read();
                if (result.done) break;

                chunks.push(result.value);
                receivedLength += result.value.length;
                chunkCount++;

                if (contentLength > 0) {
                  const downloadPercent = Math.min(100, Math.round((receivedLength / contentLength) * 100));
                  updateProgress(10 + (downloadPercent * 0.85), 'Downloading audio... ' + downloadPercent + '%');
                } else {
                  updateProgress(10 + ((1 - Math.exp(-chunkCount / 20)) * 80), 'Receiving audio...');
                }
              }

              return new Blob(chunks, {
                type: response.headers.get('Content-Type') || 'audio/mpeg',
              });
            };

            updateProgress(3, 'Sending text to TTS server...');
            
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: headers,
              body: JSON.stringify(payload)
            });
            
            if (!response.ok) {
              throw new Error('API request failed: ' + response.status);
            }
            
            updateProgress(10, 'Receiving audio...');
            const blob = await readBlobWithProgress(response);
            const url = URL.createObjectURL(blob);
            updateProgress(95, 'Starting download...');
            
            const link = document.createElement('a');
            link.href = url;
            link.download = ${JSON.stringify(downloadFilename)};
            link.style.display = 'none';
            document.body.appendChild(link);
            
            link.click();
            
            setTimeout(() => {
              URL.revokeObjectURL(url);
              link.remove();
            }, 1000);
            
            updateProgress(100, 'Download started');
            setTimeout(() => {
              const toast = document.getElementById('tts-download-toast');
              if (toast) toast.remove();
            }, 2000);
            
          } catch (error) {
            const messageEl = document.getElementById('tts-download-message');
            const progressEl = document.getElementById('tts-download-progress-bar');
            if (messageEl) messageEl.textContent = 'Download failed: ' + error.message;
            if (progressEl) progressEl.style.background = '#ff5252';
            
            setTimeout(() => {
              const toast = document.getElementById('tts-download-toast');
              if (toast) toast.remove();
            }, 3000);
          }
        })();
      `
    });
  });
}

/**
 * Process PCM audio stream for low-latency playback
 * @param {Response} response - Fetch response with PCM stream
 * @returns {Promise<void>}
 */
async function processPCMStream(response) {
  const sampleRate = CONFIG.PCM_SAMPLE_RATE;
  const numChannels = CONFIG.PCM_NUM_CHANNELS;
  setPlaybackState("playing");

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  audioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: sampleRate,
  });

  const storedVolume = (await browser.storage.local.get("outputVolume")).outputVolume ?? CONFIG.DEFAULT_VOLUME;
  gainNode = audioContext.createGain();
  gainNode.gain.value = storedVolume;
  gainNode.connect(audioContext.destination);

  pcmStreamStopped = false;
  pcmPlaybackTime = audioContext.currentTime;

  const reader = response.body.getReader();
  let leftover = new Uint8Array(0);

  async function readAndPlay() {
    while (!pcmStreamStopped) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (!audioContext) break;

      let pcmData = new Uint8Array(leftover.length + value.length);
      pcmData.set(leftover, 0);
      pcmData.set(value, leftover.length);

      const bytesPerSample = CONFIG.PCM_BYTES_PER_SAMPLE;
      const totalSamples = Math.floor(
        pcmData.length / bytesPerSample / numChannels,
      );
      const usableBytes = totalSamples * bytesPerSample * numChannels;

      const usablePCM = pcmData.slice(0, usableBytes);
      leftover = pcmData.slice(usableBytes);

      const audioBuffer = audioContext.createBuffer(
        numChannels,
        totalSamples,
        sampleRate,
      );

      for (let channel = 0; channel < numChannels; channel++) {
        const channelData = audioBuffer.getChannelData(channel);
        for (let i = 0; i < totalSamples; i++) {
          const index = (i * numChannels + channel) * bytesPerSample;
          const sample = (usablePCM[index + 1] << 8) | usablePCM[index];
          channelData[i] =
            (sample & 0x8000 ? sample | ~0xffff : sample) / 32768;
        }
      }

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNode);
      
      const now = audioContext.currentTime;
      if (pcmPlaybackTime < now) {
        pcmPlaybackTime = now;
      }
      source.start(pcmPlaybackTime);
      pcmPlaybackTime += audioBuffer.duration;

      source.onended = () => {
        source.disconnect();
      };
    }
    leftover = new Uint8Array(0);
  }

  try {
    await readAndPlay();
  } catch (error) {
    if (error.name !== 'AbortError') {
      logError('AUDIO_PLAYBACK', error);
    }
  }
}
