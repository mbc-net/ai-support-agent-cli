import { BrowserActionLog } from '../../../../src/mcp/tools/browser/browser-action-log'

describe('BrowserActionLog', () => {
  let log: BrowserActionLog

  beforeEach(() => {
    log = new BrowserActionLog()
    jest.spyOn(Date, 'now').mockReturnValue(1700000000000)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('add', () => {
    it('should add an entry with timestamp', () => {
      log.add('direct', 'click', 'Clicked at (100, 200)')

      const entries = log.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({
        timestamp: 1700000000000,
        source: 'direct',
        action: 'click',
        details: 'Clicked at (100, 200)',
      })
    })

    it('should add entries with chat source', () => {
      log.add('chat', 'navigate', 'Go to https://example.com')

      const entries = log.getEntries()
      expect(entries[0].source).toBe('chat')
    })

    it('should add multiple entries in order', () => {
      ;(Date.now as jest.Mock).mockReturnValueOnce(1700000000000)
      log.add('direct', 'click', 'First click')

      ;(Date.now as jest.Mock).mockReturnValueOnce(1700000001000)
      log.add('chat', 'type', 'Typed text')

      const entries = log.getEntries()
      expect(entries).toHaveLength(2)
      expect(entries[0].action).toBe('click')
      expect(entries[1].action).toBe('type')
    })
  })

  describe('getEntries', () => {
    it('should return empty array when no entries', () => {
      expect(log.getEntries()).toEqual([])
    })

    it('should return a copy of entries', () => {
      log.add('direct', 'click', 'Test')

      const entries1 = log.getEntries()
      const entries2 = log.getEntries()

      expect(entries1).toEqual(entries2)
      expect(entries1).not.toBe(entries2) // Different references
    })

    it('should not allow mutation of internal entries via returned copy', () => {
      log.add('direct', 'click', 'Test')

      const entries = log.getEntries()
      entries.push({
        timestamp: 0,
        source: 'chat',
        action: 'fake',
        details: 'fake',
      })

      expect(log.getEntries()).toHaveLength(1)
    })
  })

  describe('exportAsText', () => {
    it('should return "No actions recorded." when empty', () => {
      expect(log.exportAsText()).toBe('No actions recorded.')
    })

    it('should format entries as text lines', () => {
      ;(Date.now as jest.Mock).mockReturnValue(1700000000000)
      log.add('direct', 'click', 'Clicked at (100, 200)')

      const text = log.exportAsText()
      const expectedTime = new Date(1700000000000).toISOString()
      expect(text).toBe(`[${expectedTime}] [direct] click Clicked at (100, 200)`)
    })

    it('should join multiple entries with newlines', () => {
      ;(Date.now as jest.Mock)
        .mockReturnValueOnce(1700000000000)
        .mockReturnValueOnce(1700000001000)

      log.add('direct', 'click', 'First')
      log.add('chat', 'navigate', 'Second')

      const text = log.exportAsText()
      const lines = text.split('\n')
      expect(lines).toHaveLength(2)

      const time1 = new Date(1700000000000).toISOString()
      const time2 = new Date(1700000001000).toISOString()
      expect(lines[0]).toBe(`[${time1}] [direct] click First`)
      expect(lines[1]).toBe(`[${time2}] [chat] navigate Second`)
    })
  })

  describe('clear', () => {
    it('should remove all entries', () => {
      log.add('direct', 'click', 'Test 1')
      log.add('chat', 'type', 'Test 2')

      log.clear()

      expect(log.getEntries()).toEqual([])
      expect(log.size).toBe(0)
    })

    it('should be safe to call when already empty', () => {
      expect(() => log.clear()).not.toThrow()
      expect(log.size).toBe(0)
    })
  })

  describe('size', () => {
    it('should return 0 initially', () => {
      expect(log.size).toBe(0)
    })

    it('should return correct count after adding entries', () => {
      log.add('direct', 'click', 'Test')
      expect(log.size).toBe(1)

      log.add('chat', 'type', 'Test 2')
      expect(log.size).toBe(2)
    })

    it('should return 0 after clear', () => {
      log.add('direct', 'click', 'Test')
      log.clear()
      expect(log.size).toBe(0)
    })
  })
})
