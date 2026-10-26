import { populateWorkflow } from './workflow.js';
import { stripReferenceMetadata } from './image.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const OUTPUT_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp']);

function checkAbort(signal) {
    if (signal?.aborted) throw new DOMException('Image edit cancelled.', 'AbortError');
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

async function loadReference(reference, { fetch, encode, origin }, signal) {
    let blob;
    if (reference instanceof Blob) {
        blob = reference;
    } else {
        if (typeof reference !== 'string' || !reference.trim()) {
            throw new Error('Supply a reference image URL or Blob.');
        }
        const url = new URL(reference, origin);
        const isData = /^data:image\/(png|jpeg|webp);base64,/i.test(reference);
        if (!isData && (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))) {
            throw new Error('Reference must be a same-origin URL or a PNG/JPEG/WebP base64 data URL.');
        }
        const response = await fetch(url.href, { signal, redirect: 'error' });
        if (!response.ok) throw new Error(`Could not load reference image (${response.status}).`);
        blob = await response.blob();
    }
    checkAbort(signal);
    if (!IMAGE_TYPES.has(blob.type.toLowerCase())) throw new Error('Reference must be PNG, JPEG, or WebP.');
    if (!blob.size) throw new Error('Reference must contain image data.');
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
        if (!response.ok) throw new Error(`Image Edit: ${endpoint} failed (${response.status}).`);
        return response.json();
    }
    return async function edit(input) {
        // Snapshot caller values and host defaults before entering the queue.
        const defaults = deps.getDefaults();
        const job = {
            ...input, url: defaults.url,
            workflow: input.workflow === undefined ? defaults.workflow : input.workflow,
        };
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
            populateWorkflow(text, values, job.references.length); // Validate before loading images.
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
