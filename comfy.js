// Match the placeholders used by SillyTavern's ComfyUI image generator.
export function comfyValues(settings, substituteParams) {
    const values = {
        '%denoise%': settings.denoising_strength === undefined ? 1 : settings.denoising_strength,
        '%clip_skip%': isNaN(settings.clip_skip) ? -1 : -settings.clip_skip,
    };
    for (const name of ['model', 'vae', 'sampler', 'scheduler', 'steps', 'scale']) {
        if (settings[name] !== undefined) values[`%${name}%`] = settings[name];
    }
    for (const placeholder of settings.comfy_placeholders ?? []) {
        const key = `%${placeholder.find}%`;
        // Editing inputs and built-in settings take precedence over custom values.
        if (Object.hasOwn(values, key) || /^%(prompt|negative_prompt|seed|width|height|model|vae|sampler|scheduler|steps|scale|denoise|clip_skip|user_avatar|char_avatar|reference_image(?:_[1-9]\d*)?)%$/.test(key)) continue;
        values[key] = substituteParams(placeholder.replace);
    }
    return values;
}

export function characterAvatarUrl(context, getCharacterAvatar, formatCharacterAvatar) {
    if (!context.groupId) return getCharacterAvatar(context.characterId);
    const members = context.groups.find(group => group.id === context.groupId)?.members;
    const lastAvatar = context.chat?.filter(message => !message.is_system && !message.is_user).at(-1)?.original_avatar;
    const randomAvatar = Array.isArray(members) ? members[Math.floor(Math.random() * members.length)] : null;
    return formatCharacterAvatar(lastAvatar || randomAvatar);
}
