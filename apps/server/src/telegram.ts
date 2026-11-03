import type { TurnDeps } from './turn';
import { runTurn } from './turn';
import { decryptSecret } from './github/secret';

export function startTelegram(deps: TurnDeps): () => void {
  let stopped = false;
  let offset = 0;

  const tick = async () => {
    if (stopped) return;
    try {
      const token = await botToken(deps);
      if (!token) {
        schedule(tick, 20_000, () => stopped);
        return;
      }
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=${offset}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      if (!response.ok) {
        schedule(tick, 20_000, () => stopped);
        return;
      }
      const body = (await response.json()) as {
        result?: { update_id: number; message?: TelegramMessage }[];
      };
      for (const update of body.result ?? []) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(deps, token, update.message);
      }
    } catch {
      // не логируем URL: в нём токен бота
    }
    schedule(tick, 3_000, () => stopped);
  };
  schedule(tick, 2_000, () => stopped);
  return () => {
    stopped = true;
  };
}

export async function notifyTelegram(
  deps: TurnDeps,
  userId: string,
  name: string,
  text: string,
): Promise<void> {
  const token = await botToken(deps);
  if (!token) return;
  const chats = await deps.store.telegramChats(userId);
  for (const chatId of chats) {
    await sendTelegram(
      token,
      chatId,
      `Рутина «${name}»:\n${text.slice(0, 3_000)}`,
    );
  }
}

async function botToken(deps: TurnDeps): Promise<string | undefined> {
  const stored = await deps.store.getSetting('telegram_token');
  if (!stored || !deps.jwtSecret) return undefined;
  try {
    return decryptSecret(stored, deps.jwtSecret);
  } catch {
    return undefined;
  }
}

interface TelegramMessage {
  text?: string;
  chat: { id: number };
}

async function handleMessage(
  deps: TurnDeps,
  token: string,
  message: TelegramMessage,
): Promise<void> {
  const chatId = String(message.chat.id);
  const text = (message.text ?? '').trim();
  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1] ?? '';
    const userId = code
      ? await deps.store.getSetting(`tg_link_${code}`)
      : undefined;
    if (!userId) {
      await sendTelegram(
        token,
        chatId,
        'Код не найден. Возьмите его в настройках Маяка.',
      );
      return;
    }
    const agents = await deps.store.listAgents();
    await deps.store.linkTelegram(chatId, userId, agents[0]?.id ?? null);
    await deps.store.setSetting(`tg_link_${code}`, '');
    await sendTelegram(token, chatId, 'Чат привязан. Пишите сообщение агенту.');
    return;
  }
  const link = await deps.store.telegramLink(chatId);
  if (!link) {
    await sendTelegram(
      token,
      chatId,
      'Сначала /start и код из настроек Маяка.',
    );
    return;
  }
  const agents = await deps.store.listAgents();
  const agent = agents.find((item) => item.id === link.agentId) ?? agents[0];
  if (!agent || !text) return;
  let conversation = await deps.store.findConversationByTitle(
    link.userId,
    agent.id,
    'Telegram',
  );
  if (!conversation) {
    conversation = await deps.store.insertConversation({
      title: 'Telegram',
      agentId: agent.id,
      userId: link.userId,
      providerId: agent.providerId,
      model: agent.model,
    });
  }
  const result = await runTurn(deps, {
    conversationId: conversation.id,
    content: text,
    locale: 'ru',
    userId: link.userId,
    depth: 0,
  });
  await sendTelegram(
    token,
    chatId,
    result.text.slice(0, 3_500) || 'Пустой ответ.',
  );
}

async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => undefined);
}

function schedule(
  fn: () => Promise<void>,
  ms: number,
  stopped: () => boolean,
): void {
  const timer = setTimeout(() => {
    if (!stopped()) void fn();
  }, ms);
  timer.unref?.();
}
