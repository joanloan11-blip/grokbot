// Регистрирует MCP-серверы в базе Маяка. JSON приходит на stdin: { name: { url, headers } }.
// Запуск: docker exec -i mayak-app-1 node /dev/stdin … — см. deploy.sh.
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
let raw = '';
process.stdin.on('data', (c) => (raw += c)).on('end', () => {
  const input = JSON.parse(raw);
  const db = new DatabaseSync('/app/data/mayak.sqlite');
  const now = new Date().toISOString();
  for (const [name, server] of Object.entries(input.servers)) {
    db.prepare(
      `INSERT INTO mcp_servers (id, name, transport, command, args_json, env_json, url, headers_json, enabled, created_at)
       VALUES (?, ?, 'http', '', '[]', '{}', ?, ?, 1, ?)
       ON CONFLICT(name) DO UPDATE SET transport='http', url=excluded.url, headers_json=excluded.headers_json, enabled=1`,
    ).run(randomUUID(), name, server.url, JSON.stringify(server.headers), now);
  }
  // Подключаем к агентам: name агента → список MCP.
  for (const [agentName, names] of Object.entries(input.agents ?? {})) {
    const agent = db.prepare('SELECT id, mcp_ids_json FROM agents WHERE name = ?').get(agentName);
    if (!agent) { console.log('нет агента', agentName); continue; }
    const ids = new Set(JSON.parse(agent.mcp_ids_json || '[]'));
    for (const n of names) {
      const row = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(n);
      if (row) ids.add(row.id);
    }
    db.prepare('UPDATE agents SET mcp_ids_json = ? WHERE id = ?').run(JSON.stringify([...ids]), agent.id);
    console.log('агент', agentName, '←', names.join(', '));
  }
  console.log('серверы:', Object.keys(input.servers).join(', '));
});
