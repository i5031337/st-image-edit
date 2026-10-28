# Image Edit for SillyTavern

Edit images through ComfyUI with `/image-edit`. Results are saved and posted to chat; original images stay unchanged.

## Setup

1. Open **Extensions → Install Extension**, paste `https://github.com/i5031337/st-image-edit`, install, and reload SillyTavern.
2. Set your **ComfyUI URL** in **Image Generation** settings. Image Edit always uses ComfyUI, regardless of the selected provider.
3. Import an **API-format** workflow through SillyTavern's ComfyUI workflow editor. Select it as the active workflow or specify its filename with `workflow=`.

Any API-format ComfyUI workflow can be used with any number of reference images, provided it loads each reference as base64 and uses the [required placeholders](#custom-workflows).

The included Flux.2 Klein 9B workflows are examples for [one image](workflows/flux2_9b_edit.json) or [two images](workflows/flux2_9b_edit_2ref.json). Both require `Base64DecodeNode` from `comfyui-logicutils` and these model files:

- `flux-2-klein-9b-kv-fp8.safetensors`
- `qwen_3_8b_fp8mixed.safetensors`
- `flux2-vae.safetensors`

Adjust the filenames in the workflow if yours differ. These workflows scale each reference to about one megapixel and use the first image's scaled dimensions for the result. They do not use `width=` or `height=`. The two-image workflow requires exactly two references and uses more memory.

## Use

Attach an image to the message composer, then run:

```text
/image-edit Give her an amused smile.
```

If the composer has no images, the command uses the last chat message's image. It does not search earlier messages.

To choose an image explicitly:

```text
/image-edit message=12 Give her an amused smile.
/image-edit reference="/user/images/reference.png" workflow="flux2_9b_edit.json" Give her an amused smile.
```

`message=` is a zero-based chat message ID. It uses the selected gallery image, or the first image if the selection is not an image. `reference=` accepts an image URL from your SillyTavern server or a PNG/JPEG/WebP base64 data URL.

### Multiple images

Attach two images and use the two-reference workflow:

```text
/image-edit workflow="flux2_9b_edit_2ref.json" Put the person from image 1 in the outfit from image 2.
```

You can also repeat `reference=` or `message=`, or combine them. Explicit sources skip composer attachments unless you add `attached=true`:

```text
/image-edit attached=true message=12 order="2,1" workflow="flux2_9b_edit_2ref.json" Put the person from image 1 in the outfit from image 2.
```

Images are collected in this order: composer attachments, `message=` images, then `reference=` URLs. Each group preserves its own order. `order="2,1"` swaps two references; any custom order must list every reference index exactly once, starting at 1.

Non-image composer files are ignored. When explicit sources are supplied, an empty composer adds no images and does not fall back to the last message. Use `attached=false` to skip the composer entirely.

### Options

| Argument | Effect |
| --- | --- |
| `workflow="Edit.json"` | Override the active ComfyUI workflow. |
| `prompt="..."` | Supply the instruction instead of trailing text. |
| `negative="..."` | Set the negative prompt. |
| `seed=12345` | Set a nonnegative integer seed. |
| `width=704 height=1280` | Fill dimension placeholders; defaults come from Image Generation settings. Literal workflow dimensions stay unchanged. |
| `chat=false` | Save and return the image URL without posting to chat. |

Every successful command returns a `/user/images/image-edit/...` URL.

## Custom workflows

Export your ComfyUI graph in **API format**. Use these placeholders as whole input values, such as `"text": "%prompt%"`:

| Placeholder | Value |
| --- | --- |
| `%prompt%` | Editing instruction; required. |
| `%reference_image_1%`, `%reference_image_2%`, … | Raw base64 image data, one placeholder per reference. |
| `%reference_image%` | Alias for the first reference. |
| `%negative_prompt%`, `%seed%`, `%width%`, `%height%` | Optional prompt, seed, and dimension values. |

The number of supplied images must match the workflow's reference placeholders. There is no fixed reference-count limit.

References need a base64 decoder node; ComfyUI's standard `LoadImage` cannot read them. The included workflows use `Base64DecodeNode` from `comfyui-logicutils`. SillyTavern returns the first image output, so expose only the result you want saved.

## Formats and limits

HEIC/HEIF images are converted locally to PNG using the [bundled decoder](vendor/heic-to/README.md). Conversion uses the primary image and drops HEIC metadata and HDR/color profiles. No external conversion service is used.

PNG text metadata is removed from references before sending to avoid carrying old workflows into new outputs. Pixels, transparency, and color profiles are preserved. JPEG and WebP references pass through unchanged; generated images retain ComfyUI's output metadata.

References and prompts are sent to your configured ComfyUI server. Saved outputs are not automatically deleted. Large images are subject to browser memory and server request limits. Cancelling discards the result but lets an active ComfyUI request finish.

Licensed under [MIT](LICENSE).
