import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortableImportName, PortableScanResult, PortableStatus } from '@shared/portable';
import { PixelButton } from './PixelButton';

/** 设置 → 通用：「便携数据」小节（P2 迁移向导）。展示数据目录/来源/引擎随行
 *  目录，并从旧数据目录迁移 config / roster / templates（绝不覆盖已存在的文件，
 *  导入后需重启生效）。自包含，刻意不进 SettingsModal 的主体（同
 *  NameMigrationSection 的拆分方式）。 */
export function PortableDataSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PortableStatus | null>(null);
  const [scan, setScan] = useState<PortableScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState('');
  const [restartReady, setRestartReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.cth.portableStatus());
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runScan = async (dir: string) => {
    setBusy(true);
    setNote('');
    setResult('');
    try {
      const res = await window.cth.portableScan(dir);
      if (res.ok && res.scan) setScan(res.scan);
      else setNote(res.error ?? t('portable.scanFailed'));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickAndScan = async () => {
    setBusy(true);
    setNote('');
    try {
      const picked = await window.cth.portablePickSource();
      if (!picked.ok) setNote(picked.error ?? '');
      else if (!picked.canceled && picked.dir) await runScan(picked.dir);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!scan) return;
    setBusy(true);
    setNote('');
    setResult('');
    try {
      const res = await window.cth.portableImport(scan.sourceDir);
      if (res.error) {
        setNote(res.error);
        return;
      }
      setResult(
        t('portable.importDone', {
          copied: res.copied.join('、') || t('portable.none'),
          skipped: res.skippedExisting.join('、') || t('portable.none')
        })
      );
      if (res.errors.length > 0) {
        setNote(
          t('portable.importErrors', {
            count: res.errors.length,
            detail: res.errors.map((x) => `${x.name}: ${x.error}`).join('；')
          })
        );
      }
      if (res.copied.length > 0) setRestartReady(true);
      await refresh();
      await runScan(scan.sourceDir); // 目标状态已变，重扫让"将跳过"标记跟上
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (n: PortableImportName) => t(`portable.files.${n}`);
  const importable = scan?.items.filter((i) => !i.targetExists).length ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase'
      }}>
        {t('portable.title')}
      </div>
      <p style={{ margin: 0, fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
        {t('portable.desc')}
      </p>

      {status && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)' }}>
            {t('portable.mode', {
              mode: status.mode === 'portable' ? t('portable.modePortable') : t('portable.modeDefault')
            })}
            {status.source ? `　${t('portable.sourceLabel', { source: t(`portable.sources.${status.source}`) })}` : ''}
          </div>
          <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>
            {t('portable.dataDir', { dir: status.dataDir })}
          </div>
          <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>
            {t('portable.enginesDir', { dir: status.enginesDir, count: status.enginesCount })}
          </div>
          <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
            {t('portable.enginesHint')}
          </div>
          <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>
            {status.hiveRoot
              ? t('portable.hiveRoot', { dir: status.hiveRoot })
              : t('portable.hiveRootUnset')}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {status?.legacyDir && (
          <PixelButton
            variant="secondary" size="sm" disabled={busy}
            onClick={() => void runScan(status.legacyDir as string)}
          >
            {t('portable.scanLegacy', { dir: status.legacyDir })}
          </PixelButton>
        )}
        <PixelButton variant="secondary" size="sm" disabled={busy} onClick={() => void pickAndScan()}>
          {busy ? t('portable.scanning') : t('portable.scanOther')}
        </PixelButton>
      </div>
      {status && !status.legacyDir && (
        <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
          {t('portable.legacyNone')}
        </div>
      )}

      {scan && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)' }}>
            {t('portable.planTitle', { dir: scan.sourceDir })}
          </div>
          {scan.items.length > 0 ? (
            scan.items.map((item) => (
              <div key={item.name} style={{ fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-700)', wordBreak: 'break-all' }}>
                {t('portable.planLine', { name: nameOf(item.name), to: item.to })}
                {item.targetExists ? `　${t('portable.planSkip')}` : ''}
              </div>
            ))
          ) : (
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
              {t('portable.planNone')}
            </div>
          )}
          {scan.skipped.length > 0 && (
            <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
              {t('portable.skippedTitle')}
              {scan.skipped.map((s) => `${nameOf(s.name)}（${t(`portable.skipped.${s.reason}`)}）`).join('、')}
            </div>
          )}
          <div>
            <PixelButton
              variant="primary" size="sm" disabled={busy || importable === 0}
              onClick={() => void runImport()}
            >
              {busy ? t('portable.importing') : t('portable.import')}
            </PixelButton>
          </div>
        </div>
      )}

      {result && (
        <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-mint)' }}>{result}</div>
      )}
      {restartReady && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
            {t('portable.restartHint')}
          </div>
          <div>
            <PixelButton variant="primary" size="sm" onClick={() => void window.cth.portableRelaunch()}>
              {t('portable.restart')}
            </PixelButton>
          </div>
        </div>
      )}
      {note && (
        <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-coral)' }}>{note}</div>
      )}
    </div>
  );
}