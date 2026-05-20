/**
 * src/voice/vosk.js
 *
 * Vosk-browser wrapper for offline speech recognition.
 *
 * Exports:
 *   isVoskReady(): boolean
 *   downloadVoskModel(onProgress): Promise<void>
 *   ensureVoskLoaded(): Promise<void>
 *   getRecognizer(): KaldiRecognizer | null
 *
 * Model download stores into Cache Storage 'vosk-model-v1' (matches SW cache name).
 * The model zip (~40 MB) is fetched from the official Vosk CDN, unzipped in-memory
 * via fflate, and the resulting files are stored as individual Cache responses
 * so the SW can serve them offline.
 *
 * NOTE: vosk-browser@0.0.8 bundles the WASM worker inline (no separate vosk.wasm).
 */

const VOSK_JS_PATH   = '/vendor/vosk/vosk.js';
const FFLATE_PATH    = '/vendor/vosk/fflate.js';
const VOSK_CACHE     = 'vosk-model-v1';
const MODEL_NAME     = 'vosk-model-small-en-us-0.15';
const MODEL_ZIP_URL  = `https://alphacephei.com/vosk/models/${MODEL_NAME}.zip`;
const MODEL_SIZE_APPROX = 40 * 1024 * 1024; // ~40 MB for progress estimation

/** @type {boolean} */
let _voskReady = false;

/** @type {any} */
let _recognizer = null;

/** @type {any} */
let _model = null;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * isVoskReady(): boolean
 * Returns true if the Vosk model is loaded and ready for recognition.
 */
export function isVoskReady() {
    return _voskReady;
}

/**
 * getRecognizer(): KaldiRecognizer | null
 * Returns the active KaldiRecognizer, or null if not yet loaded.
 */
export function getRecognizer() {
    return _recognizer;
}

/**
 * downloadVoskModel(onProgress): Promise<void>
 *
 * Downloads the small English Vosk model from the official CDN and stores
 * each file into Cache Storage 'vosk-model-v1' so it can be served offline.
 *
 * onProgress(percent: number) is called with 0–100 as bytes arrive.
 * The percent is derived from the Content-Length header if available,
 * falling back to an estimation based on MODEL_SIZE_APPROX.
 *
 * Throws:
 *   'ALREADY_DOWNLOADED' — model already in cache (check isModelCached() first)
 *   'DOWNLOAD_FAILED'    — network error or non-2xx HTTP response
 */
export async function downloadVoskModel(onProgress) {
    // ── Ensure fflate is available ──────────────────────────────────────
    if (typeof self.fflate === 'undefined') {
        await _loadScript(FFLATE_PATH);
    }

    const cache = await caches.open(VOSK_CACHE);
    const existing = await cache.keys();
    if (existing.length > 0) {
        throw new Error('ALREADY_DOWNLOADED');
    }

    onProgress?.(0);

    // ── Fetch the zip with progress tracking ────────────────────────────
    let response;
    try {
        response = await fetch(MODEL_ZIP_URL);
    } catch (e) {
        throw new Error('DOWNLOAD_FAILED: ' + e.message);
    }
    if (!response.ok) {
        throw new Error('DOWNLOAD_FAILED: HTTP ' + response.status);
    }

    const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
    const totalBytes = contentLength || MODEL_SIZE_APPROX;

    // Read body with progress reporting
    const reader = response.body.getReader();
    const chunks = [];
    let receivedBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedBytes += value.byteLength;
        const pct = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
        onProgress?.(pct);
    }

    onProgress?.(99);

    // Combine chunks into a single Uint8Array
    const zipBytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
        zipBytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    // ── Unzip with fflate ────────────────────────────────────────────────
    const fflate = self.fflate;
    let unzipped;
    try {
        unzipped = fflate.unzipSync(zipBytes);
    } catch (e) {
        throw new Error('DOWNLOAD_FAILED: unzip error — ' + e.message);
    }

    // ── Store each file into Cache Storage ───────────────────────────────
    // The zip typically contains a top-level directory like vosk-model-small-en-us-0.15/
    // We store files under /vendor/vosk/<MODEL_NAME>/<path>
    const putPromises = [];
    for (const [relativePath, data] of Object.entries(unzipped)) {
        if (data.byteLength === 0) continue; // skip directories
        const url = `/vendor/vosk/${relativePath}`;
        const blob = new Blob([data]);
        const cacheResponse = new Response(blob, {
            headers: {
                'Content-Type':   _mimeForPath(relativePath),
                'Content-Length': String(data.byteLength),
            }
        });
        putPromises.push(cache.put(url, cacheResponse));
    }
    await Promise.all(putPromises);

    // Store a sentinel so isModelCached() can do a cheap check
    await cache.put(
        `/vendor/vosk/${MODEL_NAME}/.cached`,
        new Response('1', { headers: { 'Content-Type': 'text/plain' } })
    );

    onProgress?.(100);
}

/**
 * ensureVoskLoaded(): Promise<void>
 *
 * Loads vosk.js from /vendor/vosk/vosk.js, then opens the cached model
 * and initialises a KaldiRecognizer at 16 kHz.
 *
 * Throws 'VOSK_MODEL_NOT_DOWNLOADED' if the model has not been downloaded yet.
 * Safe to call multiple times — subsequent calls return immediately.
 */
export async function ensureVoskLoaded() {
    if (_voskReady) return;

    // Load the Vosk JS library if not already present
    if (typeof self.Vosk === 'undefined') {
        await _loadScript(VOSK_JS_PATH);
    }

    const cache = await caches.open(VOSK_CACHE);
    const sentinel = await cache.match(`/vendor/vosk/${MODEL_NAME}/.cached`);
    if (!sentinel) {
        throw new Error('VOSK_MODEL_NOT_DOWNLOADED');
    }

    // Build an in-memory object-URL for each model file so Vosk's
    // createModel() can load them. We pass a custom locateFile callback.
    const modelPath = `/vendor/vosk/${MODEL_NAME}/`;

    const { createModel } = self.Vosk;
    _model = await createModel(modelPath);
    _recognizer = new _model.KaldiRecognizer(16000);
    _recognizer.setWords(true);
    _voskReady = true;
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Dynamically insert a <script> tag and wait for it to load.
 * @param {string} src
 */
function _loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) {
            resolve();
            return;
        }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load script: ' + src));
        document.head.appendChild(s);
    });
}

/**
 * Rough MIME type lookup for common model file extensions.
 * @param {string} path
 * @returns {string}
 */
function _mimeForPath(path) {
    if (path.endsWith('.json'))  return 'application/json';
    if (path.endsWith('.txt'))   return 'text/plain';
    if (path.endsWith('.mdl') || path.endsWith('.raw') || path.endsWith('.res') ||
        path.endsWith('.fst') || path.endsWith('.bin')) return 'application/octet-stream';
    return 'application/octet-stream';
}
