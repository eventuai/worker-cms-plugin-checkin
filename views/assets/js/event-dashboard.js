function initEventDashboard() {
  document.querySelectorAll('[data-walkin-panel]').forEach(initWalkinPanel);
  document.querySelectorAll('[data-custom-field-select]').forEach(initCustomFieldSelect);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEventDashboard);
} else {
  initEventDashboard();
}

function initWalkinPanel(panel) {
  const body = panel.querySelector('[data-walkin-panel-body]');
  const toggle = panel.querySelector('[data-walkin-toggle]');
  const headingToggle = panel.querySelector('[data-walkin-heading-toggle]');
  const label = panel.querySelector('[data-walkin-toggle-label]');
  const icon = panel.querySelector('[data-walkin-toggle-icon]');
  if (!body || !toggle) return;

  const storageKey = panel.dataset.storageKey || 'checkin:event-dashboard:walkin-collapsed';
  const collapsed = readPanelState(storageKey);
  applyPanelState(collapsed);

  const togglePanel = () => {
    const nextCollapsed = !body.classList.contains('hidden');
    applyPanelState(nextCollapsed);
    writePanelState(storageKey, nextCollapsed);
  };

  toggle.addEventListener('click', togglePanel);
  if (headingToggle) headingToggle.addEventListener('click', togglePanel);

  function applyPanelState(isCollapsed) {
    body.classList.toggle('hidden', isCollapsed);
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
    if (headingToggle) headingToggle.setAttribute('aria-expanded', String(!isCollapsed));
    toggle.setAttribute('aria-label', isCollapsed ? 'Expand panel' : 'Collapse panel');
    toggle.setAttribute('title', isCollapsed ? 'Expand panel' : 'Collapse panel');
    if (label) label.textContent = isCollapsed ? 'Expand' : 'Collapse';
    if (icon) icon.style.transform = isCollapsed ? 'rotate(180deg)' : '';
  }
}

function initCustomFieldSelect(select) {
  const storageKey = select.dataset.storageKey;
  if (!storageKey) return;

  const savedValue = readStorageValue(storageKey);
  if (savedValue && selectHasOption(select, savedValue)) select.value = savedValue;

  const saveSelection = () => writeStorageValue(storageKey, select.value);
  select.addEventListener('change', saveSelection);
  if (select.form) select.form.addEventListener('submit', saveSelection);
}

function selectHasOption(select, value) {
  return Array.from(select.options).some((option) => option.value === value);
}

function readPanelState(storageKey) {
  try {
    const savedState = window.localStorage.getItem(storageKey);
    return savedState === null ? true : savedState === '1';
  } catch (error) {
    return true;
  }
}

function writePanelState(storageKey, isCollapsed) {
  try {
    window.localStorage.setItem(storageKey, isCollapsed ? '1' : '0');
  } catch (error) {
    // Ignore storage failures; the panel still works for this page view.
  }
}

function readStorageValue(storageKey) {
  try {
    return window.localStorage.getItem(storageKey) || '';
  } catch (error) {
    return '';
  }
}

function writeStorageValue(storageKey, value) {
  try {
    window.localStorage.setItem(storageKey, value);
  } catch (error) {
    // Ignore storage failures; the form still works for this page view.
  }
}
