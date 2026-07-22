# Changelog

## 0.1.0

- Rebuilt as a local-first extension with no OpenAI API dependency.
- Added Whisper ONNX speech recognition through Transformers.js.
- Added WebGPU acceleration with WASM/CPU fallback.
- Added Chrome Translator API support with local OPUS-MT fallback.
- Added independent subtitles for YouTube videos and streams without caption tracks.
- Added local model download progress and runtime status reporting.
- Retained overlapping audio windows, silence gating, subtitle deduplication, fullscreen overlay support, and bounded processing queues.
