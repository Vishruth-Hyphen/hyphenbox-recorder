document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('start-recording');
  const stopBtn = document.getElementById('stop-recording');
  const notRecordingDiv = document.getElementById('not-recording');
  const recordingDiv = document.getElementById('recording');
  const countSpan = document.getElementById('interaction-count');

  // Check if currently recording
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: 'get-status' }, (response) => {
      if (response && response.isRecording) {
        notRecordingDiv.style.display = 'none';
        recordingDiv.style.display = 'block';
        countSpan.textContent = response.interactionCount;
      }
    });
  });

  // Start recording
  startBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: 'start-recording' }, () => {
        notRecordingDiv.style.display = 'none';
        recordingDiv.style.display = 'block';
      });
    });
  });

  // Stop recording and download
  stopBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: 'stop-recording' });
      notRecordingDiv.style.display = 'block';
      recordingDiv.style.display = 'none';
    });
  });
}); 