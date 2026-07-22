# Architecture

1. The popup sends an explicit start request for the active tab.
2. The Manifest V3 service worker obtains a `tabCapture` stream ID and creates an offscreen document.
3. The offscreen document restores the captured audio to the user's speakers and copies PCM samples into short overlapping windows.
4. Silence-only windows are discarded locally.
5. Transformers.js runs Whisper ONNX locally with WebGPU when available and WASM/CPU as fallback.
6. For English output, Whisper's translation task produces English directly. For Japanese output, English text is translated with Chrome's built-in Translator API when available, otherwise with local OPUS-MT.
7. Captions are sent only through extension messaging to the selected tab.
8. The content script renders captions inside a closed Shadow DOM and relocates the host when fullscreen state changes.

## Data boundary

Captured audio and generated text never leave the extension for inference. Network access is used only to obtain model files from Hugging Face. Models and ONNX runtime assets are cached locally.

## YouTube without captions

The pipeline reads the tab's decoded audio output, not YouTube caption tracks or page metadata. Therefore it can create subtitles for videos and live streams that have no uploaded or automatic YouTube captions.
