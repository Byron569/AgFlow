import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_GOD_NAME } from '@shared/godIdentity';
import { GOD_STYLES, GOD_STRATEGIES, type GodPersona } from '@shared/godPersona';
import { OFFICE_CAST } from '@/scene/office/cast';
import { useStore } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';

const GOD_ID = 'god';

const headStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase'
};
const labelStyle: CSSProperties = { fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)' };
const hintStyle: CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)' };
const fieldStyle: CSSProperties = {
  width: '100%', padding: '6px 8px 4px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 14, color: 'var(--cth-ink-900)', outline: 'none'
};

/** 设置 → 自主性与预算：「角色设置」小节（P1-4）。
 *  - 显示名：走既有 registry 改名通道（store.renameAgent → hive.renameAgent）；
 *  - 沟通风格 / 编排策略：写入 config.godPersona，在总控下一次生成时注入协议；
 *  - 楼层形象：godPersona.avatar（cast key；未知值在 spawn 侧回落 'lead'）；
 *  - 一键恢复默认：名称回 DEFAULT_GOD_NAME，其余字段清空。
 *  自包含，刻意不进 SettingsModal 的主体（同 OfficeThemePicker 的拆分方式）。 */
export function GodPersonaSection({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const godAgent = useStore((s) => s.agents.find((a) => a.id === GOD_ID));
  const renameAgent = useStore((s) => s.renameAgent);
  const [name, setName] = useState(godAgent?.name ?? DEFAULT_GOD_NAME);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (godAgent?.name) setName(godAgent.name);
  }, [godAgent?.name]);

  const flashSaved = () => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const applyName = async () => {
    const next = name.trim();
    if (!next || next === godAgent?.name) return;
    setBusy(true);
    setNote('');
    const res = await renameAgent(GOD_ID, next);
    if (!res.ok) setNote(res.error ?? '');
    setBusy(false);
  };

  const writePersona = async (patch: GodPersona) => {
    const next: GodPersona = { ...config.godPersona, ...patch };
    // 空值 = 默认：从持久化里剔除，保持 config 干净（与「恢复默认」同一语义）。
    (Object.keys(next) as Array<keyof GodPersona>).forEach((k) => { if (!next[k]) delete next[k]; });
    setNote('');
    await window.cth.updateConfig({ godPersona: next });
    flashSaved();
  };

  const restoreDefaults = async () => {
    setBusy(true);
    setNote('');
    if (godAgent?.name && godAgent.name !== DEFAULT_GOD_NAME) {
      const res = await renameAgent(GOD_ID, DEFAULT_GOD_NAME);
      if (!res.ok) { setNote(res.error ?? ''); setBusy(false); return; }
      setName(DEFAULT_GOD_NAME);
    }
    await window.cth.updateConfig({ godPersona: {} });
    setBusy(false);
    flashSaved();
  };

  const styleVal = config.godPersona?.style ?? '';
  const strategyVal = config.godPersona?.strategy ?? '';
  const effectiveAvatar = config.godPersona?.avatar || 'lead';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={headStyle}>{t('godPersona.title')}</div>
      <p style={{ margin: 0, fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
        {t('godPersona.desc')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>{t('godPersona.nameLabel')}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ ...fieldStyle, width: 220 }}
          />
          <PixelButton
            variant="secondary"
            size="sm"
            onClick={() => void applyName()}
            disabled={busy || !name.trim() || name.trim() === godAgent?.name}
          >
            {t('godPersona.nameApply')}
          </PixelButton>
        </div>
        <span style={hintStyle}>{t('godPersona.nameHint')}</span>
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>{t('godPersona.styleLabel')}</span>
          <select
            value={styleVal}
            onChange={(e) => void writePersona({ style: e.target.value as GodPersona['style'] || undefined })}
            style={fieldStyle}
          >
            <option value="">{t('godPersona.styleDefault')}</option>
            {GOD_STYLES.map((s) => (
              <option key={s} value={s}>{t(`godPersona.style.${s}`)}</option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>{t('godPersona.strategyLabel')}</span>
          <select
            value={strategyVal}
            onChange={(e) => void writePersona({ strategy: e.target.value as GodPersona['strategy'] || undefined })}
            style={fieldStyle}
          >
            <option value="">{t('godPersona.strategyDefault')}</option>
            {GOD_STRATEGIES.map((s) => (
              <option key={s} value={s}>{t(`godPersona.strategy.${s}`)}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>{t('godPersona.avatarLabel')}</span>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {OFFICE_CAST.map((c) => {
            const active = effectiveAvatar === c.name;
            return (
              <button
                key={c.name}
                onClick={() => void writePersona({ avatar: c.name })}
                title={c.displayName}
                style={{
                  padding: 2, border: 'none', cursor: 'pointer',
                  background: active ? 'var(--cth-paper-100)' : 'transparent',
                  boxShadow: active
                    ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                    : 'inset 0 0 0 1px var(--cth-ink-100)'
                }}
              >
                <SpritePortrait character={c.name} scale={2} />
              </button>
            );
          })}
        </div>
        <span style={hintStyle}>{t('godPersona.avatarHint')}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <PixelButton variant="secondary" size="sm" onClick={() => void restoreDefaults()} disabled={busy}>
          {t('godPersona.restore')}
        </PixelButton>
        <span style={hintStyle}>{t('godPersona.restoreHint')}</span>
      </div>

      {saved && <span style={{ fontSize: 12, color: 'var(--cth-mint)' }}>{t('godPersona.saved')}</span>}
      {note && <span style={{ fontSize: 12, color: 'var(--cth-coral)' }}>{note}</span>}
    </div>
  );
}