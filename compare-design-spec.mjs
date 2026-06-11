/**
 * Stage C: Compare collected element styles against DESIGN2-0.md design tokens.
 * Reads the latest (or specified) computed-styles.json artifact and emits
 * a structured compliance report.
 *
 * Usage:
 *   node compare-design-spec.mjs [run-dir]
 *   RUN_DIR=/abs/path node compare-design-spec.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Resolve run dir ──────────────────────────────────────────────────────────

const artifactsRoot = path.join(__dirname, 'artifacts', 'stage-b-current-state');

async function latestRunDir() {
  const entries = await fs.readdir(artifactsRoot);
  const dirs = entries.filter(e => /^\d{4}-\d{2}-\d{2}T/.test(e)).sort();
  if (!dirs.length) throw new Error(`No run dirs found in ${artifactsRoot}`);
  return path.join(artifactsRoot, dirs[dirs.length - 1]);
}

const runDir = process.env.RUN_DIR || process.argv[2] || await latestRunDir();
const reportPath = path.join(runDir, 'design-compliance.json');
const htmlReportPath = path.join(runDir, 'design-compliance.html');

// ─── Design tokens (parsed from DESIGN2-0.md frontmatter) ────────────────────

function parseDesignColors(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const lines = fm[1].split('\n');
  const colors = {};
  let inColors = false;
  for (const line of lines) {
    if (/^colors:/.test(line)) { inColors = true; continue; }
    if (inColors && /^[a-z]/i.test(line)) break;
    if (inColors) {
      const m = line.match(/^\s+([\w-]+):\s+"(.+?)"\s*$/);
      if (m) colors[m[1]] = m[2];
    }
  }
  return colors;
}

const designSpecText = await fs.readFile(path.join(__dirname, 'DESIGN2-0.md'), 'utf8');

const DESIGN_TOKENS = {
  colors: parseDesignColors(designSpecText),

  // All valid font sizes in the system
  fontSizes: new Set(['12px', '14px', '16px', '18px', '20px', '24px']),

  // All valid font weights
  fontWeights: new Set(['400', '500']),

  // Valid border-radius values (100px treated as pill-shape alias of 1000px)
  borderRadii: new Set(['2px', '4px', '6px', '8px', '12px', '16px', '1000px', '100px', '0px']),

  // Valid spacing multiples (4px grid)
  spacingBase: 4,

  shadows: {
    base: '0px 4px 10px 0px rgba(191, 196, 217, 0.22)',
    secondary: '0px 6px 12px 0px rgba(191, 196, 217, 0.3)',
    tertiary: '-8px 0px 22px 0px rgba(191, 196, 217, 0.2)',
    up: '0px 0px 12px 0px rgba(191, 196, 217, 0.33)',
  },
};

// Normalise hex to lowercase #rrggbb
function normalizeColor(c) {
  if (!c) return null;
  c = c.trim().toLowerCase();
  // expand #rgb → #rrggbb
  if (/^#[0-9a-f]{3}$/.test(c)) {
    return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
  }
  // rgb(r,g,b) → hex
  const rgb = c.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/);
  if (rgb) {
    return '#' + [rgb[1], rgb[2], rgb[3]]
      .map(n => parseInt(n, 10).toString(16).padStart(2, '0'))
      .join('');
  }
  return c;
}

// Build a Set of all design-token color values (lowercase hex)
const knownColors = new Set(
  Object.values(DESIGN_TOKENS.colors).map(c => normalizeColor(c))
);
// Also add transparent and white/black special values
knownColors.add('transparent');
knownColors.add('rgba(0, 0, 0, 0)');
knownColors.add('#ffffff');
knownColors.add('#000000');

function isKnownColor(raw) {
  if (!raw || raw === 'none' || raw === '' || raw === 'initial' || raw === 'inherit') return true;
  const norm = normalizeColor(raw);
  if (!norm) return true;
  if (norm === 'transparent' || norm === 'rgba(0, 0, 0, 0)') return true;
  // rgba with alpha → harder to check, just allow
  if (norm.startsWith('rgba(')) return true;
  return knownColors.has(norm);
}

function parsePixels(val) {
  if (!val || val === 'none' || val === 'normal' || val === 'auto') return null;
  const m = val.match(/^(-?\d+(?:\.\d+)?)px$/);
  return m ? parseFloat(m[1]) : null;
}

function isOnGrid(val, base = 4) {
  const px = parsePixels(val);
  if (px === null) return true; // can't check, skip
  if (px === 0) return true;
  return px % base === 0;
}

// ─── Load collected data ──────────────────────────────────────────────────────

const rawData = JSON.parse(await fs.readFile(path.join(runDir, 'computed-styles.json'), 'utf8'));
const { page, elements } = rawData;

// ─── Per-element analysis ─────────────────────────────────────────────────────

const issues = [];
const stats = {
  total: elements.length,
  withIssues: 0,
  colorViolations: 0,
  fontSizeViolations: 0,
  fontWeightViolations: 0,
  borderRadiusViolations: 0,
  spacingViolations: 0,
};

for (const el of elements) {
  const s = el.styles;
  const elIssues = [];

  // Skip invisible / tiny elements
  if (el.bbox.width < 4 || el.bbox.height < 4) continue;
  // Skip SVG internals
  if (['path', 'svg', 'defs', 'use', 'g', 'circle', 'rect', 'line', 'polyline', 'polygon', 'mask', 'clipPath', 'linearGradient', 'stop', 'symbol', 'title'].includes(el.tagName)) continue;

  // ── Color checks ─────────────────────────────────────────────────────────

  // For border-color, only flag when the border is actually visible (width > 0)
  const borderSides = ['top', 'right', 'bottom', 'left'];
  const visibleBorderSides = new Set(
    borderSides.filter(side => {
      const w = s[`border-${side}-width`];
      const style = s[`border-${side}-style`];
      return w && w !== '0px' && style && style !== 'none' && style !== 'hidden';
    })
  );

  const colorProps = ['color', 'background-color'];
  const borderColorProps = borderSides
    .filter(side => visibleBorderSides.has(side))
    .map(side => `border-${side}-color`);

  for (const prop of [...colorProps, ...borderColorProps]) {
    const val = s[prop];
    if (!val || val === '' || val === 'none') continue;
    if (val === 'rgba(0, 0, 0, 0)') continue;
    if (!isKnownColor(val)) {
      const hexVal = normalizeColor(val) ?? val;
      elIssues.push({ type: 'color', prop, actual: hexVal, message: `${prop}: "${hexVal}" is not a design-token color` });
    }
  }

  // ── Font size ─────────────────────────────────────────────────────────────

  const fontSize = s['font-size'];
  if (fontSize && !DESIGN_TOKENS.fontSizes.has(fontSize)) {
    elIssues.push({ type: 'fontSize', prop: 'font-size', actual: fontSize, message: `font-size: "${fontSize}" outside type scale (${[...DESIGN_TOKENS.fontSizes].join(', ')})` });
  }

  // ── Font weight ───────────────────────────────────────────────────────────

  const fontWeight = s['font-weight'];
  if (fontWeight && !DESIGN_TOKENS.fontWeights.has(fontWeight)) {
    // Only flag non-normal, non-bold values that are off-spec
    const numeric = parseFloat(fontWeight);
    if (!isNaN(numeric) && numeric !== 400 && numeric !== 500) {
      elIssues.push({ type: 'fontWeight', prop: 'font-weight', actual: fontWeight, message: `font-weight: "${fontWeight}" not in design system (400 or 500 only)` });
    }
  }

  // ── Border radius ─────────────────────────────────────────────────────────

  const brProps = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
  for (const prop of brProps) {
    const val = s[prop];
    if (val && val !== '0px' && !DESIGN_TOKENS.borderRadii.has(val)) {
      // Allow percentages (e.g. 50% circles)
      if (val.endsWith('%')) continue;
      elIssues.push({ type: 'borderRadius', prop, actual: val, message: `${prop}: "${val}" not in border-radius scale` });
    }
  }

  // ── Spacing grid (padding) ────────────────────────────────────────────────

  const paddingProps = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
  for (const prop of paddingProps) {
    const val = s[prop];
    if (val && !isOnGrid(val)) {
      elIssues.push({ type: 'spacing', prop, actual: val, message: `${prop}: "${val}" not on 4px grid` });
    }
  }

  if (elIssues.length) {
    stats.withIssues += 1;
    for (const issue of elIssues) {
      switch (issue.type) {
        case 'color': stats.colorViolations += 1; break;
        case 'fontSize': stats.fontSizeViolations += 1; break;
        case 'fontWeight': stats.fontWeightViolations += 1; break;
        case 'borderRadius': stats.borderRadiusViolations += 1; break;
        case 'spacing': stats.spacingViolations += 1; break;
      }
    }
    issues.push({
      elementIndex: el.index,
      tagName: el.tagName,
      selector: el.selector,
      text: el.text?.slice(0, 80),
      bbox: el.bbox,
      screenshot: el.screenshot,
      issues: elIssues,
    });
  }
}

// ─── Aggregate color usage ────────────────────────────────────────────────────

const colorFrequency = {};
for (const el of elements) {
  for (const prop of ['color', 'background-color']) {
    const val = normalizeColor(el.styles[prop]);
    if (!val || val === 'rgba(0, 0, 0, 0)') continue;
    colorFrequency[val] = (colorFrequency[val] || 0) + 1;
  }
}
const topColors = Object.entries(colorFrequency)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 30)
  .map(([color, count]) => ({ color, count, isDesignToken: isKnownColor(color) }));

// ─── Categorise issues by type ────────────────────────────────────────────────

const issuesByType = {};
for (const el of issues) {
  for (const issue of el.issues) {
    if (!issuesByType[issue.type]) issuesByType[issue.type] = [];
    // Group by actual value
    const key = `${issue.prop}:${issue.actual}`;
    const existing = issuesByType[issue.type].find(g => g.key === key);
    if (existing) {
      existing.count += 1;
      existing.examples.push({ selector: el.selector, text: el.text });
    } else {
      issuesByType[issue.type].push({ key, prop: issue.prop, actual: issue.actual, message: issue.message, count: 1, examples: [{ selector: el.selector, text: el.text }] });
    }
  }
}

// Sort each group by frequency descending
for (const type of Object.keys(issuesByType)) {
  issuesByType[type].sort((a, b) => b.count - a.count);
}

// ─── Build report ─────────────────────────────────────────────────────────────

const complianceScore = stats.total > 0
  ? Math.round(((stats.total - stats.withIssues) / stats.total) * 100)
  : 100;

const report = {
  meta: {
    runDir,
    generatedAt: new Date().toISOString(),
    page: page.url,
    title: page.title,
    designSpec: 'DESIGN2-0.md',
    viewport: page.viewport,
  },
  summary: {
    totalElementsChecked: stats.total,
    elementsWithIssues: stats.withIssues,
    complianceScore: `${complianceScore}%`,
    violations: {
      color: stats.colorViolations,
      fontSize: stats.fontSizeViolations,
      fontWeight: stats.fontWeightViolations,
      borderRadius: stats.borderRadiusViolations,
      spacing: stats.spacingViolations,
    },
  },
  topColors,
  issuesByType,
  elementIssues: issues,
};

await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

// ─── Generate HTML report ─────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colorSwatch(hex) {
  const norm = normalizeColor(hex) || hex;
  return `<span class="swatch" style="background:${escHtml(norm)}" title="${escHtml(hex)}"></span>`;
}

const typeLabels = { color: '色值', fontSize: '字号', fontWeight: '字重', borderRadius: '圆角', spacing: '间距' };

const typeBlocks = Object.entries(issuesByType).map(([type, groups]) => {
  const rows = groups.slice(0, 30).map(g => {
    const exList = g.examples.slice(0, 3).map(e => `<li><code>${escHtml(e.selector)}</code>${e.text ? ` — ${escHtml(e.text)}` : ''}</li>`).join('');
    // 色值列：rgb(…) 转换为 #rrggbb 方便与 DESIGN2-0.md 对照
    const displayActual = type === 'color' ? (normalizeColor(g.actual) ?? g.actual) : g.actual;
    const displayMsg    = type === 'color' ? g.message.replace(g.actual, displayActual) : g.message;
    return `<tr>
      <td>${type === 'color' ? colorSwatch(g.actual) : ''}<code>${escHtml(displayActual)}</code></td>
      <td><code>${escHtml(g.prop)}</code></td>
      <td class="count">${g.count}</td>
      <td class="msg">${escHtml(displayMsg)}</td>
      <td><ul>${exList}</ul></td>
    </tr>`;
  }).join('');
  return `<section class="type-block">
    <h2>${typeLabels[type] || type} 违规 <span class="badge">${groups.length} 种 / ${groups.reduce((s, g) => s + g.count, 0)} 处</span></h2>
    <table>
      <thead><tr><th>实际值</th><th>属性</th><th>数量</th><th>说明</th><th>示例</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}).join('\n');

const colorRows = topColors.map(({ color, count, isDesignToken }) => {
  const cls = isDesignToken ? 'ok' : 'warn';
  return `<tr class="${cls}"><td>${colorSwatch(color)}<code>${escHtml(color)}</code></td><td class="count">${count}</td><td>${isDesignToken ? '✓ token' : '⚠ 非 token'}</td></tr>`;
}).join('');

const screenshotItems = issues.slice(0, 60).flatMap(el =>
  el.screenshot
    ? [`<figure>
        <img src="${escHtml(el.screenshot)}" loading="lazy" alt="${escHtml(el.selector)}" />
        <figcaption>
          <code>${escHtml(el.tagName)}</code>
          ${el.issues.map(i => `<span class="chip">${escHtml(i.type)}</span>`).join(' ')}
          <br/><small>${escHtml(el.selector?.slice(0, 80))}</small>
        </figcaption>
      </figure>`]
    : []
).join('\n');

const runId = path.basename(runDir);
const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<title>设计规范合规报告 — ${escHtml(page.title)}</title>
<style>
  :root {
    --primary: #3855D5;
    --ok: #00BA73;
    --warn: #FAAD14;
    --error: #F54242;
    --bg: #F7F8F9;
    --card: #ffffff;
    --border: #EAECF3;
    --text: #242529;
    --text2: #5A5C66;
    --text3: #9296A6;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: 'PingFang SC', -apple-system, sans-serif; font-size: 14px; color: var(--text); background: var(--bg); }
  .hero { background: var(--primary); color: #fff; padding: 32px 40px; display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .hero-text h1 { margin: 0 0 4px; font-size: 24px; font-weight: 500; }
  .hero-text p { margin: 0; opacity: .8; font-size: 14px; }
  .hero-visual-btn { display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.15); border: 1.5px solid rgba(255,255,255,0.4); color: #fff; border-radius: 8px; padding: 9px 18px; font-size: 14px; font-weight: 500; text-decoration: none; white-space: nowrap; transition: background .15s; flex-shrink: 0; margin-top: 4px; }
  .hero-visual-btn:hover { background: rgba(255,255,255,0.25); }
  .container { max-width: 1280px; margin: 0 auto; padding: 24px 40px 64px; }
  .score-row { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .score-card { background: var(--card); border-radius: 12px; padding: 20px 24px; flex: 1 1 160px;
    box-shadow: 0 4px 10px rgba(191,196,217,.22); }
  .score-card .label { font-size: 12px; color: var(--text3); margin-bottom: 6px; }
  .score-card .value { font-size: 28px; font-weight: 500; color: var(--primary); }
  .score-card.ok .value { color: var(--ok); }
  .score-card.warn .value { color: var(--warn); }
  .score-card.error .value { color: var(--error); }

  section.type-block { background: var(--card); border-radius: 12px; padding: 24px;
    box-shadow: 0 4px 10px rgba(191,196,217,.22); margin-bottom: 20px; }
  h2 { font-size: 16px; font-weight: 500; margin: 0 0 16px; display: flex; align-items: center; gap: 8px; }
  .badge { background: #F0F5FF; color: var(--primary); border-radius: 1000px; padding: 2px 10px; font-size: 12px; font-weight: 400; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; background: #F6F8F9; color: var(--text3); font-weight: 400; border-bottom: 1px solid var(--border); }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr.ok td { background: #F0FFF6; }
  tr.warn td { background: #FFFBE6; }
  .count { font-weight: 500; color: var(--primary); text-align: right; white-space: nowrap; }
  .msg { color: var(--text2); max-width: 300px; }
  ul { margin: 0; padding-left: 16px; }
  li { margin-bottom: 4px; }
  code { background: #F6F8F9; border-radius: 4px; padding: 1px 5px; font-family: 'Menlo', monospace; font-size: 12px; word-break: break-all; }
  .swatch { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(0,0,0,.12); vertical-align: middle; margin-right: 6px; }
  .chip { background: #F0F5FF; color: var(--primary); border-radius: 4px; padding: 1px 6px; font-size: 11px; }

  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-top: 16px; }
  figure { margin: 0; background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  figure img { width: 100%; display: block; object-fit: cover; max-height: 120px; }
  figcaption { padding: 8px; font-size: 11px; color: var(--text2); }
</style>
</head>
<body>
<div class="hero">
  <div class="hero-text">
    <h1>设计规范合规报告</h1>
    <p>${escHtml(page.title)} · ${escHtml(page.url)} · ${escHtml(new Date().toLocaleString('zh-CN'))}</p>
  </div>
  <a class="hero-visual-btn" href="/reports/${escHtml(runId)}/visual" target="_blank">📊 查看图示</a>
</div>
<div class="container">

  <div class="score-row">
    <div class="score-card ${complianceScore >= 90 ? 'ok' : complianceScore >= 70 ? 'warn' : 'error'}">
      <div class="label">综合合规率</div>
      <div class="value">${complianceScore}%</div>
    </div>
    <div class="score-card">
      <div class="label">检查元素数</div>
      <div class="value" style="color:var(--text)">${stats.total}</div>
    </div>
    <div class="score-card warn">
      <div class="label">有违规元素</div>
      <div class="value">${stats.withIssues}</div>
    </div>
    <div class="score-card">
      <div class="label">色值违规</div>
      <div class="value" style="color:var(--error)">${stats.colorViolations}</div>
    </div>
    <div class="score-card">
      <div class="label">字号违规</div>
      <div class="value" style="color:var(--error)">${stats.fontSizeViolations}</div>
    </div>
    <div class="score-card">
      <div class="label">圆角违规</div>
      <div class="value" style="color:var(--error)">${stats.borderRadiusViolations}</div>
    </div>
    <div class="score-card">
      <div class="label">间距违规</div>
      <div class="value" style="color:var(--error)">${stats.spacingViolations}</div>
    </div>
  </div>

  ${typeBlocks}

  <section class="type-block">
    <h2>颜色使用频率 Top ${topColors.length}</h2>
    <table>
      <thead><tr><th>颜色</th><th>使用次数</th><th>状态</th></tr></thead>
      <tbody>${colorRows}</tbody>
    </table>
  </section>

  ${screenshotItems ? `<section class="type-block">
    <h2>违规元素截图（前 60）</h2>
    <div class="gallery">${screenshotItems}</div>
  </section>` : ''}

</div>
</body>
</html>`;

await fs.writeFile(htmlReportPath, html);

// ─── Console summary ──────────────────────────────────────────────────────────

console.log(JSON.stringify({
  ok: true,
  runDir,
  reportPath,
  htmlReportPath,
  complianceScore: report.summary.complianceScore,
  summary: report.summary,
}, null, 2));
