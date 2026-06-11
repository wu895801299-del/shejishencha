# 设计合规检查工具

通过浏览器书签，一键采集任意页面的样式数据，与设计规范自动比对，生成可视化合规报告。

## 环境要求

- Node.js 18+
- npm

## 快速启动

```bash
# 1. 克隆仓库
git clone https://github.com/wu895801299-del/shejishencha.git
cd shejishencha

# 2. 安装依赖
npm install

# 3. 启动服务
node server.mjs
```

启动成功后终端显示：

```
设计合规检查服务已启动
安装书签: http://localhost:8899/setup
报告中心: http://localhost:8899/reports
```

## 使用流程

### 第一步：安装书签

浏览器打开 `http://localhost:8899/setup`，按页面指引将书签拖到书签栏。

> 如果服务器部署在远程机器，需要先建立 SSH 隧道，再访问安装页：
> ```bash
> ssh -L 8899:localhost:8899 用户名@服务器地址
> ```
> 然后访问 `http://localhost:8899/setup`

### 第二步：采集页面

打开任意需要检查的页面，点击书签栏的 **📐 设计合规检查**，等待页面右上角出现"✅ 提交成功"提示。

### 第三步：查看报告

浏览器打开 `http://localhost:8899/reports`，点击对应记录查看：

- **合规报告**：列出所有不符合设计规范的元素，包含违规类型、当前值、规范值
- **可视化报告**：在页面截图上标注违规位置

## 更新设计规范

编辑 `DESIGN2-0.md` 文件中的 YAML frontmatter 部分，修改颜色、字号、间距等 token 值，下次采集时自动生效。

## 端口说明

默认端口 `8899`，可通过环境变量修改：

```bash
PORT=9000 node server.mjs
```

## 文件说明

| 文件 | 说明 |
|---|---|
| `server.mjs` | HTTP 服务器，提供安装页、采集接口、报告中心 |
| `DESIGN2-0.md` | 设计规范文件（颜色/字号/间距等 token） |
| `compare-design-spec.mjs` | 样式数据与规范比对，生成合规报告 |
| `generate-visual-report.mjs` | 生成可视化标注报告 |
| `annotate-violations.mjs` | 违规元素标注工具 |
| `collect-current-state.mjs` | 本地手动采集脚本（可选） |
