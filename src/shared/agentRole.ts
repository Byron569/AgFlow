/**
 * Durable agent role vs live status.
 *
 * Hive `registry.json` stores `role` (job / hire one-liner). The floor roster
 * stores the same string as `description`. Live run-state belongs on
 * `status` / `action` — never on role. Pause, idle, and Cursor "standby"
 * captions are status, not a job.
 *
 * Both the English and the Chinese captions are listed: the Chinese ones are
 * what the current build writes, the English ones are what an older roster or
 * registry may still carry on disk.
 */

const TRANSIENT_ROLE_RE = /^(on\s+)?standby$|^(idle|awaiting|paused|resumed|working|thinking|archived|starting up|reconnecting…?|running the floor|a fresh harness)$|^(空闲|等待中|已暂停|已恢复|运行中|思考中|已归档|正在启动|正在重连…?|正在打理楼层|一名新同事)$/i;

export function isDurableRole(text: string | undefined | null): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  return !TRANSIENT_ROLE_RE.test(value);
}

/**
 * Pick the job string that should survive a respawn or roster/registry sync.
 * A real hire role always beats a status-like caption. When both are durable,
 * `candidate` wins (the value the operator just set).
 */
export function preferredAgentRole(
  candidate: string | undefined | null,
  fallback: string | undefined | null,
  isGod = false
): string {
  const incoming = (candidate ?? '').trim();
  const existing = (fallback ?? '').trim();
  if (isDurableRole(incoming)) return incoming;
  if (isDurableRole(existing)) return existing;
  if (incoming) return incoming;
  if (existing) return existing;
  return isGod ? '总控（god）' : '智能体';
}

/** Role to send on spawn/restart. Omit a transient roster caption so the hive
 *  registry can keep the last real hire role. */
export function roleForHiveSpawn(agent: {
  description?: string;
  isGod?: boolean;
  isAssistant?: boolean;
}): string | undefined {
  if (agent.isGod) return preferredAgentRole(agent.description, '总控（god）', true);
  if (agent.isAssistant) {
    return preferredAgentRole(agent.description, '总控的预处理助手');
  }
  const role = agent.description?.trim();
  return role && isDurableRole(role) ? role : undefined;
}
