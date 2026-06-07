import * as YPM from '@y/prosemirror'
import * as Y from '@y/y'
import * as delta from 'lib0/delta'
import * as t from 'lib0/testing'
import { Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { marks } from './complexSchema.js'
import { setupTwoWaySync } from './cohort.js'
import { $prosemirrorDelta } from '@y/prosemirror'

/* -------------------------------------------------------------------------- *
 *  Userland storage transform: structured block storage, schema-derived.
 *
 *  Exercises the `transform` option of `syncPlugin` - a bijective pair of delta
 *  rewrites between the ProseMirror representation and the Yjs representation,
 *  configured entirely in userland. It makes the cardinality constraints of a
 *  STRICT BlockNote-like `blockContent blockGroup?` schema *structural in
 *  storage* instead of encoded as duplicable nodes:
 *
 *   1. Block TYPE -> the `bcType` *attribute* of a generic `blockContentY` node
 *      (not the node name). A type change is an attribute change in Y.
 *   2. Nested `blockGroup` WRAPPER -> flattened: a block's children are stored
 *      directly as its trailing children; the single `blockGroup` is rebuilt at
 *      render. (Concurrent child-adds append to one sequence -> merge.)
 *   3. The container NODE NAME carries the *content-model class* of its block
 *      content, derived straight from the schema's content expressions
 *      (`classOf`). Same class -> same container name -> the diff `modify`s in
 *      place (one node, attr change). Different class -> different container
 *      name -> the diff replaces (two sibling blocks).
 *
 *  Point 3 is what makes the storage split a *function of the schema* (a data /
 *  merge-correctness fact), not a visualization choice: types whose content is
 *  interchangeable fold into one mergeable entity; types whose content is not
 *  stay distinct, so a change between them is a whole-block replace.
 * -------------------------------------------------------------------------- */

const attributionMarks = 'y-attributed-insert y-attributed-delete y-attributed-format'

const schema = new Schema({
  nodes: {
    doc: { content: 'blockGroup' },
    blockGroup: { content: 'blockContainer+', marks: attributionMarks, toDOM () { return ['div', { class: 'bg' }, 0] } },
    blockContainer: { content: 'blockContent blockGroup?', group: 'bc', marks: attributionMarks, toDOM () { return ['div', { class: 'bc' }, 0] } },
    paragraph: { content: 'inline*', group: 'blockContent', marks: attributionMarks, toDOM () { return ['p', 0] } },
    heading: { content: 'inline*', group: 'blockContent', marks: attributionMarks, attrs: { level: { default: 1 } }, toDOM (n) { return ['h' + n.attrs.level, 0] } },
    image: { group: 'blockContent', atom: true, marks: attributionMarks, attrs: { src: { default: '' } }, toDOM (n) { return ['img', { src: n.attrs.src }] } },
    text: { group: 'inline' }
  },
  marks
})

// --- generic delta helpers used by the transform -----------------------------

/** @param {delta.DeltaAny} d */
const attrsOf = d => Object.fromEntries([...d.attrs].map(a => [a.key, a.value]))

/**
 * Ordered child entries of a content delta: `{ node }` for block children,
 * `{ text }` for inline text. Carries each op's `format` so marks survive.
 * @param {delta.DeltaAny} d
 */
const childEntries = d => {
  /** @type {Array<{ node?: any, text?: any, format: any }>} */
  const out = []
  for (const op of d.children) {
    if (delta.$insertOp.check(op)) {
      for (const it of op.insert) out.push(delta.$deltaAny.check(it) ? { node: it, format: op.format } : { text: it, format: op.format })
    } else if (delta.$textOp.check(op)) {
      out.push({ text: op.insert, format: op.format })
    }
  }
  return out
}

/**
 * @param {string|null} name
 * @param {Record<string, any>} attrs
 * @param {Array<{ node?: any, text?: any, format?: any }>} entries
 */
const build = (name, attrs, entries) => {
  const o = /** @type {any} */ (delta.create(name, $prosemirrorDelta))
  o.setAttrs(attrs)
  for (const e of entries) {
    if (e.node !== undefined) o.insert([e.node], e.format)
    else o.insert(e.text, e.format)
  }
  return o.done(false)
}

// --- schema-derived class + the userland transform ---------------------------

const CONTAINER = 'blockContainer'

/**
 * Content-model class of a block-content type, taken straight from the schema's
 * content expression. Two types with the same expression (e.g. paragraph and
 * heading, both `inline*`) share a class -> their content is interchangeable
 * and merges; an atom like `image` (no content) is its own class.
 * @param {string} typeName
 */
const classOf = typeName => (schema.nodes[typeName] && schema.nodes[typeName].spec.content) || 'leaf'

/** @param {string} typeName */
const isBlockContent = typeName => {
  const g = schema.nodes[typeName] && schema.nodes[typeName].spec.group
  return g != null && g.split(' ').includes('blockContent')
}

/**
 * Y container node name, suffixed with the content-model class of its content.
 * @param {string} bcTypeName
 */
const containerNameFor = bcTypeName => CONTAINER + '#' + classOf(bcTypeName)
/** @param {string|null} name */
const isContainer = name => typeof name === 'string' && (name === CONTAINER || name.startsWith(CONTAINER + '#'))

/**
 * PM -> Y: block-content type into `bcType`; container named by content-model
 * class; nested `blockGroup` unwrapped (children hoisted).
 * @param {delta.DeltaAny} d
 * @returns {delta.DeltaAny}
 */
const toStore = d => {
  const name = d.name
  const attrs = attrsOf(d)
  if (name != null && isBlockContent(name)) {
    return build('blockContentY', { ...attrs, bcType: name }, childEntries(d))
  }
  if (name === CONTAINER) {
    const es = childEntries(d) // PM: [blockContent, blockGroup?]
    const kids = [{ node: toStore(es[0].node), format: es[0].format }]
    if (es[1] && es[1].node && es[1].node.name === 'blockGroup') {
      for (const c of childEntries(es[1].node)) kids.push({ node: toStore(c.node), format: c.format })
    }
    return build(containerNameFor(es[0].node.name), attrs, kids)
  }
  return build(name, attrs, childEntries(d).map(e => e.node !== undefined ? { node: toStore(e.node), format: e.format } : e))
}

/**
 * Y -> PM: `bcType` back to a node name; any class-named container back to the
 * generic `blockContainer`; trailing children re-wrapped in one `blockGroup`.
 * @param {delta.DeltaAny} d
 * @returns {delta.DeltaAny}
 */
const toView = d => {
  const name = d.name
  const attrs = attrsOf(d)
  if (name === 'blockContentY') {
    const { bcType, ...rest } = attrs
    return build(bcType, rest, childEntries(d))
  }
  if (isContainer(name)) {
    const es = childEntries(d) // Y: [blockContentY, ...childContainers]
    const kids = [{ node: toView(es[0].node), format: es[0].format }]
    const rest = es.slice(1)
    if (rest.length) kids.push({ node: build('blockGroup', {}, rest.map(c => ({ node: toView(c.node), format: c.format }))), format: null })
    return build(CONTAINER, attrs, kids)
  }
  return build(name, attrs, childEntries(d).map(e => e.node !== undefined ? { node: toView(e.node), format: e.format } : e))
}

/** @type {YpmTransform} */
const blockTransform = { toStore, toView }

/**
 * @param {import('prosemirror-model').Node} doc
 * @param {object} expected
 * @param {string} message
 */
const assertDocJSON = (doc, expected, message) => {
  t.compare(JSON.parse(JSON.stringify(doc.toJSON())), expected, message)
}

/**
 * @param {Y.Type} ytype
 * @param {Y.AbstractAttributionManager} [am]
 */
const mkView = (ytype, am = Y.noAttributionsManager) => {
  const view = new EditorView(
    { mount: document.createElement('div') },
    { state: EditorState.create({ schema, plugins: [YPM.syncPlugin({ transform: blockTransform })] }) }
  )
  YPM.configureYProsemirror({ ytype, attributionManager: am })(view.state, view.dispatch)
  return view
}

/**
 * doc>blockGroup>blockContainer>type(text), authored in the Y (storage) shape.
 * @param {string} text
 * @param {string} [type]
 * @param {Record<string, any>} [attrs]
 */
const seedStore = (text, type = 'paragraph', attrs = {}) => blockTransform.toStore(
  delta.create().insert([
    delta.create('blockGroup', {}, [delta.create('blockContainer', {}, [delta.create(type, attrs, text)])])
  ]).done()
)

/**
 * Build the base / viewer / editor suggestion trio, seeded with one block.
 * @param {string} [seedType]
 * @param {Record<string, any>} [seedAttrs]
 */
const setup = (seedType = 'paragraph', seedAttrs = {}) => {
  const doc = new Y.Doc({ gc: false, guid: 'base' })
  const suggestionDoc = new Y.Doc({ isSuggestionDoc: true, gc: false, guid: 'suggestions' })
  const suggestionModeDoc = new Y.Doc({ isSuggestionDoc: true, gc: false, guid: 'suggestions-edit' })
  const attrs = new Y.Attributions()
  const suggestionAM = Y.createAttributionManagerFromDiff(doc, suggestionDoc, { attrs })
  suggestionAM.suggestionMode = false
  const suggestionModeAM = Y.createAttributionManagerFromDiff(doc, suggestionModeDoc, { attrs })
  suggestionModeAM.suggestionMode = true
  setupTwoWaySync(suggestionDoc, suggestionModeDoc)
  doc.get('prosemirror').applyDelta(seedStore('child', seedType, seedAttrs))
  const base = mkView(doc.get('prosemirror'))
  const viewer = mkView(suggestionDoc.get('prosemirror'), suggestionAM)
  const editor = mkView(suggestionModeDoc.get('prosemirror'), suggestionModeAM)
  return { doc, suggestionModeDoc, suggestionModeAM, base, viewer, editor }
}

const para = { type: 'doc', content: [{ type: 'blockGroup', content: [{ type: 'blockContainer', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'child' }] }] }] }] }
const heading = { type: 'doc', content: [{ type: 'blockGroup', content: [{ type: 'blockContainer', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'child' }] }] }] }] }

/**
 * Seed renders as PM `paragraph`; Y stores the type as `bcType` on a generic
 * node, and the container name carries the content-model class.
 * @param {t.TestCase} _tc
 */
export const testTransformSeedSyncs = _tc => {
  const { doc, base, viewer, editor } = setup()
  assertDocJSON(base.state.doc, para, 'base: renders paragraph')
  assertDocJSON(viewer.state.doc, para, 'viewer: renders paragraph')
  assertDocJSON(editor.state.doc, para, 'editor: renders paragraph')
  const yjson = JSON.stringify(doc.get('prosemirror').toDelta(Y.noAttributionsManager, { deep: true }).toJSON())
  t.assert(yjson.includes('blockContentY'), 'Y stores the generic block-content node')
  t.assert(yjson.includes('"bcType"'), 'Y stores the type as the bcType attribute')
  t.assert(yjson.includes('blockContainer#inline*'), 'Y container name carries the content-model class')
}

/**
 * Same-class type change (paragraph -> heading) is a one-node attribute change.
 * @param {t.TestCase} _tc
 */
export const testTransformTypeChangeIsAttrChange = _tc => {
  const { base, viewer, editor } = setup()
  editor.dispatch(editor.state.tr.setNodeMarkup(2, schema.nodes.heading, { level: 2 }))
  assertDocJSON(base.state.doc, para, 'base: unchanged paragraph')
  assertDocJSON(editor.state.doc, heading, 'editor: suggested heading, one blockContent')
  assertDocJSON(viewer.state.doc, heading, 'viewer: suggested heading, one blockContent')
  for (const v of [base, viewer, editor]) {
    t.assert(v.state.doc.child(0).childCount === 1, 'blockGroup still holds exactly one blockContainer')
  }
}

/** @param {t.TestCase} _tc */
export const testTransformAccept = _tc => {
  const { base, viewer, editor } = setup()
  editor.dispatch(editor.state.tr.setNodeMarkup(2, schema.nodes.heading, { level: 2 }))
  YPM.acceptAllChanges()(viewer.state, viewer.dispatch)
  assertDocJSON(base.state.doc, heading, 'base: heading committed')
  assertDocJSON(viewer.state.doc, heading, 'viewer: heading')
  assertDocJSON(editor.state.doc, heading, 'editor: heading')
}

/** @param {t.TestCase} _tc */
export const testTransformReject = _tc => {
  const { base, viewer, editor } = setup()
  editor.dispatch(editor.state.tr.setNodeMarkup(2, schema.nodes.heading, { level: 2 }))
  YPM.rejectAllChanges()(viewer.state, viewer.dispatch)
  assertDocJSON(base.state.doc, para, 'base: paragraph restored')
  assertDocJSON(viewer.state.doc, para, 'viewer: paragraph')
  assertDocJSON(editor.state.doc, para, 'editor: paragraph')
}

/**
 * SAME content-model class -> one mergeable entity. Two offline peers edit the
 * same block: one changes its type (paragraph -> heading), the other types more
 * text. Because the type lives in an attr on a single `blockContentY` (whose
 * text is one sequence), both edits target the same entity and the CRDT merges
 * them - neither is lost. (Stored unfolded, the type change would replace the
 * entity and the concurrent text edit would be orphaned on the tombstone.)
 *
 * @param {t.TestCase} _tc
 */
export const testTransformSameClassConcurrentMerge = _tc => {
  const docA = new Y.Doc({ gc: false, guid: 'g' })
  docA.get('prosemirror').applyDelta(seedStore('hello'))
  const docB = new Y.Doc({ gc: false, guid: 'g' })
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA)) // share the block; NOT live-synced

  const a = mkView(docA.get('prosemirror'))
  const b = mkView(docB.get('prosemirror'))

  // A: paragraph -> heading (same content class). B: append " world" (text at pos 8, after "hello").
  a.dispatch(a.state.tr.setNodeMarkup(2, schema.nodes.heading, { level: 1 }))
  b.dispatch(b.state.tr.insertText(' world', 8))

  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))

  const expected = { type: 'doc', content: [{ type: 'blockGroup', content: [{ type: 'blockContainer', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'hello world' }] }] }] }] }
  assertDocJSON(a.state.doc, expected, 'A: type change + concurrent text edit both survive')
  t.compare(a.state.doc.toJSON(), b.state.doc.toJSON(), 'peers converge')
}

/**
 * DIFFERENT content-model class -> whole-block replace. Changing a heading
 * (`inline*`) to an image (atom) crosses content classes, so in suggestion mode
 * it renders as TWO sibling blocks: the old heading as a deleted block (still a
 * real, cursor-addressable node) and the new image as an inserted block - not a
 * lossy in-place attr update. base (no attribution) stays the heading.
 *
 * @param {t.TestCase} _tc
 */
export const testTransformCrossClassReplacesWholeBlock = _tc => {
  const { base, viewer, editor } = setup('heading', { level: 1 })

  // image's content model differs from heading's, so this is a content replace,
  // not a setNodeMarkup. Replace the block-content (heading) at pos 2.
  const content = editor.state.doc.child(0).child(0).child(0)
  editor.dispatch(editor.state.tr.replaceWith(2, 2 + content.nodeSize, schema.nodes.image.create({ src: 'x.png' })))

  // base (no attribution) is untouched - still a single heading block.
  t.assert(base.state.doc.child(0).childCount === 1, 'base: still one block')
  t.assert(base.state.doc.child(0).child(0).child(0).type.name === 'heading', 'base: still a heading')

  // editor & viewer: two sibling blockContainers - the deleted heading and the inserted image.
  for (const v of [viewer, editor]) {
    const bg = v.state.doc.child(0)
    t.assert(bg.childCount === 2, 'two sibling blockContainers (deleted heading + inserted image)')
    const innerTypes = [bg.child(0).child(0).type.name, bg.child(1).child(0).type.name]
    t.assert(innerTypes.includes('heading'), 'deleted block keeps a real, editable heading node')
    t.assert(innerTypes.includes('image'), 'inserted block is the image')
  }
}

/**
 * Drop-attr type change within a class folds to one node and does NOT loop.
 *
 * `heading` declares `level`; `paragraph` does not. Changing heading -> paragraph
 * (same content class -> folded into one `blockContentY`) DROPS `level`. The
 * attribution manager re-surfaces the removed `level` (it lives on `base`) as a
 * delete-attributed attr; if the binding rendered it as a live attr on the kept
 * paragraph, the PM->Y diff would re-issue its deletion forever (reconcile
 * loop). `deltaAttributionToFormat` must drop that delete-attributed attr on the
 * kept node - this test pins that: one paragraph block, peers converge, no hang.
 *
 * @param {t.TestCase} _tc
 */
export const testTransformDropAttrTypeChangeFolds = _tc => {
  const { base, viewer, editor } = setup('heading', { level: 2 })

  // heading -> paragraph (same content class); paragraph can't hold `level`.
  editor.dispatch(editor.state.tr.setNodeMarkup(2, schema.nodes.paragraph))

  // base (no attribution) keeps the original heading (with its level).
  assertDocJSON(base.state.doc, { type: 'doc', content: [{ type: 'blockGroup', content: [{ type: 'blockContainer', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'child' }] }] }] }] }, 'base: original heading')

  // editor & viewer: one folded paragraph block (the dropped `level` is gone, not looping).
  const para1 = { type: 'doc', content: [{ type: 'blockGroup', content: [{ type: 'blockContainer', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'child' }] }] }] }] }
  assertDocJSON(editor.state.doc, para1, 'editor: folded into one paragraph block')
  assertDocJSON(viewer.state.doc, para1, 'viewer: folded into one paragraph block')
}
