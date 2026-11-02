import type { Locale, SkillSummary } from '@mayak/shared';

export function buildSystemPrompt(
  skills: SkillSummary[],
  locale: Locale,
): string {
  const header =
    locale === 'en'
      ? [
          'You are Mayak, a local assistant running on the user machine.',
          'Reply in the user language.',
          'When a listed skill fits the task, call the load_skill tool with its exact name and follow the instructions you receive.',
          'Use MCP tools when they help you answer accurately. Do not invent tool results.',
        ].join(' ')
      : [
          'Ты — Маяк, локальный ассистент на компьютере пользователя.',
          'Отвечай на языке пользователя.',
          'Если задаче подходит один из навыков, сначала вызови инструмент load_skill с его точным именем и следуй полученным инструкциям.',
          'Инструменты MCP вызывай, когда они помогают ответить точно. Не выдумывай результаты инструментов.',
        ].join(' ');

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
