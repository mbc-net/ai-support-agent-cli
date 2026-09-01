/**
 * 起動経路から使う guacd のエントリポイント。
 *
 * `index.ts` は起動を軽く保つため動的 import を使う。関連する関数を 1 つの
 * モジュールにまとめ、import 文を 1 本で済ませる。
 */
export { stopGuacdContainer } from './guacd-container'
export { buildGuacdDockerArgs, resolveGuacdForHost } from './guacd-runtime'
export type { GuacdRuntimeOptions } from './guacd-runtime'
