export interface BrandingFileValidationResult {
    valid: boolean;
    error?: string;
    code?: string;
}

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.svg', '.webp']);
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

// Magic bytes for allowed binary formats (SVG is text, checked separately)
const MAGIC: Array<{ mime: string; bytes: number[] }> = [
    { mime: 'image/png',  bytes: [0x89, 0x50, 0x4e, 0x47] },
    { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
    { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF header
];

function matchesMagic(buf: Uint8Array, magic: number[]): boolean {
    return magic.every((b, i) => buf[i] === b);
}

function isSvgContent(buf: Uint8Array): boolean {
    const text = new TextDecoder().decode(buf.slice(0, 512));
    const fullText = new TextDecoder().decode(buf);

    // Must contain <svg
    if (!/<svg[\s>]/i.test(text)) return false;

    // Must NOT contain script tags
    if (/<script/i.test(fullText)) return false;

    // Must NOT contain JS event handlers (onclick, onload, etc.)
    if (/\bon\w+\s*=/i.test(fullText)) return false;

    // Must NOT contain external references via xlink:href or href attributes
    // that could load external resources (e.g., xlink:href="http://...")
    if (/\b(xlink:)?href\s*=\s*["'](?:https?:|data:|javascript:|[^#]|\/\/)/i.test(fullText)) return false;

    return true;
}

/**
 * Validate a branding file (logo) before storage or preview use.
 * Checks MIME type, file extension, size, and magic bytes / content safety.
 */
export function validateBrandingFile(
    filename: string,
    mimeType: string,
    sizeBytes: number,
    buffer: Uint8Array
): BrandingFileValidationResult {
    // 1. MIME type allowlist
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        return { valid: false, error: `File type "${mimeType}" is not allowed. Use PNG, JPEG, WebP, or SVG.`, code: 'INVALID_MIME_TYPE' };
    }

    // 2. Extension allowlist
    const ext = ('.' + filename.split('.').pop()!.toLowerCase());
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        return { valid: false, error: `File extension "${ext}" is not allowed.`, code: 'INVALID_EXTENSION' };
    }

    // 3. MIME / extension consistency (prevent .jpg with image/png header tricks)
    const jpegExts = new Set(['.jpg', '.jpeg']);
    if (mimeType === 'image/jpeg' && !jpegExts.has(ext)) {
        return { valid: false, error: 'File extension does not match MIME type.', code: 'MIME_EXTENSION_MISMATCH' };
    }
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/svg+xml') {
        const expectedExt = '.' + mimeType.split('/')[1];
        if (ext !== expectedExt) {
            return { valid: false, error: 'File extension does not match MIME type.', code: 'MIME_EXTENSION_MISMATCH' };
        }
    }

    // 4. Size limit
    if (sizeBytes > MAX_BYTES) {
        return { valid: false, error: `File exceeds the 2 MB size limit (${(sizeBytes / 1024 / 1024).toFixed(2)} MB).`, code: 'FILE_TOO_LARGE' };
    }

    // 5. Magic bytes / content safety
    if (mimeType === 'image/svg+xml') {
        if (!isSvgContent(buffer)) {
            return { valid: false, error: 'SVG file is invalid or contains unsafe content (script/event handlers).', code: 'UNSAFE_SVG' };
        }
    } else {
        const match = MAGIC.find((m) => m.mime === mimeType);
        if (match && !matchesMagic(buffer, match.bytes)) {
            return { valid: false, error: 'File content does not match the declared file type.', code: 'MAGIC_BYTES_MISMATCH' };
        }
    }

    return { valid: true };
}
