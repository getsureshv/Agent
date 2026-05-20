#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# download-vendor.sh — re-downloads all vendored files for Cricket Scorer Mobile
#
# MediaPipe: pinned exact versions per ARCHITECTURE.md §7 / Appendix
#   @mediapipe/camera_utils  0.3.1675466862
#   @mediapipe/drawing_utils 0.3.1675466124
#   @mediapipe/pose          0.5.1675469404
#
# Vosk-browser: 0.0.8  (runtime JS + WASM only — model downloaded on demand)
# fflate: 0.8.2  (used by vosk.js to unzip the model in-memory)
#
# Run from the repo root:
#   bash scripts/download-vendor.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Creating vendor directories..."
mkdir -p vendor/mediapipe/pose vendor/vosk

# ─── MediaPipe camera_utils ──────────────────────────────────────────────────
echo ""
echo "==> Downloading @mediapipe/camera_utils@0.3.1675466862 ..."
curl -fSL \
  "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js" \
  -o vendor/mediapipe/camera_utils.js
echo "    vendor/mediapipe/camera_utils.js  ($(du -sh vendor/mediapipe/camera_utils.js | cut -f1))"

# ─── MediaPipe drawing_utils ─────────────────────────────────────────────────
echo ""
echo "==> Downloading @mediapipe/drawing_utils@0.3.1675466124 ..."
curl -fSL \
  "https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@0.3.1675466124/drawing_utils.js" \
  -o vendor/mediapipe/drawing_utils.js
echo "    vendor/mediapipe/drawing_utils.js  ($(du -sh vendor/mediapipe/drawing_utils.js | cut -f1))"

# ─── MediaPipe Pose — JS + WASM + model files ────────────────────────────────
echo ""
echo "==> Downloading @mediapipe/pose@0.5.1675469404 ..."

POSE_BASE="https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404"

curl -fSL "${POSE_BASE}/pose.js" \
  -o vendor/mediapipe/pose/pose.js
echo "    vendor/mediapipe/pose/pose.js"

curl -fSL "${POSE_BASE}/pose_solution_packed_assets_loader.js" \
  -o vendor/mediapipe/pose/pose_solution_packed_assets_loader.js
echo "    vendor/mediapipe/pose/pose_solution_packed_assets_loader.js"

curl -fSL "${POSE_BASE}/pose_solution_simd_wasm_bin.js" \
  -o vendor/mediapipe/pose/pose_solution_simd_wasm_bin.js
echo "    vendor/mediapipe/pose/pose_solution_simd_wasm_bin.js"

curl -fSL "${POSE_BASE}/pose_solution_simd_wasm_bin.wasm" \
  -o vendor/mediapipe/pose/pose_solution_simd_wasm_bin.wasm
echo "    vendor/mediapipe/pose/pose_solution_simd_wasm_bin.wasm  ($(du -sh vendor/mediapipe/pose/pose_solution_simd_wasm_bin.wasm | cut -f1))"

curl -fSL "${POSE_BASE}/pose_solution_packed_assets.data" \
  -o vendor/mediapipe/pose/pose_solution_packed_assets.data
echo "    vendor/mediapipe/pose/pose_solution_packed_assets.data  ($(du -sh vendor/mediapipe/pose/pose_solution_packed_assets.data | cut -f1))"

curl -fSL "${POSE_BASE}/pose_landmark_full.tflite" \
  -o vendor/mediapipe/pose/pose_landmark_full.tflite
echo "    vendor/mediapipe/pose/pose_landmark_full.tflite  ($(du -sh vendor/mediapipe/pose/pose_landmark_full.tflite | cut -f1))"

# pose_solution_simd_wasm_bin.data does not exist in this package version — skip it

curl -fSL "${POSE_BASE}/pose_web.binarypb" \
  -o vendor/mediapipe/pose/pose_web.binarypb
echo "    vendor/mediapipe/pose/pose_web.binarypb  ($(du -sh vendor/mediapipe/pose/pose_web.binarypb | cut -f1))"

# ─── Vosk-browser 0.0.8 ──────────────────────────────────────────────────────
echo ""
echo "==> Downloading vosk-browser@0.0.8 ..."
curl -fSL \
  "https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js" \
  -o vendor/vosk/vosk.js
echo "    vendor/vosk/vosk.js  ($(du -sh vendor/vosk/vosk.js | cut -f1))"

# NOTE: vosk-browser@0.0.8 bundles the WASM and worker inline (base64-encoded).
# There is no separate vosk.wasm to download — the single vosk.js is self-contained.
echo "    (vosk-browser bundles WASM worker inline — no separate .wasm file needed)"

# ─── fflate 0.8.2 (in-browser zip decompressor for Vosk model) ───────────────
echo ""
echo "==> Downloading fflate@0.8.2 ..."
curl -fSL \
  "https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js" \
  -o vendor/vosk/fflate.js
echo "    vendor/vosk/fflate.js  ($(du -sh vendor/vosk/fflate.js | cut -f1))"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "==> Done. Vendor file sizes:"
echo ""
echo "── vendor/mediapipe/ ──────────────────────"
du -sh vendor/mediapipe/camera_utils.js
du -sh vendor/mediapipe/drawing_utils.js
echo "── vendor/mediapipe/pose/ ─────────────────"
du -sh vendor/mediapipe/pose/*
echo ""
echo "── vendor/vosk/ ───────────────────────────"
du -sh vendor/vosk/vosk.js vendor/vosk/fflate.js 2>/dev/null || true
echo ""
echo "NOTE: Vosk model (vosk-model-small-en-us-0.15, ~40 MB) is NOT downloaded here."
echo "      It is fetched on demand via downloadVoskModel() in src/voice/vosk.js"
echo "      and stored in Cache Storage 'vosk-model-v1'."
