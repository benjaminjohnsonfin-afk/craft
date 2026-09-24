import { describe, it, expect } from 'vitest';
import { validateBrandingFile } from './validate-branding-file';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_MAGIC = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const SVG_CONTENT = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
const EVIL_SVG = new TextEncoder().encode('<svg><script>alert(1)</script></svg>');
const EVENT_SVG = new TextEncoder().encode('<svg onload="evil()"><rect/></svg>');
const EXTERNAL_HREF_SVG = new TextEncoder().encode('<svg><image href="http://evil.com/payload.svg"/></svg>');
const XLINK_HREF_SVG = new TextEncoder().encode('<svg><image xlink:href="https://evil.com/payload.svg"/></svg>');
const DATA_URI_SVG = new TextEncoder().encode('<svg><image href="data:text/html,<script>alert(1)</script>"/></svg>');
const PROTOCOL_HREF_SVG = new TextEncoder().encode('<svg><a href="javascript:alert(1)"><circle/></a></svg>');
const GARBAGE = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

const KB = 1024;
const MB = 1024 * KB;

// ── MIME type ─────────────────────────────────────────────────────────────────

describe('validateBrandingFile — MIME type', () => {
    it('accepts image/png', () => {
        expect(validateBrandingFile('logo.png', 'image/png', 1 * KB, PNG_MAGIC).valid).toBe(true);
    });

    it('accepts image/jpeg', () => {
        expect(validateBrandingFile('logo.jpg', 'image/jpeg', 1 * KB, JPEG_MAGIC).valid).toBe(true);
    });

    it('accepts image/webp', () => {
        expect(validateBrandingFile('logo.webp', 'image/webp', 1 * KB, WEBP_MAGIC).valid).toBe(true);
    });

    it('accepts image/svg+xml', () => {
        expect(validateBrandingFile('logo.svg', 'image/svg+xml', SVG_CONTENT.length, SVG_CONTENT).valid).toBe(true);
    });

    it('rejects image/gif', () => {
        const r = validateBrandingFile('logo.gif', 'image/gif', 1 * KB, GARBAGE);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('INVALID_MIME_TYPE');
    });

    it('rejects application/pdf', () => {
        const r = validateBrandingFile('logo.pdf', 'application/pdf', 1 * KB, GARBAGE);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('INVALID_MIME_TYPE');
    });
});

// ── Extension ─────────────────────────────────────────────────────────────────

describe('validateBrandingFile — extension', () => {
    it('rejects .exe extension', () => {
        const r = validateBrandingFile('logo.exe', 'image/png', 1 * KB, PNG_MAGIC);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('INVALID_EXTENSION');
    });

    it('rejects MIME/extension mismatch (png file named .webp)', () => {
        const r = validateBrandingFile('logo.webp', 'image/png', 1 * KB, PNG_MAGIC);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('MIME_EXTENSION_MISMATCH');
    });

    it('accepts .jpeg extension for image/jpeg', () => {
        expect(validateBrandingFile('logo.jpeg', 'image/jpeg', 1 * KB, JPEG_MAGIC).valid).toBe(true);
    });
});

// ── Size ──────────────────────────────────────────────────────────────────────

describe('validateBrandingFile — size', () => {
    it('rejects files over 2 MB', () => {
        const r = validateBrandingFile('logo.png', 'image/png', 2 * MB + 1, PNG_MAGIC);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('FILE_TOO_LARGE');
    });

    it('accepts files exactly at 2 MB', () => {
        expect(validateBrandingFile('logo.png', 'image/png', 2 * MB, PNG_MAGIC).valid).toBe(true);
    });
});

// ── Magic bytes / content safety ──────────────────────────────────────────────

describe('validateBrandingFile — magic bytes', () => {
    it('rejects PNG with wrong magic bytes', () => {
        const r = validateBrandingFile('logo.png', 'image/png', 1 * KB, GARBAGE);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('MAGIC_BYTES_MISMATCH');
    });

    it('rejects JPEG with wrong magic bytes', () => {
        const r = validateBrandingFile('logo.jpg', 'image/jpeg', 1 * KB, GARBAGE);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('MAGIC_BYTES_MISMATCH');
    });
});

describe('validateBrandingFile — SVG safety', () => {
    it('rejects SVG with <script> tag', () => {
        const r = validateBrandingFile('logo.svg', 'image/svg+xml', EVIL_SVG.length, EVIL_SVG);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('UNSAFE_SVG');
    });

    it('rejects SVG with inline event handler', () => {
        const r = validateBrandingFile('logo.svg', 'image/svg+xml', EVENT_SVG.length, EVENT_SVG);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('UNSAFE_SVG');
    });

    it('rejects SVG with external href reference', () => {
        const r = validateBrandingFile('logo.svg', 'image/svg+xml', EXTERNAL_HREF_SVG.length, EXTERNAL_HREF_SVG);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('UNSAFE_SVG');
    });

    it('rejects SVG with external xlink:href reference', () => {
        const r = validateBrandingFile('logo.svg', 'image/svg+xml', XLINK_HREF_SVG.length, XLINK_HREF_SVG);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('UNSAFE_SVG');
    });

    it('rejects SVG with data: URI href', () => {
        const r = validateBrandingFile('logo.svg', 'image/svg+xml', DATA_URI_SVG.length, DATA_URI_SVG);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('UNSAFE_SVG');
    });

    it('rejects SVG with javascript: protocol href', () => {
        const r = validateBrandingFile('logo.svg', 'image/svg+xml', PROTOCOL_HREF_SVG.length, PROTOCOL_HREF_SVG);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('UNSAFE_SVG');
    });

    it('rejects non-SVG content declared as SVG', () => {
        const r = validateBrandingFile('logo.svg', 'image/svg+xml', GARBAGE.length, GARBAGE);
        expect(r.valid).toBe(false);
        expect(r.code).toBe('UNSAFE_SVG');
    });

    it('accepts SVG with local fragment href references', () => {
        const localFragmentSvg = new TextEncoder().encode('<svg><use href="#myIcon"/></svg>');
        const r = validateBrandingFile('logo.svg', 'image/svg+xml', localFragmentSvg.length, localFragmentSvg);
        expect(r.valid).toBe(true);
    });
});
