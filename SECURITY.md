# Security Policy

## Reporting

Please report security issues privately through GitHub Security Advisories for this repository. Do not publish API keys, captured audio, private transcripts, or reproduction data containing personal information.

## Key handling

Never commit an API key. This project is bring-your-own-key: keys are entered by each user and saved only in local extension storage. Production deployments for multiple untrusted users should use a dedicated backend that issues short-lived credentials instead of distributing a shared provider key.
