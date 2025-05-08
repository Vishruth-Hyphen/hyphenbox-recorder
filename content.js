// Recording state
let isRecording = false;
let startTime = null;
let interactionCount = 0;

// Hover highlight state
let currentHoverTarget = null; // Element currently highlighted on hover
const HOVER_HIGHLIGHT_STYLE = '2px dashed #FF00FF'; // Magenta dashed outline
const HOVER_HIGHLIGHT_SHADOW = '0 0 5px #FF00FF'; // Optional shadow for more visibility

// Start recording function
function startRecording() {
  console.log('[Content] Starting recording...');
  startTime = Date.now();
  interactionCount = 0;
  isRecording = true;
  
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16) + '-' + 
                   Math.random().toString(36).substring(2, 8);
  
  chrome.runtime.sendMessage({
    type: 'recording-started',
    sessionId: sessionId,
    startTime: new Date().toISOString(),
    url: window.location.href,
    title: document.title
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[Content] Error starting recording:', chrome.runtime.lastError);
    } else {
      console.log('[Content] Recording started with session:', sessionId);
    }
  });
  
  document.addEventListener('click', recordClick, true);
  setupTextInputRecording();
  setupSPANavigationListener();
  // Add listeners for hover highlighting
  document.addEventListener('mousemove', handleMouseMoveForHighlight, true);
  document.body.addEventListener('mouseleave', clearHoverHighlight, true);
}

// Stop recording function
function stopRecording() {
  if (!isRecording) return;
  
  console.log('[Content] Stopping recording and triggering download...');
  document.removeEventListener('click', recordClick, true);
  // Remove listeners for hover highlighting
  document.removeEventListener('mousemove', handleMouseMoveForHighlight, true);
  document.body.removeEventListener('mouseleave', clearHoverHighlight, true);
  clearHoverHighlight(); // Ensure any lingering highlight is removed

  isRecording = false;
  
  // Send stop message and wait for confirmation
  chrome.runtime.sendMessage({ 
    type: 'recording-stopped' 
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[Content] Error stopping recording:', chrome.runtime.lastError);
    } else {
      console.log('[Content] Recording stopped and download triggered:', response);
    }
  });
}

// --- Hover Highlighting Functions ---
function handleMouseMoveForHighlight(event) {
  if (!isRecording) {
    // If not recording, ensure no highlight is active and remove listener if any
    clearHoverHighlight();
    return;
  }

  // Determine the element to highlight, considering clickable parents
  let targetElement = findClickableParent(event.target) || event.target;

  // Avoid highlighting the entire body or html tag itself if it's the target
  if (targetElement === document.body || targetElement === document.documentElement) {
    clearHoverHighlight();
    return;
  }

  if (targetElement === currentHoverTarget) {
    return; // No change
  }

  // Clear previous highlight
  clearHoverHighlight();

  // Apply new highlight
  if (targetElement && typeof targetElement.style !== 'undefined') {
    targetElement.style.outline = HOVER_HIGHLIGHT_STYLE;
    targetElement.style.boxShadow = HOVER_HIGHLIGHT_SHADOW; // Optional: for better visibility
    currentHoverTarget = targetElement;
  }
}

function clearHoverHighlight() {
  if (currentHoverTarget && typeof currentHoverTarget.style !== 'undefined') {
    currentHoverTarget.style.outline = '';
    currentHoverTarget.style.boxShadow = ''; // Clear the optional shadow
  }
  currentHoverTarget = null;
}
// --- End Hover Highlighting Functions ---

// Enhanced function to generate better selectors with proper priority
function generateSelector(el) {
  // Try ID selector (fastest)
  if (el.id) return `#${el.id}`;
  
  // For links, use href-based selector (very reliable & fast)
  if (el.tagName === 'A' && el.getAttribute('href')) {
    const href = el.getAttribute('href');
    return `a[href="${href}"]`;
  }
  
  // For inputs, use name and type (very reliable)
  if (el.tagName === 'INPUT' && el.getAttribute('name')) {
    const type = el.getAttribute('type') || 'text';
    return `input[name="${el.getAttribute('name')}"][type="${type}"]`;
  }
  
  // For elements with data attributes, use those (reliable & fast)
  const dataAttrs = Array.from(el.attributes)
    .filter(attr => attr.name.startsWith('data-'));
  
  if (dataAttrs.length > 0) {
    // Use the first data attribute for simplicity
    const attr = dataAttrs[0];
    return `${el.tagName.toLowerCase()}[${attr.name}="${attr.value}"]`;
  }
  
  // For elements with semantic classes, use tag+class (reliable & fairly fast)
  const semanticClasses = Array.from(el.classList)
    .filter(className => 
      // Filter for semantic class names (avoid hash-based ones)
      !/^[a-z][0-9]_[a-f0-9]+$/.test(className) && 
      !className.match(/^[a-z][0-9]?$/) &&
      className.length > 2 
    );
  
  if (semanticClasses.length > 0) {
    // Use the most specific semantic class
    const bestClass = semanticClasses.sort((a, b) => b.length - a.length)[0];
    return `${el.tagName.toLowerCase()}.${bestClass}`;
  }
  
  // Fall back to text-based selector for interactive elements
  if ((el.tagName === 'BUTTON' || el.tagName === 'A') && el.textContent.trim()) {
    return `${el.tagName.toLowerCase()}:contains("${el.textContent.trim()}")`;
  }
  
  // Last resort: use nth-child (least reliable)
  const siblings = Array.from(el.parentNode.children);
  const index = siblings.indexOf(el) + 1;
  return `${el.tagName.toLowerCase()}:nth-child(${index})`;
}

// Enhanced path generation with more reliable identification
function generatePath(el) {
  const path = [];
  
  while (el && el !== document.body) {
    // Start with the tag name
    let selector = el.nodeName.toLowerCase();
    
    // Add ID if available
    if (el.id) {
      selector = `#${el.id}`;
      path.unshift(selector);
      break;
    } 
    
    // Add href for links (helps with identification)
    else if (el.tagName === 'A' && el.getAttribute('href')) {
      selector += `[href="${el.getAttribute('href')}"]`;
    }
    
    // Add name for form elements
    else if (el.getAttribute('name')) {
      selector += `[name="${el.getAttribute('name')}"]`;
    }
    
    // Add data attributes if available
    else {
      const dataAttrs = Array.from(el.attributes)
        .filter(attr => attr.name.startsWith('data-'));
      
      if (dataAttrs.length > 0) {
        selector += `[${dataAttrs[0].name}="${dataAttrs[0].value}"]`;
      }
      // Add position when needed
      else {
        const siblings = Array.from(el.parentNode.children).filter(sibling => 
          sibling.nodeName === el.nodeName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(el) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
    }
    
    path.unshift(selector);
    el = el.parentNode;
  }
  
  return path;
}

// Enhanced click recording with more element data
function recordClick(event) {
  if (!isRecording) return;
  
  const target = event.target;
  const clickableElement = findClickableParent(target) || target;
  interactionCount++;
  
  try {
    const rect = clickableElement.getBoundingClientRect();
    const elementRect = {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height
    };
    
    const interactionId = `click_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const elementAttributes = {};
    Array.from(clickableElement.attributes).forEach(attr => {
      if (!['style', 'class'].includes(attr.name)) {
        elementAttributes[attr.name] = attr.value;
      }
    });
    
    const semanticClasses = Array.from(clickableElement.classList || [])
      .filter(cls => 
        !cls.match(/^[a-z][0-9]?_[a-f0-9]+$/) && 
        cls.length > 2 && 
        !cls.match(/^[a-z][0-9]?$/)
      );

    // Strict normalization for the main clickableElement's textContent
    let normalizedTextContent = '';
    let rawText = '';
    if (clickableElement.innerText !== undefined && clickableElement.innerText.trim() !== '') {
        rawText = clickableElement.innerText;
    } else if (clickableElement.textContent && clickableElement.textContent.trim() !== '') {
        rawText = clickableElement.textContent;
    }
    if (rawText) {
        normalizedTextContent = rawText.trim().toLowerCase().replace(/\s+/g, ''); // Remove all whitespace
    }
    
    const interactionData = {
      id: interactionId,
      type: 'click',
      timestamp: new Date().toISOString(),
      timeOffset: null,
      pageInfo: {
        url: window.location.href,
        path: window.location.pathname,
        title: document.title
      },
      element: {
        tagName: clickableElement.tagName,
        id: clickableElement.id || null,
        textContent: normalizedTextContent, // Use strictly normalized text
        cssSelector: generateSelector(clickableElement),
        path: generatePath(clickableElement),
        attributes: JSON.stringify(elementAttributes),
        semanticClasses: semanticClasses.join(' ')
      },
      position: {
        x: Math.round(event.clientX),
        y: Math.round(event.clientY)
      },
      elementRect: elementRect,
      screenshot: null
    };

    chrome.runtime.sendMessage({
      type: 'interaction',
      data: interactionData
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[Content] Error sending interaction:', chrome.runtime.lastError);
      } else if (response && response.status === 'saved') {
        console.log('[Content] Recorded click saved successfully');
        
        // Now request a screenshot
        requestScreenshot(interactionId);
      }
    });

    console.log('[Content] Recorded click:', {
      element: interactionData.element.tagName,
      text: interactionData.element.textContent.substring(0, 30),
      selector: interactionData.element.cssSelector
    });
  } catch (error) {
    console.error('[Content] Error recording click:', error);
  }
}

// Helper functions from original code
function findClickableParent(el) {
  while (el && el !== document.body) {
    if (el.tagName === 'A' || el.tagName === 'BUTTON' || 
        el.tagName === 'INPUT' || el.onclick || 
        el.getAttribute('role') === 'button' ||
        // Consider other potentially clickable roles or custom attributes if needed
        el.hasAttribute('data-clickable') // Example for custom clickable elements
       ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

// Add this function to detect URL changes for SPA navigation
function setupSPANavigationListener() {
  let lastUrl = location.href;
  
  // Create a new observer to watch for URL changes
  const observer = new MutationObserver(() => {
    if (lastUrl !== location.href) {
      console.log('[Content] SPA navigation detected:', location.href);
      const oldUrl = lastUrl;
      lastUrl = location.href;
      
      // This is a SPA navigation - we need to re-establish our recording state
      if (isRecording) {
        console.log('[Content] Re-establishing recording after SPA navigation');
        // Re-attach click listeners that might have been lost
        document.removeEventListener('click', recordClick, true);
        document.addEventListener('click', recordClick, true);
        
        // Log this navigation as an interaction
        logSPANavigation(oldUrl, location.href);
      }
    }
  });
  
  // Start observing
  observer.observe(document, { subtree: true, childList: true });
  
  // Also listen for popstate events (browser back/forward)
  window.addEventListener('popstate', () => {
    if (lastUrl !== location.href) {
      console.log('[Content] Popstate navigation detected:', location.href);
      const oldUrl = lastUrl;
      lastUrl = location.href;
      
      if (isRecording) {
        console.log('[Content] Re-establishing recording after popstate navigation');
        document.removeEventListener('click', recordClick, true);
        document.addEventListener('click', recordClick, true);
        
        logSPANavigation(oldUrl, location.href);
      }
    }
  });
}

// Function to log SPA navigation as an interaction
function logSPANavigation(fromUrl, toUrl) {
  interactionCount++;
  
  try {
    const interactionData = {
      type: 'navigation',
      timestamp: new Date().toISOString(),
      timeOffset: null,
      pageInfo: {
        url: toUrl,
        path: new URL(toUrl).pathname,
        title: document.title
      },
      fromPage: {
        url: fromUrl,
        path: new URL(fromUrl).pathname
      },
      // We don't have element info for automatic navigation
      position: null,
      elementRect: null
    };

    chrome.runtime.sendMessage({
      type: 'interaction',
      data: interactionData
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[Content] Error sending navigation interaction:', chrome.runtime.lastError);
      } else if (response && response.status === 'saved') {
        console.log('[Content] Recorded navigation saved successfully');
      }
    });
  } catch (error) {
    console.error('[Content] Error recording navigation:', error);
  }
}

// On script initialization, check with background if recording is in progress
function checkRecordingState() {
  chrome.runtime.sendMessage({ 
    type: 'get-recording-state' 
  }, (response) => {
    if (response && response.isRecording) {
      console.log('[Content] Recording already in progress, reattaching listeners');
      isRecording = true;
      interactionCount = response.interactionCount || 0;
      document.addEventListener('click', recordClick, true);
      setupSPANavigationListener();
    }
  });
}

// Call this on content script initialization
checkRecordingState();

// Listen for messages from the background script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Content] Received message:', message.action);
  
  try {
    if (message.action === 'start-recording') {
      startRecording();
      sendResponse({ status: 'ok' });
    } 
    else if (message.action === 'stop-recording') {
      console.log('[Content] Stopping recording...');
      stopRecording();
      sendResponse({ status: 'ok' });
    }
    else if (message.action === 'get-status') {
      sendResponse({ isRecording, interactionCount });
    }
  } catch (error) {
    console.error('[Content] Error handling message:', error);
    sendResponse({ error: error.message });
  }
  return true;
});

// Add text input recording
function setupTextInputRecording() {
  const textInputSelector = 'input[type="text"], input[type="email"], input[type="password"], textarea';
  
  // Handle text input completion (blur event)
  document.addEventListener('blur', (event) => {
    if (!isRecording) return;
    
    if (event.target.matches(textInputSelector) && event.target.value) {
      recordTextInput(event.target);
    }
  }, true);
  
  // Also capture Enter key for form submissions
  document.addEventListener('keydown', (event) => {
    if (!isRecording) return;
    
    if (event.key === 'Enter' && event.target.matches(textInputSelector) && event.target.value) {
      recordTextInput(event.target);
    }
  }, true);
}

function recordTextInput(inputElement) {
  interactionCount++;
  
  try {
    const rect = inputElement.getBoundingClientRect();
    const elementRect = {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height
    };
    
    // Generate a unique ID for this interaction
    const interactionId = `input_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Collect attributes for input elements (especially important)
    const elementAttributes = {};
    Array.from(inputElement.attributes).forEach(attr => {
      if (!['style', 'class'].includes(attr.name)) {
        elementAttributes[attr.name] = attr.value;
      }
    });
    
    // Get parent form ID if available
    let formId = null;
    let formEl = inputElement.form;
    if (formEl) {
      formId = formEl.id || null;
    }
    
    const interactionData = {
      id: interactionId,
      type: 'input',
      timestamp: new Date().toISOString(),
      timeOffset: null,
      pageInfo: {
        url: window.location.href,
        path: window.location.pathname,
        title: document.title
      },
      element: {
        tagName: inputElement.tagName,
        id: inputElement.id || null,
        name: inputElement.name || null,
        type: inputElement.type || 'text',
        value: inputElement.value,
        cssSelector: generateSelector(inputElement),
        path: generatePath(inputElement),
        attributes: JSON.stringify(elementAttributes),
        formId: formId,
        placeholder: inputElement.placeholder || null
      },
      position: null,
      elementRect: elementRect,
      screenshot: null
    };

    chrome.runtime.sendMessage({
      type: 'interaction',
      data: interactionData
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[Content] Error sending text input interaction:', chrome.runtime.lastError);
      } else if (response && response.status === 'saved') {
        console.log('[Content] Recorded text input saved successfully');
        
        // Now request a screenshot
        requestScreenshot(interactionId);
      }
    });
  } catch (error) {
    console.error('[Content] Error recording text input:', error);
  }
}

// Function to request a screenshot from the background script
function requestScreenshot(interactionId) {
  chrome.runtime.sendMessage({
    type: 'take-screenshot',
    interactionId: interactionId
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[Content] Error requesting screenshot:', chrome.runtime.lastError);
    } else {
      console.log('[Content] Screenshot request acknowledged:', response);
    }
  });
}

// Listen for screenshot results from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'screenshot-result') {
    updateInteractionWithScreenshot(message.interactionId, message.result);
    sendResponse({ status: 'received' });
  }
  return true;
});

// Function to update an interaction with its screenshot URL
function updateInteractionWithScreenshot(interactionId, screenshotResult) {
  if (!screenshotResult.success) {
    console.error('[Content] Screenshot failed:', screenshotResult.error);
    return;
  }
  
  // Send a message to update the interaction with the screenshot URL
  chrome.runtime.sendMessage({
    type: 'update-interaction',
    interactionId: interactionId,
    screenshot: {
      url: screenshotResult.screenshotUrl,
      width: window.innerWidth,
      height: window.innerHeight
    }
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[Content] Error updating interaction with screenshot:', chrome.runtime.lastError);
    } else {
      console.log('[Content] Interaction updated with screenshot:', screenshotResult.screenshotUrl);
    }
  });
} 