/**
 * 设计合规分析服务器
 * 接收来自 Bookmarklet 的页面采集数据，运行合规分析，提供报告查阅。
 *
 * 启动: npm run server
 * 默认端口: 8899  (PORT 环境变量可覆盖)
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// 异步串行执行子进程，不阻塞事件循环
function runScript(scriptPath, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      cwd: __dirname,
    });
    let out = '';
    child.stdout?.on('data', d => out += d);
    child.stderr?.on('data', d => out += d);
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(''));
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8899);
const HOST = process.env.HOST || '0.0.0.0';
const artifactsRoot = path.join(__dirname, 'artifacts', 'stage-b-current-state');
const DESIGN_SPEC = path.join(__dirname, 'DESIGN2-0.md');

function timestamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

function html(res, body, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

// ─── 收到 bookmarklet 推送的采集数据 ─────────────────────────────────────────

async function handleCollect(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, { ok: false, error: 'invalid JSON' }, 400);
  }

  const runId = timestamp();
  const runDir = path.join(artifactsRoot, runId);
  const elementsDir = path.join(runDir, 'elements');
  await fs.mkdir(elementsDir, { recursive: true });

  // 把 bookmarklet 发来的数据补齐成 collect-current-state 产出的格式
  const report = {
    page: body.page,
    input: {
      targetUrl: body.page?.url,
      designSpec: DESIGN_SPEC,
      viewport: body.page?.viewport,
      maxElements: body.elements?.length,
      maxElementScreenshots: 0,
      waitPolicy: ['bookmarklet'],
    },
    artifacts: {
      fullPageScreenshot: null,
      elementScreenshotDirectory: 'elements/',
    },
    summary: {
      visibleElementCount: body.elements?.length ?? 0,
      elementScreenshotCount: 0,
    },
    elements: body.elements ?? [],
  };

  await fs.writeFile(path.join(runDir, 'computed-styles.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify({
    page: report.page, input: report.input, artifacts: report.artifacts, summary: report.summary,
  }, null, 2));

  // 先回复浏览器（采集已收到），后台异步跑 compare + 标注截图
  cors(res);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

  // 后台流水线：异步执行，不阻塞事件循环
  setImmediate(async () => {
    const errorFile = path.join(runDir, 'error.json');
    try {
      const env = { RUN_DIR: runDir };
      const out1 = await runScript(path.join(__dirname, 'compare-design-spec.mjs'), env);
      if (!existsSync(path.join(runDir, 'design-compliance.html'))) {
        throw new Error('报告文件未生成\n' + out1);
      }
    } catch (e) {
      console.error('后台处理失败:', e.message);
      await fs.writeFile(errorFile, JSON.stringify({ error: e.message, at: new Date().toISOString() }, null, 2));
    }
  });

  res.end(JSON.stringify({
    ok: true,
    runId,
    reportUrl: `/reports/${runId}`,
    message: '采集成功，分析中（约10-20秒后报告可查）',
  }));
}

// ─── 列出所有报告 ─────────────────────────────────────────────────────────────

async function handleReportList(res) {
  const entries = await fs.readdir(artifactsRoot).catch(() => []);
  const runs = [];
  for (const dir of entries.filter(e => /^\d{4}-\d{2}-\d{2}T/.test(e)).sort().reverse()) {
    const summaryFile = path.join(artifactsRoot, dir, 'summary.json');
    const complianceFile = path.join(artifactsRoot, dir, 'design-compliance.json');
    let summary = {};
    let compliance = {};
    try { summary = JSON.parse(await fs.readFile(summaryFile, 'utf8')); } catch { /* ok */ }
    try { compliance = JSON.parse(await fs.readFile(complianceFile, 'utf8')); } catch { /* ok */ }
    const hasReport = existsSync(path.join(artifactsRoot, dir, 'design-compliance.html'));
    runs.push({
      id: dir,
      url: summary.page?.url ?? '—',
      title: summary.page?.title ?? '—',
      capturedAt: summary.page?.capturedAt ?? dir,
      visibleElementCount: summary.summary?.visibleElementCount ?? 0,
      complianceScore: compliance.summary?.complianceScore ?? '—',
      violations: compliance.summary?.violations ?? {},
      hasReport,
    });
  }

  html(res, dashboardHtml(runs));
}

// ─── 等待/错误中间页（自动轮询）─────────────────────────────────────────────────

function pendingHtml(runId, target) {
  const redirectUrl = target === 'visual' ? `/reports/${runId}/visual` : `/reports/${runId}`;
  const statusUrl   = target === 'visual' ? `/reports/${runId}/visual/status` : `/reports/${runId}/status`;
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<title>报告生成中…</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'PingFang SC',system-ui,sans-serif;background:#F7F8F9;
    display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border-radius:16px;padding:48px 56px;text-align:center;
    box-shadow:0 4px 24px rgba(191,196,217,.3);max-width:420px;width:90%}
  .spinner{width:48px;height:48px;border:4px solid #EAECF3;border-top-color:#3855D5;
    border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 24px}
  @keyframes spin{to{transform:rotate(360deg)}}
  h2{font-size:18px;font-weight:500;color:#242529;margin-bottom:8px}
  p{font-size:14px;color:#9296A6;line-height:1.6}
  .error-icon{font-size:48px;margin-bottom:16px}
  .err-msg{background:#FFF2F0;border:1px solid #FFC6BF;border-radius:8px;
    padding:12px 16px;font-size:12px;color:#CF2D33;text-align:left;
    margin-top:16px;word-break:break-all;line-height:1.6;display:none}
  .retry-btn{display:none;margin-top:20px;background:#3855D5;color:#fff;
    border:none;border-radius:8px;padding:10px 24px;font-size:14px;
    cursor:pointer;font-family:inherit}
  .retry-btn:hover{background:#253AB0}
</style>
</head>
<body>
<div class="card" id="card">
  <div class="spinner" id="spinner"></div>
  <h2 id="title">报告生成中…</h2>
  <p id="desc">通常需要 5–10 秒，请稍候</p>
  <div class="err-msg" id="errmsg"></div>
  <button class="retry-btn" id="retrybtn" onclick="location.reload()">重新加载</button>
</div>
<script>
const STATUS_URL = '${statusUrl}';
const REDIRECT   = '${redirectUrl}';
let tries = 0;
const MAX = 30; // 最多轮询 30 次（约 60s）

function poll() {
  fetch(STATUS_URL)
    .then(r => r.json())
    .then(d => {
      if (d.status === 'ready') {
        document.getElementById('title').textContent = '生成完成，跳转中…';
        location.replace(REDIRECT);
      } else if (d.status === 'error') {
        showError(d.message || '未知错误');
      } else {
        tries++;
        if (tries >= MAX) {
          showError('生成超时，请检查服务器日志');
        } else {
          setTimeout(poll, 2000);
        }
      }
    })
    .catch(() => {
      tries++;
      if (tries >= MAX) showError('无法连接到服务器');
      else setTimeout(poll, 3000);
    });
}

function showError(msg) {
  document.getElementById('spinner').style.display = 'none';
  document.getElementById('title').textContent = '生成失败';
  document.getElementById('desc').textContent = '请查看服务器日志了解详情';
  const em = document.getElementById('errmsg');
  em.textContent = msg;
  em.style.display = 'block';
  document.getElementById('retrybtn').style.display = 'inline-block';
}

poll();
</script>
</body>
</html>`;
}

// ─── 仪表盘 HTML ──────────────────────────────────────────────────────────────

function dashboardHtml(runs) {
  const rows = runs.map(r => `
    <tr>
      <td><a href="/reports/${r.id}" target="_blank">${escHtml(r.title)}</a>&nbsp;<a href="/reports/${r.id}/visual" target="_blank" style="color:#9296A6;font-size:12px">📊</a></td>
      <td class="url">${escHtml(r.url)}</td>
      <td>${escHtml(new Date(r.capturedAt).toLocaleString('zh-CN'))}</td>
      <td class="num">${r.visibleElementCount}</td>
      <td class="score ${scoreClass(r.complianceScore)}">${escHtml(r.complianceScore)}</td>
      <td class="num err">${r.violations.color ?? '—'}</td>
      <td class="num err">${r.violations.fontSize ?? '—'}</td>
      <td class="num err">${r.violations.borderRadius ?? '—'}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<title>设计合规报告中心</title>
<style>
  body { margin:0; font-family:'PingFang SC',system-ui,sans-serif; font-size:14px;
    background:#F7F8F9; color:#242529; }
  .hero { background:#3855D5; color:#fff; padding:28px 40px; }
  .hero h1 { margin:0 0 4px; font-size:20px; font-weight:500; }
  .hero p { margin:0; opacity:.75; font-size:13px; }
  .container { max-width:1200px; margin:0 auto; padding:24px 40px 60px; }
  table { width:100%; border-collapse:collapse; background:#fff;
    border-radius:12px; overflow:hidden;
    box-shadow:0 4px 10px rgba(191,196,217,.22); }
  th { text-align:left; padding:12px 16px; background:#F6F8F9;
    color:#9296A6; font-weight:400; font-size:12px; border-bottom:1px solid #EAECF3; }
  td { padding:12px 16px; border-bottom:1px solid #EAECF3; vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  a { color:#3855D5; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .url { color:#9296A6; font-size:12px; max-width:240px; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; }
  .num { text-align:right; font-weight:500; }
  .err { color:#F54242; }
  .score { font-weight:700; text-align:right; }
  .ok { color:#00BA73; }
  .warn { color:#FAAD14; }
  .bad { color:#F54242; }
  .hint { color:#9296A6; margin-bottom:16px; font-size:13px; }
  .btn { display:inline-block; background:#3855D5; color:#fff;
    border-radius:8px; padding:8px 18px; font-size:14px;
    text-decoration:none; margin-bottom:20px; }
</style>
</head>
<body>
<div class="hero">
  <h1>设计合规报告中心</h1>
  <p>每次通过书签脚本采集的页面都会出现在这里</p>
</div>
<div class="container">
  <a class="btn" href="/setup">安装书签脚本</a>
  <p class="hint">共 ${runs.length} 次采集记录，点击标题查看详细报告</p>
  <table>
    <thead>
      <tr>
        <th>页面标题</th><th>URL</th><th>采集时间</th>
        <th style="text-align:right">元素数</th>
        <th style="text-align:right">合规率</th>
        <th style="text-align:right">色值违规</th>
        <th style="text-align:right">字号违规</th>
        <th style="text-align:right">圆角违规</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="8" style="text-align:center;color:#9296A6;padding:40px">暂无采集记录，请先安装并使用书签脚本</td></tr>'}</tbody>
  </table>
</div>
</body>
</html>`;
}

function scoreClass(s) {
  if (!s || s === '—') return '';
  const n = parseInt(s);
  if (n >= 90) return 'ok';
  if (n >= 70) return 'warn';
  return 'bad';
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── 安装页 ───────────────────────────────────────────────────────────────────

function setupHtml() {
  // 书签始终 POST 到 localhost（用户通过 SSH 隧道访问）
  const localUrl = `http://localhost:${PORT}`;
  const bookmarkletCode = buildBookmarklet(localUrl);
  const bookmarkletHref = `javascript:${encodeURIComponent(bookmarkletCode)}`;
  const sshHost = 'wuyingrong.bcc-szzj.baidu.com';

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<title>设计合规检查 — 安装指南</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:'PingFang SC',system-ui,sans-serif;font-size:14px;
    background:#F7F8F9;color:#242529;line-height:1.7}
  .hero{background:#3855D5;color:#fff;padding:28px 40px}
  .hero h1{margin:0 0 4px;font-size:20px;font-weight:500}
  .hero p{margin:0;opacity:.75;font-size:13px}
  .container{max-width:780px;margin:0 auto;padding:28px 40px 80px}
  .card{background:#fff;border-radius:12px;padding:24px 28px;
    box-shadow:0 4px 10px rgba(191,196,217,.22);margin-bottom:16px}
  h2{font-size:15px;font-weight:500;margin:0 0 14px}
  .step{display:flex;gap:14px;margin-bottom:14px;align-items:flex-start}
  .num{flex:0 0 26px;height:26px;background:#3855D5;color:#fff;
    border-radius:50%;display:flex;align-items:center;justify-content:center;
    font-size:12px;font-weight:600;margin-top:2px}
  pre{background:#F6F8F9;border:1px solid #EAECF3;border-radius:8px;
    padding:12px 16px;margin:8px 0;font-size:12px;overflow-x:auto;white-space:pre}
  code{background:#F6F8F9;border-radius:4px;padding:1px 6px;font-size:12px;font-family:monospace}
  .bm-btn{display:inline-block;background:#3855D5;color:#fff!important;
    border-radius:8px;padding:10px 22px;font-size:14px;font-weight:500;
    text-decoration:none;cursor:grab;border:2px dashed rgba(255,255,255,.4)}
  .note{color:#9296A6;font-size:12px;margin:6px 0 0}
  .tag{display:inline-block;background:#F0F5FF;color:#3855D5;border-radius:4px;
    padding:1px 8px;font-size:12px;font-weight:500;margin-bottom:10px}
  a.link{color:#3855D5}
</style>
</head>
<body>
<div class="hero">
  <h1>设计合规检查 — 团队安装指南</h1>
  <p>每位团队成员完成一次性配置后，之后只需点一下书签即可检查任意页面</p>
</div>
<div class="container">

  <div class="card">
    <div class="tag">第一步（一次性）</div>
    <h2>配置 SSH 隧道</h2>
    <p>把下面这段追加到你本地的 <code>~/.ssh/config</code>（Windows：<code>C:\\Users\\用户名\\.ssh\\config</code>）：</p>
<pre>Host bjh-design
    HostName ${sshHost}
    User root
    LocalForward 8899 127.0.0.1:8899
    ServerAliveInterval 60</pre>
    <p>以后每次使用前，在终端运行这条命令（保持后台运行）：</p>
<pre>ssh -N bjh-design</pre>
    <p class="note">💡 如果你用 VS Code Remote SSH 连到这台服务器，端口会自动转发，这一步可以跳过。</p>
  </div>

  <div class="card">
    <div class="tag">第二步（一次性）</div>
    <h2>安装书签脚本</h2>
    <div class="step">
      <div class="num">1</div>
      <div class="step-body">打开书签栏（Chrome Mac：<code>⌘+Shift+B</code>，Windows：<code>Ctrl+Shift+B</code>）</div>
    </div>
    <div class="step">
      <div class="num">2</div>
      <div class="step-body">
        把下面的按钮<strong>拖拽</strong>到书签栏：<br/><br/>
        <a class="bm-btn" href="${escHtml(bookmarkletHref)}">📐 设计合规检查</a>
        <p class="note">⚠️ 必须拖拽安装，直接点击无效</p>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="tag">日常使用</div>
    <h2>检查任意页面</h2>
    <div class="step">
      <div class="num">1</div>
      <div class="step-body">确认终端里 <code>ssh -N bjh-design</code> 正在运行</div>
    </div>
    <div class="step">
      <div class="num">2</div>
      <div class="step-body">在浏览器打开要检查的页面（如 <code>baijiahao.baidu.com/builder/rc/home</code>，需已登录）</div>
    </div>
    <div class="step">
      <div class="num">3</div>
      <div class="step-body">点书签栏里的 <code>📐 设计合规检查</code>，右上角出现进度提示，几秒后显示合规率并可跳转报告</div>
    </div>
  </div>

  <div class="card">
    <h2>查看所有报告</h2>
    <p>SSH 隧道建立后，浏览器访问：<a class="link" href="http://localhost:${PORT}/reports">http://localhost:${PORT}/reports</a></p>
    <p class="note">所有人的采集记录集中存档，可按时间查看历史趋势</p>
  </div>

</div>
</body>
</html>`;
}

// ─── 生成 bookmarklet 代码 ────────────────────────────────────────────────────

function buildBookmarklet(serverUrl) {
  // 这段代码会注入到目标页面运行
  return `(function(){
if(window.__bjhCollecting){alert('正在采集中，请稍候…');return;}
window.__bjhCollecting=true;

var SERVER='${serverUrl}';
var MAX_EL=800;
/* 只采集合规检查用到的属性 */
var CP=['color','background-color',
  'border-top-color','border-right-color','border-bottom-color','border-left-color',
  'font-size','font-weight',
  'border-radius','border-top-left-radius','border-top-right-radius',
  'border-bottom-right-radius','border-bottom-left-radius',
  'padding-top','padding-right','padding-bottom','padding-left'];
/* 零值/透明值 — 跳过，节省传输量（server 端缺省即代表默认值） */
var SKIP_VAL={'':1,'0px':1,'none':1,'rgba(0, 0, 0, 0)':1,'transparent':1,'normal':1};
var SKIP_TAGS={script:1,style:1,meta:1,link:1,head:1,path:1,svg:1,defs:1,use:1,g:1,
  circle:1,rect:1,line:1,polyline:1,polygon:1,mask:1,clipPath:1,linearGradient:1,
  stop:1,symbol:1,title:1,noscript:1,br:1,hr:1};

/* 悬浮提示 */
var overlay=document.createElement('div');
overlay.style.cssText='position:fixed;top:16px;right:16px;z-index:2147483647;'+
'background:#3855D5;color:#fff;padding:12px 20px;border-radius:10px;'+
'font-family:system-ui,sans-serif;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.2);'+
'display:flex;align-items:center;gap:10px;min-width:220px;';
var spinner=document.createElement('div');
spinner.style.cssText='width:16px;height:16px;border:2px solid rgba(255,255,255,.4);'+
'border-top-color:#fff;border-radius:50%;animation:bjhSpin .8s linear infinite;flex-shrink:0;';
var style=document.createElement('style');
style.textContent='@keyframes bjhSpin{to{transform:rotate(360deg)}}';
document.head.appendChild(style);
var msg=document.createElement('span');
msg.textContent='采集中…';
overlay.appendChild(spinner);overlay.appendChild(msg);
document.body.appendChild(overlay);

function setMsg(t,c){msg.textContent=t;if(c)overlay.style.background=c;}
function done(){setTimeout(function(){overlay.remove();style.remove();window.__bjhCollecting=false;},4000);}

/* 单层选择器，无 DOM 向上遍历 */
function quickSel(el){
  var tag=el.tagName.toLowerCase();
  if(el.id&&/^[A-Za-z][\\w-]*$/.test(el.id))return tag+'#'+el.id;
  var role=el.getAttribute('role')||el.getAttribute('data-testid');
  if(role)return tag+'['+(el.getAttribute('role')?'role':'data-testid')+'="'+role+'"]';
  var cls=[].filter.call(el.classList,function(c){return c&&!/^css-[a-z0-9]+$/i.test(c);})
    .slice(0,2).map(function(c){return'.'+c;}).join('');
  return tag+cls;
}

/* 分块异步采集，每 400 个让出主线程一次 */
function collect(allEls,cb){
  var elements=[];var i=0;
  function next(){
    var end=Math.min(i+400,allEls.length);
    while(i<end&&elements.length<MAX_EL){
      var el=allEls[i++];
      if(SKIP_TAGS[el.tagName.toLowerCase()])continue;
      var r=el.getBoundingClientRect();
      if(r.width<1||r.height<1)continue;
      var cs=getComputedStyle(el);
      if(cs.display==='none'||cs.visibility==='hidden'||Number(cs.opacity)===0)continue;
      /* 只存非零非透明值 */
      var styles={};
      for(var pi=0;pi<CP.length;pi++){var v=cs.getPropertyValue(CP[pi]);if(!SKIP_VAL[v])styles[CP[pi]]=v;}
      elements.push({
        index:elements.length,tagName:el.tagName.toLowerCase(),selector:quickSel(el),
        bbox:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},
        styles:styles
      });
    }
    if(i<allEls.length&&elements.length<MAX_EL){
      setMsg('采集中 ('+elements.length+')…');setTimeout(next,0);
    }else{cb(elements);}
  }
  setTimeout(next,0);
}

try{
  collect([].slice.call(document.querySelectorAll('body *')),function(elements){
    setMsg('上传中…');
    fetch(SERVER+'/api/collect',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        page:{url:location.href,title:document.title,
          viewport:{width:innerWidth,height:innerHeight},
          document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},
          capturedAt:new Date().toISOString()},
        elements:elements
      })
    }).then(function(r){return r.json();}).then(function(data){
      if(data.ok){
        setMsg('✓ 完成，点击查看报告 →','#00BA73');
        overlay.style.cursor='pointer';
        overlay.onclick=function(){window.open(SERVER+data.reportUrl,'_blank');};
        done();
      }else{setMsg('失败：'+(data.error||'?'),'#F54242');done();}
    }).catch(function(e){setMsg('网络错误：'+e.message,'#F54242');done();});
  });
}catch(e){setMsg('出错：'+e.message,'#F54242');done();}
})()`;
}

// ─── 路由 ─────────────────────────────────────────────────────────────────────

const visualGenerating = new Set(); // 防止同一 run 并发触发多次 generate-visual-report

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /api/collect
  if (req.method === 'POST' && pathname === '/api/collect') {
    await handleCollect(req, res);
    return;
  }

  // GET /reports  — 仪表盘
  if (req.method === 'GET' && (pathname === '/reports' || pathname === '/reports/')) {
    await handleReportList(res);
    return;
  }

  // GET /reports/:id/status  — 流水线状态查询（供轮询页使用）
  const statusMatch = pathname.match(/^\/reports\/([^/]+)\/status$/);
  if (req.method === 'GET' && statusMatch) {
    const runId = statusMatch[1];
    const dir   = path.join(artifactsRoot, runId);
    if (existsSync(path.join(dir, 'error.json'))) {
      let msg = '生成失败';
      try { msg = JSON.parse(await fs.readFile(path.join(dir, 'error.json'), 'utf8')).error; } catch {}
      json(res, { status: 'error', message: msg });
    } else if (existsSync(path.join(dir, 'design-compliance.html'))) {
      json(res, { status: 'ready' });
    } else {
      json(res, { status: 'pending' });
    }
    return;
  }

  // GET /reports/:id  — 单次报告 HTML
  const reportMatch = pathname.match(/^\/reports\/([^/]+)$/);
  if (req.method === 'GET' && reportMatch) {
    const runId = reportMatch[1];
    const reportFile = path.join(artifactsRoot, runId, 'design-compliance.html');
    if (existsSync(reportFile)) {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      createReadStream(reportFile).pipe(res);
    } else {
      html(res, pendingHtml(runId, 'report'));
    }
    return;
  }

  // GET /reports/:id/visual/status  — 可视化报告生成状态
  const visualStatusMatch = pathname.match(/^\/reports\/([^/]+)\/visual\/status$/);
  if (req.method === 'GET' && visualStatusMatch) {
    const runId = visualStatusMatch[1];
    const dir = path.join(artifactsRoot, runId);
    if (existsSync(path.join(dir, 'visual-report.html'))) {
      json(res, { status: 'ready' });
    } else if (existsSync(path.join(dir, 'visual-error.json'))) {
      let msg = '生成失败';
      try { msg = JSON.parse(await fs.readFile(path.join(dir, 'visual-error.json'), 'utf8')).error; } catch {}
      json(res, { status: 'error', message: msg });
    } else {
      json(res, { status: 'pending' });
    }
    return;
  }

  // GET /reports/:id/visual  — 可视化标注页（按需生成）
  const visualMatch = pathname.match(/^\/reports\/([^/]+)\/visual$/);
  if (req.method === 'GET' && visualMatch) {
    const runId = visualMatch[1];
    const dir = path.join(artifactsRoot, runId);
    const visualFile = path.join(dir, 'visual-report.html');
    if (existsSync(visualFile)) {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      createReadStream(visualFile).pipe(res);
    } else {
      // 按需触发生成（幂等：已在生成中则跳过）
      if (!visualGenerating.has(runId) && existsSync(path.join(dir, 'design-compliance.json'))) {
        visualGenerating.add(runId);
        runScript(path.join(__dirname, 'generate-visual-report.mjs'), { RUN_DIR: dir })
          .then(() => { visualGenerating.delete(runId); })
          .catch(() => {
            visualGenerating.delete(runId);
            fs.writeFile(path.join(dir, 'visual-error.json'),
              JSON.stringify({ error: '生成失败', at: new Date().toISOString() }, null, 2)).catch(() => {});
          });
      }
      html(res, pendingHtml(runId, 'visual'));
    }
    return;
  }

  // GET /reports/:id/:file.png  — 标注截图（静态图片）
  const imgMatch = pathname.match(/^\/reports\/([^/]+)\/([^/]+\.png)$/);
  if (req.method === 'GET' && imgMatch) {
    const [, runId, fileName] = imgMatch;
    const safe = path.basename(fileName);
    const imgFile = path.join(artifactsRoot, runId, safe);
    if (existsSync(imgFile)) {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public,max-age=3600' });
      createReadStream(imgFile).pipe(res);
    } else {
      res.writeHead(404); res.end();
    }
    return;
  }

  // GET /setup  — 安装说明页（动态注入服务器地址）
  if (req.method === 'GET' && (pathname === '/setup' || pathname === '/')) {
    html(res, setupHtml());
    return;
  }

  // GET /*.html  — 静态 HTML 文件（server.mjs 同目录下）
  if (req.method === 'GET' && pathname.endsWith('.html')) {
    const safeName = path.basename(pathname);
    const filePath = path.join(__dirname, safeName);
    if (existsSync(filePath)) {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      createReadStream(filePath).pipe(res);
    } else {
      html(res, `<h2>文件不存在：${safeName}</h2>`, 404);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

await fs.mkdir(artifactsRoot, { recursive: true });

// 启动时补跑所有「孤儿 pending」run（上次进程被杀导致 pipeline 未完成）
async function recoverPendingRuns() {
  const entries = await fs.readdir(artifactsRoot).catch(() => []);
  for (const entry of entries) {
    const dir = path.join(artifactsRoot, entry);
    const hasHtml  = existsSync(path.join(dir, 'design-compliance.html'));
    const hasError = existsSync(path.join(dir, 'error.json'));
    const hasData  = existsSync(path.join(dir, 'computed-styles.json'));
    if (!hasHtml && !hasError && hasData) {
      console.log(`[recovery] 补跑遗孤 run: ${entry}`);
      const runDir = dir;
      setImmediate(async () => {
        const errorFile = path.join(runDir, 'error.json');
        try {
          const env = { RUN_DIR: runDir };
          const out1 = await runScript(path.join(__dirname, 'compare-design-spec.mjs'), env);
          if (!existsSync(path.join(runDir, 'design-compliance.html'))) {
            throw new Error('报告文件未生成\n' + out1);
          }
        } catch (e) {
          console.error(`[recovery] ${entry} 失败:`, e.message);
          await fs.writeFile(errorFile, JSON.stringify({ error: e.message, at: new Date().toISOString() }, null, 2));
        }
      });
    }
  }
}
recoverPendingRuns();

server.listen(PORT, HOST, () => {
  console.log(`\n设计合规分析服务器已启动`);
  console.log(`安装书签: http://localhost:${PORT}/setup`);
  console.log(`查看报告: http://localhost:${PORT}/reports\n`);
});
