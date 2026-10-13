import Loader, { I18nJsonObject } from 'bcdice/lib/loader/loader';

import { bcdiceGameSystems, bcdiceI18n } from './bcdice-static-map';

// bcdice-js custom loader class
// 注意: テンプレートリテラルの動的importは webpack ではコンテキストモジュールとして
// 動作したが esbuild では実行時解決に失敗する。静的マップ(bcdice-static-map)経由で
// システム単位の遅延ロードを行うこと。
export default class BCDiceLoader extends Loader {
  async dynamicImportI18n(baseClassName: string, locale: string): Promise<I18nJsonObject> {
    const load = bcdiceI18n[`${baseClassName}.${locale}`];
    if (!load) throw new Error(`bcdice i18n not found: ${baseClassName}.${locale}`);
    return (await load()).default as I18nJsonObject;
  }

  async dynamicImport(className: string): Promise<void> {
    const load = bcdiceGameSystems[className];
    if (!load) throw new Error(`bcdice game system not found: ${className}`);
    await load();
  }
}
