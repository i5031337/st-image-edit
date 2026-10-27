import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { isHeicBlob, isHeicFile, stripReferenceMetadata } from '../image.js';
import { createEditor } from '../editor.js';

function chunk(type, data = Buffer.alloc(0)) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
}

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0);
header.writeUInt32BE(1, 4);
header[8] = 8;
header[9] = 6; // RGBA, including a partially transparent pixel.
const pixels = chunk('IDAT', deflateSync(Buffer.from([0, 120, 80, 40, 128])));
const profile = chunk('iCCP', Buffer.concat([Buffer.from('profile\0\0'), deflateSync(Buffer.from('profile bytes'))]));
const start = Buffer.concat([signature, chunk('IHDR', header), profile]);
const end = chunk('IEND');
const clean = Buffer.concat([start, pixels, end]);
const annotated = Buffer.concat([
    start,
    chunk('tEXt', Buffer.from('prompt\0{"reference":"previous-image"}')),
    chunk('zTXt', Buffer.concat([Buffer.from('workflow\0\0'), deflateSync(Buffer.from('old workflow'))])),
    pixels,
    chunk('iTXt', Buffer.from('description\0\0\0\0\0previous edit')),
    end,
]);

test('recognizes HEIC MIME, filenames, and container signatures without mistaking AVIF for HEIC', async () => {
    assert.ok(isHeicFile({ type: '', name: 'IMG_1234.HEIC' }));
    assert.ok(isHeicFile({ type: 'application/octet-stream', name: 'photo.heif' }));
    assert.ok(isHeicFile({ type: 'image/heic-sequence' }));
    assert.equal(isHeicFile({ type: '', name: 'photo.heic.txt' }), false);
    for (const brand of ['heic', 'heix', 'mif1', 'msf1']) {
        assert.ok(await isHeicBlob(new Blob([Buffer.from([0, 0, 0, 24]), `ftyp${brand}`])));
    }
    for (const bytes of ['xxxxftypavif', 'xxxxnopeheic', 'heic', '']) {
        assert.equal(await isHeicBlob(new Blob([bytes])), false);
    }
});

test('removes every PNG text chunk and preserves all other bytes and the original', async () => {
    const original = new Blob([annotated], { type: 'image/png' });
    const stripped = await stripReferenceMetadata(original);
    assert.equal(stripped.type, 'image/png');
    assert.deepEqual(Buffer.from(await stripped.arrayBuffer()), clean);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), annotated);
    assert.equal(await stripReferenceMetadata(stripped), stripped);
});

test('passes non-PNG formats through unchanged and rejects truncated PNG chunks', async () => {
    for (const type of ['image/jpeg', 'image/webp']) {
        const blob = new Blob(['unchanged'], { type });
        assert.equal(await stripReferenceMetadata(blob), blob);
    }
    for (const bytes of [Buffer.concat([signature, Buffer.from([0])]), annotated.subarray(0, -1), start]) {
        await assert.rejects(stripReferenceMetadata(new Blob([bytes])), /Reference PNG/);
    }
});

test('cleans only incoming references from files, URLs, and data URLs; saves output metadata intact', async () => {
    const original = new Blob([annotated], { type: 'image/png' });
    const output = annotated.toString('base64');
    for (const reference of [original, '/reference.png', `data:image/png;base64,${output}`]) {
        let saved;
        const edit = createEditor({
            origin: 'http://st.local',
            getDefaults: () => ({ url: 'http://comfy.local', workflow: 'Edit.json' }),
            headers: () => ({}), randomSeed: () => 1, makeId: () => 'id',
            encode: async blob => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`,
            save: async data => { saved = data; return '/user/images/result.png'; },
            fetch: async (url, init) => {
                if (url.startsWith('data:')) return fetch(url);
                if (url === 'http://st.local/reference.png') return new Response(original);
                if (url.endsWith('/workflows')) return Response.json(['Edit.json']);
                if (url.endsWith('/workflow')) return Response.json(JSON.stringify({
                    '1': { class_type: 'Edit', inputs: { image: '%reference_image%', prompt: '%prompt%' } },
                }));
                assert.equal(url, '/api/sd/comfy/generate');
                const graph = JSON.parse(JSON.parse(init.body).prompt).prompt;
                assert.deepEqual(Buffer.from(graph['1'].inputs.image, 'base64'), clean);
                return Response.json({ format: 'png', data: output });
            },
        });
        await edit({ reference, prompt: 'edit' });
        assert.equal(saved, output);
    }
});
