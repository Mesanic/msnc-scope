# The Scope viewer

`scope view` writes `.scope/files/view/scope.html` — one self-contained page, no network requests,
opens from the filesystem. Read this when changing the viewer or explaining it to someone.

The store and CLI are optimized for the agent; the viewer is optimized for the human. Those are
different jobs. The CLI answers "what do I need to know to do this task" in as few tokens as
possible. The viewer answers "show me how this project fits together, and where the work is".

## Contents

- [How the page is built](#how-the-page-is-built)
- [Knowledge graph view](#knowledge-graph-view)
- [Flow view](#flow-view)
- [Visual encodings](#visual-encodings)
- [Controls](#controls)
- [Performance](#performance)
- [Extending it](#extending-it)

## How the page is built

`lib/html.mjs` reads `scripts/viewer-template.html`, replaces the `/*__SCOPE_DATA__*/` slot with a
JSON payload, and writes the result. The payload is `{meta, nodes, edges, git, issues}` — the
committed graph plus both overlays, so the page is a complete snapshot at generation time.

Every `<` in the JSON is escaped to `<`. Without that, a summary containing `</script>` would
terminate the script block and break the page — and summaries quote code, so it would happen.

Because the page is fully inline it also satisfies a strict CSP, which means it can be published
as an Artifact for sharing without modification.

## Knowledge graph view

A force-directed map of every node type, for exploring structure and relationships.

The simulation is deliberately simple and runs on plain arrays: springs along every edge,
repulsion approximated through a 92px spatial hash so it stays near-linear rather than O(n²),
light gravity toward the origin, 0.85 velocity damping, and an alpha that decays 0.5% per tick
until it stops below 0.02. Dragging a node pins it and reheats the simulation.

Three of those forces exist to make *territory* readable, because containment is drawn as
enclosure rather than as lines (see below) and a hull is only legible if the things it wraps are
genuinely near each other:

- **Containment springs are short and stiff**, with a rest length that grows as the square root
  of the sibling count — a file holding thirty symbols gets a disc to hold them in, not a knot.
- **Cross-module dependency springs are long and weak.** A call from one module into another is
  the single strongest force smearing a module across the map, and on the reference graph there
  are 889 of them. They still pull, but softly and from further away.
- **Modules repel as whole bodies**, at centroid level. The node-level repulsion runs on a 92px
  grid and dies past 184 units, which cannot keep two 400-unit-wide modules from sitting on top
  of each other. 28 modules is 378 pairs, so this is free, and it is what actually divides the
  map into regions you can name.

The layout is warm-started rather than random: modules are placed on a circle at angles derived
from a hash of their path, and files are jittered around their module's position. Two runs of the
viewer over the same graph therefore produce recognisably the same picture, which matters when
someone is trying to re-find a cluster they saw yesterday.

**Containment is enclosure, not connection.** `part-of` is roughly half of every merged graph —
1107 of 2258 edges on the reference repo — and drawn as a line it is indistinguishable from a
dependency, so half the ink says only "these two things are related" while burying the edges that
carry the structure. Those lines are not drawn at all. Instead each file is wrapped in the convex
hull of its symbols and each module in the hull of its files, tinted with a muted per-module hue.
The springs stay, because that is what clusters the members in the first place. The padding is
free: stroking the hull path with a fat round-joined line inflates it by half the line width on
every side, so there is no offset-polygon geometry and no blob library. Toggle under DISPLAY.

**Semantic zoom.** Rather than a checkbox that hides a whole tier, the zoom level decides which
tier is legible: modules are always up, files fade in around 0.3–0.55, symbols around 0.6–1.05.
Zoomed out you get a territory map — named regions carrying file and symbol counts and how much
of each is in flight — and zooming in releases the contents with a fade. Faded-out nodes are also
un-clickable, so you never select something you cannot see. The tier is keyed on node type, not
on depth in the containment tree; nested modules make those two disagree. Toggle under DISPLAY.

Clicking a node opens the detail panel: summary, git state, staleness, flow position, direct
dependent and dependency counts, blast radius, issue state with blockers, connections grouped by
edge type (each clickable to navigate), a **file X-ray** — the file drawn as its own line range
with one tick per symbol, so how the file is packed is visible and not just what is in it — a
one-hop **ego graph**, and a ready-to-paste `scope context <key>` command.
That last one is the handoff: the user finds something interesting, copies the command, and the
agent picks it up with full context.

## Flow view

A layered DAG answering "how does this codebase actually run, and where is the work happening".
Entrypoints sit in column 1 and dependencies flow rightward, so reading left to right is reading
the dependency order.

The pipeline: take the `imports`/`calls` subgraph over file, entry, module and decision nodes;
remove cycles with an iterative DFS (back edges are excluded from layering and drawn as dashed red
arcs, so an import cycle is visible rather than hidden); layer with longest-path over the resulting
DAG so a node always sits to the right of everything that imports it; order within layers with four
barycenter sweeps to reduce crossings; then draw same-module nodes as a labelled block within the
layer. Layers carry captions — "1 · entry points" through "N · leaves" — drawn in **screen space**
and pinned to the top of the viewport, because a caption drawn in world space above its own tallest
row lands on top of the rows of every taller neighbour.

Two things the layering gets wrong on its own, corrected here:

- **Tests are not entry points.** A test file has no importers, so longest-path layering files it
  under "entry points" beside `src/index.ts` — 19 of the 46 roots on the reference repo were
  tests, which makes that column a lie about where the program starts. Tests get their own
  labelled block, and the lane caption counts them separately.
- **Nodes are pills with edge ports.** 29 import edges used to converge on the single centre pixel
  of `server.py`, which reads as one thick line rather than as 29 dependents. Each edge gets its
  own slot along the pill's edge, ordered by where its far end sits. The pill is also the hit
  target, instead of an 18px point in the middle of a 200px row.

Back edges drop below the lanes and return as labelled `↩ cycle` loops, so the shape itself says
"this goes backwards". The selected path animates directionally.

Three things make it explanatory rather than decorative:

**Flow ribbon.** Click any node and its entire ancestry and descendant set stay lit while
everything else drops to 10% opacity. The longest path back to an entrypoint gets numbered badges
(1, 2, 3…) and a copyable breadcrumb along the bottom. That is the answer to "how does execution
get here", which is usually the real question behind "what does this file do".

**Impact mode.** Propagates a ripple outward from the selection along the dependency edges, one
hop per frame-step, and draws a labelled ring per hop — "1 hop · 43" — sized to enclose everything
that far out. Nodes are coloured by hop distance rather than a flat tint, because one hop is what
you break today and nine hops is trivia, and a single amber wash threw that distinction away.
This is "what breaks if I change this", the visual twin of the IMPACT line in `scope context`.
Note the direction: upstream means dependents, not dependencies.

The impact graph is **not** the flow graph. Flow deliberately excludes symbols so the layered view
stays file-shaped; impact must not, because `calls` is 889 of 2258 edges on the reference graph
and every one of them is symbol-to-symbol — asking "what breaks if I change this function" over
the flow graph answered *nothing* for 795 of 1141 nodes. Impact spans both tiers and lets
containment carry the blast upward: change a symbol and its file has changed, so that file's
importers are inside the radius too.

**Work in flight.** Filters to nodes that are uncommitted, unpushed, or referenced by an open
issue. Combined with the flow layout it shows *where in the architecture* current work is
concentrated — whether it is clustered in one layer or scattered across the whole dependency chain.

Only nodes that participate in the flow graph appear here. A repo of pure documentation has an
empty flow view, and that is honest: there is no flow to show.

## Visual encodings

| Encoding | Meaning |
|---|---|
| Fill colour | Node type — entry vermillion, file sky blue, module orchid, symbol bluish green, concept amber, decision indigo, Scope-itself teal. Okabe-Ito derived, and each of the four tables (node type, edge kind, provenance, check state) owns its own band so none of them collide |
| Node shape | Also node type — module square, file circle, symbol diamond, entrypoint triangle, issue hexagon. Nine categories is past what any palette survives and well past what a deuteranope can separate, so shape carries what colour cannot |
| Solid vs outlined | Provenance — solid means both engines saw it, a thin outline means the file graph only, a dashed outline means the symbol graph only |
| Tinted blob | A module and everything it holds |
| Hexagon | Issue. Green open, grey closed |
| Green glow | Frontier issue — open, unblocked, unassigned; ready to pick up |
| Red hexagon outline | Open issue with an open blocker |
| Amber ring | Committed but not pushed |
| Orange double ring | Modified in the working tree |
| Blue ring | Staged |
| Grey dashed ring | Untracked |
| Red ring | Conflicted |
| No ring | Pushed, or not a tracked file |
| Amber ✕ hatch | Summary is stale — written against an older version of the file |
| Red dashed edge | Issue dependency (`blocks`), or an import cycle back-edge |
| Node size | √(total degree) — bigger means more connected. sqrt, not linear: degree runs 0–173 on the reference graph, so linear sizing is an 87:1 radius ratio and one node eats the screen. The previous encoding read a stored weight that ran 1–8 and put 65% of nodes inside a 1.3px band, which made the hub you need to find first draw the same size as a leaf |
| Ring colour on a hop | Impact distance — near hops warm, far hops cool |

A warning banner appears when the git overlay reports no upstream branch, because in that state
everything reads as unpushed and the rings would otherwise be misleading.

## Controls

`/` focuses search · `Esc` clears search or deselects · `f` fits to screen. Search dims
non-matches rather than hiding them, so a match keeps its structural context. Enter jumps to the
top hit. Filters cover node type, git state, and the top 22 tags; they compose.

Hovering a legend row spotlights the matching nodes, so "which ones are those?" is answered by the
graph rather than by matching a swatch by eye. When every node is filtered out the empty canvas
names the control responsible and offers a reset, instead of reading as a broken viewer.

Selection, view, impact mode and the active filters are mirrored into the URL hash, so a
particular view is a link you can paste into a PR. On an opaque origin — a `data:` URL, a
sandboxed frame, some `file://` contexts — `history.replaceState` throws; the first failure
disables the hash quietly and everything else carries on, because a link-sharing convenience must
never be able to break selection.

All motion respects `prefers-reduced-motion`: the ripple shows its settled end state, camera
moves and tab transitions cut rather than tween.

Above roughly 2000 visible nodes the map gets dense — that is what the filters are for. Filtering
to one tag or one git state, or switching to the flow view, is usually more informative than
zooming into the full graph.

## Performance

Measured on a synthetic 5040-node, 9715-edge graph: 20fps while the simulation is running,
0.9ms per frame once it settles, 1.4MB page. The simulation stops on its own, so the steady state
is a static canvas that redraws only on interaction. The flow layout is O(V+E) and computed once.

Node count is the practical limit, not edge count. If a repo produces a graph too dense to read,
the fix is `scope prune`, a tighter `ignore` list in `config.json`, or the viewer's filters — not
a faster renderer.

## Extending it

The template is plain HTML with one inline script and no build step. Colours come from CSS custom
properties at the top and adapt to the viewer's light or dark system theme. To add an encoding:
add the colour to `TYPE_COLOR` or `GIT_COLOR`, draw it in the node loop inside `draw()`, and add a
row to the legend in `buildControls()`. To add a panel section, extend `renderDetail()`.

Keep the no-external-requests property. It is what lets the page work offline, from a file path,
and as a shared Artifact.
