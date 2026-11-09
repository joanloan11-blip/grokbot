import { describe, expect, it } from 'vitest';
import { AGENT_TEMPLATES } from '../src/templates';
import { buildAgentPrompt } from '../../web/src/agent-context';

describe('universal agent templates', () => {
  it.each(AGENT_TEMPLATES)(
    '$id supports an unrelated niche without inherited company context',
    (template) => {
      const text = `${template.description}\n${template.systemPrompt}`;
      expect(text).not.toMatch(
        /автозапчаст|рулев|ГУР|ЭУР|МойСклад|Авито|QASTOM/i,
      );
      expect(template.skillNames ?? []).toEqual([]);
      expect(template.mcpNames ?? []).toEqual([]);
      const prompt = buildAgentPrompt(
        template.systemPrompt,
        'Фотосъёмка',
        'Готовить предложения для семейных съёмок',
      );
      expect(prompt).toContain('Фотосъёмка');
      expect(prompt).toContain('Готовить предложения для семейных съёмок');
      expect(prompt).toContain(template.systemPrompt);
    },
  );

  it('allows a general assistant, tasks only, and a custom agent', () => {
    expect(buildAgentPrompt('  Help  ', ' ', ' ')).toBe('Help');
    expect(buildAgentPrompt('Help', '', 'Write reports')).toContain(
      'Write reports',
    );
    expect(buildAgentPrompt('', 'Tourism', '')).toContain('Tourism');
  });
});
