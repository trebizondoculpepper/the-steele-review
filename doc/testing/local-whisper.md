# Local transcription provider

`WhisperProvider` implements the existing `TranscriptionProvider` interface using CPU-only whisper.cpp and FFmpeg. It receives only a local media path from `TranscriptionAdapter`; it does not download media, fetch models or access API keys. The application remains TypeScript; whisper.cpp and FFmpeg are external executable dependencies.

The provider converts the selected audio stream to mono 16 kHz PCM, checks its actual duration with FFprobe, runs whisper.cpp with GPU use disabled, and validates its JSON segments. Millisecond offsets become seconds. It records a configured stable model label and the provider name, without putting filesystem paths in provenance. Provision versioned model weights separately and use that version in the label.

Conversion is bounded to one second beyond the configured maximum duration and oversized input is rejected rather than reported as a complete truncated transcript. Output JSON is size-bounded and timestamps must be finite, ordered and within the decoded audio. English is selected explicitly for this initial publication. A successful result means inference completed on the full decoded audio; it does not verify factual accuracy or make machine-generated text an authoritative quotation.

All subprocess calls use argument arrays and a restricted environment without inherited API credentials. Errors exclude command lines and stderr. Cancellation terminates the active child, escalating to SIGKILL after one second. Converted audio and JSON stay in a private subdirectory of the adapter's job workspace and are removed in a finally block; the adapter retains ownership of the original download and its cleanup lifecycle.

## Dependencies and testing

The provider requires `whisper-cli` (whisper.cpp v1.9.5 CLI JSON format), `ffmpeg`, `ffprobe` and externally provisioned model weights. It defaults to two threads, one provider job per adapter slot, and a four-hour duration bound. The adapter's overall timeout still applies; choose limits based on measured runtime rather than assuming real-time processing.

Focused tests use injected subprocess results and include a real child-process cancellation check:

```sh
npx vp test run test/transcription/whisper.test.ts test/transcription/adapter.test.ts
```

These tests do not demonstrate Raspberry Pi throughput or transcript quality. Collector composition, runtime provisioning and a bounded target-machine trial are tracked separately. Enabling a provider does not reset terminal operation records; pending-post replay requires an explicit state-controller operation. Never edit SQLite directly to force a retry.

Actual machine locations, mount paths and deployment results belong in private infrastructure documentation. Model weights and temporary media belong on dedicated persistent disk mounts, not in Git or an unbounded memory filesystem. The text archive retains transcript text, timestamps and provenance only.

## Optional collector runtime

Build `docker build --target whisper -t steele-review:whisper .` to include CPU-only whisper.cpp (pinned v1.9.5 source commit) and FFmpeg. The default image target remains the ordinary runtime. Model weights are not downloaded during image builds. Mount the chosen model directory read-only and a separate disk-backed workspace writable by the runtime user; provision ownership before starting.

Set `STEELE_TRANSCRIPTION_PROVIDER=whisper.cpp` to enable it. Omit the variable or use `disabled` to keep supplied-transcript-only collection. Required enabled configuration:

| Variable                             | Purpose                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `STEELE_WHISPER_MODEL_PATH`          | Absolute container path to readable weights                                  |
| `STEELE_WHISPER_MODEL`               | Stable version/checksum label for provenance                                 |
| `STEELE_TRANSCRIPTION_WORKSPACE`     | Absolute path on the writable media volume                                   |
| `STEELE_TRANSCRIPTION_ALLOWED_HOSTS` | Explicit comma-separated download hosts; URLs and wildcards are not accepted |

Optional variables are `STEELE_WHISPER_BINARY`, `STEELE_FFMPEG_BINARY`, `STEELE_FFPROBE_BINARY` (absolute executable paths), `STEELE_WHISPER_THREADS` (default 2), `STEELE_TRANSCRIPTION_MAX_DURATION_SECONDS` (default 14400), and `STEELE_TRANSCRIPTION_TIMEOUT_MS` (default six hours). Configuration is validated and model/executable/workspace access checked before consuming messages. The adapter sweeps abandoned jobs older than 24 hours on startup and processes only one transcription at a time.

The existing destination guard still checks allowed download hosts and redirects. Do not enable unrestricted downloads merely to get a failed media URL through. Missing access, invalid configuration and cleanup errors are visible failures; raw media or model paths are never printed by the configuration error path.

Existing collector CPU/memory limits are not necessarily sufficient for inference. Benchmark with explicit trial limits first. Disabling the provider is the immediate rollback; it does not remove archived transcripts, reset state or make the pending backlog automatically retryable.
The provider declares its maximum conversion/output scratch reservation. The adapter reserves that alongside the original download in the shared workspace budget before accepting each job, retaining the reservation until cleanup succeeds. Configuration is refused if a single download plus scratch cannot fit.
