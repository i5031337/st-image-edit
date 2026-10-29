import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditor } from '../editor.js';
import { populateWorkflow } from '../workflow.js';
import { readFile } from 'node:fs/promises';

const graph = {
    '1': { class_type: 'ETN_LoadImageBase64', inputs: { image: '%reference_image%' } },
    '2': { class_type: 'EditFixture', inputs: {
        image: ['1', 0], prompt: '%prompt%', negative: '%negative_prompt%', seed: '%seed%',
    } },
};
const json = JSON.stringify(graph);
const dimensionGraph = JSON.stringify({ ...graph, '3': {
    class_type: 'EmptyLatentImage', inputs: { width: '%width%', height: '%height%', batch_size: 1 },
} });
const reference = new Blob(['reference bytes'], { type: 'image/png' });
const input = { reference, workflow: 'Edit.json', prompt: 'Smile', seed: 12 };
const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
};

function fixture(options = {}) {
    const requests = [];
    const saves = [];
    const deps = {
        origin: 'http://st.local',
        headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture' }),
        getDefaults: () => ({ url: 'http://comfy.local:8188', workflow: 'Edit.json', width: 704, height: 1280 }),
        encode: async blob => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`,
        randomSeed: () => 42,
        makeId: () => 'unique-id',
        save: async (...args) => {
            saves.push(args);
            return '/user/images/image-edit/unique-id.png';
        },
        fetch: async (url, init) => {
            requests.push({ url, ...init, body: init?.body ? JSON.parse(init.body) : undefined });
            if (url.startsWith('data:')) return fetch(url, init);
            switch (url) {
                case '/api/sd/comfy/workflows': return Response.json(options.files ?? ['Edit.json']);
                case '/api/sd/comfy/workflow': return Response.json(options.workflow ?? json);
                case '/api/sd/comfy/generate':
                    if (options.generate) return options.generate(init);
                    return Response.json({ format: 'png', data: 'output-base64' });
                case 'http://st.local/user/images/reference.png':
                    return new Response(options.reference ?? reference, {
                        headers: { 'Content-Length': String((options.reference ?? reference).size) },
                    });
                default: throw new Error(`Unexpected request: ${url}`);
            }
        },
        ...options.deps,
    };
    return { edit: createEditor(deps), requests, saves, deps };
}

test('typed substitution preserves arbitrary prompt text and never re-expands it', () => {
    const prompt = 'She says "hello"\n%seed% \\ and smiles.';
    const result = populateWorkflow(json, {
        '%reference_image%': 'raw', '%prompt%': prompt, '%negative_prompt%': '', '%seed%': 99,
    });
    assert.equal(result['2'].inputs.prompt, prompt);
    assert.equal(result['2'].inputs.seed, 99);
    assert.equal(result['1'].inputs.image, 'raw');
    assert.deepEqual(result['2'].inputs.image, ['1', 0]);
    assert.equal(graph['1'].inputs.image, '%reference_image%');
});

test('Flux example routes the reference through core conditioning to its final output', async () => {
    const text = await readFile(new URL('../workflows/flux2_9b_edit.json', import.meta.url), 'utf8');
    const populated = populateWorkflow(text, {
        '%reference_image%': 'reference-bytes', '%prompt%': 'amused smile',
        '%seed%': 12345,
    });
    assert.equal(populated['76'].class_type, 'Base64DecodeNode');
    assert.equal(populated['76'].inputs.base64_string, 'reference-bytes');
    assert.deepEqual(populated['130'].inputs.image, ['76', 0]);
    assert.deepEqual(populated['117'].inputs.pixels, ['130', 0]);
    assert.deepEqual(populated['118'].inputs.latent, ['117', 0]);
    assert.deepEqual(populated['116'].inputs.latent, ['117', 0]);
    assert.equal(populated['135'].inputs.text, 'amused smile');
    assert.equal(populated['125'].inputs.noise_seed, 12345);
    assert.deepEqual(populated['94'].inputs.images, ['124', 0]);
});

test('dimensions use explicit integers or ST defaults, without changing literal workflow inputs', async () => {
    for (const [dimensions, expected] of [
        [{}, { width: 704, height: 1280 }],
        [{ width: '832', height: '1216' }, { width: 832, height: 1216 }],
        [{ width: 1024 }, { width: 1024, height: 1280 }],
    ]) {
        const f = fixture({ workflow: dimensionGraph });
        await f.edit({ ...input, ...dimensions });
        const request = f.requests.find(r => r.url.endsWith('/generate'));
        const values = JSON.parse(request.body.prompt).prompt['3'].inputs;
        assert.deepEqual(values, { ...expected, batch_size: 1 });
    }
    const literal = dimensionGraph.replace('"%width%"', '640').replace('"%height%"', '960');
    const f = fixture({ workflow: literal });
    await f.edit({ ...input, width: 1024, height: 1024 });
    const request = f.requests.find(r => r.url.endsWith('/generate'));
    assert.deepEqual(JSON.parse(request.body.prompt).prompt['3'].inputs, { width: 640, height: 960, batch_size: 1 });
});

test('workflow defaults to the active selection and permits an explicit override', async () => {
    const f = fixture({ files: ['Edit.json', 'Other.json'] });
    await f.edit({ ...input, workflow: undefined });
    await f.edit({ ...input, workflow: 'Other.json' });
    assert.deepEqual(f.requests.filter(r => r.url.endsWith('/workflow')).map(r => r.body.file_name), [
        'Edit.json', 'Other.json',
    ]);
    const noDefault = fixture({ deps: { getDefaults: () => ({ url: 'http://comfy.local' }) } });
    await assert.rejects(noDefault.edit({ ...input, workflow: undefined }), /Select a ComfyUI workflow/);
    assert.equal(noDefault.requests.length, 0);
    for (const workflow of ['', null, '../Edit.json']) {
        const invalid = fixture();
        await assert.rejects(invalid.edit({ ...input, workflow }), /saved JSON filename/);
        assert.equal(invalid.requests.length, 0);
    }
});

test('queued requests retain the active workflow selected when accepted', async () => {
    const started = deferred();
    const release = deferred();
    const defaults = { url: 'http://comfy.local', workflow: 'Edit.json' };
    let count = 0;
    const f = fixture({
        files: ['Edit.json', 'Other.json'], deps: { getDefaults: () => defaults },
        generate: async () => {
            if (++count === 1) { started.resolve(); await release.promise; }
            return Response.json({ format: 'png', data: 'output' });
        },
    });
    const first = f.edit({ ...input, workflow: undefined });
    await started.promise;
    const second = f.edit({ ...input, workflow: undefined });
    defaults.workflow = 'Other.json';
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(f.requests.filter(r => r.url.endsWith('/workflow')).map(r => r.body.file_name), [
        'Edit.json', 'Edit.json',
    ]);
});

test('invalid dimensions reject before any backend request; unresolved dimensions never generate', async () => {
    for (const name of ['width', 'height']) {
        for (const value of [0, -1, 1.5, '', 'bad', null, true, [512], Number.MAX_SAFE_INTEGER + 1]) {
            const f = fixture({ workflow: dimensionGraph });
            await assert.rejects(f.edit({ ...input, [name]: value }), new RegExp(name));
            assert.equal(f.requests.length, 0);
        }
    }
    const f = fixture({ workflow: dimensionGraph, deps: { getDefaults: () => ({ url: 'http://comfy.local' }) } });
    await assert.rejects(f.edit(input), /%width%/);
    assert.ok(!f.requests.some(r => r.url.endsWith('/generate')));
});

test('queued dimensions snapshot caller values and ST defaults when accepted', async () => {
    const started = deferred();
    const release = deferred();
    const defaults = { url: 'http://comfy.local', width: 704, height: 1280 };
    let count = 0;
    const f = fixture({
        workflow: dimensionGraph, deps: { getDefaults: () => defaults },
        generate: async () => {
            if (++count === 1) { started.resolve(); await release.promise; }
            return Response.json({ format: 'png', data: 'output' });
        },
    });
    const first = f.edit(input);
    await started.promise;
    const caller = { ...input, width: '832' };
    const second = f.edit(caller);
    caller.width = 2048;
    defaults.height = 512;
    release.resolve();
    await Promise.all([first, second]);
    const jobs = f.requests.filter(r => r.url.endsWith('/generate'));
    assert.deepEqual(JSON.parse(jobs[1].body.prompt).prompt['3'].inputs, {
        width: 832, height: 1280, batch_size: 1,
    });
});

test('rejects malformed, visual, missing, embedded, and unknown workflow inputs', () => {
    const values = { '%reference_image%': 'raw', '%prompt%': 'edit' };
    for (const text of ['{', '{}', 'null', '[]', '{"nodes":[]}',
        JSON.stringify({ '1': graph['1'] }),
        json.replace('%prompt%', 'prefix %prompt%'),
        json.replace('%seed%', '%unknown%')]) {
        assert.throws(() => populateWorkflow(text, values));
    }
});

test('routes via the host, passes raw reference bytes, saves unchanged output and returns URL', async () => {
    const f = fixture();
    const url = await f.edit({ ...input, reference: '/user/images/reference.png' });
    assert.equal(url, '/user/images/image-edit/unique-id.png');
    const request = f.requests.find(r => r.url.endsWith('/generate'));
    const workflow = JSON.parse(request.body.prompt).prompt;
    assert.equal(workflow['1'].inputs.image, Buffer.from('reference bytes').toString('base64'));
    assert.equal(workflow['2'].inputs.seed, 12);
    assert.equal(request.body.url, 'http://comfy.local:8188');
    assert.equal(request.signal, undefined);
    assert.deepEqual(f.saves, [['output-base64', 'image-edit', 'unique-id', 'png']]);
    assert.ok(f.requests.every(r => r.url.startsWith('/api/sd/comfy/') || r.url.startsWith('http://st.local/')));
});

test('accepts data URLs and preserves WebP output', async () => {
    const f = fixture({
        deps: {
            fetch: async (url) => {
                if (url.startsWith('data:')) return fetch(url);
                if (url.endsWith('/workflows')) return Response.json(['Edit.json']);
                if (url.endsWith('/workflow')) return Response.json(json);
                return Response.json({ format: 'webp', data: 'unchanged-alpha-bytes' });
            },
        },
    });
    await f.edit({ ...input, reference: 'data:image/webp;base64,Ynl0ZXM=' });
    assert.equal(f.saves[0][0], 'unchanged-alpha-bytes');
    assert.equal(f.saves[0][3], 'webp');
});

test('converts HEIC blobs, generic MIME URLs, and HEIF data URLs before encoding', async () => {
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic')]);
    const converted = new Blob(['converted PNG bytes'], { type: 'image/png' });
    for (const source of [
        new Blob([bytes], { type: 'image/heic' }),
        '/user/images/reference.png',
        `data:image/heif;base64,${bytes.toString('base64')}`,
    ]) {
        let conversions = 0;
        const f = fixture({
            reference: new Blob([bytes], { type: 'application/octet-stream' }),
            deps: { convertHeic: async blob => {
                conversions++;
                assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
                return converted;
            } },
        });
        await f.edit({ ...input, reference: source });
        assert.equal(conversions, 1);
        const request = f.requests.find(r => r.url.endsWith('/generate'));
        assert.equal(JSON.parse(request.body.prompt).prompt['1'].inputs.image,
            Buffer.from('converted PNG bytes').toString('base64'));
    }
    const f = fixture({ deps: { convertHeic: () => { throw new Error('should not convert PNG'); } } });
    await f.edit(input);
});

test('conversion failure and cancellation prevent generation and leave the queue usable', async () => {
    const heic = new Blob(['HEIC'], { type: 'image/heic' });
    for (const convertHeic of [
        async () => { throw new Error('broken file'); },
        async () => null,
        async () => new Blob([], { type: 'image/png' }),
    ]) {
        const f = fixture({ deps: { convertHeic } });
        await assert.rejects(f.edit({ ...input, reference: heic }), /Could not convert HEIC\/HEIF/);
        assert.ok(!f.requests.some(r => r.url.endsWith('/generate')));
        await f.edit(input);
        assert.equal(f.saves.length, 1);
    }
    const controller = new AbortController();
    const f = fixture({ deps: { convertHeic: async () => {
        controller.abort();
        return new Blob(['PNG'], { type: 'image/png' });
    } } });
    await assert.rejects(f.edit({ ...input, reference: heic, signal: controller.signal }), { name: 'AbortError' });
    assert.ok(!f.requests.some(r => r.url.endsWith('/generate')));
});

test('missing workflow and invalid graph never generate or save', async () => {
    const missing = fixture();
    await assert.rejects(missing.edit({ ...input, workflow: 'Missing.json' }), /not found/);
    assert.equal(missing.requests.length, 1);
    assert.equal(missing.saves.length, 0);
    const f = fixture({ workflow: '{}' });
    await assert.rejects(f.edit(input), /API-format/);
    assert.equal(f.requests.length, 2);
    assert.equal(f.saves.length, 0);
});

test('rejects external URLs, unsupported MIME, empty references, and unsafe seeds', async () => {
    for (const badReference of ['https://elsewhere.local/image.png', 'file:///tmp/image.png',
        new Blob(['text'], { type: 'text/plain' }), new Blob([], { type: 'image/png' })]) {
        const f = fixture();
        await assert.rejects(f.edit({ ...input, reference: badReference }));
        assert.equal(f.saves.length, 0);
        assert.ok(!f.requests.some(r => r.url.endsWith('/generate')));
    }
    for (const seed of [-1, 1.5, 'bad', '', null, true, [], Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(fixture().edit({ ...input, seed }), /Seed/);
    }
    await assert.rejects(fixture({ deps: { getDefaults: () => ({}) } }).edit(input), /ComfyUI URL/);
});

test('accepts references over the former 20 MiB limit as blobs, URLs, and data URLs', async () => {
    const large = new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: 'image/png' });
    const base64 = Buffer.from(await large.arrayBuffer()).toString('base64');
    for (const source of [large, 'http://st.local/user/images/reference.png', `data:image/png;base64,${base64}`]) {
        const f = fixture({ reference: large });
        await f.edit({ ...input, reference: source });
        const request = f.requests.find(r => r.url.endsWith('/generate'));
        assert.equal(JSON.parse(request.body.prompt).prompt['1'].inputs.image, base64);
        assert.equal(f.saves.length, 1);
    }
});

test('serializes immutable jobs and snapshots backend defaults on acceptance', async () => {
    const first = deferred();
    const started = deferred();
    let count = 0;
    let backend = 'http://first.local';
    const f = fixture({
        deps: { getDefaults: () => ({ url: backend }) },
        generate: async () => {
            if (++count === 1) { started.resolve(); await first.promise; }
            return Response.json({ format: 'png', data: 'output' });
        },
    });
    const a = f.edit(input);
    await started.promise;
    const mutable = { ...input, reference: new Blob(['second'], { type: 'image/png' }), prompt: 'second' };
    backend = 'http://second.local';
    const b = f.edit(mutable);
    mutable.prompt = 'mutated';
    backend = 'http://third.local';
    assert.equal(count, 1);
    first.resolve();
    await Promise.all([a, b]);
    const requests = f.requests.filter(r => r.url.endsWith('/generate'));
    assert.deepEqual(requests.map(r => r.body.url), ['http://first.local', 'http://second.local']);
    const second = JSON.parse(requests[1].body.prompt).prompt;
    assert.equal(second['2'].inputs.prompt, 'second');
    assert.equal(second['1'].inputs.image, Buffer.from('second').toString('base64'));
});

test('cancelled queued jobs never start', async () => {
    const gate = deferred();
    const started = deferred();
    const f = fixture({ generate: async () => {
        started.resolve(); await gate.promise;
        return Response.json({ format: 'png', data: 'output' });
    } });
    const a = f.edit(input);
    await started.promise;
    const controller = new AbortController();
    const b = f.edit({ ...input, signal: controller.signal });
    const rejected = assert.rejects(b, { name: 'AbortError' });
    controller.abort();
    gate.resolve();
    await a;
    await rejected;
    assert.equal(f.requests.filter(r => r.url.endsWith('/workflows')).length, 1);
});

test('active cancellation discards output, drains host request, then continues queue', async () => {
    const gate = deferred();
    const started = deferred();
    let count = 0;
    const f = fixture({ generate: async init => {
        assert.equal(init.signal, undefined);
        if (++count === 1) { started.resolve(); await gate.promise; }
        return Response.json({ format: 'png', data: 'output' });
    } });
    const controller = new AbortController();
    const a = f.edit({ ...input, signal: controller.signal });
    const rejected = assert.rejects(a, { name: 'AbortError' });
    await started.promise;
    controller.abort();
    const b = f.edit(input);
    assert.equal(count, 1);
    gate.resolve();
    await rejected;
    await b;
    assert.equal(f.saves.length, 1);
});

test('cancellation racing with saving cannot return success', async () => {
    const controller = new AbortController();
    const f = fixture({ deps: { save: async () => {
        controller.abort(); return '/user/images/image-edit/orphan.png';
    } } });
    await assert.rejects(f.edit({ ...input, signal: controller.signal }), { name: 'AbortError' });
});

test('generation and saving failures reject and do not poison the queue', async () => {
    let count = 0;
    const f = fixture({ generate: async () => ++count === 1
        ? new Response('backend failure', { status: 500 })
        : Response.json({ format: 'png', data: 'output' }) });
    await assert.rejects(f.edit(input), /500/);
    assert.equal(f.saves.length, 0);
    await f.edit(input);
    assert.equal(f.saves.length, 1);
    await assert.rejects(fixture({ deps: { save: async () => { throw new Error('disk full'); } } }).edit(input), /disk full/);
    await assert.rejects(fixture({ deps: { save: async () => 'data:image/png;base64,abc' } }).edit(input), /served image URL/);
});


test('backend errors retain useful diagnostics and fall back for empty or HTML responses', async () => {
    for (const [response, expected] of [
        [new Response('VAELoader [127] FileNotFoundError: flux2-vae.safetensors', { status: 500 }), /VAELoader \[127\] FileNotFoundError: flux2-vae\.safetensors/],
        [Response.json({ error: { message: 'Missing node Base64DecodeNode' } }, { status: 400 }), /Missing node Base64DecodeNode/],
        [Response.json({ message: 'CUDA out of memory' }, { status: 500 }), /CUDA out of memory/],
        [new Response('', { status: 500 }), /Check the SillyTavern server logs/],
        [new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }), /Check the SillyTavern server logs/],
    ]) {
        const f = fixture({ generate: async () => response });
        await assert.rejects(f.edit(input), error => {
            assert.match(error.message, /ComfyUI image generation failed \((400|500|502)\):/);
            assert.match(error.message, expected);
            assert.doesNotMatch(error.message, /<html>/);
            return true;
        });
        assert.equal(f.saves.length, 0);
    }
});

test('workflow and reference failures identify the operation and preserve server details', async () => {
    for (const [endpoint, job, expected] of [
        ['/api/sd/comfy/workflows', input, /Could not list saved ComfyUI workflows/],
        ['/api/sd/comfy/workflow', input, /Could not load the saved ComfyUI workflow/],
        ['http://st.local/user/images/reference.png', { ...input, reference: '/user/images/reference.png' }, /Could not load reference image/],
    ]) {
        const f = fixture();
        const fetch = f.deps.fetch;
        f.deps.fetch = async (url, init) => url === endpoint
            ? new Response('Permission denied', { status: 403 }) : fetch(url, init);
        await assert.rejects(f.edit(job), error => {
            assert.match(error.message, expected);
            assert.match(error.message, /\(403\): Permission denied/);
            return true;
        });
        assert.equal(f.saves.length, 0);
    }
});

test('supports arbitrary reference counts and both spellings for the first image', async () => {
    for (const count of [1, 4, 10, 17]) {
        const workflow = { 'prompt': { class_type: 'Text', inputs: { text: '%prompt%' } } };
        const sources = Array.from({ length: count }, (_, index) => {
            workflow[String(index)] = { class_type: 'Base64DecodeNode', inputs: { image: `%reference_image_${index + 1}%` } };
            return new Blob([`image ${index + 1}`], { type: 'image/png' });
        });
        const f = fixture({ workflow: JSON.stringify(workflow) });
        await f.edit({ ...input, reference: undefined, references: sources });
        const populated = JSON.parse(f.requests.find(r => r.url.endsWith('/generate')).body.prompt).prompt;
        for (let index = 0; index < count; index++) {
            assert.equal(populated[String(index)].inputs.image, Buffer.from(`image ${index + 1}`).toString('base64'));
        }
    }
});

test('reference mismatches fail before loading images or generating', async () => {
    const two = JSON.stringify({ ...graph, '3': { class_type: 'Loader', inputs: { image: '%reference_image_2%' } } });
    for (const [workflow, sources, error] of [
        [two, [reference], /requires a reference image.*%reference_image_2%/],
        [json, [reference, reference], /missing %reference_image_2%/],
        [two.replace('%reference_image_2%', '%reference_image_3%'), [reference, reference], /%reference_image_3%/],
        [json, [], /at least one/],
    ]) {
        let encoded = 0;
        const f = fixture({ workflow, deps: { encode: async () => { encoded++; return 'data:image/png;base64,YQ=='; } } });
        await assert.rejects(f.edit({ ...input, reference: sources }), error);
        assert.equal(encoded, 0);
        assert.ok(!f.requests.some(r => r.url.endsWith('/generate')));
    }
    await assert.rejects(fixture().edit({ ...input, references: [reference] }), /either reference or references/);
});

test('queued reference arrays are copied and invalid later images prevent generation', async () => {
    const two = JSON.stringify({ ...graph, '3': { class_type: 'Loader', inputs: { image: '%reference_image_2%' } } });
    const gate = deferred();
    const started = deferred();
    let count = 0;
    const f = fixture({ workflow: two, generate: async () => {
        if (++count === 1) { started.resolve(); await gate.promise; }
        return Response.json({ format: 'png', data: 'output' });
    } });
    const sources = [reference, new Blob(['second'], { type: 'image/webp' })];
    const first = f.edit({ ...input, reference: sources });
    await started.promise;
    const second = f.edit({ ...input, reference: sources });
    sources[1] = new Blob(['changed'], { type: 'text/plain' });
    sources.length = 1;
    gate.resolve();
    await Promise.all([first, second]);
    const jobs = f.requests.filter(r => r.url.endsWith('/generate'));
    assert.equal(JSON.parse(jobs[1].body.prompt).prompt['3'].inputs.image, Buffer.from('second').toString('base64'));
    const invalid = fixture({ workflow: two });
    await assert.rejects(invalid.edit({ ...input, reference: [reference, new Blob(['text'], { type: 'text/plain' })] }), /PNG, JPEG, or WebP/);
    assert.ok(!invalid.requests.some(r => r.url.endsWith('/generate')));
});


test('two-reference Flux example conditions on both images with the original models and output size', async () => {
    const text = await readFile(new URL('../workflows/flux2_9b_edit_2ref.json', import.meta.url), 'utf8');
    const original = JSON.parse(await readFile(new URL('../workflows/flux2_9b_edit.json', import.meta.url), 'utf8'));
    const f = fixture({ workflow: text });
    await f.edit({ ...input, reference: undefined, references: [
        new Blob(['person'], { type: 'image/png' }), new Blob(['outfit'], { type: 'image/webp' }),
    ] });
    const graph = JSON.parse(f.requests.find(r => r.url.endsWith('/generate')).body.prompt).prompt;
    for (const id of ['122', '123', '125', '126', '127', '128', '129', '130', '133', '137', '139']) {
        const expected = structuredClone(original[id]);
        if (id === '125') expected.inputs.noise_seed = input.seed;
        assert.deepEqual(graph[id], expected);
    }
    for (const branch of ['positive', 'negative']) {
        let link = graph['138'].inputs[branch];
        const images = [];
        while (graph[link[0]].class_type === 'ReferenceLatent') {
            const node = graph[link[0]];
            const encoder = graph[node.inputs.latent[0]];
            assert.equal(encoder.class_type, 'VAEEncode');
            assert.deepEqual(encoder.inputs.vae, ['127', 0]);
            const scale = graph[encoder.inputs.pixels[0]];
            assert.equal(scale.class_type, 'ImageScaleToTotalPixels');
            assert.equal(scale.inputs.megapixels, 1);
            const loader = graph[scale.inputs.image[0]];
            assert.equal(loader.class_type, 'Base64DecodeNode');
            images.unshift(loader.inputs.base64_string);
            link = node.inputs.conditioning;
        }
        assert.deepEqual(images, ['person', 'outfit'].map(value => Buffer.from(value).toString('base64')));
        assert.equal(graph[link[0]].class_type, branch === 'positive' ? 'CLIPTextEncode' : 'ConditioningZeroOut');
    }
    assert.deepEqual(graph['94'].inputs.images, ['124', 0]);
    assert.equal(Object.values(graph).filter(node => node.class_type === 'SaveImage').length, 1);
    assert.throws(() => populateWorkflow(text, { '%reference_image_1%': 'person', '%prompt%': 'edit', '%seed%': 12 }), /%reference_image_2%/);
});

test('host placeholders and macros preserve types and never expand replacement text again', async () => {
    const workflow = JSON.stringify({ ...graph, '3': { class_type: 'Settings', inputs: {
        steps: '%steps%', scale: '%scale%', custom: '%scene-description%', literal: 'unchanged',
    } } });
    const f = fixture({ workflow, deps: {
        getDefaults: () => ({ url: 'http://comfy.local', values: {
            '%steps%': 24, '%scale%': 4.5, '%scene-description%': 'Alice says "hello"\n%seed%',
        } }),
        expandMacros: text => text.replaceAll('{{char}}', 'Alice'),
    } });
    await f.edit({ ...input, prompt: '{{char}} smiles', negativePrompt: '{{char}} frowns' });
    const result = JSON.parse(f.requests.find(r => r.url.endsWith('/generate')).body.prompt).prompt;
    assert.equal(result['2'].inputs.prompt, 'Alice smiles');
    assert.equal(result['2'].inputs.negative, 'Alice frowns');
    assert.deepEqual(result['3'].inputs, {
        steps: 24, scale: 4.5, custom: 'Alice says "hello"\n%seed%', literal: 'unchanged',
    });
});

test('avatars load only when used in inputs and failed responses use the SD fallback image', async () => {
    for (const ok of [true, false]) {
        let fetches = 0;
        const avatar = '/user/images/avatar.png';
        const defaults = { url: 'http://comfy.local', avatars: {
            '%user_avatar%': avatar, '%char_avatar%': avatar,
        } };
        const f = fixture({
            workflow: JSON.stringify({ ...graph, '3': { class_type: 'Avatar', inputs: {
                user: '%user_avatar%', char: '%char_avatar%',
            } } }),
            deps: { getDefaults: () => defaults },
        });
        const backend = f.deps.fetch;
        f.deps.fetch = async (url, init) => {
            if (url !== avatar) return backend(url, init);
            fetches++;
            return new Response('avatar', { status: ok ? 200 : 404 });
        };
        await f.edit(input);
        const result = JSON.parse(f.requests.find(r => r.url.endsWith('/generate')).body.prompt).prompt;
        const expected = ok ? Buffer.from('avatar').toString('base64')
            : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
        assert.equal(result['3'].inputs.user, expected);
        assert.equal(result['3'].inputs.char, expected);
        assert.equal(fetches, 2);
        const unused = fixture({
            workflow: JSON.stringify({ ...graph, '3': { class_type: 'Unused', inputs: {}, _meta: { title: '%user_avatar%' } } }),
            deps: { getDefaults: () => defaults },
        });
        await unused.edit(input); // The fixture rejects any unexpected avatar request.
    }
});

test('queued jobs snapshot host placeholders and macros', async () => {
    const gate = deferred();
    const started = deferred();
    const defaults = { url: 'http://comfy.local', values: { '%steps%': 20 } };
    let character = 'Alice';
    let count = 0;
    const f = fixture({
        workflow: JSON.stringify({ ...graph, '3': { class_type: 'Settings', inputs: { steps: '%steps%' } } }),
        deps: { getDefaults: () => defaults, expandMacros: text => text.replaceAll('{{char}}', character) },
        generate: async () => {
            if (++count === 1) { started.resolve(); await gate.promise; }
            return Response.json({ format: 'png', data: 'output' });
        },
    });
    const first = f.edit(input);
    await started.promise;
    const second = f.edit({ ...input, prompt: '{{char}} smiles' });
    defaults.values['%steps%'] = 99;
    character = 'Bob';
    gate.resolve();
    await Promise.all([first, second]);
    const result = JSON.parse(f.requests.filter(r => r.url.endsWith('/generate'))[1].body.prompt).prompt;
    assert.equal(result['2'].inputs.prompt, 'Alice smiles');
    assert.equal(result['3'].inputs.steps, 20);
});
