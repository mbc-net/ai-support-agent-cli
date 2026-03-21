/**
 * PEM形式のSSH秘密鍵を正規化する
 * DBに保存時に改行が除去されている場合、64文字ごとに改行を挿入して修復する
 */
export function normalizePemKey(key: string): string {
  // 既に改行が含まれていればそのまま返す
  if (key.includes('\n')) {
    return key.endsWith('\n') ? key : key + '\n'
  }

  // ヘッダー/フッターを抽出して本体を64文字ごとに折り返す
  const headerMatch = key.match(/^(-----BEGIN [A-Z ]+-----)/)
  const footerMatch = key.match(/(-----END [A-Z ]+-----)$/)
  if (!headerMatch || !footerMatch) {
    return key
  }

  const header = headerMatch[1]
  const footer = footerMatch[1]
  const body = key.slice(header.length, key.length - footer.length)

  const lines = body.match(/.{1,64}/g) || []
  return [header, ...lines, footer, ''].join('\n')
}
