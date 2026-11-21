# Telegram account session

Use a Telegram application API ID and hash from the account's [Telegram API development tools](https://core.telegram.org/api/obtaining_api_id). Supply them as runtime credentials using `TELEGRAM_API_ID_FILE` and `TELEGRAM_API_HASH_FILE` or the corresponding environment settings. Supply `STEELE_TELEGRAM_STATE_DIR` as an absolute, owner-only directory under the service's private persistent state storage. For containers, mount this directory read-write for the same runtime user on each invocation.

From an interactive terminal in the application runtime, run:

```sh
node dist/cli/telegram-session.js login
node dist/cli/telegram-session.js verify
```

Enter the phone number and Telegram login code at the prompts, and any requested two-step verification password or email challenge. The command verifies account access before saving `telegram.session` with owner-only permissions. The second command checks the saved session and reports success without displaying account details. Both commands only perform authentication and do not send messages.

Treat the session as an account credential. Keep it in private runtime storage outside Git and the image. To replace an expired or unwanted session, revoke it in Telegram and move the old local file out of the configured state directory before running login again.
