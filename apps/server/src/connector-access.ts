import type { McpRow, UserRecord } from './db';

export function isBusinessConnector(row: Pick<McpRow, 'name'>): boolean {
  return /avito|авито|moysklad|мой[ _-]?склад/i.test(row.name);
}

/** Проверяется и при выборе агента, и при каждом запуске инструментов. */
export function canUseConnector(
  user: Pick<UserRecord, 'id' | 'role' | 'client'>,
  row: McpRow,
  sharedIds: string[],
): boolean {
  if (row.ownerUserId) return row.ownerUserId === user.id;
  if (user.role === 'admin') return true;
  if (user.client || isBusinessConnector(row)) return false;
  return sharedIds.includes(row.id);
}

export function parseSharedConnectorIds(raw: string | undefined): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}
