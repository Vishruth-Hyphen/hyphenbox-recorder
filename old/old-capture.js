import { CONFIG } from './config.js';

let captures = [];
let audioRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let deepgramSocket = null;
let timeline = [];
let userData = null;
let session_id = null;
let audioContext = null;
let audioProcessor = null;

// Keep track of the last interim result
// let lastInterimResult = '';

// // Add to global variables
// let lastTranscriptTime = null;
// const TRANSCRIPT_COMBINE_THRESHOLD = 2000; // 2 seconds
// let pendingTranscript = '';

const MAX_BASE64_IMAGES = 2;
let screenshotCache = new Map(); // timestamp -> base64

// Add these variables at the top with other state variables
let lastTranscriptTimestamp = null;
const TRANSCRIPT_MERGE_THRESHOLD = 1500; // 1.5 seconds
let currentTranscriptDiv = null;

document.addEventListener('DOMContentLoaded', async () => {
    const startBtn = document.getElementById('startRecording');
    const stopBtn = document.getElementById('stopRecording');
    const capturesList = document.getElementById('capturesList');

    // Initially hide stop button and disable start button
    stopBtn.style.display = 'none';
    startBtn.disabled = true; // Disable until auth check completes

    // Add this function to update profile UI
    function updateProfileUI(userData) {
        const profileElement = document.getElementById('userProfile');
        if (userData && profileElement) {
            profileElement.innerHTML = `
                ${userData.avatar ? `<img src="${userData.avatar}" alt="Profile">` : ''}
                <span class="user-email">${userData.email}</span>
            `;
        }
    }

    // Check for existing auth first
    chrome.storage.local.get(['userData'], async (result) => {
        if (result.userData) {
            userData = result.userData;
            console.log('Existing user data found:', userData);
            updateProfileUI(userData);
            enableRecordingControls();
        } else {
            // No stored user data, check with background script
            chrome.runtime.sendMessage({ type: 'GET_USER_DATA' }, async (response) => {
                if (response && response.userData) {
                    userData = response.userData;
                    // Store for future sessions
                    await chrome.storage.local.set({ userData });
                    console.log('User data received and stored:', userData);
                    updateProfileUI(userData);
                    enableRecordingControls();
                } else {
                    console.log('No user data found, redirecting to auth');
                    // Open auth in new tab
                    window.open(CONFIG.AUTH_URL, '_blank');
                    // Close the side panel
                    window.close();
                }
            });
        }
    });
});

// Helper function to enable recording controls
function enableRecordingControls() {
    const startBtn = document.getElementById('startRecording');
    startBtn.disabled = false;
    startBtn.addEventListener('click', startCapture);
    document.getElementById('stopRecording').addEventListener('click', stopCapture);
    document.getElementById('status').textContent = 'Ready to record';
}

async function startCapture() {
    try {
        console.log("Starting capture with user data:", userData);
        
        // Create session first
        const response = await fetch(`${CONFIG.API_URL}/api/session/init`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userData.accessToken}`
            },
            body: JSON.stringify({
                user_id: userData.userId,
                metadata: {
                    startTime: Date.now(),
                    title: 'Recording in progress...'
                }
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Failed to create session: ${errorData.detail || response.statusText}`);
        }

        const { session_id: newSessionId } = await response.json();
        session_id = newSessionId;  // Store in memory
        
        // Store in chrome.storage.local
        await chrome.storage.local.set({ current_session_id: newSessionId });

        // ADD TRANSCRIPTION CODE HERE - After session creation
        console.log("[Transcription] Setting up audio capture");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        console.log("[Transcription] Initializing Deepgram");
        deepgramSocket = new WebSocket(
            'wss://api.deepgram.com/v1/listen?' + 
            new URLSearchParams({
                model: CONFIG.RECORDING.DEEPGRAM.MODEL,
                language: CONFIG.RECORDING.DEEPGRAM.LANGUAGE,
                encoding: 'linear16',
                sample_rate: 48000,
                channels: 1,
                interim_results: true
            }), 
            ['token', CONFIG.RECORDING.DEEPGRAM.API_KEY]
        );

        deepgramSocket.onopen = async () => {
            console.log('[Transcription] Deepgram connected');
            audioContext = new AudioContext();
            await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audioProcessor.js'));
            
            const source = audioContext.createMediaStreamSource(stream);
            audioProcessor = new AudioWorkletNode(audioContext, 'audio-processor');
            
            audioProcessor.port.onmessage = (event) => {
                if (deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
                    console.log('[Transcription] Sending audio data to Deepgram');
                    deepgramSocket.send(event.data);
                } else {
                    console.log('[Transcription] WebSocket not ready:', 
                        deepgramSocket ? deepgramSocket.readyState : 'no socket');
                }
            };

            source.connect(audioProcessor);
            console.log('[Transcription] Audio processing pipeline established');
        };

        deepgramSocket.onmessage = async (event) => {
            console.log('[Transcription] Raw response from Deepgram:', event.data);
            try {
                const result = JSON.parse(event.data);
                const transcript = result.channel?.alternatives?.[0]?.transcript;
                
                if (!transcript) return;
                
                const currentTimestamp = Date.now() - recordingStartTime;
                
                if (lastTranscriptTimestamp && 
                    currentTimestamp - lastTranscriptTimestamp < TRANSCRIPT_MERGE_THRESHOLD && 
                    currentTranscriptDiv) {
                    // Update existing transcript in UI
                    updateTranscriptInTimeline(currentTranscriptDiv, transcript, result.is_final);
                    
                    // If this is a final version, upload it
                    if (result.is_final) {
                        await uploadTranscript({
                            session_id: session_id,
                            timestamp: currentTimestamp,
                            narration: transcript,
                            metadata: {
                                type: 'speech',
                                confidence: result.channel?.alternatives?.[0]?.confidence
                            }
                        });
                    }
                } else {
                    // Create new transcript item in UI
                    currentTranscriptDiv = addTranscriptToTimeline(transcript, currentTimestamp, result.is_final);
                    lastTranscriptTimestamp = currentTimestamp;
                    
                    // If this is a final version, upload it
                    if (result.is_final) {
                        await uploadTranscript({
                            session_id: session_id,
                            timestamp: currentTimestamp,
                            narration: transcript,
                            metadata: {
                                type: 'speech',
                                confidence: result.channel?.alternatives?.[0]?.confidence
                            }
                        });
                    }
                }
            } catch (error) {
                console.error('[Transcription] Error parsing response:', error);
            }
        };

        deepgramSocket.onerror = (error) => {
            console.error('[Transcription] WebSocket error:', error);
        };

        // Start audio recording (for saving audio file)
        audioRecorder = new MediaRecorder(stream);
        recordingStartTime = Date.now();
        
        audioRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };
        
        audioRecorder.start(1000); // Collect audio in 1-second chunks
        console.log('Audio recording started');
        
        // Get all tabs and filter for valid URLs
        const tabs = await chrome.tabs.query({});
        const validTabs = tabs.filter(tab => 
            tab.url && (tab.url.startsWith('http') || tab.url.startsWith('https'))
        );
        
        // Request content script injection with updated configuration
        await chrome.runtime.sendMessage({
            type: 'START_CAPTURE',
            tabs: validTabs.map(tab => tab.id),
            config: {
                captureModifiedClicks: true,
                preventNavigation: true
            },
            session_id: session_id
        });

        // Update UI
        document.getElementById('startRecording').style.display = 'none';
        document.getElementById('stopRecording').style.display = 'block';
        document.getElementById('status').textContent = 'Recording...';
        captures = []; // Reset captures for new session

    } catch (err) {
        console.error('Failed to start capture:', err);
        document.getElementById('status').textContent = 'Failed to start capture - Please check permissions';
    }
}

async function stopCapture() {
    try {
        console.log('[stopCapture] Starting stop sequence...');
        
        // Add transcription cleanup
        console.log('[Transcription] Cleaning up transcription');
        if (deepgramSocket) {
            deepgramSocket.close();
        }
        if (audioProcessor) {
            audioProcessor.disconnect();
        }
        if (audioContext) {
            await audioContext.close();
        }
        // document.getElementById('transcriptionArea').textContent = '';
        
        const stopBtn = document.getElementById('stopRecording');
        stopBtn.disabled = true;
        stopBtn.innerHTML = 'Stopping Recording <span class="loading-spinner"></span>';
        document.body.classList.add('processing');

        // 2. Stop audio recording
        console.log('[stopCapture] Stopping audio recording...');
        if (audioRecorder && audioRecorder.state === 'recording') {
            audioRecorder.stop();
            audioRecorder.stream.getTracks().forEach(track => track.stop());
        }

        // 3. Get current session ID
        const { current_session_id } = await chrome.storage.local.get(['current_session_id']);
        console.log('[stopCapture] Current session ID:', current_session_id);

        if (!current_session_id) {
            throw new Error('No active session found');
        }

        // 4. Call API to mark session as completed
        console.log('[stopCapture] Setting session status: completed');
        const response = await fetch(`${CONFIG.API_URL}/api/session/complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userData.accessToken}`
            },
            body: JSON.stringify({
                session_id: current_session_id,
                status: 'completed'
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Failed to complete session: ${errorData.detail || response.statusText}`);
        }

        // 5. Send cleanup message to background script
        console.log('[stopCapture] Sending final cleanup message...');
        await chrome.runtime.sendMessage({
            type: 'STOP_AND_REDIRECT',
            dashboard_url: `${CONFIG.DASHBOARD_URL}/walkthroughs`
        });

        console.log('[stopCapture] Cleanup complete, closing panel...');
        window.close(); // This is the key addition - the panel closes itself
        
        // Clear screenshot cache when recording stops
        screenshotCache.clear();
        
        // Update UI
        document.getElementById('startRecording').style.display = 'block';
        document.getElementById('stopRecording').style.display = 'none';
        document.getElementById('status').textContent = 'Ready to record';

    } catch (error) {
        console.error('[stopCapture] Error:', error);
        const stopBtn = document.getElementById('stopRecording');
        if (stopBtn) {
            stopBtn.disabled = false;
            stopBtn.innerHTML = 'Stop Recording';
        }
        document.getElementById('status').textContent = 'Failed to stop recording';
        document.body.classList.remove('processing');
    }
}

// Listen for new captures
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CAPTURE_IMMEDIATE') {
        // Show the image immediately using base64
        const timelineItem = {
            type: 'screenshot',
            timestamp: message.data.timestamp,
            coordinates: message.data.coordinates,
            url: message.data.url,
            base64Image: message.data.base64Image,
            status: 'uploading'
        };
        updateTimelineView(timelineItem);
    } 
    else if (message.type === 'CAPTURE_UPLOADED') {
        // Just update the upload status
        const itemDiv = document.getElementById(`capture-${message.data.timestamp}`);
        if (itemDiv) {
            const status = itemDiv.querySelector('.upload-status');
            if (status) {
                status.textContent = 'Uploaded';
                status.classList.remove('uploading');
                status.classList.add('uploaded');
            }
            // Store the URL as data attribute but keep showing base64
            itemDiv.setAttribute('data-image-url', message.data.image_url);
        }
    } else if (message.type === 'CAPTURE_STARTED') {
        updateTimelineView(message.data);
    } else if (message.type === 'CAPTURE_SAVED') {
        // Update existing timeline item with image
        const itemDiv = document.getElementById(`capture-${message.data.timestamp}`);
        if (itemDiv) {
            const container = itemDiv.querySelector('.screenshot-container');
            container.innerHTML = `<img src="${message.data.image_url}" alt="Screenshot">`;
        }
    } else if (message.type === 'AUDIO_RECORDING_COMPLETE') {
        console.log('Audio recording complete:', message.data);
        captures.push({
            type: 'audio',
            ...message.data
        });
    } else if (message.type === 'AUTH_SUCCESS') {
        console.log('Received auth success message:', message); // Debug log
        userData = message.userData;
        updateProfileUI(userData);
        // Store user data for future sessions
        chrome.storage.local.set({ userData });
        enableRecordingControls();
    }
});

function updateTimelineView(item) {
    if (!item || typeof item.timestamp === 'undefined') {
        console.error('Invalid item for timeline:', item);
        return;
    }
    
    const timelineContainer = document.getElementById('capturesList');
    const itemDiv = document.createElement('div');
    itemDiv.className = `timeline-item screenshot`;
    itemDiv.id = `capture-${item.timestamp}`;
    
    itemDiv.innerHTML = `
        <div class="screenshot-item">
            <div class="timestamp">${formatTimestamp(item.timestamp)}</div>
            <div class="screenshot-container">
                <img src="${item.base64Image}" alt="Screenshot">
                <div class="upload-status ${item.status || ''}">${item.status === 'uploading' ? 'Uploading...' : ''}</div>
            </div>
            <div class="metadata">
                Click at (${item.coordinates.x}, ${item.coordinates.y})
                <br>
                URL: ${item.url}
            </div>
        </div>
    `;
    
    timelineContainer.appendChild(itemDiv);
    timelineContainer.scrollTop = timelineContainer.scrollHeight;
}

function formatTimestamp(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

async function downloadCaptures() {
    // Create FormData for multipart upload
    const formData = new FormData();
    
    // Prepare walkthrough data without base64 images
    const walkthroughData = {
        metadata: {
            recordingStartTime: recordingStartTime,
            recordingDuration: Date.now() - recordingStartTime,
            totalSteps: timeline.length,
            projectName: CONFIG.UI.DEFAULT_PROJECT_NAME,
            createdAt: new Date().toISOString()
        },
        steps: await Promise.all(timeline.map(async (item, index) => {
            const baseStep = {
                stepNumber: index + 1,
                timestamp: item.timestamp,
                formattedTime: formatTimestamp(item.timestamp),
                type: item.type
            };

            if (item.type === 'transcript') {
                return {
                    ...baseStep,
                    narration: item.content,
                };
            } else if (item.type === 'screenshot') {
                // Generate unique filename for this screenshot
                const filename = `screenshot-${Date.now()}-${index}.png`;
                
                // Convert base64 to blob and add to FormData
                const imageBlob = await fetch(item.content.base64).then(r => r.blob());
                formData.append('files', imageBlob, filename);

                return {
                    ...baseStep,
                    screenshotFilename: filename, // Reference to the file
                    action: {
                        type: 'click',
                        coordinates: item.metadata.coordinates,
                        url: item.metadata.url
                    }
                };
            }
            return baseStep;
        }))
    };

    // Add the JSON data to FormData
    formData.append('data', JSON.stringify(walkthroughData));

    // For now, just download as JSON for testing
    const jsonData = JSON.stringify(walkthroughData, null, 2);
    const jsonBlob = new Blob([jsonData], {type: 'application/json'});
    const jsonUrl = URL.createObjectURL(jsonBlob);
    
    const jsonLink = document.createElement('a');
    jsonLink.href = jsonUrl;
    jsonLink.download = `walkthrough-${Date.now()}.json`;
    jsonLink.click();
    
    URL.revokeObjectURL(jsonUrl);

    /* When we have an API, we'd do something like:
    
    try {
        const response = await fetch('https://api.example.com/walkthroughs', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        console.log('Walkthrough uploaded:', result);
    } catch (error) {
        console.error('Failed to upload walkthrough:', error);
    }
    */
}

async function uploadScreenshot(data, sessionId) {
    try {
        const formData = new FormData();
        const blob = await fetch(data.screenshot).then(r => r.blob());
        formData.append('screenshot', blob);
        
        // These need to be sent as form fields, not JSON
        formData.append('session_id', sessionId);
        formData.append('step_number', timeline.length + 1);
        formData.append('timestamp', data.timestamp);
        formData.append('formatted_time', formatTimestamp(data.timestamp));
        formData.append('caption', `Click at ${data.coordinates.x}, ${data.coordinates.y}`);

        const response = await fetch(`${CONFIG.API_URL}/api/screenshot/upload`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${userData.accessToken}`
            },
            body: formData
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Screenshot upload failed: ${errorData.detail}`);
        }

        const { image_url } = await response.json();
        
        // Update timeline item with URL
        const timelineItem = timeline.find(item => 
            item.type === 'screenshot' && 
            item.timestamp === data.timestamp
        );
        if (timelineItem) {
            timelineItem.content.url = image_url;
        }
    } catch (error) {
        console.error('Failed to upload screenshot:', error);
    }
}

function addTranscriptToTimeline(text, timestamp, isFinal) {
    const timelineContainer = document.getElementById('capturesList');
    const itemDiv = document.createElement('div');
    itemDiv.className = `timeline-item transcript ${isFinal ? 'final' : 'interim'}`;
    itemDiv.id = `transcript-${timestamp}`;
    
    itemDiv.innerHTML = `
        <div class="transcript-item">
            <div class="timestamp">${formatTimestamp(timestamp)}</div>
            <div class="transcript-content">${text}</div>
            ${!isFinal ? '<div class="interim-indicator">...</div>' : ''}
        </div>
    `;
    
    timelineContainer.appendChild(itemDiv);
    timelineContainer.scrollTop = timelineContainer.scrollHeight;
    return itemDiv;
}

function updateTranscriptInTimeline(itemDiv, text, isFinal) {
    const contentDiv = itemDiv.querySelector('.transcript-content');
    contentDiv.textContent = text;
    
    if (isFinal) {
        itemDiv.classList.remove('interim');
        itemDiv.classList.add('final');
        const indicator = itemDiv.querySelector('.interim-indicator');
        if (indicator) indicator.remove();
    }
}

async function uploadTranscript(transcriptData) {
    try {
        const response = await fetch(`${CONFIG.API_URL}/api/transcript/upload`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userData.accessToken}`
            },
            body: JSON.stringify(transcriptData)
        });

        if (!response.ok) {
            throw new Error(`Failed to upload transcript: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('[Transcription] Upload successful:', data);
        
        // Update UI to show upload success if needed
        if (currentTranscriptDiv) {
            currentTranscriptDiv.classList.add('uploaded');
        }

    } catch (error) {
        console.error('[Transcription] Upload failed:', error);
        // Could add retry logic here if needed
    }
}