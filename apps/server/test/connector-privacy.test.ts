import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SKILL_CATALOG } from '@mayak/shared';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';
import { canUseConnector } from '../src/connector-access';
import { exposeTools } from '../src/turn';
import type { McpRow, UserRecord } from '../src/db';

let handle: AppHandle;
let dir: string;
let admin: UserRecord;
let staff: UserRecord;
let customer: UserRecord;
let staffCookie = '';
let adminCookie = '';
const connector = (
  name: string,
  ownerUserId: string | null = null,
): McpRow => ({
  id: name,
  name,
  ownerUserId,
  transport: 'http',
  command: '',
  args: [],
  env: {},
  url: 'https://example.com/mcp',
  headers: {},
  enabled: false,
  createdAt: '',
});

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'connector-privacy-'));
  handle = await createApp(
    loadConfig({
      dataDir: dir,
      repoRoot,
      authEnabled: true,
      jwtSecret: 'test',
    }),
  );
  const response = await handle.app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@privacy.test',
      password: 'admin-password',
    }),
  });
  adminCookie =
    response.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .find((s) => s?.startsWith('mayak_session=')) ?? '';
  const providers = (await (
    await handle.app.request('/api/providers', {
      headers: { cookie: adminCookie },
    })
  ).json()) as { id: string; models: string[] }[];
  const demo = providers[0];
  await handle.app.request('/api/admin/models/shared', {
    method: 'PUT',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      models: [{ providerId: demo?.id, model: demo?.models[0] }],
    }),
  });
  const store = handle.runtime.store;
  admin = (await store.getUserByEmail('admin@privacy.test'))!;
  staff = await store.insertUser({
    email: 'staff@privacy.test',
    name: 'Staff',
    passwordHash: admin.passwordHash,
    role: 'manager',
    status: 'active',
    dailyRequestLimit: null,
  });
  customer = await store.insertUser({
    email: 'customer@privacy.test',
    name: 'Customer',
    passwordHash: '',
    role: 'manager',
    status: 'active',
    dailyRequestLimit: null,
    client: true,
  });
  const login = await handle.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: staff.email, password: 'admin-password' }),
  });
  staffCookie =
    login.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .find((s) => s?.startsWith('mayak_session=')) ?? '';
});
afterAll(async () => {
  await handle.close();
  await rm(dir, { recursive: true, force: true });
});

const call = (
  pathname: string,
  cookie: string,
  method = 'GET',
  body?: unknown,
) =>
  handle.app.request(pathname, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('private business connectors', () => {
  it.each(['avito-main', 'avito-ekat', 'moysklad'])(
    'blocks shared %s even if it was explicitly shared before',
    (name) => {
      const row = connector(name);
      expect(canUseConnector(admin, row, [row.id])).toBe(true);
      expect(canUseConnector(staff, row, [row.id])).toBe(false);
      expect(canUseConnector(customer, row, [row.id])).toBe(false);
      expect(canUseConnector(staff, connector(name, staff.id), [])).toBe(true);
      expect(canUseConnector(customer, connector(name, staff.id), [])).toBe(
        false,
      );
    },
  );

  it('keeps unrelated shared connectors restricted to the configured team', () => {
    const browser = connector('browser');
    expect(canUseConnector(staff, browser, [browser.id])).toBe(true);
    expect(canUseConnector(staff, browser, [])).toBe(false);
    expect(canUseConnector(customer, browser, [browser.id])).toBe(false);
  });

  it('hides shared accounts in API, rejects sharing and strips their ids from a new agent', async () => {
    const store = handle.runtime.store;
    const avito = await store.upsertMcp({
      name: 'avito-main',
      transport: 'http',
      url: 'https://example.com/mcp',
      enabled: false,
    });
    const own = await store.upsertMcp(
      {
        name: 'avito-staff',
        transport: 'http',
        url: 'https://example.com/mcp',
        enabled: false,
      },
      { ownerUserId: staff.id },
    );
    await store.setSetting('manager_mcp_ids', JSON.stringify([avito.id]));
    const list = (await (await call('/api/mcp', staffCookie)).json()) as {
      id: string;
    }[];
    expect(list.map((row) => row.id)).not.toContain(avito.id);
    expect(list.map((row) => row.id)).toContain(own.id);
    expect(
      (
        await call(`/api/mcp/${avito.id}`, adminCookie, 'PATCH', {
          forManagers: true,
        })
      ).status,
    ).toBe(400);
    const created = await call('/api/agents', staffCookie, 'POST', {
      name: 'Private connectors',
      mcpServerIds: [avito.id, own.id],
    });
    expect(created.status).toBe(201);
    expect(
      ((await created.json()) as { mcpServerIds: string[] }).mcpServerIds,
    ).toEqual([own.id]);
  });

  it('blocks shared accounts at tool execution even for an old agent with their ids', async () => {
    const store = handle.runtime.store;
    const shared = (await store.listMcp()).find(
      (row) => row.name === 'avito-main',
    )!;
    const own = (await store.listMcp()).find(
      (row) => row.name === 'avito-staff',
    )!;
    const agent = await store.insertAgent({
      name: 'Legacy',
      ownerId: staff.id,
      mcpServerIds: [shared.id, own.id],
      skillNames: ['market-analyst', 'competitive-landscape'],
    });
    await store.setSetting('moysklad_token', 'not-a-real-secret');
    const spy = vi.spyOn(handle.runtime.mcp, 'listConnected').mockReturnValue(
      [shared, own].map((row) => ({
        id: row.id,
        name: row.name,
        tools: [
          {
            name: 'lookup',
            description: 'test',
            inputSchema: { type: 'object' },
          },
        ],
      })) as never,
    );
    try {
      const tools = await exposeTools(
        handle.runtime,
        agent,
        staff.id,
        0,
        'unused',
      );
      const names = tools.map((tool) => tool.definition.name);
      expect(names).not.toContain('stock_lookup');
      expect(names.some((name) => name.includes('avito-main'))).toBe(false);
      expect(names.some((name) => name.includes('avito-staff'))).toBe(true);
      const loader = tools.find(
        (tool) => tool.definition.name === 'load_skill',
      )!;
      expect(await loader.run({ name: 'market-analyst' })).toContain(
        'не включён',
      );
      expect(await loader.run({ name: 'competitive-landscape' })).toContain(
        'Конкурентная среда',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('does not replay an old approval for a shared business account', async () => {
    const store = handle.runtime.store;
    const agent = (await store.listAgents()).find(
      (row) => row.name === 'Legacy',
    );
    if (!agent) throw new Error('missing legacy fixture');
    const response = await call('/api/conversations', staffCookie, 'POST', {
      agentId: agent.id,
    });
    expect(response.status).toBe(201);
    const conversation = (await response.json()) as { id: string };
    const approvalId = await store.createApproval({
      userId: staff.id,
      conversationId: conversation.id,
      toolName: 'mcp__avito-main__lookup',
      arguments: '{}',
    });
    const spy = vi.spyOn(handle.runtime.mcp, 'callTool');
    try {
      const approval = await call(
        `/api/approvals/${approvalId}`,
        staffCookie,
        'POST',
        { approve: true },
      );
      expect(approval.status).toBe(200);
      expect(((await approval.json()) as { result: string }).result).toContain(
        'Нет доступа',
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('ships ready public skills without exposing company skills or the storage path', async () => {
    const response = await call('/api/skills', staffCookie);
    const catalog = (await response.json()) as {
      directory: string;
      skills: { name: string }[];
    };
    expect(catalog.directory).toBe('');
    for (const item of SKILL_CATALOG)
      expect(catalog.skills.some((skill) => skill.name === item.id)).toBe(true);
    expect(
      catalog.skills.some((skill) => skill.name === 'market-analyst'),
    ).toBe(false);
    expect((await call('/api/skills/market-analyst', staffCookie)).status).toBe(
      404,
    );
    expect((await call('/api/skills/avito-api', staffCookie)).status).toBe(200);
    expect(
      (
        await call('/api/skills/competitive-landscape', staffCookie, 'PUT', {
          body: 'hack',
        })
      ).status,
    ).toBe(403);
  });
});
