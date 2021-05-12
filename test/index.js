import * as prosemirror from "./y-prosemirrorSub.test.js";

import { runTests } from "lib0/testing.js";
import { isBrowser, isNode } from "lib0/environment.js";
import * as log from "lib0/logging.js";

if (isBrowser) {
  log.createVConsole(document.body);
}
runTests({
  prosemirror,
}).then((success) => {
  /* istanbul ignore next */
  if (isNode) {
    // process.exit(success ? 0 : 1);
  }
});
