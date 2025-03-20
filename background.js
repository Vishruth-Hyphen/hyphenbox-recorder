// Recording state
let recording = null;
let currentTabId = null;

// Add this to track content scripts across pages
let contentScripts = {}; // Track which tabs have content scripts

console.log('[Background] Service worker initialized');

// Initialize recording state
function initializeRecording(sessionId, startTime, url, title) {
  console.log('[Background] Initializing recording:', sessionId);
  recording = {
    id: sessionId,
    startTime: startTime,
    lastUpdated: new Date().toISOString(),
    interactions: [],
    initialPage: {
      url: url,
      title: title
    }
  };
}

// Add an interaction to the recording
function addInteraction(interaction) {
  if (!recording) {
    console.warn('[Background] Attempted to add interaction without active recording');
    return;
  }
  
  try {
    recording.interactions.push(interaction);
    recording.lastUpdated = new Date().toISOString();
    console.log('[Background] Added interaction:', {
      type: interaction.type,
      element: interaction.element.tagName,
      text: interaction.element.textContent.substring(0, 30)
    });
    saveRecording();
  } catch (error) {
    console.error('[Background] Error adding interaction:', error);
  }
}

// Save recording to Chrome storage
function saveRecording() {
  if (!recording) return;
  
  chrome.storage.local.set({ 
    currentRecording: recording 
  }, () => {
    console.log('Recording saved to Chrome storage');
  });
}

// Export recording as JSON file
function exportRecording() {
  if (!recording) {
    console.warn('[Background] Attempted to export without active recording');
    return false;
  }
  
  try {
    console.log('[Background] Preparing recording for export...');
    const recordingData = { 
      recording: {
        id: recording.id,
        startTime: recording.startTime,
        lastUpdated: recording.lastUpdated,
        interactions: recording.interactions
      }
    };
    
    // Convert the recording data to a data URL
    const jsonString = JSON.stringify(recordingData, null, 2);
    const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonString);
    
    chrome.downloads.download({
      url: dataUrl,
      filename: `session-${recording.id}.json`,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[Background] Download failed:', chrome.runtime.lastError);
        return false;
      }
      console.log('[Background] Recording downloaded successfully, id:', downloadId);
      return true;
    });
    return true;
  } catch (error) {
    console.error('[Background] Error exporting recording:', error);
    return false;
  }
}

// Clear current recording
function clearRecording() {
  recording = null;
  chrome.storage.local.remove('currentRecording');
}

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] Received message:', message.type);
  
  try {
    if (message.type === 'recording-started') {
      initializeRecording(message.sessionId, message.startTime, message.url, message.title);
      
      // Track this tab as having an active content script
      if (sender.tab && sender.tab.id) {
        contentScripts[sender.tab.id] = true;
      }
      
      sendResponse({ status: 'initialized' });
    } 
    else if (message.type === 'interaction') {
      addInteraction(message.data);
      sendResponse({ status: 'saved' });
    }
    else if (message.type === 'recording-stopped') {
      console.log('[Background] Stopping recording and triggering export...');
      const exported = exportRecording();
      
      // Clear tab tracking
      contentScripts = {};
      
      recording = null; // Clear the recording after export
      sendResponse({ 
        status: exported ? 'exported' : 'export-failed',
        message: exported ? 'Recording exported successfully' : 'Failed to export recording'
      });
    }
    else if (message.type === 'get-recording-state') {
      // New handler to support content script reconnections
      if (recording) {
        sendResponse({ 
          isRecording: true, 
          interactionCount: recording.interactions.length 
        });
        
        // Track this tab
        if (sender.tab && sender.tab.id) {
          contentScripts[sender.tab.id] = true;
        }
      } else {
        sendResponse({ isRecording: false });
      }
    }
  } catch (error) {
    console.error('[Background] Error handling message:', error);
    sendResponse({ error: error.message });
  }
  return true;
});

// Load any existing recording from storage when the extension starts
chrome.storage.local.get('currentRecording', (data) => {
  if (data.currentRecording) {
    recording = data.currentRecording;
    console.log('Loaded existing recording:', recording.id);
  }
}); 