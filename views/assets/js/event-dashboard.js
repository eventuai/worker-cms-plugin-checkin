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

// Large event roll calls render 100 Liquid rows first, then append the rest in
// small browser-side batches. Check-in-specific hooks keep this independent of
// cms-plugin-events' progressive table when both plugins are visited in one
// admin session.
(function initProgressiveAllGuests() {
  if (window.WorkerCmsCheckinAllGuestsEmbedded) {
    window.WorkerCmsCheckinAllGuestsEmbedded.scan(document);
    return;
  }

  function text(root, selector, value) {
    const node = root.querySelector(selector);
    if (node) node.textContent = value == null ? '' : String(value);
    return node;
  }

  function setHref(node, value) {
    if (node instanceof HTMLAnchorElement) node.href = String(value || '');
  }

  function updateColorDot(row, value) {
    const color = String(value || '');
    const container = row.querySelector('[data-guest-color]');
    if (!container) return;
    container.textContent = '';
    const wrapper = document.createElement('span');
    wrapper.className = 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full';
    const dot = document.createElement('span');
    dot.className = 'block h-3.5 w-3.5 rounded-full';
    dot.setAttribute('data-color-tag-dot', '');
    dot.setAttribute('data-color-tag-color', color);
    const label = color ? color.charAt(0).toUpperCase() + color.slice(1) + ' color tag' : 'No color tag';
    wrapper.setAttribute('title', label);
    wrapper.setAttribute('aria-label', label);
    wrapper.appendChild(dot);
    container.appendChild(wrapper);
  }

  function updatePlusGuests(row, value) {
    const count = Number(value || 0);
    const plus = row.querySelector('[data-guest-plus]');
    if (!plus) return;
    plus.hidden = !(count > 0);
    text(plus, '[data-guest-plus-count]', count > 0 ? count : 0);
    text(plus, '[data-guest-plus-label]', count === 1 ? 'guest' : 'guests');
  }

  function updateCheckin(row, checkedIn) {
    const cell = row.querySelector('[data-guest-checkin]');
    if (!cell) return;
    cell.textContent = '';
    const label = document.createElement('span');
    if (checkedIn) {
      label.className = 'inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700';
      label.textContent = 'Checked in';
    } else {
      label.className = 'text-xs text-gray-400';
      label.textContent = 'Not checked in';
    }
    cell.appendChild(label);
  }

  function resetPrivacyState(row) {
    row.querySelectorAll('[data-private-field]').forEach((field) => {
      field.removeAttribute('data-private-original-html');
      field.removeAttribute('data-private-original-text');
      field.removeAttribute('data-private-mask');
      field.removeAttribute('data-private-masked');
    });
  }

  function fillRow(prototype, data) {
    const row = prototype.cloneNode(true);
    row.setAttribute('data-filter-search', String(data.searchText || ''));
    row.setAttribute('data-filter-status', String(data.status || ''));
    row.setAttribute('data-filter-color', String(data.colorTag || ''));

    const name = text(row, '[data-guest-name]', data.name);
    setHref(name, data.guestHref);
    text(row, '[data-guest-email]', data.email);
    text(row, '[data-guest-list]', data.listName);
    text(row, '[data-guest-organization]', data.organization);
    updatePlusGuests(row, data.plusGuests);
    text(row, '[data-guest-status]', data.status);
    const custom = text(row, '[data-guest-custom-field]', data.customFieldValue || '—');
    if (custom) {
      custom.classList.toggle('italic', !data.customFieldValue);
      custom.classList.toggle('text-gray-400', !data.customFieldValue);
    }
    updateColorDot(row, data.colorTag);
    updateCheckin(row, Boolean(data.checkedIn));
    setHref(row.querySelector('[data-guest-open]'), data.guestHref);
    resetPrivacyState(row);
    return row;
  }

  function setSummary(root, rendered, filtered, total, done) {
    let summary = root.parentElement && root.parentElement.querySelector('[data-checkin-all-guests-summary-text]');
    if (!summary) summary = document.querySelector('[data-checkin-all-guests-summary-text]');
    if (!summary) return;
    if (!done) {
      summary.textContent = rendered + ' of ' + filtered + ' matching guests rendered';
      return;
    }
    summary.textContent = '';
    const count = document.createElement('span');
    count.setAttribute('data-table-filter-count', 'guests');
    count.textContent = String(filtered);
    const label = document.createElement('span');
    label.setAttribute('data-table-filter-count-label', 'guests');
    label.setAttribute('data-singular', 'guest');
    label.setAttribute('data-plural', 'guests');
    label.textContent = filtered === 1 ? 'guest' : 'guests';
    summary.appendChild(count);
    summary.appendChild(document.createTextNode(' '));
    summary.appendChild(label);
    summary.appendChild(document.createTextNode(' across every list'));
  }

  function nextPaint() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function load(root) {
    if (root.getAttribute('data-checkin-all-guests-started') === '1') return;
    root.setAttribute('data-checkin-all-guests-started', '1');
    const target = root.querySelector('[data-checkin-all-guests-table]');
    const loading = root.querySelector('[data-checkin-all-guests-loading]');
    const progress = root.querySelector('[data-checkin-all-guests-progress]');
    const dataNode = root.querySelector('[data-checkin-all-guests-json]');
    if (!target || !dataNode) return;

    const tbody = target.querySelector('tbody');
    const prototype = target.querySelector('[data-guest-row]');
    const emptyRow = target.querySelector('[data-table-filter-empty]');
    if (!prototype || !tbody) return;
    if (emptyRow) emptyRow.remove();

    const initial = Number(root.getAttribute('data-initial-count') || 0);
    const filtered = Number(root.getAttribute('data-filtered-count') || initial);
    const total = Number(root.getAttribute('data-total-count') || filtered);
    try {
      const deferred = JSON.parse(dataNode.textContent || '[]');
      dataNode.remove();
      let rendered = initial;

      await nextPaint();
      for (let offset = 0; offset < deferred.length; offset += 100) {
        if (!root.isConnected) return;
        const fragment = document.createDocumentFragment();
        deferred.slice(offset, offset + 100).forEach((data) => {
          fragment.appendChild(fillRow(prototype, data));
          rendered += 1;
        });
        tbody.appendChild(fragment);
        setSummary(root, rendered, filtered, total, false);
        if (progress) progress.textContent = 'Rendering ' + rendered + ' of ' + filtered + ' matching guests…';
        await nextPaint();
      }

      deferred.length = 0;
      if (emptyRow) {
        emptyRow.hidden = filtered !== 0;
        tbody.appendChild(emptyRow);
      }
      setSummary(root, filtered, filtered, total, true);
      if (loading) loading.remove();
      if (window.WorkerCmsTableFilter) window.WorkerCmsTableFilter.scan(document);
    } catch (error) {
      if (progress) progress.textContent = 'The remaining guests could not be rendered. Refresh the page to try again.';
      if (loading) loading.classList.add('border-red-200', 'bg-red-50');
    }
  }

  function scan(root) {
    (root || document).querySelectorAll('[data-checkin-all-guests-async]').forEach(load);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(document));
  } else {
    scan(document);
  }
  new MutationObserver(() => scan(document)).observe(document.documentElement, { childList: true, subtree: true });
  window.WorkerCmsCheckinAllGuestsEmbedded = { scan };
})();
