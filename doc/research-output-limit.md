# Live research output limit

`STEELE_RESEARCH_MAX_TOKENS` is the single research output-token setting. Its
validated default is 4000 and its application/provider request bound is 1–32000.
It is separate from research job allowances, monetary limits and reasoning effort.
Both article-commissioned research and local standalone subject research use it.
Default standalone Restate submissions use the worker's same research adapter.

The existing generic configuration controller reads a flat JSON settings file
selected by the private `STEELE_SETTINGS_FILE` location pointer. Values are strings,
for example `{ "STEELE_RESEARCH_MAX_TOKENS": "12000" }`. Credentials belong in
their separate canonical credential configuration, never this setting or an audit.
The controller's established precedence remains nonempty environment, then file,
then default. A configured unreadable or invalid file fails closed. Use an atomic
file replacement for edits; the next genuine outbound request reads the current
value through the handler without a settings cache or generated copy.

The configuration browser shows its own current effective value and source.
Other services may have different private mounts or environment; this page is not
proof of their configuration. `sonarFromEnv().currentSettings()` provides a fresh
read-only effective setting for worker checks. The old synchronous `settings`
property retains fixed constructor defaults for compatibility, not live readiness.

Each outbound request reads once and records only the applied token value, source
and public-setting revision in its retained response envelope. An in-flight request
keeps the value already sent. These are applied non-secret decisions, not a frozen
whole-run configuration or an additional configuration authority.

Saved terminal results and report snapshots are checked first. For a retained
response interrupted before report curation, live adapters select the existing
exact-request dispatch descriptor before any new settings read or network call.
The bounded selector preserves old fixed-limit descriptors and response bytes;
ambiguous candidates or an incomplete scan stop without another discovery call.
New live dispatch identity does not vary with the output-token setting. Fixed
explicit clients keep their existing identities. Changes to configuration never
invalidate a reusable response or authorize automatic rediscovery.

The former article-only `STEELE_RESEARCH_MAX_OUTPUT_TOKENS` environment knob is no
longer read; there is no alias or second token setting. At an approved deployment,
move the existing configured value to the canonical setting and remove the former
environment knob. Preserve the current configured 12000; do not silently activate
the default, increase provider spending limits, or create a second configuration
copy. No runtime change is part of the source implementation.

A handler refusal before transport is a known local configuration failure, not an
ambiguous paid response. The discovery and job leases are yielded and bounded
workflow retries may read a corrected file. No uncertain-response marker or failed
research result is fabricated for that refusal. Operational failures selecting a
saved response likewise remain retryable in the new live path. An actual ambiguous
transport response retains the existing no-recall handling.
