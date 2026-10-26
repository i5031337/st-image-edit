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
    return { edit: createEditor(deps), requests, saves };
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
