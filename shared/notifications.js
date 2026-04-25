/**
 * User notification utilities
 */

/**
 * Show a toast notification to the user
 * @param {string} message - Message to display
 * @param {string} type - Type of toast (success, error, info)
 * @param {number} duration - Duration in milliseconds
 */
function showToast(message, type = 'info', duration = CONFIG.TOAST_DURATION) {
  const style = TOAST_STYLES.base + TOAST_STYLES[type];
  
  browser.tabs.query({active: true, currentWindow: true}).then((tabs) => {
    if (tabs.length === 0) return;
    
    browser.tabs.executeScript(tabs[0].id, {
      code: `
        (function() {
          const toast = document.createElement('div');
          toast.textContent = ${JSON.stringify(message)};
          toast.style.cssText = ${JSON.stringify(style)};
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), ${duration});
        })();
      `
    }).catch(error => {
      console.error('Failed to show toast:', error);
    });
  });
}

/**
 * Log error with context and show user notification
 * @param {string} context - Where the error occurred
 * @param {Error} error - The error object
 * @param {boolean} showUser - Whether to show a toast to the user
 */
function logError(context, error, showUser = true) {
  const message = `[${context}] ${error.message || error}`;
  console.error(message, error);
  
  if (showUser) {
    const userMessage = getUserFriendlyError(context, error);
    showToast(userMessage, 'error', CONFIG.ERROR_TOAST_DURATION);
  }
}

/**
 * Convert technical errors to user-friendly messages
 * @param {string} context - Where the error occurred
 * @param {Error} error - The error object
 * @returns {string} User-friendly error message
 */
function getUserFriendlyError(context, error) {
  const errorStr = error.message || String(error);
  
  if (errorStr.includes('Failed to fetch') || errorStr.includes('NetworkError')) {
    return 'Cannot connect to TTS server. Check your API URL.';
  }
  
  if (errorStr.includes('401') || errorStr.includes('403')) {
    return 'Authentication failed. Check your API key.';
  }
  
  if (errorStr.includes('404')) {
    return 'TTS endpoint not found. Check your API URL.';
  }
  
  if (errorStr.includes('429')) {
    return 'Too many requests. Please wait a moment.';
  }
  
  if (errorStr.includes('500') || errorStr.includes('502') || errorStr.includes('503')) {
    return 'TTS server error. Please try again later.';
  }
  
  switch (context) {
    case 'API_REQUEST':
      return 'Failed to generate audio. Check your settings.';
    case 'AUDIO_PLAYBACK':
      return 'Failed to play audio. Please try again.';
    case 'READER_VIEW':
      return errorStr;
    case 'STORAGE':
      return 'Failed to save settings. Please try again.';
    default:
      return 'An error occurred. Please try again.';
  }
}
