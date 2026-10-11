import { getRequestHeaders } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getBase64Async, saveBase64AsFile } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { createEditor } from './editor.js';

// Other extensions may import this function directly; it returns the saved URL.
export const edit = createEditor({
    fetch: (...args) => fetch(...args),
    headers: getRequestHeaders,
    getDefaults: () => ({
        url: extension_settings.sd?.comfy_url?.trim(),
        width: extension_settings.sd?.width,
        height: extension_settings.sd?.height,
    }),
    encode: getBase64Async,
    save: saveBase64AsFile,
    origin: location.origin,
    makeId: () => crypto.randomUUID(),
    randomSeed: () => {
        const words = crypto.getRandomValues(new Uint32Array(2));
        return (words[0] & 0x1fffff) * 0x100000000 + words[1];
    },
});

async function command(args, text) {
    // ST's abort controller is an EventTarget; its signal is not a native AbortSignal.
    const controller = new AbortController();
    const abort = () => controller.abort();
    args._abortController?.addEventListener('abort', abort);
    if (args._abortController?.signal.aborted) abort();
    try {
        return await edit({
            reference: args.reference,
            workflow: args.workflow,
            prompt: args.prompt ?? String(text ?? ''),
            negativePrompt: args.negative ?? '',
            seed: args.seed,
            width: args.width,
            height: args.height,
            signal: controller.signal,
        });
    } catch (error) {
        if (error.name !== 'AbortError') toastr.error(error.message, 'Image Edit');
        throw error;
    } finally {
        args._abortController?.removeEventListener('abort', abort);
    }
}

const argument = (name, description, required = false, type = ARGUMENT_TYPE.STRING) =>
    SlashCommandNamedArgument.fromProps({ name, description, typeList: [type], isRequired: required });

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'image-edit',
    callback: command,
    returns: 'Saved image URL. Errors stop the command; no image is posted to chat.',
    namedArgumentList: [
        argument('reference', 'Same-origin image URL or base64 image data URL', true),
        argument('workflow', 'Saved ComfyUI API-format workflow filename', true),
        argument('prompt', 'Editing instruction (alternatively use trailing text)'),
        argument('negative', 'Optional negative prompt'),
        argument('seed', 'Optional nonnegative integer seed', false, ARGUMENT_TYPE.NUMBER),
        argument('width', 'Width in pixels for %width% (defaults to ST Image Generation)', false, ARGUMENT_TYPE.NUMBER),
        argument('height', 'Height in pixels for %height% (defaults to ST Image Generation)', false, ARGUMENT_TYPE.NUMBER),
    ],
    unnamedArgumentList: [SlashCommandArgument.fromProps({
        description: 'Editing instruction when prompt= is omitted', typeList: [ARGUMENT_TYPE.STRING],
        isRequired: false,
    })],
    helpString: '<p>Edit a reference using a saved ComfyUI workflow. Returns a saved URL without posting.</p><p>Required inputs: %reference_image% (raw base64), %prompt%. Optional: %negative_prompt%, %seed%, %width%, %height%. Each placeholder fills a whole JSON string value. Dimensions default to ST Image Generation settings; literal workflow dimensions stay unchanged.</p><p><code>/image-edit reference="/user/images/reference.png" workflow="Edit.json" width=704 height=1280 Give her an amused smile.</code></p>',
}));
