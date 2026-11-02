import { app, BrowserWindow, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
let server: ChildProcess | null = null;

function waitFor(url: string, timeoutMs = 40_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if ((res.statusCode ?? 500) < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(1000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs)
        reject(new Error(`Не дождались ${url}`));
      else setTimeout(tick, 300);
    };
    tick();
  });
}

async function createWindow(): Promise<void> {
  const devUrl = process.env.MAYAK_WEB_URL ?? 'http://127.0.0.1:5173';
  let url = devUrl;
  if (!isDev) {
    const port = process.env.PORT ?? '8787';
    const resources = process.resourcesPath;
    server = spawn(
      process.execPath,
      [path.join(resources, 'server', 'index.js')],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          HOST: '127.0.0.1',
          PORT: port,
          DATA_DIR: path.join(app.getPath('userData'), 'data'),
          STATIC_DIR: path.join(resources, 'web'),
          MAYAK_DEMO_SERVER: path.join(
            resources,
            'demo-mcp-server',
            'index.mjs',
          ),
        },
        stdio: 'inherit',
      },
    );
    url = `http://127.0.0.1:${port}`;
    await waitFor(`${url}/api/health`);
  } else {
    await waitFor(devUrl);
  }

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 640,
    title: 'Маяк',
    backgroundColor: '#09111c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  await window.loadURL(url);
}

app.whenReady().then(() => {
  void createWindow().catch((error: unknown) => {
    console.error(error);
    app.quit();
  });
});

app.on('window-all-closed', () => {
  server?.kill();
  app.quit();
});
