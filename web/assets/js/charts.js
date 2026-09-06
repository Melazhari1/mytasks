/* =============================================================================
   Charts — hand-rolled SVG. No chart library, no build step.

   Rules baked in here rather than left to the caller:
     · colours come from CSS custom properties, so a theme switch re-steps
       every mark against the new surface (charts redraw on 'themechange')
     · gridlines and axes are SOLID hairlines one shade off the surface
     · 2px strokes on lines, 4px rounded data-ends on bars anchored to the
       baseline, a 2px surface gap between adjacent bars
     · a legend whenever there are ≥ 2 series, plus selective direct labels —
       the endpoint only, never a number on every point
     · a hover layer by default, and a table view so the data is reachable
       without seeing colour at all
   ========================================================================== */

import { Theme, escapeHtml } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

let tooltipEl;

function tooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'tooltip';
    tooltipEl.setAttribute('role', 'presentation');
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function showTooltip(html, clientX, clientY) {
  const t = tooltip();
  t.innerHTML = html;
  t.dataset.open = 'true';

  // Keep it on screen near the edges.
  const pad = 10;
  const rect = t.getBoundingClientRect();
  const x = Math.min(Math.max(clientX, rect.width / 2 + pad), window.innerWidth - rect.width / 2 - pad);
  const y = Math.max(clientY, rect.height + pad);

  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.dataset.open = 'false';
}

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/**
 * Axis scale with whole-number ticks.
 *
 * Picking a round *max* and then slicing it into N is what produces axes like
 * 0, 1, 3, 4, 5 — the step, not the max, is what has to be round. So round the
 * step first and let the max fall out of it. These are counts, so small
 * maxima get a step of exactly 1 rather than an axis padded with headroom.
 */
function niceScale(maxValue) {
  const value = Math.max(1, maxValue);

  if (value <= 6) return { max: value, step: 1, ticks: value };

  const raw = value / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;

  const ticks = Math.ceil(value / step);

  return { max: step * ticks, step, ticks };
}

/** Upper bound only — bar charts scale to it but draw no gridlines. */
function niceMax(value) {
  return niceScale(value).max;
}

/* Redraw every registered chart when the theme flips — the dark and light
   palettes are separately validated sets, not a filter over one set. */
const registry = new Set();

window.addEventListener('themechange', () => {
  registry.forEach((redraw) => redraw());
});

function register(host, draw) {
  const redraw = () => { host.innerHTML = ''; draw(hostWidth(host)); };
  registry.add(redraw);

  // Stop redrawing charts whose host has left the document.
  new MutationObserver(() => {
    if (!document.contains(host)) registry.delete(redraw);
  }).observe(document.body, { childList: true, subtree: true });

  // Charts are drawn in CSS pixels (see hostWidth), so a width change is a
  // re-draw, not a stretch — otherwise 11px labels shrink to 4px on a phone.
  let lastWidth = hostWidth(host);
  let resizeTimer;

  new ResizeObserver(() => {
    const width = hostWidth(host);
    if (Math.abs(width - lastWidth) < 8) return;

    lastWidth = width;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redraw, 120);
  }).observe(host);

  // redraw(), not draw() — the host still holds the loading skeleton, and
  // drawing over it would leave a ghost block above every chart.
  redraw();
}

/**
 * Draw in CSS pixels: 1 SVG unit = 1 rendered pixel, so font sizes, stroke
 * widths and the 2px gaps all stay literal at any container width.
 */
function hostWidth(host) {
  return Math.max(300, Math.round(host.clientWidth || host.parentElement?.clientWidth || 720));
}

/* --- Table view ----------------------------------------------------------
   Every chart ships one. It is the fallback when colour can't be seen, when
   the chart is printed, and when a reader just wants the numbers.          */
function attachTable(container, headers, rows, label) {
  const wrap = document.createElement('div');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chart-table-toggle';
  btn.textContent = 'Show data table';
  btn.setAttribute('aria-expanded', 'false');

  const tableWrap = document.createElement('div');
  tableWrap.className = 'chart-table table-wrap';
  tableWrap.hidden = true;
  tableWrap.innerHTML = `
    <table class="data">
      <caption class="visually-hidden">${escapeHtml(label)}</caption>
      <thead><tr>${headers.map((h, i) =>
        `<th ${i ? 'class="num"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) =>
        `<td ${i ? 'class="num"' : ''}>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;

  btn.addEventListener('click', () => {
    tableWrap.hidden = !tableWrap.hidden;
    btn.textContent = tableWrap.hidden ? 'Show data table' : 'Hide data table';
    btn.setAttribute('aria-expanded', String(!tableWrap.hidden));
  });

  wrap.append(btn, tableWrap);
  container.appendChild(wrap);
}

function legend(container, series) {
  const box = document.createElement('div');
  box.className = 'legend';
  box.innerHTML = series.map((s) => `
    <span class="legend__item">
      <span class="legend__swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}
    </span>`).join('');
  container.appendChild(box);
}

/* =============================================================================
   Line chart — change over time. Crosshair + shared tooltip.
   ========================================================================== */
export function lineChart(host, { labels, series, title = 'Activity', valueLabel = 'tasks' }) {
  register(host, (W) => {
    const colors = series.map((s) => Theme.token(s.token));
    const resolved = series.map((s, i) => ({ ...s, color: colors[i] }));

    if (resolved.length >= 2) legend(host, resolved);

    const H = W < 460 ? 200 : 240;
    const pad = { top: 14, right: 44, bottom: 26, left: 34 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const scale = niceScale(Math.max(1, ...resolved.flatMap((s) => s.values)));
    const max = scale.max;
    const n = labels.length;

    const xAt = (i) => pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yAt = (v) => pad.top + plotH - (v / max) * plotH;

    const svg = el('svg', {
      class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': `${title}. Line chart, ${n} days.`,
      style: `height:${H}px`,
    });

    // Gridlines — solid hairlines, never dashed.
    for (let i = 0; i <= scale.ticks; i++) {
      const v = scale.step * i;
      const y = yAt(v);
      svg.appendChild(el('line', { class: 'chart__grid', x1: pad.left, x2: W - pad.right, y1: y, y2: y }));
      svg.appendChild(el('text', {
        class: 'chart__label', x: pad.left - 8, y: y + 4, 'text-anchor': 'end',
      }, Math.round(v)));
    }

    svg.appendChild(el('line', {
      class: 'chart__axis',
      x1: pad.left, x2: W - pad.right, y1: pad.top + plotH, y2: pad.top + plotH,
    }));

    // X labels: first, middle, last only — a label under every day is noise.
    [0, Math.floor((n - 1) / 2), n - 1].forEach((i, idx, arr) => {
      if (arr.indexOf(i) !== idx) return;
      svg.appendChild(el('text', {
        class: 'chart__label', x: xAt(i), y: H - 6,
        'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
      }, labels[i]));
    });

    resolved.forEach((s) => {
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`).join(' ');
      svg.appendChild(el('path', { class: 'chart__series', d, stroke: s.color }));

      // Selective direct label: the endpoint only.
      const last = s.values[s.values.length - 1];
      svg.appendChild(el('circle', {
        class: 'chart__dot', cx: xAt(n - 1), cy: yAt(last), r: 4.5, fill: s.color,
      }));
      svg.appendChild(el('text', {
        class: 'chart__value', x: W - pad.right + 8, y: yAt(last) + 4, 'text-anchor': 'start',
      }, last));
    });

    // Hover layer: one column per point, wider than the marks themselves.
    const crosshair = el('line', {
      class: 'chart__axis', y1: pad.top, y2: pad.top + plotH,
      opacity: 0, 'stroke-width': 1,
    });
    svg.appendChild(crosshair);

    const dots = resolved.map((s) =>
      svg.appendChild(el('circle', { class: 'chart__dot', r: 5, fill: s.color, opacity: 0 })));

    const band = plotW / Math.max(1, n - 1);

    labels.forEach((label, i) => {
      const hit = el('rect', {
        class: 'chart__hit',
        x: xAt(i) - band / 2, y: pad.top,
        width: band, height: plotH,
      });

      const move = (event) => {
        crosshair.setAttribute('x1', xAt(i));
        crosshair.setAttribute('x2', xAt(i));
        crosshair.setAttribute('opacity', '1');

        dots.forEach((dot, si) => {
          dot.setAttribute('cx', xAt(i));
          dot.setAttribute('cy', yAt(resolved[si].values[i]));
          dot.setAttribute('opacity', '1');
        });

        showTooltip(`
          <div class="tooltip__title">${escapeHtml(label)}</div>
          ${resolved.map((s) => `
            <div class="tooltip__row">
              <span class="tooltip__swatch" style="background:${s.color}"></span>
              ${escapeHtml(s.label)}<b>${s.values[i]}</b>
            </div>`).join('')}`,
          event.clientX, event.clientY - 8);
      };

      hit.addEventListener('mousemove', move);
      hit.addEventListener('mouseenter', move);
      hit.addEventListener('mouseleave', () => {
        crosshair.setAttribute('opacity', '0');
        dots.forEach((d) => d.setAttribute('opacity', '0'));
        hideTooltip();
      });

      svg.appendChild(hit);
    });

    host.appendChild(svg);

    attachTable(
      host,
      ['Day', ...resolved.map((s) => s.label)],
      labels.map((label, i) => [label, ...resolved.map((s) => String(s.values[i]))]),
      `${title} — ${valueLabel} per day`,
    );
  });
}

/* =============================================================================
   Horizontal bar chart — magnitude across a handful of named things.

   `ordinal: true` uses the per-row colour (the validated violet ramp for
   priority). Otherwise every bar takes series slot 1: one series, one colour.
   A value ramp over nominal categories would double-encode bar length as hue.
   ========================================================================== */
export function barChart(host, { rows, title = 'Breakdown', unit = 'tasks', ordinal = false }) {
  register(host, (W) => {
    if (!rows.length) {
      host.innerHTML = '<p class="card__sub" style="margin:0">Nothing to chart yet.</p>';
      return;
    }

    const fallback = Theme.token('--series-1');
    const resolved = rows.map((r) => ({
      ...r,
      color: ordinal && r.token ? Theme.token(r.token) : fallback,
    }));

    const BAR = 20, GAP = 14;            // 2px surface gap is the minimum; 14 breathes
    const labelW = Math.min(116, Math.max(58, Math.round(W * 0.28)));
    const pad = { top: 4, right: 46, bottom: 4, left: labelW };
    const H = pad.top + pad.bottom + resolved.length * (BAR + GAP) - GAP;
    const plotW = W - pad.left - pad.right;

    // Truncate to whatever the label gutter can actually hold at 11px.
    const maxChars = Math.max(6, Math.floor(labelW / 6.2));

    const max = niceMax(Math.max(1, ...resolved.map((r) => r.value)));

    const svg = el('svg', {
      class: 'chart', viewBox: `0 0 ${W} ${H}`,
      role: 'img', 'aria-label': `${title}. Bar chart.`,
      style: `height:${H}px`,
    });

    // Baseline the bars are anchored to.
    svg.appendChild(el('line', {
      class: 'chart__axis', x1: pad.left, x2: pad.left, y1: pad.top, y2: H - pad.bottom,
    }));

    resolved.forEach((row, i) => {
      const y = pad.top + i * (BAR + GAP);
      const w = Math.max(3, (row.value / max) * plotW);
      const r = Math.min(4, w / 2);      // 4px rounded data-end

      svg.appendChild(el('text', {
        class: 'chart__label', x: pad.left - 12, y: y + BAR / 2 + 4, 'text-anchor': 'end',
      }, row.label.length > maxChars ? `${row.label.slice(0, maxChars - 1)}…` : row.label));

      // Square at the baseline, rounded at the data end.
      const bar = el('path', {
        d: `M${pad.left} ${y} H${pad.left + w - r} a${r} ${r} 0 0 1 ${r} ${r}
            V${y + BAR - r} a${r} ${r} 0 0 1 ${-r} ${r} H${pad.left} Z`,
        fill: row.color,
      });

      // Direct label — mandatory here: the low step of the ordinal ramp sits
      // under 3:1 against the surface, so the number carries the value.
      svg.appendChild(el('text', {
        class: 'chart__value', x: pad.left + w + 9, y: y + BAR / 2 + 4,
      }, row.value));

      const hit = el('rect', {
        class: 'chart__hit', x: pad.left, y: y - GAP / 2,
        width: plotW + pad.right, height: BAR + GAP,
      });

      const enter = (event) => {
        bar.setAttribute('opacity', '0.78');
        const pct = Math.round((row.value / Math.max(1, resolved.reduce((a, b) => a + b.value, 0))) * 100);
        showTooltip(`
          <div class="tooltip__title">${escapeHtml(row.label)}</div>
          <div class="tooltip__row">
            <span class="tooltip__swatch" style="background:${row.color}"></span>
            ${escapeHtml(unit)}<b>${row.value}</b>
          </div>
          <div class="tooltip__row">share<b>${pct}%</b></div>`,
          event.clientX, event.clientY - 6);
      };

      hit.addEventListener('mousemove', enter);
      hit.addEventListener('mouseenter', enter);
      hit.addEventListener('mouseleave', () => {
        bar.setAttribute('opacity', '1');
        hideTooltip();
      });

      svg.append(bar, hit);
    });

    host.appendChild(svg);

    attachTable(
      host,
      ['Name', unit.charAt(0).toUpperCase() + unit.slice(1)],
      resolved.map((r) => [r.label, String(r.value)]),
      title,
    );
  });
}

/* =============================================================================
   Completion meter — one number with a proportion behind it.
   A single share does not deserve a pie or a one-bar chart.
   ========================================================================== */
export function completionMeter(host, { done, total, label = 'completed' }) {
  register(host, (/* width — the meter is a fixed 140px disc */) => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    const color = Theme.token('--series-1');
    const track = Theme.token('--surface-3');

    const R = 52, C = 2 * Math.PI * R;

    const svg = el('svg', {
      class: 'chart', viewBox: '0 0 140 140', role: 'img',
      'aria-label': `${pct}% ${label}: ${done} of ${total}.`,
      style: 'height:140px;margin:0 auto;display:block',
    });

    svg.appendChild(el('circle', {
      cx: 70, cy: 70, r: R, fill: 'none', stroke: track, 'stroke-width': 12,
    }));
    svg.appendChild(el('circle', {
      cx: 70, cy: 70, r: R, fill: 'none', stroke: color, 'stroke-width': 12,
      'stroke-linecap': 'round',
      'stroke-dasharray': `${(pct / 100) * C} ${C}`,
      transform: 'rotate(-90 70 70)',
    }));

    const value = el('text', {
      x: 70, y: 72, 'text-anchor': 'middle',
      fill: Theme.token('--text-primary'),
      style: 'font-size:29px;font-weight:700',
    }, `${pct}%`);

    const sub = el('text', {
      x: 70, y: 93, 'text-anchor': 'middle',
      fill: Theme.token('--text-muted'), style: 'font-size:11px',
    }, `${done} of ${total}`);

    svg.append(value, sub);
    host.appendChild(svg);
  });
}
