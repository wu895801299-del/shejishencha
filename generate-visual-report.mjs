/**
 * 从 design-compliance.json + computed-styles.json 生成可视化标注 HTML。
 * 用全部元素的 bbox 绘制页面结构骨架作底图，再叠加各类型违规框。
 * 不依赖 Playwright 或页面截图。
 *
 * 用法：
 *   node generate-visual-report.mjs [runDir]
 *   RUN_DIR=... node generate-visual-report.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const artifactsRoot = path.join(__dirname, 'artifacts', 'stage-b-current-state');

async function latestRunDir() {
  const entries = await fs.readdir(artifactsRoot);
  const dirs = entries.filter(e => /^\d{4}-\d{2}-\d{2}T/.test(e)).sort();
  if (!dirs.length) throw new Error('No run dirs found in ' + artifactsRoot);
  return path.join(artifactsRoot, dirs[dirs.length - 1]);
}

const runDir = process.env.RUN_DIR || process.argv[2] || await latestRunDir();

const compliance = JSON.parse(await fs.readFile(path.join(runDir, 'design-compliance.json'), 'utf8'));
const summary    = JSON.parse(await fs.readFile(path.join(runDir, 'summary.json'), 'utf8'));
const collected  = JSON.parse(await fs.readFile(path.join(runDir, 'computed-styles.json'), 'utf8'));

const violations  = compliance.elementIssues ?? [];
const page        = summary.page ?? {};
const allElements = collected.elements ?? [];
const docW        = page.document?.width  ?? 1440;
const docH        = page.document?.height ?? 1000;

// ── 骨架元素：过滤出有意义的结构块（跳过极大/极小/svg内部元素）──────────────
const SKIP_TAGS = new Set(['path','svg','defs','use','g','circle','rect','line',
  'polyline','polygon','mask','clippath','lineargradient','stop','symbol',
  'title','script','style','head','html','body','img','br','hr','input','textarea',
  'select','option','button','a','span','i','em','strong','b','label','code','pre']);

const skeletonEls = allElements.filter(el => {
  const { width: w, height: h } = el.bbox;
  if (SKIP_TAGS.has(el.tagName)) return false;
  // 跳过全页大容器（超过 90% 页宽/页高）
  if (w > docW * 0.9 && h > docH * 0.6) return false;
  // 保留宽 40-1100px、高 16-400px 的块
  return w >= 40 && w <= 1100 && h >= 16 && h <= 400;
});

// ── 违规框 ────────────────────────────────────────────────────────────────────
const TYPE_META = {
  color:        { label: '色值', border: '#F54242', fill: 'rgba(245,66,66,0.18)'   },
  borderRadius: { label: '圆角', border: '#19B2FF', fill: 'rgba(25,178,255,0.18)'  },
  spacing:      { label: '间距', border: '#00BA73', fill: 'rgba(0,186,115,0.18)'   },
  fontSize:     { label: '字号', border: '#FAAD14', fill: 'rgba(250,173,20,0.18)'  },
  fontWeight:   { label: '字重', border: '#8B5CF6', fill: 'rgba(139,92,246,0.18)'  },
};

const countByType = {};
for (const el of violations) {
  for (const issue of el.issues) {
    countByType[issue.type] = (countByType[issue.type] || 0) + 1;
  }
}

const allBoxes = violations.flatMap(el =>
  el.issues.map(issue => ({
    type: issue.type,
    x: el.bbox.x, y: el.bbox.y,
    w: el.bbox.width, h: el.bbox.height,
    msg: issue.message,
    text: (el.text || '').slice(0, 60),
  }))
);

// ── HTML 生成 ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const activeTypes = Object.keys(TYPE_META).filter(t => countByType[t]);
const score       = compliance.summary?.complianceScore ?? '—';
const capturedAt  = page.capturedAt ? new Date(page.capturedAt).toLocaleString('zh-CN') : '';
const runId       = path.basename(runDir);

const tabsHtml = [
  `<button class="tab active" data-type="all">全部 <span class="cnt">${violations.length}</span></button>`,
  ...activeTypes.map(t => {
    const m = TYPE_META[t];
    return `<button class="tab" data-type="${t}" data-color="${m.border}">${m.label} <span class="cnt">${countByType[t]}</span></button>`;
  }),
].join('\n  ');

const legendHtml = activeTypes.map(t => {
  const m = TYPE_META[t];
  return `<span class="leg"><span class="leg-dot" style="background:${m.border}"></span>${m.label}</span>`;
}).join('');

// 骨架数据只传 bbox + tagName（text 太重）
const skeletonData = skeletonEls.map(el => ({
  x: el.bbox.x, y: el.bbox.y,
  w: el.bbox.width, h: el.bbox.height,
  tag: el.tagName,
}));

const htmlContent = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<title>可视化标注 — ${esc(page.title || '页面')}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'PingFang SC',system-ui,sans-serif;font-size:14px;
  color:#242529;background:#EAECF3}

.hero{background:#3855D5;color:#fff;padding:14px 28px}
.hero h1{font-size:17px;font-weight:500;margin-bottom:2px}
.hero p{font-size:12px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.toolbar{position:sticky;top:0;z-index:100;background:#fff;
  border-bottom:1px solid #EAECF3;padding:10px 28px;
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  box-shadow:0 2px 8px rgba(0,0,0,.08)}
.tab{background:#F6F8F9;border:1.5px solid #EAECF3;border-radius:20px;
  padding:5px 14px;cursor:pointer;font-size:13px;color:#5A5C66;
  display:inline-flex;align-items:center;gap:5px;
  transition:border-color .15s,color .15s,background .15s;white-space:nowrap}
.tab:hover{border-color:#3855D5;color:#3855D5}
.tab.active{background:var(--ac,#3855D5);color:#fff;border-color:var(--ac,#3855D5)}
.cnt{background:rgba(0,0,0,.12);border-radius:1000px;padding:0 6px;font-size:11px}
.tab.active .cnt{background:rgba(255,255,255,.25)}
.legend{margin-left:auto;display:flex;gap:12px;align-items:center;flex-shrink:0}
.leg{display:flex;align-items:center;gap:4px;font-size:12px;color:#5A5C66;white-space:nowrap}
.leg-dot{width:9px;height:9px;border-radius:2px;flex-shrink:0}

.meta{display:flex;gap:10px;padding:10px 28px;flex-wrap:wrap;align-items:center}
.chip{background:#fff;border:1px solid #EAECF3;border-radius:8px;
  padding:5px 12px;font-size:12px;color:#5A5C66;white-space:nowrap}
.chip strong{color:#242529;font-weight:500}
.chip a{color:#3855D5;text-decoration:none}
.chip a:hover{text-decoration:underline}

.wrap{padding:0 28px 40px}
.scale-note{font-size:12px;color:#9296A6;margin-bottom:8px}

/* 外框：控制可见高度，内容可滚动 */
.outer{border-radius:10px;border:1px solid #D5D6D9;overflow:hidden;
  box-shadow:0 4px 16px rgba(0,0,0,.12);position:relative}

/* 画布本身：不缩放，让 outer 负责 transform */
#stage{position:relative;transform-origin:top left}

/* 骨架底图 */
.sk{position:absolute;border:1px solid rgba(0,0,0,.08);
  background:rgba(255,255,255,0.55);pointer-events:none}

/* 违规框：pointer-events:none，由 stage mousemove 统一命中检测 */
.vb{position:absolute;border-width:2px;border-style:solid;
  pointer-events:none;transition:opacity .12s}
.vb.dim{opacity:.15}
.vb.hit{opacity:1;z-index:9999}

/* 浮动 tooltip */
#tooltip{position:fixed;display:none;
  background:rgba(15,15,15,.92);color:#fff;font-size:11px;line-height:1.7;
  padding:7px 11px;border-radius:7px;max-width:360px;word-break:break-all;
  z-index:99999;pointer-events:none;box-shadow:0 3px 12px rgba(0,0,0,.45);
  white-space:pre-wrap}
</style>
</head>
<body>

<div class="hero">
  <h1>可视化标注报告</h1>
  <p>${esc(page.url || '')}${capturedAt ? ' · ' + esc(capturedAt) : ''}</p>
</div>

<div class="toolbar">
  ${tabsHtml}
  <div class="legend">${legendHtml}</div>
</div>

<div class="meta">
  <div class="chip">页面 <strong>${docW} × ${docH} px</strong></div>
  <div class="chip">违规框 <strong>${allBoxes.length}</strong> 个</div>
  <div class="chip">合规率 <strong>${esc(score)}</strong></div>
  <div class="chip"><a href="/reports/${esc(runId)}">← 代码报告</a></div>
</div>

<div id="tooltip"></div>
<div class="wrap">
  <p class="scale-note" id="snote"></p>
  <div class="outer" id="outer">
    <div id="stage"></div>
  </div>
</div>

<script>
const BOXES    = ${JSON.stringify(allBoxes)};
const SKELETON = ${JSON.stringify(skeletonData)};
const TYPE_META = ${JSON.stringify(TYPE_META)};
const DOC_W    = ${docW};
const DOC_H    = ${docH};

let curType = 'all';
let skeletonRendered = false;

function getScale() {
  return Math.min(1, (window.innerWidth - 58) / DOC_W);
}

// 骨架只需渲染一次
function renderSkeleton(stage) {
  if (skeletonRendered) return;
  skeletonRendered = true;
  const frag = document.createDocumentFragment();
  SKELETON.forEach(el => {
    if (el.w < 2 || el.h < 2) return;
    const div = document.createElement('div');
    div.className = 'sk';
    div.style.cssText =
      'left:' + el.x + 'px;top:' + el.y + 'px;' +
      'width:' + el.w + 'px;height:' + el.h + 'px;';
    frag.appendChild(div);
  });
  stage.appendChild(frag);
}

// 每个 box 对应的 DOM 元素，用于命中高亮
let vbElements = [];

function renderViolations(stage) {
  stage.querySelectorAll('.vb').forEach(el => el.remove());
  vbElements = [];
  const frag = document.createDocumentFragment();
  BOXES.forEach(b => {
    if (curType !== 'all' && b.type !== curType) return;
    if (b.w < 2 || b.h < 2) return;
    const m   = TYPE_META[b.type] || TYPE_META.color;
    const div = document.createElement('div');
    div.className = 'vb';
    div.style.cssText =
      'left:' + b.x + 'px;top:' + b.y + 'px;' +
      'width:' + b.w + 'px;height:' + b.h + 'px;' +
      'border-color:' + m.border + ';background:' + m.fill + ';';
    frag.appendChild(div);
    vbElements.push({ b, el: div });
  });
  stage.appendChild(frag);
}

// ── 坐标命中检测 ──────────────────────────────────────────────────────────────
const tooltip = document.getElementById('tooltip');

document.getElementById('outer').addEventListener('mousemove', e => {
  const stage = document.getElementById('stage');
  const rect  = stage.getBoundingClientRect();
  const s     = getScale();
  const mx    = (e.clientX - rect.left) / s;
  const my    = (e.clientY - rect.top)  / s;

  const lines = [];
  let hasHit  = false;

  vbElements.forEach(({ b, el }) => {
    const hit = mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h;
    if (hit) {
      el.classList.add('hit');
      el.classList.remove('dim');
      lines.push((TYPE_META[b.type]?.label || b.type) + '  ' + b.msg
        + (b.text ? '\\n  ' + b.text : ''));
      hasHit = true;
    } else {
      el.classList.remove('hit');
      el.classList.add('dim');
    }
  });

  if (hasHit) {
    tooltip.textContent = lines.join('\\n─────────────────\\n');
    tooltip.style.display = 'block';
    // tooltip 跟着鼠标，避免超出右/下边界
    const tw = 370, th = 160;
    const tx = e.clientX + 14 + tw > window.innerWidth  ? e.clientX - tw - 6 : e.clientX + 14;
    const ty = e.clientY + 14 + th > window.innerHeight ? e.clientY - th - 6 : e.clientY + 14;
    tooltip.style.left = tx + 'px';
    tooltip.style.top  = ty + 'px';
  } else {
    tooltip.style.display = 'none';
    vbElements.forEach(({ el }) => { el.classList.remove('dim', 'hit'); });
  }
});

document.getElementById('outer').addEventListener('mouseleave', () => {
  tooltip.style.display = 'none';
  vbElements.forEach(({ el }) => { el.classList.remove('dim', 'hit'); });
});

function applyScale() {
  const s     = getScale();
  const stage = document.getElementById('stage');
  const outer = document.getElementById('outer');

  stage.style.width     = DOC_W + 'px';
  stage.style.height    = DOC_H + 'px';
  stage.style.transform = 'scale(' + s + ')';
  // outer 高度 = 缩放后实际占用高度，撑开容器
  outer.style.height    = Math.ceil(DOC_H * s) + 'px';

  document.getElementById('snote').textContent =
    '页面骨架 + 违规框（缩放 ' + Math.round(s * 100) +
    '% · 原始 ' + DOC_W + ' × ' + DOC_H + ' px）' +
    '  · 鼠标悬停查看详情';
}

function render() {
  const stage = document.getElementById('stage');
  renderSkeleton(stage);
  renderViolations(stage);
  applyScale();
}

// Tab 切换
const TAB_COLORS = { all: '#3855D5' };
${activeTypes.map(t => `TAB_COLORS['${t}'] = '${TYPE_META[t].border}';`).join('\n')}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('active');
      t.style.removeProperty('--ac');
    });
    const c = TAB_COLORS[btn.dataset.type] || '#3855D5';
    btn.style.setProperty('--ac', c);
    btn.classList.add('active');
    curType = btn.dataset.type;
    renderViolations(document.getElementById('stage'));
  });
});

document.querySelector('.tab.active').style.setProperty('--ac', '#3855D5');

render();
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(applyScale, 120);
});
</script>
</body>
</html>`;

await fs.writeFile(path.join(runDir, 'visual-report.html'), htmlContent, 'utf8');
console.log(JSON.stringify({ ok: true, runDir, skeletonElements: skeletonEls.length, violationBoxes: allBoxes.length }));
