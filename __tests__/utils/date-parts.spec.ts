import { dateParts } from '../../src/utils/date-parts'

describe('dateParts', () => {
  it('zero-pads month/day/hours/minutes/seconds to 2 digits and leaves year unpadded', () => {
    // Local-time constructor + local getters round-trip regardless of TZ.
    expect(dateParts(new Date(2026, 2, 5, 9, 8, 7))).toEqual({
      year: '2026',
      month: '03', // getMonth() is 0-based → +1
      day: '05',
      hours: '09',
      minutes: '08',
      seconds: '07',
    })
  })

  it('does not pad already-2-digit components', () => {
    expect(dateParts(new Date(2026, 11, 25, 23, 59, 59))).toEqual({
      year: '2026',
      month: '12',
      day: '25',
      hours: '23',
      minutes: '59',
      seconds: '59',
    })
  })

  it('composes the logger timestamp format (YYYY-MM-DD HH:mm:ss)', () => {
    const { year, month, day, hours, minutes, seconds } = dateParts(
      new Date(2026, 0, 2, 3, 4, 5),
    )
    expect(`${year}-${month}-${day} ${hours}:${minutes}:${seconds}`).toBe(
      '2026-01-02 03:04:05',
    )
  })

  it('composes the session-id format (YYYYMMDDHHmmss)', () => {
    const { year, month, day, hours, minutes, seconds } = dateParts(
      new Date(2026, 0, 2, 3, 4, 5),
    )
    expect(year + month + day + hours + minutes + seconds).toBe('20260102030405')
  })
})
