// Child process for the cross-process claim test: claims one key and reports the result.
import { OperationStore } from "../../../src/controllers/operation-store.js";

const [path, owner] = process.argv.slice(2);
const store = new OperationStore({ path: path!, busyTimeoutMs: 10_000 });
const result = store.claim("shared-op", owner!, 60_000);
store.close();
process.send?.(result.kind, () => process.exit(0));
