import { CLI_FLAG_NO_DOCKER } from '../constants'

/**
 * コンテナ内で起動する ai-support-agent CLI の引数プレフィックス。
 *
 * 各呼び出し側は `[...CONTAINER_START_ARGV, ...]` のようにスプレッドして
 * **新しい可変配列**を作ること（後段で `.push`/追記するため、共有参照を
 * 直接変更しない）。
 */
export const CONTAINER_START_ARGV = [
  'ai-support-agent',
  'start',
  CLI_FLAG_NO_DOCKER,
] as const

/**
 * `docker run` に渡す `--user uid:gid` 引数を組み立てる。
 *
 * `process.getuid` が存在する環境（Linux/macOS）ではホストの uid:gid を
 * 指定し、存在しない環境（Windows）では空配列を返す。呼び出し側は
 * `...buildDockerUserArgs()` でスプレッドする。
 */
export function buildDockerUserArgs(): string[] {
  return process.getuid
    ? ['--user', `${process.getuid()}:${process.getgid!()}`]
    : []
}
