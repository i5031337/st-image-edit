// Explicit manual smoke test. Never run by npm test: this submits one real GPU job.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createEditor } from '../editor.js';
import { populateWorkflow } from '../workflow.js';

const run = promisify(execFile);
const origin = 'http://127.0.0.1:8000';
const scratch = '/tmp/st-image-edit-smoke';
await mkdir(scratch, { recursive: true });
const cookies = `${scratch}/cookies`;
const temporaryFiles = [cookies];
process.once('exit', () => {
    for (const path of temporaryFiles) rmSync(path, { force: true });
});
const csrfResult = await run('curl', ['-sS', '-c', cookies, `${origin}/csrf-token`]);
const { token } = JSON.parse(csrfResult.stdout);
if (!token) throw new Error('Could not establish ST CSRF session.');
const headersFile = `${scratch}/headers`;
temporaryFiles.push(headersFile);
await writeFile(headersFile, `Content-Type: application/json\nX-CSRF-Token: ${token}\n`, { mode: 0o600 });

let sequence = 0;
const requests = [];
async function hostFetch(url, init = {}) {
    const fullUrl = new URL(url, origin);
    if (fullUrl.origin !== origin) throw new Error('Smoke test only permits ST requests.');
    if (init.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const args = ['-sS', '-b', cookies, '-w', '\n%{http_code}\n%{content_type}'];
    if (init.method) args.push('-X', init.method);
    if (init.body) {
        const payload = `${scratch}/request-${++sequence}.json`;
        temporaryFiles.push(payload);
        await writeFile(payload, init.body, { mode: 0o600 });
        args.push('-H', `@${headersFile}`, '--data-binary', `@${payload}`);
    }
    requests.push(fullUrl.pathname);
    args.push(fullUrl.href);
    const { stdout } = await run('curl', args, { maxBuffer: 60 * 1024 * 1024 });
    const mimeBreak = stdout.lastIndexOf('\n');
    const statusBreak = stdout.lastIndexOf('\n', mimeBreak - 1);
    return new Response(stdout.slice(0, statusBreak), {
        status: Number(stdout.slice(statusBreak + 1, mimeBreak)),
        headers: { 'Content-Type': stdout.slice(mimeBreak + 1) },
    });
}

const sd = JSON.parse(await readFile(new URL('../../../../../../data/default-user/settings.json', import.meta.url), 'utf8')).extension_settings.sd;
const workflow = await readFile(new URL('../workflows/anima_ip_adapter_image_edit.json', import.meta.url), 'utf8');
populateWorkflow(workflow, {
    '%reference_image%': 'validation-only', '%prompt%': 'validation-only',
    '%negative_prompt%': '', '%seed%': 12345, '%width%': sd.width, '%height%': sd.height,
});
const workflowName = 'anima_ip_adapter_image_edit.json';
const installed = await hostFetch('/api/sd/comfy/save-workflow', {
    method: 'POST', body: JSON.stringify({ file_name: workflowName, workflow }),
});
if (!installed.ok) throw new Error(`Could not save workflow (${installed.status}).`);

// Supply a Blob to exercise the same encoding path as browser File/Blob callers.
const referenceFile = new URL('../../../../../../data/default-user/characters/Narrator/isolde/neutral.png', import.meta.url);
const reference = new Blob([await readFile(referenceFile)], { type: 'image/png' });
const edit = createEditor({
    origin, fetch: hostFetch, headers: () => ({}),
    getDefaults: () => ({ url: sd.comfy_url, workflow: sd.comfy_workflow, width: sd.width, height: sd.height }),
    encode: async blob => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`,
    randomSeed: () => 12345, makeId: randomUUID,
    save: async (image, ch_name, filename, format) => {
        const response = await hostFetch('/api/images/upload', {
            method: 'POST', body: JSON.stringify({ image, ch_name, filename, format }),
        });
        if (!response.ok) throw new Error(`Could not save result (${response.status}).`);
        return (await response.json()).path;
    },
});
console.log('Running one reference-guided generation through the ST proxy…');
const url = await edit({
    reference, workflow: workflowName, seed: 12345,
    prompt: '1girl, solo, adult woman, brown hair, braided hair, brown eyes, tan skin, white crop top, blue athletic shorts, standing, looking at viewer, upper thighs visible, amused smile, same character and outfit as the reference, anime illustration',
    negativePrompt: 'different clothes, different hair color, extra fingers, extra limbs, duplicate, text, watermark',
});
const downloaded = `${scratch}/result.png`;
await run('curl', ['-sS', '-f', '-b', cookies, '-o', downloaded, new URL(url, origin).href]);
console.log(JSON.stringify({ url, downloaded, requests }, null, 2));
