import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const targetUrl = process.env.TARGET_URL || process.argv[2] || 'https://baijiahao.baidu.com/builder/rc/home';
const outputRoot = process.env.OUTPUT_DIR || path.join(__dirname, 'artifacts', 'stage-b-current-state');
const viewportWidth = Number(process.env.VIEWPORT_WIDTH || 1440);
const viewportHeight = Number(process.env.VIEWPORT_HEIGHT || 1000);
const maxElements = Number(process.env.MAX_ELEMENTS || 2000);
const maxElementScreenshots = Number(process.env.MAX_ELEMENT_SCREENSHOTS || 300);
const timeoutMs = Number(process.env.TIMEOUT_MS || 60000);
const routeViaNodeFetch = process.env.ROUTE_VIA_NODE_FETCH !== '0';
const cdpEndpoint = process.env.CDP_ENDPOINT || '';
const cdpMatch = process.env.CDP_MATCH || '';
const captureCurrentTab = process.env.CAPTURE_CURRENT_TAB === '1' || targetUrl === 'current';

// Cookie injection: INJECT_COOKIES env var, semicolon-separated "name=value" pairs
// e.g. INJECT_COOKIES="BDUSS=xxx;BAIDUID=yyy"
const injectCookiesRaw = process.env.INJECT_COOKIES || '';
const injectCookies = injectCookiesRaw
  ? injectCookiesRaw.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
      const eqIdx = pair.indexOf('=');
      return { name: pair.slice(0, eqIdx).trim(), value: pair.slice(eqIdx + 1).trim() };
    })
  : [];

const styleProperties = [
  'display', 'visibility', 'opacity', 'position', 'z-index',
  'box-sizing', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'overflow', 'overflow-x', 'overflow-y',
  'color', 'background-color', 'background-image', 'background-size', 'background-position',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration-line',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'gap', 'row-gap', 'column-gap',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'box-shadow', 'filter', 'transform',
  'flex-direction', 'justify-content', 'align-items', 'align-content', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'grid-template-columns', 'grid-template-rows', 'grid-auto-flow',
];

function timestampName(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true });
}

const runDir = path.join(outputRoot, timestampName());
const screenshotDir = path.join(runDir, 'elements');
await ensureDir(screenshotDir);

const browser = cdpEndpoint
  ? await chromium.connectOverCDP(cdpEndpoint)
  : await chromium.launch({ headless: true });
const context = cdpEndpoint
  ? browser.contexts()[0]
  : await browser.newContext({
    viewport: { width: viewportWidth, height: viewportHeight },
    deviceScaleFactor: 1,
  });

// Inject cookies if provided
if (injectCookies.length && !cdpEndpoint) {
  const cookieDomain = (() => {
    try { return new URL(targetUrl).hostname; } catch { return 'baijiahao.baidu.com'; }
  })();
  await context.addCookies(injectCookies.map(({ name, value }) => ({
    name,
    value,
    domain: cookieDomain.startsWith('.') ? cookieDomain : `.${cookieDomain}`,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  })));
}

if (routeViaNodeFetch && !cdpEndpoint) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (!['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'fetch'].includes(request.resourceType())) {
      await route.continue();
      return;
    }

    try {
      const response = await fetch(request.url(), {
        method: request.method(),
        headers: request.headers(),
        body: request.method() === 'GET' || request.method() === 'HEAD' ? undefined : request.postDataBuffer(),
        redirect: 'manual',
      });
      const headers = Object.fromEntries(response.headers.entries());
      delete headers['content-encoding'];
      await route.fulfill({
        status: response.status,
        headers,
        body: Buffer.from(await response.arrayBuffer()),
      });
    } catch {
      await route.continue();
    }
  });
}

try {
  const existingPages = context.pages();
  const matchedPage = cdpMatch
    ? existingPages.find((existingPage) => existingPage.url().includes(cdpMatch))
    : existingPages.find((existingPage) => existingPage.url() !== 'about:blank') || existingPages[0];
  const page = captureCurrentTab && matchedPage
    ? matchedPage
    : await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  if (!captureCurrentTab) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }

  await captureArtifacts(page);
} catch (error) {
  const errorReport = { ok: false, targetUrl, message: error.message, stack: error.stack };
  await fs.writeFile(path.join(runDir, 'error.json'), JSON.stringify(errorReport, null, 2));
  console.error(JSON.stringify({ ...errorReport, runDir }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}

async function captureArtifacts(page) {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });

  const fullPageScreenshot = path.join(runDir, 'full-page.png');
  await page.screenshot({ path: fullPageScreenshot, fullPage: true, timeout: Math.min(timeoutMs, 15000) });

  const pageInfo = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    capturedAt: new Date().toISOString(),
  }));

  const elements = await page.evaluate(({ styleProperties, maxElements }) => {
    const selectorSegment = (element) => {
      const tag = element.tagName.toLowerCase();
      if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) return `${tag}#${element.id}`;

      const attrSelector = ['data-testid', 'data-test-id', 'data-cy', 'data-id', 'aria-label', 'name', 'role']
        .map((name) => element.getAttribute(name) ? `${tag}[${name}="${CSS.escape(element.getAttribute(name))}"]` : null)
        .find(Boolean);
      if (attrSelector) return attrSelector;

      const classNames = [...element.classList]
        .filter((className) => className && !/^css-[a-z0-9]+$/i.test(className))
        .slice(0, 3)
        .map((className) => `.${CSS.escape(className)}`)
        .join('');
      const base = `${tag}${classNames}`;
      const parent = element.parentElement;
      if (!parent) return base;
      const sameTagSiblings = [...parent.children].filter((child) => child.tagName === element.tagName);
      return sameTagSiblings.length > 1 ? `${base}:nth-of-type(${sameTagSiblings.indexOf(element) + 1})` : base;
    };

    const cssPath = (element) => {
      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
        parts.unshift(selectorSegment(current));
        if (current.id && /^[A-Za-z][\w-]*$/.test(current.id)) break;
        current = current.parentElement;
      }
      return parts.join(' > ');
    };

    const textOf = (element) => (element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);

    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) > 0
        && rect.width > 0
        && rect.height > 0;
    };

    return [...document.querySelectorAll('body *')]
      .filter(isVisible)
      .slice(0, maxElements)
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const computedStyle = getComputedStyle(element);
        const styles = Object.fromEntries(styleProperties.map((property) => [property, computedStyle.getPropertyValue(property)]));
        return {
          index,
          tagName: element.tagName.toLowerCase(),
          selector: cssPath(element),
          text: textOf(element),
          attributes: {
            id: element.id || null,
            class: element.getAttribute('class'),
            role: element.getAttribute('role'),
            ariaLabel: element.getAttribute('aria-label'),
          },
          bbox: {
            x: Math.round(rect.x * 100) / 100,
            y: Math.round(rect.y * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
          },
          styles,
          screenshot: null,
        };
      });
  }, { styleProperties, maxElements });

  let screenshotCount = 0;
  for (const element of elements) {
    if (screenshotCount >= maxElementScreenshots) break;
    if (element.bbox.width < 2 || element.bbox.height < 2) continue;

    const screenshotFile = `element-${String(element.index).padStart(4, '0')}.png`;
    try {
      await page.locator(element.selector).first().screenshot({
        path: path.join(screenshotDir, screenshotFile),
        timeout: 5000,
      });
      element.screenshot = `elements/${screenshotFile}`;
      screenshotCount += 1;
    } catch {
      element.screenshot = null;
    }
  }

  const report = {
    page: pageInfo,
    input: {
      targetUrl,
      designSpec: path.join(__dirname, 'DESIGN2-0.md'),
      viewport: { width: viewportWidth, height: viewportHeight },
      maxElements,
      maxElementScreenshots,
      waitPolicy: ['domcontentloaded', 'networkidle best-effort', 'document.fonts.ready'],
    },
    artifacts: {
      fullPageScreenshot: 'full-page.png',
      elementScreenshotDirectory: 'elements/',
    },
    summary: {
      visibleElementCount: elements.length,
      elementScreenshotCount: screenshotCount,
    },
    elements,
  };

  await fs.writeFile(path.join(runDir, 'computed-styles.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify({ page: pageInfo, input: report.input, artifacts: report.artifacts, summary: report.summary }, null, 2));

  console.log(JSON.stringify({ ok: true, runDir, ...report.summary, finalUrl: pageInfo.url, title: pageInfo.title }, null, 2));
}
