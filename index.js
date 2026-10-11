import { eventSource, event_types, getMediaIndex, getRequestHeaders } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getBase64Async, isTrueBoolean, saveBase64AsFile } from '../../../utils.js';
import { getMessageTimeStamp } from '../../../RossAscends-mods.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } from '../../../constants.js';
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
        workflow: extension_settings.sd?.comfy_workflow,
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
        if (args.reference !== undefined && args.message !== undefined) {
            throw new Error('Supply exactly one of reference= and message=.');
        }
        const reference = args.message === undefined ? args.reference : messageReference(args.message);
        if (!reference) throw new Error('Supply reference= or message= for the reference image.');
        const target = isTrueBoolean(args.chat) ? getContext() : null;
        const chatId = target?.getCurrentChatId();
        if (target && !chatId) throw new Error('Open a chat before using chat=true.');
        const prompt = args.prompt ?? String(text ?? '');
        const url = await edit({
            reference,
            workflow: args.workflow,
            prompt,
            negativePrompt: args.negative ?? '',
            seed: args.seed,
            width: args.width,
            height: args.height,
            signal: controller.signal,
        });
        if (target) await postImage(url, prompt, target, chatId);
        return url;
    } catch (error) {
        if (error.name !== 'AbortError') toastr.error(error.message, 'Image Edit');
        throw error;
    } finally {
        args._abortController?.removeEventListener('abort', abort);
    }
}

function messageReference(value) {
    const id = Number(value);
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(id)) {
        throw new Error('Message ID must be a nonnegative integer.');
    }
    const context = getContext();
    if (!context.getCurrentChatId()) throw new Error('Open a chat before using message=.');
    const message = context.chat[id];
    if (!message) throw new Error(`Message ${id} does not exist in the current chat.`);
    const media = Array.isArray(message.extra?.media) ? message.extra.media : [];
    const selected = media[getMediaIndex(message)];
    const image = selected?.type === MEDIA_TYPE.IMAGE ? selected : media.find(item => item?.type === MEDIA_TYPE.IMAGE);
    const url = image?.url ?? message.extra?.image;
    if (typeof url !== 'string' || !url) throw new Error(`Message ${id} has no attached image.`);
    return url;
}

async function postImage(url, prompt, target, chatId) {
    const context = getContext();
    if (context.getCurrentChatId() !== chatId || context.characterId !== target.characterId
        || context.groupId !== target.groupId) {
        toastr.warning(`Image saved to ${url}. Chat changed; image was not posted.`, 'Image Edit');
        return;
    }
    const message = {
        name: 'Image Edit', is_user: false, is_system: true,
        send_date: getMessageTimeStamp(), mes: '',
        extra: {
            media: [{ url, title: prompt, type: MEDIA_TYPE.IMAGE, source: MEDIA_SOURCE.GENERATED }],
            media_display: MEDIA_DISPLAY.GALLERY, media_index: 0, inline_image: false,
        },
    };
    context.chat.push(message);
    const messageId = context.chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
    context.addOneMessage(message);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await context.saveChat();
}

const argument = (name, description, required = false, type = ARGUMENT_TYPE.STRING) =>
    SlashCommandNamedArgument.fromProps({ name, description, typeList: [type], isRequired: required });

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'image-edit',
    callback: command,
    returns: 'Saved image URL. Add chat=true to also post it to the current chat.',
    namedArgumentList: [
        argument('reference', 'Same-origin image URL or base64 image data URL (alternative to message=)'),
        argument('message', 'Message ID in the current chat to take the reference image from', false, ARGUMENT_TYPE.NUMBER),
        argument('workflow', 'Saved workflow filename (defaults to the active ST ComfyUI workflow)'),
        argument('prompt', 'Editing instruction (alternatively use trailing text)'),
        argument('negative', 'Optional negative prompt'),
        argument('seed', 'Optional nonnegative integer seed', false, ARGUMENT_TYPE.NUMBER),
        argument('width', 'Width in pixels for %width% (defaults to ST Image Generation)', false, ARGUMENT_TYPE.NUMBER),
        argument('height', 'Height in pixels for %height% (defaults to ST Image Generation)', false, ARGUMENT_TYPE.NUMBER),
        argument('chat', 'Also post the output to the current chat (default: false)', false, ARGUMENT_TYPE.BOOLEAN),
    ],
    unnamedArgumentList: [SlashCommandArgument.fromProps({
        description: 'Editing instruction when prompt= is omitted', typeList: [ARGUMENT_TYPE.STRING],
        isRequired: false,
    })],
    helpString: '<p>Edit a reference using a saved ComfyUI workflow. Supply reference= or message= (zero-based chat message ID). Workflow defaults to the active ST ComfyUI workflow; use workflow= to override. Returns a saved URL; add chat=true to also post it.</p><p>Required inputs: %reference_image% (raw base64), %prompt%. Optional: %negative_prompt%, %seed%, %width%, %height%. Each placeholder fills a whole JSON string value. Dimensions default to ST Image Generation settings; literal workflow dimensions stay unchanged.</p><p><code>/image-edit message=12 chat=true width=704 height=1280 Give her an amused smile.</code></p>',
}));
