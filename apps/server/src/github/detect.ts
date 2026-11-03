import fs from 'node:fs';
import path from 'node:path';
import type { GithubPreview } from '@mayak/shared';
import { parseSkillMarkdown } from '../skills';

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
]);

export interface Detection {
  kind: GithubPreview['kind'];
  summary: string;
  command: string;
  args: string[];
  skills: { name: string; description: string }[];
}

export function detectProject(root: string, nodeBinary = 'node'): Detection {
  const top = unwrap(root);
  const skills = findSkills(top);
  const node = detectNode(top, nodeBinary);
  if (node) return { ...node, skills };
  const python = detectPython(top);
  if (python) return { ...python, skills };
  const docker = detectDocker(top);
  if (docker) return { ...docker, skills };
  const config = detectReadme(top);
  if (config) return { ...config, skills };
  return {
    kind: 'unknown',
    summary:
      'Команду запуска по файлам репозитория определить не удалось. Укажите её вручную. Ничего не запускается, пока вы не подтвердите.',
    command: '',
    args: [],
    skills,
  };
}

function unwrap(root: string): string {
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name !== '.git');
  if (entries.length === 1 && entries[0]?.isDirectory()) {
    return path.join(root, entries[0].name);
  }
  return root;
}

function inside(root: string, relative: string): string | undefined {
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return resolved;
}

function detectNode(
  root: string,
  nodeBinary: string,
): Omit<Detection, 'skills'> | undefined {
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) return undefined;
  let parsed: { bin?: unknown; name?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      bin?: unknown;
      name?: unknown;
    };
  } catch {
    return undefined;
  }
  let relative = '';
  if (typeof parsed.bin === 'string') relative = parsed.bin;
  else if (parsed.bin && typeof parsed.bin === 'object') {
    const first = Object.values(parsed.bin).find(
      (item) => typeof item === 'string',
    );
    if (typeof first === 'string') relative = first;
  }
  const target = relative ? inside(root, relative) : undefined;
  if (!target || !fs.existsSync(target)) return undefined;
  const name = typeof parsed.name === 'string' ? parsed.name : 'node';
  return {
    kind: 'node',
    summary: `package.json (${name}) указывает bin ${relative}. Команда только предлагается и не запускается до подтверждения.`,
    command: nodeBinary,
    args: [target],
  };
}

function detectPython(root: string): Omit<Detection, 'skills'> | undefined {
  if (!fs.existsSync(path.join(root, 'pyproject.toml'))) return undefined;
  const candidates = ['server.py', 'main.py', path.join('src', 'server.py')];
  for (const candidate of candidates) {
    const target = inside(root, candidate);
    if (target && fs.existsSync(target)) {
      return {
        kind: 'python',
        summary: `Найден pyproject.toml и ${candidate}. Интерпретатор запустится только после подтверждения.`,
        command: 'python3',
        args: [target],
      };
    }
  }
  return {
    kind: 'python',
    summary:
      'Есть pyproject.toml, но файл сервера не найден. Укажите команду вручную.',
    command: 'python3',
    args: [],
  };
}

function detectDocker(root: string): Omit<Detection, 'skills'> | undefined {
  if (!fs.existsSync(path.join(root, 'Dockerfile'))) return undefined;
  const tag = `mayak-mcp-${
    path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '') || 'repo'
  }`;
  return {
    kind: 'docker',
    summary: `Есть Dockerfile. Образ не собирается сам. После подтверждения можно включить сервер: docker build -t ${tag} в каталоге репозитория, затем docker run -i --rm ${tag}.`,
    command: 'docker',
    args: ['run', '-i', '--rm', tag],
  };
}

function detectReadme(root: string): Omit<Detection, 'skills'> | undefined {
  const file = path.join(root, 'README.md');
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, 'utf8').slice(0, 200_000);
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fence)) {
    const body = match[1];
    if (!body?.includes('command')) continue;
    try {
      const parsed = JSON.parse(body) as unknown;
      const found = firstCommand(parsed);
      if (found) {
        return {
          kind: 'config',
          summary:
            'В README найден фрагмент конфигурации MCP. Команда взята оттуда и не запускается до подтверждения.',
          command: found.command,
          args: found.args,
        };
      }
    } catch {
      // следующий блок
    }
  }
  return undefined;
}

function firstCommand(
  value: unknown,
): { command: string; args: string[] } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstCommand(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.command === 'string') {
    const args = Array.isArray(record.args)
      ? record.args.filter((item): item is string => typeof item === 'string')
      : [];
    return { command: record.command, args };
  }
  for (const item of Object.values(record)) {
    const found = firstCommand(item);
    if (found) return found;
  }
  return undefined;
}

function findSkills(
  root: string,
  dir = root,
  depth = 0,
  found: { name: string; description: string }[] = [],
): { name: string; description: string }[] {
  if (depth > 4 || found.length >= 40) return found;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findSkills(root, full, depth + 1, found);
    if (entry.isFile() && entry.name === 'SKILL.md') {
      const name = path.basename(dir).toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) continue;
      const parsed = parseSkillMarkdown(
        fs.readFileSync(full, 'utf8').slice(0, 100_000),
      );
      if (!found.some((item) => item.name === name)) {
        found.push({ name, description: parsed.description });
      }
    }
  }
  return found;
}
