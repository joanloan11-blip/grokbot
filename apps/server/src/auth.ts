import {
  scrypt,
  randomBytes,
  timingSafeEqual,
  createHmac,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { PublicUser } from '@mayak/shared';
import type { Store, UserRecord } from './db';
import { HttpError } from './errors';

const scryptAsync = promisify(scrypt);
const COOKIE = 'mayak_session';

export interface AuthConfig {
  enabled: boolean;
  jwtSecret: string;
  secureCookie: boolean;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 32)) as Buffer;
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [kind, salt, hex] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hex) return false;
  const hash = (await scryptAsync(password, salt, 32)) as Buffer;
  const expected = Buffer.from(hex, 'hex');
  if (hash.length !== expected.length) return false;
  return timingSafeEqual(hash, expected);
}

export function signSession(
  userId: string,
  secret: string,
  ttlSeconds = 60 * 60 * 24 * 14,
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(
    JSON.stringify({
      sub: userId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  );
  const data = `${header}.${body}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function readSession(token: string, secret: string): string | undefined {
  return readSessionPayload(token, secret)?.sub;
}

export function readSessionPayload(
  token: string,
  secret: string,
): { sub: string; iat?: number } | undefined {
  const [header, body, sig] = token.split('.');
  if (!header || !body || !sig) return undefined;
  const data = `${header}.${body}`;
  const expected = createHmac('sha256', secret)
    .update(data)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as {
      sub?: string;
      iat?: number;
      exp?: number;
    };
    if (
      !payload.sub ||
      !payload.exp ||
      payload.exp < Math.floor(Date.now() / 1000)
    )
      return undefined;
    return { sub: payload.sub, iat: payload.iat };
  } catch {
    return undefined;
  }
}

export function toPublicUser(
  user: UserRecord,
  agentIds: string[],
  models: { providerId: string; model: string }[] = [],
): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    dailyRequestLimit: user.dailyRequestLimit,
    agentIds,
    modelsRestricted: user.modelsRestricted,
    models,
    createdAt: user.createdAt,
  };
}

export function setSessionCookie(
  c: Context,
  token: string,
  secure: boolean,
): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure,
    maxAge: 60 * 60 * 24 * 14,
  });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, COOKIE, { path: '/', secure, sameSite: 'Lax' });
}

export async function userFromRequest(
  c: Context,
  store: Store,
  auth: AuthConfig,
  localUserId: string,
): Promise<UserRecord> {
  if (!auth.enabled) {
    const user = await store.getUser(localUserId);
    if (!user) throw new HttpError(500, 'Локальный пользователь не создан');
    return user;
  }
  const token = getCookie(c, COOKIE);
  if (!token) throw new HttpError(401, 'Нужно войти');
  const session = readSessionPayload(token, auth.jwtSecret);
  if (!session) throw new HttpError(401, 'Сессия истекла');
  const user = await store.getUser(session.sub);
  // После смены пароля старые сессии (на других устройствах) не действуют.
  if (user?.passwordChangedAt) {
    const changed = Math.floor(Date.parse(user.passwordChangedAt) / 1000);
    if (!session.iat || session.iat < changed)
      throw new HttpError(401, 'Пароль изменён — войдите заново');
  }
  if (user?.status !== 'active')
    throw new HttpError(403, 'Учётная запись недоступна');
  return user;
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newInviteToken(): string {
  return randomBytes(24).toString('hex');
}

export const LOCAL_USER_ID = 'local';

const PUBLIC_API = new Set([
  '/api/health',
  '/api/auth/config',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/accept',
  '/api/auth/logout',
  '/api/auth/forgot',
  '/api/auth/reset',
]);

export function isPublicApi(pathname: string): boolean {
  return (
    PUBLIC_API.has(pathname) ||
    pathname.startsWith('/api/hooks/') ||
    pathname.startsWith('/api/public/')
  );
}

/** Managers may read the shared catalog. Writes stay with the admin. */
export function isSharedCatalogWrite(
  method: string,
  pathname: string,
): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')
    return false;
  if (
    pathname.startsWith('/api/providers') ||
    pathname.startsWith('/api/mcp') ||
    pathname.startsWith('/api/skills')
  ) {
    return true;
  }
  // Агентов менеджеры создают сами (личные); права проверяют маршруты /api/agents.
  return false;
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
