# Trace format

Simple Trace reads the **Chrome Trace Event Format** (the JSON format used by
`chrome://tracing`, Perfetto, and many profilers). This document defines
exactly which parts of that format Simple Trace understands, how each field is
interpreted, and what is ignored.

If you are generating traces yourself, following this document guarantees they
render correctly.

## Top-level structure

The file is UTF-8 JSON in one of two shapes.

Object form (recommended):

```json
{
  "traceEvents": [ /* array of event objects */ ],
  "displayTimeUnit": "ms"
}
```

Array form (also accepted):

```json
[ /* array of event objects */ ]
```

| Field             | Type   | Required | Notes                                                            |
| ----------------- | ------ | -------- | ---------------------------------------------------------------- |
| `traceEvents`     | array  | yes\*    | The list of event objects. \*Required in object form.            |
| `displayTimeUnit` | string | no       | `"ms"` or `"ns"`. Currently informational; see [Units](#units).  |

Any other top-level fields (for example `metadata`, `otherData`) are ignored.

## Event object

Every element of `traceEvents` is an object. The fields Simple Trace reads:

| Field  | Type            | Meaning                                                                 |
| ------ | --------------- | ----------------------------------------------------------------------- |
| `ph`   | string          | Phase (event type). Determines how the event is handled. See below.     |
| `name` | string          | Display name of the slice.                                              |
| `cat`  | string          | Category. The default color dimension; see [Color](#color-and-the-legend). Optional. |
| `pid`  | number / string | Process id. Groups tracks. Defaults to `0` if omitted.                  |
| `tid`  | number / string | Thread id. Identifies the track within a process. Defaults to `0`.      |
| `ts`   | number          | Start timestamp, in microseconds. See [Units](#units).                  |
| `dur`  | number          | Duration, in microseconds (used by `X` events).                         |
| `args` | object          | Arbitrary key/value metadata shown in the slice tooltip. Every key is also offered as a color dimension. Optional. |

## Supported phases (`ph`)

Simple Trace implements the subset needed to draw a timeline of durations.

### `X` — complete event

A single slice with an explicit start and duration. This is the primary and
recommended event type.

```json
{ "name": "compute", "cat": "kernel", "ph": "X", "pid": 0, "tid": 3, "ts": 120.5, "dur": 42.0, "args": { "size": 4096 } }
```

- Drawn from `ts` to `ts + dur` on the track `(pid, tid)`.
- A negative `dur` is clamped to `0`.

### `B` / `E` — begin and end

A slice expressed as two events on the same `(pid, tid)`: a begin (`B`) followed
by a matching end (`E`). Begins are matched to ends as a stack (LIFO), so nested
begin/end pairs become nested slices.

```json
{ "name": "outer", "ph": "B", "pid": 0, "tid": 1, "ts": 10 }
{ "name": "inner", "ph": "B", "pid": 0, "tid": 1, "ts": 12 }
{ "name": "inner", "ph": "E", "pid": 0, "tid": 1, "ts": 18 }
{ "name": "outer", "ph": "E", "pid": 0, "tid": 1, "ts": 25 }
```

- The slice takes its `name`, `cat`, and `args` from the `B` event (falling back
  to the `E` event's `args` if the begin had none).
- An `E` with no open `B` on that track is ignored.

### `M` — metadata

Metadata events set track labels and ordering. Only these three `name` values
are used; all are optional.

| `name`               | Reads from `args` | Effect                                                        |
| -------------------- | ----------------- | ------------------------------------------------------------- |
| `process_name`       | `args.name`       | Display name for the process group (`pid`).                   |
| `thread_name`        | `args.name`       | Display name for the track (`pid`, `tid`).                    |
| `thread_sort_index`  | `args.sort_index` | Sort key for ordering tracks within a process (ascending).    |

```json
{ "name": "process_name",      "ph": "M", "pid": 0,          "args": { "name": "worker 0" } }
{ "name": "thread_name",       "ph": "M", "pid": 0, "tid": 3, "args": { "name": "stream 3" } }
{ "name": "thread_sort_index", "ph": "M", "pid": 0, "tid": 3, "args": { "sort_index": 3 } }
```

### `s` / `t` / `f` — flow events

Flow events draw **arrows between slices** to show a directed relationship such
as a producer → consumer dependency. A flow is a sequence of points that share
an `id`, in one of three phases: `s` (start), `t` (step), and `f` (finish). An
arrow is drawn between each consecutive pair of points in `ts` order.

| Field | Type            | Meaning                                                                       |
| ----- | --------------- | ----------------------------------------------------------------------------- |
| `id`  | number / string | Flow id. Points sharing an `id` (within a `cat`) form one flow. `bind_id` is also accepted. |
| `cat` | string          | Category. Colors the arrow by default and appears in the legend; toggle it to hide those arrows. |
| `ts`  | number          | Position of this point in time (microseconds).                                |
| `pid` / `tid` | number / string | The track the point sits on.                                          |

- Each point binds to the **enclosing slice** on its `(pid, tid)` track — the
  slice whose `[ts, ts + dur]` interval contains the flow's `ts` (this matches a
  Perfetto `"bp": "e"` flow). If no slice contains it, the point falls back to
  the track's row at that time.
- Flow ids are scoped by `cat` (the Chrome-trace convention), so different
  categories may reuse the same id.
- Arrows are colored by the current "color by" property using the same palette as
  slices — by default `cat`, so each flow category appears in the legend and can
  be toggled there. Hovering a slice highlights the flows that touch it and dims
  the rest; the slice tooltip shows how many flows it touches.
- Use the **flow arrows** toolbar toggle to show/hide all arrows at once.

```json
{ "name": "dep", "cat": "dep_cross_l2", "ph": "s", "id": 7, "pid": 0, "tid": 0, "ts": 10 }
{ "name": "dep", "cat": "dep_cross_l2", "ph": "f", "bp": "e", "id": 7, "pid": 0, "tid": 1, "ts": 60 }
```

See [`examples/flows.trace.json`](../examples/flows.trace.json) for a
producer→consumer fan-out with two flow categories.

### Ignored phases

The following phases are parsed without error but are **not** drawn:
instant (`i` / `I`), counter (`C`), async (`b` / `n` / `e`), sample (`P`),
object (`N` / `O` / `D`), and metadata names other than the three listed above.

## Tracks, grouping, and ordering

- A **track** is one `(pid, tid)` pair. Slices on the same track that overlap in
  time are stacked into sub-rows automatically (depth is computed from overlap).
- Tracks are grouped by **process** (`pid`), labeled using `process_name`.
- Within a process, tracks are ordered by `thread_sort_index` ascending; tracks
  without a sort index sort after those that have one, then by `tid`.
- The "merge tracks by name" toggle collapses all tracks that share the same
  `thread_name` (within a process) into a single lane.

## Color and the legend

Slices and flow arrows are colored by **one property at a time**, chosen with
the "color by" dropdown in the toolbar. The available properties are:

| Option                   | Value used                                                   |
| ------------------------ | ------------------------------------------------------------ |
| `cat` (default)          | The event's `cat`.                                           |
| `name`                   | The event's `name`.                                          |
| `track`                  | The track's `thread_name`, or `tid N` if it has none.        |
| `process`                | The process's `process_name`, or `pid N` for a non-zero pid.  |
| `pid` / `tid`            | The raw ids of the track the event sits on.                   |
| `args.<key>`             | `args[<key>]`, for every key seen anywhere in the trace.      |

Two things hold whichever property you pick:

- Events that **do not have** the selected property all share one neutral gray
  default color and are listed in the legend as `(none)`, which stays clickable
  to hide them. A property counts as missing when the field is absent, `null`, an
  empty string, or (for `args`) an object or array rather than a scalar.
- A flow takes its color from its **first point** (that point's `cat`, `name`,
  `args`, and track), so a flow can be colored by the same properties a slice
  can.

### Categorical coloring

Used for any property that is not entirely numeric.

- Each distinct value gets a color, assigned from a fixed categorical palette in
  order of first appearance, and from generated hues once the palette is
  exhausted. Colors are stable for a given trace and property.
- The legend lists the values of the property currently being colored by, and
  clicking a value hides or shows the events with that value. Each property
  remembers its own hidden values. When a property has more than 48 distinct
  values, the legend shows the 48 most common and notes how many were omitted.

[`examples/example.trace.json`](../examples/example.trace.json) colored by
`args.tile`, with the `(none)` bucket covering the slices that carry no `tile`:

![The timeline colored by an args key](color_by_args.png)

### Numeric heatmap

When **every** value of the selected property is a number, the color can instead
ramp continuously with the value, which suits magnitudes (a size, a duration, a
queue depth) and ordered indices (an iteration or wave id) far better than
unrelated categorical colors.

- The ramp is [viridis](https://bids.github.io/colormap/), stretched linearly
  from the property's smallest value to its largest. The legend becomes a color
  bar labelled with those two bounds.
- A heatmap is the **default** once a numeric property has more than 16 distinct
  values, the point past which the categorical palette stops being readable.
  Below that, categorical coloring is the default. The **heatmap** checkbox in
  the toolbar forces it on or off per property, and is disabled for properties
  that are not numeric.
- Only plain decimal numbers count, including negatives and exponent notation
  (`-3`, `0.5`, `1e6`). Coded strings such as `"0x1000"` are treated as
  identifiers, not magnitudes, so they stay categorical. A single non-numeric
  value anywhere in the trace disqualifies the property.
- If a property has just one distinct value, it is drawn at the middle of the
  ramp rather than at an arbitrary end.

The same `args.tile` property as a heatmap — one bar from `0` to `39` instead of
forty swatches, so the sweep through tiles is visible directly:

![The timeline heatmapped by a numeric args key](heatmap_args.png)

## Units

- `ts` and `dur` are interpreted as **microseconds**, which is the Chrome-trace
  convention, regardless of `displayTimeUnit`.
- Axis and tooltip labels are formatted adaptively (ns / µs / ms / s) based on
  magnitude. Displayed times are relative to the earliest event in the trace.

## Minimal valid example

A single complete (`X`) slice on one track.
[`examples/minimal.trace.json`](../examples/minimal.trace.json):

```json
{
  "traceEvents": [
    { "name": "task", "cat": "work", "ph": "X", "pid": 0, "tid": 0, "ts": 0, "dur": 100 }
  ]
}
```

Rendered:

![Minimal example rendered](format_minimal.png)

## Fuller example

Two tracks in one process, a nested `B`/`E` pair, and a slice on a second
track. [`examples/fuller.trace.json`](../examples/fuller.trace.json):

```json
{
  "displayTimeUnit": "ms",
  "traceEvents": [
    { "name": "process_name",      "ph": "M", "pid": 0,          "args": { "name": "renderer" } },
    { "name": "thread_name",       "ph": "M", "pid": 0, "tid": 0, "args": { "name": "main" } },
    { "name": "thread_sort_index", "ph": "M", "pid": 0, "tid": 0, "args": { "sort_index": 0 } },
    { "name": "thread_name",       "ph": "M", "pid": 0, "tid": 1, "args": { "name": "compositor" } },
    { "name": "thread_sort_index", "ph": "M", "pid": 0, "tid": 1, "args": { "sort_index": 1 } },

    { "name": "frame",  "cat": "render", "ph": "X", "pid": 0, "tid": 0, "ts": 0,    "dur": 16000, "args": { "frame": 1 } },
    { "name": "layout", "cat": "render", "ph": "B", "pid": 0, "tid": 0, "ts": 1000 },
    { "name": "layout", "cat": "render", "ph": "E", "pid": 0, "tid": 0, "ts": 4000 },
    { "name": "commit", "cat": "gpu",    "ph": "X", "pid": 0, "tid": 1, "ts": 15000, "dur": 900 }
  ]
}
```

Rendered. Note the `layout` `B`/`E` pair becomes a single slice, stacked on a
sub-row beneath `frame` because they overlap in time; the two threads appear as
separate tracks ordered by `thread_sort_index`:

![Fuller example rendered](format_fuller.png)

## Reference

- Chrome Trace Event Format specification:
  <https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU>
