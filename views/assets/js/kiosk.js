// Kiosk glue: camera scanning (ZXingWASM, ported as-is from the legacy app —
// see qr-scanner.liquid's tryCode128Detection for the reference call shape)
// and badge printing (encoder.js SVG->bitmap + printer.js WebUSB/printer-server
// transport, also ported as-is).

// Carry this script's own `?r=<deploy revision>` onto the wasm URL so the wasm
// is cached immutably and busts on deploy too. Captured synchronously at load
// (document.currentScript is only valid during initial execution).
var KIOSK_ASSET_QUERY = (function () {
  try {
    const src = document.currentScript && document.currentScript.src;
    return src ? new URL(src).search : '';
  } catch (error) {
    return '';
  }
})();

var KIOSK_ZXING_WASM_URL = '/admin/plugins/checkin/assets/wasm/zxing_reader.wasm' + KIOSK_ASSET_QUERY;
var KIOSK_ZXING_OVERRIDES = {
  // Point the decoder at the CMS-served, admin-approved wasm binary (same
  // origin, so connect-src 'self' allows it) instead of zxing's jsdelivr
  // default, which the admin CSP blocks. See views/assets/wasm.
  locateFile: (path, prefix) => (path.endsWith('.wasm') ? KIOSK_ZXING_WASM_URL : prefix + path),
};
var KIOSK_MIRROR_STORAGE_KEY = 'checkin:kiosk:scanner-mirrored';
var KIOSK_CAMERA_STORAGE_KEY = 'checkin:kiosk:scanner-camera';

async function initKiosk() {
  initScanner();
  initBadgePrint();
  initGuestActions();
  initAdhocToggle();
}

// The CMS admin shell renders client-side and injects this script *after*
// DOMContentLoaded has already fired, so a DOMContentLoaded listener would
// never run. Init immediately when the DOM is ready; only wait when it isn't.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initKiosk);
} else {
  initKiosk();
}

function initAdhocToggle() {
  const link = document.getElementById('showAdhocForm');
  const form = document.getElementById('adhocForm');
  if (!link || !form) return;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    form.style.display = 'block';
  });
}

// ── Camera scanning ─────────────────────────────────────────────────────

async function initScanner() {
  const video = document.getElementById('scanVideo');
  if (!video) return;

  const frame = document.getElementById('scanVideoFrame');
  const statusEl = document.getElementById('scanStatus');
  const cameraSelect = document.getElementById('scanCameraSelect');
  const mirrorToggle = document.getElementById('scanMirrorToggle');
  const codeForm = document.getElementById('scanCodeForm');
  const codeInput = document.getElementById('scanCodeInput');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let scanning = true;
  let stream = null;
  let scanTimer = 0;
  let scanRun = 0;
  let selectedDeviceId = readStringSetting(KIOSK_CAMERA_STORAGE_KEY);
  let mirrored = readBooleanSetting(KIOSK_MIRROR_STORAGE_KEY);
  let zoom = 1;
  let pinchStartDistance = 0;
  let pinchStartZoom = 1;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (statusEl) statusEl.textContent = 'Camera unavailable — use manual entry below.';
    if (cameraSelect) cameraSelect.disabled = true;
    if (mirrorToggle) mirrorToggle.disabled = true;
    return;
  }

  try {
    if (statusEl) statusEl.textContent = 'Loading scanner…';
    await prepareScannerDecoder();
  } catch (error) {
    console.error('Scanner decoder unavailable:', error);
    if (statusEl) statusEl.textContent = 'Scanner unavailable — use manual entry below.';
    return;
  }

  if (cameraSelect) {
    cameraSelect.addEventListener('change', () => {
      selectedDeviceId = cameraSelect.value;
      writeStringSetting(KIOSK_CAMERA_STORAGE_KEY, selectedDeviceId);
      startCamera();
    });
  }
  if (mirrorToggle) {
    mirrorToggle.setAttribute('aria-pressed', String(mirrored));
    mirrorToggle.classList.toggle('bg-gray-100', mirrored);
    mirrorToggle.addEventListener('click', () => {
      mirrored = !mirrored;
      mirrorToggle.setAttribute('aria-pressed', String(mirrored));
      mirrorToggle.classList.toggle('bg-gray-100', mirrored);
      writeBooleanSetting(KIOSK_MIRROR_STORAGE_KEY, mirrored);
      updateVideoTransform();
    });
  }
  if (frame) {
    frame.addEventListener('wheel', (event) => {
      event.preventDefault();
      setZoom(zoom + (event.deltaY < 0 ? 0.15 : -0.15));
    }, { passive: false });
    frame.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 2) return;
      pinchStartDistance = touchDistance(event.touches[0], event.touches[1]);
      pinchStartZoom = zoom;
    }, { passive: true });
    frame.addEventListener('touchmove', (event) => {
      if (event.touches.length !== 2 || pinchStartDistance <= 0) return;
      event.preventDefault();
      const nextDistance = touchDistance(event.touches[0], event.touches[1]);
      setZoom(pinchStartZoom * (nextDistance / pinchStartDistance));
    }, { passive: false });
    frame.addEventListener('touchend', () => {
      pinchStartDistance = 0;
    });
  }

  updateVideoTransform();
  startCamera();

  async function startCamera() {
    const run = ++scanRun;
    scanning = true;
    window.clearTimeout(scanTimer);
    stopStream();

    if (statusEl) statusEl.textContent = 'Starting camera…';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: selectedDeviceId
          ? { deviceId: { exact: selectedDeviceId }, width: { ideal: 1280 }, height: { ideal: 1280 } }
          : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      });
      if (run !== scanRun) {
        stopTracks(stream);
        return;
      }

      video.srcObject = stream;
      await video.play().catch(() => {});
      const track = stream.getVideoTracks()[0];
      if (!selectedDeviceId) selectedDeviceId = track && track.getSettings ? track.getSettings().deviceId || '' : '';
      await refreshCameraList();
      if (selectedDeviceId) writeStringSetting(KIOSK_CAMERA_STORAGE_KEY, selectedDeviceId);
      if (statusEl) statusEl.textContent = 'Scanning for codes…';
      scheduleScan(run);
    } catch (error) {
      if (selectedDeviceId) {
        selectedDeviceId = '';
        writeStringSetting(KIOSK_CAMERA_STORAGE_KEY, '');
        startCamera();
        return;
      }
      console.error('Camera unavailable:', error);
      if (statusEl) statusEl.textContent = 'Camera unavailable — use manual entry below.';
      if (cameraSelect) cameraSelect.disabled = true;
    }
  }

  function stopStream() {
    if (!stream) return;
    stopTracks(stream);
    stream = null;
  }

  function stopTracks(targetStream) {
    targetStream.getTracks().forEach((track) => track.stop());
  }

  async function refreshCameraList() {
    if (!cameraSelect || !navigator.mediaDevices.enumerateDevices) return;

    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
      const currentValue = selectedDeviceId || cameraSelect.value;
      cameraSelect.innerHTML = '';
      devices.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${index + 1}`;
        cameraSelect.appendChild(option);
      });
      if (currentValue && devices.some((device) => device.deviceId === currentValue)) {
        cameraSelect.value = currentValue;
        selectedDeviceId = currentValue;
      } else if (devices[0]) {
        cameraSelect.value = devices[0].deviceId;
        selectedDeviceId = devices[0].deviceId;
      }
      if (selectedDeviceId) writeStringSetting(KIOSK_CAMERA_STORAGE_KEY, selectedDeviceId);
      cameraSelect.disabled = devices.length <= 1;
    } catch (error) {
      console.error('Could not list cameras:', error);
      cameraSelect.disabled = true;
    }
  }

  function scheduleScan(run) {
    if (scanning && run === scanRun) scanTimer = window.setTimeout(() => tick(run), 300);
  }

  async function tick(run) {
    if (run !== scanRun) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      drawZoomedFrame();
      try {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const results = await ZXingWASM.readBarcodes(blob, {
          tryHarder: true,
          formats: ['QRCode', 'Code128', 'EAN-13', 'ITF'],
          maxNumberOfSymbols: 1,
        });
        if (results && results.length > 0 && results[0].text) {
          scanning = false;
          stopStream();
          onDecoded(results[0].text);
          return;
        }
      } catch (error) {
        if (isDecoderLoadError(error)) {
          console.error('Scanner decoder failed after camera start:', error);
          scanning = false;
          if (statusEl) statusEl.textContent = 'Scanner unavailable — use manual entry below.';
          return;
        }
        // Decode miss on this frame — keep scanning.
      }
    }
    scheduleScan(run);
  }

  function drawZoomedFrame() {
    const sourceWidth = video.videoWidth / zoom;
    const sourceHeight = video.videoHeight / zoom;
    const sourceX = (video.videoWidth - sourceWidth) / 2;
    const sourceY = (video.videoHeight - sourceHeight) / 2;
    ctx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  }

  function setZoom(nextZoom) {
    zoom = Math.max(1, Math.min(4, nextZoom));
    updateVideoTransform();
  }

  function updateVideoTransform() {
    const mirror = mirrored ? 'scaleX(-1)' : 'scaleX(1)';
    video.style.transform = `${mirror} scale(${zoom})`;
    video.style.transformOrigin = 'center center';
  }

  function touchDistance(first, second) {
    return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
  }

  function onDecoded(text) {
    if (statusEl) statusEl.textContent = 'Code detected!';
    const checkinCode = checkinLinkCode(text);
    if (checkinCode) {
      // Keep the camera flow inside the staff kiosk. The server verifies the
      // signed Events QR and opens the matching guest; navigating an absolute
      // /checkin URL here would incorrectly send the browser to the CMS host.
      if (codeInput) codeInput.value = checkinCode;
      if (codeForm) codeForm.submit();
      return;
    }
    if (codeInput) codeInput.value = text;
    if (codeForm) codeForm.submit();
  }
}

async function prepareScannerDecoder() {
  const decoder = await waitForZXingWASM();
  if (!decoder || !decoder.readBarcodes) throw new Error('ZXingWASM did not load');

  if (decoder.purgeZXingModule) decoder.purgeZXingModule();
  if (decoder.setZXingModuleOverrides) decoder.setZXingModuleOverrides(KIOSK_ZXING_OVERRIDES);
  if (decoder.getZXingModule) {
    await decoder.getZXingModule(KIOSK_ZXING_OVERRIDES);
  }
}

function waitForZXingWASM() {
  if (typeof ZXingWASM !== 'undefined') return Promise.resolve(ZXingWASM);

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timeoutMs = 8000;
    const timer = setInterval(() => {
      if (typeof ZXingWASM !== 'undefined') {
        clearInterval(timer);
        resolve(ZXingWASM);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out loading zxing-wasm.js'));
      }
    }, 50);
  });
}

function isDecoderLoadError(error) {
  const message = String(error && (error.message || error));
  return /wasm|webassembly|instantiate|fetch|network|abort/i.test(message);
}

/** Returns a complete Events /checkin URL for server-side QR verification, otherwise null. */
function checkinLinkCode(text) {
  try {
    const url = new URL(text, window.location.origin);
    return url.pathname.startsWith('/checkin/') ? url.href : null;
  } catch {
    return null;
  }
}

function readBooleanSetting(key) {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch (error) {
    return false;
  }
}

function writeBooleanSetting(key, value) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch (error) {
    // Ignore storage failures; the control still works for this page view.
  }
}

function readStringSetting(key) {
  try {
    return window.localStorage.getItem(key) || '';
  } catch (error) {
    return '';
  }
}

function writeStringSetting(key, value) {
  try {
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch (error) {
    // Ignore storage failures; the control still works for this page view.
  }
}

// ── Badge printing (encoder.js + printer.js) ────────────────────────────

function initBadgePrint() {
  const button = document.querySelector('[data-print-badges]');
  if (!button) return;

  button.addEventListener('click', () => printBadges(button));
}

async function printBadges(button) {
  const root = button.closest('[data-kiosk-guest]') || document;
  const cards = Array.from(root.querySelectorAll('[data-label-card]'));
  const originalText = button.textContent;
  button.disabled = true;
  try {
    if (!cards.length) throw new Error('No labels are available');
    const printCommands = [];
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      const svgElement = card.querySelector('[data-label-preview] svg');
      const designSource = card.querySelector('[data-label-design]');
      let config = {};
      try { config = JSON.parse(designSource?.value || '{}').labelConfig || {}; } catch { /* use defaults */ }
      const widthMm = Number.parseFloat(String(config.width || '60'));
      const heightMm = Number.parseFloat(String(config.height || '30'));
      if (!svgElement) throw new Error('Badge preview is not ready');
      // QR codes render once qrcode.min.js finishes loading (kiosk-labels.js
      // marks them pending) — don't print a badge whose QR is still missing.
      if (svgElement.querySelector('[data-qr-pending]')) throw new Error('Badge preview is not ready');
      button.textContent = `Preparing ${index + 1} of ${cards.length}…`;
      printCommands.push(await encodeBadge(svgElement, widthMm, heightMm));
    }
    const bitmapOutput = document.getElementById('bitmapOutput');
    if (!bitmapOutput) throw new Error('Print output is unavailable');
    // Each encoded label ends with 0C (form feed). Concatenating the full
    // command streams preserves both page boundaries while the transport
    // sends them to the printer server/USB device as one job.
    bitmapOutput.value = printCommands.join('\n');
    button.textContent = 'Sending to printer…';
    await connectAndPrintWithBitmap(bitmapOutput);
    button.textContent = `Sent ${cards.length} label${cards.length === 1 ? '' : 's'} to printer`;
  } catch (error) {
    console.error('Badge print failed:', error);
    alert('Could not print labels: ' + error.message);
    button.textContent = originalText;
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 2000);
  }
}

async function initGuestActions() {
  const root = document.querySelector('[data-kiosk-guest]');
  if (!root) return;

  root.querySelectorAll('form[data-kiosk-action]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const confirmation = form.getAttribute('data-confirm');
      if (confirmation && !window.confirm(confirmation)) return;

      const button = form.querySelector('button[type="submit"]');
      const originalText = button?.textContent || '';
      if (button) {
        button.disabled = true;
        button.textContent = 'Saving…';
      }

      try {
        const actionUrl = new URL(form.action, window.location.origin);
        actionUrl.searchParams.set('json', '1');
        const response = await fetch(actionUrl, {
          method: 'POST',
          body: new FormData(form),
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'X-Requested-With': 'fetch' },
        });
        if (!response.ok) throw new Error(await response.text() || `Request failed (${response.status})`);
        const payload = await response.json();
        const nextRoot = await renderKioskGuestRoot(payload);
        root.replaceWith(nextRoot);
        if (typeof window.renderKioskLabels === 'function') window.renderKioskLabels(nextRoot);
        initBadgePrint();
        initGuestActions();
        if (payload?.data?.autoPrint) {
          const printButton = nextRoot.querySelector('[data-print-badges]');
          if (printButton) await printBadges(printButton);
        }
      } catch (error) {
        console.error('Kiosk guest action failed:', error);
        alert('Could not update check-in: ' + error.message);
        if (button) {
          button.disabled = false;
          button.textContent = originalText;
        }
      }
    });
  });
}

async function renderKioskGuestRoot(payload) {
  if (!payload || payload.template !== 'kiosk-guest' || !payload.data) {
    throw new Error('The refreshed guest view was invalid');
  }
  if (!window.liquidjs?.Liquid) throw new Error('The page renderer is unavailable');
  const response = await fetch('/admin/plugins/checkin/views/sections/kiosk-guest.liquid', {
    credentials: 'same-origin',
    headers: { Accept: 'text/plain' },
  });
  if (!response.ok) throw new Error('The guest view could not be refreshed');
  const engine = new window.liquidjs.Liquid();
  const html = await engine.parseAndRender(await response.text(), payload.data);
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content.querySelector('[data-kiosk-guest]');
  if (!root) throw new Error('The refreshed guest view was empty');
  return root;
}

async function encodeBadge(svgElement, widthMm, heightMm) {
  const viewBoxAttr = svgElement.getAttribute('viewBox');
  const viewBox = viewBoxAttr ? viewBoxAttr.split(/\s+/).map(Number) : [0, 0, 0, 0];
  const svgWidth = Number.parseFloat(svgElement.getAttribute('width') || '') || viewBox[2] || 0;
  const svgHeight = Number.parseFloat(svgElement.getAttribute('height') || '') || viewBox[3] || 0;
  // Match Events label printing: the SVG is already margin-adjusted at
  // 150 DPI, so rasterize it at 2x instead of rebuilding physical dimensions.
  const width = Math.round(svgWidth * 2);
  const height = Math.round(svgHeight * 2);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const encoder = new LabelEncoder({ width: widthMm, height: heightMm });
  await new Promise((resolve, reject) => {
    try {
      encoder.svgElementToCanvas(
        svgElement,
        ctx,
        width,
        height,
        svgWidth,
        svgHeight,
        true,
        128,
        (error) => error ? reject(error) : resolve(),
        'threshold',
      );
    } catch (error) {
      reject(error);
    }
  });

  return encoder.encodeBitmap(canvas);
}
