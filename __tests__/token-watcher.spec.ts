import { startTokenWatcher } from '../src/token-watcher'
import { loadConfig, getProjectList } from '../src/config-manager'

jest.mock('../src/config-manager')
jest.mock('../src/logger')

const mockedLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>
const mockedGetProjectList = getProjectList as jest.MockedFunction<typeof getProjectList>

describe('startTokenWatcher', () => {
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

    const callback = jest.fn()
    const watcher = startTokenWatcher(projects, callback)

    jest.advanceTimersByTime(5000)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('proj-a', 'new-token-a')

    watcher.stop()
  })

  it('should not call onTokenUpdate when tokens are unchanged', () => {
    mockedLoadConfig.mockReturnValue({
      agentId: 'test',
      createdAt: '2024-01-01',
      projects,
    })
    mockedGetProjectList.mockReturnValue(projects)

    const callback = jest.fn()
    const watcher = startTokenWatcher(projects, callback)

    jest.advanceTimersByTime(5000)

    expect(callback).not.toHaveBeenCalled()

    watcher.stop()
  })

  it('should stop polling when stop() is called', () => {
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

    const callback = jest.fn()
    const watcher = startTokenWatcher(projects, callback)

    watcher.stop()

    jest.advanceTimersByTime(10000)

    expect(callback).not.toHaveBeenCalled()
  })

  it('should ignore config read errors', () => {
    mockedLoadConfig.mockImplementation(() => {
      throw new Error('ENOENT: file not found')
    })

    const callback = jest.fn()
    const watcher = startTokenWatcher(projects, callback)

    // Should not throw
    jest.advanceTimersByTime(5000)

    expect(callback).not.toHaveBeenCalled()

    watcher.stop()
  })

  it('should ignore when loadConfig returns null', () => {
    mockedLoadConfig.mockReturnValue(null)

    const callback = jest.fn()
    const watcher = startTokenWatcher(projects, callback)

    jest.advanceTimersByTime(5000)

    expect(callback).not.toHaveBeenCalled()

    watcher.stop()
  })

  it('should track token changes across multiple intervals', () => {
    // First poll: token-a changes
    mockedLoadConfig.mockReturnValueOnce({
      agentId: 'test',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a-v2', apiUrl: 'http://api-a' },
        { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
      ],
    })
    mockedGetProjectList.mockReturnValueOnce([
      { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a-v2', apiUrl: 'http://api-a' },
      { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
    ])

    // Second poll: token-a unchanged (same as v2)
    mockedLoadConfig.mockReturnValueOnce({
      agentId: 'test',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a-v2', apiUrl: 'http://api-a' },
        { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
      ],
    })
    mockedGetProjectList.mockReturnValueOnce([
      { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a-v2', apiUrl: 'http://api-a' },
      { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
    ])

    const callback = jest.fn()
    const watcher = startTokenWatcher(projects, callback)

    jest.advanceTimersByTime(5000)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('proj-a', 'token-a-v2')

    jest.advanceTimersByTime(5000)
    // Should not fire again because token hasn't changed since v2
    expect(callback).toHaveBeenCalledTimes(1)

    watcher.stop()
  })

  it('should not fire for projects not in the initial list', () => {
    mockedLoadConfig.mockReturnValue({
      agentId: 'test',
      createdAt: '2024-01-01',
      projects: [
        { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
        { tenantCode: 'mbc', projectCode: 'proj-c', token: 'token-c-new', apiUrl: 'http://api-c' },
      ],
    })
    mockedGetProjectList.mockReturnValue([
      { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
      { tenantCode: 'mbc', projectCode: 'proj-c', token: 'token-c-new', apiUrl: 'http://api-c' },
    ])

    const callback = jest.fn()
    const watcher = startTokenWatcher(projects, callback)

    jest.advanceTimersByTime(5000)

    // proj-c is not in initial projects, so no callback
    expect(callback).not.toHaveBeenCalled()

    watcher.stop()
  })
})
