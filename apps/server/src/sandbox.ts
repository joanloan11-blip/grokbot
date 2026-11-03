import { spawn } from 'node:child_process';

export function sandboxCommand(
  language: string,
  code: string,
): { cmd: string; args: string[] } | undefined {
  if (language === 'python') {
    return {
      cmd: 'docker',
      args: [
        'run',
        '--network',
        'none',
        '--memory',
        '256m',
        '--cpus',
        '0.5',
        '-i',
        '--rm',
        'python:3.12-alpine',
        'python',
        '-c',
        code,
      ],
    };
  }
  if (language === 'node') {
    return {
      cmd: 'docker',
      args: [
        'run',
        '--network',
        'none',
        '--memory',
        '256m',
        '--cpus',
        '0.5',
        '-i',
        '--rm',
        'node:22-alpine',
        'node',
        '-e',
        code,
      ],
    };
  }
  return undefined;
}

export async function runSandboxed(input: {
  enabled: boolean;
  language: string;
  code: string;
  spawnImpl?: typeof spawn;
}): Promise<string> {
  if (!input.enabled) return 'Песочница выключена. Её включает администратор.';
  if (input.code.length > 20_000) return 'Код слишком длинный.';
  const spec = sandboxCommand(input.language, input.code);
  if (!spec) return 'Язык: python или node.';
  const spawnImpl = input.spawnImpl ?? spawn;
  return await new Promise((resolve) => {
    let output = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(spec.cmd, spec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve('Не удалось запустить docker.');
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 20_000) child.kill('SIGKILL');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('Docker недоступен. Песочница не выполнила код на хосте.');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(output.trim().slice(0, 20_000) || `(код ${code ?? 0})`);
    });
  });
}
