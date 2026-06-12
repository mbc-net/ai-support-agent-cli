import * as os from 'os'
import * as path from 'path'

jest.mock('fs')
jest.mock('child_process')
jest.mock('../../../src/logger')
jest.mock('../../../src/i18n', () => ({
  initI18n: jest.fn(),
  t: (key: string, params?: Record<string, unknown>) => {
    if (params) {
      let result = key
      for (const [k, v] of Object.entries(params)) {
        result = result.replace(`{{${k}}}`, String(v))
      }
      return result
    }
    return key
  },
}))

// Mock config-manager
jest.mock('../../../src/config-manager', () => ({
  loadConfig: jest.fn(),
  getProjectList: jest.fn(),
  getConfigDir: jest.fn(() => {
    const envDir = process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    if (envDir) {
      return require('path').resolve(envDir)
    }
    return require('path').join(require('os').homedir(), '.ai-support-agent')
  }),
}))

import { execSync } from 'child_process'
import * as fs from 'fs'
import { IMAGE_NAME } from '../../../src/docker/docker-utils'
import { ENV_VARS } from '../../../src/constants'
import {
  LinuxServiceStrategy,
  generateServiceUnit,
  generateProjectServiceUnit,
  generateWrapperScript,
  generateUpdateScript,
  getProjectUnitName,
  getProjectUnitFilePath,
  getAllProjectUnits,
  detectSystemSystemdUnits,
  writeProjectServiceFiles,
  installAndStartProject,
  getCliEntryPoint,
  getNodePath,
} from '../../../src/cli/service/linux-service'
import { logger } from '../../../src/logger'
import { loadConfig, getProjectList } from '../../../src/config-manager'

const mockedFs = jest.mocked(fs)
const mockedExecSync = jest.mocked(execSync)
const mockedLoadConfig = jest.mocked(loadConfig)
const mockedGetProjectList = jest.mocked(getProjectList)

beforeEach(() => {
  jest.clearAllMocks()
  mockedLoadConfig.mockReturnValue(null)
  mockedGetProjectList.mockReturnValue([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedFs.readdirSync.mockReturnValue([] as any)
})

// ---------------------------------------------------------------------------
// generateServiceUnit (legacy single-unit)
// ---------------------------------------------------------------------------
describe('generateServiceUnit', () => {
  it('should generate valid systemd unit file', () => {
    const result = generateServiceUnit({
      nodePath: '/usr/bin/node',
      entryPoint: '/usr/lib/node_modules/@ai-support-agent/cli/dist/index.js',
      logDir: '/home/user/.local/share/ai-support-agent/logs',
    })

    expect(result).toContain('[Unit]')
    expect(result).toContain('Description=AI Support Agent')
    expect(result).toContain('After=network-online.target')
    expect(result).toContain('[Service]')
    expect(result).toContain('Type=simple')
    expect(result).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/@ai-support-agent/cli/dist/index.js start --no-docker')
    expect(result).toContain('Restart=always')
    expect(result).toContain('RestartSec=10')
    expect(result).toContain(`Environment=HOME=${os.homedir()}`)
    expect(result).toContain('StandardOutput=append:/home/user/.local/share/ai-support-agent/logs/agent.out.log')
    expect(result).toContain('StandardError=append:/home/user/.local/share/ai-support-agent/logs/agent.err.log')
    expect(result).toContain('[Install]')
    expect(result).toContain('WantedBy=default.target')
    expect(result).not.toContain('--verbose')
  })

  it('should include --verbose flag when verbose is true', () => {
    const result = generateServiceUnit({
      nodePath: '/usr/bin/node',
      entryPoint: '/path/to/index.js',
      logDir: '/tmp/logs',
      verbose: true,
    })

    expect(result).toContain('--verbose')
  })

  it('should not include --no-docker when docker is true', () => {
    const result = generateServiceUnit({
      nodePath: '/usr/bin/node',
      entryPoint: '/path/to/index.js',
      logDir: '/tmp/logs',
      docker: true,
    })

    expect(result).not.toContain('--no-docker')
  })

  it('should quote paths containing spaces in ExecStart', () => {
    const result = generateServiceUnit({
      nodePath: '/opt/my programs/node',
      entryPoint: '/home/user/my app/index.js',
      logDir: '/tmp/logs',
    })

    expect(result).toContain('ExecStart="/opt/my programs/node" "/home/user/my app/index.js" start --no-docker')
  })

  it('should include PATH environment variable', () => {
    const result = generateServiceUnit({
      nodePath: '/usr/bin/node',
      entryPoint: '/path/to/index.js',
      logDir: '/tmp/logs',
    })

    expect(result).toContain('Environment=PATH=/usr/local/bin:/usr/bin:/bin')
  })
})

// ---------------------------------------------------------------------------
// generateProjectServiceUnit
// ---------------------------------------------------------------------------
describe('generateProjectServiceUnit', () => {
  it('should generate valid per-project systemd unit', () => {
    const result = generateProjectServiceUnit({
      unitName: 'ai-support-agent-mbc-mbc-01',
      wrapperScriptPath: '/home/user/.ai-support-agent/services/mbc-mbc-01/run.sh',
      logDir: '/home/user/.local/share/ai-support-agent/logs/mbc-mbc-01',
    })

    expect(result).toContain('[Unit]')
    expect(result).toContain('Description=AI Support Agent (ai-support-agent-mbc-mbc-01)')
    expect(result).toContain('[Service]')
    expect(result).toContain('Type=simple')
    expect(result).toContain('ExecStart=/bin/bash /home/user/.ai-support-agent/services/mbc-mbc-01/run.sh')
    expect(result).toContain('Restart=always')
    expect(result).toContain('RestartSec=10')
    // systemd unit captures the WRAPPER's stdout/stderr (bootstrap noise).
    // The agent's actual stdout/stderr is rotated into agent.out.log /
    // agent.err.log inside the wrapper itself — those paths are NOT used
    // here to avoid a double-write race with the rotator. See
    // generateProjectServiceUnit for the full rationale.
    expect(result).toContain('StandardOutput=append:/home/user/.local/share/ai-support-agent/logs/mbc-mbc-01/wrapper.out.log')
    expect(result).toContain('StandardError=append:/home/user/.local/share/ai-support-agent/logs/mbc-mbc-01/wrapper.err.log')
    // Must NOT include the rotated-file paths — those belong to the rotator only.
    expect(result).not.toContain('StandardOutput=append:/home/user/.local/share/ai-support-agent/logs/mbc-mbc-01/agent.out.log')
    expect(result).not.toContain('StandardError=append:/home/user/.local/share/ai-support-agent/logs/mbc-mbc-01/agent.err.log')
    expect(result).toContain('[Install]')
    expect(result).toContain('WantedBy=default.target')
  })

  it('should include PATH and HOME in environment', () => {
    const result = generateProjectServiceUnit({
      unitName: 'ai-support-agent-mbc-mbc-01',
      wrapperScriptPath: '/tmp/run.sh',
      logDir: '/tmp/logs',
    })

    expect(result).toContain('Environment=PATH=/usr/local/bin:/usr/bin:/bin')
    // HOME is systemd-escaped; for a path without spaces this is unchanged
    expect(result).toContain(`Environment=HOME=${os.homedir()}`)
  })

  it('should systemd-escape spaces in the wrapper script path', () => {
    const result = generateProjectServiceUnit({
      unitName: 'ai-support-agent-mbc-mbc-01',
      wrapperScriptPath: '/home/jane doe/.ai-support-agent/services/mbc-mbc-01/run.sh',
      logDir: '/home/jane doe/.local/share/ai-support-agent/logs/mbc-mbc-01',
    })

    // systemd parses ExecStart on unescaped whitespace; spaces must be \x20
    expect(result).toContain('ExecStart=/bin/bash /home/jane\\x20doe/.ai-support-agent/services/mbc-mbc-01/run.sh')
    expect(result).toContain('StandardOutput=append:/home/jane\\x20doe/.local/share/ai-support-agent/logs/mbc-mbc-01/wrapper.out.log')
  })

  it('should systemd-escape `$` to `$$` to prevent variable expansion', () => {
    const result = generateProjectServiceUnit({
      unitName: 'ai-support-agent-mbc-mbc-01',
      wrapperScriptPath: '/home/user$abc/.ai-support-agent/services/mbc-mbc-01/run.sh',
      logDir: '/tmp/logs',
    })

    // systemd would otherwise expand $abc as an Environment variable reference;
    // the literal $ must appear as $$
    expect(result).toContain('ExecStart=/bin/bash /home/user$$abc/.ai-support-agent/services/mbc-mbc-01/run.sh')
  })

  it('should systemd-escape `%` to `%%` to prevent specifier expansion', () => {
    const result = generateProjectServiceUnit({
      unitName: 'ai-support-agent-mbc-mbc-01',
      wrapperScriptPath: '/home/user%h/.ai-support-agent/services/mbc-mbc-01/run.sh',
      logDir: '/tmp/logs',
    })

    // systemd would otherwise expand %h to the home dir specifier
    expect(result).toContain('ExecStart=/bin/bash /home/user%%h/.ai-support-agent/services/mbc-mbc-01/run.sh')
  })
})

// ---------------------------------------------------------------------------
// generateWrapperScript
// ---------------------------------------------------------------------------
describe('generateWrapperScript', () => {
  const baseOpts = {
    imageName: IMAGE_NAME,
    tenantCode: 'mbc',
    projectCode: 'MBC_01',
    projectConfigHostDir: '/home/user/.ai-support-agent/projects/mbc/MBC_01/.ai-support-agent',
    token: 'test-token',
    apiUrl: 'https://api.example.com',
    updateScriptPath: '/home/user/.ai-support-agent/update-and-restart.sh',
  }

  it('should generate a bash script with docker run', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('#!/bin/bash')
    expect(result).toContain('docker run --rm -i')
    // image tag and container name are shell-quoted; IMAGE_TAG bash var holds the full tag
    expect(result).toContain("IMAGE_TAG='ai-support-agent':${_INSTALLED_VERSION}")
    expect(result).toContain('"$IMAGE_TAG"')
    expect(result).toContain('npm root -g')
    expect(result).toContain('@ai-support-agent/cli/package.json')
    expect(result).toContain('ai-support-agent start --no-docker')
    expect(result).toContain("--project 'mbc/MBC_01'")
  })

  it('should run the container as the invoking user (--user uid:gid)', () => {
    // Without --user, a container started by a systemd --user service runs
    // as root inside the container but bind-mounted host paths owned by the
    // unprivileged service user are not writable (EACCES on mkdir under
    // rootless docker or userns-remap setups), so the agent fails to
    // initialize the per-project workspace on first start.
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('_DOCKER_UID=$(id -u)')
    expect(result).toContain('_DOCKER_GID=$(id -g)')
    expect(result).toContain('--user "${_DOCKER_UID}:${_DOCKER_GID}"')
  })

  it('should load nvm and set PATH for systemd compatibility', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('NVM_DIR')
    expect(result).toContain('nvm.sh')
    expect(result).toContain('/usr/local/bin:/usr/bin:/bin')
  })

  it('should exit with error when version cannot be determined', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('if [ -z "$_INSTALLED_VERSION" ]')
    expect(result).toContain('Could not determine installed version')
    expect(result).toContain('exit 1')
    expect(result).not.toContain(':-latest')
  })

  it('should include container name derived from tenantCode and projectCode', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain("--name 'ai-mbc-mbc-01'")
    expect(result).toContain("docker rm -f 'ai-mbc-mbc-01'")
  })

  it('should sanitize special characters in container name', () => {
    const result = generateWrapperScript({ ...baseOpts, tenantCode: 'my_tenant', projectCode: 'MY.PROJECT' })

    expect(result).toContain("--name 'ai-my-tenant-my-project'")
  })

  it('should convert localhost to host.docker.internal in apiUrl', () => {
    const result = generateWrapperScript({ ...baseOpts, apiUrl: 'http://localhost:4030' })

    expect(result).toContain("AI_SUPPORT_AGENT_API_URL='http://host.docker.internal:4030'")
    expect(result).not.toContain('localhost')
  })

  it('should convert 127.0.0.1 to host.docker.internal in apiUrl', () => {
    const result = generateWrapperScript({ ...baseOpts, apiUrl: 'http://127.0.0.1:4030' })

    expect(result).toContain("AI_SUPPORT_AGENT_API_URL='http://host.docker.internal:4030'")
    expect(result).not.toContain('127.0.0.1')
  })

  it('should NOT replace localhost when it is a prefix of a longer hostname', () => {
    // Without the regex anchor, `http://localhost.example.com` would
    // partially match the `localhost` prefix and become
    // `http://host.docker.internal.example.com` — a different host.
    const result = generateWrapperScript({ ...baseOpts, apiUrl: 'http://localhost.example.com/api' })

    expect(result).toContain("AI_SUPPORT_AGENT_API_URL='http://localhost.example.com/api'")
    expect(result).not.toContain('host.docker.internal')
  })

  it('should NOT replace 127.0.0.1 when it is a prefix of a longer host', () => {
    const result = generateWrapperScript({ ...baseOpts, apiUrl: 'http://127.0.0.1.nip.io/api' })

    expect(result).toContain("AI_SUPPORT_AGENT_API_URL='http://127.0.0.1.nip.io/api'")
    expect(result).not.toContain('host.docker.internal')
  })

  it('should convert localhost without port when path follows directly', () => {
    const result = generateWrapperScript({ ...baseOpts, apiUrl: 'http://localhost/api' })

    expect(result).toContain("AI_SUPPORT_AGENT_API_URL='http://host.docker.internal/api'")
  })

  it('should handle exit 42 by delegating to update script', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('EXIT_CODE=$?')
    expect(result).toContain('if [ "$EXIT_CODE" -eq 42 ]; then')
    expect(result).toContain("exec '/home/user/.ai-support-agent/update-and-restart.sh'")
  })

  it('should auto-build Docker image when it does not exist locally', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain('docker image inspect "$IMAGE_TAG"')
    expect(result).toContain('ai-support-agent docker-build || { echo "ERROR: docker-build failed')
  })

  it('should include ANTHROPIC_API_KEY when provided', () => {
    const result = generateWrapperScript({ ...baseOpts, anthropicApiKey: 'sk-ant-test' })

    expect(result).toContain("-e ANTHROPIC_API_KEY='sk-ant-test'")
  })

  it('should include CLAUDE_CODE_OAUTH_TOKEN when provided', () => {
    const result = generateWrapperScript({ ...baseOpts, claudeCodeOauthToken: 'oauth-token' })

    expect(result).toContain(`-e ${ENV_VARS.CLAUDE_CODE_OAUTH_TOKEN}='oauth-token'`)
  })

  it('should not include optional env vars when not provided', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).not.toContain('ANTHROPIC_API_KEY')
    expect(result).not.toContain(ENV_VARS.CLAUDE_CODE_OAUTH_TOKEN)
  })

  it('should include --verbose flag when verbose is true', () => {
    const result = generateWrapperScript({ ...baseOpts, verbose: true })

    expect(result).toContain('--verbose')
  })

  it('should include project volume mount when projectDir is provided', () => {
    const result = generateWrapperScript({ ...baseOpts, projectDir: '/home/user/projects/mbc01' })

    expect(result).toContain('/home/user/projects/mbc01')
    expect(result).toContain('/workspace/projects/MBC_01')
  })

  it('should mount project config dir', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).toContain("'/home/user/.ai-support-agent/projects/mbc/MBC_01/.ai-support-agent:/home/node/.ai-support-agent:rw'")
  })

  it('should mount the parent of projectConfigHostDir as the in-container project dir when projectDir is NOT provided', () => {
    // Regression for the double-nesting bug: without this mount + env, the
    // in-container `ensureProjectDirs` resolves the project dir to
    // `${CONFIG_DIR}/projects/<t>/<p>` inside the metadata bind-mount,
    // producing `<host>/.ai-support-agent/projects/<t>/<p>/.ai-support-agent/projects/<t>/<p>/workspace/...`.
    const result = generateWrapperScript(baseOpts)

    // The default project-dir mount source is the PARENT of projectConfigHostDir
    expect(result).toContain("'/home/user/.ai-support-agent/projects/mbc/MBC_01:/workspace/projects/MBC_01:rw'")
    // The agent's resolveProjectDir() must short-circuit via the env map
    expect(result).toContain("AI_SUPPORT_AGENT_PROJECT_DIR_MAP='MBC_01=/workspace/projects/MBC_01'")
  })

  it('should fall back to the default project dir when projectDir is empty string (not nullish)', () => {
    // `??` would keep '' as the source and emit `-v ':/workspace/...:rw'`,
    // which docker rejects. `||` short-circuits to the default mount.
    const result = generateWrapperScript({ ...baseOpts, projectDir: '' })

    expect(result).not.toMatch(/-v\s+'?:\/workspace/)
    expect(result).toContain("'/home/user/.ai-support-agent/projects/mbc/MBC_01:/workspace/projects/MBC_01:rw'")
  })

  it('should shell-quote tokens containing shell metacharacters', () => {
    const result = generateWrapperScript({ ...baseOpts, token: "abc$(rm -rf ~) `id` 'oops'\"" })

    // The token must be embedded inside POSIX single quotes (with embedded
    // single quotes escaped via '\''). Bash does NOT expand $(...) / `...`
    // inside single quotes, so the literal characters appearing in the
    // script source are harmless at runtime.
    expect(result).toContain(`AI_SUPPORT_AGENT_TOKEN='abc$(rm -rf ~) \`id\` '\\''oops'\\''"'`)
    // It must NOT appear as a bare (unquoted) command substitution.
    expect(result).not.toMatch(/AI_SUPPORT_AGENT_TOKEN=abc\$\(rm -rf/)
  })

  it('should shell-quote API URLs containing shell metacharacters', () => {
    const result = generateWrapperScript({ ...baseOpts, apiUrl: 'https://api.example.com/?x=$y&z=1' })

    // The raw URL must be wrapped in single quotes so '&' and '$' don't expand
    expect(result).toContain("AI_SUPPORT_AGENT_API_URL='https://api.example.com/?x=$y&z=1'")
  })

  it('should shell-quote REBUILD_MARKER path containing $', () => {
    const result = generateWrapperScript({ ...baseOpts, projectConfigHostDir: '/srv/data$VERSION/cfg' })

    // Verify the literal $VERSION is preserved (not expanded by bash at runtime)
    expect(result).toContain("REBUILD_MARKER='/srv/data$VERSION/cfg'/docker-rebuild-needed")
  })

  it('should shell-quote ANTHROPIC_API_KEY containing shell metacharacters', () => {
    const result = generateWrapperScript({ ...baseOpts, anthropicApiKey: 'sk-ant-$BAD' })

    expect(result).toContain("ANTHROPIC_API_KEY='sk-ant-$BAD'")
  })

  it('should stream stdout/stderr through background log-rotate subprocesses via named FIFOs when logDir is provided', () => {
    // Per-project log rotation: stdout → agent.out.log, stderr → agent.err.log
    // via background `ai-support-agent log-rotate --no-tee` subprocesses
    // reading from named FIFOs (NOT process substitution — that's not
    // reapable by bash 3.2 / macOS's /bin/bash via bare `wait`). The
    // explicit `_ROT_OUT_PID` / `_ROT_ERR_PID` capture lets us wait on
    // the rotators portably so they drain before the wrapper exits.
    const result = generateWrapperScript({
      ...baseOpts,
      logDir: '/home/user/.local/share/ai-support-agent/logs/mbc-mbc-01',
    })

    // FIFOs created in a per-run temp dir
    expect(result).toContain('mkfifo "$_ROT_DIR/out" "$_ROT_DIR/err"')
    // Background rotators reading from FIFOs with shell-quoted log paths
    expect(result).toContain(
      "ai-support-agent log-rotate --no-tee '/home/user/.local/share/ai-support-agent/logs/mbc-mbc-01/agent.out.log' < \"$_ROT_DIR/out\" &",
    )
    expect(result).toContain(
      "ai-support-agent log-rotate --no-tee '/home/user/.local/share/ai-support-agent/logs/mbc-mbc-01/agent.err.log' < \"$_ROT_DIR/err\" >&2 &",
    )
    // PID capture for explicit wait
    expect(result).toContain('_ROT_OUT_PID=$!')
    expect(result).toContain('_ROT_ERR_PID=$!')
    // docker writes to FIFOs (not to >(cmd) process substitution)
    expect(result).toContain('> "$_ROT_DIR/out" 2> "$_ROT_DIR/err"')
    // Explicit wait on captured PIDs so rotators drain before exit
    expect(result).toContain('wait "$_ROT_OUT_PID" "$_ROT_ERR_PID" 2>/dev/null')
    // EXIT_CODE is set from docker's exit (NOT via pipefail, so the rotator
    // can never mask docker's own exit code — important for the exit-42
    // update path).
    expect(result).toContain('EXIT_CODE=$?')
    // tmpdir is cleaned up on wrapper exit (EXIT trap)
    expect(result).toContain("trap 'rm -rf \"$_ROT_DIR\"")
  })

  it('should NOT pipe through log-rotate when logDir is omitted (back-compat for callers that construct the wrapper without logDir)', () => {
    const result = generateWrapperScript(baseOpts)

    expect(result).not.toContain('ai-support-agent log-rotate')
  })
})

// ---------------------------------------------------------------------------
// generateUpdateScript
// ---------------------------------------------------------------------------
describe('generateUpdateScript', () => {
  it('should generate a bash script that stops/restarts systemd units', () => {
    const result = generateUpdateScript()

    expect(result).toContain('#!/bin/bash')
    expect(result).toContain('systemctl --user stop')
    expect(result).toContain('systemctl --user start')
    expect(result).toContain('ai-support-agent-*.service')
  })

  it('should iterate units via a shell glob (not pass a literal pattern to systemctl stop)', () => {
    const result = generateUpdateScript()

    // systemctl does not glob unit names; a quoted literal like
    // 'ai-support-agent-*.service' matches nothing. The script must expand
    // the glob in the shell and call systemctl stop per unit.
    expect(result).not.toMatch(/systemctl --user stop '[^']*\*[^']*'/)
    // The stop loop iterates the same glob the restart loop uses
    const stopLoopMatches = result.match(/for unit_path in "\$SYSTEMD_USER_DIR"\/ai-support-agent-\*\.service/g)
    expect(stopLoopMatches).not.toBeNull()
    expect(stopLoopMatches!.length).toBeGreaterThanOrEqual(2) // stop + restart
  })

  it('should shell-quote the systemd user dir in the for-loop', () => {
    const result = generateUpdateScript()

    // The dir is interpolated into the script at generation time and must be
    // quoted so a HOME containing whitespace doesn't word-split the glob.
    expect(result).toContain(`SYSTEMD_USER_DIR='${os.homedir()}/.config/systemd/user'`)
  })

  it('should enable nullglob so an empty match exits the loop cleanly', () => {
    const result = generateUpdateScript()

    expect(result).toContain('shopt -s nullglob')
  })

  it('should install new version from update-version.json', () => {
    const result = generateUpdateScript()

    expect(result).toContain('update-version.json')
    expect(result).toContain('npm install -g')
    expect(result).toContain('@ai-support-agent/cli@')
    expect(result).toContain('ai-support-agent service install')
  })

  it('should load nvm for systemd compatibility', () => {
    const result = generateUpdateScript()

    expect(result).toContain('NVM_DIR')
    expect(result).toContain('nvm.sh')
  })

  it('should reload daemon before restarting units', () => {
    const result = generateUpdateScript()

    expect(result).toContain('systemctl --user daemon-reload')
  })

  it('should capture npm install stderr and redact secrets', () => {
    const result = generateUpdateScript()

    expect(result).toContain('NPM_OUTPUT=$(npm install -g')
    expect(result).toContain('"$NPM_OUTPUT" | redact_secrets')
    expect(result).toContain('SI_OUTPUT=$(ai-support-agent service install')
    expect(result).toContain('"$SI_OUTPUT" | redact_secrets')
  })

  it('should redact common secret patterns', () => {
    const result = generateUpdateScript()

    expect(result).toContain('redact_secrets()')
    expect(result).toContain('Bearer ')
    expect(result).toContain('authToken')
    expect(result).toContain('X-Auth-Token')
  })

  it('should use UTC date for log prefix', () => {
    const result = generateUpdateScript()

    expect(result).toContain("date -u '+%Y-%m-%dT%H:%M:%SZ'")
  })

  it('should exit 0 on success', () => {
    const result = generateUpdateScript()

    expect(result).toContain('exit 0')
  })

  it('should use AI_SUPPORT_AGENT_CONFIG_DIR when set', () => {
    const originalConfigDir = process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    try {
      process.env.AI_SUPPORT_AGENT_CONFIG_DIR = '/custom/config-dir'
      const result = generateUpdateScript()

      expect(result).toContain('/custom/config-dir')
    } finally {
      if (originalConfigDir === undefined) delete process.env.AI_SUPPORT_AGENT_CONFIG_DIR
      else process.env.AI_SUPPORT_AGENT_CONFIG_DIR = originalConfigDir
    }
  })
})

// ---------------------------------------------------------------------------
// getProjectUnitName / getProjectUnitFilePath
// ---------------------------------------------------------------------------
describe('getProjectUnitName', () => {
  it('should generate unit name from tenantCode and projectCode', () => {
    expect(getProjectUnitName('mbc', 'MBC_01')).toBe('ai-support-agent-mbc-mbc-01')
  })

  it('should sanitize special characters', () => {
    expect(getProjectUnitName('my_tenant', 'MY.PROJECT')).toBe('ai-support-agent-my-tenant-my-project')
  })

  it('should lowercase codes', () => {
    expect(getProjectUnitName('MBC', 'TEST')).toBe('ai-support-agent-mbc-test')
  })
})

describe('getProjectUnitFilePath', () => {
  it('should return unit path under systemd user dir', () => {
    const result = getProjectUnitFilePath('mbc', 'MBC_01')
    expect(result).toBe(
      path.join(os.homedir(), '.config', 'systemd', 'user', 'ai-support-agent-mbc-mbc-01.service'),
    )
  })
})

// ---------------------------------------------------------------------------
// getAllProjectUnits
// ---------------------------------------------------------------------------
describe('getAllProjectUnits', () => {
  it('should return empty array when systemd dir read fails', () => {
    mockedFs.readdirSync.mockImplementation(() => { throw new Error('ENOENT') })

    const result = getAllProjectUnits()

    expect(result).toEqual([])
  })

  it('should return per-project units (excluding legacy unit)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue([
      'ai-support-agent.service',                       // legacy — excluded
      'ai-support-agent-mbc-mbc-01.service',
      'ai-support-agent-mbc-mbc-02.service',
      'other-service.service',                           // unrelated — excluded
    ] as any)

    const result = getAllProjectUnits()

    expect(result).toHaveLength(2)
    expect(result[0].unitName).toBe('ai-support-agent-mbc-mbc-01')
    expect(result[1].unitName).toBe('ai-support-agent-mbc-mbc-02')
  })

  it('should return empty array when only legacy unit exists', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue([
      'ai-support-agent.service',
    ] as any)

    const result = getAllProjectUnits()

    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// LinuxServiceStrategy — no projects configured
// ---------------------------------------------------------------------------
describe('LinuxServiceStrategy — no projects configured', () => {
  const strategy = new LinuxServiceStrategy()

  beforeEach(() => {
    mockedLoadConfig.mockReturnValue(null)
    mockedGetProjectList.mockReturnValue([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue([] as any)
  })

  it('install should log error when no projects configured', () => {
    strategy.install({})

    expect(logger.error).toHaveBeenCalledWith('service.noProjectsConfigured')
  })

  it('uninstall should warn when no units found', () => {
    strategy.uninstall()

    expect(logger.warn).toHaveBeenCalledWith('service.notInstalled')
  })

  it('start should log error when not installed', () => {
    strategy.start()

    expect(logger.error).toHaveBeenCalledWith('service.notInstalled')
    expect(mockedExecSync).not.toHaveBeenCalled()
  })

  it('stop should log error when not installed', () => {
    strategy.stop()

    expect(logger.error).toHaveBeenCalledWith('service.notInstalled')
    expect(mockedExecSync).not.toHaveBeenCalled()
  })

  it('restart should log error when not installed', () => {
    strategy.restart()

    expect(logger.error).toHaveBeenCalledWith('service.notInstalled')
    expect(mockedExecSync).not.toHaveBeenCalled()
  })

  it('status should return not installed', () => {
    const result = strategy.status()

    expect(result).toEqual({ installed: false, running: false })
  })
})

// ---------------------------------------------------------------------------
// LinuxServiceStrategy — multi-project mode
// ---------------------------------------------------------------------------
describe('LinuxServiceStrategy — multi-project mode', () => {
  const strategy = new LinuxServiceStrategy()

  const mockProjects = [
    {
      tenantCode: 'mbc',
      projectCode: 'MBC_01',
      token: 'token-01',
      apiUrl: 'https://api.example.com',
      projectDir: '/home/user/projects/mbc01',
    },
    {
      tenantCode: 'mbc',
      projectCode: 'MBC_02',
      token: 'token-02',
      apiUrl: 'https://api.example.com',
    },
  ]

  const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user')
  const mockProjectUnits = [
    {
      unitName: 'ai-support-agent-mbc-mbc-01',
      unitPath: path.join(systemdDir, 'ai-support-agent-mbc-mbc-01.service'),
    },
    {
      unitName: 'ai-support-agent-mbc-mbc-02',
      unitPath: path.join(systemdDir, 'ai-support-agent-mbc-mbc-02.service'),
    },
  ]

  beforeEach(() => {
    mockedLoadConfig.mockReturnValue({ projects: {} } as ReturnType<typeof loadConfig>)
    mockedGetProjectList.mockReturnValue(mockProjects)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue([
      'ai-support-agent-mbc-mbc-01.service',
      'ai-support-agent-mbc-mbc-02.service',
    ] as any)
  })

  describe('install', () => {
    it('should create per-project units and wrapper scripts', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.install({})

      // update-and-restart.sh + 2 wrapper scripts + 2 unit files = 5 writes
      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(5)

      const wrapperCalls = mockedFs.writeFileSync.mock.calls.filter(
        (call) => String(call[0]).endsWith('run.sh'),
      )
      expect(wrapperCalls).toHaveLength(2)

      const unitCalls = mockedFs.writeFileSync.mock.calls.filter(
        (call) => String(call[0]).endsWith('.service'),
      )
      expect(unitCalls).toHaveLength(2)
      expect(unitCalls[0][0]).toContain('ai-support-agent-mbc-mbc-01.service')
      expect(unitCalls[1][0]).toContain('ai-support-agent-mbc-mbc-02.service')
    })

    it('should log success for each project', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.install({})

      expect(logger.success).toHaveBeenCalledTimes(2)
    })

    it('should log multi hint and log rotation notice', () => {
      mockedFs.existsSync.mockReturnValue(true)

      strategy.install({})

      expect(logger.info).toHaveBeenCalledWith('service.loadHintMulti')
      expect(logger.info).toHaveBeenCalledWith('service.noLogRotation')
    })

    it('should create missing directories', () => {
      mockedFs.existsSync.mockReturnValue(false)

      strategy.install({})

      expect(mockedFs.mkdirSync).toHaveBeenCalled()
    })

    it('should daemon-reload and enable each unit so it auto-starts at next login', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.install({})

      expect(mockedExecSync).toHaveBeenCalledWith(
        'systemctl --user daemon-reload',
        { stdio: 'pipe' },
      )
      for (const project of mockProjects) {
        const unitFile = `ai-support-agent-${project.tenantCode}-${project.projectCode.toLowerCase().replace(/_/g, '-')}.service`
        expect(mockedExecSync).toHaveBeenCalledWith(
          `systemctl --user enable "${unitFile}"`,
          { stdio: 'pipe' },
        )
      }
    })

    it('should warn but continue when enable fails (linger not configured)', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('enable')) {
          throw new Error('Failed to connect to bus')
        }
        return Buffer.from('')
      })

      strategy.install({})

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('service.enableFailed'),
      )
      // install still reports success per project even with enable warnings
      expect(logger.success).toHaveBeenCalledTimes(2)
    })

    it('should warn when daemon-reload fails during install', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('daemon-reload')) {
          throw new Error('reload failed')
        }
        return Buffer.from('')
      })

      strategy.install({})

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('service.daemonReloadFailed'),
      )
    })

    it('should disable and remove orphaned units for projects no longer in config', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      // Config has mbc-01 and mbc-02 (from mockProjects). Filesystem also
      // has an orphan mbc-99 that was registered previously and then removed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([
        'ai-support-agent-mbc-mbc-01.service',
        'ai-support-agent-mbc-mbc-02.service',
        'ai-support-agent-mbc-mbc-99.service',
      ] as any)

      strategy.install({})

      // The orphan must be disabled and its unit file removed.
      expect(mockedExecSync).toHaveBeenCalledWith(
        'systemctl --user disable --now "ai-support-agent-mbc-mbc-99.service"',
        { stdio: 'pipe' },
      )
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('ai-support-agent-mbc-mbc-99.service'),
      )
      // Live units are NOT removed.
      expect(mockedFs.unlinkSync).not.toHaveBeenCalledWith(
        expect.stringContaining('ai-support-agent-mbc-mbc-01.service'),
      )
    })

    it('should warn but continue when orphan removal unlink fails', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([
        'ai-support-agent-mbc-mbc-01.service',
        'ai-support-agent-mbc-mbc-02.service',
        'ai-support-agent-mbc-mbc-99.service',
      ] as any)
      mockedFs.unlinkSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.includes('mbc-99')) {
          throw new Error('EACCES')
        }
      })

      strategy.install({})

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('service.orphanUnitRemoveFailed'),
      )
    })

    it('should not abort the install loop when one project has an invalid projectCode', () => {
      // Regression: a single bad project (`X;Y` is rejected by
      // assertProjectCodeIsSafe) used to throw out of the loop and skip
      // every subsequent project. Now we log and continue.
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'X;Y', token: 't2', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC_03', token: 't3', apiUrl: 'https://api' },
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([] as any)

      strategy.install({})

      // Error logged for the bad project, but valid projects still got
      // their unit files written.
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectInstallFailed'),
      )
      const unitCalls = mockedFs.writeFileSync.mock.calls.filter(
        (call) => String(call[0]).endsWith('.service'),
      )
      expect(unitCalls).toHaveLength(2)
      expect(unitCalls[0][0]).toContain('mbc-mbc-01.service')
      expect(unitCalls[1][0]).toContain('mbc-mbc-03.service')
    })

    it('should SKIP orphan cleanup when any project install fails (avoid destructive deregistration)', () => {
      // Regression: previously, if validation rejected one project and
      // pre-existing units for that project (or, worse, a sibling whose
      // sanitized name collides) were on disk, the orphan loop would
      // disable --now and unlink them. A typo in one project's code
      // should not silently kill a different project's running unit.
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'X;Y', token: 't2', apiUrl: 'https://api' },
      ])
      // The filesystem has a pre-existing unit for some old project the
      // user removed. Without the skip, this would normally be cleaned up.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([
        'ai-support-agent-mbc-mbc-old.service',
      ] as any)

      strategy.install({})

      // Orphan cleanup must be skipped (no systemctl disable --now, no unlink).
      const disableCalls = (mockedExecSync as jest.Mock).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('disable --now'),
      )
      expect(disableCalls).toHaveLength(0)
      expect(mockedFs.unlinkSync).not.toHaveBeenCalled()
    })

    it('control: SHOULD run orphan cleanup when all projects install successfully (catches a refactor that drops cleanup entirely)', () => {
      // Sanity check that the SKIP test above is meaningful: with the same
      // filesystem setup (orphan unit on disk) but ALL projects valid,
      // orphan cleanup MUST fire — otherwise the SKIP-on-failure test
      // could pass vacuously if cleanup were dropped from both paths.
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([
        'ai-support-agent-mbc-mbc-01.service',   // expected, will not be cleaned
        'ai-support-agent-mbc-mbc-old.service',  // orphan, MUST be cleaned
      ] as any)

      strategy.install({})

      // Orphan cleanup must fire for the legacy unit.
      const disableOldCalls = (mockedExecSync as jest.Mock).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('mbc-old'),
      )
      expect(disableOldCalls.length).toBeGreaterThan(0)
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('ai-support-agent-mbc-mbc-old.service'),
      )
    })

    it('should refuse to install when two projects sanitize to the same unit name', () => {
      // sanitize() collapses `_` and `-` (and other non-[a-z0-9-] chars) to
      // `-`, so `MBC_01` and `MBC-01` both produce `ai-support-agent-mbc-mbc-01`.
      // Without collision detection the second project's writeProjectServiceFiles
      // silently overwrites the first.
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC-01', token: 't2', apiUrl: 'https://api' },
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([] as any)

      strategy.install({})

      // Both colliding projects must be refused with the collision error.
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectUnitNameCollision'),
      )
      // No unit file should have been written for the colliding pair.
      const unitCalls = mockedFs.writeFileSync.mock.calls.filter(
        (call) => String(call[0]).endsWith('.service'),
      )
      expect(unitCalls).toHaveLength(0)
    })

    it('should NOT deny-install a valid project whose sanitized name "collides" only with an invalid sibling', () => {
      // Regression: collision detection used to count EVERY sanitized
      // unit name including those of codes that would be rejected by
      // assertProjectCodeIsSafe. So `MBC;01` (invalid) + `MBC-01` (valid)
      // both sanitize to `mbc-01`, falsely marking MBC-01 as colliding
      // and denying its install. Now we only count installable codes.
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC;01', token: 't1', apiUrl: 'https://api' },  // invalid
        { tenantCode: 'mbc', projectCode: 'MBC-01', token: 't2', apiUrl: 'https://api' },  // valid
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([] as any)

      strategy.install({})

      // MBC;01 was refused by assertProjectCodeIsSafe (invalidProjectCode),
      // NOT by the collision detection.
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectInstallFailed'),
      )
      // The valid sibling MBC-01 must still be written.
      const unitCalls = mockedFs.writeFileSync.mock.calls.filter(
        (call) => String(call[0]).endsWith('.service'),
      )
      expect(unitCalls).toHaveLength(1)
      expect(unitCalls[0][0]).toContain('mbc-mbc-01.service')
      // No collision error should fire — the only failure was the invalid code.
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('service.projectUnitNameCollision'),
      )
    })

    it('should use projectDuplicateEntry message when the same tenant/project pair appears twice', () => {
      // True literal duplicate: same tenantCode AND projectCode listed twice.
      // The `others` filter (excluding self FQN) returns []; the error
      // message must NOT render an empty `()` parenthetical via the
      // generic collision template — use the dedicated duplicate-entry key.
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't2', apiUrl: 'https://api' },
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([] as any)

      strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectDuplicateEntry'),
      )
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringContaining('service.projectUnitNameCollision'),
      )
    })

    it('should emit BOTH duplicate and collision hints when a config has duplicates AND a sanitize-colliding sibling', () => {
      // Regression for AA1 + BB1: when config has `[MBC_01, MBC_01, MBC-01]`,
      // the user needs to know about TWO problems: the duplicate row
      // (cheap fix: remove it) and the sanitize-collision sibling (rename
      // one of the codes). Both messages must fire, regardless of which
      // config row appears first.
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't2', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC-01', token: 't3', apiUrl: 'https://api' },
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([] as any)

      strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectDuplicateEntry'),
      )
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectUnitNameCollision'),
      )
    })

    it('should emit BOTH hints even when the sanitize-colliding sibling appears FIRST in config (order-independent)', () => {
      // BB1: previously the dedup keyed on unit-name only, so config row
      // order decided which hint fired. With (name, messageKey) dedup
      // both still surface regardless of order.
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC-01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't2', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't3', apiUrl: 'https://api' },
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([] as any)

      strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectDuplicateEntry'),
      )
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectUnitNameCollision'),
      )
    })

    it('should log a partialInstallSummary warning when at least one project fails', () => {
      // Sanity: when ANY project install fails, a single summary line at
      // the end tells operators not to trust the surrounding success logs.
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'X;Y', token: 't2', apiUrl: 'https://api' },
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([] as any)

      strategy.install({})

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('service.partialInstallSummary'),
      )
    })

    it('should NOT log partialInstallSummary when all projects install successfully', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([] as any)

      strategy.install({})

      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('service.partialInstallSummary'),
      )
    })

    it('should suppress the start hint and log lines when ALL projects fail (no units written)', () => {
      // Z1 regression: if every project is refused, the post-loop info
      // hints (loadHintMulti / logDir / noLogRotation) used to fire and
      // tell the user to start services that do not exist. Skip them.
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'X;Y', token: 't1', apiUrl: 'https://api' },
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([] as any)

      strategy.install({})

      expect(logger.info).not.toHaveBeenCalledWith('service.loadHintMulti')
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('service.logDir'),
      )
      expect(logger.info).not.toHaveBeenCalledWith('service.noLogRotation')
    })

    it('should report only ONE collision error per shared unit name even when listed many times', () => {
      // Z5 regression: an N-times-listed entry used to emit N identical
      // error lines. The reportedCollisionNames Set in install() now
      // deduplicates them.
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't2', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't3', apiUrl: 'https://api' },
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([] as any)

      strategy.install({})

      const dupCalls = (logger.error as jest.Mock).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string'
          && (call[0] as string).includes('service.projectDuplicateEntry'),
      )
      expect(dupCalls).toHaveLength(1)
    })

    it('should include failed/total/succeeded counts in the partialInstallSummary message', () => {
      // Z4: partialInstallSummary now templates `{{failed}} of {{total}} ... {{succeeded}}`
      // so a wrapping script / operator can tell the failure ratio at a glance.
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'mbc', projectCode: 'MBC_01', token: 't1', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'X;Y', token: 't2', apiUrl: 'https://api' },
        { tenantCode: 'mbc', projectCode: 'MBC_03', token: 't3', apiUrl: 'https://api' },
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([] as any)

      const tMod = jest.requireMock('../../../src/i18n') as { t: jest.Mock }
      const tSpy = jest.spyOn(tMod, 't')

      strategy.install({})

      expect(tSpy).toHaveBeenCalledWith('service.partialInstallSummary', expect.objectContaining({
        failed: '1',
        total: '3',
        succeeded: '2',
      }))
      tSpy.mockRestore()
    })
  })

  describe('uninstall', () => {
    it('should disable and delete all per-project units', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.uninstall()

      for (const { unitName, unitPath } of mockProjectUnits) {
        expect(mockedExecSync).toHaveBeenCalledWith(
          `systemctl --user disable --now "${unitName}.service"`,
          { stdio: 'pipe' },
        )
        expect(mockedFs.unlinkSync).toHaveBeenCalledWith(unitPath)
      }
      expect(logger.success).toHaveBeenCalledWith('service.uninstalled')
    })

    it('should tolerate disable failures', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockImplementation(() => { throw new Error('not loaded') })

      strategy.uninstall()

      // unlinkSync should still be called
      expect(mockedFs.unlinkSync).toHaveBeenCalled()
      expect(logger.success).toHaveBeenCalledWith('service.uninstalled')
    })
  })

  describe('start', () => {
    it('should start all per-project units', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.start()

      expect(mockedExecSync).toHaveBeenCalledWith(
        'systemctl --user daemon-reload',
        { stdio: 'pipe' },
      )
      for (const { unitName } of mockProjectUnits) {
        expect(mockedExecSync).toHaveBeenCalledWith(
          `systemctl --user start "${unitName}.service"`,
          { stdio: 'pipe' },
        )
      }
      expect(logger.success).toHaveBeenCalledWith('service.started')
    })

    it('should tolerate daemon-reload failure', () => {
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('daemon-reload')) {
          throw new Error('reload failed')
        }
        return Buffer.from('')
      })

      strategy.start()

      expect(logger.success).toHaveBeenCalledWith('service.started')
    })

    it('should log error and not log success if any start fails', () => {
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('mbc-02')) {
          throw new Error('start failed')
        }
        return Buffer.from('')
      })

      strategy.start()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unitStartFailed'),
      )
      expect(logger.success).not.toHaveBeenCalled()
    })

    it('should pass the failing unit name to the i18n message for start failures', () => {
      // Capture t() invocations to ensure operator gets unit context.
      const tMod = jest.requireMock('../../../src/i18n') as { t: jest.Mock }
      const tSpy = jest.spyOn(tMod, 't')
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('mbc-02')) {
          throw new Error('start failed')
        }
        return Buffer.from('')
      })

      strategy.start()

      expect(tSpy).toHaveBeenCalledWith('service.unitStartFailed', expect.objectContaining({
        unit: 'ai-support-agent-mbc-mbc-02.service',
        message: expect.stringContaining('start failed'),
      }))
      tSpy.mockRestore()
    })

    it('should handle non-Error throw from start', () => {
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('mbc-01')) {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'string start error'
        }
        return Buffer.from('')
      })

      strategy.start()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unitStartFailed'),
      )
    })
  })

  describe('stop', () => {
    it('should stop all per-project units', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.stop()

      for (const { unitName } of mockProjectUnits) {
        expect(mockedExecSync).toHaveBeenCalledWith(
          `systemctl --user stop "${unitName}.service"`,
          { stdio: 'pipe' },
        )
      }
      expect(logger.success).toHaveBeenCalledWith('service.stopped')
    })

    it('should log error and not log success if any stop fails', () => {
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('mbc-02')) {
          throw new Error('stop failed')
        }
        return Buffer.from('')
      })

      strategy.stop()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unitStopFailed'),
      )
      expect(logger.success).not.toHaveBeenCalled()
    })

    it('should handle non-Error throw from stop', () => {
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('mbc-01')) {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'string stop error'
        }
        return Buffer.from('')
      })

      strategy.stop()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unitStopFailed'),
      )
    })
  })

  describe('restart', () => {
    it('should restart all per-project units', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.restart()

      expect(mockedExecSync).toHaveBeenCalledWith(
        'systemctl --user daemon-reload',
        { stdio: 'pipe' },
      )
      for (const { unitName } of mockProjectUnits) {
        expect(mockedExecSync).toHaveBeenCalledWith(
          `systemctl --user restart "${unitName}.service"`,
          { stdio: 'pipe' },
        )
      }
      expect(logger.success).toHaveBeenCalledWith('service.restarted')
    })

    it('should tolerate daemon-reload failure', () => {
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('daemon-reload')) {
          throw new Error('reload failed')
        }
        return Buffer.from('')
      })

      strategy.restart()

      expect(logger.success).toHaveBeenCalledWith('service.restarted')
    })

    it('should log error if any restart fails', () => {
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('restart')) {
          throw new Error('restart failed')
        }
        return Buffer.from('')
      })

      strategy.restart()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unitRestartFailed'),
      )
    })

    it('should handle non-Error throw from restart', () => {
      mockedExecSync.mockImplementation((cmd: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('restart')) {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'string restart error'
        }
        return Buffer.from('')
      })

      strategy.restart()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.unitRestartFailed'),
      )
    })
  })

  describe('status', () => {
    it('should return running=true and PID when any unit is active', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from('ActiveState=active\nMainPID=1234\n'))
        .mockReturnValueOnce(Buffer.from('ActiveState=inactive\nMainPID=0\n'))

      const result = strategy.status()

      expect(result.installed).toBe(true)
      expect(result.running).toBe(true)
      expect(result.pid).toBe(1234)
      expect(result.projects).toHaveLength(2)
      expect(result.projects![0].running).toBe(true)
      expect(result.projects![0].pid).toBe(1234)
      expect(result.projects![1].running).toBe(false)
    })

    it('should return running=false when no unit is active', () => {
      mockedExecSync.mockReturnValue(Buffer.from('ActiveState=inactive\nMainPID=0\n'))

      const result = strategy.status()

      expect(result.installed).toBe(true)
      expect(result.running).toBe(false)
      expect(result.projects?.every(p => !p.running)).toBe(true)
    })

    it('should handle systemctl failure for an individual unit', () => {
      mockedExecSync.mockImplementation(() => { throw new Error('not loaded') })

      const result = strategy.status()

      expect(result.installed).toBe(true)
      expect(result.running).toBe(false)
      expect(result.projects?.every(p => !p.running)).toBe(true)
    })

    it('should return logDir', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      const result = strategy.status()

      expect(result.logDir).toBeTruthy()
      expect(result.logDir).toContain('ai-support-agent')
    })

    it('should derive projectCode from loaded config (not by splitting the unit name)', () => {
      mockedExecSync.mockReturnValue(Buffer.from('ActiveState=inactive\nMainPID=0\n'))

      const result = strategy.status()

      // Canonical projectCode comes from getProjectList(), not from
      // reverse-parsing the sanitized unit name (which is lossy when the
      // tenant/project codes contain '_' or other collapsed characters).
      expect(result.projects?.[0].projectCode).toBe('MBC_01')
      expect(result.projects?.[1].projectCode).toBe('MBC_02')
    })

    it('should preserve projectCode for tenants whose sanitized name contains a hyphen', () => {
      mockedGetProjectList.mockReturnValue([
        { tenantCode: 'my_tenant', projectCode: 'MBC_01', token: 'tok', apiUrl: 'https://api' },
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([
        'ai-support-agent-my-tenant-mbc-01.service',
      ] as any)
      mockedExecSync.mockReturnValue(Buffer.from('ActiveState=inactive\nMainPID=0\n'))

      const result = strategy.status()

      // A first-dash split would yield 'TENANT_MBC_01'; via config lookup we get the real code.
      expect(result.projects).toHaveLength(1)
      expect(result.projects?.[0].projectCode).toBe('MBC_01')
    })

    it('should fall back to the unit name (prefix stripped) for orphaned units no longer in config', () => {
      mockedGetProjectList.mockReturnValue([]) // config has no projects
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockedFs.readdirSync.mockReturnValue([
        'ai-support-agent-mbc-mbc-99.service',
      ] as any)
      mockedExecSync.mockReturnValue(Buffer.from('ActiveState=inactive\nMainPID=0\n'))

      const result = strategy.status()

      // Brand prefix removed so users see something close to tenant-project
      expect(result.projects?.[0].projectCode).toBe('mbc-mbc-99')
    })

    it('should treat active state without MainPID as running', () => {
      mockedExecSync.mockReturnValue(Buffer.from('ActiveState=active\n'))

      const result = strategy.status()

      expect(result.installed).toBe(true)
      expect(result.running).toBe(true)
      expect(result.projects?.[0].pid).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// writeProjectServiceFiles
// ---------------------------------------------------------------------------
describe('writeProjectServiceFiles', () => {
  const project = {
    tenantCode: '00000005',
    projectCode: 'QUOTEMATE',
    token: '00000005:uuid:secret',
    apiUrl: 'https://api.ai-support-agent.com',
  }

  beforeEach(() => {
    mockedFs.existsSync.mockReturnValue(false)
    mockedFs.mkdirSync.mockReturnValue(undefined)
    mockedFs.writeFileSync.mockReturnValue(undefined)
  })

  it('should create service dirs, write run.sh and unit, return unit path', () => {
    const unitPath = writeProjectServiceFiles(project)

    expect(unitPath).toContain('ai-support-agent-00000005-quotemate.service')
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('run.sh'),
      expect.any(String),
      expect.objectContaining({ mode: 0o700 }),
    )
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.service'),
      expect.any(String),
      'utf-8',
    )
  })

  it('should embed the token and apiUrl in the wrapper script', () => {
    writeProjectServiceFiles(project)

    const runShCall = mockedFs.writeFileSync.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('run.sh'),
    )
    expect(runShCall).toBeDefined()
    const script = runShCall![1] as string
    expect(script).toContain(project.token)
    expect(script).toContain(project.apiUrl)
  })

  it('should chmod 0o700 on the wrapper script to enforce mode on overwrite', () => {
    // fs.writeFileSync({ mode }) only applies on file CREATION. To guarantee
    // 0o700 on an existing (possibly world-readable) wrapper, we follow up
    // with an explicit chmod.
    writeProjectServiceFiles(project)

    expect(mockedFs.chmodSync).toHaveBeenCalledWith(
      expect.stringContaining('run.sh'),
      0o700,
    )
  })

  it('should reject projectCodes that would break PROJECT_DIR_MAP parsing', () => {
    // ';' is the multi-entry separator; '=' is the key/value separator.
    // Either one in the projectCode would silently truncate the env map
    // and silently re-introduce the doubly-nested layout this PR fixes.
    expect(() => writeProjectServiceFiles({ ...project, projectCode: 'A;B' })).toThrow(
      /service\.invalidProjectCode/,
    )
    expect(() => writeProjectServiceFiles({ ...project, projectCode: 'A=B' })).toThrow(
      /service\.invalidProjectCode/,
    )
  })

  it('should reject tenantCodes containing PROJECT_DIR_MAP separators', () => {
    expect(() => writeProjectServiceFiles({ ...project, tenantCode: 't;x' })).toThrow(
      /service\.invalidProjectCode/,
    )
  })

  it('should drop project.projectDir when the host path does not exist and fall back to default', () => {
    // existsSync mocked false → validation drops projectDir → wrapper falls
    // back to default mount. Without this guard the wrapper would emit a
    // `-v <missing-path>:/workspace/projects/<code>:rw` line which docker
    // auto-creates as root-owned and then the --user invocation can't
    // write into it (the exact failure mode from commit 11cbed1).
    mockedFs.existsSync.mockReturnValue(false)

    writeProjectServiceFiles({ ...project, projectDir: '/nonexistent/path' })

    const runShCall = mockedFs.writeFileSync.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('run.sh'),
    )
    const script = runShCall![1] as string
    expect(script).not.toContain('/nonexistent/path')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('service.projectDirMissing'),
    )
  })
})

// ---------------------------------------------------------------------------
// installAndStartProject
// ---------------------------------------------------------------------------
describe('installAndStartProject', () => {
  const project = {
    tenantCode: '00000005',
    projectCode: 'QUOTEMATE',
    token: '00000005:uuid:secret',
    apiUrl: 'https://api.ai-support-agent.com',
  }

  beforeEach(() => {
    mockedFs.existsSync.mockReturnValue(false)
    mockedFs.mkdirSync.mockReturnValue(undefined)
    mockedFs.writeFileSync.mockReturnValue(undefined)
    mockedExecSync.mockReturnValue(Buffer.from('active'))
  })

  it('should run daemon-reload before starting', () => {
    installAndStartProject(project)

    const reloadCall = (mockedExecSync as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('daemon-reload'),
    )
    expect(reloadCall).toBeDefined()
  })

  it('should stop existing service before starting (idempotent)', () => {
    installAndStartProject(project)

    const stopCall = (mockedExecSync as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('systemctl --user stop'),
    )
    expect(stopCall).toBeDefined()
    expect(stopCall![0]).toBe('systemctl --user stop "ai-support-agent-00000005-quotemate.service"')
  })

  it('should enable and start the service', () => {
    installAndStartProject(project)

    const enableCall = (mockedExecSync as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('systemctl --user enable'),
    )
    expect(enableCall).toBeDefined()

    const startCall = (mockedExecSync as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('systemctl --user start'),
    )
    expect(startCall).toBeDefined()
    expect(startCall![0]).toContain('ai-support-agent-00000005-quotemate.service')
  })

  it('should verify the service is active', () => {
    installAndStartProject(project)

    const isActiveCall = (mockedExecSync as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('is-active'),
    )
    expect(isActiveCall).toBeDefined()
  })

  it('should not throw when systemctl stop fails (service not loaded)', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('systemctl --user stop')) {
        throw new Error('not loaded')
      }
      return Buffer.from('active')
    })

    expect(() => installAndStartProject(project)).not.toThrow()
  })

  it('should warn but not throw when systemctl enable fails', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('systemctl --user enable')) {
        throw new Error('Failed to connect to bus')
      }
      return Buffer.from('active')
    })

    expect(() => installAndStartProject(project)).not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('service.enableFailed'),
    )
  })

  it('should warn and return when daemon-reload fails', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('daemon-reload')) {
        throw new Error('reload failed')
      }
      return Buffer.from('active')
    })

    installAndStartProject(project)

    // Uses the same i18n key as LinuxServiceStrategy.install() for the same
    // root cause, so support logs can correlate.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('service.daemonReloadFailed'),
    )
    // Should not proceed to start
    const startCall = (mockedExecSync as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('systemctl --user start'),
    )
    expect(startCall).toBeUndefined()
  })

  it('should warn when systemctl start fails', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('systemctl --user start')) {
        throw new Error('start failed')
      }
      return Buffer.from('active')
    })

    installAndStartProject(project)

    expect(logger.warn).toHaveBeenCalled()
    // Should not call is-active after start failure
    const isActiveCall = (mockedExecSync as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('is-active'),
    )
    expect(isActiveCall).toBeUndefined()
  })

  it('should warn when is-active returns non-active', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('is-active')) {
        return Buffer.from('failed')
      }
      return Buffer.from('')
    })

    installAndStartProject(project)

    expect(logger.warn).toHaveBeenCalled()
  })

  it('should warn when is-active throws', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('is-active')) {
        throw new Error('inactive')
      }
      return Buffer.from('')
    })

    installAndStartProject(project)

    expect(logger.warn).toHaveBeenCalled()
  })

  it('should handle non-Error throw from daemon-reload', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('daemon-reload')) {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string error'
      }
      return Buffer.from('active')
    })

    installAndStartProject(project)

    expect(logger.warn).toHaveBeenCalled()
  })

  it('should handle non-Error throw from systemctl start', () => {
    mockedExecSync.mockImplementation((cmd: unknown) => {
      if (typeof cmd === 'string' && cmd.includes('systemctl --user start')) {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string error'
      }
      return Buffer.from('active')
    })

    installAndStartProject(project)

    expect(logger.warn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// detectSystemSystemdUnits — stray /etc/systemd/system unit detection
// ---------------------------------------------------------------------------
describe('detectSystemSystemdUnits', () => {
  it('returns matching unit files under /etc/systemd/system', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockImplementation(((dir: any) => {
      if (dir === '/etc/systemd/system') {
        return [
          'ai-support-agent.service',
          'ai-support-agent-foo-bar.service',
          'unrelated.service',
          'ai-support-agent-readme.txt',
        ] as unknown as fs.Dirent[]
      }
      return [] as unknown as fs.Dirent[]
    }) as typeof fs.readdirSync)

    const units = detectSystemSystemdUnits()

    expect(units).toEqual([
      '/etc/systemd/system/ai-support-agent.service',
      '/etc/systemd/system/ai-support-agent-foo-bar.service',
    ])
  })

  it('returns an empty list when the directory cannot be read', () => {
    mockedFs.readdirSync.mockImplementation(() => {
      throw new Error('EACCES')
    })

    expect(detectSystemSystemdUnits()).toEqual([])
  })

  it('returns an empty list when no matching files exist', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue(['cron.service', 'sshd.service'] as any)

    expect(detectSystemSystemdUnits()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// LinuxServiceStrategy.status — warns on stray system-scope units
// ---------------------------------------------------------------------------
describe('LinuxServiceStrategy.status — stray system unit warning', () => {
  it('emits a warning when a stray system-scope unit is detected', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockImplementation(((dir: any) => {
      if (dir === '/etc/systemd/system') {
        return ['ai-support-agent.service'] as unknown as fs.Dirent[]
      }
      // user systemd dir → no project units
      return [] as unknown as fs.Dirent[]
    }) as typeof fs.readdirSync)

    const strategy = new LinuxServiceStrategy()
    const result = strategy.status()

    expect(result).toEqual({ installed: false, running: false })
    // The i18n mock returns the bare translation key without interpolation,
    // so we assert on the key rather than the rendered message.
    expect(logger.warn).toHaveBeenCalledWith('service.systemUnitDetected')
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('emits one warning per stray unit when multiple exist', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockImplementation(((dir: any) => {
      if (dir === '/etc/systemd/system') {
        return [
          'ai-support-agent.service',
          'ai-support-agent-foo.service',
        ] as unknown as fs.Dirent[]
      }
      return [] as unknown as fs.Dirent[]
    }) as typeof fs.readdirSync)

    const strategy = new LinuxServiceStrategy()
    strategy.status()

    expect(logger.warn).toHaveBeenCalledTimes(2)
  })

  it('does not warn when no stray system-scope unit exists', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdirSync.mockReturnValue([] as any)

    const strategy = new LinuxServiceStrategy()
    strategy.status()

    expect(logger.warn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// re-exported path utilities
// ---------------------------------------------------------------------------
describe('re-exported path utilities', () => {
  it('getNodePath returns the current Node.js executable', () => {
    expect(getNodePath()).toBe(process.execPath)
  })

  it('getCliEntryPoint returns an absolute path ending with index.js', () => {
    const result = getCliEntryPoint()
    expect(result.endsWith('index.js')).toBe(true)
  })
})
