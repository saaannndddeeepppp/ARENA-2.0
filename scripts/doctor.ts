import { config, initializeStorage } from "../server/src/config.js";
import { db } from "../server/src/db.js";
import { spawnSync } from "node:child_process";
initializeStorage();
const shell = spawnSync("bash", ["-lc", "printf galaxy-agent-ok"], {
  encoding: "utf8",
  timeout: 5000,
});
const integrity = db.prepare("PRAGMA integrity_check").get() as {
  integrity_check: string;
};
console.log(
  JSON.stringify(
    {
      node: process.version,
      dataDir: config.dataDir,
      sqlite: integrity.integrity_check,
      shell: shell.stdout.trim(),
      providers: (
        db.prepare("SELECT COUNT(*) AS n FROM providers").get() as { n: number }
      ).n,
    },
    null,
    2,
  ),
);
