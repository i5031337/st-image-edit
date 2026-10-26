import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

test('command resolves references and handles posting, failures, chat switches and cancellation', async () => {
    const commands = [];
    const saves = [];
    const errors = [];
    const warnings = [];
    const messages = [];
    const rendered = [];
    const events = [];
    const references = [];
    const workflowRequests = [];
    let chatId = 'original-chat';
    let characterId = 1;
    let chatSaves = 0;
    let onGenerate = () => {};
    let generationCount = 0;
    const composer = { files: [] };
    const sd = { comfy_url: 'http://comfy.local:8188', comfy_workflow: 'normal.json', width: 704, height: 1280 };
    const originalSettings = { ...sd };
    const workflow = JSON.stringify({
        '1': { class_type: 'ETN_LoadImageBase64', inputs: { image: '%reference_image%' } },
        '2': { class_type: 'EditingFixture', inputs: { prompt: '%prompt%', width: '%width%', height: '%height%' } },
    });
    const context = vm.createContext({
        Blob, URL, AbortController, DOMException, Uint32Array,
        crypto: webcrypto, location: { origin: 'http://st.local' },
        document: { getElementById: id => id === 'file_form_input' ? composer : null },
        toastr: {
            error: (...args) => errors.push(args),
            warning: (...args) => warnings.push(args),
        },
        fetch: async (url, init) => {
            assert.ok(url.startsWith('/api/sd/comfy/') || url.startsWith('data:') || url.startsWith('http://st.local/user/images/'));
            if (url.startsWith('data:')) return fetch(url, init);
            if (url.startsWith('http://st.local/user/images/')) {
                return new Response('saved reference', { headers: { 'Content-Type': 'image/png' } });
            }
            if (url.endsWith('/workflows')) return Response.json(['Edit.json', 'normal.json']);
            if (url.endsWith('/workflow')) {
                workflowRequests.push(JSON.parse(init.body).file_name);
                return Response.json(workflow);
            }
            assert.equal(url, '/api/sd/comfy/generate');
            const graph = JSON.parse(JSON.parse(init.body).prompt);
            assert.equal(graph.prompt['2'].inputs.width, 832);
            assert.equal(graph.prompt['2'].inputs.height, 1216);
            references.push(graph.prompt['1'].inputs.image);
            generationCount++;
            onGenerate();
            return Response.json({ format: 'png', data: 'result-bytes' });
        },
    });
    const props = { fromProps: value => value };
    const host = {
        '../../../../script.js': {
            getRequestHeaders: () => ({}),
            getMediaIndex: message => message.extra?.media_index ?? 0,
            event_types: { MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
            eventSource: { emit: async (...args) => events.push(args) },
        },
        '../../../extensions.js': {
            extension_settings: { sd },
            getContext: () => ({
                chat: messages, characterId, groupId: null,
                getCurrentChatId: () => chatId,
                addOneMessage: message => rendered.push(message),
                saveChat: async () => { chatSaves++; },
            }),
        },
        '../../../RossAscends-mods.js': { getMessageTimeStamp: () => 'fixture-timestamp' },
        '../../../macros.js': { getLastMessageId: () => messages.length ? messages.length - 1 : null },
        '../../../constants.js': {
            MEDIA_TYPE: { IMAGE: 'image' }, MEDIA_DISPLAY: { GALLERY: 'gallery' },
            MEDIA_SOURCE: { GENERATED: 'generated' },
        },
        '../../../utils.js': {
            isTrueBoolean: value => String(value).toLowerCase() === 'true',
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
            ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'bool' },
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
    assert.equal(commands[0].namedArgumentList.find(arg => arg.name === 'workflow').isRequired, false);
    assert.deepEqual(Array.from(commands[0].namedArgumentList.find(arg => arg.name === 'attached').typeList), ['bool']);
    const args = { reference: 'data:image/png;base64,Ynl0ZXM=', workflow: 'Edit.json', width: '832', height: '1216', chat: false };
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
    assert.equal(messages.length, 0);
    assert.equal(chatSaves, 0);

    const postedUrl = await commands[0].callback({ ...args, chat: 'true' }, 'smile');
    assert.equal(messages.length, 1);
    assert.equal(rendered[0], messages[0]);
    assert.equal(messages[0].is_system, true);
    assert.equal(messages[0].extra.media[0].url, postedUrl);
    assert.equal(messages[0].extra.media[0].title, 'smile');
    assert.equal(messages[0].extra.media[0].type, 'image');
    assert.equal(chatSaves, 1);
    assert.deepEqual(events, [['received', 0, 'extension'], ['rendered', 0, 'extension']]);

    await commands[0].callback({ ...args, chat: 'false' }, 'smile');
    await entry.namespace.edit({
        reference: args.reference, workflow: args.workflow, prompt: 'smile',
        width: args.width, height: args.height, chat: true,
    });
    assert.equal(messages.length, 1);
    assert.equal(chatSaves, 1);

    onGenerate = () => { chatId = 'another-chat'; };
    const switchedUrl = await commands[0].callback({ ...args, chat: true }, 'smile');
    assert.match(switchedUrl, /^\/user\/images\//);
    assert.equal(messages.length, 1);
    assert.equal(chatSaves, 1);
    assert.equal(warnings.length, 1);
    onGenerate = () => { characterId = 2; };
    await commands[0].callback({ ...args, chat: true }, 'smile');
    assert.equal(messages.length, 1);
    assert.equal(warnings.length, 2);

    const count = generationCount;
    chatId = null;
    await assert.rejects(commands[0].callback({ ...args, chat: true }, 'smile'), /Open a chat/);
    assert.equal(generationCount, count);
    assert.equal(messages.length, 1);
    assert.deepEqual(sd, originalSettings);

    // Model ST's EventTarget controller with its non-native signal object.
    chatId = 'original-chat';
    onGenerate = () => {};
    const errorsBeforeCancel = errors.length;
    const stController = new EventTarget();
    stController.signal = { aborted: false };
    const cancelled = commands[0].callback({ ...args, chat: true, _abortController: stController }, 'smile');
    const rejection = assert.rejects(cancelled, error => error.name === 'AbortError');
    stController.signal.aborted = true;
    stController.dispatchEvent(new Event('abort'));
    await rejection;
    assert.equal(generationCount, count);
    assert.equal(errors.length, errorsBeforeCancel);
    assert.equal(messages.length, 1);
    assert.equal(chatSaves, 1);

    const selectedImage = 'data:image/png;base64,c2VsZWN0ZWQ=';
    const legacyImage = 'data:image/png;base64,bGVnYWN5';
    messages.push(
        { extra: { media: [{ type: 'image', url: args.reference }, { type: 'image', url: selectedImage }], media_index: 1 } },
        { extra: { image: legacyImage } },
        { extra: { media: [{ type: 'video', url: '/video.webm' }] } },
    );
    const fromMessage = { ...args, reference: undefined, message: '1' };
    const snapshot = JSON.stringify(messages);
    await commands[0].callback({ ...fromMessage, message: 0 }, 'smile');
    assert.equal(references.at(-1), Buffer.from('saved reference').toString('base64'));
    await commands[0].callback(fromMessage, 'smile');
    assert.equal(references.at(-1), 'c2VsZWN0ZWQ=');
    await commands[0].callback({ ...fromMessage, message: 2 }, 'smile');
    assert.equal(references.at(-1), 'bGVnYWN5');
    assert.equal(JSON.stringify(messages), snapshot);

    // Resolve the URL before awaiting the job, rather than re-reading a live message.
    const pending = commands[0].callback(fromMessage, 'smile');
    messages[1].extra.media[1].url = args.reference;
    await pending;
    assert.equal(references.at(-1), 'c2VsZWN0ZWQ=');

    messages[1].extra.media_index = 0;
    messages[1].extra.media[0] = { type: 'video', url: '/video.webm' };
    messages[1].extra.media[1].url = selectedImage;
    await commands[0].callback(fromMessage, 'smile');
    assert.equal(references.at(-1), 'c2VsZWN0ZWQ=');

    const countBeforeInvalidMessage = generationCount;
    for (const value of [-1, 1.5, 'bad', '', null, true, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(commands[0].callback({ ...fromMessage, message: value }, 'smile'), /Message ID/);
    }
    await assert.rejects(commands[0].callback({ ...fromMessage, message: 99 }, 'smile'), /does not exist/);
    await assert.rejects(commands[0].callback({ ...fromMessage, message: 3 }, 'smile'), /no attached image/);
    await assert.rejects(commands[0].callback({ ...args, message: 1 }, 'smile'), /exactly one/);
    await assert.rejects(commands[0].callback({ ...args, reference: undefined }, 'smile'), /no attached image/);
    chatId = null;
    await assert.rejects(commands[0].callback(fromMessage, 'smile'), /Open a chat/);
    assert.equal(generationCount, countBeforeInvalidMessage);
    assert.equal(chatSaves, 1);

    await commands[0].callback({ ...args, workflow: undefined }, 'smile');
    assert.equal(workflowRequests.at(-1), 'normal.json');
    assert.deepEqual(sd, originalSettings);

    const fromAttachment = { ...args, reference: undefined, attached: 'true' };
    const attachment = new Blob(['composer image'], { type: 'image/png' });
    const textFile = new Blob(['notes'], { type: 'text/plain' });
    composer.files = [textFile, attachment];
    const originalFiles = composer.files;
    await commands[0].callback(fromAttachment, 'smile');
    assert.equal(references.at(-1), Buffer.from('composer image').toString('base64'));
    assert.equal(composer.files, originalFiles);
    assert.equal(messages.length, 4);
    assert.equal(chatSaves, 1);

    // Clearing or replacing the composer cannot change an already accepted reference.
    const attachedPending = commands[0].callback(fromAttachment, 'smile');
    composer.files = [];
    await attachedPending;
    assert.equal(references.at(-1), Buffer.from('composer image').toString('base64'));

    const beforeInvalidAttachment = generationCount;
    await assert.rejects(commands[0].callback(fromAttachment, 'smile'), /Open a chat/);
    composer.files = [textFile];
    await assert.rejects(commands[0].callback(fromAttachment, 'smile'), /Open a chat/);
    composer.files = [attachment, attachment];
    await assert.rejects(commands[0].callback(fromAttachment, 'smile'), /exactly one image/);
    composer.files = [new Blob(['gif'], { type: 'image/gif' })];
    await assert.rejects(commands[0].callback(fromAttachment, 'smile'), /PNG, JPEG, or WebP/);
    composer.files = [attachment];
    await assert.rejects(commands[0].callback({ ...args, attached: true }, 'smile'), /exactly one/);
    await assert.rejects(commands[0].callback({ ...fromAttachment, message: 1 }, 'smile'), /exactly one/);
    assert.equal(generationCount, beforeInvalidAttachment);

    await commands[0].callback({ ...args, attached: 'false' }, 'smile');
    assert.equal(references.at(-1), 'Ynl0ZXM=');
    chatId = 'original-chat';
    const attachedPosted = await commands[0].callback({ ...fromAttachment, chat: true }, 'smile');
    assert.equal(messages.at(-1).extra.media[0].url, attachedPosted);
    assert.equal(composer.files[0], attachment);

    // Defaults select the composer and post to chat without any source/chat arguments.
    const automatic = { ...args, reference: undefined, chat: undefined };
    const defaultPosted = await commands[0].callback(automatic, 'smile');
    assert.equal(references.at(-1), Buffer.from('composer image').toString('base64'));
    assert.equal(messages.at(-1).extra.media[0].url, defaultPosted);
    assert.equal(composer.files[0], attachment);

    // Explicit sources still override the composer when attached= is omitted.
    await commands[0].callback(args, 'smile');
    assert.equal(references.at(-1), 'Ynl0ZXM=');
    await commands[0].callback(fromMessage, 'smile');
    assert.equal(references.at(-1), 'c2VsZWN0ZWQ=');

    // attached=false skips the composer and uses exactly the last message.
    messages.push({ extra: { image: legacyImage } });
    await commands[0].callback({ ...automatic, attached: false, chat: false }, 'smile');
    assert.equal(references.at(-1), 'bGVnYWN5');

    // Missing composer images fall back for both implicit and explicit attached=true.
    for (const files of [[], [textFile]]) {
        composer.files = files;
        for (const attached of [undefined, 'true']) {
            await commands[0].callback({ ...automatic, attached, chat: 'false' }, 'smile');
            assert.equal(references.at(-1), 'bGVnYWN5');
        }
    }
    messages.push({ mes: 'No image on the last message' });
    const beforeMissingImages = generationCount;
    await assert.rejects(commands[0].callback(automatic, 'smile'), /no attached image/);
    assert.equal(generationCount, beforeMissingImages);

    // A composer image succeeds even when the last message has no image.
    composer.files = [attachment];
    await commands[0].callback({ ...automatic, chat: false }, 'smile');
    assert.equal(references.at(-1), Buffer.from('composer image').toString('base64'));

    composer.files = [];
    messages.length = 0;
    await assert.rejects(commands[0].callback(automatic, 'smile'), /No reference image found/);
});
