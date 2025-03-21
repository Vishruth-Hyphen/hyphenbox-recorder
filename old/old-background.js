import { CONFIG } from './config.js';

console.log('VoxiGuide: Background script loaded');

let recordingTabId = null; // Track which tab we're recording
let isCapturing = false;
let capturedTabs = new Set();
let audioRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let userData = null;

// Add installation and update handler
chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('VoxiGuide: Extension installed/updated');
    // await chrome.storage.local.set({ userData: null });
    await checkAndHandleAuth();
});
chrome.runtime.onStartup.addListener(async (details) => {
    console.log('VoxiGuide: Extension installed/updated');
    await checkAndHandleAuth();
});

// Add this near the top of your background.js after imports
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Failed to set panel behavior:', error));

// Add this function to check token expiration
function isTokenExpired(token) {
    try {
        const tokenData = JSON.parse(atob(token.split('.')[1]));
        const currentTime = Math.floor(Date.now() / 1000);
        return tokenData.exp <= currentTime;
    } catch (error) {
        console.error('Error parsing token:', error);
        return true; // Assume expired if we can't parse
    }
}

// Modify the checkAndHandleAuth function
async function checkAndHandleAuth() {
    try {
        const { userData } = await chrome.storage.local.get(['userData']);
        console.log('User data:', userData);
        
        if (userData && userData.accessToken) {
            // Check if token is expired
            if (isTokenExpired(userData.accessToken)) {
                console.log('Token expired, clearing session');
                await chrome.storage.local.remove(['userData']);
                return false;
            }
            return true;
        }
        
        // No stored auth, open auth page in a new tab
        const authTab = await chrome.tabs.create({ 
            url: CONFIG.AUTH_URL,
            active: true
        });
        return false;
    } catch (error) {
        console.error('Auth check failed:', error);
        return false;
    }
}

// Modify the action.onClicked listener
chrome.action.onClicked.addListener(async (tab) => {
    try {
        const { userData } = await chrome.storage.local.get(['userData']);
        if (!userData) {
            await checkAndHandleAuth();
            return;
        }
        
        // Try opening the side panel
        try {
            await chrome.sidePanel.open({ windowId: tab.windowId });
            console.log('Side panel opened successfully');
        } catch (error) {
            console.error('Failed to open side panel:', error);
            // Fallback to tab-specific opening if window-level fails
            await chrome.sidePanel.open({ tabId: tab.id });
        }
    } catch (error) {
        console.error('Error handling action click:', error);
    }
});

// Comment out or modify auth-related code
chrome.runtime.onConnectExternal.addListener((port) => {
    console.log('External connection established');
    
    port.onMessage.addListener(async (message) => {
        console.log('Received external message:', message);
        
        if (message.type === 'SIGN_IN_SUCCESS') {
            try {
                // Store user data
                userData = message.userData;  // Update global userData
                await chrome.storage.local.set({ userData: message.userData });
                
                // Instead of opening side panel here, we'll update the extension icon
                await chrome.action.setIcon({
                    path: {
                       "32": "icons-bw/icon-32.png",
                        "48": "icons-bw/icon-48.png",
                        "128": "icons-bw/icon-128.png"
                    }
                });

                // Only show notification if the API is available
                if (chrome.notifications) {
                    chrome.notifications.create({
                        type: 'basic',
                        iconUrl: 'icons-bw/icon-128.png',
                        title: 'Welcome to VoxiGuide!',
                        message: 'Click the extension icon in your toolbar to get started.',
                    });
                }
                
                port.postMessage({ success: true });
            } catch (error) {
                console.error('Error handling sign in:', error);
                port.postMessage({ success: false, error: error.message });
            }
        }
    });

    port.onDisconnect.addListener(() => {
        console.log('Port disconnected');
    });
});

async function addClickIndicator(screenshot, coordinates) {
    try {
        // Debug log
        console.log('Processing click at:', coordinates.x, coordinates.y);
        
        const response = await fetch(screenshot);
        const blob = await response.blob();
        const imageBitmap = await createImageBitmap(blob);
        
        const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
        const ctx = canvas.getContext('2d');
        
        // Draw screenshot
        ctx.drawImage(imageBitmap, 0, 0);
        
        // Calculate scaling (in case of high DPI displays)
        const scaleX = imageBitmap.width / coordinates.viewport.width;
        const scaleY = imageBitmap.height / coordinates.viewport.height;
        
        // Scale click coordinates
        const x = coordinates.x * scaleX;
        const y = coordinates.y * scaleY;
        
        console.log('Drawing indicator at:', x, y, 'Scale:', scaleX, scaleY);
        
        // Draw click indicator
        ctx.beginPath();
        ctx.arc(x, y, 50 * scaleX, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(255, 82, 82, 0.2)';
        ctx.fill();
        
        ctx.beginPath();
        ctx.arc(x, y, 24 * scaleX, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(255, 82, 82, 0.4)';
        ctx.fill();
        
        ctx.beginPath();
        ctx.arc(x, y, 6 * scaleX, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgb(255, 82, 82)';
        ctx.fill();
        
        const resultBlob = await canvas.convertToBlob();
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(resultBlob);
        });
    } catch (error) {
        console.error('Error in addClickIndicator:', error);
        throw error;
    }
}

// Handle content script injection
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.type === 'START_CAPTURE') {
        isCapturing = true;
        recordingStartTime = Date.now();
        
        // Store capture configuration
        const captureConfig = message.config || {
            captureModifiedClicks: true,
            preventNavigation: true
        };
        
        // Inject content script into all specified tabs
        for (const tabId of message.tabs) {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ['content.js']
                });
                
                // Send configuration to content script
                await chrome.tabs.sendMessage(tabId, {
                    type: 'CAPTURE_STATE_UPDATE',
                    isCapturing: true,
                    config: captureConfig
                });
                
                capturedTabs.add(tabId);
                console.log('Injected and started capture in tab:', tabId);
            } catch (err) {
                console.error('Failed to inject into tab:', tabId, err);
            }
        }
    } 
    else if (message.type === 'STOP_CAPTURE') {
        try {
            isCapturing = false;
            
            // Unregister content scripts from all captured tabs
            await chrome.scripting.unregisterContentScripts({
                ids: ['voxi-capture']
            });

            // Clear captured tabs
            capturedTabs.clear();
            
            // Stop audio recording if active
            if (audioRecorder && audioRecorder.state === 'recording') {
                audioRecorder.stop();
                audioRecorder.stream.getTracks().forEach(track => track.stop());
                audioChunks = [];
                audioRecorder = null;
            }

            recordingStartTime = null;
            sendResponse({ success: true });
        } catch (error) {
            console.error('Error stopping capture:', error);
            sendResponse({ success: false, error: error.message });
        }
        return true;
    }
    else if (message.type === 'CLICK_DETECTED') {
        try {
            const { userData, current_session_id, lastCaptureTime } = 
                await chrome.storage.local.get(['userData', 'current_session_id', 'lastCaptureTime']);
                
            if (!userData || !userData.accessToken) {
                console.error('No authentication token found');
                return;
            }

            const currentTime = Date.now();
            if (lastCaptureTime && (currentTime - lastCaptureTime) < 100) {
                console.log('Duplicate capture prevented');
                return;
            }
            await chrome.storage.local.set({ lastCaptureTime: currentTime });

            if (!current_session_id) {
                throw new Error('No active session found');
            }

            const screenshot = await chrome.tabs.captureVisibleTab(null, {
                format: 'png'
            });
            
            if (!screenshot || screenshot === 'data:,') {
                console.error('Invalid screenshot captured');
                return;
            }
            
            // Add click indicator to screenshot
            const processedScreenshot = await addClickIndicator(
                screenshot, 
                message.coordinates
            );

            const relativeTimestamp = Date.now() - recordingStartTime;
            
            // First send immediate notification with base64 image
            chrome.runtime.sendMessage({
                type: 'CAPTURE_IMMEDIATE',
                data: {
                    base64Image: processedScreenshot,
                    coordinates: message.coordinates,
                    url: message.url,
                    timestamp: relativeTimestamp
                }
            });

            // Then handle the upload in background
            const response = await fetch(processedScreenshot);
            const blob = await response.blob();
            
            const formData = new FormData();
            formData.append('screenshot', blob);
            formData.append('session_id', current_session_id);
            formData.append('step_number', message.step_number || 1);
            formData.append('timestamp', relativeTimestamp);
            formData.append('formatted_time', formatTimestamp(relativeTimestamp));
            formData.append('caption', `Click at ${message.coordinates.x}, ${message.coordinates.y}`);

            const uploadResponse = await fetch(`${CONFIG.API_URL}/api/screenshot/upload`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${userData.accessToken}`
                },
                body: formData
            });

            if (!uploadResponse.ok) {
                throw new Error('Failed to upload screenshot');
            }

            const { image_url } = await uploadResponse.json();
            
            // Send upload success message
            chrome.runtime.sendMessage({
                type: 'CAPTURE_UPLOADED',
                data: {
                    image_url,
                    timestamp: relativeTimestamp
                }
            });
            
        } catch (err) {
            console.error('Failed to process screenshot:', err);
        }
    }
    else if (message.type === 'GET_USER_DATA') {
        sendResponse({ userData });
    }
    else if (message.type === 'CLOSE_PANEL') {
        try {
            // First open the dashboard
            await chrome.tabs.create({ 
                url: message.dashboard_url,
                active: true  // Make sure the new tab is active
            });
            
            // Close the side panel for all windows
            const windows = await chrome.windows.getAll();
            for (const window of windows) {
                try {
                    await chrome.sidePanel.close({ windowId: window.id });
                } catch (err) {
                    console.error(`Failed to close panel for window ${window.id}:`, err);
                }
            }
            
            // Send response to indicate success
            sendResponse({ success: true });
        } catch (error) {
            console.error('Error in CLOSE_PANEL handler:', error);
            sendResponse({ success: false, error: error.message });
        }
        return true; // Keep the message channel open for async response
    }
    else if (message.type === 'FINISH_RECORDING') {
        try {
            // First open the dashboard
            await chrome.tabs.create({ 
                url: message.dashboard_url,
                active: true
            });
            
            // Close all side panels
            const windows = await chrome.windows.getAll();
            for (const window of windows) {
                try {
                    await chrome.sidePanel.close({ windowId: window.id });
                } catch (err) {
                    console.error(`Failed to close panel for window ${window.id}:`, err);
                }
            }

            // Clean up recording state
            isCapturing = false;
            capturedTabs.clear();
            recordingStartTime = null;
            
            sendResponse({ success: true });
        } catch (error) {
            console.error('Error in FINISH_RECORDING handler:', error);
            sendResponse({ success: false, error: error.message });
        }
        return true; // Keep message channel open for async response
    }
    else if (message.type === 'STOP_AND_REDIRECT') {
        try {
            console.log('[STOP_AND_REDIRECT] Starting cleanup sequence...');
            
            // 1. Immediately stop capturing
            isCapturing = false;
            console.log('[STOP_AND_REDIRECT] Capture flag disabled');

            // 2. Send state update to all captured tabs
            console.log('[STOP_AND_REDIRECT] Updating tab states...');
            const updatePromises = Array.from(capturedTabs).map(async (tabId) => {
                try {
                    await chrome.tabs.sendMessage(tabId, {
                        type: 'CAPTURE_STATE_UPDATE',
                        isCapturing: false
                    });
                    console.log(`[STOP_AND_REDIRECT] Updated tab ${tabId}`);
                } catch (err) {
                    console.error(`[STOP_AND_REDIRECT] Failed to update tab ${tabId}:`, err);
                }
            });
            
            // Wait for all tabs to be updated
            await Promise.allSettled(updatePromises);
            console.log('[STOP_AND_REDIRECT] All tabs updated');

            // 3. Close all side panels (using the method we know works)
            console.log('[STOP_AND_REDIRECT] Closing side panels...');
            // ... your working side panel close code here ...

            // 4. Re-enable side panel behavior for future use
            console.log('[STOP_AND_REDIRECT] Re-enabling side panel behavior...');
            await chrome.sidePanel
                .setPanelBehavior({ openPanelOnActionClick: true })
                .catch((error) => console.error('Failed to set panel behavior:', error));

            // 5. Open dashboard in new tab
            console.log('[STOP_AND_REDIRECT] Opening dashboard...');
            await chrome.tabs.create({ 
                url: message.dashboard_url,
                active: true
            });

            // 6. Clean up state
            capturedTabs.clear();
            recordingStartTime = null;
            await chrome.storage.local.remove(['isCapturing', 'current_session_id']);
            console.log('[STOP_AND_REDIRECT] Cleanup complete');
            
            sendResponse({ success: true });
        } catch (error) {
            console.error('[STOP_AND_REDIRECT] Failed:', error);
            // Even if other cleanup fails, make sure side panel behavior is restored
            try {
                await chrome.sidePanel
                    .setPanelBehavior({ openPanelOnActionClick: true })
                    .catch((error) => console.error('Failed to set panel behavior:', error));
            } catch (err) {
                console.error('[STOP_AND_REDIRECT] Failed to re-enable side panel:', err);
            }
            sendResponse({ success: false, error: error.message });
        }
        return true;
    }
    else if (message.type === 'CAPTURE_STATE_UPDATE' && !message.isCapturing) {
        // Remove all listeners
        document.removeEventListener('click', handleClick);
        window.removeEventListener('scroll', handleScroll);
        // Clear any stored state
        chrome.storage.local.remove(['isCapturing']);
    }
});

// Handle new tabs created during capture
chrome.tabs.onCreated.addListener(async (tab) => {
    if (isCapturing && tab.url?.startsWith('http')) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
            });
            
            await chrome.tabs.sendMessage(tab.id, {
                type: 'CAPTURE_STATE_UPDATE',
                isCapturing: true
            });
            
            capturedTabs.add(tab.id);
            console.log('Injected and started capture in new tab:', tab.id);
        } catch (err) {
            console.error('Failed to inject into new tab:', tab.id, err);
        }
    }
});

// Add periodic token check (every 5 minutes)
setInterval(async () => {
    const { userData } = await chrome.storage.local.get(['userData']);
    if (userData && userData.accessToken && isTokenExpired(userData.accessToken)) {
        console.log('Token expired during session, clearing');
        await chrome.storage.local.remove(['userData']);
    }
}, 5 * 60 * 1000);

// Add helper function for timestamp formatting
function formatTimestamp(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}