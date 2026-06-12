import { useCreateBlockNote } from '@blocknote/react'
import { createExtension } from '@blocknote/core'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import { syncPlugin, yCursorPlugin } from '@y/prosemirror'
import { useEffect } from 'react'
import { yhub, mapAttributionToMark } from './yhub.js'
import { blockTransform, setTransformSchema } from './blockTransform.js'

const YSyncExtension = createExtension(() => ({
  key: 'ySync',
  prosemirrorPlugins: [syncPlugin({ mapAttributionToMark, transform: blockTransform })]
}))

const YCursorExtension = createExtension(() => ({
  key: 'yCursor',
  prosemirrorPlugins: [yCursorPlugin(yhub.provider.awareness)]
}))

export default function Editor () {
  const editor = useCreateBlockNote({
    extensions: [
      YSyncExtension(),
      YCursorExtension()
    ]
  })

  useEffect(() => {
    const view = editor?._tiptapEditor?.view
    if (view) {
      // The transform's `classOf` needs the live schema; capture it before sync
      // starts (attachView -> configureYProsemirror, which runs the transform).
      setTransformSchema(view.state.schema)
      yhub.attachView(view)
    }
    return () => yhub.detachView()
  }, [editor])

  return <BlockNoteView editor={editor} theme='light' />
}
