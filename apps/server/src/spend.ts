import type { SpendLine, SpendReport } from '@mayak/shared';
import { freePriceFor, readFreeCatalog } from './free-llm';
import type { Store } from './db';
import { costUsd, priceFor, priceTable } from './pricing';

type Row = Awaited<ReturnType<Store['usageBreakdown']>>[number];

const PERIOD_DAYS = { day: 1, week: 7, month: 30 } as const;

export function periodStart(period: SpendReport['period'], now = new Date()) {
  const since = new Date(now);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (PERIOD_DAYS[period] - 1));
  return since;
}

function emptyLine(): SpendLine & { exactCalls: number } {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    exactShare: 0,
    exactCalls: 0,
    unpricedCalls: 0,
  };
}

function addTo(
  line: SpendLine & { exactCalls: number },
  row: Row,
  cost: number | null,
) {
  line.calls += row.calls;
  line.inputTokens += row.inputTokens;
  line.outputTokens += row.outputTokens;
  line.cachedTokens += row.cachedTokens;
  line.exactCalls += row.exactCalls;
  if (cost === null) line.unpricedCalls += row.calls;
  // Если хоть у одной модели нет цены, сумму показываем без неё, но не обнуляем.
  line.costUsd = (line.costUsd ?? 0) + (cost ?? 0);
  line.exactShare = line.calls ? line.exactCalls / line.calls : 0;
}

function finish<T extends SpendLine & { exactCalls: number }>(
  line: T,
): Omit<T, 'exactCalls'> {
  const { exactCalls: _skip, ...rest } = line;
  return {
    ...rest,
    costUsd:
      rest.costUsd === null ||
      (rest.calls > 0 && rest.unpricedCalls === rest.calls)
        ? null
        : Math.round(rest.costUsd * 1e6) / 1e6,
  };
}

const byCost = (a: SpendLine, b: SpendLine) =>
  (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.calls - a.calls;

/**
 * Отчёт о расходах: по агентам (ботам), внутри — по пользователям и моделям;
 * по пользователям; по ключам (провайдерам) с ценой каждой модели.
 */
export async function buildSpendReport(
  store: Store,
  input: { period: SpendReport['period']; userId?: string; since?: Date },
): Promise<SpendReport> {
  const since = input.since ?? periodStart(input.period);
  const [rows, prices, agents, users, providers] = await Promise.all([
    store.usageBreakdown(since.toISOString(), input.userId),
    priceTable(store),
    store.listAgents(),
    store.listUsers(),
    store.listProviders(),
  ]);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const userById = new Map(users.map((user) => [user.id, user]));
  const providerById = new Map(providers.map((item) => [item.id, item]));

  const total = emptyLine();
  const agentMap = new Map<
    string,
    ReturnType<typeof emptyLine> & {
      users: Map<string, ReturnType<typeof emptyLine>>;
      models: Map<string, ReturnType<typeof emptyLine> & { row: Row }>;
    }
  >();
  const userMap = new Map<string, ReturnType<typeof emptyLine>>();
  const keyMap = new Map<
    string,
    ReturnType<typeof emptyLine> & {
      models: Map<string, ReturnType<typeof emptyLine> & { row: Row }>;
    }
  >();

  // Бесплатные модели из каталога awesome-free-llm-apis (и NVIDIA целиком) стоят 0.
  const catalog = await readFreeCatalog(store);
  const priceOf = (row: Row) =>
    (row.providerId &&
      freePriceFor(
        catalog,
        providerById.get(row.providerId)?.baseUrl ?? '',
        row.model,
      )) ||
    priceFor(row.model, prices);

  for (const row of rows) {
    const price = priceOf(row);
    const cost = costUsd(price, row);
    addTo(total, row, cost);

    const agentKey = row.agentId ?? '';
    const agent =
      agentMap.get(agentKey) ??
      Object.assign(emptyLine(), { users: new Map(), models: new Map() });
    agentMap.set(agentKey, agent);
    addTo(agent, row, cost);
    const agentUser = agent.users.get(row.userId) ?? emptyLine();
    agent.users.set(row.userId, agentUser);
    addTo(agentUser, row, cost);
    const modelKey = `${row.providerId}|${row.model}|${row.kind}`;
    const agentModel =
      agent.models.get(modelKey) ?? Object.assign(emptyLine(), { row });
    agent.models.set(modelKey, agentModel);
    addTo(agentModel, row, cost);

    const user = userMap.get(row.userId) ?? emptyLine();
    userMap.set(row.userId, user);
    addTo(user, row, cost);

    const providerKey = row.providerId ?? '';
    const key =
      keyMap.get(providerKey) ??
      Object.assign(emptyLine(), { models: new Map() });
    keyMap.set(providerKey, key);
    addTo(key, row, cost);
    const keyModel =
      key.models.get(modelKey) ?? Object.assign(emptyLine(), { row });
    key.models.set(modelKey, keyModel);
    addTo(keyModel, row, cost);
  }

  const userInfo = (id: string) => {
    const user = userById.get(id);
    return {
      userId: id,
      name: user?.name || user?.email || 'Удалённый пользователь',
      email: user?.email ?? '',
    };
  };
  const providerName = (id: string | null) =>
    (id && providerById.get(id)?.name) || 'Удалённый ключ';

  return {
    since: since.toISOString(),
    period: input.period,
    scope: input.userId ? 'mine' : 'all',
    total: finish(total),
    agents: [...agentMap.entries()]
      .map(([id, line]) => {
        const agent = id ? agentById.get(id) : undefined;
        const { users: lineUsers, models, ...rest } = line;
        return {
          ...finish(rest),
          agentId: id || null,
          name:
            agent?.name ??
            (id ? 'Удалённый агент' : 'Без агента (старые записи)'),
          emoji: agent?.emoji ?? (id ? '🗑' : '·'),
          users: [...lineUsers.entries()]
            .map(([userId, value]) => ({
              ...finish(value),
              ...userInfo(userId),
            }))
            .sort(byCost),
          models: [...models.values()]
            .map(({ row, ...value }) => ({
              ...finish(value),
              model: row.model,
              provider: providerName(row.providerId),
              kind: row.kind,
            }))
            .sort(byCost),
        };
      })
      .sort(byCost),
    users: [...userMap.entries()]
      .map(([id, line]) => ({ ...finish(line), ...userInfo(id) }))
      .sort(byCost),
    keys: [...keyMap.entries()]
      .map(([id, line]) => {
        const { models, ...rest } = line;
        return {
          ...finish(rest),
          providerId: id || null,
          name: providerName(id || null),
          models: [...models.values()]
            .map(({ row, ...value }) => ({
              ...finish(value),
              model: row.model,
              kind: row.kind,
              price: priceOf(row),
            }))
            .sort(byCost),
        };
      })
      .sort(byCost),
  };
}

/** Цена модели этого провайдера: бесплатная по каталогу или из таблицы цен. */
export async function priceForModel(
  store: Store,
  baseUrl: string,
  model: string,
) {
  const [catalog, prices] = await Promise.all([
    readFreeCatalog(store),
    priceTable(store),
  ]);
  return freePriceFor(catalog, baseUrl, model) || priceFor(model, prices);
}
