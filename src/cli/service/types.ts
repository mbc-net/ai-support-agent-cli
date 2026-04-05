export interface ServiceOptions {
  verbose?: boolean
  docker?: boolean
}

export interface ServiceStatus {
  installed: boolean
  running: boolean
  pid?: number
  logDir?: string
}

export interface ServiceStrategy {
  install(options: ServiceOptions): void | Promise<void>
  uninstall(): void
  start(): void
  stop(): void
  restart(): void
  status(): ServiceStatus
}

export interface ServiceConfig {
  nodePath: string
  entryPoint: string
  logDir: string
  verbose?: boolean
  docker?: boolean
}
