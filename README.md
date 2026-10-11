# Image Edit

A small SillyTavern extension with one command. Send an arbitrary reference to a
saved ComfyUI editing workflow and receive a saved image URL. Quiet by default,
with optional chat posting. No avatar changes, prompt rewriting, settings panel,
or build step.

## Setup

1. Enable this extension and reload SillyTavern.
2. Set the **ComfyUI URL** in SillyTavern's Image Generation settings. The tool
   always uses ComfyUI, irrespective of the selected image-generation provider.
3. Save your editing workflow in ST's ComfyUI workflow editor. Export it from
   ComfyUI in **API format**, then prepare its placeholders as described below.

## Command

```text
/image-edit reference="/user/images/reference.png" workflow="Edit.json" Give her an amused smile; preserve identity, outfit and framing.
```

`workflow=` is optional: it defaults to the active ComfyUI workflow selected in
ST Image Generation. Both the command and JavaScript API capture that selection
when accepting a request; changing it later does not affect queued calls. The
active workflow must satisfy the reference-image placeholder contract below.

Alternatively supply `prompt="..."`. Optional arguments: `negative="..."`,
`seed=12345`, `width=704`, and `height=1280`. Omit the seed for a random
nonnegative safe integer. Dimensions must be positive safe integers; omitted
dimensions use ST Image Generation settings. They replace workflow placeholders
only; literal workflow dimensions stay unchanged.

Use `message=<id>` instead of `reference=` to take an attached image from the
current chat. Message IDs are zero-based, matching ST's displayed message IDs:

```text
/image-edit message=12 chat=true Give her an amused smile.
```

For a gallery, it uses the selected image; otherwise it uses the first attached
image. Legacy `extra.image` attachments are also supported. Inline Markdown/HTML
images are not attachments. Missing messages and messages without images fail
before generation. Supply exactly one of `reference=` and `message=`. The image
URL is captured immediately, so later message edits or chat switches cannot
change an already queued request's reference.

Add `chat=true` to also display the saved image as an Image Edit message:

```text
/image-edit reference="/user/images/reference.png" workflow="Edit.json" chat=true Give her an amused smile.
```

The command still returns the URL. The message is excluded from the LLM context.
If you switch chats while generation runs, the image stays saved and the command
returns its URL with a warning instead of posting to the newly opened chat.
The JavaScript `edit()` function always stays quiet and accepts an explicit
reference; `chat` and `message` are command options.

The slash-command pipe receives `/user/images/image-edit/<unique-id>.png` (or
the output's JPEG/WebP extension). The original image is untouched. Errors are
shown and thrown; they do not return a success URL. Results are saved even when
the caller does nothing with the URL.

## Call from another extension

JavaScript callers can import the same implementation, avoiding command-string
quoting and slash-parser macro expansion:

```js
const { edit } = await import('/scripts/extensions/third-party/st-image-edit/index.js');
const url = await edit({
    reference: '/user/images/reference.png', // also accepts a Blob/File or data URL
    workflow: 'Edit.json',                  // optional; defaults to active ST workflow
    prompt: 'Keep the same person and clothes; show restrained anger.',
    negativePrompt: '',                     // optional
    seed: 12345,                            // optional
    width: 704,                             // optional
    height: 1280,                           // optional
    signal: abortController.signal,         // optional native AbortSignal
});
```

The import path assumes this folder is named `st-image-edit` under the shared
third-party extensions directory. Keep the extension enabled. For a per-user
installation, use its actual served module path instead.

## Workflow contract

Each placeholder occupies a **complete JSON string input value**:

| Placeholder | Supplied value |
| --- | --- |
| `%reference_image%` | Required; raw base64 reference bytes |
| `%prompt%` | Required; editing instruction |
| `%negative_prompt%` | Optional; negative prompt or empty string |
| `%seed%` | Optional; integer, substituted as a JSON number |
| `%width%`, `%height%` | Optional; integer pixels, from the caller or ST Image Generation settings |

Use a base64 loader, such as `ETN_LoadImageBase64` from
[comfyui-tooling-nodes](https://github.com/Acly/comfyui-tooling-nodes), with its
`image` input set to `%reference_image%`. A standard `LoadImage` expects a server
filename and **cannot use this base64 input**. This node is an example; any
compatible base64 loader is suitable. Install the nodes and models required by
your own editing graph.

All other inputs (model, sampler, etc.) are literal workflow values.
Other native ST placeholders such as `%char_avatar%` are unsupported.
Repeated reference inputs receive the same bytes. Prompts containing quotes,
newlines, or placeholder-like text are preserved without a second substitution.

Expose only the intended final image as an output: the ST proxy returns the
first image output. Background removal is your workflow's responsibility. This
extension preserves returned image bytes, including PNG/WebP alpha, when saving.

References may be same-origin served URLs, PNG/JPEG/WebP base64 data URLs, or
Blob/File inputs, up to 20 MiB. Cross-origin URLs and redirected references are
rejected. Missing workflow names are rejected instead of silently using ST's
default graph. Saved output filenames use UUIDs because the host save endpoint
overwrites existing filenames.

## Execution and cancellation

Calls are serialized in this module instance and snapshot inputs, dimension
defaults, and the backend URL when accepted. A failed call does not stop
subsequent calls. No automatic generation occurs, and chat switches do not
cancel jobs.

An aborted queued call never starts. Cancellation during generation discards the
result but **does not interrupt the ComfyUI request**: the host's disconnect
handler can interrupt unrelated work. The promise and queue wait for that request
to finish. Closing the browser can still trigger the host's disconnect handler.
Cancellation racing with saving may leave an unused saved file; files are never
automatically deleted. There is no separate Cancel command.

## Verification

Run `npm test` (no dependencies). Tests mock the backend and cover workflow
substitution, request routing, reference encoding, queue isolation, cancellation,
failure recovery, and saved-URL results. A real editing workflow and reference
are still required to verify model behavior and alpha end to end; the unit-test
graph is a fixture, not a runnable image-editing workflow.

## Tested Anima workflow

On 2026-10-11, a real ST-proxy generation succeeded using
`anima_ip_adapter_image_edit.json`, supplied in `workflows/`. A copy is also saved
in the tested ST user's workflow list. It was adapted from the user's
`anima_ip_adapter.json`: node 22 uses the already-installed
`Base64DecodeNode` from `comfyui-logicutils` instead of filename-based `LoadImage`,
and width/height now use `%width%` / `%height%` placeholders. The original
workflow is unchanged. The real test used 704×1280 dimensions.

```text
/image-edit reference="/characters/Narrator/isolde/neutral.png" workflow="anima_ip_adapter_image_edit.json" width=704 height=1280 seed=12345 1girl, solo, brown hair, braided hair, brown eyes, tan skin, white crop top, blue athletic shorts, standing, looking at viewer, amused smile, anime illustration
```

The test used the neutral Isolde reference as a Blob via the shared `edit`
implementation. It saved a 704×1280 PNG with alpha ranging from 0 to 255 and
372,068 fully transparent pixels. The saved and served bytes matched. Only
workflow loading/saving, ComfyUI generation, and image-saving endpoints were
called; no chat message or avatar was changed.

This graph uses Anima Turbo + its SigLIP2 IP-Adapter and BiRefNet background
removal. It generates from a fresh latent guided by the reference; it preserves
general character appearance but can change pose, framing, and clothing details.
It is not a strict instruction-following image-edit model.

`tests/real-workflow.mjs` is a local, explicit smoke test for this installation.
Running it submits one real GPU job and saves the adapted workflow copy and
result. It is excluded from `npm test`.
