import {
  executeCommand,
  executeShellCommand,
  fileRead,
  fileWrite,
  fileList,
  fileRename,
  fileDelete,
  fileMkdir,
  processList,
  processKill,
} from '../../src/commands'
import { _getRunningProcesses } from '../../src/commands/chat-executor'
import { _getRunningApiChats } from '../../src/commands/api-chat-executor'
import type { CommandDispatch } from '../../src/types'

jest.mock('../../src/logger')

describe('commands/dispatch', () => {
  describe('CommandDispatch overload', () => {
    it('should dispatch execute_command via CommandDispatch', async () => {
      const dispatch: CommandDispatch = {
        type: 'execute_command',
        payload: { command: 'echo dispatch-test' },
      }
      const result = await executeCommand(dispatch)
      expect(result.success).toBe(true)
      expect((result.data as string).trim()).toBe('dispatch-test')
    })

    it('should dispatch process_list via CommandDispatch', async () => {
      const dispatch: CommandDispatch = {
        type: 'process_list',
        payload: {} as Record<string, never>,
      }
      const result = await executeCommand(dispatch)
      expect(result.success).toBe(true)
    })

    it('should handle unknown command type via loose signature', async () => {
      const result = await executeCommand('nonexistent_type' as any, {})
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Unknown command type')
      }
    })

    it('should return error for chat command without commandId and client', async () => {
      const result = await executeCommand('chat' as any, { message: 'hello' })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('chat command requires commandId and client')
      }
    })

    it('should return error for chat command with commandId but no client', async () => {
      const result = await executeCommand('chat' as any, { message: 'hello' }, { commandId: 'cmd-1' })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('chat command requires commandId and client')
      }
    })

    it('should dispatch setup command with onSetup callback', async () => {
      const onSetup = jest.fn().mockResolvedValue(undefined)
      const result = await executeCommand('setup', {}, { onSetup })
      expect(result.success).toBe(true)
      expect(onSetup).toHaveBeenCalled()
    })

    it('should return error for setup command without onSetup callback', async () => {
      const result = await executeCommand('setup', {})
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('setup command requires onSetup callback')
      }
    })

    it('should dispatch config_sync command with onConfigSync callback', async () => {
      const onConfigSync = jest.fn().mockResolvedValue(undefined)
      const result = await executeCommand('config_sync', {}, { onConfigSync })
      expect(result.success).toBe(true)
      expect(onConfigSync).toHaveBeenCalled()
    })

    it('should return error for config_sync command without onConfigSync callback', async () => {
      const result = await executeCommand('config_sync', {})
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('config_sync command requires onConfigSync callback')
      }
    })

    it('should dispatch setup via CommandDispatch', async () => {
      const onSetup = jest.fn().mockResolvedValue(undefined)
      const dispatch: CommandDispatch = { type: 'setup', payload: {} as Record<string, never> }
      const result = await executeCommand(dispatch, { onSetup })
      expect(result.success).toBe(true)
      expect(onSetup).toHaveBeenCalled()
    })

    it('should dispatch config_sync via CommandDispatch', async () => {
      const onConfigSync = jest.fn().mockResolvedValue(undefined)
      const dispatch: CommandDispatch = { type: 'config_sync', payload: {} as Record<string, never> }
      const result = await executeCommand(dispatch, { onConfigSync })
      expect(result.success).toBe(true)
      expect(onConfigSync).toHaveBeenCalled()
    })

    it('should dispatch file_rename command', async () => {
      // file_rename requires valid paths; missing path returns error
      const result = await executeCommand('file_rename', { oldPath: '', newPath: '' })
      expect(result.success).toBe(false)
    })

    it('should dispatch file_delete command', async () => {
      const result = await executeCommand('file_delete', { path: '/nonexistent/path/to/delete' })
      expect(result.success).toBe(false)
    })

    it('should dispatch file_mkdir command', async () => {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-'))
      const newDir = path.join(tmpDir, 'subdir')
      const result = await executeCommand('file_mkdir', { path: newDir })
      expect(result.success).toBe(true)
      expect(fs.existsSync(newDir)).toBe(true)
      fs.rmSync(tmpDir, { recursive: true })
    })

    it('should dispatch file_rename via CommandDispatch', async () => {
      const dispatch: CommandDispatch = {
        type: 'file_rename',
        payload: { oldPath: '', newPath: '' },
      }
      const result = await executeCommand(dispatch)
      expect(result.success).toBe(false)
    })

    it('should dispatch file_delete via CommandDispatch', async () => {
      const dispatch: CommandDispatch = {
        type: 'file_delete',
        payload: { path: '/nonexistent' },
      }
      const result = await executeCommand(dispatch)
      expect(result.success).toBe(false)
    })

    it('should dispatch file_mkdir via CommandDispatch', async () => {
      const os = await import('os')
      const fs = await import('fs')
      const path = await import('path')
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test2-'))
      const newDir = path.join(tmpDir, 'sub')
      const dispatch: CommandDispatch = {
        type: 'file_mkdir',
        payload: { path: newDir },
      }
      const result = await executeCommand(dispatch)
      expect(result.success).toBe(true)
      fs.rmSync(tmpDir, { recursive: true })
    })
  })

  describe('chat_cancel dispatch', () => {
    afterEach(() => {
      // Cleanup any leftover entries
      _getRunningProcesses().clear()
      _getRunningApiChats().clear()
    })

    it('should return error when targetCommandId is not a string', async () => {
      const result = await executeCommand('chat_cancel' as any, { targetCommandId: 123 })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('targetCommandId is required')
      }
    })

    it('should return error when targetCommandId is not provided', async () => {
      const result = await executeCommand('chat_cancel' as any, {})
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('targetCommandId is required')
      }
    })

    it('should return cancelled=true when cancelChatProcess succeeds', async () => {
      const cancelFn = jest.fn()
      _getRunningProcesses().set('target-cmd', { cancel: cancelFn })

      const result = await executeCommand('chat_cancel' as any, { targetCommandId: 'target-cmd' })
      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data as { cancelled: boolean; targetCommandId: string }
        expect(data.cancelled).toBe(true)
        expect(data.targetCommandId).toBe('target-cmd')
      }
      expect(cancelFn).toHaveBeenCalled()
    })

    it('should return cancelled=true when cancelApiChatProcess succeeds (after cancelChatProcess fails)', async () => {
      const cancelFn = jest.fn()
      _getRunningApiChats().set('api-target-cmd', { cancel: cancelFn })

      const result = await executeCommand('chat_cancel' as any, { targetCommandId: 'api-target-cmd' })
      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data as { cancelled: boolean; targetCommandId: string }
        expect(data.cancelled).toBe(true)
        expect(data.targetCommandId).toBe('api-target-cmd')
      }
      expect(cancelFn).toHaveBeenCalled()
    })

    it('should return cancelled=false when both cancel methods fail', async () => {
      const result = await executeCommand('chat_cancel' as any, { targetCommandId: 'unknown-cmd' })
      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data as { cancelled: boolean; targetCommandId: string }
        expect(data.cancelled).toBe(false)
        expect(data.targetCommandId).toBe('unknown-cmd')
      }
    })

    it('should dispatch chat_cancel via CommandDispatch', async () => {
      const dispatch: CommandDispatch = {
        type: 'chat_cancel',
        payload: { targetCommandId: 'no-such-cmd' },
      }
      const result = await executeCommand(dispatch)
      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data as { cancelled: boolean; targetCommandId: string }
        expect(data.cancelled).toBe(false)
      }
    })
  })

  describe('re-exports', () => {
    it('should export executeShellCommand', () => {
      expect(typeof executeShellCommand).toBe('function')
    })

    it('should export fileRead', () => {
      expect(typeof fileRead).toBe('function')
    })

    it('should export fileWrite', () => {
      expect(typeof fileWrite).toBe('function')
    })

    it('should export fileList', () => {
      expect(typeof fileList).toBe('function')
    })

    it('should export fileRename', () => {
      expect(typeof fileRename).toBe('function')
    })

    it('should export fileDelete', () => {
      expect(typeof fileDelete).toBe('function')
    })

    it('should export fileMkdir', () => {
      expect(typeof fileMkdir).toBe('function')
    })

    it('should export processList', () => {
      expect(typeof processList).toBe('function')
    })

    it('should export processKill', () => {
      expect(typeof processKill).toBe('function')
    })
  })
})
