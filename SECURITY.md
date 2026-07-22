# Security

Please report security issues privately to the repository owner instead of opening a public issue when exploitation details or user data may be involved.

## Security properties

- No bundled credentials or API keys.
- No developer-operated backend.
- Captured audio and generated text stay on the device.
- Remote access is limited to model-file hosts declared in `host_permissions`.
- Page text is inserted with `textContent` inside a closed Shadow DOM.
- Only the user-selected active tab is captured and scripted.
- Model runtime code and ONNX WebAssembly files are packaged with the release rather than executed from a remote script host.
