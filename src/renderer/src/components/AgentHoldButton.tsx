import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { useStore } from '@/store/store';

/**
 * 1:1 — "I have this agent, Michael stop sending it work."
 *
 * Lives in `AgentControlStrip` beside "block tools" and "stop after this step",
 * so it is present in both sidebar and focus mode. It was briefly in the title
 * bar, which focus mode covers, making it invisible in the one mode you are
 * most likely to be in during a 1:1.
 *
 * It is a different KIND of control from the two it sits with, and the tooltip
 * carries that since the grouping no longer does: those two restrain the AGENT
 * (take its tools, or stop it after this step), while this one restrains
 * MICHAEL. The agent keeps running and keeps answering you. "Stop after this
 * step" is in fact the worst thing to reach for in a 1:1, because it stops the
 * agent you wanted to talk to.
 *
 * Never rendered for Michael himself: telling the orchestrator to stop routing
 * work to itself is not a state worth having.
 */
export function AgentHoldButton({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const godName = useStore((s) => s.agents.find((a) => a.isGod)?.name) ?? '总控';
  const [busy, setBusy] = useState(false);
  /** Last failure, shown on the button itself. A control that silently does
   *  nothing is worse than one that says why. */
  const [err, setErr] = useState<string | null>(null);

  // The registry is the record and it survives restarts, so the store's copy
  // can be stale on a fresh launch. Read it back once per agent.
  useEffect(() => {
    let alive = true;
    window.cth.hiveRegistry?.().then((reg) => {
      if (!alive) return;
      const onHold = !!(reg as { agents?: Record<string, { onHold?: boolean }> })?.agents?.[agentId]?.onHold;
      if (onHold !== !!useStore.getState().agents.find((a) => a.id === agentId)?.onHold) {
        useStore.getState().updateAgent(agentId, { onHold });
      }
    }).catch(() => { /* no hive — the button is harmless either way */ });
    return () => { alive = false; };
  }, [agentId]);

  if (!agent || agent.isGod) return null;
  const on = !!agent.onHold;

  return (
    <PixelButton
      variant={on ? 'primary' : 'secondary'}
      size="sm"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        // Promise.resolve().then(...) rather than calling straight into the
        // bridge: on a dev build whose PRELOAD predates this feature the method
        // is undefined, and the resulting TypeError is thrown SYNCHRONOUSLY out
        // of onClick, so `finally` never runs and the button stays disabled
        // until React remounts it. Which is exactly how this was reported.
        // Preload is not hot-reloaded; only a restart picks it up.
        void Promise.resolve()
          .then(() => window.cth.hiveSetAgentHold?.(agentId, !on)
            ?? Promise.reject(new Error('重启应用：该构建的 preload 还不支持一对一控制')))
          // Mirror locally only after main confirms the write. Flipping
          // optimistically would show a hold Michael never heard about.
          .then((r) => {
            if (r?.ok) { setErr(null); useStore.getState().updateAgent(agentId, { onHold: !on }); }
            else setErr(r?.error ?? '无法设置一对一');
          })
          .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
    >
      <span
        className="cth-tip cth-tip-wrap"
        data-tip={err ? err : on
          ? `结束一对一。${godName} 可以重新给 ${agent.name} 派活。`
          : `把 ${agent.name} 叫到一边。在你结束之前，${godName} 不再给他派活。与这里的另外两个按钮不同，这不会限制该智能体：他仍在运行，也仍会回应你。`}
        aria-label={on ? `结束一对一，把该智能体交还给 ${godName}` : '把该智能体叫到一边单独谈话'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        <Icon name={on ? 'pause' : 'play'} /> {err ? '一对一失败' : on ? '谈话中' : '一对一'}
      </span>
    </PixelButton>
  );
}
