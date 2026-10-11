import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

test('host entry registers one command, returns URL quietly, reports failures and bridges ST cancellation', async () => {
    const commands = [];
    const saves = [];
    const errors = [];
    let generationCount = 0;
    const sd = { comfy_url: 'http://comfy.local:8188', comfy_workflow: 'normal.json', width: 704, height: 1280 };
    const originalSettings = { ...sd };
    const workflow = JSON.stringify({
        '1': { class_type: 'ETN_LoadImageBase64', inputs: { image: '%reference_image%' } },
        '2': { class_type: 'EditingFixture', inputs: { prompt: '%prompt%', width: '%width%', height: '%height%' } },
    });
    const context = vm.createContext({
        Blob, URL, AbortController, DOMException, Uint32Array,
        crypto: webcrypto, location: { origin: 'http://st.local' },
        toastr: { error: (...args) => errors.push(args) },
        fetch: async (url, init) => {
            assert.ok(url.startsWith('/api/sd/comfy/') || url.startsWith('data:'));
            if (url.startsWith('data:')) return fetch(url, init);
            if (url.endsWith('/workflows')) return Response.json(['Edit.json']);
            if (url.endsWith('/workflow')) return Response.json(workflow);
            assert.equal(url, '/api/sd/comfy/generate');
            const graph = JSON.parse(JSON.parse(init.body).prompt);
            assert.equal(graph.prompt['2'].inputs.width, 832);
            assert.equal(graph.prompt['2'].inputs.height, 1216);
            generationCount++;
            return Response.json({ format: 'png', data: 'result-bytes' });
        },
    });
    const props = { fromProps: value => value };
    const host = {
        '../../../../script.js': { getRequestHeaders: () => ({}) },
        '../../../extensions.js': { extension_settings: { sd } },
        '../../../utils.js': {
            getBase64Async: async blob => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`,
            saveBase64AsFile: async (...args) => {
                saves.push(args);
                return `/user/images/image-edit/${args[2]}.${args[3]}`;
            },
        },
        '../../../slash-commands/SlashCommandParser.js': {
            SlashCommandParser: { addCommandObject: command => commands.push(command) },
        },
        '../../../slash-commands/SlashCommand.js': { SlashCommand: props },
        '../../../slash-commands/SlashCommandArgument.js': {
            ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number' },
            SlashCommandArgument: props, SlashCommandNamedArgument: props,
        },
    };
    const cache = new Map();
    async function sourceModule(filename) {
        if (cache.has(filename)) return cache.get(filename);
        const source = await readFile(new URL(`../${filename}`, import.meta.url), 'utf8');
        const module = new vm.SourceTextModule(source, { context, identifier: filename });
        cache.set(filename, module);
        await module.link(async specifier => {
            if (host[specifier]) {
                const exports = host[specifier];
                return new vm.SyntheticModule(Object.keys(exports), function () {
                    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
                }, { context });
            }
            return sourceModule(specifier.replace('./', ''));
        });
        return module;
    }
    const entry = await sourceModule('index.js');
    await entry.evaluate();
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, 'image-edit');
    const args = { reference: 'data:image/png;base64,Ynl0ZXM=', workflow: 'Edit.json', width: '832', height: '1216' };
    for (const name of ['width', 'height']) {
        assert.deepEqual(Array.from(commands[0].namedArgumentList.find(arg => arg.name === name).typeList), ['number']);
    }
    const url = await commands[0].callback(args, 'smile');
    assert.match(url, /^\/user\/images\/image-edit\/[a-f0-9-]+\.png$/);
    assert.equal(saves.length, 1);
    assert.equal(typeof entry.namespace.edit, 'function');
    assert.deepEqual(sd, originalSettings);
    await assert.rejects(commands[0].callback({ ...args, workflow: 'missing.json' }, 'smile'), /not found/);
    assert.equal(errors.length, 1);

    // Model ST's EventTarget controller with its non-native signal object.
    const stController = new EventTarget();
    stController.signal = { aborted: false };
    const cancelled = commands[0].callback({ ...args, _abortController: stController }, 'smile');
    const rejection = assert.rejects(cancelled, error => error.name === 'AbortError');
    stController.signal.aborted = true;
    stController.dispatchEvent(new Event('abort'));
    await rejection;
    assert.equal(generationCount, 1);
    assert.equal(errors.length, 1);
});
