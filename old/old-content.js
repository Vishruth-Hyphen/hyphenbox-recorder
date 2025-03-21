console.log('HyphenBox Agent: Content script loaded');

// Store capture state in chrome.storage for persistence
chrome.storage.local.get(['isCapturing'], (result) => {
    if (result.isCapturing) {
        console.log('HyphenBox Agent: Restoring capture state');
        setupClickListener();
    }
});

function setupClickListener() {
    // Remove existing listener if any
    document.removeEventListener('click', handleClick);
    // Add new listener
    document.addEventListener('click', handleClick);
    console.log('HyphenBox Agent: Click listener setup complete');
}

function handleClick(e) {
    console.log('Click detected at:', e.clientX, e.clientY);
    
    // Prevent default for links that might navigate away
    if (e.target.tagName === 'A' && e.target.getAttribute('target') === '_blank') {
        e.preventDefault();
    }
    
    chrome.runtime.sendMessage({
        type: 'CLICK_DETECTED',
        coordinates: {
            x: e.clientX,  // These are already viewport-relative
            y: e.clientY,
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio || 1
            }
        },
        url: window.location.href,
        timestamp: Date.now(),
        // session_id: message.session_id
    });
}

// Listen for capture state changes
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('HyphenBox Agent: Message received:', message.type);
    
    if (message.type === 'CAPTURE_STATE_UPDATE') {
        if (!message.isCapturing) {
            // Remove all listeners
            document.removeEventListener('click', handleClick);
            window.removeEventListener('scroll', handleScroll);
            // Clear any stored state
            chrome.storage.local.remove(['isCapturing']);
        } else {
            setupClickListener();
        }
        sendResponse({ received: true });
        return true;
    }
});

// Handle page loads/navigation
document.addEventListener('DOMContentLoaded', () => {
    console.log('HyphenBox Agent: Page loaded, checking capture state');
    chrome.storage.local.get(['isCapturing'], (result) => {
        if (result.isCapturing) {
            setupClickListener();
        }
    });
});

// Add scroll event debouncing
let scrollTimeout;
window.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
        chrome.storage.local.get(['isCapturing'], (result) => {
            if (result.isCapturing) {
                console.log('HyphenBox Agent: Page scrolled, ensuring click listener');
                setupClickListener();
            }
        });
    }, 150);
});