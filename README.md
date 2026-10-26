# Image Edit for SillyTavern

Edit an image with a saved ComfyUI workflow using `/image-edit`. The command
returns a saved image URL and posts the result to chat by default.

## Install

1. In SillyTavern, open **Extensions → Install Extension** and paste
   `https://github.com/i5031337/st-image-edit`. Install it for your user or for
   all users, then reload SillyTavern.
2. In **Image Generation** settings, configure your **ComfyUI URL**. Image Edit
   uses ComfyUI even if another image generation provider is selected.
3. Export your graph from ComfyUI in **API format** and save it in SillyTavern's
   ComfyUI workflow editor.
   Select it as the active workflow, or pass its filename with `workflow=`.

The graph needs base64 image loaders and whole-string input values:
`%prompt%` (your instruction) and `%reference_image_1%`, `%reference_image_2%`,
etc. (raw base64 bytes), one per reference image. `%reference_image%` is an alias
for `%reference_image_1%`, so existing single-image workflows still work.
There is no fixed reference-count limit: provide a workflow wired for as many
images as you want to supply. Every supplied image must have a placeholder in
the workflow, and every reference placeholder must have a supplied image;
mismatches fail before images are loaded or generation starts. It may
also use `%negative_prompt%`, `%seed%`, `%width%`, and `%height%`. A normal
ComfyUI `LoadImage` node cannot decode `%reference_image%`. A compatible base64
decoder is required; the included example uses `Base64DecodeNode` from
`comfyui-logicutils`. The ST proxy returns the first image output, so expose
only the result you want saved.

## Use

```text
/image-edit reference="/user/images/reference.png" Give her an amused smile.
/image-edit message=12 workflow="Edit.json" chat=false Give her an amused smile.
/image-edit Give her an amused smile.
/image-edit reference="/user/images/person.png" reference="/user/images/outfit.png" workflow="TwoImages.json" Put the person in this outfit.
```

By default, `attached=true` uses all images currently attached to the message
composer in attachment order, before sending. If no image is attached, it falls back to
`message={{lastMessageID}}`, the last message in the current chat. Image selection
fails if neither has an image; it does not search earlier messages.
Use `attached=false` to skip the composer. To select an explicit source, supply
`reference=` (a same-origin image URL or PNG/JPEG/WebP base64 data URL) or
`message=` (a zero-based ID of a chat message with an image attachment).
An explicit source overrides the default composer selection.
Repeat `reference=` to supply multiple URLs, or repeat `message=` to take one
selected image from each specified message, in argument order. Each message
uses its selected gallery image (or first image if the selection is not an
image). Composer images use attachment order; non-image files are ignored.
The original composer attachments stay unchanged. `workflow=` defaults to the active ComfyUI workflow. Optional
arguments are `prompt="..."` instead of trailing text, `negative="..."`,
`seed=12345`, `width=704`, `height=1280`, and `chat=false`. Dimensions fill
placeholders only; literal dimensions in the graph stay as they are. The
extension imposes no reference file-size limit. Large images remain subject to
browser memory and SillyTavern/ComfyUI request limits; base64 encoding increases
the transferred size by about one third.

The command returns a `/user/images/image-edit/...` URL and posts the result to
chat (`chat=true` by default). Use `chat=false` to save and return the URL only.
The original reference stays unchanged. Before sending a PNG reference to
ComfyUI, the extension removes text metadata from the transmitted copy to avoid
nesting previous workflows and base64 references inside each new output. Pixel
data, transparency, and color profiles are preserved without recompression.
JPEG and WebP references pass through unchanged. Generated outputs retain the
metadata supplied by ComfyUI, including the most recent workflow.

Other extensions can import the same function:

```js
const { edit } = await import('/scripts/extensions/third-party/st-image-edit/index.js');
const url = await edit({
    reference: '/user/images/reference.png', // also accepts Blob/File or data URL
    prompt: 'Keep the outfit; change the expression to amused.',
    workflow: 'Edit.json', // optional
});
```

For multiple inputs, pass `references: [urlOrBlob1, urlOrBlob2, ...]` instead of
`reference`. An array in `reference` also works. Do not supply both fields.
The array order maps to the numbered placeholders; the array is copied when
the job is accepted so later caller changes do not alter queued jobs.

That import path assumes the extension is installed for all users under the
`st-image-edit` folder. Per-user installations have a different served path.

## Included example workflow

[`workflows/flux2_9b_edit.json`](workflows/flux2_9b_edit.json) is a single-reference API-format
Flux.2 Klein 9B edit graph. Its sampling, reference conditioning, and image
output use ComfyUI core nodes. It needs one custom node, `Base64DecodeNode` from
`comfyui-logicutils`, to receive the reference image. It also needs these model
files: `flux-2-klein-9b-kv-fp8.safetensors`, `qwen_3_8b_fp8mixed.safetensors`,
and `flux2-vae.safetensors`. Change the filenames in the graph if yours differ.
Upload the API-format file through SillyTavern's ComfyUI workflow editor.
Then try:

```text
/image-edit reference="/user/images/reference.png" workflow="flux2_9b_edit.json" Give her an amused smile.
```

This graph scales the reference to about one megapixel and uses that size for
the result. It has no `%width%` or `%height%` inputs. The model can still change
pose, framing, clothing, and other details.

### Two-reference example

[`workflows/flux2_9b_edit_2ref.json`](workflows/flux2_9b_edit_2ref.json) uses the
same models, custom decoder, and sampling settings with two reference images.
Import it through SillyTavern's ComfyUI workflow editor, then attach two images
and run:

```text
/image-edit workflow="flux2_9b_edit_2ref.json" Put the person from image 1 in the outfit from image 2.
```

Or supply two explicit URLs:

```text
/image-edit reference="/user/images/person.png" reference="/user/images/outfit.png" workflow="flux2_9b_edit_2ref.json" Put the person from image 1 in the outfit from image 2.
```

Both references are independently scaled to about one megapixel and encoded
with the same VAE. Both feed the positive and negative reference conditioning
chains, in image order. Output dimensions come from the scaled first image.
This workflow requires exactly two references and uses more memory than the
single-reference example.

## Privacy and limits

SillyTavern sends the reference image and prompt to your configured ComfyUI
server. If that server is remote, its operator can receive those inputs. Outputs
are saved under SillyTavern's user images and are not automatically deleted.
Cancellation discards the result but lets an active ComfyUI request finish.

Run `npm test` for the unit tests; they use a mocked backend and do not generate
images. Licensed under [MIT](LICENSE).
