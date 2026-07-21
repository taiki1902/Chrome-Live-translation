# Privacy Policy

Helium Live Translator does not include analytics, advertising, telemetry, or a developer-operated backend.

- The OpenAI API key is stored in `chrome.storage.local` on the user's browser profile. Browser local storage is not a hardware-backed secret vault; anyone with access to the profile or extension debugging tools may be able to read it.
- Audio from the user-selected tab is divided into short segments and sent directly from the extension to OpenAI's transcription API using the user's key.
- Transcribed text is sent directly to OpenAI's Responses API for translation with `store: false`.
- The extension developer does not receive audio, transcripts, translations, API keys, browsing history, or usage statistics.
- No data is sold or shared by the extension developer.

Users should review OpenAI's own API privacy and data-control terms before use. Stop translation to end capture immediately, and remove the extension to delete its local settings through the browser.
