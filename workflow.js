const REQUIRED = ['%prompt%'];

export function populateWorkflow(text, values, referenceCount = 1) {
    let graph;
    try {
        graph = JSON.parse(text);
    } catch {
        throw new Error('Editing workflow must be valid API-format JSON.');
    }
    if (!graph || Array.isArray(graph) || typeof graph !== 'object'
        || !Object.keys(graph).length
        || !Object.values(graph).every(node => node && typeof node.class_type === 'string'
            && node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs))) {
        throw new Error('Use a ComfyUI API-format node graph, not a visual workflow export.');
    }
    const found = new Set();
    function replace(value) {
        if (typeof value === 'string') {
            if (Object.hasOwn(values, value)) {
                found.add(value);
                return values[value];
            }
            if (/^%reference_image_[1-9][0-9]*%$/.test(value)) {
                throw new Error(`Workflow requires a reference image for ${value}.`);
            }
            if (/%[a-zA-Z_][a-zA-Z0-9_]*%/.test(value)) {
                throw new Error(`Unsupported or embedded workflow placeholder: ${value.slice(0, 100)}`);
            }
            return value;
        }
        if (Array.isArray(value)) return value.map(replace);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
        }
        return value;
    }
    // Replace inputs only: node titles and metadata are not executable inputs.
    const populated = Object.fromEntries(Object.entries(graph).map(([id, node]) => [
        id, { ...node, inputs: replace(node.inputs) },
    ]));
    for (const placeholder of REQUIRED) {
        if (!found.has(placeholder)) throw new Error(`Editing workflow is missing ${placeholder}.`);
    }
    for (let index = 1; index <= referenceCount; index++) {
        if (!found.has(`%reference_image_${index}%`) && !(index === 1 && found.has('%reference_image%'))) {
            throw new Error(`Editing workflow is missing ${index === 1 ? '%reference_image% or %reference_image_1%' : `%reference_image_${index}%`} for supplied reference ${index}.`);
        }
    }
    return populated;
}
