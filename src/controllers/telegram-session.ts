import { constants } from "node:fs";
import { lstat, link, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { TelegramClient } from "teleproto";
import { LogLevel } from "teleproto/extensions/Logger";
import { StringSession } from "teleproto/sessions";
import { readCredential } from "../config/credentials.js";

type Prompt = (label: string) => Promise<string>;

function privateOwner(uid: number, mode: number): boolean {
  return uid === process.getuid?.() && (mode & 0o077) === 0;
}

async function loadSession(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !privateOwner(info.uid, info.mode) || info.size < 1 || info.size > 4096) {
      throw new Error("invalid session file");
    }
    return (await handle.readFile({ encoding: "utf8" })).trim();
  } finally {
    await handle.close();
  }
}

/** Log in and save a new personal session, or verify an existing session. */
export async function telegramSession(mode: "login" | "verify", prompt: Prompt): Promise<void> {
  const directory = process.env.STEELE_TELEGRAM_STATE_DIR;
  if (!directory || !isAbsolute(directory)) throw new Error("invalid state directory");
  if (mode === "login") await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || !privateOwner(info.uid, info.mode)) {
    throw new Error("state directory must be private");
  }
  const file = join(directory, "telegram.session");
  let saved: string | undefined;
  try {
    saved = await loadSession(file);
  } catch (error) {
    if (mode !== "login" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const apiId = Number(readCredential("TELEGRAM_API_ID", { required: true }));
  const apiHash = readCredential("TELEGRAM_API_HASH", { required: true });
  if (!Number.isSafeInteger(apiId) || apiId < 1 || !/^[a-f0-9]{32}$/i.test(apiHash)) {
    throw new Error("invalid Telegram API configuration");
  }
  const session = new StringSession(saved);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 1,
    requestRetries: 1,
    autoReconnect: false,
  });
  client.setLogLevel(LogLevel.NONE);
  try {
    await client.connect();
    if (saved === undefined) {
      await client.signInUser(
        { apiId, apiHash },
        {
          phoneNumber: () => prompt("Phone number with country code"),
          phoneCode: () => prompt("Telegram login code"),
          password: () => prompt("Telegram two-step verification password"),
          emailAddress: () => prompt("Telegram email address"),
          emailVerification: async () => ({
            type: "code",
            code: await prompt("Telegram email verification code"),
          }),
          onError: async () => true,
        },
      );
    }
    const account = await client.getMe();
    if (!account || account.bot) throw new Error("personal account required");
    if (saved === undefined) {
      const value = session.save();
      if (!value) throw new Error("session unavailable");
      const temporary = await mkdtemp(join(directory, ".telegram-session-"));
      try {
        const staged = join(temporary, "session");
        await writeFile(staged, value, { mode: 0o600, flag: "wx" });
        await link(staged, file);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  } finally {
    await client.destroy();
  }
}
