import { createSession, addMessage, db } from "../server/src/db.js";
const session = createSession("A quick tour of your workspace");
session &&
  addMessage(session.id, "user", "Show me what this local agent can do.");
addMessage(
  session.id,
  "assistant",
  "I can work with files in this session workspace, run shell commands with an approval guard, search the web, inspect pages, and use a model provider you configure. Add a provider in Settings to start an agent run.\n\nYour workspace is persistent and local to this machine.",
);
console.log(`Seeded demo session ${session.id}`);
