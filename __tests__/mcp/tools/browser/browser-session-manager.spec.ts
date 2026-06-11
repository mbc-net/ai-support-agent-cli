import {
  BrowserSessionManager,
  DEFAULT_MAX_BROWSER_SESSIONS,
  getMaxBrowserSessionsFromEnv,
} from '../../../../src/mcp/tools/browser/browser-session-manager'

jest.mock('../../../../src/mcp/tools/browser/playwright-loader', () => ({
  loadPlaywright: jest.fn(),
}))

jest.mock('../../../../src/logger')

// Capture the onClosed callback so tests can simulate self-close (idle timeout)
let capturedOnClosed: (() => void) | undefined

jest.mock('../../../../src/mcp/tools/browser/browser-session', () => {
  return {
    BrowserSession: jest.fn().mockImplementation((_idleTimeoutMs?: number, onClosed?: () => void) => {
      capturedOnClosed = onClosed
      return {
        close: jest.fn().mockImplementation(() => {
          onClosed?.()
          return Promise.resolve()
        }),
        isActive: jest.fn().mockReturnValue(true),
      }
    }),
  }
})

describe('BrowserSessionManager', () => {
  let manager: BrowserSessionManager

  beforeEach(() => {
    manager = new BrowserSessionManager()
  })

  describe('getOrCreate', () => {
    it('should create a new session', async () => {
      const session = await manager.getOrCreate('session-1')
      expect(session).toBeDefined()
      expect(manager.size).toBe(1)
    })

    it('should return existing session for the same ID', async () => {
      const session1 = await manager.getOrCreate('session-1')
      const session2 = await manager.getOrCreate('session-1')
      expect(session1).toBe(session2)
      expect(manager.size).toBe(1)
    })

    it('should create multiple sessions with different IDs', async () => {
      await manager.getOrCreate('session-1')
      await manager.getOrCreate('session-2')
      expect(manager.size).toBe(2)
    })

    it('should throw when max sessions is reached', async () => {
      const smallManager = new BrowserSessionManager(2)
      await smallManager.getOrCreate('session-1')
      await smallManager.getOrCreate('session-2')

      await expect(smallManager.getOrCreate('session-3')).rejects.toThrow(
        'Max browser sessions reached (2)',
      )
    })

    it('should use the documented default maxSessions', async () => {
      // The default should match DEFAULT_MAX_BROWSER_SESSIONS so the cap
      // surfaces to operators via that exported constant.
      for (let i = 1; i <= DEFAULT_MAX_BROWSER_SESSIONS; i++) {
        await manager.getOrCreate(`session-${i}`)
      }

      await expect(
        manager.getOrCreate(`session-${DEFAULT_MAX_BROWSER_SESSIONS + 1}`),
      ).rejects.toThrow(
        `Max browser sessions reached (${DEFAULT_MAX_BROWSER_SESSIONS})`,
      )
    })
  })

  describe('get', () => {
    it('should return session by ID', async () => {
      const session = await manager.getOrCreate('session-1')
      expect(manager.get('session-1')).toBe(session)
    })

    it('should return undefined for missing session', () => {
      expect(manager.get('nonexistent')).toBeUndefined()
    })
  })

  describe('getByConversationId', () => {
    it('should return session linked to conversation', async () => {
      const session = await manager.getOrCreate('session-1')
      manager.linkConversation('conv-1', 'session-1')

      expect(manager.getByConversationId('conv-1')).toBe(session)
    })

    it('should return undefined for unlinked conversation', () => {
      expect(manager.getByConversationId('conv-unknown')).toBeUndefined()
    })

    it('should return undefined if session was closed', async () => {
      await manager.getOrCreate('session-1')
      manager.linkConversation('conv-1', 'session-1')
      await manager.close('session-1')

      expect(manager.getByConversationId('conv-1')).toBeUndefined()
    })
  })

  describe('getSessionIdByConversationId', () => {
    it('should return session ID for linked conversation', async () => {
      await manager.getOrCreate('session-1')
      manager.linkConversation('conv-1', 'session-1')

      expect(manager.getSessionIdByConversationId('conv-1')).toBe('session-1')
    })

    it('should return undefined for unlinked conversation', () => {
      expect(manager.getSessionIdByConversationId('conv-unknown')).toBeUndefined()
    })
  })

  describe('linkConversation', () => {
    it('should link a conversation to a session', async () => {
      await manager.getOrCreate('session-1')
      manager.linkConversation('conv-1', 'session-1')

      expect(manager.getSessionIdByConversationId('conv-1')).toBe('session-1')
    })

    it('should overwrite existing conversation link', async () => {
      await manager.getOrCreate('session-1')
      await manager.getOrCreate('session-2')
      manager.linkConversation('conv-1', 'session-1')
      manager.linkConversation('conv-1', 'session-2')

      expect(manager.getSessionIdByConversationId('conv-1')).toBe('session-2')
    })

    it('should allow multiple conversations to link to same session', async () => {
      await manager.getOrCreate('session-1')
      manager.linkConversation('conv-1', 'session-1')
      manager.linkConversation('conv-2', 'session-1')

      expect(manager.getSessionIdByConversationId('conv-1')).toBe('session-1')
      expect(manager.getSessionIdByConversationId('conv-2')).toBe('session-1')
    })
  })

  describe('close', () => {
    it('should close session and remove from map', async () => {
      const session = await manager.getOrCreate('session-1')
      await manager.close('session-1')

      expect(session.close).toHaveBeenCalled()
      expect(manager.get('session-1')).toBeUndefined()
      expect(manager.size).toBe(0)
    })

    it('should clean up conversation links pointing to closed session', async () => {
      await manager.getOrCreate('session-1')
      manager.linkConversation('conv-1', 'session-1')
      manager.linkConversation('conv-2', 'session-1')

      await manager.close('session-1')

      expect(manager.getSessionIdByConversationId('conv-1')).toBeUndefined()
      expect(manager.getSessionIdByConversationId('conv-2')).toBeUndefined()
    })

    it('should not affect other sessions or their conversation links', async () => {
      await manager.getOrCreate('session-1')
      const session2 = await manager.getOrCreate('session-2')
      manager.linkConversation('conv-1', 'session-1')
      manager.linkConversation('conv-2', 'session-2')

      await manager.close('session-1')

      expect(manager.get('session-2')).toBe(session2)
      expect(manager.getSessionIdByConversationId('conv-2')).toBe('session-2')
      expect(manager.size).toBe(1)
    })

    it('should be safe to call with nonexistent session ID', async () => {
      await expect(manager.close('nonexistent')).resolves.not.toThrow()
    })
  })

  describe('closeAll', () => {
    it('should close all sessions', async () => {
      const session1 = await manager.getOrCreate('session-1')
      const session2 = await manager.getOrCreate('session-2')

      await manager.closeAll()

      expect(session1.close).toHaveBeenCalled()
      expect(session2.close).toHaveBeenCalled()
      expect(manager.size).toBe(0)
    })

    it('should clean up all conversation links', async () => {
      await manager.getOrCreate('session-1')
      await manager.getOrCreate('session-2')
      manager.linkConversation('conv-1', 'session-1')
      manager.linkConversation('conv-2', 'session-2')

      await manager.closeAll()

      expect(manager.getSessionIdByConversationId('conv-1')).toBeUndefined()
      expect(manager.getSessionIdByConversationId('conv-2')).toBeUndefined()
    })

    it('should be safe to call when no sessions exist', async () => {
      await expect(manager.closeAll()).resolves.not.toThrow()
    })
  })

  describe('listSessions', () => {
    it('should list all sessions with conversation info', async () => {
      await manager.getOrCreate('session-1')
      await manager.getOrCreate('session-2')
      manager.linkConversation('conv-1', 'session-1')

      const list = manager.listSessions()

      expect(list).toHaveLength(2)
      expect(list).toContainEqual({ sessionId: 'session-1', conversationId: 'conv-1' })
      expect(list).toContainEqual({ sessionId: 'session-2', conversationId: undefined })
    })

    it('should return empty array when no sessions exist', () => {
      expect(manager.listSessions()).toEqual([])
    })
  })

  describe('size', () => {
    it('should return 0 initially', () => {
      expect(manager.size).toBe(0)
    })

    it('should return correct count after adding sessions', async () => {
      await manager.getOrCreate('session-1')
      expect(manager.size).toBe(1)

      await manager.getOrCreate('session-2')
      expect(manager.size).toBe(2)
    })

    it('should decrease after closing a session', async () => {
      await manager.getOrCreate('session-1')
      await manager.getOrCreate('session-2')
      await manager.close('session-1')

      expect(manager.size).toBe(1)
    })
  })

  describe('session leak regression', () => {
    it('should decrease size when session self-closes via onClosed callback', async () => {
      await manager.getOrCreate('session-1')
      expect(manager.size).toBe(1)

      // Simulate idle timeout: session calls onClosed on its own
      expect(capturedOnClosed).toBeDefined()
      capturedOnClosed!()

      expect(manager.size).toBe(0)
    })

    it('should allow new session after self-close frees up the slot', async () => {
      const smallManager = new BrowserSessionManager(2)
      await smallManager.getOrCreate('session-1')
      await smallManager.getOrCreate('session-2')

      // Both slots full — new session must fail
      await expect(smallManager.getOrCreate('session-3')).rejects.toThrow(
        'Max browser sessions reached (2)',
      )

      // Simulate session-1 self-closing via idle timeout
      capturedOnClosed!()

      // Now one slot is free — new session must succeed
      await expect(smallManager.getOrCreate('session-3')).resolves.toBeDefined()
    })

    it('should clean up conversation links when session self-closes', async () => {
      await manager.getOrCreate('session-1')
      manager.linkConversation('conv-1', 'session-1')

      capturedOnClosed!()

      expect(manager.getByConversationId('conv-1')).toBeUndefined()
      expect(manager.getSessionIdByConversationId('conv-1')).toBeUndefined()
    })

    it('should not throw when onClosed fires after explicit manager.close()', async () => {
      await manager.getOrCreate('session-1')
      const onClosed = capturedOnClosed!

      // Explicit close first
      await manager.close('session-1')
      expect(manager.size).toBe(0)

      // onClosed fires again (e.g. idle timer already scheduled) — must be idempotent
      expect(() => onClosed()).not.toThrow()
      expect(manager.size).toBe(0)
    })
  })
})

describe('getMaxBrowserSessionsFromEnv', () => {
  it('returns the default when BROWSER_MAX_SESSIONS is unset', () => {
    expect(getMaxBrowserSessionsFromEnv({})).toBe(DEFAULT_MAX_BROWSER_SESSIONS)
  })

  it('returns the default when BROWSER_MAX_SESSIONS is empty', () => {
    expect(getMaxBrowserSessionsFromEnv({ BROWSER_MAX_SESSIONS: '' })).toBe(
      DEFAULT_MAX_BROWSER_SESSIONS,
    )
  })

  it('parses a positive integer override', () => {
    expect(getMaxBrowserSessionsFromEnv({ BROWSER_MAX_SESSIONS: '10' })).toBe(10)
  })

  it('falls back to default when the override is not a number', () => {
    expect(
      getMaxBrowserSessionsFromEnv({ BROWSER_MAX_SESSIONS: 'lots' }),
    ).toBe(DEFAULT_MAX_BROWSER_SESSIONS)
  })

  it('falls back to default when the override is zero or negative', () => {
    expect(getMaxBrowserSessionsFromEnv({ BROWSER_MAX_SESSIONS: '0' })).toBe(
      DEFAULT_MAX_BROWSER_SESSIONS,
    )
    expect(getMaxBrowserSessionsFromEnv({ BROWSER_MAX_SESSIONS: '-3' })).toBe(
      DEFAULT_MAX_BROWSER_SESSIONS,
    )
  })
})
