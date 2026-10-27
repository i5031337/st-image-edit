import { eventSource, event_types, getMediaIndex, getRequestHeaders } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getBase64Async, isTrueBoolean, saveBase64AsFile, uuidv4 } from '../../../utils.js';
import { getMessageTimeStamp } from '../../../RossAscends-mods.js';
import { getLastMessageId } from '../../../macros.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } from '../../../constants.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { createEditor } from './editor.js';
import { isHeicFile } from './image.js';

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
    makeId: uuidv4,
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
        const attached = isTrueBoolean(args.attached);
        const explicit = args.reference !== undefined || args.message !== undefined;
        // Group sources in workflow order; capture every input before awaiting the job.
        const reference = [];
        if (attached || (args.attached === undefined && !explicit)) {
            reference.push(...(attachedReference() ?? []));
        }
        if (args.message !== undefined) {
            reference.push(...(Array.isArray(args.message) ? args.message : [args.message]).map(messageReference));
        }
        if (args.reference !== undefined) {
            reference.push(...(Array.isArray(args.reference) ? args.reference : [args.reference]));
        }
        if (!explicit && !reference.length) reference.push(lastMessageReference());
        if (!reference.length) throw new Error('No reference image found. Attach an image or use reference= or message=.');
        const target = args.chat === undefined || isTrueBoolean(args.chat) ? getContext() : null;
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

function attachedReference() {
    // Capture the File now: the composer may be cleared or changed while the job waits.
    const files = Array.from(document.getElementById('file_form_input')?.files ?? []);
    const images = files.filter(file => file.type.toLowerCase().startsWith('image/') || isHeicFile(file));
    return images.length ? images : undefined;
}

function lastMessageReference() {
    const id = getLastMessageId();
    if (id === null) throw new Error('No reference image found in the composer or last chat message.');
    return messageReference(id);
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

const argument = (name, description, required = false, type = ARGUMENT_TYPE.STRING, acceptsMultiple = false) =>
    SlashCommandNamedArgument.fromProps({ name, description, typeList: [type], isRequired: required, acceptsMultiple });

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'image-edit',
    callback: command,
    returns: 'Saved image URL. Posts to the current chat by default; use chat=false for URL only.',
    namedArgumentList: [
        argument('reference', 'Image URL or base64 data URL; repeat reference= for multiple images in order', false, ARGUMENT_TYPE.STRING, true),
        argument('message', 'Message ID to take the selected image from; repeat message= for multiple images in order', false, ARGUMENT_TYPE.NUMBER, true),
        argument('attached', 'Include all composer images first; use attached=true to combine with message= or reference= (default: use composer, then last message, when no explicit source)', false, ARGUMENT_TYPE.BOOLEAN),
        argument('workflow', 'Saved workflow filename (defaults to the active ST ComfyUI workflow)'),
        argument('prompt', 'Editing instruction (alternatively use trailing text)'),
        argument('negative', 'Optional negative prompt'),
        argument('seed', 'Optional nonnegative integer seed', false, ARGUMENT_TYPE.NUMBER),
        argument('width', 'Width in pixels for %width% (defaults to ST Image Generation)', false, ARGUMENT_TYPE.NUMBER),
        argument('height', 'Height in pixels for %height% (defaults to ST Image Generation)', false, ARGUMENT_TYPE.NUMBER),
        argument('chat', 'Also post the output to the current chat (default: true)', false, ARGUMENT_TYPE.BOOLEAN),
    ],
    unnamedArgumentList: [SlashCommandArgument.fromProps({
        description: 'Editing instruction when prompt= is omitted', typeList: [ARGUMENT_TYPE.STRING],
        isRequired: false,
    })],
    helpString: '<p>Edit a reference using a saved ComfyUI workflow. Defaults to attached=true: use all composer images in attachment order, falling back to message={{lastMessageID}} if none is attached. Combine reference= and message= (zero-based chat message ID) freely; add attached=true to include composer images too. Image order is composer attachments, then message= images, then reference= URLs, preserving order within each group. Explicit sources skip the composer unless attached=true; an empty composer adds no last-message fallback when explicit sources are supplied. Use attached=false to skip the composer. Workflow defaults to the active ST ComfyUI workflow; use workflow= to override. Returns a saved URL and posts to chat by default; use chat=false for URL only. The original composer attachment stays unchanged.</p><p>Required inputs: %prompt% and %reference_image_1%, %reference_image_2%, etc. (raw base64), one per supplied image. %reference_image% is an alias for image 1. Repeat reference= or message= for multiple explicit sources. The workflow must use every supplied reference. Optional: %negative_prompt%, %seed%, %width%, %height%. Each placeholder fills a whole JSON string value. Dimensions default to ST Image Generation settings; literal workflow dimensions stay unchanged.</p><p><code>/image-edit Give her an amused smile.</code></p><p><code>/image-edit message=12 chat=false width=704 height=1280 Give her an amused smile.</code></p><p><code>/image-edit attached=true message=12 workflow="flux2_9b_edit_2ref.json" Put the person from image 1 in the outfit from image 2.</code></p>',
}));
