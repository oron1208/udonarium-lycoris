import { environment } from '../../../../../environments/environment';

/**
 * 軽量ロガー。console.* の直接呼び出しを置き換えるための単一インターフェース。
 *
 * - 本番ビルド(environment.production === true)では debug/info を no-op 化し、
 *   Terser の dead-code elimination で呼び出しをごと削除できるように定数で分岐する。
 * - warn/error は本番でも出力する(回復可能エラー/正統なエラーパス)。
 * - Angular DI 不要の namespace シングルトン。util/ の CryptoUtil/StringUtil 慣例に準拠。
 */
export namespace Logger {
  export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

  // 本番では debug/info を完全に落とす(定数分岐なので DCE で呼び出し側も消える)。
  const verbose = !environment.production;

  export function debug(...args: unknown[]): void {
    if (verbose) console.debug(prefix('debug'), ...args);
  }

  export function info(...args: unknown[]): void {
    if (verbose) console.log(prefix('info'), ...args);
  }

  export function warn(...args: unknown[]): void {
    console.warn(prefix('warn'), ...args);
  }

  export function error(...args: unknown[]): void {
    console.error(prefix('error'), ...args);
  }

  function prefix(level: LogLevel): string {
    // ISO 時刻 + レベル。コンソールでフィルタしやすいように括弧付き。
    return `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  }
}
