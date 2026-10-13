import { initializeStorage, config } from "../server/src/config.js";
import { db } from "../server/src/db.js";
import { existsSync, statSync } from "node:fs";
initializeStorage();
const check = db.prepare("PRAGMA integrity_check").get() as {
  integrity_check: string;
};
if (check.integrity_check !== "ok")
  throw new Error(`SQLite integrity check failed: ${check.integrity_check}`);
console.log(`Local storage ready: ${config.dataDir}`);
console.log(
  `Database: ${existsSync(`${config.dataDir}/app.db`) ? "created" : "missing"}`,
);
console.log(
  `Secret permissions: ${(statSync(`${config.dataDir}/.secret`).mode & 0o777).toString(8)}`,
);
