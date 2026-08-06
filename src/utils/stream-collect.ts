/**
 * Readable ストリームの全チャンクを収集し、Buffer に連結して返す。
 *
 * `const chunks: Buffer[] = []; x.on('data', c => chunks.push(c));
 *  x.on('end', () => ...Buffer.concat(chunks)); x.on('error', reject)`
 * の定型ボイラープレートを集約する。呼び出し元は解決後に
 * `.toString()` / `.toString('base64')` 等の後処理を行う。
 */
export function streamToBuffer(
  readable: NodeJS.ReadableStream,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    readable.on('data', (chunk: Buffer) => chunks.push(chunk))
    readable.on('end', () => resolve(Buffer.concat(chunks)))
    readable.on('error', reject)
  })
}
