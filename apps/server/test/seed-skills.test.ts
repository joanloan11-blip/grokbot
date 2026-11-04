import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { seedSkills } from '../src/skills';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function skill(root: string, name: string) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), `# ${name}\n`);
}

describe('seedSkills', () => {
  it('adds new examples to a filled folder but never restores deleted ones', async () => {
    const examples = await mkdtemp(path.join(tmpdir(), 'ex-'));
    const target = await mkdtemp(path.join(tmpdir(), 'sk-'));
    dirs.push(examples, target);
    skill(examples, 'summary');
    skill(target, 'summary');
    skill(target, 'mine');
    skill(examples, 'market-analyst');
    seedSkills(target, examples);
    expect(fs.existsSync(path.join(target, 'market-analyst', 'SKILL.md'))).toBe(
      true,
    );
    fs.rmSync(path.join(target, 'market-analyst'), { recursive: true });
    seedSkills(target, examples);
    expect(fs.existsSync(path.join(target, 'market-analyst'))).toBe(false);
  });

  it('seeds everything into an empty folder', async () => {
    const examples = await mkdtemp(path.join(tmpdir(), 'ex-'));
    const target = await mkdtemp(path.join(tmpdir(), 'sk-'));
    dirs.push(examples, target);
    skill(examples, 'a');
    skill(examples, 'b');
    seedSkills(target, examples);
    expect(
      fs
        .readdirSync(target)
        .filter((n) => !n.startsWith('.'))
        .sort(),
    ).toEqual(['a', 'b']);
  });
});
