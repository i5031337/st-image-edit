const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt']);
const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

// Some browsers report HEIC attachments with an empty or generic MIME type.
export function isHeicFile(file) {
    return HEIC_TYPES.has(file.type.toLowerCase()) || /\.hei[cf]$/i.test(file.name ?? '');
}

export async function isHeicBlob(blob) {
    if (isHeicFile(blob)) return true;
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    return String.fromCharCode(...header.subarray(4, 8)) === 'ftyp'
        && HEIC_BRANDS.has(String.fromCharCode(...header.subarray(8, 12)));
}

export async function convertHeicToPng(blob) {
    // Bundled CSP-compatible decoder; fetched only for the first HEIC reference.
    const { heicTo } = await import('./vendor/heic-to/heic-to.js');
    return heicTo({ blob, type: 'image/png' });
}

/** Remove embedded workflows without decoding or recompressing the image. */
export async function stripReferenceMetadata(blob) {
    const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if (!PNG_SIGNATURE.every((byte, index) => signature[index] === byte)) return blob;

    const parts = [blob.slice(0, 8)];
    let offset = 8;
    let removed = false;
    while (offset < blob.size) {
        const header = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
        if (header.length !== 8) throw new Error('Reference PNG has a truncated chunk header.');
        const length = new DataView(header.buffer).getUint32(0);
        const end = offset + 12 + length; // Length, type, data, and CRC.
        if (end > blob.size) throw new Error('Reference PNG has a truncated chunk.');
        const type = String.fromCharCode(...header.subarray(4));
        if (PNG_TEXT_CHUNKS.has(type)) removed = true;
        else parts.push(blob.slice(offset, end));
        offset = end;
        if (type === 'IEND') {
            // Preserve any trailing bytes as well as all non-text chunks verbatim.
            parts.push(blob.slice(offset));
            return removed ? new Blob(parts, { type: blob.type }) : blob;
        }
    }
    throw new Error('Reference PNG is missing its end chunk.');
}
