import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from '../src/checkpoints';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mayak-checkpoints-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('точки отката рабочей папки', () => {
  it('снимает папку и возвращает изменённые/удалённые файлы', async () => {
    const dataDir = tempDir();
    const workspace = path.join(dataDir, 'workspace');
    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'один');
    fs.writeFileSync(path.join(workspace, 'docs', 'b.txt'), 'два');
    fs.mkdirSync(path.join(workspace, 'node_modules', 'pkg'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'pkg', 'x.js'), 'x');

    const checkpoint = await createCheckpoint({
      dataDir,
      conversationId: 'chat-1',
      workspace,
      messageId: 'msg-1',
    });
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.files).toBe(2);

    fs.writeFileSync(path.join(workspace, 'a.txt'), 'изменено');
    fs.rmSync(path.join(workspace, 'docs', 'b.txt'));
    fs.writeFileSync(path.join(workspace, 'new.txt'), 'новый');

    const result = await restoreCheckpoint({
      dataDir,
      conversationId: 'chat-1',
      checkpointId: checkpoint?.id ?? '',
      workspace,
    });
    expect(result).not.toBeNull();
    expect(result?.restored).toBe(2);
    expect(result?.removed).toBe(1);
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('один');
    expect(fs.readFileSync(path.join(workspace, 'docs', 'b.txt'), 'utf8')).toBe(
      'два',
    );
    expect(fs.existsSync(path.join(workspace, 'new.txt'))).toBe(false);
    // Служебные каталоги не входят в снимок и не удаляются откатом.
    expect(
      fs.readFileSync(path.join(workspace, 'node_modules', 'pkg', 'x.js'), 'utf8'),
    ).toBe('x');
  });

  it('хранит не больше 10 точек на чат и не пересекает чаты', async () => {
    const dataDir = tempDir();
    const workspace = path.join(dataDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'x');
    for (let index = 0; index < 12; index += 1) {
      await createCheckpoint({
        dataDir,
        conversationId: 'chat-1',
        workspace,
      });
    }
    expect(listCheckpoints(dataDir, 'chat-1').length).toBeLessThanOrEqual(10);
    expect(listCheckpoints(dataDir, 'chat-2')).toEqual([]);
  });

  it('создаёт точку для пустой папки, чтобы откатить первые файлы', async () => {
    const dataDir = tempDir();
    const missing = await createCheckpoint({
      dataDir,
      conversationId: 'chat-1',
      workspace: path.join(dataDir, 'нет-папки'),
    });
    expect(missing).toBeNull();

    const empty = path.join(dataDir, 'empty');
    fs.mkdirSync(empty);
    const checkpoint = await createCheckpoint({
      dataDir,
      conversationId: 'chat-1',
      workspace: empty,
    });
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.files).toBe(0);
    fs.writeFileSync(path.join(empty, 'new.txt'), 'x');
    const result = await restoreCheckpoint({
      dataDir,
      conversationId: 'chat-1',
      checkpointId: checkpoint?.id ?? '',
      workspace: empty,
    });
    expect(result?.removed).toBe(1);
    expect(fs.existsSync(path.join(empty, 'new.txt'))).toBe(false);
  });

  it('не откатывает чужую или неизвестную точку', async () => {
    const dataDir = tempDir();
    const workspace = path.join(dataDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'x');
    const checkpoint = await createCheckpoint({
      dataDir,
      conversationId: 'chat-1',
      workspace,
    });
    expect(checkpoint).not.toBeNull();
    expect(
      await restoreCheckpoint({
        dataDir,
        conversationId: 'chat-2',
        checkpointId: checkpoint?.id ?? '',
        workspace,
      }),
    ).toBeNull();
    expect(
      await restoreCheckpoint({
        dataDir,
        conversationId: 'chat-1',
        checkpointId: '../etc',
        workspace,
      }),
    ).toBeNull();
  });
});
