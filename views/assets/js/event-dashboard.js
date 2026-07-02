function initEventDashboard() {
  document.querySelectorAll('[data-walkin-panel]').forEach(initWalkinPanel);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEventDashboard);
} else {
  initEventDashboard();
}

function initWalkinPanel(panel) {
  const body = panel.querySelector('[data-walkin-panel-body]');
  const toggle = panel.querySelector('[data-walkin-toggle]');
  const label = panel.querySelector('[data-walkin-toggle-label]');
  const icon = panel.querySelector('[data-walkin-toggle-icon]');
  if (!body || !toggle) return;

  const storageKey = panel.dataset.storageKey || 'checkin:event-dashboard:walkin-collapsed';
  const collapsed = readPanelState(storageKey);
  applyPanelState(collapsed);

  toggle.addEventListener('click', () => {
    const nextCollapsed = !body.classList.contains('hidden');
    applyPanelState(nextCollapsed);
    writePanelState(storageKey, nextCollapsed);
  });

  function applyPanelState(isCollapsed) {
    body.classList.toggle('hidden', isCollapsed);
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
    toggle.setAttribute('aria-label', isCollapsed ? 'Expand panel' : 'Collapse panel');
    toggle.setAttribute('title', isCollapsed ? 'Expand panel' : 'Collapse panel');
    if (label) label.textContent = isCollapsed ? 'Expand' : 'Collapse';
    if (icon) icon.style.transform = isCollapsed ? 'rotate(180deg)' : '';
  }
}

function readPanelState(storageKey) {
  try {
    return window.localStorage.getItem(storageKey) === '1';
  } catch (error) {
    return false;
  }
}

function writePanelState(storageKey, isCollapsed) {
  try {
    window.localStorage.setItem(storageKey, isCollapsed ? '1' : '0');
  } catch (error) {
    // Ignore storage failures; the panel still works for this page view.
  }
}
