/**
 * BrowserActionLog — records browser operations for the session.
 */

export interface ActionLogEntry {
  timestamp: number
  source: 'direct' | 'chat'
  action: string
  details: string
}

export class BrowserActionLog {
  private entries: ActionLogEntry[] = []
  private readonly maxEntries: number

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries
  }

  add(source: 'direct' | 'chat', action: string, details: string): void {
    this.entries.push({
      timestamp: Date.now(),
      source,
      action,
      details,
    })
    // Remove oldest entries when exceeding max
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }
  }

  getEntries(): ActionLogEntry[] {
    return [...this.entries]
  }

  exportAsText(): string {
    if (this.entries.length === 0) return 'No actions recorded.'
    return this.entries
      .map((e) => {
        const time = new Date(e.timestamp).toISOString()
        return `[${time}] [${e.source}] ${e.action} ${e.details}`
      })
      .join('\n')
  }

  clear(): void {
    this.entries = []
  }

  get size(): number {
    return this.entries.length
  }
}
