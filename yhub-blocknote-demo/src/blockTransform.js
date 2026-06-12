/* eslint-env browser */
import * as delta from 'lib0/delta'
import { $prosemirrorDelta } from '@y/prosemirror'

/**
 * Userland storage transform for BlockNote (experimental).
 *
 * Maps between BlockNote's ProseMirror representation and a Yjs storage shape
 * that makes the schema's cardinality constraints structural, so suggestions /
 * concurrent edits can't produce schema-invalid `blockContent blockGroup?`
 * content:
 *
 *   1. block-content TYPE  -> `bcType` *attribute* of a generic `blockContentY`
 *      node (a type change becomes an attribute change, not node delete+insert).
 *   2. container NODE NAME carries the content-model CLASS of its block content
 *      (`blockContainer#<contentExpr>`). Same class -> same name -> diff modifies
 *      in place (one node, attr change): e.g. paragraph<->heading<->quote all
 *      stay one block. Different class -> different name -> diff replaces (two
 *      sibling blocks): e.g. heading -> image (atom) renders as a deleted heading
 *      + an inserted image.
 *
 *  The structure is otherwise kept 1:1 with ProseMirror - the nested `blockGroup`
 *  wrapper is preserved, NOT flattened. (An earlier version hoisted children to
 *  flatten the wrapper, which merges concurrent child-adds but makes the Y tree
 *  non-1:1 with PM, so a structural op like unindent + a subsequent type change
 *  produced a misaligned diff -> applyDelta "Unexpected case". Keeping it 1:1 is
 *  far more robust for everyday indent/unindent at the cost of the concurrent-
 *  child-add merge.)
 *
 *  A type change that DROPS an attribute the new type can't hold (paragraph ->
 *  quote drops `textAlignment`) still folds to one node: the binding's
 *  `deltaAttributionToFormat` drops the AM's delete-attributed attr on the kept
 *  node, so the reconcile converges (no loop).
 *
 * NOTE: this changes the Yjs storage format. Use a fresh room, and be aware the
 * backend's activity / version-diff features read the raw Y structure.
 */

/** @type {import('prosemirror-model').Schema | null} */
let schema = null

/** Capture the live editor schema (call before sync starts). */
export const setTransformSchema = (s) => { schema = s }

const CONTAINER = 'blockContainer'

/**
 * Content-model class of a block-content type, from the schema's content
 * expression. Types sharing a content model (paragraph/heading/quote, all
 * `inline*`) fold into one mergeable entity (a `bcType` attribute change); a
 * different content model (image, an atom) gets its own class -> two-block
 * replace. Falls back to the type name so unknown/leaf types stay distinct.
 *
 * Note: types in the same class can still differ in *attributes* (paragraph has
 * `textAlignment`, quote does not). A type change that drops such an attr is
 * fine - `deltaAttributionToFormat` drops the AM's delete-attributed attr on the
 * kept node, so the fold converges (no reconcile loop) without splitting the
 * class.
 *
 * @param {string} typeName
 */
const classOf = (typeName) => (schema && schema.nodes[typeName] && schema.nodes[typeName].spec.content) || ('leaf:' + typeName)

/** @param {string} typeName */
const isBlockContent = (typeName) => {
  const g = schema && schema.nodes[typeName] && schema.nodes[typeName].spec.group
  return g != null && g.split(' ').includes('blockContent')
}

/** @param {string} bcTypeName */
const containerNameFor = (bcTypeName) => CONTAINER + '#' + classOf(bcTypeName)
/** @param {string|null} name */
const isContainer = (name) => typeof name === 'string' && (name === CONTAINER || name.startsWith(CONTAINER + '#'))

/** @param {delta.DeltaAny} d */
const attrsOf = (d) => Object.fromEntries([...d.attrs].map((a) => [a.key, a.value]))

/**
 * @param {delta.DeltaAny} d
 * @returns {Array<{ node?: any, text?: any, format: any }>}
 */
const childEntries = (d) => {
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

/**
 * PM -> Y. Structure is kept 1:1 (the nested `blockGroup` is NOT flattened) so
 * structural ops like indent/unindent map cleanly; only the block-content type
 * is folded into `bcType` and the container is named by content-model class.
 * @param {delta.DeltaAny} d
 * @returns {delta.DeltaAny}
 */
const toStore = (d) => {
  const name = d.name
  const attrs = attrsOf(d)
  if (name != null && isBlockContent(name)) {
    return build('blockContentY', { ...attrs, bcType: name }, childEntries(d))
  }
  if (name === CONTAINER) {
    const es = childEntries(d) // PM: [blockContent, blockGroup?]
    return build(es[0] && es[0].node ? containerNameFor(es[0].node.name) : CONTAINER, attrs,
      es.map((e) => e.node !== undefined ? { node: toStore(e.node), format: e.format } : e))
  }
  return build(name, attrs, childEntries(d).map((e) => e.node !== undefined ? { node: toStore(e.node), format: e.format } : e))
}

/**
 * Y -> PM. Inverse of {@link toStore}: `blockContentY` back to its `bcType`
 * node, any class-named container back to the generic `blockContainer`.
 * @param {delta.DeltaAny} d
 * @returns {delta.DeltaAny}
 */
const toView = (d) => {
  const name = d.name
  const attrs = attrsOf(d)
  if (name === 'blockContentY') {
    const { bcType, ...rest } = attrs
    return build(bcType, rest, childEntries(d))
  }
  return build(isContainer(name) ? CONTAINER : name, attrs,
    childEntries(d).map((e) => e.node !== undefined ? { node: toView(e.node), format: e.format } : e))
}

export const blockTransform = { toStore, toView }
