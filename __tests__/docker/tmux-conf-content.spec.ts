/**
 * Static analysis tests for the bundled tmux status-bar config.
 *
 * Reads the actual committed docker/tmux.conf (no fs mocking) to verify the
 * status bar renders session identity instead of the container hostname,
 * which is a random, meaningless container ID rather than a useful label.
 */

import * as fs from 'fs'
import * as path from 'path'

const TMUX_CONF = path.resolve(__dirname, '../../docker/tmux.conf')
const DOCKERFILE = path.resolve(__dirname, '../../docker/Dockerfile')

describe('docker/tmux.conf content validation', () => {
  let content: string

  beforeAll(() => {
    content = fs.readFileSync(TMUX_CONF, 'utf-8')
  })

  it('enables the status bar at the bottom', () => {
    expect(content).toMatch(/set -g status on\b/)
    expect(content).toMatch(/set -g status-position bottom\b/)
  })

  it('shows the tmux session name (#S) on the status-left segment', () => {
    expect(content).toMatch(/status-left\s+'[^']*#S/)
  })

  it('does NOT use #h (container hostname is a meaningless random ID, not the tmux session)', () => {
    expect(content).not.toMatch(/#h\b/)
  })

  it('shows the current date and time on the status-right segment', () => {
    expect(content).toMatch(/status-right\s+'[^']*%Y-%m-%d[^']*%H:%M/)
  })

  it('highlights the active window differently from inactive windows', () => {
    expect(content).toMatch(/window-status-current-format\s+'/)
    expect(content).toMatch(/window-status-format\s+'/)
  })
})

describe('Dockerfile bundles the tmux status-bar config', () => {
  let dockerfileContent: string

  beforeAll(() => {
    dockerfileContent = fs.readFileSync(DOCKERFILE, 'utf-8')
  })

  it('copies docker/tmux.conf to /etc/tmux.conf so it applies to every session regardless of the runtime UID', () => {
    expect(dockerfileContent).toMatch(/COPY docker\/tmux\.conf \/etc\/tmux\.conf\b/)
  })
})
