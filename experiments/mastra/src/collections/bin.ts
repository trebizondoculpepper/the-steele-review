import { main } from "./cli.js";

// Entry point of the bundled `steele-collections` command (see cli/).
process.exitCode = await main(process.argv.slice(2));
