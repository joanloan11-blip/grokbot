import type { PreviewServeInfo } from '@mayak/shared';

/**
 * Живые dev-серверы для превью: приложение просит runner запустить
 * долгоживущий процесс (npm run dev и т. п.), а затем проксирует HTTP
 * из `/api/preview/live/<id>/...` в контейнер runner на его порт.
 *
 * Процессы живут в песочнице runner: свой uid, без прямого интернета,
 * автоматически останавливаются через 2 часа. Приложение хранит метаданные
 * в таблице preview_serves, чтобы переживать перезапуск.
 */
function runnerUrl(): string {
  const base = process.env.RUNNER_URL?.replace(/\/$/, '');
  if (!base) throw new Error('Песочница не настроена (RUNNER_URL)');
  return base;
}

export function previewRunnerHost(): string {
  return new URL(runnerUrl()).hostname;
}

async function runnerCall(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${runnerUrl()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-runner-token': process.env.RUNNER_TOKEN ?? '',
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : `Песочница: ${response.status}`,
    );
  }
  return data;
}

export async function startPreviewServe(input: {
  id: string;
  userId: string;
  scope: string;
  command: string;
  port: number;
}): Promise<PreviewServeInfo> {
  const data = (await runnerCall('/serve', {
    method: 'POST',
    body: JSON.stringify({
      user: input.userId,
      scope: input.scope,
      command: input.command,
      port: input.port,
      id: input.id,
    }),
  })) as {
    id: string;
    scope: string;
    command: string;
    port: number;
    status: PreviewServeInfo['status'];
    error?: string;
    startedAt: string;
  };
  return {
    id: data.id,
    scope: data.scope,
    command: data.command,
    port: data.port,
    status: data.status,
    error: data.error,
    createdAt: data.startedAt,
  };
}

export async function stopPreviewServe(id: string): Promise<void> {
  await runnerCall(`/serve/${id}/stop`, { method: 'POST' });
}

export async function listRunnerServes(): Promise<
  {
    id: string;
    port: number;
    status: string;
    error?: string;
    logs?: string;
  }[]
> {
  const data = (await runnerCall('/serve')) as {
    serves?: {
      id: string;
      port: number;
      status: string;
      error?: string;
      logs?: string;
    }[];
  };
  return data.serves ?? [];
}

export async function getRunnerServe(id: string): Promise<
  | {
      id: string;
      port: number;
      status: string;
      error?: string;
      logs?: string;
    }
  | undefined
> {
  try {
    const data = (await runnerCall(`/serve/${id}`)) as {
      serve?: {
        id: string;
        port: number;
        status: string;
        error?: string;
        logs?: string;
      };
    };
    return data.serve;
  } catch {
    return undefined;
  }
}

/** Проксирует HTTP-запрос из браузера в dev-сервер внутри runner. */
export async function proxyPreview(input: {
  port: number;
  path: string;
  search: string;
  method: string;
  headers: Headers;
  body?: ArrayBuffer;
  livePrefix: string;
}): Promise<Response> {
  const target = `http://${previewRunnerHost()}:${input.port}${input.path}${input.search}`;
  const headers = new Headers();
  for (const name of [
    'accept',
    'accept-language',
    'content-type',
    'range',
    'if-none-match',
    'if-modified-since',
    'user-agent',
  ]) {
    const value = input.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('x-forwarded-prefix', input.livePrefix);
  const response = await fetch(target, {
    method: input.method,
    headers,
    body: input.body,
    redirect: 'manual',
  });
  const outgoing = new Headers();
  for (const name of [
    'content-type',
    'cache-control',
    'etag',
    'last-modified',
    'accept-ranges',
    'content-range',
  ]) {
    const value = response.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  // Редиректы dev-сервера уводим обратно под префикс превью.
  const location = response.headers.get('location');
  if (location) {
    outgoing.set(
      'location',
      location.startsWith('/') && !location.startsWith(input.livePrefix)
        ? `${input.livePrefix}${location}`
        : location,
    );
  }
  outgoing.set('cache-control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    headers: outgoing,
  });
}
