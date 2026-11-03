import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { badRequest } from '../errors';
import { unsafeTarPath } from './parse';

const exec = promisify(execFile);

export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;

export async function readCapped(
  response: Response,
  max = MAX_ARCHIVE_BYTES,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw badRequest('Пустой ответ GitHub');
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw badRequest('Архив репозитория больше 20 МБ');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function extractTarball(
  archive: string,
  dest: string,
): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  let listed = '';
  try {
    const result = await exec('tar', ['-tzf', archive], {
      maxBuffer: 8 * 1024 * 1024,
    });
    listed = result.stdout;
  } catch {
    throw badRequest('Не удалось прочитать архив. Нужна утилита tar.');
  }
  const entries = listed.split('\n').filter(Boolean);
  if (entries.length > 5000) throw badRequest('В архиве слишком много файлов');
  if (entries.some((entry) => unsafeTarPath(entry))) {
    throw badRequest('Архив содержит небезопасные пути');
  }
  await exec('tar', ['-xzf', archive, '-C', dest]);
  const root = path.resolve(dest);
  for (const entry of entries) {
    const resolved = path.resolve(dest, entry);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw badRequest('Архив распаковался за пределы каталога');
    }
  }
}
