import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { CONFIG_DIR, CONFIG_FILE } from './constants'

type TranslationMap = Record<string, string>

let translations: TranslationMap = {}
let fallback: TranslationMap = {}

function detectLocale(): string {
  // 1. CLI --lang flag (pre-parse process.argv)
  const langIdx = process.argv.indexOf('--lang')
  if (langIdx !== -1 && process.argv[langIdx + 1]) {
    return process.argv[langIdx + 1]
  }

  // 2. config.json language setting
  try {
    const configDir = path.join(os.homedir(), CONFIG_DIR)
    const configPath = path.join(configDir, CONFIG_FILE)
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      if (data.language) {
        return data.language
      }
    }
  } catch {
    // ignore config read errors
  }

  // 3. Environment variables
  const envLang =
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG
  if (envLang) {
    return envLang.split('.')[0].split('_')[0]
  }

  // 4. Intl
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale
    if (locale) {
      return locale.split('-')[0]
    }
  } catch {
    // ignore
  }

  // 5. Fallback
  return 'en'
}

function loadLocale(lang: string): TranslationMap {
  if (!/^[a-z]{2}$/.test(lang)) {
    return {}
  }
  const localesDir = path.join(__dirname, 'locales')
  const filePath = path.join(localesDir, `${lang}.json`)
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TranslationMap
    }
  } catch {
    // ignore load errors
  }
  return {}
}

export function initI18n(explicitLang?: string): void {
  const lang = explicitLang || detectLocale()
  fallback = loadLocale('en')
  translations = lang === 'en' ? fallback : { ...fallback, ...loadLocale(lang) }
}

export function t(key: string, params?: Record<string, string | number>): string {
  const template = translations[key] ?? fallback[key] ?? key
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    params[name] !== undefined ? String(params[name]) : `{{${name}}}`,
  )
}
