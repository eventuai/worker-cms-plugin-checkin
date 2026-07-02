// Kiosk glue: camera scanning (ZXingWASM, ported as-is from the legacy app —
// see qr-scanner.liquid's tryCode128Detection for the reference call shape)
// and badge printing (encoder.js SVG->bitmap + printer.js WebUSB/printer-server
// transport, also ported as-is).

function initKiosk() {
  // Point the decoder at the CMS-served, admin-approved wasm binary (same
  // origin, so connect-src 'self' allows it) instead of zxing's jsdelivr
  // default, which the admin CSP blocks. See views/assets/wasm.
  if (typeof ZXingWASM !== 'undefined' && ZXingWASM.setZXingModuleOverrides) {
    ZXingWASM.setZXingModuleOverrides({
      locateFile: (path, prefix) =>
        path.endsWith('.wasm') ? '/admin/plugins/checkin/assets/wasm/zxing_reader.wasm' : prefix + path,
    });
  }
  initScanner();
  initBadgePrint();
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

function initScanner() {
  const video = document.getElementById('scanVideo');
  if (!video || typeof ZXingWASM === 'undefined') return;

  const statusEl = document.getElementById('scanStatus');
  const codeForm = document.getElementById('scanCodeForm');
  const codeInput = document.getElementById('scanCodeInput');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let scanning = true;

  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } } })
    .then((stream) => {
      video.srcObject = stream;
      video.play();
      if (statusEl) statusEl.textContent = 'Scanning for codes…';
      scheduleScan();
    })
    .catch((error) => {
      console.error('Camera unavailable:', error);
      if (statusEl) statusEl.textContent = 'Camera unavailable — use manual entry below.';
    });

  function scheduleScan() {
    if (scanning) setTimeout(tick, 300);
  }

  async function tick() {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const results = await ZXingWASM.readBarcodes(blob, {
          tryHarder: true,
          formats: ['QRCode', 'Code128', 'EAN-13', 'ITF'],
          maxNumberOfSymbols: 1,
        });
        if (results && results.length > 0 && results[0].text) {
          scanning = false;
          onDecoded(results[0].text);
          return;
        }
      } catch (error) {
        // Decode miss on this frame — keep scanning.
      }
    }
    scheduleScan();
  }

  function onDecoded(text) {
    if (statusEl) statusEl.textContent = 'Code detected!';
    const checkinPath = checkinLinkPath(text);
    if (checkinPath) {
      window.location.href = checkinPath;
      return;
    }
    if (codeInput) codeInput.value = text;
    if (codeForm) codeForm.submit();
  }
}

/** If the decoded text is one of cms-plugin-events' /checkin/... links, returns its path+query; otherwise null. */
function checkinLinkPath(text) {
  try {
    const url = new URL(text, window.location.origin);
    return url.pathname.startsWith('/checkin/') ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

// ── Badge printing (encoder.js + printer.js) ────────────────────────────

function initBadgePrint() {
  const button = document.getElementById('printBadgeBtn');
  if (!button) return;

  button.addEventListener('click', async () => {
    const badgeHref = button.dataset.badgeHref;
    const widthMm = Number.parseFloat(button.dataset.widthMm || '60');
    const heightMm = Number.parseFloat(button.dataset.heightMm || '30');
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Printing…';
    try {
      await printBadge(badgeHref, widthMm, heightMm);
      button.textContent = 'Sent to printer';
    } catch (error) {
      console.error('Badge print failed:', error);
      alert('Could not print badge: ' + error.message);
      button.textContent = originalText;
    } finally {
      setTimeout(() => {
        button.disabled = false;
        button.textContent = originalText;
      }, 2000);
    }
  });
}

async function printBadge(badgeHref, widthMm, heightMm) {
  const response = await fetch(badgeHref);
  if (!response.ok) throw new Error('Badge not available for this event');
  const svgText = await response.text();

  const svgElement = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
  const viewBoxAttr = svgElement.getAttribute('viewBox');
  const dpi = 300;
  const pxPerMm = dpi / 25.4;
  const width = Math.round(widthMm * pxPerMm);
  const height = Math.round(heightMm * pxPerMm);
  const viewBox = viewBoxAttr ? viewBoxAttr.split(/\s+/).map(Number) : [0, 0, width, height];

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const encoder = new LabelEncoder({ width: widthMm, height: heightMm });
  await new Promise((resolve, reject) => {
    try {
      encoder.svgElementToCanvas(svgElement, ctx, width, height, viewBox[2] || width, viewBox[3] || height, true, 128, resolve, 'floyd-steinberg');
    } catch (error) {
      reject(error);
    }
  });

  const bitmapOutput = document.getElementById('bitmapOutput');
  if (bitmapOutput) bitmapOutput.value = encoder.encodeBitmap(canvas);
  await connectAndPrintWithBitmap(bitmapOutput);
}
