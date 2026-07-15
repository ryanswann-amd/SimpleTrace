const vscode = require("vscode");
const path = require("path");

/**
 * Read-only custom editor that renders Chrome Trace Event Format JSON
 * as an interactive Perfetto-style timeline inside a webview.
 */
class TraceEditorProvider {
  constructor(context) {
    this.context = context;
  }

  async resolveCustomTextEditor(document, webviewPanel, _token) {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, "media")),
      ],
    };

    const mediaUri = (file) =>
      webview.asWebviewUri(
        vscode.Uri.file(path.join(this.context.extensionPath, "media", file))
      );

    webview.html = this.getHtml(webview, mediaUri);

    const post = () => {
      webview.postMessage({
        type: "load",
        fileName: path.basename(document.uri.fsPath),
        text: document.getText(),
      });
    };

    webview.onDidReceiveMessage((msg) => {
      if (msg.type === "ready") post();
      if (msg.type === "error") {
        vscode.window.showErrorMessage("Simple Trace: " + msg.message);
      }
    });

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) post();
    });
    webviewPanel.onDidDispose(() => changeSub.dispose());
  }

  getHtml(webview, mediaUri) {
    const nonce = getNonce();
    const scriptUri = mediaUri("viewer.js");
    const styleUri = mediaUri("viewer.css");
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Simple Trace</title>
</head>
<body>
  <div id="toolbar">
    <span id="title">trace</span>
    <span class="spacer"></span>
    <label class="ctrl"><input type="checkbox" id="mergeTracks" /> merge tracks by name</label>
    <label class="ctrl"><input type="checkbox" id="showFlows" checked /> flow arrows</label>
    <input type="text" id="search" placeholder="filter slice name…" />
    <button id="fit">Fit</button>
    <span id="stats"></span>
  </div>
  <div id="legend"></div>
  <div id="stage">
    <canvas id="canvas"></canvas>
    <div id="tooltip" class="hidden"></div>
  </div>
  <div id="help">wheel = zoom · shift+wheel / drag = pan · double-click = fit · click slice for details</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++)
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function activate(context) {
  const provider = new TraceEditorProvider(context);
  const opts = { webviewOptions: { retainContextWhenHidden: true } };

    context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "simpleTrace.timeline",
      provider,
      opts
    ),
    vscode.window.registerCustomEditorProvider(
      "simpleTrace.timelineOptional",
      provider,
      opts
    ),
    vscode.commands.registerCommand(
      "simpleTrace.openActiveFile",
      async (uri) => {
        const target =
          uri || (vscode.window.activeTextEditor &&
            vscode.window.activeTextEditor.document.uri);
        if (!target) {
          vscode.window.showErrorMessage("Simple Trace: no active file.");
          return;
        }
        await vscode.commands.executeCommand(
          "vscode.openWith",
          target,
          "simpleTrace.timelineOptional"
        );
      }
    )
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
