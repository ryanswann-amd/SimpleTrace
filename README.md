# Simple Trace

A native VSCode / Cursor extension that renders Chrome Trace Event Format JSON
as an interactive, Perfetto-style timeline directly inside the editor. No
browser, no uploading your traces to `ui.perfetto.dev`.

Simple Trace reads the same JSON that Perfetto and `chrome://tracing` consume,
so any tool that emits Chrome-trace output (profilers, tracers, custom
instrumentation) can be viewed in place.

## Why

Opening trace files usually means leaving your editor, launching a browser, and
uploading data to a hosted UI. Simple Trace keeps the whole loop local: open a
trace file and it renders as a zoomable timeline in an editor tab, next to the
code that produced it.

## Features

- Interactive canvas timeline with zoom, pan, vertical scroll, and fit-to-view.
- Tracks grouped by process and ordered by `thread_sort_index`.
- Slices colored by category (`cat`) with a clickable legend to toggle
  categories on and off.
- Hover or click any slice to see its name, category, track, start time,
  duration, and all `args`.
- Slice-name filter box for quickly isolating events.
- "Merge tracks by name" toggle to collapse identically named threads into a
  single lane.
- Understands `X` (complete) and `B`/`E` (begin/end) events, with automatic
  stacking of nested slices.
- Zero build step and no runtime dependencies. The extension is plain
  JavaScript.

## Controls

| Action            | Result                                  |
| ----------------- | --------------------------------------- |
| Wheel             | Scroll up / down                        |
| `+` / `=`         | Zoom in                                 |
| `-` / `_`         | Zoom out                                |
| Ctrl/Cmd + Wheel  | Zoom horizontally (centered on cursor)  |
| Shift + Wheel     | Pan horizontally                        |
| Drag              | Pan (horizontal and vertical)           |
| Double-click      | Fit to view                             |
| Click slice       | Pin its details tooltip                 |
| Arrow keys / WASD | Pan                                     |
| `f` / `0`         | Fit                                     |

## Install

### One-line install from GitHub Releases

Downloads the latest released `.vsix` and installs it into Cursor (or VSCode):

```bash
curl -fsSL https://raw.githubusercontent.com/ryanswann-amd/SimpleTrace/main/install.sh | bash
```

Clone and run the script directly to pick a specific version:

```bash
./install.sh          # latest release
./install.sh v0.1.0   # specific tag
```

Set `EDITOR_CMD=code` to target VSCode explicitly, or `REPO=owner/fork` to
install from a fork. After installing, run "Developer: Reload Window".

### Download and install the latest .vsix directly

This always points at the most recent release, no script involved:

```bash
curl -fsSL -o simple-trace.vsix \
  https://github.com/ryanswann-amd/SimpleTrace/releases/latest/download/simple-trace.vsix
cursor --install-extension simple-trace.vsix   # or: code --install-extension ...
```

### Manual install

Download `simple-trace.vsix` from the
[Releases page](https://github.com/ryanswann-amd/SimpleTrace/releases), then use
"Extensions: Install from VSIX..." in the command palette, or:

```bash
cursor --install-extension simple-trace.vsix   # or: code --install-extension ...
```

### Run from source

Open this folder in Cursor / VSCode and press `F5` ("Run Extension"). A second
window launches with the extension loaded. There is no build step.

## Usage

- Files matching `*trace*.json`, `*.trace.json`, `*.perfetto.json`, or
  `*.chrometrace.json` open in the timeline automatically.
- For any other `.json` file, right-click and choose
  "Reopen Editor With... > Simple Trace (Timeline)", or run the command
  "Simple Trace: Open Active File as Timeline".

## Supported input

Chrome Trace Event Format, either an object with a `traceEvents` array:

```json
{ "traceEvents": [ ... ], "displayTimeUnit": "ms" }
```

or a bare array of events. Timestamp and duration values are interpreted as
microseconds (the Chrome-trace convention). The following event types are used:

- `X` (complete): a slice with `ts` and `dur`.
- `B` / `E` (begin / end): paired into slices per track, with nesting support.
- `M` (metadata): `process_name`, `thread_name`, and `thread_sort_index` set
  track labels and ordering.

Other event phases (instant, counter, flow) are currently ignored.

## Development and releasing

Continuous integration and releases are automated with GitHub Actions:

- `.github/workflows/ci.yml` runs on every push and pull request. It
  syntax-checks the sources and packages a `.vsix` build artifact.
- `.github/workflows/release.yml` runs when a `v*` tag is pushed. It builds the
  `.vsix` and publishes it as a GitHub Release asset.

To cut a release, bump `version` in `package.json`, then:

```bash
git tag v0.1.0
git push origin v0.1.0
```

To build locally:

```bash
npm install
npm run package   # produces simple-trace.vsix
```

## License

MIT. See [LICENSE](LICENSE).
