import type { Agent, Conversation } from '@mayak/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store, TelegramBotRow } from '../src/db';
import { encryptSecret } from '../src/github/secret';
import {
  checkTelegramToken,
  notifyUserTelegram,
  parseTelegramMessage,
  sendTelegramTest,
  splitTelegramText,
  startTelegramBots,
} from '../src/telegram-bots';
import type { TurnDeps, TurnInput } from '../src/turn';

const JWT = 'test-jwt-secret';
const TOKEN = '123456:TEST-BOT-TOKEN';
const OWNER_ID = '777';

const AGENT: Agent = {
  id: 'agent-1',
  name: 'Джарвис',
  emoji: '🤖',
  description: '',
  systemPrompt: '',
  providerId: 'provider-1',
  model: 'model-1',
  mcpServerIds: [],
  skillNames: [],
  githubRepos: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

type RunTurn = typeof import('../src/turn').runTurn;

/** Подменённый Store: только методы, которые нужны воркеру. */
class FakeStore {
  bots: TelegramBotRow[] = [];
  conversations: Conversation[] = [];
  agent: Agent = AGENT;
  private counter = 0;

  async listTelegramBots(): Promise<TelegramBotRow[]> {
    return this.bots;
  }

  async getTelegramBotForUser(
    userId: string,
  ): Promise<TelegramBotRow | undefined> {
    return this.bots.find((bot) => bot.userId === userId);
  }

  async upsertTelegramBot(input: {
    userId: string;
    agentId: string;
    tokenEnc: string;
    tgUserId: string;
    username: string;
  }): Promise<TelegramBotRow> {
    const row = makeBot({
      userId: input.userId,
      agentId: input.agentId,
      tokenEnc: input.tokenEnc,
      tgUserId: input.tgUserId,
      username: input.username,
    });
    this.bots = [
      ...this.bots.filter((bot) => bot.userId !== input.userId),
      row,
    ];
    return row;
  }

  async deleteTelegramBot(userId: string): Promise<void> {
    this.bots = this.bots.filter((bot) => bot.userId !== userId);
  }

  async setTelegramBotUpdate(userId: string, updateId: number): Promise<void> {
    const bot = this.bots.find((item) => item.userId === userId);
    if (bot) bot.lastUpdateId = updateId;
  }

  async getAgent(id: string): Promise<Agent | undefined> {
    return id === this.agent.id ? this.agent : undefined;
  }

  async listAgents(): Promise<Agent[]> {
    return [this.agent];
  }

  async findConversationByTitle(
    userId: string,
    agentId: string,
    title: string,
  ): Promise<Conversation | undefined> {
    return this.conversations.find(
      (item) =>
        item.userId === userId &&
        item.agentId === agentId &&
        item.title === title,
    );
  }

  async insertConversation(input: {
    title: string;
    agentId: string | null;
    userId: string;
    providerId: string | null;
    model: string | null;
    projectId?: string | null;
  }): Promise<Conversation> {
    const conversation: Conversation = {
      id: `conv-${++this.counter}`,
      title: input.title,
      agentId: input.agentId,
      userId: input.userId,
      providerId: input.providerId,
      model: input.model,
      projectId: input.projectId ?? null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    this.conversations.push(conversation);
    return conversation;
  }

  async updateConversation(
    id: string,
    patch: { title?: string },
  ): Promise<Conversation | undefined> {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) return undefined;
    if (patch.title !== undefined) conversation.title = patch.title;
    return conversation;
  }
}

function makeBot(overrides: Partial<TelegramBotRow> = {}): TelegramBotRow {
  return {
    userId: 'user-1',
    agentId: AGENT.id,
    tokenEnc: encryptSecret(TOKEN, JWT),
    tgUserId: OWNER_ID,
    username: 'jarvis_bot',
    lastUpdateId: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDeps(store: FakeStore): TurnDeps {
  return {
    store: store as unknown as Store,
    mcp: {} as never,
    skills: {} as never,
    jwtSecret: JWT,
  };
}

function makeConversation(id: string, title: string): Conversation {
  return {
    id,
    title,
    agentId: AGENT.id,
    userId: 'user-1',
    providerId: AGENT.providerId,
    model: AGENT.model,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface FakePlan {
  updates?: unknown[];
  send?: { chatId: string; text: string }[];
  filePath?: string;
  fileBytes?: Uint8Array;
  whisperText?: string;
  getMe?: unknown;
  updatesStatus?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeTelegram(plan: FakePlan): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes('/getUpdates')) {
      if (plan.updatesStatus && plan.updatesStatus !== 200) {
        return new Response('error', { status: plan.updatesStatus });
      }
      const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
      const updates = plan.updates ?? [];
      const pending = updates.filter(
        (update) => (update as { update_id: number }).update_id >= offset,
      );
      return jsonResponse({ ok: true, result: pending });
    }
    if (url.includes('/sendMessage')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        chat_id?: string | number;
        text?: string;
      };
      plan.send?.push({
        chatId: String(body.chat_id ?? ''),
        text: String(body.text ?? ''),
      });
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    }
    if (url.includes('/getFile')) {
      return jsonResponse({
        ok: true,
        result: { file_path: plan.filePath ?? 'voice/file.ogg' },
      });
    }
    if (url.includes('/file/bot')) {
      return new Response(
        plan.fileBytes ?? new Uint8Array(Buffer.from('audio-bytes')),
        { status: 200 },
      );
    }
    if (url.includes('/getMe')) {
      return jsonResponse(
        plan.getMe ?? { ok: true, result: { username: 'jarvis_bot' } },
      );
    }
    if (url.endsWith('/inference')) {
      return jsonResponse({ text: plan.whisperText ?? 'привет' });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function textUpdate(
  updateId: number,
  text: string,
  fromId: string | number = OWNER_ID,
): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: OWNER_ID },
      from: { id: fromId },
      text,
    },
  };
}

function voiceUpdate(updateId: number): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: OWNER_ID },
      from: { id: OWNER_ID },
      voice: { file_id: 'voice-1', mime_type: 'audio/ogg' },
    },
  };
}

function runTurnStub(answer = 'Ответ агента', sink?: TurnInput[]): RunTurn {
  return async (_deps, input) => {
    sink?.push(input);
    return { text: answer };
  };
}

async function waitUntil(
  check: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs)
      throw new Error('Таймаут ожидания воркера');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const stops: Array<() => void> = [];

async function start(
  store: FakeStore,
  fetchImpl: typeof fetch,
  runTurn: RunTurn,
): Promise<void> {
  stops.push(
    startTelegramBots(makeDeps(store), {
      fetchImpl,
      pollMs: 5,
      runTurn,
    }),
  );
}

const savedWhisperUrl = process.env.WHISPER_URL;

beforeEach(() => {
  process.env.WHISPER_URL = '';
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  if (savedWhisperUrl === undefined) delete process.env.WHISPER_URL;
  else process.env.WHISPER_URL = savedWhisperUrl;
});

describe('parseTelegramMessage', () => {
  it('разбирает текстовое сообщение', () => {
    expect(parseTelegramMessage(textUpdate(5, '  привет  '))).toEqual({
      updateId: 5,
      message: { chatId: '777', fromId: '777', text: 'привет' },
    });
  });

  it('разбирает голосовое сообщение с mime', () => {
    expect(parseTelegramMessage(voiceUpdate(7))).toEqual({
      updateId: 7,
      message: {
        chatId: '777',
        fromId: '777',
        voiceFileId: 'voice-1',
        mime: 'audio/ogg',
      },
    });
  });

  it('разбирает видеокружок', () => {
    const parsed = parseTelegramMessage({
      update_id: 9,
      message: {
        chat: { id: 777 },
        from: { id: 777 },
        video_note: { file_id: 'note-1' },
      },
    });
    expect(parsed?.message.videoNoteFileId).toBe('note-1');
    expect(parsed?.message.mime).toBe('video/mp4');
  });

  it('возвращает null для мусора', () => {
    expect(parseTelegramMessage(null)).toBeNull();
    expect(parseTelegramMessage('update')).toBeNull();
    expect(parseTelegramMessage({})).toBeNull();
    expect(parseTelegramMessage({ update_id: 1 })).toBeNull();
    expect(
      parseTelegramMessage({
        update_id: 1,
        message: { text: 'без чата' },
      }),
    ).toBeNull();
    expect(
      parseTelegramMessage({ update_id: 1, message: { chat: {} } }),
    ).toBeNull();
  });
});

describe('splitTelegramText', () => {
  it('короткий текст остаётся одним сообщением', () => {
    expect(splitTelegramText('привет')).toEqual(['привет']);
    expect(splitTelegramText('   ')).toEqual([]);
  });

  it('режет длинный текст на части не больше лимита', () => {
    const paragraph = 'слово '.repeat(300).trim(); // ~1800 символов
    const text = [paragraph, paragraph, paragraph, paragraph, paragraph].join(
      '\n\n',
    );
    const chunks = splitTelegramText(text, 4_000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4_000);
    expect(chunks.join(' ')).toContain('слово');
  });

  it('жёстко режет слово длиннее лимита', () => {
    const chunks = splitTelegramText('a'.repeat(25), 10);
    expect(chunks).toEqual(['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaa']);
  });

  it('использует лимит по умолчанию 4000', () => {
    const chunks = splitTelegramText('б'.repeat(8_500));
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4_000);
  });
});

describe('startTelegramBots', () => {
  it('обрабатывает текст: runTurn и ответ в чат', async () => {
    const store = new FakeStore();
    store.bots = [makeBot()];
    const plan: FakePlan = { updates: [textUpdate(5, 'привет')], send: [] };
    const { fetchImpl } = fakeTelegram(plan);
    const inputs: TurnInput[] = [];

    await start(store, fetchImpl, runTurnStub('Здравствуйте!', inputs));
    await waitUntil(() => (plan.send?.length ?? 0) > 0 && inputs.length > 0);

    expect(inputs[0]).toMatchObject({
      content: 'привет',
      locale: 'ru',
      userId: 'user-1',
      depth: 0,
    });
    expect(plan.send?.at(-1)?.text).toBe('Здравствуйте!');
    expect(store.conversations).toHaveLength(1);
    expect(store.conversations[0]?.title).toBe('Telegram: Джарвис');
    expect(store.conversations[0]?.providerId).toBe('provider-1');
    expect(store.conversations[0]?.model).toBe('model-1');
    expect(store.bots[0]?.lastUpdateId).toBe(5);
  });

  it('отказывает чужому from.id и не запускает runTurn', async () => {
    const store = new FakeStore();
    store.bots = [makeBot()];
    const plan: FakePlan = {
      updates: [textUpdate(1, 'привет', 999)],
      send: [],
    };
    const { fetchImpl } = fakeTelegram(plan);
    const inputs: TurnInput[] = [];

    await start(store, fetchImpl, runTurnStub('не должен', inputs));
    await waitUntil(() => (plan.send?.length ?? 0) > 0);

    expect(inputs).toHaveLength(0);
    expect(store.conversations).toHaveLength(0);
    expect(plan.send?.[0]?.text).toContain('личный');
  });

  it('распознаёт голосовое и отвечает с префиксом 🎧', async () => {
    process.env.WHISPER_URL = 'http://whisper.local';
    const store = new FakeStore();
    store.bots = [makeBot()];
    const plan: FakePlan = {
      updates: [voiceUpdate(2)],
      send: [],
      whisperText: 'напомни про встречу',
    };
    const { fetchImpl, calls } = fakeTelegram(plan);
    const inputs: TurnInput[] = [];

    await start(store, fetchImpl, runTurnStub('Хорошо, напомню.', inputs));
    await waitUntil(() => inputs.length > 0 && (plan.send?.length ?? 0) >= 2);

    expect(inputs[0]?.content).toBe('напомни про встречу');
    const texts = (plan.send ?? []).map((item) => item.text);
    expect(texts).toContain('🎧 напомни про встречу');
    expect(texts.at(-1)).toBe('Хорошо, напомню.');
    expect(calls.some((call) => call.url.includes('/getFile'))).toBe(true);
    expect(calls.some((call) => call.url.includes('/file/bot'))).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/inference'))).toBe(true);
    const whisperCall = calls.find((call) => call.url.endsWith('/inference'));
    const form = whisperCall?.init.body as FormData;
    expect(form.get('language')).toBe('ru');
  });

  it('просит повторить, если речь не распознана', async () => {
    process.env.WHISPER_URL = 'http://whisper.local';
    const store = new FakeStore();
    store.bots = [makeBot()];
    const plan: FakePlan = {
      updates: [voiceUpdate(3)],
      send: [],
      whisperText: '   ',
    };
    const { fetchImpl } = fakeTelegram(plan);
    const inputs: TurnInput[] = [];

    await start(store, fetchImpl, runTurnStub('ответ', inputs));
    await waitUntil(() => (plan.send?.length ?? 0) > 0);

    expect(inputs).toHaveLength(0);
    expect(plan.send?.[0]?.text).toBe('Не расслышал, повторите.');
  });

  it('отвечает на /start приветствием', async () => {
    const store = new FakeStore();
    store.bots = [makeBot()];
    const plan: FakePlan = { updates: [textUpdate(1, '/start')], send: [] };
    const { fetchImpl } = fakeTelegram(plan);
    const inputs: TurnInput[] = [];

    await start(store, fetchImpl, runTurnStub('ответ', inputs));
    await waitUntil(() => (plan.send?.length ?? 0) > 0);

    expect(plan.send?.[0]?.text).toContain('Привет');
    expect(inputs).toHaveLength(0);
  });

  it('/new переименовывает чат, следующее сообщение создаёт новый', async () => {
    const store = new FakeStore();
    store.bots = [makeBot()];
    store.conversations.push(makeConversation('old-chat', 'Telegram: Джарвис'));
    const plan: FakePlan = {
      updates: [textUpdate(1, '/new'), textUpdate(2, 'привет')],
      send: [],
    };
    const { fetchImpl } = fakeTelegram(plan);
    const inputs: TurnInput[] = [];

    await start(store, fetchImpl, runTurnStub('Новый ответ', inputs));
    await waitUntil(() => inputs.length > 0);

    expect(store.conversations).toHaveLength(2);
    expect(store.conversations[0]?.title).toMatch(/^Telegram: Джарвис \(/);
    expect(store.conversations[1]?.title).toBe('Telegram: Джарвис');
    expect(inputs[0]?.content).toBe('привет');
    expect(
      (plan.send ?? []).some((item) => item.text.includes('Начат новый чат')),
    ).toBe(true);
  });

  it('ошибка runTurn не ломает воркер', async () => {
    const store = new FakeStore();
    store.bots = [makeBot()];
    const plan: FakePlan = { updates: [textUpdate(1, 'привет')], send: [] };
    const { fetchImpl } = fakeTelegram(plan);
    const failing: RunTurn = async () => {
      throw new Error('модель недоступна');
    };

    await start(store, fetchImpl, failing);
    await waitUntil(() => (plan.send?.length ?? 0) > 0);

    expect(plan.send?.[0]?.text).toBe(
      'Не получилось обработать сообщение, попробуйте ещё раз.',
    );
  });
});

describe('служебные функции Telegram', () => {
  it('checkTelegramToken возвращает username', async () => {
    const { fetchImpl } = fakeTelegram({
      getMe: { ok: true, result: { username: 'jarvis_bot' } },
    });
    await expect(checkTelegramToken(TOKEN, fetchImpl)).resolves.toEqual({
      ok: true,
      username: 'jarvis_bot',
    });
  });

  it('checkTelegramToken отдаёт ошибку без токена в тексте', async () => {
    const { fetchImpl } = fakeTelegram({
      getMe: { ok: false, description: 'Unauthorized' },
    });
    const result = await checkTelegramToken(TOKEN, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Unauthorized');
    expect(result.error ?? '').not.toContain(TOKEN);
  });

  it('sendTelegramTest отправляет проверочное сообщение', async () => {
    const plan: FakePlan = { send: [] };
    const { fetchImpl } = fakeTelegram(plan);
    await expect(sendTelegramTest(TOKEN, OWNER_ID, fetchImpl)).resolves.toEqual(
      { ok: true },
    );
    expect(plan.send?.[0]).toEqual({
      chatId: OWNER_ID,
      text: 'Проверка связи ✅',
    });
  });

  it('notifyUserTelegram отправляет рутину в личный бот', async () => {
    const store = new FakeStore();
    store.bots = [makeBot()];
    const plan: FakePlan = { send: [] };
    const { fetchImpl } = fakeTelegram(plan);

    await expect(
      notifyUserTelegram(makeDeps(store), 'user-1', 'Утренняя', 'Доброе утро', {
        fetchImpl,
      }),
    ).resolves.toBe(true);

    expect(plan.send?.[0]?.chatId).toBe(OWNER_ID);
    expect(plan.send?.[0]?.text).toContain('Рутина «Утренняя»:');
    expect(plan.send?.[0]?.text).toContain('Доброе утро');
  });

  it('notifyUserTelegram возвращает false без бота', async () => {
    const store = new FakeStore();
    const plan: FakePlan = { send: [] };
    const { fetchImpl } = fakeTelegram(plan);
    await expect(
      notifyUserTelegram(makeDeps(store), 'user-1', 'Утренняя', 'текст', {
        fetchImpl,
      }),
    ).resolves.toBe(false);
    expect(plan.send).toHaveLength(0);
  });
});
