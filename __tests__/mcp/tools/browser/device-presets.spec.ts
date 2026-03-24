import { DEVICE_PRESETS, DeviceEmulation } from '../../../../src/mcp/tools/browser/device-presets'

describe('DEVICE_PRESETS', () => {
  const expectedPresets = ['iphone-se', 'iphone-14', 'iphone-14-pro-max', 'pixel-7', 'ipad-mini']

  it('should contain all expected preset keys', () => {
    for (const key of expectedPresets) {
      expect(DEVICE_PRESETS[key]).toBeDefined()
    }
  })

  it('should have valid properties for each preset', () => {
    for (const [, preset] of Object.entries(DEVICE_PRESETS)) {
      expect(typeof preset.userAgent).toBe('string')
      expect(preset.userAgent.length).toBeGreaterThan(0)
      expect(typeof preset.isMobile).toBe('boolean')
      expect(typeof preset.hasTouch).toBe('boolean')
      expect(typeof preset.deviceScaleFactor).toBe('number')
      expect(preset.deviceScaleFactor).toBeGreaterThan(0)
      // All current presets are mobile devices
      expect(preset.isMobile).toBe(true)
      expect(preset.hasTouch).toBe(true)
    }
  })

  it('should have non-empty userAgent strings', () => {
    for (const preset of Object.values(DEVICE_PRESETS)) {
      expect(preset.userAgent).toBeTruthy()
      expect(preset.userAgent.length).toBeGreaterThan(10)
    }
  })

  it('should have correct deviceScaleFactor values', () => {
    expect(DEVICE_PRESETS['iphone-se'].deviceScaleFactor).toBe(2)
    expect(DEVICE_PRESETS['iphone-14'].deviceScaleFactor).toBe(3)
    expect(DEVICE_PRESETS['iphone-14-pro-max'].deviceScaleFactor).toBe(3)
    expect(DEVICE_PRESETS['pixel-7'].deviceScaleFactor).toBe(2.625)
    expect(DEVICE_PRESETS['ipad-mini'].deviceScaleFactor).toBe(2)
  })

  it('should have iPhone UA for iPhone presets', () => {
    expect(DEVICE_PRESETS['iphone-se'].userAgent).toContain('iPhone')
    expect(DEVICE_PRESETS['iphone-14'].userAgent).toContain('iPhone')
    expect(DEVICE_PRESETS['iphone-14-pro-max'].userAgent).toContain('iPhone')
  })

  it('should have Android UA for Pixel preset', () => {
    expect(DEVICE_PRESETS['pixel-7'].userAgent).toContain('Android')
    expect(DEVICE_PRESETS['pixel-7'].userAgent).toContain('Pixel 7')
  })

  it('should have iPad UA for iPad preset', () => {
    expect(DEVICE_PRESETS['ipad-mini'].userAgent).toContain('iPad')
  })

  it('should satisfy DeviceEmulation interface', () => {
    // Type check — if this compiles, the interface is satisfied
    const preset: DeviceEmulation = DEVICE_PRESETS['iphone-se']
    expect(preset).toBeDefined()
  })
})
