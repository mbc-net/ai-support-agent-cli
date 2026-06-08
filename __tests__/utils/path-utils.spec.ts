import * as os from 'os'
import * as path from 'path'

jest.mock('../../src/config-manager', () => ({
  getConfigDir: jest.fn(),
}))

import { getConfigDir } from '../../src/config-manager'
import {
  getAgentErrLog,
  getAgentOutLog,
  getDarwinLaunchAgentsDir,
  getDarwinLogDir,
  getLinuxLogDir,
  getLinuxSystemdUserDir,
  getProjectConfigHostDir,
  getProjectLogDir,
  getProjectServiceDir,
  getServicesDir,
  getUpdateScriptPath,
  getUpdateVersionFilePath,
  getWin32LogDir,
  getWin32WrapperScriptPath,
  getWrapperErrLog,
  getWrapperOutLog,
  getWrapperScriptPath,
} from '../../src/utils/path-utils'

const mockedGetConfigDir = jest.mocked(getConfigDir)
const HOME = os.homedir()
const MOCK_CONFIG_DIR = '/mock/config'

beforeEach(() => {
  mockedGetConfigDir.mockReturnValue(MOCK_CONFIG_DIR)
})

// ---------------------------------------------------------------------------
// Shared service path helpers
// ---------------------------------------------------------------------------

describe('getProjectConfigHostDir', () => {
  it('should return project config host dir under config dir', () => {
    expect(getProjectConfigHostDir('tenant1', 'PROJECT_A')).toBe(
      path.join(MOCK_CONFIG_DIR, 'projects', 'tenant1', 'PROJECT_A', '.ai-support-agent'),
    )
  })

  it('should include both tenantCode and projectCode in path', () => {
    const result = getProjectConfigHostDir('myTenant', 'MY_PROJECT')
    expect(result).toContain('myTenant')
    expect(result).toContain('MY_PROJECT')
    expect(result).toContain('.ai-support-agent')
  })

  it('should handle codes with hyphens and underscores', () => {
    const result = getProjectConfigHostDir('my-tenant', 'MY_PROJECT_01')
    expect(result).toBe(
      path.join(MOCK_CONFIG_DIR, 'projects', 'my-tenant', 'MY_PROJECT_01', '.ai-support-agent'),
    )
  })
})

describe('getServicesDir', () => {
  it('should return services dir under config dir', () => {
    expect(getServicesDir()).toBe(path.join(MOCK_CONFIG_DIR, 'services'))
  })
})

describe('getUpdateScriptPath', () => {
  it('should return update-and-restart.sh under config dir', () => {
    expect(getUpdateScriptPath()).toBe(path.join(MOCK_CONFIG_DIR, 'update-and-restart.sh'))
  })
})

describe('getUpdateVersionFilePath', () => {
  it('should return update-version.json under config dir', () => {
    expect(getUpdateVersionFilePath()).toBe(path.join(MOCK_CONFIG_DIR, 'update-version.json'))
  })

  it('should track a changed config dir', () => {
    mockedGetConfigDir.mockReturnValue('/other/cfg')
    expect(getUpdateVersionFilePath()).toBe(path.join('/other/cfg', 'update-version.json'))
  })
})

describe('getProjectLogDir', () => {
  it('should join logRootDir with projectKey', () => {
    expect(getProjectLogDir('/var/log/agent', 'tenant-project')).toBe(
      '/var/log/agent/tenant-project',
    )
  })

  it('should produce path under a custom log root', () => {
    const result = getProjectLogDir('/custom/logs', 'mbc-MBC-01')
    expect(result).toBe('/custom/logs/mbc-MBC-01')
  })
})

describe('getProjectServiceDir', () => {
  it('should join servicesDir with projectKey', () => {
    expect(getProjectServiceDir('/services', 'tenant-project')).toBe('/services/tenant-project')
  })
})

describe('getWrapperScriptPath', () => {
  it('should return run.sh inside projectServiceDir', () => {
    expect(getWrapperScriptPath('/services/tenant-project')).toBe(
      '/services/tenant-project/run.sh',
    )
  })
})

describe('getWin32WrapperScriptPath', () => {
  it('should return run.cmd inside projectServiceDir', () => {
    expect(getWin32WrapperScriptPath('/services/tenant-project')).toBe(
      path.join('/services/tenant-project', 'run.cmd'),
    )
  })
})

describe('getAgentOutLog', () => {
  it('should return agent.out.log inside logDir', () => {
    expect(getAgentOutLog('/logs/project')).toBe('/logs/project/agent.out.log')
  })
})

describe('getAgentErrLog', () => {
  it('should return agent.err.log inside logDir', () => {
    expect(getAgentErrLog('/logs/project')).toBe('/logs/project/agent.err.log')
  })
})

describe('getWrapperOutLog', () => {
  it('should return wrapper.out.log inside logDir', () => {
    expect(getWrapperOutLog('/logs/project')).toBe('/logs/project/wrapper.out.log')
  })
})

describe('getWrapperErrLog', () => {
  it('should return wrapper.err.log inside logDir', () => {
    expect(getWrapperErrLog('/logs/project')).toBe('/logs/project/wrapper.err.log')
  })
})

// ---------------------------------------------------------------------------
// macOS (Darwin) specific path helpers
// ---------------------------------------------------------------------------

describe('getDarwinLogDir', () => {
  it('should return ~/Library/Logs/ai-support-agent', () => {
    expect(getDarwinLogDir()).toBe(path.join(HOME, 'Library', 'Logs', 'ai-support-agent'))
  })

  it('should be rooted at homedir', () => {
    expect(getDarwinLogDir().startsWith(HOME)).toBe(true)
  })
})

describe('getDarwinLaunchAgentsDir', () => {
  it('should return ~/Library/LaunchAgents', () => {
    expect(getDarwinLaunchAgentsDir()).toBe(path.join(HOME, 'Library', 'LaunchAgents'))
  })

  it('should be rooted at homedir', () => {
    expect(getDarwinLaunchAgentsDir().startsWith(HOME)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Linux specific path helpers
// ---------------------------------------------------------------------------

describe('getLinuxSystemdUserDir', () => {
  it('should return ~/.config/systemd/user', () => {
    expect(getLinuxSystemdUserDir()).toBe(path.join(HOME, '.config', 'systemd', 'user'))
  })

  it('should be rooted at homedir', () => {
    expect(getLinuxSystemdUserDir().startsWith(HOME)).toBe(true)
  })
})

describe('getLinuxLogDir', () => {
  it('should return ~/.local/share/ai-support-agent/logs', () => {
    expect(getLinuxLogDir()).toBe(
      path.join(HOME, '.local', 'share', 'ai-support-agent', 'logs'),
    )
  })

  it('should be rooted at homedir', () => {
    expect(getLinuxLogDir().startsWith(HOME)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Windows (win32) specific path helpers
// ---------------------------------------------------------------------------

describe('getWin32LogDir', () => {
  const origLocalAppData = process.env.LOCALAPPDATA

  afterEach(() => {
    if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = origLocalAppData
  })

  it('uses %LOCALAPPDATA% when set', () => {
    process.env.LOCALAPPDATA = path.join('C:', 'Users', 'test', 'AppData', 'Local')
    expect(getWin32LogDir()).toBe(
      path.join(process.env.LOCALAPPDATA, 'ai-support-agent', 'logs'),
    )
  })

  it('falls back to ~/AppData/Local when LOCALAPPDATA is unset', () => {
    delete process.env.LOCALAPPDATA
    expect(getWin32LogDir()).toBe(
      path.join(HOME, 'AppData', 'Local', 'ai-support-agent', 'logs'),
    )
  })
})
