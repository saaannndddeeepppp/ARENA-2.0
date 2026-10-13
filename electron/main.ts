import { app, BrowserWindow, shell, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import { createServer } from "node:net";
import { join } from "node:path";

/**
 * Galaxy Agent desktop shell.
 *
 * The Electron main process boots the exact same Fastify backend that
 * `npm start` runs (server/dist/index.js) as a utility process bound to
 * 127.0.0.1, waits for /api/health, then opens a window on it. Frontend,
 * backend, SQLite data and workspaces therefore ship inside one app and
 * behave identically to the local web version. User data lives in the OS
 * app-data folder (e.g. %APPDATA%/Galaxy Agent/data), never in the install
 * directory, so the portable exe can live anywhere.
 */

const isDev = !app.isPackaged;
let serverProcess: UtilityProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

function freePort(start = 4310): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => {
      if (start >= 4399) reject(new Error("No free local port found."));
      else resolve(freePort(start + 1));
    });
    probe.listen(start, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        typeof address === "object" && address ? address.port : start;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      /* backend not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Galaxy Agent backend did not become healthy in time.");
}

async function startBackend(port: number): Promise<void> {
  const appRoot = app.getAppPath();
  const serverEntry = join(appRoot, "server", "dist", "index.js");
  const dataDir = join(app.getPath("userData"), "data");
  serverProcess = utilityProcess.fork(serverEntry, [], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      WEB_DIST_DIR: join(appRoot, "web-dist"),
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    },
    stdio: "pipe",
  });
  serverProcess.stdout?.on("data", (d) => process.stdout.write(`[api] ${d}`));
  serverProcess.stderr?.on("data", (d) => process.stderr.write(`[api] ${d}`));
  serverProcess.on("exit", (code) => {
    if (code !== 0 && !quitting) {
      console.error(`Galaxy Agent backend exited with code ${code}`);
    }
  });
  await waitForHealth(port);
}

async function createWindow(): Promise<void> {
  const port = await freePort();
  await startBackend(port);
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: "Galaxy Agent",
    autoHideMenuBar: true,
    backgroundColor: "#f7f3e8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1")) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    createWindow().catch((error) => {
      console.error(error);
      app.quit();
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0)
        createWindow().catch(() => app.quit());
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    quitting = true;
    serverProcess?.kill();
    serverProcess = null;
  });
}

if (isDev) console.log("Galaxy Agent (dev): backend + web from repo build.");
