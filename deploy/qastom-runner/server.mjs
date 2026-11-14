// Песочница QASTOM AGENT. Принимает POST /run от приложения и выполняет команду
// в рабочей папке пользователя от отдельного системного пользователя (uid на человека):
// чужие папки ему недоступны, фоновые процессы убиваются, время и вывод ограничены.
// Интернет — только через прокси с белым списком (npm, PyPI, GitHub).
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const TOKEN = process.env.RUNNER_TOKEN ?? '';
const ROOT = process.env.RUNNER_ROOT ?? '/work';
const PROXY = process.env.RUNNER_PROXY ?? '';
const MAX_PARALLEL = Number(process.env.RUNNER_PARALLEL) || 2;
const MAX_TIMEOUT = 600_000;
const OUTPUT_CAP = 30_000;

if (!TOKEN) {
  console.error('RUNNER_TOKEN не задан');
  process.exit(1);
}
fs.mkdirSync(ROOT, { recursive: true });
fs.chmodSync(ROOT, 0o711);

const safe = (value) => String(value).replace(/[^\w-]+/g, '_').slice(0, 80);
const uidFor = (user) =>
  20000 +
  (Number.parseInt(crypto.createHash('sha256').update(user).digest('hex').slice(0, 8), 16) %
    40000);

const busyUsers = new Set();
let running = 0;

function prepare(userDir, uid) {
  fs.mkdirSync(path.join(userDir, '.home', 'tmp'), { recursive: true });
  // Файлы, созданные приложением (root), передаём пользователю песочницы.
  try {
    execFileSync('find', [userDir, '-xdev', '!', '-uid', String(uid), '-exec', 'chown', '-h', `${uid}:${uid}`, '{}', '+']);
  } catch {
    // часть файлов могла исчезнуть по ходу — не страшно
  }
  fs.chmodSync(userDir, 0o700);
}

function clip(text) {
  if (text.length <= OUTPUT_CAP) return text;
  const head = text.slice(0, 6000);
  const tail = text.slice(-(OUTPUT_CAP - 6000));
  return `${head}\n… (пропущено ${text.length - OUTPUT_CAP} символов) …\n${tail}`;
}

function run({ user, scope, command, stdin, timeoutMs }) {
  const uid = uidFor(user);
  const userDir = path.join(ROOT, safe(user));
  const cwd = path.join(userDir, safe(scope));
  fs.mkdirSync(cwd, { recursive: true });
  prepare(userDir, uid);
  const home = path.join(userDir, '.home');
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    LANG: 'C.UTF-8',
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    ...(PROXY
      ? {
          HTTP_PROXY: PROXY,
          HTTPS_PROXY: PROXY,
          http_proxy: PROXY,
          https_proxy: PROXY,
          npm_config_proxy: PROXY,
          npm_config_https_proxy: PROXY,
        }
      : {}),
  };
  // Защита от форк-бомбы и гигантских файлов.
  const script =
    'ulimit -u 256; ulimit -f 2000000; exec bash --norc --noprofile -c "$QASTOM_CMD"';
  return new Promise((resolve) => {
    let out = '';
    let size = 0;
    const started = Date.now();
    const child = spawn('bash', ['--norc', '--noprofile', '-c', script], {
      cwd,
      env: { ...env, QASTOM_CMD: command },
      uid,
      gid: uid,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMs);
    const collect = (chunk) => {
      size += chunk.length;
      if (out.length < 400_000) out += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
    let done = false;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Убиваем всё, что команда оставила в фоне.
      try {
        execFileSync('pkill', ['-KILL', '-u', String(uid)]);
      } catch {}
      resolve({
        output: clip(error ? `${out}\n${error}` : out),
        code,
        timedOut,
        ms: Date.now() - started,
        bytes: size,
      });
    };
    child.on('error', (error) => finish(null, error.message));
    // Команда завершилась, а фоновый процесс держит вывод — не ждём его.
    child.on('exit', (code) => setTimeout(() => finish(code), 300));
    child.on('close', (code) => finish(code));
  });
}

/** Потоковый запуск: отдаёт чанки stdout/stderr по мере появления (NDJSON). */
function streamRun({ user, scope, command, timeoutMs, onEvent, onChild }) {
  return new Promise((resolve) => {
    const uid = uidFor(user);
    const userDir = path.join(ROOT, safe(user));
    const cwd = path.join(userDir, safe(scope));
    fs.mkdirSync(cwd, { recursive: true });
    prepare(userDir, uid);
    const home = path.join(userDir, '.home');
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      TMPDIR: path.join(home, 'tmp'),
      LANG: 'C.UTF-8',
      CI: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      ...(PROXY
        ? {
            HTTP_PROXY: PROXY,
            HTTPS_PROXY: PROXY,
            http_proxy: PROXY,
            https_proxy: PROXY,
            npm_config_proxy: PROXY,
            npm_config_https_proxy: PROXY,
          }
        : {}),
    };
    const script =
      'ulimit -u 256; ulimit -f 2000000; exec bash --norc --noprofile -c "$QASTOM_CMD"';
    const started = Date.now();
    const child = spawn('bash', ['--norc', '--noprofile', '-c', script], {
      cwd,
      env: { ...env, QASTOM_CMD: command },
      uid,
      gid: uid,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    onChild?.(child);
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let done = false;
    const cap = 1_000_000;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMs);
    const sendChunk = (stream) => (chunk) => {
      if (done || truncated) return;
      bytes += chunk.length;
      if (bytes > cap) {
        truncated = true;
        onEvent({ type: 'error', message: 'Вывод обрезан: больше 1 МБ' });
        return;
      }
      onEvent({ type: 'chunk', stream, data: chunk.toString('utf8') });
    };
    child.stdout.on('data', sendChunk('stdout'));
    child.stderr.on('data', sendChunk('stderr'));
    child.stdin.on('error', () => {});
    child.stdin.end('');
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        execFileSync('pkill', ['-KILL', '-u', String(uid)]);
      } catch {}
      onEvent({
        type: 'exit',
        code,
        timedOut,
        truncated,
        ms: Date.now() - started,
        bytes,
        ...(error ? { error } : {}),
      });
      resolve();
    };
    child.on('error', (error) => finish(null, error.message));
    child.on('exit', (code) => setTimeout(() => finish(code), 300));
    child.on('close', (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// Долгоживущие dev-серверы для превью (npm run dev и т. п.).
// Процесс запускается от uid песочницы и НЕ убивается после ответа; остановка —
// явная (POST /serve/:id/stop), по таймауту жизни или при перезапуске контейнера.
const serves = new Map();
const MAX_SERVES = Number(process.env.RUNNER_MAX_SERVES) || 6;
const SERVE_MAX_MS = Number(process.env.RUNNER_SERVE_MAX_MS) || 2 * 60 * 60 * 1000;
let serveSeq = 0;
const SERVE_ID = () => `s${Date.now().toString(36)}${(serveSeq += 1).toString(36)}`;

function servePublic(entry) {
  return {
    id: entry.id,
    user: entry.user,
    scope: entry.scope,
    command: entry.command,
    port: entry.port,
    status: entry.status,
    error: entry.error || '',
    startedAt: entry.startedAt,
    expiresAt: entry.expiresAt,
    logs: entry.logs,
  };
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
    socket.setTimeout(600, () => finish(false));
  });
}

async function waitForPort(port, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await portOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function sandboxEnv(user) {
  const userDir = path.join(ROOT, safe(user));
  const home = path.join(userDir, '.home');
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    LANG: 'C.UTF-8',
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    ...(PROXY
      ? {
          HTTP_PROXY: PROXY,
          HTTPS_PROXY: PROXY,
          http_proxy: PROXY,
          https_proxy: PROXY,
          npm_config_proxy: PROXY,
          npm_config_https_proxy: PROXY,
        }
      : {}),
  };
}

function stopServeEntry(entry, reason = '') {
  if (!entry || entry.status === 'stopped') return;
  entry.status = 'stopped';
  entry.error = reason;
  try {
    process.kill(-entry.pid, 'SIGTERM');
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-entry.pid, 'SIGKILL');
    } catch {}
  }, 2000).unref();
}

async function startServe({ user, scope, command, port, id: wantedId }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    return { error: 'port должен быть 1024..65535', status: 400 };
  if ([...serves.values()].some((entry) => entry.port === port))
    return { error: `Порт ${port} уже занят другим превью`, status: 409 };
  if ([...serves.values()].some((entry) => entry.user === user && entry.status === 'running'))
    return { error: 'У вас уже есть запущенный dev-сервер — остановите его', status: 429 };
  if ([...serves.values()].filter((entry) => entry.status === 'running').length >= MAX_SERVES)
    return { error: 'Слишком много запущенных превью, попробуйте позже', status: 429 };
  const uid = uidFor(user);
  const userDir = path.join(ROOT, safe(user));
  const cwd = path.join(userDir, safe(scope));
  fs.mkdirSync(cwd, { recursive: true });
  prepare(userDir, uid);
  const script =
    'ulimit -u 256; ulimit -f 2000000; exec bash --norc --noprofile -c "$QASTOM_CMD"';
  const safeId = /^[a-z0-9]{6,64}$/.test(String(wantedId ?? ''))
    ? String(wantedId)
    : SERVE_ID();
  if (serves.has(safeId)) return { error: 'Такой id уже занят', status: 409 };
  const entry = {
    id: safeId,
    user,
    scope,
    command,
    port,
    status: 'starting',
    error: '',
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SERVE_MAX_MS).toISOString(),
    logs: '',
    pid: 0,
    child: null,
  };
  const child = spawn('bash', ['--norc', '-c', script], {
    cwd,
    env: { ...sandboxEnv(user), PORT: String(port), HOST: '0.0.0.0', QASTOM_CMD: command },
    uid,
    gid: uid,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  entry.child = child;
  entry.pid = child.pid;
  serves.set(entry.id, entry);
  const collect = (chunk) => {
    entry.logs = (entry.logs + chunk.toString('utf8')).slice(-20_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', (error) => {
    entry.status = 'error';
    entry.error = error.message;
  });
  child.on('exit', (code) => {
    if (entry.status !== 'stopped') {
      entry.status = 'stopped';
      entry.error = `процесс завершился с кодом ${code ?? '—'}`;
    }
  });
  const opened = await waitForPort(port, 25_000);
  if (entry.status === 'starting') {
    entry.status = opened ? 'running' : 'error';
    if (!opened) entry.error = 'Сервер не открыл порт — посмотрите логи (команда должна слушать 0.0.0.0)';
  }
  return { serve: servePublic(entry) };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health')
    return send(res, 200, { ok: true });
  const given = Buffer.from(String(req.headers['x-runner-token'] ?? ''));
  const expected = Buffer.from(TOKEN);
  if (
    given.length !== expected.length ||
    !crypto.timingSafeEqual(given, expected)
  )
    return send(res, 401, { error: 'unauthorized' });

  // Долгоживущие dev-серверы превью.
  const stopMatch = req.url.match(/^\/serve\/([a-z0-9]+)\/stop$/);
  const infoMatch = req.url.match(/^\/serve\/([a-z0-9]+)$/);
  if (req.method === 'GET' && req.url === '/serve') {
    return send(res, 200, {
      serves: [...serves.values()].map(servePublic),
    });
  }
  if (req.method === 'GET' && infoMatch) {
    const entry = serves.get(infoMatch[1]);
    return entry
      ? send(res, 200, { serve: servePublic(entry) })
      : send(res, 404, { error: 'serve not found' });
  }
  if (req.method === 'POST' && stopMatch) {
    const entry = serves.get(stopMatch[1]);
    if (!entry) return send(res, 404, { error: 'serve not found' });
    stopServeEntry(entry, 'остановлен пользователем');
    return send(res, 200, { serve: servePublic(entry) });
  }

  const isStream = req.url === '/stream';
  const isServe = req.url === '/serve';
  if (req.method !== 'POST' || (req.url !== '/run' && !isStream && !isServe))
    return send(res, 404, { error: 'not found' });
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 1_000_000) req.destroy();
  });
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'bad json' });
    }
    const user = safe(body.user ?? '');
    const scope = safe(body.scope ?? '');
    const command = String(body.command ?? '');
    if (!user || !scope || !command)
      return send(res, 400, { error: 'user, scope, command' });
    if (isServe) {
      try {
        const result = await startServe({
          user,
          scope,
          command,
          port: Number(body.port) || 0,
          id: body.id,
        });
        if (result.error) return send(res, result.status, { error: result.error });
        return send(res, 201, result.serve);
      } catch (error) {
        return send(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (busyUsers.has(user))
      return send(res, 429, { error: 'Предыдущая команда этого пользователя ещё выполняется' });
    if (running >= MAX_PARALLEL)
      return send(res, 429, { error: 'Песочница занята другими командами, повторите через минуту' });
    busyUsers.add(user);
    running += 1;
    const timeoutMs = Math.min(
      MAX_TIMEOUT,
      Math.max(1000, Number(body.timeoutMs) || 120_000),
    );
    if (isStream) {
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      });
      let child = null;
      const kill = () => {
        try {
          if (child) process.kill(-child.pid, 'SIGKILL');
        } catch {}
      };
      // req 'close' срабатывает сразу после чтения тела — это не обрыв клиента.
      // Отменяем команду только когда закрылся ответ (клиент ушёл).
      res.on('close', kill);
      try {
        await streamRun({
          user,
          scope,
          command,
          timeoutMs,
          onEvent: (event) => {
            if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
          },
          onChild: (next) => {
            child = next;
          },
        });
      } catch (error) {
        if (!res.writableEnded)
          res.write(
            `${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })}\n`,
          );
      } finally {
        busyUsers.delete(user);
        running -= 1;
        if (!res.writableEnded) res.end();
      }
      return;
    }
    try {
      send(res, 200, await run({ user, scope, command, stdin: body.stdin, timeoutMs }));
    } catch (error) {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      busyUsers.delete(user);
      running -= 1;
    }
  });
});
server.requestTimeout = MAX_TIMEOUT + 30_000;
// Останавливаем превью, которые живут дольше двух часов.
setInterval(() => {
  const now = Date.now();
  for (const entry of serves.values()) {
    if (entry.status === 'running' && now > Date.parse(entry.expiresAt)) {
      stopServeEntry(entry, 'истёк срок жизни dev-сервера');
    }
  }
}, 60_000).unref();
server.listen(8080, () => console.log('runner :8080'));
