import type { Locale, SkillSummary } from '@mayak/shared';

export function buildSystemPrompt(
  skills: SkillSummary[],
  locale: Locale,
  options?: {
    persona?: string;
    peers?: { name: string; description: string }[];
  },
): string {
  const identity = options?.persona?.trim()
    ? options.persona.trim()
    : locale === 'en'
      ? 'You are Mayak, a local assistant running on the user machine.'
      : 'Ты — Маяк, локальный ассистент на компьютере пользователя.';
  const rules =
    locale === 'en'
      ? 'Reply in the user language. When a listed skill fits the task, call load_skill with its exact name and follow the instructions. Use memory_read and memory_write for notes that should survive across chats. Use MCP tools when they help you answer accurately. Do not invent tool results.'
      : 'Отвечай на языке пользователя. Если задаче подходит один из навыков, сначала вызови load_skill с его точным именем и следуй инструкциям. memory_read и memory_write — заметки, которые сохраняются между чатами. Инструменты MCP вызывай, когда они помогают ответить точно. Не выдумывай результаты инструментов.';
  const peers = options?.peers ?? [];
  const peerBlock =
    peers.length === 0
      ? ''
      : `\n\n${
          locale === 'en'
            ? 'Other agents you can message with send_to_agent'
            : 'Другие агенты, которым можно написать через send_to_agent'
        }:\n${peers.map((peer) => `- ${peer.name}: ${peer.description || (locale === 'en' ? 'no description' : 'без описания')}`).join('\n')}`;
  const header = `${identity}\n\n${rules}${peerBlock}`;

  if (skills.length === 0) {
    return `${header}\n\n${locale === 'en' ? 'No skills are enabled.' : 'Включённых навыков нет.'}`;
  }
  const lines = skills.map(
    (skill) =>
      `- ${skill.name}: ${skill.description || (locale === 'en' ? 'No description' : 'без описания')}`,
  );
  const title = locale === 'en' ? 'Enabled skills' : 'Включённые навыки';
  return `${header}\n\n${title}:\n${lines.join('\n')}`;
}

export const LOAD_SKILL_TOOL = {
  name: 'load_skill',
  description:
    'Load the full instructions of an enabled skill by its exact name. Call this before following a skill. Загружает полный текст включённого навыка.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill folder name, for example summary',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
} as const;
