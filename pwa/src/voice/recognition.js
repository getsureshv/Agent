/**
 * src/voice/recognition.js
 *
 * Unified speech recognizer — drop-in replacement for webkitSpeechRecognition.
 *
 * Exports:
 *   createRecognition(): UnifiedRecognizer
 *   isVoskReady(): boolean          (re-exported from vosk.js)
 *   downloadVoskModel(onProgress)   (re-exported from vosk.js)
 *
 * Priority logic (per ARCHITECTURE.md §6):
 *   1. If Vosk model is cached in 'vosk-model-v1' → use Vosk (true offline)
 *   2. Else if window.webkitSpeechRecognition is available AND online → use that
 *   3. Else fire onerror({ error: 'no-speech-engine' })
 *
 * The returned object implements the same callback surface as webkitSpeechRecognition:
 *   .onstart, .onresult, .onerror, .onend
 *   .start(), .stop()
 *   .continuous, .interimResults, .lang, .maxAlternatives
 *
 * The onresult event shape is identical to the native API:
 *   { results: [ [ { transcript, confidence } ] ] }
 *   results[0].isFinal: boolean
 */

import { ensureVoskLoaded, getRecognizer, isVoskReady, downloadVoskModel } from './vosk.js';

export { isVoskReady, downloadVoskModel };

const _webkitAvailable = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * createRecognition(): UnifiedRecognizer
 *
 * Returns a new recognizer object that matches the webkitSpeechRecognition
 * callback contract so existing app code works unchanged.
 */
export function createRecognition() {
    return new UnifiedRecognizer();
}

// ── UnifiedRecognizer class ─────────────────────────────────────────────────

class UnifiedRecognizer {
    constructor() {
        // ── Callbacks (matching webkitSpeechRecognition) ────────────────
        this.onstart  = null;
        this.onresult = null;
        this.onerror  = null;
        this.onend    = null;

        // ── Config properties (matching webkitSpeechRecognition) ────────
        this.continuous      = false;
        this.interimResults  = false;
        this.lang            = 'en-US';
        this.maxAlternatives = 3;

        /** @private */
        this._impl = null;
    }

    /**
     * start(): Promise<void>
     *
     * Determines which backend to use, then begins recognition.
     */
    async start() {
        try {
            const modelCached = await _isModelCached();
            if (modelCached) {
                await this._startVosk();
            } else if (_webkitAvailable) {
                this._startWebkit();
            } else {
                this.onerror?.({ error: 'no-speech-engine' });
            }
        } catch (err) {
            this.onerror?.({ error: 'start-failed', message: err.message });
        }
    }

    /**
     * stop()
     *
     * Stops the active recognition session (Vosk or webkit).
     */
    stop() {
        this._impl?.stop?.();
    }

    // ── WebKit backend ────────────────────────────────────────────────────

    _startWebkit() {
        const WS = window.SpeechRecognition || window.webkitSpeechRecognition;
        const r  = new WS();
        r.continuous      = this.continuous;
        r.interimResults  = this.interimResults;
        r.lang            = this.lang;
        r.maxAlternatives = this.maxAlternatives;

        r.onstart  = () => this.onstart?.();
        // Pass the native event through unmodified — it already has the right shape.
        r.onresult = (e) => this.onresult?.(e);
        r.onerror  = (e) => this.onerror?.(e);
        r.onend    = () => this.onend?.();

        this._impl = r;
        r.start();
    }

    // ── Vosk backend ──────────────────────────────────────────────────────

    async _startVosk() {
        // Load Vosk model; fall back to webkit on failure
        try {
            await ensureVoskLoaded();
        } catch (e) {
            if (_webkitAvailable) {
                this._startWebkit();
                return;
            }
            this.onerror?.({ error: 'vosk-not-ready', message: e.message });
            return;
        }

        this.onstart?.();

        // Request microphone at 16 kHz mono (optimal for Vosk)
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true }
            });
        } catch (e) {
            this.onerror?.({ error: 'audio-capture', message: e.message });
            return;
        }

        const ctx  = new AudioContext({ sampleRate: 16000 });
        const src  = ctx.createMediaStreamSource(stream);
        // ScriptProcessor is deprecated but still the most compatible path for Vosk
        // eslint-disable-next-line no-undef
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        const recognizer = getRecognizer();

        proc.onaudioprocess = (e) => {
            if (!recognizer) return;
            const buf = e.inputBuffer.getChannelData(0);

            if (recognizer.acceptWaveform(buf)) {
                // Final result
                let final;
                try { final = JSON.parse(recognizer.result()); } catch (_) { return; }
                if (final.text) {
                    const synthetic = {
                        results: [
                            Object.assign([{ transcript: final.text, confidence: 1.0 }],
                                          { isFinal: true })
                        ]
                    };
                    this.onresult?.(synthetic);
                    if (!this.continuous) this.stop();
                }
            } else if (this.interimResults) {
                // Partial result (only forwarded when caller opts in)
                let partial;
                try { partial = JSON.parse(recognizer.partialResult()); } catch (_) { return; }
                if (partial.partial) {
                    const synthetic = {
                        results: [
                            Object.assign([{ transcript: partial.partial, confidence: 0 }],
                                          { isFinal: false })
                        ]
                    };
                    this.onresult?.(synthetic);
                }
            }
        };

        src.connect(proc);
        proc.connect(ctx.destination);

        this._impl = {
            stop: () => {
                proc.disconnect();
                src.disconnect();
                ctx.close().catch(() => {});
                stream.getTracks().forEach(t => t.stop());
                this.onend?.();
            }
        };
    }
}

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Returns true if the Vosk model has been downloaded into Cache Storage.
 * Uses a lightweight sentinel key to avoid iterating all cache entries.
 */
async function _isModelCached() {
    try {
        const cache = await caches.open('vosk-model-v1');
        const keys  = await cache.keys();
        return keys.length > 0;
    } catch (_) {
        return false;
    }
}
