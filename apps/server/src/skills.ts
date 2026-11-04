import fs from 'node:fs';
import path from 'node:path';
import type { Skill, SkillSummary } from '@mayak/shared';
import { badRequest } from './errors';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertSkillName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!NAME_RE.test(normalized)) {
    throw badRequest(
      'Имя навыка: латиница, цифры, «-» и «_», до 64 символов, с буквы или цифры.',
    );
  }
  return normalized;
}

export function parseSkillMarkdown(raw: string): {
  description: string;
  enabled: boolean;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match || match[1] === undefined) {
    return { description: '', enabled: true, body: raw.trim() };
  }
  let description = '';
  let enabled = true;
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    const key = field[1];
    let value = (field[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    }
    if (key === 'description') description = value;
    if (key === 'enabled')
      enabled = value === 'true' || value === 'yes' || value === '1';
  }
  return { description, enabled, body: raw.slice(match[0].length).trim() };
}

export function serializeSkill(skill: {
  description: string;
  enabled: boolean;
  body: string;
}): string {
  return `---\ndescription: ${JSON.stringify(skill.description.replace(/\s+/g, ' ').trim())}\nenabled: ${skill.enabled ? 'true' : 'false'}\n---\n\n${skill.body.trim()}\n`;
}

export class SkillLibrary {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  get directory(): string {
    return this.dir;
  }

  list(): SkillSummary[] {
    return this.readAll().map((skill) => ({
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
    }));
  }

  listEnabled(): SkillSummary[] {
    return this.list().filter((skill) => skill.enabled);
  }

  get(name: string): Skill | undefined {
    const normalized = assertSkillName(name);
    const file = this.fileFor(normalized);
    if (!fs.existsSync(file)) return undefined;
    const parsed = parseSkillMarkdown(fs.readFileSync(file, 'utf8'));
    return { name: normalized, ...parsed };
  }

  save(input: {
    name: string;
    description: string;
    enabled: boolean;
    body: string;
  }): Skill {
    const name = assertSkillName(input.name);
    if (input.body.length > 100_000)
      throw badRequest('Текст навыка слишком большой (лимит 100 КБ).');
    const folder = path.join(this.dir, name);
    fs.mkdirSync(folder, { recursive: true });
    const skill: Skill = {
      name,
      description: input.description.replace(/\s+/g, ' ').trim(),
      enabled: input.enabled,
      body: input.body.trim(),
    };
    fs.writeFileSync(
      path.join(folder, 'SKILL.md'),
      serializeSkill(skill),
      'utf8',
    );
    return skill;
  }

  remove(name: string): boolean {
    const normalized = assertSkillName(name);
    const folder = path.join(this.dir, normalized);
    if (!fs.existsSync(folder)) return false;
    fs.rmSync(folder, { recursive: true, force: true });
    return true;
  }

  private readAll(): Skill[] {
    const names = fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && NAME_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const skills: Skill[] = [];
    for (const name of names) {
      const file = this.fileFor(name);
      if (!fs.existsSync(file)) continue;
      const parsed = parseSkillMarkdown(fs.readFileSync(file, 'utf8'));
      skills.push({ name, ...parsed });
    }
    return skills;
  }

  private fileFor(name: string): string {
    return path.join(this.dir, name, 'SKILL.md');
  }
}

/**
 * Копирует примеры навыков в каталог данных. Новые примеры (из обновлений)
 * добавляются и в уже заполненный каталог; удалённые пользователем навыки
 * не возвращаются — их имена помнит файл `.seeded`.
 */
export function seedSkills(targetDir: string, examplesDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  if (!fs.existsSync(examplesDir)) return;
  const marker = path.join(targetDir, '.seeded');
  const existing = fs
    .readdirSync(targetDir)
    .filter((name) => !name.startsWith('.'));
  let seeded: string[] = [];
  if (fs.existsSync(marker)) {
    seeded = fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean);
  } else if (existing.length > 0) {
    // Каталог заполнялся старой версией: всё, что там есть, считаем уже выданным.
    seeded = [...existing];
  }
  for (const name of fs.readdirSync(examplesDir)) {
    const source = path.join(examplesDir, name, 'SKILL.md');
    if (!fs.existsSync(source)) continue;
    if (seeded.includes(name)) continue;
    seeded.push(name);
    if (existing.includes(name)) continue;
    const destDir = path.join(targetDir, name);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(source, path.join(destDir, 'SKILL.md'));
  }
  fs.writeFileSync(marker, `${seeded.join('\n')}\n`);
}
