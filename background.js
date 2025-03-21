// Recording state
let recording = null;
let currentTabId = null;
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
  
  // Update the extension badge to indicate recording is in progress
  chrome.action.setBadgeText({ text: "REC" });
  chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
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
    
    // Safer logging that checks if element exists
    console.log('[Background] Added interaction:', {
      id: interaction.id || 'unknown',
      type: interaction.type || 'unknown',
      // Only log element info if it exists
      ...(interaction.element ? {
        element: interaction.element.tagName,
        text: interaction.element.textContent?.substring(0, 30)
      } : {})
    });
    
    saveRecording();
  } catch (error) {
    console.error('[Background] Error adding interaction:', error);
  }
}

// Simplified screenshot capture function
async function captureAndUploadScreenshot(tabId, sessionId, interactionId) {
  try {
    // Capture the visible tab
    const dataUrl = await chrome.tabs.captureVisibleTab(
      null, // Use current window
      { format: 'png', quality: 80 } // Reduced quality to save space
    );
    
    // For now, let's store the screenshot directly in the recording
    // We'll skip Supabase integration to simplify
    return {
      success: true,
      screenshotUrl: dataUrl,  // Just store the data URL directly for now
      width: 0,
      height: 0
    };
  } catch (error) {
    console.error('[Screenshot Service] Error:', error);
    return {
      success: false,
      error: error.message
    };
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
  
  // Clear the badge when recording stops
  chrome.action.setBadgeText({ text: "" });
}

// New function to update an interaction with screenshot information
function updateInteractionWithScreenshot(interactionId, screenshotInfo) {
  if (!recording) {
    console.warn('[Background] Attempted to update interaction without active recording');
    return false;
  }
  
  try {
    // Find the interaction by ID
    const interactionIndex = recording.interactions.findIndex(i => i.id === interactionId);
    
    if (interactionIndex === -1) {
      console.warn('[Background] Interaction not found:', interactionId);
      return false;
    }
    
    // Update the interaction with screenshot info
    recording.interactions[interactionIndex].screenshot = screenshotInfo;
    recording.lastUpdated = new Date().toISOString();
    
    console.log('[Background] Updated interaction with screenshot:', interactionId);
    saveRecording();
    return true;
  } catch (error) {
    console.error('[Background] Error updating interaction:', error);
    return false;
  }
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
    // Add new handler for screenshot requests
    else if (message.type === 'take-screenshot') {
      // We need to send an immediate response and then handle the screenshot asynchronously
      sendResponse({ status: 'processing' });
      
      // Process the screenshot capture and upload
      captureAndUploadScreenshot(
        sender.tab.id, 
        recording.id, 
        message.interactionId
      ).then(result => {
        // Send the result back to the content script
        chrome.tabs.sendMessage(sender.tab.id, {
          action: 'screenshot-result',
          interactionId: message.interactionId,
          result: result
        });
      });
      
      return true; // Keep the message channel open for the async response
    }
    else if (message.type === 'recording-stopped') {
      console.log('[Background] Stopping recording and triggering export...');
      const exported = exportRecording();
      
      // Clear tab tracking
      contentScripts = {};
      
      // Clear recording
      clearRecording();
      
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
    else if (message.type === 'update-interaction') {
      const updated = updateInteractionWithScreenshot(message.interactionId, message.screenshot);
      sendResponse({ status: updated ? 'updated' : 'failed' });
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