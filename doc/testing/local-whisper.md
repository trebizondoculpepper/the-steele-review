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

The provider declares its maximum conversion/output scratch reservation. The adapter reserves that alongside the original download in the shared workspace budget before accepting each job, retaining the reservation until cleanup succeeds. Configuration is refused if a single download plus scratch cannot fit.
