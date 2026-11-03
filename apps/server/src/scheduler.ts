import { cronMatches } from './cron';
import { runTurn, type TurnDeps } from './turn';

const running = new Set<string>();

export async function runDueRoutines(
  deps: TurnDeps,
  now = new Date(),
): Promise<number> {
  let started = 0;
  for (const routine of deps.store.listRoutines()) {
    if (!routine.enabled || running.has(routine.id)) continue;
    if (!cronMatches(routine.cron, now)) continue;
    if (routine.lastRunAt && sameMinute(routine.lastRunAt, now)) continue;
    running.add(routine.id);
    started += 1;
    deps.store.markRoutineRan(routine.id, now.toISOString());
    void runRoutine(
      deps,
      routine.id,
      routine.agentId,
      routine.name,
      routine.prompt,
    ).finally(() => {
      running.delete(routine.id);
    });
  }
  return started;
}

export async function runRoutineNow(
  deps: TurnDeps,
  routineId: string,
): Promise<void> {
  const routine = deps.store.getRoutine(routineId);
  if (!routine) throw new Error('Расписание не найдено');
  deps.store.markRoutineRan(routine.id, new Date().toISOString());
  await runRoutine(
    deps,
    routine.id,
    routine.agentId,
    routine.name,
    routine.prompt,
  );
}

export function startScheduler(deps: TurnDeps): () => void {
  const timer = setInterval(() => {
    void runDueRoutines(deps).catch((error: unknown) => {
      console.error(
        'Расписание:',
        error instanceof Error ? error.message : error,
      );
    });
  }, 20_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function runRoutine(
  deps: TurnDeps,
  _routineId: string,
  agentId: string,
  name: string,
  prompt: string,
): Promise<void> {
  const agent = deps.store.getAgent(agentId);
  if (!agent) return;
  const title = `Расписание: ${name}`;
  let conversation = deps.store.findConversationByTitle(agent.id, title);
  if (!conversation) {
    conversation = deps.store.insertConversation({
      title,
      agentId: agent.id,
      providerId: agent.providerId,
      model: agent.model,
    });
  }
  await runTurn(deps, {
    conversationId: conversation.id,
    content: prompt,
    locale: 'ru',
    depth: 0,
  });
}

function sameMinute(iso: string, date: Date): boolean {
  const previous = new Date(iso);
  return (
    previous.getFullYear() === date.getFullYear() &&
    previous.getMonth() === date.getMonth() &&
    previous.getDate() === date.getDate() &&
    previous.getHours() === date.getHours() &&
    previous.getMinutes() === date.getMinutes()
  );
}
