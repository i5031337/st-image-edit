import { populateWorkflow } from './workflow.js';
import { convertHeicToPng, isHeicBlob, stripReferenceMetadata } from './image.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const OUTPUT_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function checkAbort(signal) {
    if (signal?.aborted) throw new DOMException('Image edit cancelled.', 'AbortError');
}

async function responseError(response, action) {
    let detail = '';
    try {
        const text = (await response.text()).trim();
        // Proxy error pages are not useful in a toast. Keep plain server diagnostics.
        if (!response.headers.get('content-type')?.includes('text/html') && !/^\s*</.test(text)) {
            detail = text;
            try {
                const body = JSON.parse(text);
                const message = body?.error?.message ?? body?.message ?? body?.error;
                if (typeof message === 'string') detail = message;
            } catch { /* Plain text is the normal ComfyUI error response. */ }
        }
    } catch (error) {
        if (error.name === 'AbortError') throw error;
    }
    detail = detail.trim();
    if (detail.length > 2000) detail = `${detail.slice(0, 2000)}…`;
    return new Error(`${action} (${response.status}): ${detail || 'Check the SillyTavern server logs for details.'}`);
}

function integer(value, name, minimum) {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') {
        throw new Error(`${name} must be an integer of at least ${minimum}.`);
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum) {
        throw new Error(`${name} must be an integer of at least ${minimum}.`);
    }
    return number;
}

async function loadReference(reference, { fetch, encode, origin, convertHeic = convertHeicToPng }, signal) {
    let blob;
    if (reference instanceof Blob) {
        blob = reference;
    } else {
        if (typeof reference !== 'string' || !reference.trim()) {
            throw new Error('Supply a reference image URL or Blob.');
        }
        const url = new URL(reference, origin);
        const isData = /^data:image\/(png|jpeg|webp|heic|heif|heic-sequence|heif-sequence);base64,/i.test(reference);
        if (!isData && (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))) {
            throw new Error('Reference must be a same-origin URL or a PNG/JPEG/WebP/HEIC/HEIF base64 data URL.');
        }
        const response = await fetch(url.href, { signal, redirect: 'error' });
        if (!response.ok) throw await responseError(response, 'Could not load reference image');
        blob = await response.blob();
    }
    checkAbort(signal);
    if (!blob.size) throw new Error('Reference must contain image data.');
    if (await isHeicBlob(blob)) {
        checkAbort(signal);
        try {
            blob = await convertHeic(blob);
            if (!(blob instanceof Blob) || blob.type !== 'image/png' || !blob.size) {
                throw new Error('Decoder did not return a PNG image.');
            }
        } catch (error) {
            checkAbort(signal);
            throw new Error(`Could not convert HEIC/HEIF reference to PNG: ${error.message ?? error}`);
        }
        checkAbort(signal);
    }
    if (!IMAGE_TYPES.has(blob.type.toLowerCase())) throw new Error('Reference must be PNG, JPEG, or WebP, or HEIC/HEIF.');
    blob = await stripReferenceMetadata(blob);
    checkAbort(signal);
    const dataUrl = await encode(blob);
    checkAbort(signal);
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/** One queue per instance. Dependencies keep the host integration small and testable. */
export function createEditor(deps) {
    let tail = Promise.resolve();
    async function post(endpoint, body, signal) {
        const response = await deps.fetch(endpoint, {
            method: 'POST', headers: deps.headers(), body: JSON.stringify(body), signal,
        });
        if (!response.ok) {
            const action = {
                '/api/sd/comfy/workflows': 'Could not list saved ComfyUI workflows',
                '/api/sd/comfy/workflow': 'Could not load the saved ComfyUI workflow',
                '/api/sd/comfy/generate': 'ComfyUI image generation failed',
            }[endpoint];
            throw await responseError(response, action);
        }
        return response.json();
    }
    return async function edit(input) {
        // Snapshot caller values and host defaults before entering the queue.
        const defaults = deps.getDefaults();
        const job = {
            ...input, url: defaults.url,
            workflow: input.workflow === undefined ? defaults.workflow : input.workflow,
            values: { ...defaults.values },
            avatars: { ...defaults.avatars },
        };
        if (typeof job.prompt === 'string' && deps.expandMacros) job.prompt = deps.expandMacros(job.prompt);
        if (!job.url) throw new Error('Configure the ComfyUI URL in ST Image Generation first.');
        if (typeof job.prompt !== 'string' || !job.prompt.trim()) {
            throw new Error('Supply an editing prompt.');
        }
        if (typeof job.workflow !== 'string' || !/^[^/\\]+\.json$/i.test(job.workflow)) {
            throw new Error('Select a ComfyUI workflow in ST Image Generation or supply workflow= with a saved JSON filename.');
        }
        if (input.reference !== undefined && input.references !== undefined) {
            throw new Error('Supply either reference or references, not both.');
        }
        const source = input.references ?? input.reference;
        job.references = Array.isArray(source) ? [...source] : [source];
        if (!job.references.length) throw new Error('Supply at least one reference image.');
        job.negativePrompt ??= '';
        if (typeof job.negativePrompt !== 'string') throw new Error('Negative prompt must be text.');
        if (deps.expandMacros) job.negativePrompt = deps.expandMacros(job.negativePrompt);
        job.seed = integer(job.seed === undefined ? deps.randomSeed() : job.seed, 'Seed', 0);
        for (const name of ['width', 'height']) {
            const value = job[name] === undefined ? defaults[name] : job[name];
            if (value !== undefined) job[name] = integer(value, name, 1);
        }
        const run = async () => {
            const { signal } = job;
            checkAbort(signal);
            // Host silently substitutes the default for missing files. Verify membership first.
            const files = await post('/api/sd/comfy/workflows', {}, signal);
            checkAbort(signal);
            if (!Array.isArray(files) || !files.includes(job.workflow)) {
                throw new Error(`Saved editing workflow not found: ${job.workflow}`);
            }
            const text = await post('/api/sd/comfy/workflow', { file_name: job.workflow }, signal);
            checkAbort(signal);
            const values = {
                ...job.values,
                '%prompt%': job.prompt,
                '%negative_prompt%': job.negativePrompt, '%seed%': job.seed,
            };
            for (const name of ['width', 'height']) {
                if (job[name] !== undefined) values[`%${name}%`] = job[name];
            }
            for (let index = 1; index <= job.references.length; index++) {
                values[`%reference_image_${index}%`] = '';
            }
            values['%reference_image%'] = '';
            // Validate with empty avatars before fetching any image data.
            const avatarValues = Object.fromEntries(Object.keys(job.avatars).map(key => [key, '']));
            populateWorkflow(text, { ...avatarValues, ...values }, job.references.length);
            const nodes = Object.values(JSON.parse(text));
            for (const [key, url] of Object.entries(job.avatars)) {
                if (Object.hasOwn(values, key)) continue;
                // Only fetch avatars referenced by executable inputs, not metadata.
                const contains = value => value === key || (value && typeof value === 'object' && Object.values(value).some(contains));
                if (!nodes.some(node => contains(node.inputs))) continue;
                const response = await deps.fetch(url, { signal });
                checkAbort(signal);
                values[key] = response.ok
                    ? (await deps.encode(await response.blob())).split(',')[1]
                    : PNG_PIXEL;
                checkAbort(signal);
            }
            for (let index = 0; index < job.references.length; index++) {
                values[`%reference_image_${index + 1}%`] = await loadReference(job.references[index], deps, signal);
            }
            values['%reference_image%'] = values['%reference_image_1%'];
            const graph = populateWorkflow(text, values, job.references.length);
            checkAbort(signal);
            // Deliberately do not abort this fetch: ST can issue a backend-wide /interrupt.
            const result = await post('/api/sd/comfy/generate', {
                url: job.url, prompt: JSON.stringify({ prompt: graph }),
            });
            checkAbort(signal);
            if (!result || !OUTPUT_FORMATS.has(result.format) || typeof result.data !== 'string' || !result.data) {
                throw new Error('ComfyUI did not return a supported image.');
            }
            const url = await deps.save(result.data, 'image-edit', deps.makeId(), result.format);
            checkAbort(signal);
            if (typeof url !== 'string' || !url.startsWith('/user/images/')) {
                throw new Error('Image save did not return a local served image URL.');
            }
            return url;
        };
        const result = tail.then(run);
        tail = result.catch(() => {});
        return result;
    };
}
