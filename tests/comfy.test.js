import test from 'node:test';
import assert from 'node:assert/strict';
import { comfyValues, characterAvatarUrl } from '../comfy.js';

test('ComfyUI settings preserve types and match SD denoise and clip-skip conventions', () => {
    const settings = { model: 'model.safetensors', vae: 'vae.safetensors', sampler: 'euler',
        scheduler: 'normal', steps: 20, scale: 3.5, clip_skip: 2, denoising_strength: 0.7 };
    assert.deepEqual(comfyValues(settings, value => value), {
        '%model%': settings.model, '%vae%': settings.vae, '%sampler%': 'euler',
        '%scheduler%': 'normal', '%steps%': 20, '%scale%': 3.5,
        '%clip_skip%': -2, '%denoise%': 0.7,
    });
    assert.deepEqual(comfyValues({}, value => value), { '%denoise%': 1, '%clip_skip%': -1 });
});

test('custom placeholders expand ST macros without overriding editing inputs or built-in values', () => {
    const values = comfyValues({ steps: 20, comfy_placeholders: [
        { find: 'character-description', replace: '{{char}} says "hello"\n%seed%' },
        ...['prompt', 'negative_prompt', 'seed', 'width', 'height', 'reference_image', 'reference_image_2', 'steps']
            .map(find => ({ find, replace: 'override' })),
    ] }, text => text.replaceAll('{{char}}', 'Alice'));
    assert.equal(values['%character-description%'], 'Alice says "hello"\n%seed%');
    assert.equal(values['%steps%'], 20);
    assert.equal(values['%reference_image_2%'], undefined);
    assert.equal(values['%prompt%'], undefined);
});

test('character avatar selection matches single chats and group speakers', () => {
    const get = id => `character:${id}`;
    const format = avatar => `avatar:${avatar}`;
    assert.equal(characterAvatarUrl({ characterId: 2 }, get, format), 'character:2');
    const context = { groupId: 'group', groups: [{ id: 'group', members: ['member.png'] }], chat: [
        { is_user: false, original_avatar: 'speaker.png' },
        { is_user: true, original_avatar: 'user.png' },
        { is_system: true, original_avatar: 'system.png' },
    ] };
    assert.equal(characterAvatarUrl(context, get, format), 'avatar:speaker.png');
    context.chat = [];
    assert.equal(characterAvatarUrl(context, get, format), 'avatar:member.png');
});
