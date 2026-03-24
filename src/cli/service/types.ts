export interface ServiceOptions {
  verbose?: boolean
  docker?: boolean
}

export interface ServiceStrategy {
  install(options: ServiceOptions): void
  uninstall(): void
  restart(): void
}

export interface ServiceConfig {
  nodePath: string
  entryPoint: string
  logDir: string
  verbose?: boolean
  docker?: boolean
}
