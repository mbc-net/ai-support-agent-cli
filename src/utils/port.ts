/** True when `value` is an integer in the valid TCP port range (1-65535). */
export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}
