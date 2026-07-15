// Read-only renderer for the JSON documents created by cms-plugin-events'
// label editor. Keep the stored document authoritative; this page never edits
// it and only substitutes the selected guest's tokens.
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PX_PER_MM = 150 / 25.4;
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

  function tokens() {
    const source = document.querySelector('[data-label-tokens]');
    try { return JSON.parse(source?.value || '{}'); } catch { return {}; }
  }

  function replaceTokens(value, values) {
    return String(value || '').replace(/\[@([A-Za-z0-9_]+)\]/g, (_all, key) => values[key] || '')
      .replace(/\s*\|\|\s*/g, '');
  }

  function rotate(element, item, x, y, width = 0, height = 0) {
    const degrees = number(item.rotation);
    if (!degrees) return;
    element.setAttribute('transform', `rotate(${degrees} ${x + width / 2} ${y + height / 2})`);
  }

  function appendText(svg, item, values) {
    const text = document.createElementNS(SVG_NS, 'text');
    const x = number(item.x), y = number(item.y);
    text.setAttribute('x', String(x)); text.setAttribute('y', String(y));
    text.setAttribute('text-anchor', item.textAnchor || 'start');
    text.setAttribute('fill', item.fill || '#000');
    text.style.fontFamily = item.fontFamily || 'Arial, sans-serif';
    text.style.fontSize = `${number(item.fontSize, 16)}px`;
    text.style.fontWeight = item.fontWeight || 'normal';
    text.style.fontStyle = item.fontStyle || 'normal';
    if (item.textDecoration && item.textDecoration !== 'none') text.style.textDecoration = item.textDecoration;
    rotate(text, item, x, y);
    const lineHeight = number(item.lineHeight, 1.2) * number(item.fontSize, 16);
    replaceTokens(item.text, values).split('\n').forEach((line, index) => {
      const span = document.createElementNS(SVG_NS, 'tspan');
      span.setAttribute('x', String(x)); span.setAttribute('dy', index ? String(lineHeight) : '0');
      span.textContent = line || ' ';
      text.appendChild(span);
    });
    svg.appendChild(text);
  }

  function appendImage(svg, item) {
    const image = document.createElementNS(SVG_NS, 'image');
    const x = number(item.x), y = number(item.y), width = number(item.width), height = number(item.height);
    image.setAttribute('x', String(x)); image.setAttribute('y', String(y)); image.setAttribute('width', String(width)); image.setAttribute('height', String(height));
    image.setAttribute('href', item.href || ''); rotate(image, item, x, y, width, height); svg.appendChild(image);
  }

  function appendShape(svg, item) {
    const shape = document.createElementNS(SVG_NS, item.shapeType === 'ellipse' ? 'ellipse' : 'rect');
    if (item.shapeType === 'ellipse') {
      shape.setAttribute('cx', String(number(item.cx))); shape.setAttribute('cy', String(number(item.cy)));
      shape.setAttribute('rx', String(number(item.rx))); shape.setAttribute('ry', String(number(item.ry)));
      rotate(shape, item, number(item.cx) - number(item.rx), number(item.cy) - number(item.ry), number(item.rx) * 2, number(item.ry) * 2);
    } else {
      const x = number(item.x), y = number(item.y), width = number(item.width), height = number(item.height);
      shape.setAttribute('x', String(x)); shape.setAttribute('y', String(y)); shape.setAttribute('width', String(width)); shape.setAttribute('height', String(height));
      if (number(item.rx) > 0) shape.setAttribute('rx', String(number(item.rx)));
      rotate(shape, item, x, y, width, height);
    }
    shape.setAttribute('fill', item.fill || '#fff'); shape.setAttribute('stroke', item.stroke || '#000'); shape.setAttribute('stroke-width', String(number(item.strokeWidth, 1))); svg.appendChild(shape);
  }

  // The host injects approved plugin scripts dynamically, which makes them
  // async — this file can execute before qrcode.min.js has loaded. Poll
  // briefly instead of dropping the QR element on the floor.
  function whenQrcodeReady(callback) {
    if (typeof window.qrcode === 'function') { callback(true); return; }
    let waited = 0;
    const timer = setInterval(() => {
      waited += 100;
      if (typeof window.qrcode === 'function') { clearInterval(timer); callback(true); }
      else if (waited >= 10000) { clearInterval(timer); callback(false); }
    }, 100);
  }

  function appendQr(svg, item, values) {
    const x = number(item.x), y = number(item.y), size = number(item.size, 50);
    const group = document.createElementNS(SVG_NS, 'g');
    const degrees = number(item.rotation);
    const translate = `translate(${x} ${y})`;
    group.setAttribute('transform', degrees ? `rotate(${degrees} ${x + size / 2} ${y + size / 2}) ${translate}` : translate);
    svg.appendChild(group);
    // Lets the print button (kiosk.js) refuse to serialize a badge whose QR
    // hasn't been drawn yet; cleared in every terminal state below.
    group.setAttribute('data-qr-pending', '');
    const text = replaceTokens(item.qrText, values) || ' ';
    whenQrcodeReady((ready) => {
      group.removeAttribute('data-qr-pending');
      if (!ready) return;
      let qr;
      try { qr = window.qrcode(0, item.errorLevel || 'M'); qr.addData(text); qr.make(); } catch { return; }
      const count = qr.getModuleCount();
      const background = document.createElementNS(SVG_NS, 'rect');
      background.setAttribute('width', String(size)); background.setAttribute('height', String(size)); background.setAttribute('fill', '#fff');
      group.appendChild(background);
      // One vector path in module units: adjacent squares share exact edges
      // (no seams), and it stays crisp at any preview or print-raster scale —
      // unlike the previous 1px-per-module PNG, which upscaled blurry.
      let d = '';
      for (let row = 0; row < count; row++) for (let column = 0; column < count; column++) {
        if (qr.isDark(row, column)) d += `M${column} ${row}h1v1h-1z`;
      }
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', '#000');
      path.setAttribute('transform', `scale(${size / count})`);
      group.appendChild(path);
    });
  }

  document.querySelectorAll('[data-label-design]').forEach((source) => {
    let design; try { design = JSON.parse(source.value); } catch { return; }
    const config = design?.labelConfig; if (!config) return;
    const width = Math.max(1, Math.floor(number(config.width, 60) * PX_PER_MM));
    const height = Math.max(1, Math.floor((number(config.height, 30) - 6) * PX_PER_MM));
    const svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('xmlns', SVG_NS); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height)); svg.style.maxWidth = '100%'; svg.style.height = 'auto';
    const background = document.createElementNS(SVG_NS, 'rect'); background.setAttribute('width', String(width)); background.setAttribute('height', String(height)); background.setAttribute('fill', config.backgroundColor || '#fff'); if (number(config.borderRadius) > 0) background.setAttribute('rx', String(number(config.borderRadius))); svg.appendChild(background);
    const values = tokens();
    const elements = [
      ...(design.textElements || []).map((item) => ({ type: 'text', item })),
      ...(design.imageElements || []).map((item) => ({ type: 'image', item })),
      ...(design.shapeElements || []).map((item) => ({ type: 'shape', item })),
      ...(design.qrcodeElements || []).map((item) => ({ type: 'qr', item })),
    ].sort((a, b) => number(a.item.zIndex) - number(b.item.zIndex));
    elements.forEach(({ type, item }) => {
      if (type === 'text') appendText(svg, item, values);
      else if (type === 'image') appendImage(svg, item);
      else if (type === 'shape') appendShape(svg, item);
      else appendQr(svg, item, values);
    });
    source.parentElement?.querySelector('[data-label-preview]')?.appendChild(svg);
  });
})();
