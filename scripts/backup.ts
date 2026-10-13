import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config, initializeStorage } from "../server/src/config.js";
import { db } from "../server/src/db.js";

initializeStorage();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = resolve(config.dataDir, "backups");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const destination = resolve(dir, `app-${stamp}.db`);
await db.backup(destination);
console.log(`SQLite backup written: ${destination}`);
console.log(
  "Workspaces are files under data/workspaces — archive the whole data/ directory (excluding data/backups if desired) for a full restore point.",
);
