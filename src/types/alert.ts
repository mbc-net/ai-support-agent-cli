export type CloudWatchState = 'ALARM' | 'OK' | 'INSUFFICIENT_DATA'

export interface PendingAlert {
  alertNumber: string
  alarmName: string
  state: CloudWatchState
  reason: string
  timestamp: string
  namespace: string | null
  metricName: string | null
  dimensions: Array<{ name: string; value: string }>
  status: 'pending' | 'processing' | 'processed' | 'failed'
  tenantCode: string
  projectCode: string
}
