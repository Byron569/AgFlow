import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LEGACY_GOD_NAME, type LegacyNameScan } from '@shared/legacyNames';
import { PixelButton } from './PixelButton';

/** 设置 → 通用：「历史名称迁移」小节（P1-3）。扫描 → 展示计划 → 确认应用
 *  （自动备份 + 总控改名）。迁移要求没有终端在运行，主进程会在 error 里说明。
 *  自包含，刻意不进 SettingsModal 的主体（同 OfficeThemePicker 的拆分方式）。 */
export function NameMigrationSection() {
  const { t } = useTranslation();
  const [scan, setScan] = useState<LegacyNameScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState('');

  const runScan = async () => {
    setBusy(true);
    setNote('');
    setResult('');
    try {
      setScan(await window.cth.scanLegacyNames());
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runApply = async () => {
    setBusy(true);
    setNote('');
    setResult('');
    try {
      const res = await window.cth.applyLegacyNameMigration();
      if (res.ok) {
        setResult(
          (res.filesChanged ?? 0) > 0
            ? t('nameMigration.done', {
                files: res.filesChanged,
                hits: res.totalReplaced,
                dir: res.backupDir ?? ''
              })
            : t('nameMigration.clean')
        );
        setScan(await window.cth.scanLegacyNames());
      } else {
        setNote(res.error ?? '');
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = scan?.files.slice(0, 8) ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase'
      }}>
        {t('nameMigration.title')}
      </div>
      <p style={{ margin: 0, fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
        {t('nameMigration.desc')}
      </p>
      <div>
        <PixelButton variant="secondary" size="sm" onClick={() => void runScan()} disabled={busy}>
          {busy ? t('nameMigration.scanning') : t('nameMigration.scan')}
        </PixelButton>
      </div>

      {scan && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)' }}>
            {t('nameMigration.godLine', { name: scan.godName })}
          </div>
          {scan.godOnLegacyDefault && (
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
              {t('nameMigration.godRename', { from: scan.godName, to: scan.replacementTarget })}
            </div>
          )}
          {scan.totalHits > 0 ? (
            <>
              <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)' }}>
                {t('nameMigration.found', {
                  files: scan.files.length,
                  hits: scan.totalHits,
                  from: LEGACY_GOD_NAME,
                  to: scan.replacementTarget
                })}
              </div>
              <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                {shown.map((f) => `${f.rel} ×${f.hits}`).join('　')}
                {scan.files.length > shown.length ? `　…+${scan.files.length - shown.length}` : ''}
              </div>
              <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
                {t('nameMigration.backupHint')}
              </div>
              <div>
                <PixelButton variant="primary" size="sm" onClick={() => void runApply()} disabled={busy}>
                  {busy ? t('nameMigration.applying') : t('nameMigration.confirm')}
                </PixelButton>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
              {t('nameMigration.clean')}
            </div>
          )}
        </div>
      )}

      {result && (
        <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-mint)' }}>{result}</div>
      )}
      {note && (
        <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-coral)' }}>{note}</div>
      )}
    </div>
  );
}