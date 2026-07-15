// Renders the real Simple Trace viewer headlessly against an example trace and
// saves a screenshot for the README. Requires: npm i playwright && npx
// playwright install chromium.
//
// Usage: node docs/render_screenshot.mjs [tracePath] [outPng]

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tracePath = process.argv[2] || path.join(root, "examples", "example.trace.json");
const outPng = process.argv[3] || path.join(root, "docs", "screenshot.png");

const css = readFileSync(path.join(root, "media", "viewer.css"), "utf8");
const js = readFileSync(path.join(root, "media", "viewer.js"), "utf8");
const traceText = readFileSync(tracePath, "utf8");
const fileName = path.basename(tracePath);

// Minimal host page mirroring extension.js's webview HTML, with a stub
// acquireVsCodeApi so viewer.js runs unchanged.
// Provide VSCode-like theme variables so the viewer renders a cohesive dark
// theme headlessly (in the editor these come from the active color theme).
const theme = `:root{
  --vscode-editor-background:#1e1e1e;
  --vscode-editor-foreground:#d4d4d4;
  --vscode-descriptionForeground:#9aa0a6;
  --vscode-panel-border:#333333;
  --vscode-editorWidget-background:#252526;
  --vscode-input-background:#3c3c3c;
  --vscode-input-foreground:#cccccc;
  --vscode-input-border:#555555;
  --vscode-button-background:#0e639c;
  --vscode-button-foreground:#ffffff;
  --vscode-editorHoverWidget-background:#252526;
  --vscode-editorHoverWidget-foreground:#cccccc;
  --vscode-editorHoverWidget-border:#454545;
  --vscode-font-family:"Segoe UI",system-ui,sans-serif;
}`;

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${theme}${css}</style></head>
<body>
  <div id="toolbar">
    <span id="title">trace</span>
    <span class="spacer"></span>
    <label class="ctrl"><input type="checkbox" id="mergeTracks" /> merge tracks by name</label>
    <input type="text" id="search" placeholder="filter slice name…" />
    <button id="fit">Fit</button>
    <span id="stats"></span>
  </div>
  <div id="legend"></div>
  <div id="stage">
    <canvas id="canvas"></canvas>
    <div id="tooltip" class="hidden"></div>
  </div>
  <div id="help"></div>
  <script>
    window.acquireVsCodeApi = () => ({ postMessage: () => {} });
  </script>
  <script>${js}</script>
</body></html>`;

const width = Number(process.env.ST_W || 1200);
const height = Number(process.env.ST_H || 720);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: 2,
});
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(
  ({ fileName, text }) =>
    window.dispatchEvent(new MessageEvent("message", { data: { type: "load", fileName, text } })),
  { fileName, text: traceText }
);
await page.waitForTimeout(400);
await page.screenshot({ path: outPng });
await browser.close();
console.log("wrote", outPng);
