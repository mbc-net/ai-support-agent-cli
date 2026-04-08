import { startConfigWatcher, startTokenWatcher } from '../src/config-watcher'
import { loadConfig, getProjectList } from '../src/config-manager'

jest.mock('../src/config-manager')
jest.mock('../src/logger')

const mockedLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>
const mockedGetProjectList = getProjectList as jest.MockedFunction<typeof getProjectList>

describe('startConfigWatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const projects = [
    { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
    { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
  ]

  it('should call onTokenUpdate when token changes for a project', () => {
    mockedLoadConfig.mockReturnValue({
      agentId: 'test',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'new-token-a', apiUrl: 'http://api-a' },
        { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
      ],
    })
    mockedGetProjectList.mockReturnValue([
      { tenantCode: 'mbc', projectCode: 'proj-a', token: 'new-token-a', apiUrl: 'http://api-a' },
      { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
    ])

    const callbacks = {
      onTokenUpdate: jest.fn(),
      onProjectAdded: jest.fn(),
      onProjectRemoved: jest.fn(),
    }
    const watcher = startConfigWatcher(projects, callbacks)

    jest.advanceTimersByTime(5000)

    expect(callbacks.onTokenUpdate).toHaveBeenCalledTimes(1)
    expect(callbacks.onTokenUpdate).toHaveBeenCalledWith('proj-a', 'new-token-a')
    expect(callbacks.onProjectAdded).not.toHaveBeenCalled()
    expect(callbacks.onProjectRemoved).not.toHaveBeenCalled()

    watcher.stop()
  })

  it('should call onProjectAdded when a new project appears in config', () => {
    const newProject = { tenantCode: 'mbc', projectCode: 'proj-c', token: 'token-c', apiUrl: 'http://api-c' }
    mockedLoadConfig.mockReturnValue({
      agentId: 'test',
      createdAt: '2024-01-01',
      projects: [...projects, newProject],
    })
    mockedGetProjectList.mockReturnValue([...projects, newProject])

    const callbacks = {
      onTokenUpdate: jest.fn(),
      onProjectAdded: jest.fn(),
      onProjectRemoved: jest.fn(),
    }
    const watcher = startConfigWatcher(projects, callbacks)

    jest.advanceTimersByTime(5000)

    expect(callbacks.onProjectAdded).toHaveBeenCalledTimes(1)
    expect(callbacks.onProjectAdded).toHaveBeenCalledWith(newProject)
    expect(callbacks.onTokenUpdate).not.toHaveBeenCalled()
    expect(callbacks.onProjectRemoved).not.toHaveBeenCalled()

    watcher.stop()
  })

  it('should call onProjectRemoved when a project is removed from config', () => {
    mockedLoadConfig.mockReturnValue({
      agentId: 'test',
      createdAt: '2024-01-01',
      projects: [projects[0]], // proj-b removed
    })
    mockedGetProjectList.mockReturnValue([projects[0]])

    const callbacks = {
      onTokenUpdate: jest.fn(),
      onProjectAdded: jest.fn(),
      onProjectRemoved: jest.fn(),
    }
    const watcher = startConfigWatcher(projects, callbacks)

    jest.advanceTimersByTime(5000)

    expect(callbacks.onProjectRemoved).toHaveBeenCalledTimes(1)
    expect(callbacks.onProjectRemoved).toHaveBeenCalledWith('proj-b')
    expect(callbacks.onTokenUpdate).not.toHaveBeenCalled()
    expect(callbacks.onProjectAdded).not.toHaveBeenCalled()

    watcher.stop()
  })

  it('should handle simultaneous add, remove, and token change', () => {
    mockedLoadConfig.mockReturnValue({
      agentId: 'test',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'new-token-a', apiUrl: 'http://api-a' }, // token changed
        // proj-b removed
        { tenantCode: 'mbc', projectCode: 'proj-c', token: 'token-c', apiUrl: 'http://api-c' }, // added
      ],
    })
    mockedGetProjectList.mockReturnValue([
      { tenantCode: 'mbc', projectCode: 'proj-a', token: 'new-token-a', apiUrl: 'http://api-a' },
      { tenantCode: 'mbc', projectCode: 'proj-c', token: 'token-c', apiUrl: 'http://api-c' },
    ])

    const callbacks = {
      onTokenUpdate: jest.fn(),
      onProjectAdded: jest.fn(),
      onProjectRemoved: jest.fn(),
    }
    const watcher = startConfigWatcher(projects, callbacks)

    jest.advanceTimersByTime(5000)

    expect(callbacks.onTokenUpdate).toHaveBeenCalledWith('proj-a', 'new-token-a')
    expect(callbacks.onProjectAdded).toHaveBeenCalledWith(
      { tenantCode: 'mbc', projectCode: 'proj-c', token: 'token-c', apiUrl: 'http://api-c' },
    )
    expect(callbacks.onProjectRemoved).toHaveBeenCalledWith('proj-b')

    watcher.stop()
  })

  it('should not fire callbacks when nothing changes', () => {
    mockedLoadConfig.mockReturnValue({
      agentId: 'test',
      createdAt: '2024-01-01',
      projects,
    })
    mockedGetProjectList.mockReturnValue(projects)

    const callbacks = {
      onTokenUpdate: jest.fn(),
      onProjectAdded: jest.fn(),
      onProjectRemoved: jest.fn(),
    }
    const watcher = startConfigWatcher(projects, callbacks)

    jest.advanceTimersByTime(5000)

    expect(callbacks.onTokenUpdate).not.toHaveBeenCalled()
    expect(callbacks.onProjectAdded).not.toHaveBeenCalled()
    expect(callbacks.onProjectRemoved).not.toHaveBeenCalled()

    watcher.stop()
  })

  it('should not call onProjectAdded again for already-tracked project on second poll', () => {
    const newProject = { tenantCode: 'mbc', projectCode: 'proj-c', token: 'token-c', apiUrl: 'http://api-c' }
    mockedLoadConfig.mockReturnValue({
      agentId: 'test',
      createdAt: '2024-01-01',
      projects: [...projects, newProject],
    })
    mockedGetProjectList.mockReturnValue([...projects, newProject])

    const callbacks = {
      onTokenUpdate: jest.fn(),
      onProjectAdded: jest.fn(),
      onProjectRemoved: jest.fn(),
    }
    const watcher = startConfigWatcher(projects, callbacks)

    jest.advanceTimersByTime(5000)
    expect(callbacks.onProjectAdded).toHaveBeenCalledTimes(1)

    // Second poll: same config, should not fire again
    jest.advanceTimersByTime(5000)
    expect(callbacks.onProjectAdded).toHaveBeenCalledTimes(1)

    watcher.stop()
  })

  it('should stop polling when stop() is called', () => {
    mockedLoadConfig.mockReturnValue({
      agentId: 'test',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'new-token-a', apiUrl: 'http://api-a' },
      ],
    })
    mockedGetProjectList.mockReturnValue([
      { tenantCode: 'mbc', projectCode: 'proj-a', token: 'new-token-a', apiUrl: 'http://api-a' },
    ])

    const callbacks = {
      onTokenUpdate: jest.fn(),
      onProjectAdded: jest.fn(),
      onProjectRemoved: jest.fn(),
    }
    const watcher = startConfigWatcher(projects, callbacks)

    watcher.stop()

    jest.advanceTimersByTime(10000)

    expect(callbacks.onTokenUpdate).not.toHaveBeenCalled()

    watcher.stop()
  })

  it('should ignore config read errors', () => {
    mockedLoadConfig.mockImplementation(() => {
      throw new Error('ENOENT: file not found')
    })

    const callbacks = {
      onTokenUpdate: jest.fn(),
      onProjectAdded: jest.fn(),
      onProjectRemoved: jest.fn(),
    }
    const watcher = startConfigWatcher(projects, callbacks)

    jest.advanceTimersByTime(5000)

    expect(callbacks.onTokenUpdate).not.toHaveBeenCalled()
    expect(callbacks.onProjectAdded).not.toHaveBeenCalled()
    expect(callbacks.onProjectRemoved).not.toHaveBeenCalled()

    watcher.stop()
  })

  it('should ignore when loadConfig returns null', () => {
    mockedLoadConfig.mockReturnValue(null)

    const callbacks = {
      onTokenUpdate: jest.fn(),
      onProjectAdded: jest.fn(),
      onProjectRemoved: jest.fn(),
    }
    const watcher = startConfigWatcher(projects, callbacks)

    jest.advanceTimersByTime(5000)

    expect(callbacks.onTokenUpdate).not.toHaveBeenCalled()

    watcher.stop()
  })
})

describe('startTokenWatcher (legacy wrapper)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const projects = [
    { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
  ]

  it('should call onTokenUpdate when token changes', () => {
    mockedLoadConfig.mockReturnValue({
      agentId: 'test',
      createdAt: '2024-01-01',
      projects: [{ tenantCode: 'mbc', projectCode: 'proj-a', token: 'new-token', apiUrl: 'http://api-a' }],
    })
    mockedGetProjectList.mockReturnValue([
      { tenantCode: 'mbc', projectCode: 'proj-a', token: 'new-token', apiUrl: 'http://api-a' },
    ])

    const callback = jest.fn()
    const watcher = startTokenWatcher(projects, callback)

    jest.advanceTimersByTime(5000)

    expect(callback).toHaveBeenCalledWith('proj-a', 'new-token')

    watcher.stop()
  })
})
