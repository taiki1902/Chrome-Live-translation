# Privacy

Helium Live Translator is local-first.

- The extension does not request or store an OpenAI API key.
- Captured tab audio is processed in the extension's offscreen document on the user's device.
- Recognized and translated subtitle text is not sent to a transcription or translation API.
- Language, model, performance, and subtitle display settings are stored in `chrome.storage.local`.
- Runtime state is stored temporarily in `chrome.storage.session`.
- On first use, model files and ONNX runtime assets may be downloaded from Hugging Face and cached by the browser.
- Model download requests reveal ordinary network metadata such as IP address and requested model file, but do not include captured audio or generated subtitle text.
- Capture stops immediately when the user presses stop, closes the selected tab, or the browser ends the tab-capture stream.

The extension does not include analytics, advertising, account tracking, or a developer-operated backend.
