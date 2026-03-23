export interface ServiceOptions {
  verbose?: boolean
}

export interface ServiceStrategy {
  install(options: ServiceOptions): void
  uninstall(): void
}

export interface ServiceConfig {
  nodePath: string
  entryPoint: string
  logDir: string
  verbose?: boolean
}
