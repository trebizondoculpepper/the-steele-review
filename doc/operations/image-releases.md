# Experiment image releases (#959)

Every push to `main` gets a new release version, and the workflow `.github/workflows/images.yml` builds and publishes two images.

## Versions

- **How a version is chosen:** `scripts/release/version.mjs <sha>` derives the version from `main`'s first-parent history alone, so rerunning a commit always gives it the same version and different commits always get different ones.
- **Baseline:** the commit that adds `scripts/release/baseline.json` is **v0.2.0**. Every later commit bumps the patch number unless its message carries `feat:` or `Semver: minor` (minor), or `type!:` or `Semver: major` (major). Before 1.0, a major bump raises the minor number instead.
- **Why 0.2.0:** the archived pipeline published v0.1.0 to v0.1.60. Those tags are never reissued. A test checks that the baseline sits above every existing tag, and the workflow refuses a version whose tag already names another commit.

## Images

| Image | Built from | Published as |
|---|---|---|
| Mastra | `experiments/mastra` plus `experiments/shared` | `ghcr.io/trebizondoculpepper/the-steele-review/mastra` |
| Draft service | `experiments/draft-service` | `ghcr.io/trebizondoculpepper/the-steele-review/draft-service` |

n8n keeps its pinned upstream image and Git-tracked workflows.

Both images are built on GitHub-hosted native ARM64 runners, in parallel, with a separate build cache each. Each build context is exported from the commit with `git archive` (`scripts/ci/stage-context.sh`), so only tracked files can reach an image.

Each image goes through the same checks, carried over from the archived workflow:
1. Its architecture (`arm64`) and its version and revision labels are verified.
2. It is smoke-tested.
3. It is scanned for secrets. A finding blocks publishing.
4. It is scanned for vulnerabilities. This is reported but does not block.

It is then published under both `:<version>` and `:sha-<commit>` (`scripts/ci/publish-image.sh`).

## Tags and recovery

A published tag is never moved. If the version tag already exists for the same commit, which happens on a rerun after only one image was published, it is reused and nothing is pushed. A tag that names another commit stops the job.

The Git tag and the GitHub release are created only after both images are published for the commit. The release notes record both image digests.

## Timings and deployment

Pull requests and manual runs build and check both images without publishing. Every run records build and upload times in its summary, so the owner can decide whether moving builds to the Mac is worthwhile.

Publishing images is separate from deploying to the Pi, which still uses `experiments/*/deploy/deploy.sh`.
