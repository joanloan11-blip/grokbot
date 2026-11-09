import { decryptSecret, encryptSecret } from './github/secret';
import type { Store } from './db';
import type { AvitoAccount } from './avito';

/** Личный кабинет Авито хранится в настройках пользователя: avito:<userId>. */
const settingKey = (userId: string) => `avito:${userId}`;

interface StoredAvito {
  clientId: string;
  profileId: string;
  name?: string;
  secret: string;
  connectedAt?: string;
}

export interface AvitoStatus {
  connected: boolean;
  clientId?: string;
  profileId?: string;
  name?: string;
  connectedAt?: string;
}

/**
 * Читает кабинет пользователя. Возвращает undefined, если он не подключён
 * или секрет не расшифровывается (например, сменился JWT_SECRET).
 */
export async function readAvitoAccount(
  store: Store,
  jwtSecret: string | undefined,
  userId: string,
): Promise<AvitoAccount | undefined> {
  if (!jwtSecret) return undefined;
  const raw = await store.getSetting(settingKey(userId));
  if (!raw) return undefined;
  let parsed: StoredAvito;
  try {
    parsed = JSON.parse(raw) as StoredAvito;
  } catch {
    return undefined;
  }
  if (!parsed.clientId || !parsed.secret) return undefined;
  try {
    return {
      clientId: parsed.clientId,
      profileId: parsed.profileId ?? '',
      name: parsed.name,
      secret: decryptSecret(parsed.secret, jwtSecret),
    };
  } catch {
    return undefined;
  }
}

/** Состояние для интерфейса: без секрета. */
export async function avitoStatus(
  store: Store,
  jwtSecret: string | undefined,
  userId: string,
): Promise<AvitoStatus> {
  if (!jwtSecret) return { connected: false };
  const raw = await store.getSetting(settingKey(userId));
  if (!raw) return { connected: false };
  try {
    const parsed = JSON.parse(raw) as StoredAvito;
    const secret = parsed.secret
      ? decryptSecret(parsed.secret, jwtSecret)
      : '';
    return {
      connected: Boolean(secret && parsed.clientId),
      clientId: parsed.clientId,
      profileId: parsed.profileId,
      name: parsed.name,
      connectedAt: parsed.connectedAt,
    };
  } catch {
    return { connected: false };
  }
}

export async function saveAvitoAccount(
  store: Store,
  jwtSecret: string,
  userId: string,
  input: { clientId: string; clientSecret: string; profileId: string },
  name?: string,
): Promise<void> {
  const stored: StoredAvito = {
    clientId: input.clientId,
    profileId: input.profileId,
    name,
    secret: encryptSecret(input.clientSecret, jwtSecret),
    connectedAt: new Date().toISOString(),
  };
  await store.setSetting(settingKey(userId), JSON.stringify(stored));
}

export async function clearAvitoAccount(
  store: Store,
  userId: string,
): Promise<void> {
  await store.setSetting(settingKey(userId), '');
}
