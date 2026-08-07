/**
 * ローカル時刻の日付・時刻要素を文字列で返す。
 *
 * 月・日・時・分・秒は 2 桁ゼロ埋め、年はゼロ埋めなし（`String(getFullYear())`）。
 * ログのタイムスタンプ（`YYYY-MM-DD HH:mm:ss`）や docker セッション ID
 * （`YYYYMMDDHHmmss`）など、**フォーマット文字列は呼び出し側で組み立てる**
 * 用途で共通利用する（ゼロ埋めの定型処理を一箇所に集約する）。
 */
export function dateParts(date: Date): {
  year: string
  month: string
  day: string
  hours: string
  minutes: string
  seconds: string
} {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    year: String(date.getFullYear()),
    month: pad(date.getMonth() + 1),
    day: pad(date.getDate()),
    hours: pad(date.getHours()),
    minutes: pad(date.getMinutes()),
    seconds: pad(date.getSeconds()),
  }
}
