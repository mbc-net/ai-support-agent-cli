/**
 * エージェント本体の挙動を決めるオプション。
 *
 * ネイティブ実行では `RunnerOptions` としてそのまま使われ、Docker 実行では
 * `buildContainerArgs()` が **コンテナ内の CLI 引数へ転送**する。つまりこの型の
 * 項目は「コンテナの中まで届かなければならないもの」であり、
 * `DockerRunOptions` が併せ持つホスト側の項目（`rdp` / `dockerfile` /
 * `imagePull` など、コンテナの起動方法を決めるもの）とは性質が違う。
 *
 * :::danger
 * **ここに項目を足したら `buildContainerArgs()` にも転送を足すこと。**
 * 忘れても型エラーにならず、ネイティブ実行では効くのに Docker 実行でだけ
 * 黙って無視される。利用者から見ると「設定したのに効かない」形でしか現れない。
 * `agent-run-options-forwarding.spec.ts` がこの対応を検査している。
 * :::
 */
export interface AgentRunOptions {
  token?: string
  apiUrl?: string
  pollInterval?: number
  heartbeatInterval?: number
  verbose?: boolean
  autoUpdate?: boolean
  /**
   * リリースチャンネル。ネイティブ側は `ReleaseChannel` に絞るが、Docker 側は
   * CLI から素の文字列を受けるため広いまま扱い、`validateUpdateChannel()` で
   * 正規化する。
   */
  updateChannel?: string
  /**
   * 単一プロジェクトへの絞り込み。形式は "tenantCode/projectCode"。
   */
  project?: string
}
