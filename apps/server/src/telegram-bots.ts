import type { Agent } from '@mayak/shared';
import type { TelegramBotRow } from './db';
import { HttpError } from './errors';
import { decryptSecret } from './github/secret';
import { transcribeAudio } from './transcribe';
import type { TurnDeps } from './turn';
import { runTurn } from './turn';
import { isRecord } from './util';

const API = 'https://api.telegram.org';
/** Telegram Bot API не отдаёт ботам файлы больше 20 МБ. */
const MAX_FILE_BYTES = 20_000_000;
/** Лимит длины одного сообщения Telegram в этой реализации (запас от 4096). */
const TEXT_LIMIT = 4_000;

/** Разобранное сообщение Telegram: только нужные воркеру поля. */
export interface ParsedTelegramMessage {
  updateId: number;
  message: {
    chatId: string;
    fromId: string;
    text?: string;
    voiceFileId?: string;
    audioFileId?: string;
    videoNoteFileId?: string;
    mime?: string;
  };
}

interface WorkerOptions {
  fetchImpl: typeof fetch;
  runTurn: typeof runTurn;
}

/**
 * Чистая функция: вытаскивает из update_id и message поля, которые понимает
 * воркер. Всё, что не похоже на сообщение (edited_message, callback и т.п.),
 * возвращает null.
 */
export function parseTelegramMessage(
  update: unknown,
): ParsedTelegramMessage | null {
  if (!isRecord(update)) return null;
  const updateId = update.update_id;
  if (typeof updateId !== 'number' || !Number.isFinite(updateId)) return null;
  const message = update.message;
  if (!isRecord(message)) return null;
  const chatId = isRecord(message.chat) ? idOf(message.chat.id) : undefined;
  const fromId = isRecord(message.from) ? idOf(message.from.id) : undefined;
  if (!chatId || !fromId) return null;

  const voice = isRecord(message.voice) ? message.voice : undefined;
  const audio = isRecord(message.audio) ? message.audio : undefined;
  const videoNote = isRecord(message.video_note)
    ? message.video_note
    : undefined;
  const voiceFileId = fileIdOf(voice);
  const audioFileId = fileIdOf(audio);
  const videoNoteFileId = fileIdOf(videoNote);
  const mime =
    stringOf(voice, 'mime_type') ??
    stringOf(audio, 'mime_type') ??
    (videoNoteFileId ? 'video/mp4' : undefined);
  const text =
    typeof message.text === 'string' && message.text.trim()
      ? message.text.trim()
      : undefined;

  const parsed: ParsedTelegramMessage = {
    updateId: Math.floor(updateId),
    message: { chatId, fromId },
  };
  const target = parsed.message;
  if (text) target.text = text;
  if (voiceFileId) target.voiceFileId = voiceFileId;
  if (audioFileId) target.audioFileId = audioFileId;
  if (videoNoteFileId) target.videoNoteFileId = videoNoteFileId;
  if (mime) target.mime = mime;
  return parsed;
}

/**
 * Запускает фоновый опрос личных ботов всех пользователей.
 * Возвращает функцию остановки; ошибки одного бота или сообщения не
 * останавливают цикл.
 */
export function startTelegramBots(
  deps: TurnDeps,
  options: {
    fetchImpl?: typeof fetch;
    pollMs?: number;
    runTurn?: typeof runTurn;
  } = {},
): () => void {
  const worker: WorkerOptions = {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    runTurn: options.runTurn ?? runTurn,
  };
  const pollMs = options.pollMs ?? 2_500;
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    timer = undefined;
    if (stopped || running) return;
    running = true;
    try {
      const bots = await deps.store.listTelegramBots();
      for (const bot of bots) {
        if (stopped) break;
        try {
          await pollBot(deps, bot, worker);
        } catch {
          // один сломанный бот не должен ломать опрос остальных
        }
      }
    } catch {
      // база временно недоступна — повторим на следующем тике
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(() => void tick(), pollMs);
        timer.unref?.();
      }
    }
  };

  timer = setTimeout(() => void tick(), 0);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

/**
 * Отправляет рутинное уведомление в личный бот пользователя (если он создан).
 * Возвращает false, если бота нет или отправка не удалась.
 */
export async function notifyUserTelegram(
  deps: TurnDeps,
  userId: string,
  name: string,
  text: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  let bot: TelegramBotRow | undefined;
  try {
    bot = await deps.store.getTelegramBotForUser(userId);
  } catch {
    return false;
  }
  if (!bot || !bot.tgUserId) return false;
  const token = botToken(deps, bot);
  if (!token) return false;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const chunks = splitTelegramText(`Рутина «${name}»:\n${text}`);
  if (!chunks.length) return false;
  for (const chunk of chunks) {
    if (!(await sendMessage(fetchImpl, token, bot.tgUserId, chunk)))
      return false;
  }
  return true;
}

/** Проверяет токен бота через getMe. Токен не попадает в тексты ошибок. */
export async function checkTelegramToken(
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ ok: boolean; username?: string; error?: string }> {
  const response = await fetchImpl(`${API}/bot${token}/getMe`, {
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined);
  if (!response?.ok) {
    return { ok: false, error: 'Telegram не ответил на проверку токена' };
  }
  const body = (await response.json().catch(() => undefined)) as
    | { ok?: unknown; result?: unknown; description?: unknown }
    | undefined;
  if (!isRecord(body) || body.ok !== true || !isRecord(body.result)) {
    const description =
      isRecord(body) && typeof body.description === 'string'
        ? body.description
        : 'Токен не принят Telegram';
    return { ok: false, error: description };
  }
  const username =
    typeof body.result.username === 'string' ? body.result.username : '';
  return username ? { ok: true, username } : { ok: true };
}

/** Отправляет тестовое сообщение в указанный чат. */
export async function sendTelegramTest(
  token: string,
  chatId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ ok: boolean; error?: string }> {
  const ok = await sendMessage(fetchImpl, token, chatId, 'Проверка связи ✅');
  return ok
    ? { ok: true }
    : { ok: false, error: 'Telegram не принял сообщение' };
}

/**
 * Режет длинный ответ на сообщения не длиннее limit символов.
 * Сначала пытается сохранить абзацы, длинные абзацы режет по словам.
 */
export function splitTelegramText(text: string, limit = TEXT_LIMIT): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const max = Math.max(1, Math.floor(limit));
  if (clean.length <= max) return [clean];

  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };

  for (const paragraph of clean.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    flush();
    if (paragraph.length <= max) {
      current = paragraph;
      continue;
    }
    // Слишком длинный абзац: режем по словам, а неразрывные слова — жёстко.
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (word.length > max) {
        flush();
        if (line) {
          chunks.push(line);
          line = '';
        }
        for (let i = 0; i < word.length; i += max) {
          chunks.push(word.slice(i, i + max));
        }
        continue;
      }
      const next = line ? `${line} ${word}` : word;
      if (next.length <= max) line = next;
      else {
        chunks.push(line);
        line = word;
      }
    }
    current = line;
  }
  flush();
  return chunks;
}

/** Расшифровывает токен бота; при ошибке шифрования бот считается нерабочим. */
function botToken(deps: TurnDeps, bot: TelegramBotRow): string | undefined {
  if (!deps.jwtSecret || !bot.tokenEnc) return undefined;
  try {
    return decryptSecret(bot.tokenEnc, deps.jwtSecret) || undefined;
  } catch {
    return undefined;
  }
}

/** Опрашивает одного бота и обрабатывает все новые update. */
async function pollBot(
  deps: TurnDeps,
  bot: TelegramBotRow,
  worker: WorkerOptions,
): Promise<void> {
  const token = botToken(deps, bot);
  if (!token) return;
  const offset = Math.max(0, bot.lastUpdateId) + 1;
  const response = await worker
    .fetchImpl(`${API}/bot${token}/getUpdates?offset=${offset}&timeout=0`, {
      signal: AbortSignal.timeout(20_000),
    })
    .catch(() => undefined);
  if (!response?.ok) return;
  const body = (await response.json().catch(() => undefined)) as
    | { ok?: unknown; result?: unknown }
    | undefined;
  if (!isRecord(body) || !Array.isArray(body.result)) return;

  for (const update of body.result) {
    const parsed = parseTelegramMessage(update);
    if (!parsed) continue;
    // Сохраняем offset сразу: сбой обработки не должен приводить к вечному повтору.
    try {
      await deps.store.setTelegramBotUpdate(bot.userId, parsed.updateId);
    } catch {
      // база может быть временно недоступна — обработаем сообщение всё равно
    }
    bot.lastUpdateId = parsed.updateId;
    try {
      await handleMessage(deps, token, bot, parsed.message, worker);
    } catch {
      // ошибка одного сообщения не останавливает воркер
    }
  }
}

/** Обрабатывает одно сообщение: команды, текст или голос. */
async function handleMessage(
  deps: TurnDeps,
  token: string,
  bot: TelegramBotRow,
  message: ParsedTelegramMessage['message'],
  worker: WorkerOptions,
): Promise<void> {
  const { chatId, fromId } = message;
  if (fromId !== bot.tgUserId) {
    await sendMessage(
      worker.fetchImpl,
      token,
      chatId,
      'Этот бот личный: общаться с ним может только его владелец.',
    );
    return;
  }

  const command = commandOf(message.text);
  if (command === '/start' || command === '/help') {
    await sendMessage(
      worker.fetchImpl,
      token,
      chatId,
      command === '/start' ? START_TEXT : HELP_TEXT,
    );
    return;
  }

  const agent = await findAgent(deps, bot);
  if (!agent) {
    await sendMessage(
      worker.fetchImpl,
      token,
      chatId,
      'Агент не найден. Проверьте настройки в QASTOM AGENT.',
    );
    return;
  }

  if (command === '/new') {
    await startNewChat(deps, bot, agent);
    await sendMessage(
      worker.fetchImpl,
      token,
      chatId,
      'Начат новый чат. Напишите сообщение.',
    );
    return;
  }

  const fileId =
    message.voiceFileId ?? message.audioFileId ?? message.videoNoteFileId;
  if (fileId) {
    const transcript = await recognizeVoice(
      token,
      chatId,
      fileId,
      message.mime,
      worker,
    );
    if (transcript === undefined) return;
    if (!transcript) {
      await sendMessage(
        worker.fetchImpl,
        token,
        chatId,
        'Не расслышал, повторите.',
      );
      return;
    }
    // Сначала короткая строка с распознанным текстом, затем ответ агента.
    await sendMessage(
      worker.fetchImpl,
      token,
      chatId,
      `🎧 ${transcript.length > 500 ? `${transcript.slice(0, 499)}…` : transcript}`,
    );
    await replyWithAgent(deps, token, bot, agent, chatId, transcript, worker);
    return;
  }

  if (!message.text) return;
  await replyWithAgent(deps, token, bot, agent, chatId, message.text, worker);
}

/** Ответ агента в чате «Telegram: <имя агента>». */
async function replyWithAgent(
  deps: TurnDeps,
  token: string,
  bot: TelegramBotRow,
  agent: Agent,
  chatId: string,
  text: string,
  worker: WorkerOptions,
): Promise<void> {
  const title = `Telegram: ${agent.name}`;
  try {
    let conversation = await deps.store.findConversationByTitle(
      bot.userId,
      agent.id,
      title,
    );
    if (!conversation) {
      conversation = await deps.store.insertConversation({
        title,
        agentId: agent.id,
        userId: bot.userId,
        providerId: agent.providerId,
        model: agent.model,
      });
    }
    const result = await worker.runTurn(deps, {
      conversationId: conversation.id,
      content: text,
      locale: 'ru',
      userId: bot.userId,
      depth: 0,
    });
    const answer = result.text.trim() || 'Пустой ответ.';
    for (const chunk of splitTelegramText(answer)) {
      await sendMessage(worker.fetchImpl, token, chatId, chunk);
    }
  } catch {
    await sendMessage(
      worker.fetchImpl,
      token,
      chatId,
      'Не получилось обработать сообщение, попробуйте ещё раз.',
    );
  }
}

/** /new: переименовывает текущий чат, чтобы следующее сообщение создало новый. */
async function startNewChat(
  deps: TurnDeps,
  bot: TelegramBotRow,
  agent: Agent,
): Promise<void> {
  const title = `Telegram: ${agent.name}`;
  try {
    const conversation = await deps.store.findConversationByTitle(
      bot.userId,
      agent.id,
      title,
    );
    if (!conversation) return;
    await deps.store.updateConversation(conversation.id, {
      title: `${title} (${new Date().toISOString()})`,
    });
  } catch {
    // не критично: новый чат можно создать и позже
  }
}

/**
 * Скачивает голосовое/видеосообщение и распознаёт его.
 * Возвращает текст, '' если речь не распознана, или undefined при ошибке
 * (сообщение об ошибке уже отправлено пользователю).
 */
async function recognizeVoice(
  token: string,
  chatId: string,
  fileId: string,
  mime: string | undefined,
  worker: WorkerOptions,
): Promise<string | undefined> {
  const filePath = await telegramFilePath(worker.fetchImpl, token, fileId);
  if (!filePath) {
    await sendMessage(
      worker.fetchImpl,
      token,
      chatId,
      'Не удалось получить голосовое сообщение.',
    );
    return undefined;
  }
  const response = await worker
    .fetchImpl(`${API}/file/bot${token}/${filePath}`, {
      signal: AbortSignal.timeout(60_000),
    })
    .catch(() => undefined);
  if (!response?.ok) {
    await sendMessage(
      worker.fetchImpl,
      token,
      chatId,
      'Не удалось скачать голосовое сообщение.',
    );
    return undefined;
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength > MAX_FILE_BYTES) {
    await sendMessage(
      worker.fetchImpl,
      token,
      chatId,
      'Голосовое сообщение больше 20 МБ.',
    );
    return undefined;
  }
  try {
    return await transcribeAudio(data, {
      locale: 'ru',
      mime,
      filename: filePath.split('/').pop() || 'voice.ogg',
      fetchImpl: worker.fetchImpl,
    });
  } catch (error) {
    const notConfigured = error instanceof HttpError && error.status === 503;
    await sendMessage(
      worker.fetchImpl,
      token,
      chatId,
      notConfigured
        ? 'Распознавание речи не настроено (WHISPER_URL).'
        : 'Не удалось распознать голосовое сообщение, попробуйте ещё раз.',
    );
    return undefined;
  }
}

/** getFile: узнаёт file_path для скачивания. */
async function telegramFilePath(
  fetchImpl: typeof fetch,
  token: string,
  fileId: string,
): Promise<string | undefined> {
  const response = await fetchImpl(
    `${API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
    { signal: AbortSignal.timeout(20_000) },
  ).catch(() => undefined);
  if (!response?.ok) return undefined;
  const body = (await response.json().catch(() => undefined)) as
    | { ok?: unknown; result?: unknown }
    | undefined;
  if (!isRecord(body) || body.ok !== true || !isRecord(body.result))
    return undefined;
  const filePath = body.result.file_path;
  return typeof filePath === 'string' && filePath ? filePath : undefined;
}

/** Агент личного бота: указанный в настройках или первый доступный. */
async function findAgent(
  deps: TurnDeps,
  bot: TelegramBotRow,
): Promise<Agent | undefined> {
  try {
    const agent = bot.agentId
      ? await deps.store.getAgent(bot.agentId)
      : undefined;
    if (agent) return agent;
    const agents = await deps.store.listAgents();
    return agents[0];
  } catch {
    return undefined;
  }
}

/** Отправляет текст в чат; ошибки сети не пробрасываются. */
async function sendMessage(
  fetchImpl: typeof fetch,
  token: string,
  chatId: string,
  text: string,
): Promise<boolean> {
  if (!text || !chatId) return false;
  const response = await fetchImpl(`${API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined);
  return Boolean(response?.ok);
}

function commandOf(text: string | undefined): string {
  if (!text || !text.startsWith('/')) return '';
  return (text.split(/\s+/)[0] ?? '').split('@')[0].toLowerCase();
}

function idOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function fileIdOf(record: Record<string, unknown> | undefined) {
  return record ? idOf(record.file_id) : undefined;
}

function stringOf(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const START_TEXT =
  'Привет! Я ваш личный ассистент. Напишите вопрос текстом или отправьте голосовое сообщение — отвечу здесь же.\n\n/new — новый чат, /help — подсказка.';
const HELP_TEXT =
  'Просто напишите сообщение или отправьте голосовое — я отвечу как личный ассистент.\n\nКоманды:\n/start — приветствие\n/help — эта подсказка\n/new — начать новый чат';
