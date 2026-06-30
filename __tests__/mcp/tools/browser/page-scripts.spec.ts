/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit coverage for the browser page-scripts.
 *
 * These functions are serialized by Playwright and run INSIDE the browser, so
 * in production they execute against a real DOM. Here we invoke the REAL
 * exported functions in Node against a hand-built fake DOM (installed on
 * globalThis) so every branch — selector priorities, focus reporting, value
 * setting — is exercised and counted toward coverage.
 */
import {
  CURSOR_AT_POINT_SCRIPT,
  ELEMENT_AT_POINT_SCRIPT,
  FOCUSED_ELEMENT_SCRIPT,
  FOCUS_REPORTING_SCRIPT,
  GET_SELECTED_TEXT_SCRIPT,
  SET_FOCUSED_INPUT_VALUE_SCRIPT,
} from '../../../../src/mcp/tools/browser/page-scripts'

// --- Fake DOM scaffolding ---------------------------------------------------

interface FakeEl {
  tagName: string
  id: string
  attrs: Record<string, string>
  classes: string[]
  textContent: string | null
  parentElement: FakeEl | null
  getAttribute: (n: string) => string | null
  get classList(): string[]
  value?: string
  selectionStart?: number | null
  selectionEnd?: number | null
  maxLength?: number
  getBoundingClientRect?: () => { x: number; y: number; width: number; height: number }
  dispatchEvent?: jest.Mock
  setSelectionRange?: jest.Mock
}

function makeEl(tagName: string, opts: Partial<FakeEl> = {}): FakeEl {
  const attrs = opts.attrs ?? {}
  return {
    tagName,
    id: opts.id ?? '',
    attrs,
    classes: opts.classes ?? [],
    textContent: opts.textContent ?? '',
    parentElement: opts.parentElement ?? null,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    get classList() {
      return this.classes
    },
    value: opts.value,
    selectionStart: opts.selectionStart,
    selectionEnd: opts.selectionEnd,
    maxLength: opts.maxLength,
    getBoundingClientRect:
      opts.getBoundingClientRect ?? (() => ({ x: 1, y: 2, width: 3, height: 4 })),
    dispatchEvent: opts.dispatchEvent,
    setSelectionRange: opts.setSelectionRange,
  }
}

const g = globalThis as any
let saved: Record<string, unknown> = {}

function installDom(dom: {
  elementFromPoint?: (x: number, y: number) => FakeEl | null
  activeElement?: FakeEl | null
  body?: FakeEl | null
  querySelectorAll?: (sel: string) => FakeEl[]
  getSelection?: () => { toString: () => string } | null
  computedStyle?: Record<string, string>
  windowExtras?: Record<string, unknown>
  inputEvents?: Array<{ type: string }>
}) {
  saved = {
    window: g.window,
    document: g.document,
    getComputedStyle: g.getComputedStyle,
    CSS: g.CSS,
    InputEvent: g.InputEvent,
  }
  const inputEvents = dom.inputEvents ?? []
  g.CSS = { escape: (s: string) => s }
  g.InputEvent = class {
    type: string
    constructor(type: string) {
      this.type = type
      inputEvents.push({ type })
    }
  }
  g.getComputedStyle = () =>
    dom.computedStyle ?? {
      cursor: 'auto',
      fontSize: '16px',
      lineHeight: '20px',
      paddingTop: '2px',
      paddingLeft: '4px',
      textAlign: 'left',
    }
  const listeners: Record<string, Array<() => void>> = {}
  g.document = {
    elementFromPoint: dom.elementFromPoint ?? (() => null),
    get activeElement() {
      return dom.activeElement ?? null
    },
    body: dom.body ?? null,
    querySelectorAll: dom.querySelectorAll ?? (() => []),
    getSelection: dom.getSelection,
    addEventListener: (type: string, cb: () => void) => {
      ;(listeners[type] ||= []).push(cb)
    },
    _fire: (type: string) => {
      for (const cb of listeners[type] ?? []) cb()
    },
  }
  g.window = {
    getSelection: dom.getSelection,
    HTMLInputElement: { prototype: {} },
    HTMLTextAreaElement: { prototype: {} },
    ...dom.windowExtras,
  }
  return { listeners, inputEvents, fire: (t: string) => g.document._fire(t) }
}

afterEach(() => {
  g.window = saved.window
  g.document = saved.document
  g.getComputedStyle = saved.getComputedStyle
  g.CSS = saved.CSS
  g.InputEvent = saved.InputEvent
  jest.restoreAllMocks()
})

// --- ELEMENT_AT_POINT_SCRIPT ------------------------------------------------

describe('ELEMENT_AT_POINT_SCRIPT', () => {
  it('returns null when no element is at the point', () => {
    installDom({ elementFromPoint: () => null })
    expect(ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })).toBeNull()
  })

  it('prefers data-testid', () => {
    const el = makeEl('button', { attrs: { 'data-testid': 'go' } })
    installDom({ elementFromPoint: () => el })
    expect(ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })?.selector).toBe('[data-testid="go"]')
  })

  it('uses id when present', () => {
    const el = makeEl('div', { id: 'main' })
    installDom({ elementFromPoint: () => el })
    expect(ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })?.selector).toBe('#main')
  })

  it('uses role + aria-label', () => {
    const el = makeEl('div', { attrs: { role: 'button', 'aria-label': 'Save' } })
    installDom({ elementFromPoint: () => el })
    const info = ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })
    expect(info?.selector).toBe('div[role="button"][aria-label="Save"]')
    expect(info?.label).toBe('Save')
  })

  it('uses name attribute for form fields', () => {
    const el = makeEl('input', { attrs: { name: 'email' } })
    installDom({ elementFromPoint: () => el })
    expect(ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })?.selector).toBe('input[name="email"]')
  })

  it('uses a Playwright text selector for links/buttons and escapes quotes', () => {
    const el = makeEl('button', { textContent: 'Say "hi"' })
    installDom({ elementFromPoint: () => el })
    expect(ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })?.selector).toBe('button:has-text("Say \\"hi\\"")')
  })

  it('uses placeholder for inputs', () => {
    const el = makeEl('input', { attrs: { placeholder: 'Search' } })
    installDom({ elementFromPoint: () => el })
    expect(ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })?.selector).toBe('input[placeholder="Search"]')
  })

  it('uses type with parent id context for inputs', () => {
    const parent = makeEl('div', { id: 'form1' })
    const el = makeEl('input', { attrs: { type: 'checkbox' }, parentElement: parent })
    installDom({ elementFromPoint: () => el })
    expect(ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })?.selector).toBe(
      '#form1 > input[type="checkbox"]',
    )
  })

  it('uses type without parent context when parent has no id', () => {
    const el = makeEl('input', { attrs: { type: 'checkbox' } })
    installDom({ elementFromPoint: () => el })
    expect(ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })?.selector).toBe('input[type="checkbox"]')
  })

  it('uses a unique class selector', () => {
    const el = makeEl('span', { classes: ['badge', 'js-x'] })
    installDom({ elementFromPoint: () => el, querySelectorAll: () => [el] })
    expect(ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })?.selector).toBe('span.badge')
  })

  it('falls back to nth-of-type when the class selector is not unique', () => {
    const el = makeEl('span', { classes: ['badge'] })
    const other = makeEl('span', { classes: ['badge'] })
    installDom({ elementFromPoint: () => el, querySelectorAll: () => [other, el] })
    expect(ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })?.selector).toBe('span.badge:nth-of-type(2)')
  })

  it('falls back to the tag name when nothing else matches', () => {
    const el = makeEl('section')
    installDom({ elementFromPoint: () => el })
    expect(ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })?.selector).toBe('section')
  })

  it('truncates very long visible text', () => {
    const el = makeEl('p', { textContent: 'x'.repeat(120) })
    installDom({ elementFromPoint: () => el })
    const info = ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })
    expect(info?.text?.endsWith('...')).toBe(true)
    expect(info?.text?.length).toBe(80)
  })

  it('handles null textContent', () => {
    const el = makeEl('div', { textContent: null })
    installDom({ elementFromPoint: () => el })
    expect(ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })?.text).toBeUndefined()
  })

  it.each([
    ['button', undefined, 'button'],
    ['a', undefined, 'link'],
    ['input', 'checkbox', 'checkbox'],
    ['input', 'radio', 'radio'],
    ['input', 'submit', 'button'],
    ['input', 'text', 'textbox'],
    ['textarea', undefined, 'textbox'],
    ['select', undefined, 'combobox'],
    ['img', undefined, 'img'],
    ['div', undefined, ''],
  ])('derives implicit role for <%s type=%s>', (tag, type, expected) => {
    const attrs: Record<string, string> = {}
    if (type) attrs.type = type
    // give it a fallback selector path; we only assert role
    const el = makeEl(tag, { attrs })
    installDom({ elementFromPoint: () => el })
    const info = ELEMENT_AT_POINT_SCRIPT({ x: 1, y: 1 })
    expect(info?.role ?? '').toBe(expected)
  })
})

// --- CURSOR_AT_POINT_SCRIPT -------------------------------------------------

describe('CURSOR_AT_POINT_SCRIPT', () => {
  it('returns default when no element at point', () => {
    installDom({ elementFromPoint: () => null })
    expect(CURSOR_AT_POINT_SCRIPT({ x: 1, y: 1 })).toBe('default')
  })

  it('returns the computed cursor', () => {
    const el = makeEl('a')
    installDom({ elementFromPoint: () => el, computedStyle: { cursor: 'pointer' } })
    expect(CURSOR_AT_POINT_SCRIPT({ x: 1, y: 1 })).toBe('pointer')
  })

  it('returns default when the computed cursor is empty', () => {
    const el = makeEl('div')
    installDom({ elementFromPoint: () => el, computedStyle: { cursor: '' } })
    expect(CURSOR_AT_POINT_SCRIPT({ x: 1, y: 1 })).toBe('default')
  })
})

// --- FOCUSED_ELEMENT_SCRIPT -------------------------------------------------

describe('FOCUSED_ELEMENT_SCRIPT', () => {
  it('returns null when nothing is focused', () => {
    installDom({ activeElement: null })
    expect(FOCUSED_ELEMENT_SCRIPT()).toBeNull()
  })

  it('returns null when body is focused', () => {
    const body = makeEl('body')
    installDom({ activeElement: body, body })
    expect(FOCUSED_ELEMENT_SCRIPT()).toBeNull()
  })

  it('reports the focused input', () => {
    const el = makeEl('input', { attrs: { name: 'search', type: 'text' } })
    installDom({ activeElement: el })
    const info = FOCUSED_ELEMENT_SCRIPT()
    expect(info?.tagName).toBe('input')
    expect(info?.selector).toBe('input[name="search"]')
    expect(info?.role).toBe('textbox')
  })

  it('covers the focused-element selector priority branches', () => {
    installDom({ activeElement: makeEl('div', { attrs: { 'data-testid': 't' } }) })
    expect(FOCUSED_ELEMENT_SCRIPT()?.selector).toBe('[data-testid="t"]')

    installDom({ activeElement: makeEl('div', { id: 'x' }) })
    expect(FOCUSED_ELEMENT_SCRIPT()?.selector).toBe('#x')

    installDom({ activeElement: makeEl('div', { attrs: { role: 'button', 'aria-label': 'A' } }) })
    expect(FOCUSED_ELEMENT_SCRIPT()?.selector).toBe('div[role="button"][aria-label="A"]')

    installDom({ activeElement: makeEl('input', { attrs: { placeholder: 'p' } }) })
    expect(FOCUSED_ELEMENT_SCRIPT()?.selector).toBe('input[placeholder="p"]')

    installDom({ activeElement: makeEl('input', { attrs: { type: 'date' } }) })
    expect(FOCUSED_ELEMENT_SCRIPT()?.selector).toBe('input[type="date"]')

    installDom({ activeElement: makeEl('span', { classes: ['c', 'js-x'] }) })
    expect(FOCUSED_ELEMENT_SCRIPT()?.selector).toBe('span.c')

    installDom({ activeElement: makeEl('section') })
    expect(FOCUSED_ELEMENT_SCRIPT()?.selector).toBe('section')
  })

  it.each([
    ['button', undefined, 'button'],
    ['a', undefined, 'link'],
    ['input', 'checkbox', 'checkbox'],
    ['input', 'radio', 'radio'],
    ['input', 'submit', 'button'],
    ['input', 'email', 'textbox'],
    ['textarea', undefined, 'textbox'],
    ['select', undefined, 'combobox'],
    ['div', undefined, ''],
  ])('derives implicit role for focused <%s type=%s>', (tag, type, expected) => {
    const attrs: Record<string, string> = {}
    if (type) attrs.type = type
    installDom({ activeElement: makeEl(tag, { attrs }) })
    expect(FOCUSED_ELEMENT_SCRIPT()?.role ?? '').toBe(expected)
  })
})

// --- GET_SELECTED_TEXT_SCRIPT -----------------------------------------------

describe('GET_SELECTED_TEXT_SCRIPT', () => {
  it('returns the selected substring of a focused input', () => {
    const el = makeEl('INPUT', { value: 'hello world', selectionStart: 0, selectionEnd: 5 })
    installDom({ activeElement: el })
    expect(GET_SELECTED_TEXT_SCRIPT()).toBe('hello')
  })

  it('falls back to the document selection', () => {
    installDom({
      activeElement: null,
      getSelection: () => ({ toString: () => 'page text' }),
    })
    expect(GET_SELECTED_TEXT_SCRIPT()).toBe('page text')
  })

  it('returns empty string when nothing is selected', () => {
    installDom({ activeElement: null, getSelection: () => null })
    expect(GET_SELECTED_TEXT_SCRIPT()).toBe('')
  })

  it('returns empty string when input has a collapsed selection', () => {
    const el = makeEl('INPUT', { value: 'abc', selectionStart: 1, selectionEnd: 1 })
    installDom({ activeElement: el, getSelection: () => ({ toString: () => '' }) })
    expect(GET_SELECTED_TEXT_SCRIPT()).toBe('')
  })
})

// --- FOCUS_REPORTING_SCRIPT -------------------------------------------------

describe('FOCUS_REPORTING_SCRIPT', () => {
  function makeReportEl(tagName: string, attrs: Record<string, string> = {}): FakeEl {
    return makeEl(tagName, {
      attrs,
      value: 'abc',
      selectionStart: 0,
      selectionEnd: 0,
      maxLength: 10,
    })
  }

  it('installs listeners and emits focused:true for a reporting target', () => {
    const onFocus = jest.fn()
    const target = makeReportEl('INPUT', { type: 'text' })
    const env = installDom({
      activeElement: target,
      windowExtras: { __onBrowserFocus: onFocus },
    })
    FOCUS_REPORTING_SCRIPT()
    // initial report fires for the already-focused target
    expect(onFocus).toHaveBeenCalledTimes(1)
    const payload = onFocus.mock.calls[0][0]
    expect(payload.focused).toBe(true)
    expect(payload.value).toBe('abc')
    expect(payload.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect(payload.fontSize).toBe(16)
    expect(payload.maxLength).toBe(10)
    // firing input emits again
    env.fire('input')
    expect(onFocus).toHaveBeenCalledTimes(2)
  })

  it('reports a textarea as multiline', () => {
    const onFocus = jest.fn()
    installDom({
      activeElement: makeReportEl('TEXTAREA'),
      windowExtras: { __onBrowserFocus: onFocus },
    })
    FOCUS_REPORTING_SCRIPT()
    const payload = onFocus.mock.calls[0][0]
    expect(payload.multiline).toBe(true)
    expect(payload.inputType).toBe('textarea')
  })

  it('omits numeric style fields that are NaN and a negative maxLength', () => {
    const onFocus = jest.fn()
    const el = makeEl('INPUT', {
      attrs: { type: 'text' },
      value: 'v',
      selectionStart: null,
      selectionEnd: null,
      maxLength: -1,
    })
    installDom({
      activeElement: el,
      computedStyle: { fontSize: 'normal', lineHeight: 'normal', paddingTop: 'auto', paddingLeft: 'auto', textAlign: 'left' },
      windowExtras: { __onBrowserFocus: onFocus },
    })
    FOCUS_REPORTING_SCRIPT()
    const payload = onFocus.mock.calls[0][0]
    expect(payload.fontSize).toBeUndefined()
    expect(payload.maxLength).toBeUndefined()
    expect(payload.selectionStart).toBeUndefined()
  })

  it('does not emit on injection when the active element is not a reporting target', () => {
    const onFocus = jest.fn()
    installDom({ activeElement: makeEl('DIV'), windowExtras: { __onBrowserFocus: onFocus } })
    FOCUS_REPORTING_SCRIPT()
    expect(onFocus).not.toHaveBeenCalled()
  })

  it('emits focused:false only once on the true->false transition', () => {
    const onFocus = jest.fn()
    const target = makeReportEl('INPUT', { type: 'text' })
    const win: Record<string, unknown> = { __onBrowserFocus: onFocus }
    const dom = { activeElement: target as FakeEl | null }
    // mutable active element via getter
    const env = installDomWithActive(dom, win)
    FOCUS_REPORTING_SCRIPT()
    onFocus.mockClear()
    dom.activeElement = null
    env.fire('focusout')
    env.fire('selectionchange')
    env.fire('input')
    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(onFocus.mock.calls[0][0].focused).toBe(false)
  })

  it('does not emit focused:false from selectionchange while nothing was focused', () => {
    const onFocus = jest.fn()
    const dom = { activeElement: null as FakeEl | null }
    const env = installDomWithActive(dom, { __onBrowserFocus: onFocus })
    FOCUS_REPORTING_SCRIPT()
    env.fire('selectionchange')
    env.fire('selectionchange')
    expect(onFocus).not.toHaveBeenCalled()
  })

  it('emits focused:false via the report path when focus moves to a non-target', () => {
    const onFocus = jest.fn()
    const target = makeReportEl('INPUT', { type: 'text' })
    const dom = { activeElement: target as FakeEl | null }
    const env = installDomWithActive(dom, { __onBrowserFocus: onFocus })
    FOCUS_REPORTING_SCRIPT()
    onFocus.mockClear()
    // Active element becomes a non-reporting target; an input event routes
    // through window.__browserFocusReport and emits the true->false transition.
    dom.activeElement = makeEl('DIV')
    env.fire('input')
    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(onFocus.mock.calls[0][0].focused).toBe(false)
  })

  it('logs a one-shot console warning when the binding throws', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const onFocus = jest.fn(() => {
      throw new Error('binding gone')
    })
    const target = makeReportEl('INPUT', { type: 'text' })
    const win: Record<string, unknown> = { __onBrowserFocus: onFocus }
    const dom = { activeElement: target as FakeEl | null }
    const env = installDomWithActive(dom, win)
    FOCUS_REPORTING_SCRIPT() // first failing report logs once
    env.fire('input') // second failure stays silent
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('[focus-reporting] report failed')
    expect((win as any).__focusReportErrorLogged).toBe(true)
  })

  it('is idempotent: re-running does not re-register listeners', () => {
    const onFocus = jest.fn()
    const target = makeReportEl('INPUT', { type: 'text' })
    const win: Record<string, unknown> = { __onBrowserFocus: onFocus }
    const dom = { activeElement: target as FakeEl | null }
    const env = installDomWithActive(dom, win)
    FOCUS_REPORTING_SCRIPT()
    const before = env.listenerCount()
    FOCUS_REPORTING_SCRIPT() // re-evaluation in same context
    expect(env.listenerCount()).toBe(before)
    // but the initial report ran again for the still-focused target
    expect(onFocus.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

// Variant installer exposing a MUTABLE activeElement object + listener count,
// used by FOCUS_REPORTING_SCRIPT transition tests.
function installDomWithActive(
  ref: { activeElement: FakeEl | null },
  windowExtras: Record<string, unknown>,
) {
  saved = {
    window: g.window,
    document: g.document,
    getComputedStyle: g.getComputedStyle,
    CSS: g.CSS,
    InputEvent: g.InputEvent,
  }
  g.CSS = { escape: (s: string) => s }
  g.getComputedStyle = () => ({
    fontSize: '16px',
    lineHeight: '20px',
    paddingTop: '2px',
    paddingLeft: '4px',
    textAlign: 'left',
  })
  const listeners: Record<string, Array<() => void>> = {}
  g.document = {
    get activeElement() {
      return ref.activeElement
    },
    body: null,
    addEventListener: (type: string, cb: () => void) => {
      ;(listeners[type] ||= []).push(cb)
    },
  }
  // Share the SAME object so window globals the script sets (e.g.
  // __focusReportErrorLogged) are observable on `windowExtras`.
  g.window = windowExtras
  return {
    fire: (type: string) => {
      for (const cb of listeners[type] ?? []) cb()
    },
    listenerCount: () => Object.values(listeners).reduce((n, a) => n + a.length, 0),
  }
}

// --- SET_FOCUSED_INPUT_VALUE_SCRIPT -----------------------------------------

describe('SET_FOCUSED_INPUT_VALUE_SCRIPT', () => {
  function makeEnv(opts: { inputHasSetter?: boolean; textareaHasSetter?: boolean } = {}) {
    const inputSetter = jest.fn(function (this: FakeEl, v: string) {
      this.value = v
    })
    const textareaSetter = jest.fn(function (this: FakeEl, v: string) {
      this.value = v
    })
    const inputProto: Record<string, unknown> = {}
    Object.defineProperty(inputProto, 'value', {
      configurable: true,
      get: () => '',
      ...(opts.inputHasSetter !== false ? { set: inputSetter } : {}),
    })
    const textareaProto: Record<string, unknown> = {}
    Object.defineProperty(textareaProto, 'value', {
      configurable: true,
      get: () => '',
      ...(opts.textareaHasSetter !== false ? { set: textareaSetter } : {}),
    })
    return { inputSetter, textareaSetter, inputProto, textareaProto }
  }

  function setActive(el: FakeEl | null, protos: { inputProto: unknown; textareaProto: unknown }) {
    const inputEvents: Array<{ type: string }> = []
    installDom({
      activeElement: el,
      inputEvents,
      windowExtras: {
        HTMLInputElement: { prototype: protos.inputProto },
        HTMLTextAreaElement: { prototype: protos.textareaProto },
      },
    })
    return inputEvents
  }

  it('sets the value via the native setter and dispatches input + selection', () => {
    const env = makeEnv()
    const el = makeEl('INPUT', {
      attrs: { type: 'text' },
      dispatchEvent: jest.fn(),
      setSelectionRange: jest.fn(),
    })
    const inputEvents = setActive(el, env)
    SET_FOCUSED_INPUT_VALUE_SCRIPT({ value: 'hi', selectionStart: 0, selectionEnd: 2 })
    expect(env.inputSetter).toHaveBeenCalledWith('hi')
    expect(el.dispatchEvent).toHaveBeenCalledTimes(1)
    expect(inputEvents).toEqual([{ type: 'input' }])
    expect(el.setSelectionRange).toHaveBeenCalledWith(0, 2)
  })

  it('sets the value on a textarea', () => {
    const env = makeEnv()
    const el = makeEl('TEXTAREA', { dispatchEvent: jest.fn(), setSelectionRange: jest.fn() })
    setActive(el, env)
    SET_FOCUSED_INPUT_VALUE_SCRIPT({ value: 'multi' })
    expect(env.textareaSetter).toHaveBeenCalledWith('multi')
    expect(el.dispatchEvent).toHaveBeenCalledTimes(1)
  })

  it('skips setSelectionRange when bounds are omitted', () => {
    const env = makeEnv()
    const el = makeEl('INPUT', {
      attrs: { type: 'text' },
      dispatchEvent: jest.fn(),
      setSelectionRange: jest.fn(),
    })
    setActive(el, env)
    SET_FOCUSED_INPUT_VALUE_SCRIPT({ value: 'x' })
    expect(el.setSelectionRange).not.toHaveBeenCalled()
  })

  it('no-ops when there is no active element', () => {
    const env = makeEnv()
    setActive(null, env)
    expect(() => SET_FOCUSED_INPUT_VALUE_SCRIPT({ value: 'x' })).not.toThrow()
    expect(env.inputSetter).not.toHaveBeenCalled()
  })

  it('no-ops for a non-reporting input type', () => {
    const env = makeEnv()
    const el = makeEl('INPUT', { attrs: { type: 'checkbox' }, dispatchEvent: jest.fn() })
    setActive(el, env)
    SET_FOCUSED_INPUT_VALUE_SCRIPT({ value: 'x' })
    expect(env.inputSetter).not.toHaveBeenCalled()
  })

  it('no-ops for a non-input/textarea element', () => {
    const env = makeEnv()
    const el = makeEl('DIV', { dispatchEvent: jest.fn() })
    setActive(el, env)
    SET_FOCUSED_INPUT_VALUE_SCRIPT({ value: 'x' })
    expect(env.inputSetter).not.toHaveBeenCalled()
    expect(env.textareaSetter).not.toHaveBeenCalled()
  })

  it('no-ops (no crash) when the native value setter is missing', () => {
    const env = makeEnv({ inputHasSetter: false })
    const el = makeEl('INPUT', { attrs: { type: 'text' }, dispatchEvent: jest.fn() })
    setActive(el, env)
    expect(() => SET_FOCUSED_INPUT_VALUE_SCRIPT({ value: 'x' })).not.toThrow()
    expect(el.dispatchEvent).not.toHaveBeenCalled()
  })
})
