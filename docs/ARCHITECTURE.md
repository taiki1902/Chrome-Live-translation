# Architecture

1. The popup sends a start request after the user invokes the extension.
2. The service worker immediately obtains a one-use `tabCapture` stream ID, validates settings, and starts an offscreen document.
3. The offscreen document consumes the stream, reconnects it to the audio output, and creates independent Opus/WebM segments with a short overlap.
4. Silent segments are discarded locally. Remaining segments are transcribed and translated directly through OpenAI APIs.
5. The service worker forwards caption messages only to the captured tab.
6. A content script renders text in a closed Shadow DOM, uses `textContent` to prevent HTML injection, and expires old captions.

Only one captured tab is supported per browser profile at a time. The queue is bounded to prevent unbounded memory growth when API processing is slower than the live stream.
