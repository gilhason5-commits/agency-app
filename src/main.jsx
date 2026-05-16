import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// Global error handlers — surface module-load and runtime errors instead of a blank white screen
function showErr(label, err) {
    try {
        const root = document.getElementById('root') || document.body;
        const msg = (err && (err.message || err.toString())) || 'Unknown error';
        const stack = (err && err.stack) || '';
        root.innerHTML = '<div style="padding:20px;background:#0f172a;color:#ef4444;min-height:100vh;font-family:monospace;direction:ltr;white-space:pre-wrap;font-size:13px"><h2 style="color:#f87171;margin-bottom:16px">' + label + '</h2><div style="color:#fca5a5;margin-bottom:12px">' + msg + '</div><div style="color:#94a3b8;font-size:11px">' + stack + '</div></div>';
    } catch {}
}
window.addEventListener('error', (e) => showErr('Runtime Error', e.error || { message: e.message, stack: (e.filename || '') + ':' + (e.lineno || '') }));
window.addEventListener('unhandledrejection', (e) => showErr('Unhandled Promise Rejection', e.reason));

// Version marker — proves the fresh bundle is loaded (delete after debugging)
try {
    const marker = document.createElement('div');
    marker.style.cssText = 'position:fixed;bottom:0;left:0;background:#22c55e;color:#000;padding:2px 8px;font-size:10px;z-index:99999;font-family:monospace';
    marker.textContent = 'BUILD v2026-05-16-tdz-fix2';
    document.body.appendChild(marker);
    setTimeout(() => marker.remove(), 8000);
} catch {}

try {
    ReactDOM.createRoot(document.getElementById('root')).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    );
} catch (err) {
    showErr('React Mount Error', err);
}
