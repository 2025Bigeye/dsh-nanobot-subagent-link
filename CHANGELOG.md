# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - Unreleased

### Improved

- **Host robustness**: extracted all magic numbers into named constants (`DEFAULT_TIMEOUT_MS`, `TRUNCATE_MAX_LEN`, `SERVER_RETRY_COUNT`, `SERVER_RETRY_DELAY_SEC`, `HTTP_TIMEOUT_SEC`, `JSON_DEPTH`, `MODES`) for easier maintenance.
- **Server startup resilience**: wrapped `shell.start()` in `try-catch` so startup failures cleanly reset `serverState` instead of leaving the plugin in a broken half-started state.
- **Error diagnostics**: unified error message prefix `[dsh-tool-nanobot]` across all throw sites; added contextual details (actual values, counts, outcome strings) to help users pinpoint misconfiguration quickly.

## [0.3.0] - 2025-08-18

### Added

- Initial release: `nanobot_run` tool with `oneshot` and `server` modes.
- Settings namespace (`nanobot`) for durable configuration.
- Sandbox escalation support with user approval gating.
- Runtime skill registration from `SKILL.md`.
