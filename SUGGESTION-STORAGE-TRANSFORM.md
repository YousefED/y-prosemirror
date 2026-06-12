# Schema-decoupled suggestion storage (the `transform` hook)

---

## 1. The problem

BlockNote's schema is strict:

```
doc            -> blockGroup
blockGroup     -> blockContainer+
blockContainer -> blockContent blockGroup?        // exactly one blockContent
blockContent   = paragraph | heading | quote | image | table | ...
```

A suggestion that **changes a block's type** (e.g. paragraph → heading) is, in
the default 1:1 PM↔Y mapping, a _node replace_: the old `blockContent` is kept
as a deletion tombstone **and** the new one is inserted, side by side, inside
one `blockContainer`. That's **two `blockContent`s in one container** —
forbidden by `blockContent blockGroup?`, so the render throws.

Concurrent edits hit a sibling of this: two users each adding a first child to
the same block independently create two `blockGroup` wrappers → also invalid.

The root cause in both cases: **schema-cardinality-constrained structure is
encoded as duplicable CRDT nodes** (the type as a node _name_, the children
wrapper as a `blockGroup` _node_), and suggestions/concurrency duplicate them.

---

## 2. What we built (high level)

1. **A userland `transform` hook on `syncPlugin`** — a bijective pair of delta
   rewrites that lets the **Yjs storage representation differ from the
   ProseMirror representation**. The editor still renders BlockNote's exact
   schema; only what's _stored_ changes. (Library, generic, identity by default.)

2. **A fix in `deltaAttributionToFormat`** — the attribution manager re-surfaces
   a _removed_ attribute (from `base`) as a live attr with a `delete`
   attribution. On an otherwise-kept node that's not a live attr; surfacing it
   caused a reconcile loop. We now drop it (but keep attrs on whole-node
   tombstones). This is general, not transform-specific.

3. **An example BlockNote transform** (`blockTransform.js`) that uses the hook to
   make type changes _attribute_ changes and route incompatible changes to a
   clean two-block representation.

---

## 3. How the architecture works

### 3.1 The hook

```js
syncPlugin({
  transform: {
    toStore: (pmDelta) => yDelta, // PM representation  -> Y storage representation
    toView: (yDelta) => pmDelta, // Y storage representation -> PM representation (inverse)
  },
});
```

`toStore`/`toView` are inverse delta→delta functions. The binding applies them at
the boundaries it already produces/consumes deltas:

- **Y → PM (render):** `toView(deltaAttributionToFormat(ytype.toDeltaDeep(am)))`
  — applied in every render path (the `afterTransaction` and AM-`change`
  handlers, the `view.update` reconcile, and `configureYProsemirror`).
- **PM → Y (write):** `toStore(nodeToDelta(view.state.doc, canonicalize))` — the
  PM→Y diff is computed in the **Y representation**.

Default is `identityTransform` (`toStore(x) === toView(x) === x`), so existing
behavior is byte-for-byte unchanged when no transform is given.
`configureYProsemirror` reads the transform off the plugin state, so wiring it
into `syncPlugin` is the only integration step.

### 3.2 The example BlockNote transform — two ideas

**(a) Block type → attribute.** Every block-content node (`paragraph`,
`heading`, …) is stored as a generic `blockContentY` node whose type is the
`bcType` **attribute**:

```
PM:  blockContainer > heading{level:2} "hi"
Y:   blockContainer#inline* > blockContentY{ bcType:"heading", level:2 } "hi"
```

A type change is then a `bcType` **attribute change** in Y — no node
delete+insert, so a single container never holds two `blockContent`s. The
suggestion is one block whose attribute changed.

**(b) Container name carries the content-model _class_.** The container node is
named `blockContainer#<contentExpr>` (the block-content's schema content
expression):

- **Same class → same container name** → the diff `modify`s in place (one node):
  `paragraph ↔ heading ↔ quote` (all `inline*`) stay **one block**.
- **Different class → different name** → the diff _replaces_ (two sibling
  blocks): `heading → image` (`inline*` vs atom) renders as a **deleted heading
  block + an inserted image block**.

This re-uses lib0's fundamental diff rule (same name → descend/modify; different
name → replace) to get the right granularity for free, with **no schema change**
to `blockContainer` (each rendered container still has exactly one
`blockContent`).

Why class = content expression, not the type name: types sharing a content model
have _interchangeable, mergeable_ content, so folding them into one entity is
required for **merge correctness** (a concurrent text edit during a type change
must merge, not land on a tombstone). This is a data fact derived from the
schema, not a visualization choice.

### 3.3 The `deltaAttributionToFormat` fix

`toDeltaDeep(am)` renders the branch _diffed against base_. For an attribute that
was **removed** in the branch (e.g. `paragraph → quote` drops `textAlignment`,
which `quote` can't hold), the AM re-adds it as a live attr carrying its old
value plus a `delete` attribution — to _visualize_ the removal. But the rendered
`quote` can't hold it, so PM drops it, the PM→Y diff re-issues the deletion, the
AM re-surfaces it → **infinite reconcile loop**.

Fix: `deltaAttributionToFormat` does **not** surface an attribute whose
attribution is `delete` **on an otherwise-kept node** — it's not a live attr of
the suggested node. Crucially it threads a `nodeDeleted` flag so a _whole node
tombstone_ (a deleted block) still keeps its attrs (they're part of what's
rendered). Without that distinction, deleted blocks lose `bcType`/`level` and
fail to render.

---

## 4. The cases (decision matrix)

| change                                           | content class                 | attrs                          | result                                                                     | visualized?                                                       |
| ------------------------------------------------ | ----------------------------- | ------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **paragraph → heading**                          | same (`inline*`)              | _adds_ `level`/`isToggleable`  | **one block**, `bcType` attr change                                        | ⚠️ only as the new type — the attr change itself is not marked    |
| **heading → paragraph**                          | same                          | _drops_ `level`/`isToggleable` | **one block**; `deltaAttributionToFormat` drops the orphan attrs (no loop) | ⚠️ same                                                           |
| **paragraph → quote**                            | same                          | _drops_ `textAlignment`        | **one block** (same as above)                                              | ⚠️ same                                                           |
| **image `src` change** (image → image)           | same                          | attr change                    | **one block**, `src` attr change                                           | ❌ not visible — see §5.1; needs NodeView/mark to show old vs new |
| **image → heading** / **heading → image**        | different (atom vs `inline*`) | n/a                            | **two sibling blocks**: deleted old + inserted new                         | ✅ node-level insert/delete marks                                 |
| **concurrent child-add** (two peers, same block) | —                             | —                              | **two `blockGroup`s** → invalid                                            | ❌ open (§5.3)                                                    |

The unifying rule: **fold to a one-node attr change only when old and new share a
content model**; otherwise it's a content replacement → two blocks. Attribute
_drops_ within a class are handled by the `deltaAttributionToFormat` fix. The
"two blocks" path is also where the _deleted_ block stays a real, editable node
(its content/attrs live on the tombstone), which the one-node path can't offer.

---

## 5. Caveats & open cases (tangible)

### 5.1 Attribute-level suggestions are invisible

A one-node type change (paragraph→heading) or `image src` change renders only the
**new** state; the suggestion isn't marked, because `deltaAttributionToFormat`
turns attribution on _content_ into marks but **not attribution on attrs**. To
show "type changed p→h" or "old image / new image", we need to surface
attribute-level attribution as a `y-attributed-format` **node mark carrying
{from,to}** (and a NodeView to render it — e.g. old image stacked above new).
This is the main missing primitive; it's also what would let `image src` show a
before/after. (Note: this is _visualization_ only — accept/reject already work,
because the old value lives on `base`.)

### 5.2 The parent must allow the attribution marks

When a _whole block_ is deleted/inserted as a suggestion (the two-block path), the
attribution lands as a node mark on the `blockContainer`. ProseMirror's
`checkContent` validates a node's marks **against its parent**, so `blockGroup`
(and `blockContainer`) must whitelist `y-attributed-*`. This is the standard
"allow the marks where attribution can land" rule, extended up the nesting. It is
_not_ a content-model change.

### 5.3 Concurrent child-add → two `blockGroup`s (unfixed)

Two peers each adding a first child to the same childless block independently
create two `blockGroup` nodes → invalid. The flatten approach fixed this (store
children directly, synthesize one `blockGroup` at render) but made the tree
non-1:1 and broke structural ops, so it was **removed**. This case is
currently unhandled. A proper fix is the keyed/structured model (§6) where the
children container is a single named slot.

### 5.4 Per-type attribute schemas

Types in the same content class can declare **different attrs** (`paragraph` has
`textAlignment`, `quote` doesn't; `heading` adds `level`, `isToggleable`). A type
change across such a pair drops/adds attrs. Adds are fine; drops are handled by
§3.3. This is why classing by content expression (not by attr set) is correct —
but it means the `deltaAttributionToFormat` fix is load-bearing for the common
type changes, not optional.

### 5.5 External Yjs edits / version diffs

The transform is applied on the binding's own render/write paths. A pre-existing
document, an external/LLM write, or a snapshot version-diff that produced the
_old_ (un-transformed) storage shape will not round-trip. **Use a fresh room.**
The backend's activity/version/rollback features read the raw Y structure, which
is now the transformed shape.

### 5.6 Storage format change / migration

This changes the Yjs document format (generic `blockContentY`, class-named
containers). Existing documents need migration; mixed old/new data in one room
will misrender.

---

## 6. Where this is heading (the "right" model)

The cleanest long-term storage is a **structured/keyed record** per block —
roughly BlockNote's own block JSON:

```
block = { type, props, content(Y.Text sequence), children(Y.Array) }
```

Named slots make both cardinalities _structural_ (one `content`, one `children`),
each field gets the correct CRDT semantics (LWW type, mergeable text, mergeable
children), and `@y/y`'s unified `YType` + attribution already support it. It
would subsume the transform's wins **and** §5.3, but it's a from-the-foundation
structured binding (manage nested keyed types, new position mapping), not a
userland delta transform — see the discussion in chat. The `transform` hook is
the pragmatic step that works on today's sequence-tree binding.

---

## 7. Files changed

Library (generic, shippable):

- `src/sync-utils.js` — `YpmTransform` typedef + `identityTransform`; the
  `deltaAttributionToFormat` `delete`-attr fix (§3.3).
- `src/sync-plugin.js` — `transform` plugin option/state; `toStore`/`toView`
  applied on the PM→Y and Y→PM paths.
- `src/commands.js` — `configureYProsemirror` applies `toView`.
- `global.d.ts` — global `YpmTransform` type.

Tests:

- `tests/transform.test.js` — seed/round-trip, type-change-is-attr-change,
  accept/reject, same-class concurrent merge, cross-class two-block,
  drop-attr-folds (the §3.3 regression). 120 tests pass.

Demo (experimental example):

- `yhub-blocknote-demo/src/blockTransform.js` — the BlockNote transform
  (type→attr + class-named containers, 1:1 structure).
- `yhub-blocknote-demo/src/Editor.jsx` — wires `transform` into `syncPlugin`,
  captures the schema before sync.
