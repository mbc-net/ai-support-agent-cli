export interface ServiceOptions {
  verbose?: boolean
  docker?: boolean
}

export interface ProjectStatus {
  label: string
  projectCode: string
  running: boolean
  pid?: number
}

export interface ServiceStatus {
  installed: boolean
  running: boolean
  pid?: number
  logDir?: string
  projects?: ProjectStatus[]
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
