document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('start-recording');
  const stopBtn = document.getElementById('stop-recording');
  const notRecordingDiv = document.getElementById('not-recording');
  const recordingDiv = document.getElementById('recording');
  const countSpan = document.getElementById('interaction-count');
  const popupInfo = document.getElementById('popup-info');
  const errorInfo = document.getElementById('error-info');

  // Check if currently recording
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) return;
    
    // First check if we can access this tab
    const currentUrl = tabs[0].url || '';
    if (currentUrl.startsWith('chrome://') || 
        currentUrl.startsWith('chrome-extension://') || 
        currentUrl.startsWith('about:')) {
      // We can't inject content scripts into these pages
      if (errorInfo) {
        errorInfo.textContent = "Recording isn't available on this page. Please navigate to a regular website.";
        errorInfo.style.display = 'block';
      }
      startBtn.disabled = true;
      return;
    }
    
    // Try to get status, but handle the case where content script isn't ready
    try {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'get-status' }, (response) => {
        if (chrome.runtime.lastError) {
          console.log('Error connecting to the page:', chrome.runtime.lastError.message);
          // Don't show an error, this is normal when first loading
          return;
        }
        
        if (response && response.isRecording) {
          notRecordingDiv.style.display = 'none';
          recordingDiv.style.display = 'block';
          countSpan.textContent = response.interactionCount;
        }
      });
    } catch (err) {
      console.error("Error checking recording status:", err);
    }
  });

  // Start recording
  startBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) return;
      
      try {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'start-recording' }, (response) => {
          if (chrome.runtime.lastError) {
            console.log('Error starting recording:', chrome.runtime.lastError.message);
            if (errorInfo) {
              errorInfo.textContent = "Couldn't start recording. Try reloading the page first.";
              errorInfo.style.display = 'block';
            }
            return;
          }
          
          notRecordingDiv.style.display = 'none';
          recordingDiv.style.display = 'block';
          
          // Add notification that popup will close when clicking outside
          if (popupInfo) {
            popupInfo.textContent = "Note: This popup will close when you click on the page. Recording will continue in the background.";
            popupInfo.style.display = 'block';
          }
          
          if (errorInfo) {
            errorInfo.style.display = 'none';
          }
        });
      } catch (err) {
        console.error("Error starting recording:", err);
      }
    });
  });

  // Stop recording and download
  stopBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) return;
      
      try {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'stop-recording' }, (response) => {
          if (chrome.runtime.lastError) {
            console.log('Error stopping recording:', chrome.runtime.lastError.message);
            // We still want to reset the UI even if there's an error
          }
          
          notRecordingDiv.style.display = 'block';
          recordingDiv.style.display = 'none';
          
          if (errorInfo) {
            errorInfo.style.display = 'none';
          }
        });
      } catch (err) {
        console.error("Error stopping recording:", err);
        notRecordingDiv.style.display = 'block';
        recordingDiv.style.display = 'none';
      }
    });
  });
}); 