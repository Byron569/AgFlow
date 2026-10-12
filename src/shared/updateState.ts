/**
 * Auto-update status model + presentation mapping.
 *
 * Deliberately electron-free: main (src/main/updater.ts) produces these states
 * from electron-updater events, the toolbar badge
 * (src/renderer/src/components/UpdateBadge.tsx) renders them, and the rules that
 * matter — which state wins when two arrive out of order, what the button says
 * and does — live here where they can be unit-tested without booting Electron.
 */

export type UpdateStatus =
  /** Nothing known yet (fresh window, or dev build where we never check). */
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'not-available' }
  | { state: 'available'; version: string; notes?: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string; notes?: string }
  /** This install can't self-update (win-portable, or the native path failed):
   *  notify-only, link to the release page. `reason` is the underlying error.
   *  `notes` is the release body — the notify-only poll already reads the same
   *  `releases/latest` JSON that carries it, so the toast can show "what's new"
   *  here too without a second request. */
  | { state: 'available-manual'; version: string; url: string; reason?: string; notes?: string;
      /** Direct asset for THIS platform/arch, when the release has one. The
       *  modal's primary button downloads it; without it the button falls back
       *  to the releases page. */
      downloadUrl?: string }
  /** First launch after the version moved: `version` is the one now RUNNING and
   *  `notes` its release body, so the renderer can show that release's page. */
  | { state: 'just-updated'; version: string; notes?: string }
  | { state: 'error'; message: string };

export type UpdateAction = 'none' | 'check' | 'download' | 'restart' | 'open-release' | 'manual';

export const REPO = 'agflow/agflow';

/** The installer for THIS machine in the release tagged v{version}, by the
 *  names electron-builder.yml produces. Used when a status carries no
 *  `downloadUrl` of its own (the native updater path never does). */
export function installerUrl(version: string, platform: string, arch: string): string {
  const v = version.replace(/^v/, '');
  const file = platform === 'darwin' ? `AgFlow-${v}-mac-${arch}.dmg`
    : platform === 'win32' ? `AgFlow-${v}-win-x64-setup.exe`
    : `AgFlow-${v}-linux-x86_64.AppImage`;
  return `https://github.com/${REPO}/releases/download/v${v}/${file}`;
}

/** The newer release a status knows about, or null. Every state that names a
 *  version newer than the running one counts, whatever the updater is doing
 *  with it: the manual path is always on offer. */
export function pendingVersion(status: UpdateStatus | null, current: string): string | null {
  if (!status || !('version' in status)) return null;
  if (status.state === 'just-updated') return null;
  return isNewer(status.version, current) ? status.version : null;
}

/** Where a manual download of `status`'s release goes: the asset the release
 *  itself named when it did, else the conventional installer URL. */
export function manualDownloadUrl(status: UpdateStatus, platform: string, arch: string): string | null {
  if (!('version' in status) || status.state === 'just-updated') return null;
  if (status.state === 'available-manual' && status.downloadUrl) return status.downloadUrl;
  return installerUrl(status.version, platform, arch);
}

export interface UpdateBadgeView {
  /** Extra text beside the version, or null to show the version alone. */
  label: string | null;
  /** What a click does. 'none' renders the badge non-interactive. */
  action: UpdateAction;
  tone: 'idle' | 'busy' | 'ready' | 'warn';
  /** Tooltip — the only place the underlying error is ever surfaced verbatim. */
  title: string;
  busy: boolean;
}

/** `1.2.3` / `v1.2.3` -> [1,2,3]; null for anything that isn't semver-ish. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = String(v ?? '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * Should the "what's new" release drop open on this launch?
 *
 * `previous` is the `last-run-version` stamp (null when the file does not
 * exist), `current` is the running version.
 *
 * The drop used to require a stamp to already be present, which meant it fired
 * for almost nobody: the stamp AND its reader shipped in the same release, so
 * no earlier install had the file, `previous` read null on the upgrade INTO
 * that release, and a genuinely fresh install had nothing either.
 *
 *   - same version relaunch  -> false. Seen once is seen.
 *   - never run before       -> true.  The fresh-install case that was missing.
 *   - version moved forward  -> true.  The ordinary upgrade.
 *   - version moved BACKWARD -> false. A downgrade has nothing new to announce.
 *
 * Note the forward test is "not a downgrade", not `isNewer(current, previous)`.
 * `isNewer` compares major.minor.patch only and discards `-rc.N`, so a second
 * RC of the same version (0.4.7-rc.1 -> 0.4.7-rc.2) is neither newer nor older;
 * asking "is this a downgrade?" lets that case through DELIBERATELY (a new
 * build does have new notes) while still refusing a real downgrade. Doing it
 * here rather than by teaching `isNewer` about prereleases keeps the change off
 * the badge/pending state machine, which reads `isNewer` for other decisions.
 */
export function shouldShowReleaseDrop(previous: string | null, current: string): boolean {
  if (previous === current) return false;
  if (previous === null) return true;
  return !isNewer(previous, current);
}

/** Download percentages arrive as floats and, on a resumed/differential
 *  download, occasionally out of range. Clamp so the UI can't render `-0%`
 *  or `104%`. */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** How far along the update pipeline a state is. A later stage is never
 *  replaced by an earlier one for the SAME version — see `reduceStatus`. */
function rank(s: UpdateStatus): number {
  switch (s.state) {
    case 'idle': return 0;
    case 'checking': return 1;
    case 'not-available': return 1;
    case 'error': return 1;
    case 'just-updated': return 1;
    case 'available-manual': return 2;
    case 'available': return 3;
    case 'downloading': return 4;
    case 'downloaded': return 5;
  }
}

function versionOf(s: UpdateStatus): string | null {
  return 'version' in s ? s.version : null;
}

/**
 * Fold a new status into the current one.
 *
 * The rule that matters: once an update is staged, the 6-hourly re-check (or a
 * manual "check now") must NOT wipe the "restart to update" affordance out from
 * under the user — `checking` / `not-available` / a transient `error` are all
 * lower-rank and lose. A genuinely NEWER version always wins, so a long-running
 * app that sees 0.3.7 while 0.3.6 is staged moves forward rather than sticking.
 */
export function reduceStatus(prev: UpdateStatus | null, next: UpdateStatus): UpdateStatus {
  if (!prev) return next;
  const pv = versionOf(prev);
  const nv = versionOf(next);
  if (pv && nv && isNewer(nv, pv)) return next;   // a newer release supersedes
  if (pv && nv && pv !== nv) return next;         // different (e.g. rolled back) release
  return rank(next) >= rank(prev) ? next : prev;
}

/**
 * What the toolbar badge shows and does for a given status.
 *
 * `currentVersion` is the running app's version — it is always rendered next to
 * the logo, so every one of these views is "v0.3.6" plus at most one extra chip.
 */
export function describeUpdate(status: UpdateStatus | null, currentVersion: string): UpdateBadgeView {
  const v = currentVersion;
  // The title-bar badge is the MANUAL path, always: click downloads the
  // installer and the user replaces the app. Auto-update (download, restart)
  // lives in Settings -> Updates. So any state that names a newer release reads
  // the same here, whatever the background updater is doing with it.
  if (status?.state === 'downloading') {
    // Settings started the automatic download; the chip reports progress and
    // nothing else, so the two paths are not raced against each other.
    return {
      label: `下载中 ${clampPercent(status.percent)}%`, action: 'none', tone: 'busy', busy: true,
      title: `正在下载 v${status.version}… ${clampPercent(status.percent)}%`
    };
  }
  const pending = pendingVersion(status, v);
  if (pending) {
    // When the native updater has staged the update, the badge drives the SAME
    // auto-update the Settings pane does: restart to install once it is
    // downloaded, or kick the download while it is 'available'. Manual download
    // is reserved for 'available-manual', the notify-only fallback where the
    // native updater could NOT fetch it, so the user replaces the app by hand.
    if (status?.state === 'downloaded') {
      return {
        label: `v${pending} · 重启安装`, action: 'restart', tone: 'ready', busy: false,
        title: `点击重启并安装 v${pending}`
      };
    }
    if (status?.state === 'available') {
      return {
        label: `v${pending} · 更新`, action: 'download', tone: 'ready', busy: false,
        title: `正在后台下载 v${pending}；若尚未开始，点击即可启动`
      };
    }
    const why = status?.state === 'available-manual' && status.reason
      ? `（该安装无法自动更新：${status.reason}）` : '';
    return {
      label: `v${pending} · 下载`, action: 'manual', tone: 'ready', busy: false,
      title: `点击下载 v${pending}，然后手动替换当前应用${why}`
    };
  }
  switch (status?.state) {
    case 'checking':
      return { label: '检查中…', action: 'none', tone: 'busy', busy: true, title: `正在检查更新（当前 v${v}）` };
    case 'error':
      return {
        label: '更新检查失败', action: 'check', tone: 'warn', busy: false,
        title: `${status.message}，点击重试`
      };
    case 'not-available':
    case 'just-updated':
      // A check has confirmed it, so say so. Idle (no check yet) stays bare.
      return { label: '最新', action: 'check', tone: 'idle', busy: false, title: `v${v} 已是最新版本，点击再次检查` };
    case 'idle':
    default:
      return { label: null, action: 'check', tone: 'idle', busy: false, title: `v${v}，点击检查更新` };
  }
}

export interface UpdateSettingsView {
  /** Headline: the version that matters right now — yours, or the one waiting. */
  headline: string;
  /** One sentence of explanation. Carries the verbatim error when there is one. */
  detail: string;
  /** Primary button label, or null while the updater is mid-flight and there is
   *  nothing useful to press. */
  button: string | null;
  action: UpdateAction;
  busy: boolean;
  tone: 'idle' | 'busy' | 'ready' | 'warn';
}

/**
 * What the Settings → General "Updates" block shows and does.
 *
 * Separate from `describeUpdate` on purpose. The toolbar chip has room for two
 * words and has to stay quiet when nothing is happening, so its idle state says
 * nothing at all; Settings is where someone goes *to ask*, so every state gets a
 * full sentence and — outside the two mid-flight states — a button. The states
 * and the transitions between them are shared, which is the part that has to
 * stay in sync.
 */
export function describeUpdateSettings(
  status: UpdateStatus | null,
  currentVersion: string
): UpdateSettingsView {
  const v = currentVersion;
  switch (status?.state) {
    case 'checking':
      return {
        headline: `当前 v${v}`,
        detail: '正在检查新版本…',
        button: null, action: 'none', busy: true, tone: 'busy'
      };
    case 'available':
      return {
        headline: `v${status.version} 可以更新`,
        detail: `你当前是 v${v}。现在下载——准备好后会询问你何时重启。`,
        button: `下载 v${status.version}`, action: 'download', busy: false, tone: 'ready'
      };
    case 'downloading':
      return {
        headline: `正在下载 v${status.version}`,
        detail: `已完成 ${clampPercent(status.percent)}%。你可以继续工作；重启由你决定。`,
        button: null, action: 'none', busy: true, tone: 'busy'
      };
    case 'downloaded':
      return {
        headline: `v${status.version} 已准备好安装`,
        detail: `重启 AgFlow 即可完成从 v${v} 的更新。`,
        button: '重启以更新', action: 'restart', busy: false, tone: 'ready'
      };
    case 'available-manual':
      return {
        headline: `v${status.version} 可以更新`,
        detail: status.reason
          ? `该安装无法自动更新（${status.reason}）——请从发布页面下载。`
          : `该安装无法自动更新——请从发布页面下载。`,
        button: status.downloadUrl ? `下载 v${status.version}` : '打开发布页面',
        action: 'open-release', busy: false, tone: 'warn'
      };
    case 'just-updated':
      return {
        headline: `当前 v${v}`,
        detail: '刚刚完成更新。这是最新的发布版。',
        button: '检查更新', action: 'check', busy: false, tone: 'idle'
      };
    case 'error':
      return {
        headline: '更新检查失败',
        detail: `${status.message}（你当前是 v${v}）。`,
        button: '重试', action: 'check', busy: false, tone: 'warn'
      };
    case 'not-available':
      return {
        headline: `v${v} 已是最新版本`,
        detail: '你已是最新版本——无需安装。',
        button: '再次检查', action: 'check', busy: false, tone: 'idle'
      };
    case 'idle':
    default:
      return {
        headline: `当前 v${v}`,
        detail: '应用每 6 小时自动检查一次更新。想确认的话可以立即检查。',
        button: '检查更新', action: 'check', busy: false, tone: 'idle'
      };
  }
}

/** What to do with the installer once it has downloaded, per platform. Shown
 *  on the title-bar badge's hover card and in the notice after the click. */
export function manualInstallSteps(platform: string): { os: string; steps: string[] } {
  if (platform === 'darwin') {
    return {
      os: 'macOS',
      steps: [
        '打开 .dmg，把 AgFlow 拖入「应用程序」。询问时选择「替换」。',
        '退出本应用，从「应用程序」打开新版本，并选择同一个项目。'
      ]
    };
  }
  if (platform === 'win32') {
    return {
      os: 'Windows',
      steps: [
        '退出本应用，然后运行下载的安装程序 .exe。它会替换已安装的版本。',
        '再次打开 AgFlow，并选择同一个项目。'
      ]
    };
  }
  return {
    os: 'Linux',
    steps: [
      '给下载的 .AppImage 加上可执行权限（chmod +x），并移动覆盖你现在运行的那一份。',
      '退出本应用，启动新的 AppImage，并选择同一个项目。'
    ]
  };
}
