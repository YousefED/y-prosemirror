import * as t from "lib0/testing.js";
import * as prng from "lib0/prng.js";
import * as math from "lib0/math.js";
import * as Y from "yjs";
import { applyRandomTests } from "yjs/tests/testHelper.js";

import {
  ySyncPlugin,
  prosemirrorJSONToYDoc,
  yDocToProsemirrorJSON,
} from "../src/y-prosemirror.js";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import * as basicSchema from "prosemirror-schema-basic";
import { findWrapping } from "prosemirror-transform";
import { schema as complexSchema } from "./complexSchema.js";

const schema = /** @type {any} */ (basicSchema.schema);

/**
 * @param {t.TestCase} tc
 */
export const testEmptyNotSync = (tc) => {
  const ydocSub = new Y.Doc();
  const xmlSub = ydocSub.getXmlFragment("xml");
  const xmlSubEl = new Y.XmlElement("paragraph");
  xmlSubEl.insert(0, [new Y.XmlText("hello")]);
  xmlSub.insert(0, [xmlSubEl]);

  const ydoc = new Y.Doc();
  const type = ydoc.getXmlFragment("prosemirror");
  t.assert(type.toString() === "", "should only sync after first change");

  const view = createNewComplexProsemirrorView(ydoc, async (el) => {
    return xmlSubEl;
  });
  view.dispatch(
    view.state.tr.setNodeMarkup(0, undefined, {
      checked: true,
    })
  );

  // const ref = new Y.XmlElement("ref");
  // ref.insert(0, [new Y.XmlText()]);
  // const xmlEl = new Y.XmlElement("paragraph");
  // xmlEl.insert(0, [new Y.XmlText("hi")]);
  // type.insert(0, [ref, xmlEl]);

  // type.insert(0, [xmlEl]);
  // await new Promise((resolve) => setTimeout(resolve, 1000));

  const json = view.state.toJSON();
  t.compareStrings(
    type.toString(),
    '<custom checked="true"></custom><paragraph></paragraph><ref></ref>'
  );
  setTimeout(() => {
    let json = view.state.toJSON();
    const t = type.toString();
    let pos;
    view.state.doc.descendants((node, nodePos) => {
      if (node.text === "hello") {
        console.log(node, nodePos);
        pos = nodePos;
      }
    });
    view.dispatch(
      view.state.tr.addMark(
        pos,
        pos + 3,
        view.state.schema.marks.strong.instance
      )
    );
    json = view.state.toJSON();
  }, 2000);
};

const createNewComplexProsemirrorView = (y, resolveRef) => {
  const view = new EditorView(null, {
    // @ts-ignore
    state: EditorState.create({
      schema: complexSchema,
      plugins: [ySyncPlugin(y.get("prosemirror", Y.XmlFragment), resolveRef)],
    }),
  });
  return view;
};
