import { extname } from 'path'

/**
 * 拡張子(ドットなし)から MIME タイプへのマッピング。
 * IANA 標準 (https://www.iana.org/assignments/media-types/) に従う。
 * IANA 未登録の言語は `text/x-*` (Apache/IANA 慣例) を使用。
 */
const CONTENT_TYPE_MAP: Record<string, string> = {
  // テキスト系
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  css: 'text/css',
  scss: 'text/css',
  less: 'text/css',
  log: 'text/plain',
  env: 'text/plain',
  conf: 'text/plain',
  cfg: 'text/plain',
  ini: 'text/plain',

  // アプリケーション系
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  js: 'application/javascript',
  jsx: 'application/javascript',
  ts: 'application/typescript',
  tsx: 'application/typescript',
  sql: 'application/sql',
  graphql: 'application/graphql',
  sh: 'application/x-sh',
  bash: 'application/x-sh',
  zsh: 'application/x-sh',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',

  // 言語ソースコード (IANA 未登録)
  py: 'text/x-python',
  rb: 'text/x-ruby',
  java: 'text/x-java',
  go: 'text/x-go',
  rs: 'text/x-rust',
  c: 'text/x-c',
  cpp: 'text/x-c++',
  h: 'text/x-c',
  hpp: 'text/x-c++',

  // 画像
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',

  // Office / バイナリ
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/**
 * ファイルパス(またはファイル名)から MIME タイプを推定する。
 * 未知の拡張子は `application/octet-stream` を返す。
 */
export function guessContentType(filenameOrExt: string): string {
  // ドット付き → extname で拡張子を取得、ドットなし → そのまま拡張子として扱う
  const ext = filenameOrExt.includes('.')
    ? extname(filenameOrExt).replace(/^\./, '').toLowerCase()
    : filenameOrExt.toLowerCase()
  return CONTENT_TYPE_MAP[ext] ?? 'application/octet-stream'
}

/**
 * テキストファイルとして読み取り可能な拡張子かどうかを判定する。
 * MIME タイプだけでは判定しきれないケース(.prisma, .tf 等)を補完するために使用。
 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'tsv',
  'json', 'xml', 'yaml', 'yml',
  'js', 'ts', 'jsx', 'tsx',
  'py', 'rb', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
  'sh', 'bash', 'zsh',
  'html', 'css', 'scss', 'less',
  'sql', 'graphql',
  'env', 'cfg', 'ini', 'toml', 'conf', 'log',
  'prisma', 'proto', 'tf', 'hcl',
])

export function isTextExtension(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext.toLowerCase())
}

/** MIME タイプがテキストとして読み取り可能か判定する */
const TEXT_MIME_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/yaml',
  'application/x-sh',
  'application/sql',
  'application/toml',
  'application/graphql',
]

export function isTextMime(contentType: string): boolean {
  return TEXT_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix))
}

/** MIME タイプが画像か判定する */
export function isImageMime(contentType: string): boolean {
  return contentType.startsWith('image/')
}
