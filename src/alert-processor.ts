import axios from 'axios'

import {
  ANTHROPIC_API_URL,
  ANTHROPIC_API_VERSION,
  DEFAULT_ANTHROPIC_MODEL,
} from './constants'
import { logger } from './logger'
import { getErrorMessage } from './utils'
import type { ApiClient } from './api-client'
import type { PendingAlert } from './types'

const VALID_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const
type Priority = typeof VALID_PRIORITIES[number]

/**
 * CloudWatch Alert 処理クラス
 * AppSync Push 受信時・フォールバック・定期ポーリングから呼ばれる
 */
export class AlertProcessor {
  /**
   * 処理中の alertNumber を保持する重複ガード。
   * AppSync Push とポーリングが同時に同じアラートを処理しようとしたり、
   * 連続ポーリングで二重処理されるのを防ぐ。
   */
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly client: ApiClient,
    private readonly tenantCode: string,
    private readonly projectCode: string,
  ) {}

  /**
   * 単一アラームを処理する（AppSync Push・ポーリング両方から呼ばれる）
   * null になるケース: AppSync Push で alertNumber を受信したが、
   * DynamoDB Streams → RDS 同期がまだ完了していない場合（稀なタイミング問題）
   */
  async processAlert(alertNumber: string): Promise<void> {
    // 重複ガード: 既に処理中の同一アラートは早期 return（二重 updateAlertStatus を防ぐ）
    if (this.inFlight.has(alertNumber)) {
      logger.debug(`Alert ${alertNumber} already in flight, skipping duplicate processing`)
      return
    }
    this.inFlight.add(alertNumber)
    // step① の processing マークが成功して「評価を開始した」かを追跡する。
    // step① 自体が一時的エラーで失敗した場合、アラートの中身を一切評価して
    // いないため failed に確定させず、pending のまま再試行可能に残す。
    let evaluationStarted = false
    try {
      // ① 処理中マーク（他エージェントとの競合防止）
      await this.client.updateAlertStatus(
        this.tenantCode, this.projectCode, alertNumber,
        { status: 'processing' },
      )
      evaluationStarted = true

      // ② Alert 詳細取得（alarmName・reason 等を優先度判定・Issue 作成に使う）
      const alert = await this.client.getAlert(
        this.tenantCode, this.projectCode, alertNumber,
      )
      if (!alert) {
        await this.markFailed(
          alertNumber,
          'Alert not found in RDS (possible sync delay)',
        )
        return
      }

      // ③ OK 通知（アラーム解除）の場合: 既存の未解決 Issue を resolved に更新して終了
      if (alert.state === 'OK') {
        const activeIssue = await this.client.findActiveIssueByAlarmName(
          this.tenantCode, this.projectCode, alert.alarmName,
        )
        if (activeIssue) {
          await this.client.resolveIssueFromAlert(
            this.tenantCode, this.projectCode, alertNumber, activeIssue.id,
          )
          await this.client.updateAlertStatus(
            this.tenantCode, this.projectCode, alertNumber,
            { status: 'processed', issueId: activeIssue.id },
          )
          logger.info(`Alert ${alertNumber} (OK): resolved issue ${activeIssue.id} for alarm ${alert.alarmName}`)
        } else {
          // 未解決 Issue がなければスキップ（既に解決済みか Issue が作られていなかった）
          await this.client.updateAlertStatus(
            this.tenantCode, this.projectCode, alertNumber,
            { status: 'processed' },
          )
          logger.info(`Alert ${alertNumber} (OK): no active issue found for alarm ${alert.alarmName}, skipped`)
        }
        return
      }

      // ④ 重複チェック: 同じ alarmName の未解決 Issue（open/received/in_progress）が存在するか
      // resolved / closed は重複とみなさない（再発アラームは新規 Issue を作成する）
      const activeIssue = await this.client.findActiveIssueByAlarmName(
        this.tenantCode, this.projectCode, alert.alarmName,
      )
      if (activeIssue) {
        await this.client.updateAlertStatus(
          this.tenantCode, this.projectCode, alertNumber,
          { status: 'processed', issueId: activeIssue.id },
        )
        logger.info(`Alert ${alertNumber} skipped: active issue ${activeIssue.id} already exists for alarm ${alert.alarmName}`)
        return
      }

      // ⑤ Claude で優先度判定（invalid な値・API エラーはすべて 'medium' にフォールバック）
      const rawPriority = await this.determinePriority(alert)
      const priority: Priority = (VALID_PRIORITIES as readonly string[]).includes(rawPriority)
        ? (rawPriority as Priority)
        : 'medium'

      // ⑥ Issue 作成（Alert 専用エンドポイント経由で alarmName を attributes に保存）
      const issue = await this.client.createIssueFromAlert(
        this.tenantCode, this.projectCode, alertNumber, priority,
      )

      // ⑦ 処理済みマーク
      await this.client.updateAlertStatus(
        this.tenantCode, this.projectCode, alertNumber,
        { status: 'processed', issueId: issue.id },
      )

      logger.info(`Alert ${alertNumber} processed: issue ${issue.id} created with priority ${priority}`)
    } catch (error) {
      const failureReason = getErrorMessage(error).substring(0, 500)
      if (!evaluationStarted) {
        // step①（processing マーク）自体が失敗 = アラートを一切評価していない。
        // failed に確定させると pending/processing いずれの救済フローにも乗らず
        // 永久に失われるため、failed にせず次回ポーリングでの再試行に委ねる。
        logger.warn(
          `Alert ${alertNumber}: failed to mark 'processing' (not evaluated, leaving for retry): ${failureReason}`,
        )
        return
      }
      logger.warn(`Alert ${alertNumber} failed: ${failureReason}`)
      await this.markFailed(alertNumber, failureReason)
    } finally {
      this.inFlight.delete(alertNumber)
    }
  }

  /**
   * アラートを failed に遷移させる。更新自体が失敗した場合は握りつぶさず
   * logger.error で記録する（status は processing のまま残り、スタック救済
   * フロー recoverStaleProcessingAlerts の対象になる）。
   */
  private async markFailed(alertNumber: string, failureReason: string): Promise<void> {
    try {
      await this.client.updateAlertStatus(
        this.tenantCode, this.projectCode, alertNumber,
        { status: 'failed', failureReason },
      )
    } catch (markErr) {
      logger.error(
        `Alert ${alertNumber}: failed to mark as 'failed' (will be picked up by stale recovery): ${getErrorMessage(markErr)}`,
      )
    }
  }

  /**
   * pending アラームを一括取得して処理する（フォールバック・定期ポーリング用）
   * getPendingAlerts は status=pending のみ取得する（processing は含めない）。
   * processing でスタックしたアラートの救済は recoverStaleProcessingAlerts で
   * 低頻度に別途行う（無限ループ防止のため通常ポーリングから分離）。
   */
  async checkPendingAlerts(): Promise<void> {
    try {
      const { items } = await this.client.getPendingAlerts(
        this.tenantCode,
        this.projectCode,
      )
      if (items.length > 0) {
        logger.info(`Found ${items.length} pending alerts, processing...`)
      }
      for (const alert of items) {
        await this.processAlert(alert.alertNumber)
      }
    } catch (error) {
      logger.warn(`checkPendingAlerts failed: ${getErrorMessage(error)}`)
    }
  }

  /**
   * 指定分数以上 processing のままスタックしたアラートを救済する。
   * 通常の高頻度ポーリング（checkPendingAlerts）とは分離した低頻度フローから
   * 呼ぶこと。これにより、processing で止まったアラートを毎回再処理して
   * CQRS コマンドが無限に増殖するのを防ぐ。
   *
   * @param staleProcessingMinutes この分数以上 processing のアラートを対象とする
   */
  async recoverStaleProcessingAlerts(staleProcessingMinutes: number): Promise<void> {
    try {
      const { items } = await this.client.getStaleProcessingAlerts(
        this.tenantCode,
        this.projectCode,
        staleProcessingMinutes,
      )
      if (items.length > 0) {
        logger.info(`Found ${items.length} stale processing alerts (>${staleProcessingMinutes}min), recovering...`)
      }
      for (const alert of items) {
        await this.processAlert(alert.alertNumber)
      }
    } catch (error) {
      logger.warn(`recoverStaleProcessingAlerts failed: ${getErrorMessage(error)}`)
    }
  }

  /**
   * Claude API で優先度を判定する
   * ANTHROPIC_API_URL, ANTHROPIC_API_VERSION は constants.ts に定義済み（既存定数を再利用）
   * apiKey は ANTHROPIC_API_KEY 環境変数から取得
   * 失敗した場合は 'medium' にフォールバック（課題作成を止めない）
   */
  private async determinePriority(alert: PendingAlert): Promise<string> {
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) {
        logger.warn('ANTHROPIC_API_KEY is not set, defaulting priority to medium')
        return 'medium'
      }

      const prompt = this.buildPriorityPrompt(alert)
      const response = await axios.post(
        ANTHROPIC_API_URL,
        {
          model: DEFAULT_ANTHROPIC_MODEL,
          max_tokens: 20,
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION,
            'content-type': 'application/json',
          },
          timeout: 30000,
        },
      )

      return response.data.content?.[0]?.text?.trim().toLowerCase() ?? 'medium'
    } catch (error) {
      logger.warn(`determinePriority failed: ${getErrorMessage(error)}, defaulting to medium`)
      return 'medium'
    }
  }

  private buildPriorityPrompt(alert: PendingAlert): string {
    const dimensionStr = alert.dimensions.length > 0
      ? alert.dimensions.map((d) => `${d.name}=${d.value}`).join(', ')
      : '（なし）'

    return [
      'あなたはAWSインフラ監視アラームのトリアージエンジニアです。',
      '以下のCloudWatchアラームの内容を分析し、課題の優先度を判定してください。',
      '',
      `アラーム名: ${alert.alarmName}`,
      `状態: ${alert.state}`,
      `理由: ${alert.reason}`,
      `メトリクス: ${alert.namespace ?? ''}/${alert.metricName ?? ''}`,
      `ディメンション: ${dimensionStr}`,
      '',
      '以下のいずれかのみで回答してください（他の文字は不要）:',
      'urgent / high / medium / low',
      '',
      '判断基準:',
      '- urgent: サービス停止、データ損失リスク、セキュリティ侵害',
      '- high:   重大なパフォーマンス低下、部分的なサービス障害',
      '- medium: 警告レベルの異常、近い将来の問題リスク',
      '- low:    情報レベルのアラーム',
    ].join('\n')
  }
}

/**
 * フォールバック用: チェックして alert-processor を更新する関数
 * agent-transport.ts の onReconnect から呼ばれる
 */
export async function checkPendingAlerts(
  client: ApiClient,
  tenantCode: string,
  projectCode: string,
): Promise<void> {
  const processor = new AlertProcessor(client, tenantCode, projectCode)
  await processor.checkPendingAlerts()
}
