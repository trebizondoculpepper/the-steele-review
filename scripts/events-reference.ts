import { writeFileSync } from "node:fs";
import { renderRegistryReference } from "../src/events/registry.js";

writeFileSync("doc/architecture/generated/streams-and-messages.md", renderRegistryReference());
