/**
 * src/vendor/umpirePose.js
 *
 * Wrapper around MediaPipe Pose for umpire signal detection.
 * All MediaPipe files are loaded from /vendor/mediapipe/ (self-hosted,
 * SW-cached offline) via the locateFile callback.
 *
 * Exports:
 *   initUmpirePose(videoEl, canvasEl, onSignal): void
 *   stopUmpirePose(): void
 *   isUmpirePoseActive(): boolean
 *
 * onSignal is called with a VoiceCommand object (shape defined in src/voice/commands.js)
 * when a confirmed umpire gesture is detected and held for SIGNAL_HOLD_THRESHOLD frames.
 *
 * MediaPipe globals expected on window (loaded via <script> in index.html or sw cache):
 *   Pose, Camera, drawConnectors, drawLandmarks, POSE_CONNECTIONS
 */

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Number of consecutive frames a signal must be held before onSignal fires.
 * At ~30 fps this is roughly 1 second of confirmation.
 */
const SIGNAL_HOLD_THRESHOLD = 30;

// ── Module state ─────────────────────────────────────────────────────────────

/** @type {any} */       let _pose   = null;
/** @type {any} */       let _camera = null;
/** @type {boolean} */   let _active = false;

/** @type {string|null} */         let _lastSignalLabel  = null;
/** @type {number} */              let _signalHoldFrames = 0;
/** @type {function|null} */       let _onSignal         = null;
/** @type {boolean} */             let _pendingFired     = false;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * isUmpirePoseActive(): boolean
 */
export function isUmpirePoseActive() {
    return _active;
}

/**
 * initUmpirePose(videoEl, canvasEl, onSignal)
 *
 * Starts the MediaPipe Pose pipeline on the given video element, draws the
 * skeleton overlay onto canvasEl, and calls onSignal(VoiceCommand) when a
 * recognised umpire gesture has been held for SIGNAL_HOLD_THRESHOLD frames.
 *
 * Requires Pose and Camera globals loaded from /vendor/mediapipe/.
 *
 * @param {HTMLVideoElement}  videoEl   - live camera video element
 * @param {HTMLCanvasElement} canvasEl  - overlay canvas
 * @param {function}          onSignal  - callback(cmd: VoiceCommand)
 */
export function initUmpirePose(videoEl, canvasEl, onSignal) {
    if (_active) return; // already running

    /* global Pose, Camera, POSE_CONNECTIONS, drawConnectors, drawLandmarks */
    if (typeof Pose === 'undefined') {
        console.error('[umpirePose] MediaPipe Pose not loaded. Check vendor/mediapipe/pose/pose.js.');
        return;
    }

    _onSignal        = onSignal;
    _active          = true;
    _lastSignalLabel = null;
    _signalHoldFrames = 0;
    _pendingFired    = false;

    // ── Initialise MediaPipe Pose (self-hosted locateFile) ────────────────
    _pose = new Pose({
        locateFile: (file) => `/vendor/mediapipe/pose/${file}`
    });

    _pose.setOptions({
        modelComplexity:        1,
        smoothLandmarks:        true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence:  0.5,
    });

    _pose.onResults((results) => _onPoseResults(results, canvasEl));

    // ── Start camera + feed frames to Pose ───────────────────────────────
    navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
    }).then((stream) => {
        videoEl.srcObject = stream;
        videoEl.play();

        _camera = new Camera(videoEl, {
            onFrame: async () => {
                if (_pose && _active) {
                    await _pose.send({ image: videoEl });
                }
            },
            width:  640,
            height: 480,
        });
        _camera.start();
    }).catch((err) => {
        console.error('[umpirePose] Camera error:', err);
        _active = false;
    });
}

/**
 * stopUmpirePose()
 *
 * Tears down the camera, stops the Pose model, and resets state.
 */
export function stopUmpirePose() {
    _active = false;

    if (_camera) {
        _camera.stop();
        _camera = null;
    }

    const videoEl = document.querySelector('#umpire-video');
    if (videoEl && videoEl.srcObject) {
        videoEl.srcObject.getTracks().forEach(t => t.stop());
        videoEl.srcObject = null;
    }

    if (_pose) {
        _pose.close();
        _pose = null;
    }

    _lastSignalLabel  = null;
    _signalHoldFrames = 0;
    _onSignal         = null;
    _pendingFired     = false;
}

// ── Frame processing ─────────────────────────────────────────────────────────

function _onPoseResults(results, canvasEl) {
    /* global drawConnectors, drawLandmarks, POSE_CONNECTIONS */
    const ctx = canvasEl.getContext('2d');
    canvasEl.width  = results.image.width;
    canvasEl.height = results.image.height;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    if (!results.poseLandmarks) {
        _lastSignalLabel  = null;
        _signalHoldFrames = 0;
        _pendingFired     = false;
        return;
    }

    // Draw skeleton overlay
    if (typeof drawConnectors !== 'undefined') {
        drawConnectors(ctx, results.poseLandmarks, POSE_CONNECTIONS,
            { color: 'rgba(79,195,247,0.4)', lineWidth: 2 });
        drawLandmarks(ctx, results.poseLandmarks,
            { color: 'rgba(124,77,255,0.6)', lineWidth: 1, radius: 3 });
    }

    const signal = _detectUmpireSignal(results.poseLandmarks);

    if (signal) {
        if (signal.label === _lastSignalLabel) {
            _signalHoldFrames++;
        } else {
            _lastSignalLabel  = signal.label;
            _signalHoldFrames = 1;
            _pendingFired     = false;
        }

        // Fire onSignal once when threshold is reached
        if (_signalHoldFrames === SIGNAL_HOLD_THRESHOLD && !_pendingFired) {
            _pendingFired = true;
            _onSignal?.(signal.cmd);
        }
    } else {
        if (_signalHoldFrames < SIGNAL_HOLD_THRESHOLD) {
            _lastSignalLabel  = null;
            _signalHoldFrames = 0;
            _pendingFired     = false;
        }
    }
}

// ── Signal detection ─────────────────────────────────────────────────────────

/**
 * _detectUmpireSignal(landmarks)
 *
 * Analyses MediaPipe Pose landmarks and returns the detected umpire signal
 * or null if no recognised gesture is present.
 *
 * MediaPipe Pose landmark indices used:
 *   0: nose
 *  11: left shoulder   12: right shoulder
 *  13: left elbow      14: right elbow
 *  15: left wrist      16: right wrist
 *  23: left hip        24: right hip
 *
 * Signals (in priority order):
 *   SIX     — both arms above head
 *   FOUR    — one arm extended horizontally, other arm down
 *   WIDE    — both arms extended horizontally (T-pose)
 *   OUT     — one arm raised up, other arm down
 *   NO BALL — one arm at ~45° above shoulder (extended wide), other arm down
 *   BYE     — both arms above shoulder but below head, one noticeably higher
 *
 * @param {Array} lm - MediaPipe Pose landmark array (normalized coordinates)
 * @returns {{ label: string, cmd: object } | null}
 */
function _detectUmpireSignal(lm) {
    const nose      = lm[0];
    const lShoulder = lm[11], rShoulder = lm[12];
    // const lElbow = lm[13], rElbow = lm[14];  // available if needed
    const lWrist    = lm[15], rWrist    = lm[16];
    const lHip      = lm[23], rHip      = lm[24];

    const shoulderY     = (lShoulder.y + rShoulder.y) / 2;
    const shoulderXSpan = Math.abs(lShoulder.x - rShoulder.x);
    const hipY          = (lHip.y + rHip.y) / 2;
    const torsoH        = hipY - shoulderY;

    // Arm-position helpers (Y axis: 0 = top, 1 = bottom in normalized coords)
    const aboveHead      = (w) => w.y < nose.y - 0.03;
    const atShoulderHgt  = (w) => Math.abs(w.y - shoulderY) < torsoH * 0.4;
    const extendedWide   = (w, shoulder) => Math.abs(w.x - shoulder.x) > shoulderXSpan * 0.7;
    const belowHip       = (w) => w.y > hipY + 0.02;

    const lUp    = aboveHead(lWrist);
    const rUp    = aboveHead(rWrist);
    const lHoriz = atShoulderHgt(lWrist) && extendedWide(lWrist, lShoulder);
    const rHoriz = atShoulderHgt(rWrist) && extendedWide(rWrist, rShoulder);
    const lDown  = belowHip(lWrist);
    const rDown  = belowHip(rWrist);

    // SIX — both arms raised above head
    if (lUp && rUp) {
        return { label: 'SIX',  cmd: { action: 'runs', runs: 6 } };
    }

    // FOUR — one arm extended horizontally, other arm not up
    if ((lHoriz && !rHoriz && !rUp) || (rHoriz && !lHoriz && !lUp)) {
        return { label: 'FOUR', cmd: { action: 'runs', runs: 4 } };
    }

    // OUT — one arm up (index finger raised), other arm down
    if (lUp && !rUp && rDown) {
        return { label: 'OUT',  cmd: { action: 'wicket', type: 'bowled' } };
    }
    if (rUp && !lUp && lDown) {
        return { label: 'OUT',  cmd: { action: 'wicket', type: 'bowled' } };
    }

    // WIDE — both arms extended horizontally (T-pose)
    if (lHoriz && rHoriz) {
        return { label: 'WIDE', cmd: { action: 'extra', type: 'wide', additionalRuns: 0 } };
    }

    // NO BALL — one arm at ~45° (above shoulder but not fully overhead, extended wide), other down
    const lMidUp = lWrist.y < shoulderY && !aboveHead(lWrist) && extendedWide(lWrist, lShoulder);
    const rMidUp = rWrist.y < shoulderY && !aboveHead(rWrist) && extendedWide(rWrist, rShoulder);
    if ((lMidUp && rDown) || (rMidUp && lDown)) {
        return { label: 'NO BALL', cmd: { action: 'extra', type: 'noball', additionalRuns: 0 } };
    }

    // BYE — both arms above shoulder but below head, one noticeably higher
    if (lWrist.y < shoulderY && rWrist.y < shoulderY && !lUp && !rUp) {
        const diff = Math.abs(lWrist.y - rWrist.y);
        if (diff > torsoH * 0.15) {
            return { label: 'BYE', cmd: { action: 'extra', type: 'bye', additionalRuns: 0 } };
        }
    }

    return null;
}
