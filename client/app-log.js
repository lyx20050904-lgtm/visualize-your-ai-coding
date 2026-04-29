/**
 * LogManager — Ring-buffered activity log for Vibe Guarding
 *
 * Separated from app.js to keep the controller under 600-line guardrail.
 * Usage: LogManager.log(type, message)
 *   type:    event type string (displayed as label)
 *   message: file path or description
 */
class LogManager {
  static log(type, message) {
    const container = document.getElementById('logContainer');
    if (!container) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.dataset.type = type;
    const time = new Date().toLocaleTimeString('en', { hour12: false });
    const label = type.replace('agent:', '').replace('edit-counts:', '').replace('project:', '');
    entry.innerHTML = '<span class="log-time">' + time + '</span><span class="log-evt">' + label + '</span><span class="log-path">' + message + '</span>';
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
    while (container.children.length > 300) container.removeChild(container.firstChild);
  }
}
