# Standalone SillyTavern image-editing extension plan

Written 2026-10-11. Status: command implementation added and verified through the
real ST ComfyUI proxy with an adapted Anima IP-Adapter workflow. Returned PNG
alpha and served-URL persistence verified; see README for workflow limitations.

**Scope revised by the user:** build a tiny tool with one command accepting an
arbitrary reference and editing workflow, returning the result without posting
to chat. A manual editor, settings panel, and global versioned facade are no
longer required. Current usage and limitations are in `README.md`. The command
requires an explicit workflow filename; JavaScript consumers can import `edit`.
The original broader design below is retained as background, not the current
completion checklist.
Working name: **Image Editor**. Choose the final repository/extension name when
creating its own checkout. This file lives in SillyNPC only as a handoff document.

## Objective and agreed boundary

Build a standalone SillyTavern browser extension that edits an arbitrary reference
image through a user-configured ComfyUI workflow. It exposes a slash command,
a small manual editor, and a structured JavaScript API for other extensions.
Use SillyTavern's existing ComfyUI server proxy rather than making a direct
browser connection or managing another set of backend credentials.

The user and most intended users use ComfyUI. Their image workflow can perform
background removal; the extension does not need to implement it. The key missing
capability is passing an arbitrary image as the reference instead of the native
ST character or persona avatar.

SillyNPC will be a consumer, not a dependency. SillyNPC owns NPC identity,
emotion classification, varied emotion/gesture prompts, missing-sprite detection,
and expression-pack storage. Image Editor owns reference loading, workflow
population, requests, cancellation, and returning or saving the edited image.
Do not add NPC-specific concepts to Image Editor's core API.

## Findings from the installed host

Inspected local host files:

- `/home/akoca/Desktop/SillyTavern/public/scripts/extensions/stable-diffusion/index.js`
- `/home/akoca/Desktop/SillyTavern/src/endpoints/stable-diffusion.js`

Recheck these interfaces against the host in the new session; line numbers and
behavior may change. Findings on 2026-10-11:

- `/imagine` has prompt/settings arguments but no arbitrary reference-image
  argument. Its `multimodal` option captions avatars for portrait prompts; it is
  not an arbitrary image-editing input.
- ComfyUI workflow substitution supports `%char_avatar%` and `%user_avatar%`.
  It fetches the native avatar, converts it to base64, and substitutes the raw
  base64 string without the data-URL prefix.
- The character resolver selects the actual host character/group member; the
  user resolver selects the persona. Neither accepts a SillyNPC image override.
- Custom workflow placeholders can expand macros, but passing each reference
  explicitly is preferable to maintaining a shared current-reference macro.
- The host's generation helpers are private; do not rely on importing them.
- `POST /api/sd/comfy/workflow` with `{file_name}` returns a JSON string containing
  the saved workflow text. A missing file silently falls back to the default
  workflow, so validate the loaded workflow before any generation.
- `POST /api/sd/comfy/generate` accepts `{url, prompt}`. `prompt` is a JSON string
  containing a ComfyUI request shaped like `{prompt: populatedWorkflow}`.
  It submits the graph, polls history, downloads the first image output (or GIF
  fallback), and returns `{format, data}` with base64 image bytes.
- The host's socket-close handler can send ComfyUI `/interrupt` when a pending
  request disconnects. That interrupt is backend-wide, not reliably scoped to
  this extension's job. Do not promise isolated cancellation.
- The inspected proxy selects the first image output. The edit workflow should
  expose only the intended final image as an output; arbitrary output-node
  selection would need more than this proxy currently provides.

Do not temporarily change ST avatars, character identity, persona, or global
Image Generation settings to supply references or switch workflows. Build each
request from a settings snapshot plus explicit per-request inputs.

## MVP user experience

A settings section lets users select a saved **editing workflow**, separately
from the workflow used by normal ST image generation. Reuse the configured
ComfyUI URL from ST Image Generation settings (`extension_settings.sd.comfy_url`).
Show a clear error if no backend is configured; do not silently use another
provider. No host source patch is planned.

A manual editor provides:

- Reference image selection: a local file or an existing served image URL.
- An editing prompt and optional negative prompt.
- Generate and Cancel controls, a status indicator, and result preview.
- Save/download actions and a returned served image URL for integrations.

Generation does not post a chat message or replace an avatar. Keep the original
reference intact. Preserve transparency in returned PNG/WebP data. Background
removal and the actual editing model remain workflow responsibilities.

No automatic generation on startup, history rendering, or image selection.
A user action or an explicit API call authorizes a job.

## Public interfaces

### Slash command

Proposed syntax; confirm argument conventions during implementation:

```text
/image-edit reference="/user/images/example/reference.png" prompt="Keep the same character, outfit and framing; give her an amused smile."
```

Optional arguments: `workflow`, `negative`, and `seed`. Return the saved image's
served URL through the slash-command pipe. File-picker references belong to the
manual UI; command references are URLs/data URLs. Errors should be visible and
must not return a misleading success URL.

Both the command and manual editor call the same API implementation. Do not
build commands by concatenating unescaped user input inside integrations.

### Structured JavaScript API

Proposed discoverable, versioned interface:

```js
const editor = globalThis.SillyTavernImageEditor?.v1;
if (!editor) throw new Error('Install and enable Image Editor first.');

const result = await editor.edit({
    reference: '/user/images/example/reference.png', // also accept Blob/File
    prompt: 'Preserve identity, clothes, style and framing; show restrained anger.',
    negativePrompt: '',
    workflow: 'NPC_Expression_Edit.json', // optional override
    seed: 12345,                         // optional
    signal: abortController.signal,
    onStatus: status => console.log(status),
});

// result: { url, format, seed, workflow, jobId }
```

Expose availability/capabilities without starting requests. Publish the API only
when ready; document how consumers retry discovery if initialization is late.
Use a namespaced ready event if needed. Keep `edit` and capabilities implemented
in modules so the global facade is small and testable.

Persist results under an Image Editor-owned user image folder using a host image
save helper/endpoint. Return a local served URL and metadata, not base64 stored
in extension settings. Consumers can copy the result into their own asset store.
Verify the host saving helper and its overwrite behavior before implementing.
Automatic cleanup/deletion of consumer-owned files is outside the MVP.

## Workflow contract

Require a ComfyUI **API-format graph**, not the visual editor's canvas JSON.
The workflow must contain an input node that can decode a base64 image. Standard
file-name `LoadImage` inputs do not automatically accept base64; document the
required node and provide an example graph for the tested installation.
Do not assume every ComfyUI installation has the same custom nodes/model.

Proposed placeholders, each occupying a complete JSON string value:

| Placeholder | Value supplied by Image Editor |
| --- | --- |
| `%reference_image%` | Raw base64 reference bytes, without a data-URL prefix |
| `%prompt%` | Editing instruction supplied by the caller |
| `%negative_prompt%` | Optional negative prompt |
| `%seed%` | Supplied or generated integer seed |

Only the reference and prompt placeholders are required. Optional placeholders
are populated if present. Additional model/sampler/dimension placeholders can
be added later if a concrete workflow needs them; MVP graphs can contain literal
values. Do not advertise the entire native ST placeholder system as supported.

Parse the workflow and recursively replace exact placeholder values with typed
values. This avoids broken JSON, escaped prompt errors, and accidental replacement
inside unrelated strings. Reject malformed graphs, missing required placeholders,
and unresolved placeholders before contacting ComfyUI. Repeated reference
placeholders receive the same input.

Fetch served references with normal ST access, convert Blob/File input to base64,
and validate supported image type and a reasonable input-size limit. Accept
same-origin URLs and image data URLs for MVP. Cross-origin references can wait
until there is a concrete need and a deliberate fetch policy. Never log reference
base64 or full image payloads.

## Job lifecycle and cancellation

Use one serialized queue per extension instance. Each job carries immutable
reference, prompt, workflow, URL, and seed inputs; never read a shared current
reference after enqueueing. Snapshot defaults when accepting the job.

Suggested states: queued, preparing, generating, saving, complete, cancelled,
failed. These reflect observable work; the host proxy does not provide precise
model progress. Call `onStatus` without letting a consumer callback exception
break the generation lifecycle.

Check AbortSignal before and after reference fetch, workflow loading, generation,
and saving. A queued cancelled job must never start. A cancelled active job must
never report success or update the editor preview. Saving may leave an orphaned
result if cancellation races with completion; document this rather than deleting
files that consumers might already use.

Do not automatically cancel generic image-editing jobs on chat switches: the
standalone tool has no chat ownership. Consumers such as SillyNPC supply their
own cancellation signals. Disabling Image Editor stops queued/active work.
Because host cancellation may interrupt unrelated ComfyUI work, explain that
limitation and verify it in the target host before finalizing Cancel behavior.

## Later SillyNPC integration (separate change)

Do not implement this integration as part of the standalone extension MVP.
Its contract should support the following future behavior:

1. User approves a neutral full-body reference and opts the NPC into generating
   missing expressions.
2. SillyNPC classifies dialogue against the supported emotion vocabulary,
   including labels absent from the pack. Its current WebLLM adapter limits labels
   to existing sprites and must change for missing-emotion discovery.
3. Existing sprites are reused. Missing sprites use neutral/base fallback while
   SillyNPC queues one job per NPC/reference version/emotion.
4. SillyNPC selects a varied expression/gesture prompt using character traits
   and dialogue, with instructions to preserve identity, outfit, style, and
   framing. Prompt variation is SillyNPC policy, not Image Editor policy.
5. Image Editor edits the supplied reference and returns the result.
6. SillyNPC verifies ownership/reference freshness, uploads the result through
   the host sprite backend, and refreshes its pack cache.

Do not delay speech for generation. Do not let a late image result switch the
currently audible speaker or change a dialogue portrait mid-playback. Maintain
per-line portrait identity and existing speech synchronization. Reuse generated
emotions instead of generating on every occurrence. Add review/regenerate controls,
duplicate prevention, limits, and explicit retry after failure.

## Implementation sequence

1. **Create the standalone extension skeleton.** Own repository/directory,
   manifest, entry point, settings, and short source modules. No build step is
   necessary. Recheck host imports, proxy endpoints, and saving helpers.
2. **Build the pure workflow adapter.** Parse/validate API graphs, substitute
   placeholders safely, and establish the reference-image encoding contract.
3. **Implement jobs and persistence.** Reference loading, configured host proxy,
   serialized execution, AbortSignal handling, saving, and normalized errors.
4. **Expose command and JavaScript API.** Both use the same job controller;
   document availability, results, and errors.
5. **Build the manual editor.** Reference picker, prompt, status, cancellation,
   preview, and result saving/downloading.
6. **Verify with a real editing workflow.** Edit one chosen test reference through
   the local backend. Check transparency and identity/framing by inspection.
   Publish setup instructions with tested workflow/node requirements.
7. **Integrate SillyNPC afterward.** On-demand emotion generation is a separate
   consumer feature, with its own tests and settings.

Suggested module split: `api.js`, `settings.js`, `references.js`, `workflow.js`,
`comfy-client.js`, `jobs.js`, `image-store.js`, `commands.js`, and `ui/`.
Keep source files below 20 kB; avoid adding a generic provider framework before
another provider is actually requested.

## Verification and completion criteria

Focused tests should cover typed substitution, quotes/newlines in prompts,
missing/invalid graphs, reference encoding, immutable concurrent requests,
queue ordering, queued and active cancellation, failures, and served-URL results.
Use mocked fetch/backend responses for routing and cancellation tests.

In running SillyTavern, verify that command, manual editor, and JS API use the
chosen image rather than native avatars. Confirm normal `/imagine` still works
and its settings/avatars remain unchanged. Verify malformed requests fail before
generation and cancelled jobs cannot update a newer preview.

Use a deliberate real ComfyUI sample to verify the reference reaches the loader,
the final output is selected, and alpha survives saving. Do not make real image
requests merely to verify UI rendering. Temporary UI fixtures must restore
settings, avoid chat saves, and clean up injected elements.

MVP is complete when an arbitrary reference can be edited from all three entry
points, returned as a saved local URL, and used without avatar swaps, host patches,
or a direct browser-to-ComfyUI dependency.

## Starting the next session

Read this plan, create or locate the standalone extension checkout, and inspect
the installed host's image-generation and proxy code. Identify the user's saved
ComfyUI editing graph and its base64 loader node before wiring requests. If the
workflow is absent, first provide the explicit placeholder/node contract and
build the adapter against a small fixture; a real workflow remains necessary for
end-to-end verification. Do not begin by modifying SillyNPC's emotion generation.
