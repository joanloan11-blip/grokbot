import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Context, Hono } from 'hono';
import type { AppConfig } from './config';
import type { Store, UserRecord } from './db';
import { HttpError, badRequest } from './errors';
import { extractUploadText } from './files';
import { decryptSecret, encryptSecret } from './github/secret';
import { checkMoyskladToken } from './moysklad';
import type { McpManager } from './mcp/manager';
import { runSandboxed } from './sandbox';
import { deliverToAgent, type TurnDeps } from './turn';
import { isRecord } from './util';

export function registerExtraRoutes(
  app: Hono,
  deps: {
    store: Store;
    mcp: McpManager;
    config: AppConfig;
    actor: (c: Context) => Promise<UserRecord>;
    readBody: (c: Context) => Promise<unknown>;
    runtime: TurnDeps;
  },
): void {
  const admin = async (c: Context) => {
    const user = await deps.actor(c);
    if (user.role !== 'admin')
      throw new HttpError(403, 'Только для администратора');
    return user;
  };

  app.get('/api/search', async (c) => {
    const user = await deps.actor(c);
    const query = (c.req.query('q') ?? '').trim();
    return c.json(await deps.store.searchMessages(user.id, query));
  });

  app.post('/api/transcribe', async (c) => {
    await deps.actor(c);
    const base = (process.env.WHISPER_URL ?? '').replace(/\/$/, '');
    if (!base)
      return c.json(
        { error: 'Распознавание речи не настроено (WHISPER_URL)' },
        503,
      );
    const body = await c.req.parseBody();
    const file = body.file;
    if (
      !file ||
      typeof file === 'string' ||
      typeof file.arrayBuffer !== 'function'
    )
      throw badRequest('Приложите аудио в поле file');
    if (file.size > 20_000_000) throw badRequest('Аудио больше 20 МБ');
    const raw = Buffer.from(await file.arrayBuffer());
    const wav = await toWav(raw).catch(() => undefined);
    const form = new FormData();
    const language = c.req.query('lang') === 'en' ? 'en' : 'ru';
    let url = `${base}/inference`;
    const headers: Record<string, string> = {};
    if (base.endsWith('/v1')) {
      // OpenAI-совместимый Whisper API.
      url = `${base}/audio/transcriptions`;
      form.append('model', process.env.WHISPER_MODEL || 'whisper-1');
      if (process.env.WHISPER_API_KEY)
        headers.authorization = `Bearer ${process.env.WHISPER_API_KEY}`;
    }
    form.append(
      'file',
      new Blob([wav ?? raw], {
        type: wav ? 'audio/wav' : file.type || 'audio/webm',
      }),
      wav ? 'voice.wav' : file.name || 'voice.webm',
    );
    form.append('response_format', 'json');
    form.append('language', language);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(180_000),
    }).catch(() => undefined);
    if (!response?.ok)
      return c.json({ error: 'Сервис распознавания не ответил' }, 502);
    const data = (await response.json().catch(() => ({}))) as {
      text?: unknown;
    };
    const text =
      typeof data.text === 'string'
        ? data.text.replace(/\[[^\]]*\]/g, '').trim()
        : '';
    return c.json({ text });
  });

  app.get('/api/tasks', async (c) => {
    const user = await deps.actor(c);
    const conversationId = c.req.query('conversationId') || undefined;
    return c.json(await deps.store.listTasks(user.id, conversationId));
  });

  app.get('/api/pages', async (c) => {
    const user = await deps.actor(c);
    return c.json(await deps.store.listPages(user.id));
  });

  app.get('/api/public/pages/:token', async (c) => {
    const page = await deps.store.getPageByToken(c.req.param('token'));
    if (!page) return c.text('Не найдено', 404);
    const safeTitle = escapeHtml(page.title);
    const safeBody = escapeHtml(page.body);
    return c.html(
      `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${safeTitle}</title>
      <body style="font-family:Georgia,serif;max-width:760px;margin:40px auto;padding:0 16px;background:#f6f1e7;color:#1b2430">
      <h1>${safeTitle}</h1><pre style="white-space:pre-wrap;font:16px/1.5 sans-serif">${safeBody}</pre></body>`,
    );
  });

  app.get('/api/files/:id', async (c) => {
    const user = await deps.actor(c);
    const file = await deps.store.getUpload(c.req.param('id'), user.id);
    if (!file) return c.json({ error: 'Файл не найден' }, 404);
    const bytes = fs.readFileSync(file.path);
    return new Response(bytes, {
      headers: {
        'content-type': file.mime || 'application/octet-stream',
        'content-disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
        'x-content-type-options': 'nosniff',
      },
    });
  });

  app.post('/api/conversations/:id/files', async (c) => {
    const user = await deps.actor(c);
    const conversation = await deps.store.getConversation(
      c.req.param('id'),
      user.id,
    );
    if (!conversation) return c.json({ error: 'Чат не найден' }, 404);
    const body = await c.req.parseBody();
    const file = body.file;
    if (
      !file ||
      typeof file === 'string' ||
      typeof file.arrayBuffer !== 'function'
    ) {
      throw badRequest('Приложите файл в поле file');
    }
    if (file.size > 8_000_000) throw badRequest('Файл больше 8 МБ');
    const bytes = Buffer.from(await file.arrayBuffer());
    const text = extractUploadText(
      file.name,
      file.type || 'application/octet-stream',
      bytes,
    );
    const dir = path.join(deps.config.dataDir, 'uploads', user.id);
    fs.mkdirSync(dir, { recursive: true });
    const idName = `${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`;
    const stored = path.join(dir, idName);
    fs.writeFileSync(stored, bytes);
    const id = await deps.store.insertUpload({
      userId: user.id,
      conversationId: conversation.id,
      name: file.name,
      mime: file.type || 'application/octet-stream',
      path: stored,
      text,
    });
    return c.json(
      {
        id,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        text: text.slice(0, 4000),
      },
      201,
    );
  });

  app.post('/api/messages/:id/reactions', async (c) => {
    const user = await deps.actor(c);
    const body = await deps.readBody(c);
    const emoji =
      isRecord(body) && typeof body.emoji === 'string'
        ? body.emoji.slice(0, 8)
        : '';
    if (!emoji) throw badRequest('Нужен emoji');
    await deps.store.setReaction(c.req.param('id'), user.id, emoji);
    return c.json({ ok: true });
  });

  app.post('/api/approvals/:id', async (c) => {
    const user = await deps.actor(c);
    const approval = await deps.store.getApproval(c.req.param('id'));
    if (!approval || approval.userId !== user.id) {
      return c.json({ error: 'Подтверждение не найдено' }, 404);
    }
    if (approval.status !== 'pending')
      return c.json({ ok: true, status: approval.status });
    const body = await deps.readBody(c);
    const allow = isRecord(body) && body.approve === true;
    if (!allow) {
      await deps.store.setApprovalStatus(approval.id, 'denied');
      return c.json({ ok: true, status: 'denied' });
    }
    const result = await replayApproval(deps.runtime, approval, user.id);
    await deps.store.setApprovalStatus(approval.id, 'approved');
    await deps.store.insertMessage({
      conversationId: approval.conversationId,
      role: 'assistant',
      content: `Подтверждено «${approval.toolName}»:\n\n${result.slice(0, 4000)}`,
    });
    return c.json({
      ok: true,
      status: 'approved',
      result: result.slice(0, 2000),
    });
  });

  app.get('/api/admin/search', async (c) => {
    await admin(c);
    return c.json({
      provider: (await deps.store.getSetting('search_provider')) || 'searxng',
      url: (await deps.store.getSetting('search_url')) || '',
      hasKey: Boolean(await deps.store.getSetting('search_key')),
      sandbox: (await deps.store.getSetting('code_sandbox')) === '1',
      approvals: (await deps.store.getSetting('approvals_enabled')) === '1',
      approvalAuto: (await deps.store.getSetting('approval_auto')) || '',
      telegram: Boolean(await deps.store.getSetting('telegram_token')),
      moysklad: Boolean(await deps.store.getSetting('moysklad_token')),
    });
  });

  // МойСклад: токен только на запись, наружу не отдаётся. Пустая строка — отключить.
  app.put('/api/admin/moysklad', async (c) => {
    await admin(c);
    const body = await deps.readBody(c);
    const token =
      isRecord(body) && typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) {
      await deps.store.setSetting('moysklad_token', '');
      return c.json({ ok: true, connected: false });
    }
    let who: string;
    try {
      who = await checkMoyskladToken(token);
    } catch (error) {
      throw badRequest(
        error instanceof Error ? error.message : 'МойСклад не ответил',
      );
    }
    await deps.store.setSetting(
      'moysklad_token',
      encryptSecret(token, deps.config.jwtSecret),
    );
    return c.json({ ok: true, connected: true, account: who });
  });

  app.get('/api/admin/moysklad', async (c) => {
    await admin(c);
    const stored = await deps.store.getSetting('moysklad_token');
    if (!stored) return c.json({ connected: false });
    try {
      const account = await checkMoyskladToken(
        decryptSecret(stored, deps.config.jwtSecret),
      );
      return c.json({ connected: true, account });
    } catch (error) {
      return c.json({
        connected: false,
        error: error instanceof Error ? error.message : 'ошибка',
      });
    }
  });

  app.put('/api/admin/search', async (c) => {
    await admin(c);
    const body = await deps.readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON');
    if (typeof body.provider === 'string') {
      await deps.store.setSetting('search_provider', body.provider);
    }
    if (typeof body.url === 'string')
      await deps.store.setSetting('search_url', body.url.trim());
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      await deps.store.setSetting(
        'search_key',
        encryptSecret(body.apiKey.trim(), deps.config.jwtSecret),
      );
    }
    if (typeof body.sandbox === 'boolean') {
      await deps.store.setSetting('code_sandbox', body.sandbox ? '1' : '0');
    }
    if (typeof body.approvals === 'boolean') {
      await deps.store.setSetting(
        'approvals_enabled',
        body.approvals ? '1' : '0',
      );
    }
    if (typeof body.approvalAuto === 'string') {
      await deps.store.setSetting(
        'approval_auto',
        body.approvalAuto.slice(0, 500),
      );
    }
    if (
      typeof body.dailyTokenLimit === 'number' &&
      typeof body.userId === 'string'
    ) {
      await deps.store.setSetting(
        `token_limit:${body.userId}`,
        String(Math.max(0, Math.floor(body.dailyTokenLimit))),
      );
    }
    return c.json({ ok: true });
  });

  app.put('/api/admin/telegram', async (c) => {
    await admin(c);
    const body = await deps.readBody(c);
    const token =
      isRecord(body) && typeof body.token === 'string' ? body.token.trim() : '';
    if (token.length < 10) throw badRequest('Вставьте токен бота');
    await deps.store.setSetting(
      'telegram_token',
      encryptSecret(token, deps.config.jwtSecret),
    );
    return c.json({ ok: true });
  });

  app.post('/api/telegram/link', async (c) => {
    const user = await deps.actor(c);
    const code = randomBytes(4).toString('hex');
    await deps.store.setSetting(`tg_link_${code}`, user.id);
    return c.json({ code, hint: `Отправьте боту /start ${code}` });
  });
}

async function replayApproval(
  deps: TurnDeps,
  approval: {
    toolName: string;
    arguments: string;
    conversationId: string;
    userId: string;
  },
  userId: string,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(approval.arguments) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    args = {};
  }
  if (approval.toolName === 'run_code') {
    return runSandboxed({
      enabled: (await deps.store.getSetting('code_sandbox')) === '1',
      language: String(args.language ?? ''),
      code: String(args.code ?? ''),
    });
  }
  if (approval.toolName === 'send_to_agent') {
    const conversation = await deps.store.getConversation(
      approval.conversationId,
      userId,
    );
    const agent = conversation?.agentId
      ? await deps.store.getAgent(conversation.agentId)
      : undefined;
    if (!agent) return 'Агент не найден';
    return deliverToAgent(deps, {
      from: agent,
      userId,
      targetName: String(args.agent ?? ''),
      message: String(args.message ?? ''),
      depth: 0,
      locale: 'ru',
    });
  }
  if (approval.toolName.startsWith('mcp__')) {
    const parts = approval.toolName.split('__');
    const serverName = parts[1];
    const toolName = parts.slice(2).join('__');
    const servers = await deps.store.listMcp();
    const server = servers.find((item) => item.name === serverName);
    if (!server) return 'MCP-сервер не найден';
    return deps.mcp.callTool(server.id, toolName, args);
  }
  return 'Это действие нельзя повторить автоматически.';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Перекодирует запись браузера (webm/ogg) в WAV 16 кГц mono для whisper.cpp. */
function toWav(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error('ffmpeg failed'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}
