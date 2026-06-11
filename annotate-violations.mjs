/**
 * 用 Playwright 对目标页面截图并在图上叠加违规元素红框。
 * 每种违规类型生成一张标注图，另有一张"全部"总览图。
 *
 * 用法：
 *   node annotate-violations.mjs <runDir> [localUrl]
 *   RUN_DIR=... [LOCAL_URL=...] node annotate-violations.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const runDir = process.env.RUN_DIR || process.argv[2];
if (!runDir) { console.error('需要传入 runDir'); process.exit(1); }

// 把线上 URL 映射到本地 dev server（同源页面）
function toLocalUrl(url) {
  if (!url) return 'http://localhost:5173/';
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return url;
    // 百家号线上页映射到本地 dev server
    return 'http://localhost:5173' + (u.pathname || '/');
  } catch { return 'http://localhost:5173/'; }
}

const TYPE_META = {
  color:        { label: '色值违规',  border: '#F54242', fill: 'rgba(245,66,66,0.15)' },
  fontSize:     { label: '字号违规',  border: '#FAAD14', fill: 'rgba(250,173,20,0.15)' },
  fontWeight:   { label: '字重违规',  border: '#8B5CF6', fill: 'rgba(139,92,246,0.15)' },
  borderRadius: { label: '圆角违规',  border: '#19B2FF', fill: 'rgba(25,178,255,0.15)' },
  spacing:      { label: '间距违规',  border: '#00BA73', fill: 'rgba(0,186,115,0.15)' },
};

async function run() {
  // 读取合规分析结果
  const compliancePath = path.join(runDir, 'design-compliance.json');
  const summaryPath = path.join(runDir, 'summary.json');

  const compliance = JSON.parse(await fs.readFile(compliancePath, 'utf8'));
  const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));

  const violations = compliance.elementIssues ?? [];
  if (!violations.length) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no violations' }));
    return;
  }

  const rawUrl = process.env.LOCAL_URL || summary.page?.url || '';
  const localUrl = toLocalUrl(rawUrl);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  try {
    await page.goto(localUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.evaluate(async () => { if (document.fonts?.ready) await document.fonts.ready; });
  } catch (e) {
    console.error('页面加载失败:', e.message);
    await browser.close();
    process.exit(1);
  }

  // 注入工具函数：根据 bbox 数组在页面上绘制彩色框
  async function injectBoxes(boxes) {
    // 清除上次的框
    await page.evaluate(() => {
      document.querySelectorAll('[data-bjh-vio]').forEach(el => el.remove());
    });

    if (!boxes.length) return;

    await page.evaluate((boxes) => {
      const frag = document.createDocumentFragment();
      boxes.forEach(({ x, y, width, height, border, fill, title }) => {
        if (width < 2 || height < 2) return;
        const div = document.createElement('div');
        div.setAttribute('data-bjh-vio', '');
        div.title = title || '';
        div.style.cssText = [
          'position:absolute',
          `left:${x}px`,
          `top:${y}px`,
          `width:${width}px`,
          `height:${height}px`,
          `border:2px solid ${border}`,
          `background:${fill}`,
          'z-index:2147483646',
          'pointer-events:none',
          'box-sizing:border-box',
        ].join(';');
        frag.appendChild(div);
      });
      document.body.style.position = 'relative';
      document.body.appendChild(frag);
    }, boxes);
  }

  const screenshots = {};

  // ── 1. 每种类型单独一张图 ────────────────────────────────────────────────────
  for (const [type, meta] of Object.entries(TYPE_META)) {
    const typeViolations = violations.filter(el => el.issues.some(i => i.type === type));
    if (!typeViolations.length) continue;

    const boxes = typeViolations.map(el => ({
      x: el.bbox.x,
      y: el.bbox.y,
      width: el.bbox.width,
      height: el.bbox.height,
      border: meta.border,
      fill: meta.fill,
      title: el.issues.filter(i => i.type === type).map(i => i.message).join('\n'),
    }));

    await injectBoxes(boxes);

    const file = `violations-${type}.png`;
    await page.screenshot({ path: path.join(runDir, file), fullPage: true, timeout: 20000 });
    screenshots[type] = { file, label: meta.label, count: typeViolations.length };
  }

  // ── 2. 全部问题一张总览图（不同类型不同颜色）────────────────────────────────
  const allBoxes = violations.flatMap(el =>
    el.issues.map(issue => ({
      x: el.bbox.x,
      y: el.bbox.y,
      width: el.bbox.width,
      height: el.bbox.height,
      border: (TYPE_META[issue.type] || TYPE_META.color).border,
      fill: (TYPE_META[issue.type] || TYPE_META.color).fill,
      title: issue.message,
    }))
  );

  await injectBoxes(allBoxes);
  await page.screenshot({ path: path.join(runDir, 'violations-all.png'), fullPage: true, timeout: 20000 });
  screenshots.all = { file: 'violations-all.png', label: '全部违规总览', count: violations.length };

  await browser.close();

  // 把截图元数据写入 compliance json
  compliance.screenshots = screenshots;
  await fs.writeFile(compliancePath, JSON.stringify(compliance, null, 2));

  console.log(JSON.stringify({ ok: true, runDir, screenshots }));
}

run().catch(e => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
