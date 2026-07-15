(function () {
  "use strict";
  const vscode = acquireVsCodeApi();

  // ---------- DOM ----------
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("stage");
  const tooltip = document.getElementById("tooltip");
  const legendEl = document.getElementById("legend");
  const titleEl = document.getElementById("title");
  const statsEl = document.getElementById("stats");
  const searchEl = document.getElementById("search");
  const fitBtn = document.getElementById("fit");
  const mergeChk = document.getElementById("mergeTracks");
  const helpEl = document.getElementById("help");
  helpEl.textContent =
    "wheel = scroll up/down · +/− = zoom in/out · ctrl+wheel = zoom · shift+wheel = pan horizontally · drag = pan · double-click = fit";

  // ---------- layout constants ----------
  const GUTTER = 190;
  const RULER_H = 26;
  const SLICE_H = 14;
  const TRACK_GAP = 2;
  const GROUP_H = 18;

  // ---------- state ----------
  let model = null; // parsed trace model
  let dpr = window.devicePixelRatio || 1;
  let view = { start: 0, pxPerUs: 1, scrollY: 0 }; // start in us
  let hover = null; // slice under cursor
  let pinned = null; // clicked slice
  let disabledCats = new Set();
  let filterText = "";

  // ---------- color palette ----------
  // Categories are colored from a fixed categorical palette in order of first
  // appearance, falling back to a deterministic hashed hue if it is exhausted.
  const PALETTE = [
    "#3b76c0", "#e08a1e", "#2f9e6f", "#8e6fbf", "#c0504d",
    "#4bacc6", "#d6a419", "#7f8c8d", "#5b9bd5", "#e06c9f",
    "#70ad47", "#a6761d", "#9c6ade", "#d95f5f", "#3fa7a0",
  ];
  const catColorCache = {};
  let catColorNext = 0;
  function catColor(cat) {
    const key = cat == null ? "(none)" : String(cat);
    if (catColorCache[key]) return catColorCache[key];
    let color;
    if (catColorNext < PALETTE.length) {
      color = PALETTE[catColorNext++];
    } else {
      let h = 0;
      for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
      color = `hsl(${h % 360}, 55%, 52%)`;
    }
    catColorCache[key] = color;
    return color;
  }

  // ---------- time formatting (raw values assumed microseconds) ----------
  function fmtTime(us) {
    const a = Math.abs(us);
    if (a === 0) return "0";
    if (a < 1e-3) return (us * 1000).toFixed(2) + " ns";
    if (a < 1) return (us * 1000).toFixed(1) + " ns";
    if (a < 1000) return us.toFixed(a < 10 ? 3 : 2) + " µs";
    if (a < 1e6) return (us / 1000).toFixed(a < 1e4 ? 3 : 2) + " ms";
    return (us / 1e6).toFixed(3) + " s";
  }
  function fmtDur(us) {
    return fmtTime(us);
  }

  // ---------- parsing ----------
  function parse(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error("Invalid JSON: " + e.message);
    }
    const events = Array.isArray(raw) ? raw : raw.traceEvents;
    if (!Array.isArray(events))
      throw new Error("No 'traceEvents' array found in file.");

    const procNames = {}; // pid -> name
    const threadNames = {}; // pid:tid -> name
    const threadSort = {}; // pid:tid -> sort index
    const tracksMap = new Map(); // key -> track
    const openStacks = new Map(); // key -> [event] for B/E matching
    const cats = new Set();

    let tMin = Infinity;
    let tMax = -Infinity;

    function trackFor(pid, tid) {
      const key = pid + ":" + tid;
      let t = tracksMap.get(key);
      if (!t) {
        t = { key, pid, tid, slices: [], maxDepth: 1 };
        tracksMap.set(key, t);
      }
      return t;
    }

    function addSlice(pid, tid, name, cat, ts, dur, args) {
      if (dur < 0) dur = 0;
      const t = trackFor(pid, tid);
      t.slices.push({ name, cat, ts, dur, end: ts + dur, args, track: t, depth: 0 });
      if (cat != null) cats.add(String(cat));
      else cats.add("(none)");
      if (ts < tMin) tMin = ts;
      if (ts + dur > tMax) tMax = ts + dur;
    }

    for (const e of events) {
      const ph = e.ph;
      if (ph === "M") {
        if (e.name === "process_name") procNames[e.pid] = e.args && e.args.name;
        else if (e.name === "thread_name")
          threadNames[e.pid + ":" + e.tid] = e.args && e.args.name;
        else if (e.name === "thread_sort_index")
          threadSort[e.pid + ":" + e.tid] = e.args && e.args.sort_index;
        continue;
      }
      const pid = e.pid == null ? 0 : e.pid;
      const tid = e.tid == null ? 0 : e.tid;
      if (ph === "X") {
        addSlice(pid, tid, e.name, e.cat, +e.ts || 0, +e.dur || 0, e.args);
      } else if (ph === "B") {
        const key = pid + ":" + tid;
        if (!openStacks.has(key)) openStacks.set(key, []);
        openStacks.get(key).push(e);
      } else if (ph === "E") {
        const key = pid + ":" + tid;
        const st = openStacks.get(key);
        if (st && st.length) {
          const b = st.pop();
          addSlice(pid, tid, b.name, b.cat, +b.ts || 0, (+e.ts || 0) - (+b.ts || 0), b.args || e.args);
        }
      }
      // instant (i/I), counters (C), flows (s/t/f) are ignored for now
    }

    // assign names / sort index
    const tracks = Array.from(tracksMap.values());
    for (const t of tracks) {
      t.name = threadNames[t.key] || "tid " + t.tid;
      t.procName = procNames[t.pid] || (t.pid !== 0 ? "pid " + t.pid : "");
      t.sortIndex = threadSort[t.key];
      // stack overlapping slices
      t.slices.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
      const endByDepth = [];
      for (const s of t.slices) {
        let d = 0;
        while (d < endByDepth.length && endByDepth[d] > s.ts + 1e-9) d++;
        s.depth = d;
        endByDepth[d] = s.end;
        if (d + 1 > t.maxDepth) t.maxDepth = d + 1;
      }
    }

    // order tracks: by process, then sort_index, then tid
    tracks.sort((a, b) => {
      if (a.pid !== b.pid) return a.pid - b.pid;
      const sa = a.sortIndex == null ? Infinity : a.sortIndex;
      const sb = b.sortIndex == null ? Infinity : b.sortIndex;
      if (sa !== sb) return sa - sb;
      return a.tid - b.tid;
    });

    if (!isFinite(tMin)) {
      tMin = 0;
      tMax = 1;
    }
    let sliceCount = 0;
    for (const t of tracks) sliceCount += t.slices.length;

    return {
      tracks,
      cats: Array.from(cats).sort(),
      tMin,
      tMax,
      sliceCount,
      procNames,
    };
  }

  // ---------- track / process layout with grouping ----------
  function buildRows() {
    // rows: sequence of { type:'group'|'track', ... , y, h }
    const rows = [];
    const merge = mergeChk.checked;
    let displayTracks = model.tracks;

    if (merge) {
      // merge all slices from tracks sharing the same name into one track
      const byName = new Map();
      for (const t of model.tracks) {
        const gk = t.pid + "|" + t.name;
        if (!byName.has(gk))
          byName.set(gk, {
            key: gk,
            pid: t.pid,
            name: t.name,
            procName: t.procName,
            sortIndex: t.sortIndex,
            slices: [],
            maxDepth: 1,
          });
        const m = byName.get(gk);
        for (const s of t.slices) m.slices.push(s);
      }
      displayTracks = Array.from(byName.values());
      for (const t of displayTracks) {
        t.slices.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
        const endByDepth = [];
        for (const s of t.slices) {
          let d = 0;
          while (d < endByDepth.length && endByDepth[d] > s.ts + 1e-9) d++;
          s.depth = d;
          endByDepth[d] = s.end;
          if (d + 1 > t.maxDepth) t.maxDepth = d + 1;
        }
      }
      displayTracks.sort((a, b) => {
        if (a.pid !== b.pid) return a.pid - b.pid;
        const sa = a.sortIndex == null ? Infinity : a.sortIndex;
        const sb = b.sortIndex == null ? Infinity : b.sortIndex;
        if (sa !== sb) return sa - sb;
        return a.name < b.name ? -1 : 1;
      });
    }

    let y = 0;
    let lastPid = null;
    for (const t of displayTracks) {
      if (t.pid !== lastPid) {
        rows.push({
          type: "group",
          y,
          h: GROUP_H,
          label: t.procName || "process " + t.pid,
        });
        y += GROUP_H;
        lastPid = t.pid;
      }
      const h = t.maxDepth * SLICE_H + TRACK_GAP;
      rows.push({ type: "track", y, h, track: t });
      y += h;
    }
    return { rows, totalH: y };
  }

  let rowCache = null;
  function rows() {
    if (!rowCache) rowCache = buildRows();
    return rowCache;
  }
  function invalidateRows() {
    rowCache = null;
  }

  // ---------- coordinate transforms ----------
  function plotW() {
    return canvas.clientWidth - GUTTER;
  }
  function timeToX(t) {
    return GUTTER + (t - view.start) * view.pxPerUs;
  }
  function xToTime(x) {
    return view.start + (x - GUTTER) / view.pxPerUs;
  }

  // ---------- fit ----------
  function fit() {
    if (!model) return;
    const span = Math.max(model.tMax - model.tMin, 1e-6);
    view.pxPerUs = plotW() / (span * 1.02);
    view.start = model.tMin;
    view.scrollY = 0;
    draw();
  }

  // ---------- resize ----------
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  // ---------- drawing ----------
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name);
    return v ? v.trim() : fallback;
  }

  function niceStep(rawStep) {
    const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const n = rawStep / pow;
    let m;
    if (n < 1.5) m = 1;
    else if (n < 3) m = 2;
    else if (n < 7) m = 5;
    else m = 10;
    return m * pow;
  }

  function draw() {
    if (!ctx) return;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const bg = cssVar("--bg", "#1e1e1e");
    const fg = cssVar("--fg", "#d4d4d4");
    const muted = cssVar("--muted", "#9aa0a6");
    const border = cssVar("--border", "#333");

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    if (!model) {
      ctx.fillStyle = muted;
      ctx.font = "13px sans-serif";
      ctx.fillText("Loading trace…", 20, 40);
      return;
    }

    // never pan left of t=0 (trace start)
    if (view.start < model.tMin) view.start = model.tMin;

    const layout = rows();
    // clamp scrollY
    const maxScroll = Math.max(0, layout.totalH - (H - RULER_H));
    if (view.scrollY > maxScroll) view.scrollY = maxScroll;
    if (view.scrollY < 0) view.scrollY = 0;

    const contentTop = RULER_H;
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, contentTop, W - GUTTER, H - contentTop);
    ctx.clip();

    // gridlines (time)
    const targetPx = 110;
    const step = niceStep(targetPx / view.pxPerUs);
    const first = Math.ceil(view.start / step) * step;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = first; timeToX(t) < W; t += step) {
      const x = Math.round(timeToX(t)) + 0.5;
      ctx.moveTo(x, contentTop);
      ctx.lineTo(x, H);
    }
    ctx.stroke();

    // slices
    const filter = filterText.toLowerCase();
    hover = null;
    const minVisT = view.start;
    const maxVisT = xToTime(W);
    for (const row of layout.rows) {
      if (row.type !== "track") continue;
      const rowTop = contentTop + row.y - view.scrollY;
      if (rowTop > H || rowTop + row.h < contentTop) continue;
      const t = row.track;
      for (const s of t.slices) {
        if (s.end < minVisT || s.ts > maxVisT) continue;
        const catKey = s.cat == null ? "(none)" : String(s.cat);
        if (disabledCats.has(catKey)) continue;
        if (filter && s.name.toLowerCase().indexOf(filter) === -1) continue;
        let x0 = timeToX(s.ts);
        let x1 = timeToX(s.end);
        if (x0 < GUTTER) x0 = GUTTER;
        let w = x1 - x0;
        if (w < 1) w = 1;
        const y = rowTop + s.depth * SLICE_H;
        if (y + SLICE_H < contentTop || y > H) continue;
        ctx.fillStyle = catColor(s.cat);
        ctx.fillRect(x0, y, w, SLICE_H - 1);
        // label if wide enough
        if (w > 28) {
          ctx.fillStyle = "#fff";
          ctx.font = "10px sans-serif";
          const prev = ctx.textBaseline;
          ctx.textBaseline = "middle";
          const label = clipText(s.name, w - 6);
          if (label) ctx.fillText(label, x0 + 3, y + (SLICE_H - 1) / 2);
          ctx.textBaseline = prev;
        }
      }
    }
    ctx.restore();

    // gutter (track labels) — drawn after clip released
    ctx.fillStyle = bg;
    ctx.fillRect(0, contentTop, GUTTER, H - contentTop);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, contentTop, GUTTER, H - contentTop);
    ctx.clip();
    for (const row of layout.rows) {
      const rowTop = contentTop + row.y - view.scrollY;
      if (rowTop > H || rowTop + row.h < contentTop) continue;
      if (row.type === "group") {
        ctx.fillStyle = cssVar("--toolbar-bg", "#252526");
        ctx.fillRect(0, rowTop, W, row.h);
        ctx.fillStyle = fg;
        ctx.font = "bold 11px sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(clipText(row.label, GUTTER - 8), 6, rowTop + row.h / 2);
      } else {
        ctx.fillStyle = muted;
        ctx.font = "11px sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(clipText(row.track.name, GUTTER - 10), 8, rowTop + row.h / 2);
      }
    }
    ctx.restore();
    // group full-width bands over plot area
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, contentTop, W - GUTTER, H - contentTop);
    ctx.clip();
    for (const row of layout.rows) {
      if (row.type !== "group") continue;
      const rowTop = contentTop + row.y - view.scrollY;
      if (rowTop > H || rowTop + row.h < contentTop) continue;
      ctx.fillStyle = cssVar("--toolbar-bg", "#252526");
      ctx.fillRect(GUTTER, rowTop, W - GUTTER, row.h);
    }
    ctx.restore();

    // gutter separator
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(GUTTER + 0.5, contentTop);
    ctx.lineTo(GUTTER + 0.5, H);
    ctx.stroke();

    // ruler
    ctx.fillStyle = cssVar("--toolbar-bg", "#252526");
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(W, RULER_H + 0.5);
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "middle";
    for (let t = first; timeToX(t) < W; t += step) {
      const x = timeToX(t);
      if (x < GUTTER) continue;
      ctx.strokeStyle = border;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - 6);
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();
      ctx.fillText(fmtTime(t - model.tMin), x + 3, RULER_H / 2);
    }

    // hover / pinned highlight outline
    const hi = pinned || pendingHover;
    if (hi && hi.rect) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hi.rect.x, hi.rect.y, hi.rect.w, hi.rect.h);
    }
  }

  function clipText(text, maxW) {
    if (!text) return "";
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0,
      hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const s = text.slice(0, mid) + "…";
      if (ctx.measureText(s).width <= maxW) lo = mid + 1;
      else hi = mid;
    }
    const n = Math.max(0, lo - 1);
    return n > 0 ? text.slice(0, n) + "…" : "";
  }

  // ---------- hit testing ----------
  let pendingHover = null;
  function sliceAt(px, py) {
    const layout = rows();
    const contentTop = RULER_H;
    if (px < GUTTER || py < contentTop) return null;
    const filter = filterText.toLowerCase();
    for (const row of layout.rows) {
      if (row.type !== "track") continue;
      const rowTop = contentTop + row.y - view.scrollY;
      if (py < rowTop || py > rowTop + row.h) continue;
      const depth = Math.floor((py - rowTop) / SLICE_H);
      const t = row.track;
      for (const s of t.slices) {
        if (s.depth !== depth) continue;
        const catKey = s.cat == null ? "(none)" : String(s.cat);
        if (disabledCats.has(catKey)) continue;
        if (filter && s.name.toLowerCase().indexOf(filter) === -1) continue;
        const x0 = timeToX(s.ts);
        const x1 = Math.max(timeToX(s.end), x0 + 1);
        if (px >= x0 - 1 && px <= x1 + 1) {
          const y = rowTop + s.depth * SLICE_H;
          return {
            slice: s,
            rect: { x: x0, y, w: Math.max(x1 - x0, 1), h: SLICE_H - 1 },
          };
        }
      }
      return null;
    }
    return null;
  }

  // ---------- tooltip ----------
  function showTooltip(hit, clientX, clientY) {
    const s = hit.slice;
    const rows2 = [];
    rows2.push(`<div class="t-name">${esc(s.name)}</div>`);
    if (s.cat != null) rows2.push(row("category", s.cat));
    rows2.push(row("track", s.track.name));
    rows2.push(row("start", fmtTime(s.ts - model.tMin)));
    rows2.push(row("duration", fmtDur(s.dur)));
    rows2.push(row("wall", fmtTime(s.ts) + " → " + fmtTime(s.end)));
    if (s.args && typeof s.args === "object") {
      for (const k of Object.keys(s.args)) {
        rows2.push(row(k, s.args[k]));
      }
    }
    tooltip.innerHTML = rows2.join("");
    tooltip.classList.remove("hidden");
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let x = clientX + 14;
    let y = clientY + 14;
    const rect = stage.getBoundingClientRect();
    if (x + tw > rect.width) x = clientX - tw - 14;
    if (y + th > rect.height) y = clientY - th - 14;
    tooltip.style.left = Math.max(2, x) + "px";
    tooltip.style.top = Math.max(2, y) + "px";
  }
  function row(k, v) {
    return `<div class="t-row"><b>${esc(k)}</b>: ${esc(String(v))}</div>`;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    }[c]));
  }
  function hideTooltip() {
    tooltip.classList.add("hidden");
  }

  // ---------- legend ----------
  function buildLegend() {
    legendEl.innerHTML = "";
    for (const cat of model.cats) {
      const item = document.createElement("div");
      item.className = "item" + (disabledCats.has(cat) ? " disabled" : "");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = catColor(cat === "(none)" ? null : cat);
      const label = document.createElement("span");
      label.textContent = cat;
      item.appendChild(sw);
      item.appendChild(label);
      item.onclick = () => {
        if (disabledCats.has(cat)) disabledCats.delete(cat);
        else disabledCats.add(cat);
        buildLegend();
        draw();
      };
      legendEl.appendChild(item);
    }
  }

  // ---------- interactions ----------
  stage.addEventListener("wheel", (e) => {
    if (!model) return;
    e.preventDefault();
    // ctrl/cmd + wheel = zoom horizontally; otherwise scroll up/down
    if (e.ctrlKey || e.metaKey) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const anchorT = xToTime(mx < GUTTER ? GUTTER : mx);
      const factor = Math.exp(-e.deltaY * 0.0015);
      view.pxPerUs *= factor;
      view.pxPerUs = Math.max(1e-9, Math.min(view.pxPerUs, 1e9));
      const mxc = mx < GUTTER ? GUTTER : mx;
      view.start = anchorT - (mxc - GUTTER) / view.pxPerUs;
      draw();
      return;
    }
    // shift converts vertical wheel into horizontal pan
    if (e.shiftKey && e.deltaX === 0) {
      view.start += e.deltaY / view.pxPerUs;
      draw();
      return;
    }
    view.scrollY += e.deltaY;
    if (e.deltaX) view.start += e.deltaX / view.pxPerUs;
    draw();
  }, { passive: false });

  let dragging = false;
  let lastX = 0,
    lastY = 0,
    movedDist = 0;
  canvas.addEventListener("mousedown", (e) => {
    dragging = true;
    movedDist = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.classList.add("panning");
  });
  window.addEventListener("mouseup", (e) => {
    if (dragging && movedDist < 4) {
      // treat as click
      const rect = canvas.getBoundingClientRect();
      const hit = sliceAt(e.clientX - rect.left, e.clientY - rect.top);
      pinned = hit;
      if (hit) showTooltip(hit, e.clientX - rect.left, e.clientY - rect.top);
      else hideTooltip();
      draw();
    }
    dragging = false;
    canvas.classList.remove("panning");
  });
  window.addEventListener("mousemove", (e) => {
    if (!model) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (dragging) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      movedDist += Math.abs(dx) + Math.abs(dy);
      view.start -= dx / view.pxPerUs;
      view.scrollY -= dy;
      lastX = e.clientX;
      lastY = e.clientY;
      hideTooltip();
      pendingHover = null;
      draw();
      return;
    }
    if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) {
      hideTooltip();
      return;
    }
    const hit = sliceAt(mx, my);
    pendingHover = hit;
    if (hit) {
      showTooltip(hit, mx, my);
      draw();
    } else if (!pinned) {
      hideTooltip();
      draw();
    } else {
      draw();
    }
  });

  canvas.addEventListener("dblclick", (e) => {
    e.preventDefault();
    fit();
  });

  fitBtn.addEventListener("click", fit);
  searchEl.addEventListener("input", () => {
    filterText = searchEl.value.trim();
    draw();
  });
  mergeChk.addEventListener("change", () => {
    invalidateRows();
    draw();
  });

  window.addEventListener("keydown", (e) => {
    if (!model) return;
    if (e.target === searchEl) return;
    const panStep = plotW() * 0.15;
    if (e.key === "=" || e.key === "+") {
      zoomBy(1.25);
    } else if (e.key === "-" || e.key === "_") {
      zoomBy(0.8);
    } else if (e.key === "ArrowLeft" || e.key === "a") {
      view.start -= panStep / view.pxPerUs;
      draw();
    } else if (e.key === "ArrowRight" || e.key === "d") {
      view.start += panStep / view.pxPerUs;
      draw();
    } else if (e.key === "ArrowUp" || e.key === "w") {
      view.scrollY -= 60;
      draw();
    } else if (e.key === "ArrowDown" || e.key === "s") {
      view.scrollY += 60;
      draw();
    } else if (e.key === "f" || e.key === "0") {
      fit();
    }
  });
  function zoomBy(factor) {
    const cx = GUTTER + plotW() / 2;
    const anchorT = xToTime(cx);
    view.pxPerUs *= factor;
    view.start = anchorT - (cx - GUTTER) / view.pxPerUs;
    draw();
  }

  window.addEventListener("resize", resize);

  // ---------- message handling ----------
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg.type === "load") {
      titleEl.textContent = msg.fileName || "trace";
      try {
        model = parse(msg.text);
      } catch (err) {
        statsEl.textContent = "";
        vscode.postMessage({ type: "error", message: err.message });
        ctx && drawError(err.message);
        return;
      }
      invalidateRows();
      disabledCats = new Set();
      pinned = null;
      // reset category color assignment for the new trace
      for (const k in catColorCache) delete catColorCache[k];
      catColorNext = 0;
      buildLegend();
      const nProc = Object.keys(model.procNames).length || 1;
      statsEl.textContent = `${model.sliceCount.toLocaleString()} slices · ${model.tracks.length} tracks · span ${fmtTime(
        model.tMax - model.tMin
      )}`;
      resize();
      fit();
    }
  });

  function drawError(m) {
    const W = canvas.clientWidth,
      H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = cssVar("--bg", "#1e1e1e");
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#e06c75";
    ctx.font = "13px sans-serif";
    ctx.fillText("Failed to parse trace: " + m, 20, 40);
  }

  resize();
  vscode.postMessage({ type: "ready" });
})();
