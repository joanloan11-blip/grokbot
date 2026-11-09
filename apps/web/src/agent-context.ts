/** Контекст сохраняется вместе с промптом и остаётся доступен в редакторе агента. */
export function buildAgentPrompt(
  base: string,
  niche: string,
  tasks: string,
): string {
  const context = [
    niche.trim() ? `Ниша / сфера пользователя: ${niche.trim()}` : '',
    tasks.trim() ? `Задачи и желаемый результат:\n${tasks.trim()}` : '',
  ].filter(Boolean);
  return [
    base.trim(),
    context.length ? `Контекст пользователя:\n${context.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
