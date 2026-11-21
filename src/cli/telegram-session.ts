import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { telegramSession } from "../controllers/telegram-session.js";

async function main(): Promise<number> {
  const [mode] = process.argv.slice(2);
  if (process.argv.length !== 3 || (mode !== "login" && mode !== "verify")) {
    console.error("Usage: telegram-session login|verify");
    return 2;
  }
  if (mode === "login" && (!process.stdin.isTTY || !process.stderr.isTTY)) {
    console.error("Telegram login requires an interactive terminal.");
    return 2;
  }
  try {
    await telegramSession(mode, async (label) => {
      process.stderr.write(label + ": ");
      // Keep readline's terminal editing without echoing the phone or secrets.
      const mute = new Writable({ write: (_chunk, _encoding, done) => done() });
      const terminal = createInterface({ input: process.stdin, output: mute, terminal: true });
      try {
        return (await terminal.question("")).trim();
      } finally {
        terminal.close();
        process.stderr.write("\n");
      }
    });
    console.log("Telegram account session verified.");
    return 0;
  } catch {
    console.error(
      "Telegram session failed. Check the API credentials, private session storage, and network access.",
    );
    return 1;
  }
}

process.exitCode = await main();
