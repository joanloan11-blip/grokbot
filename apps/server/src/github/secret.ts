import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const SALT = 'mayak-github-v1';

function keyFrom(secret: string): Buffer {
  return scryptSync(secret, SALT, 32);
}

/** AES-256-GCM. Формат: v1:iv:tag:data, всё в base64url. */
export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    data.toString('base64url'),
  ].join(':');
}

export function decryptSecret(stored: string, secret: string): string {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !data) {
    throw new Error('Не удалось прочитать секрет');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFrom(secret),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function redact(text: string, secret?: string): string {
  if (!secret) return text;
  return text.split(secret).join('[token]');
}
