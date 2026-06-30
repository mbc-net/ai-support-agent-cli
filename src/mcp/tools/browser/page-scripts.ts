/**
 * page-scripts.ts — Browser-context functions passed to Playwright's
 * page.evaluate() / page.addInitScript().
 *
 * IMPORTANT: every function in this module is serialized by Playwright and
 * executed INSIDE the browser page, NOT in Node. They must therefore be
 * self-contained (no references to Node/module-scope variables) and may only
 * use browser globals (document, window, getComputedStyle, CSS, …).
 *
 * They are REAL functions (not strings): Playwright treats a string
 * pageFunction as a JS expression and never calls it, so a string arrow
 * function would silently do nothing and ignore its argument. Passing the
 * function directly lets Playwright serialize and invoke it with the arg.
 *
 * DOM typing is provided by the MODULE-SCOPED ambient declarations below. They
 * intentionally avoid `/// <reference lib="dom" />` and `declare global`, both
 * of which leak DOM types into the rest of the (Node) codebase; module-scoped
 * `declare const` bindings are visible only within this file, so the global
 * tsconfig `lib: ["ES2022"]` (no "DOM") still catches stray DOM usage elsewhere.
 */

/** Focus payload forwarded through `window.__onBrowserFocus`. */
interface FocusReportPayload {
  focused: boolean
  rect?: { x: number; y: number; width: number; height: number }
  value?: string
  selectionStart?: number
  selectionEnd?: number
  multiline?: boolean
  inputType?: string
  maxLength?: number
  fontSize?: number
  lineHeight?: number
  paddingTop?: number
  paddingLeft?: number
  textAlign?: string
  caretColor?: string
}

/** Minimal DOM element shape used by the page-scripts. */
interface PageElement {
  tagName: string
  id: string
  classList: ArrayLike<string> & Iterable<string>
  textContent: string | null
  parentElement: PageElement | null
  getAttribute(name: string): string | null
  getBoundingClientRect(): { x: number; y: number; width: number; height: number }
  dispatchEvent(event: unknown): boolean
}

/** input/textarea element shape (a reporting target). */
interface PageInputElement extends PageElement {
  value: string
  selectionStart: number | null
  selectionEnd: number | null
  maxLength: number
  setSelectionRange(start: number, end: number): void
}

/** Subset of CSSStyleDeclaration the scripts read. */
interface PageComputedStyle {
  cursor: string
  fontSize: string
  lineHeight: string
  paddingTop: string
  paddingLeft: string
  textAlign: string
  caretColor: string
  color: string
}

/** Subset of window the scripts use, including custom focus-reporting globals. */
interface PageWindow {
  HTMLInputElement: { prototype: object }
  HTMLTextAreaElement: { prototype: object }
  getSelection(): { toString(): string } | null
  __onBrowserFocus?: (payload: FocusReportPayload) => void
  __browserFocusReportingInstalled?: boolean
  __browserFocusReport?: () => void
  __focusReportErrorLogged?: boolean
}

// Browser globals — declared at MODULE scope so the DOM types stay local to
// this file (no project-wide leak). Erased at compile time; at runtime these
// resolve to the real browser globals when Playwright runs the functions.
declare const document: {
  elementFromPoint(x: number, y: number): PageElement | null
  activeElement: PageElement | null
  body: PageElement | null
  querySelectorAll(selector: string): ArrayLike<PageElement>
  addEventListener(type: string, listener: () => void, capture?: boolean): void
}
declare const window: PageWindow
declare const getComputedStyle: (el: PageElement) => PageComputedStyle
declare const CSS: { escape(value: string): string }
declare const InputEvent: { new (type: string, init?: { bubbles?: boolean }): unknown }

/**
 * Extract Playwright-friendly element info for the element at a point.
 * Returns an ElementInfo-compatible object or null.
 */
export const ELEMENT_AT_POINT_SCRIPT = (point: { x: number; y: number }) => {
  const el = document.elementFromPoint(point.x, point.y)
  if (!el) return null
  return extractInfo(el)

  function extractInfo(el: PageElement) {
    const tag = el.tagName.toLowerCase()
    const id = el.id
    const name = el.getAttribute('name')
    const type = el.getAttribute('type')
    const role = el.getAttribute('role') || implicitRole(tag, type)
    const ariaLabel = el.getAttribute('aria-label')
    const placeholder = el.getAttribute('placeholder')
    const title = el.getAttribute('title')
    const href = el.getAttribute('href')
    const text = getVisibleText(el)
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id')

    const selector = buildSelector(el, tag, id, name, testId, text, role, ariaLabel, placeholder, type)
    const label = ariaLabel || placeholder || name || title || undefined

    return {
      selector,
      tagName: tag,
      type: type || undefined,
      text: text || undefined,
      role: role || undefined,
      label: label || undefined,
      href: href || undefined,
    }
  }

  function buildSelector(
    el: PageElement,
    tag: string,
    id: string,
    name: string | null,
    testId: string | null,
    text: string,
    role: string,
    ariaLabel: string | null,
    placeholder: string | null,
    type: string | null,
  ): string {
    // Priority 1: data-testid (most stable)
    if (testId) return '[data-testid="' + testId + '"]'

    // Priority 2: id (unique)
    if (id) return '#' + CSS.escape(id)

    // Priority 3: role + name (accessible selectors)
    if (role && ariaLabel) return tag + '[role="' + role + '"][aria-label="' + ariaLabel + '"]'

    // Priority 4: name attribute (forms)
    if (name && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
      return tag + '[name="' + name + '"]'
    }

    // Priority 5: Playwright text selector for buttons/links
    if (text && text.length <= 50 && (tag === 'button' || tag === 'a' || role === 'button' || role === 'link')) {
      return tag + ':has-text("' + text.replace(/"/g, '\\"') + '")'
    }

    // Priority 6: placeholder for inputs
    if (placeholder && tag === 'input') {
      return 'input[placeholder="' + placeholder + '"]'
    }

    // Priority 7: type for inputs
    if (type && tag === 'input') {
      // Check if unique enough by adding parent context
      const parent = el.parentElement
      if (parent && parent.id) {
        return '#' + CSS.escape(parent.id) + ' > input[type="' + type + '"]'
      }
      return 'input[type="' + type + '"]'
    }

    // Priority 8: nth-of-type with class
    const classes = Array.from(el.classList).filter((c) => !c.match(/^(js-|is-|has-)/)).slice(0, 2)
    if (classes.length > 0) {
      const classSelector = tag + '.' + classes.map((c) => CSS.escape(c)).join('.')
      const siblings = document.querySelectorAll(classSelector)
      if (siblings.length === 1) return classSelector
      const index = Array.from(siblings).indexOf(el)
      if (index >= 0) return classSelector + ':nth-of-type(' + (index + 1) + ')'
    }

    // Fallback: tag with index
    return tag
  }

  function getVisibleText(el: PageElement): string {
    const text = (el.textContent || '').trim()
    return text.length > 80 ? text.substring(0, 77) + '...' : text
  }

  function implicitRole(tag: string, type: string | null): string {
    if (tag === 'button') return 'button'
    if (tag === 'a') return 'link'
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit') return 'button'
      if (!type || type === 'text' || type === 'email' || type === 'password' || type === 'search' || type === 'tel' || type === 'url' || type === 'number') return 'textbox'
    }
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    if (tag === 'img') return 'img'
    return ''
  }
}

/**
 * Read the CSS `cursor` value of the element at a point. Returns 'default' when
 * no element is found or the computed cursor is empty.
 */
export const CURSOR_AT_POINT_SCRIPT = (point: { x: number; y: number }): string => {
  const el = document.elementFromPoint(point.x, point.y)
  if (!el) return 'default'
  return getComputedStyle(el).cursor || 'default'
}

/**
 * Extract info about the currently focused element.
 */
export const FOCUSED_ELEMENT_SCRIPT = () => {
  const el = document.activeElement
  if (!el || el === document.body) return null

  const tag = el.tagName.toLowerCase()
  const id = el.id
  const name = el.getAttribute('name')
  const type = el.getAttribute('type')
  const role = el.getAttribute('role') || implicitRole(tag, type)
  const ariaLabel = el.getAttribute('aria-label')
  const placeholder = el.getAttribute('placeholder')
  const title = el.getAttribute('title')
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id')

  const selector = buildSelector(el, tag, id, name, testId, '', role, ariaLabel, placeholder, type)
  const label = ariaLabel || placeholder || name || title || undefined

  return {
    selector,
    tagName: tag,
    type: type || undefined,
    role: role || undefined,
    label: label || undefined,
  }

  function buildSelector(
    el: PageElement,
    tag: string,
    id: string,
    name: string | null,
    testId: string | null,
    _text: string,
    role: string,
    ariaLabel: string | null,
    placeholder: string | null,
    type: string | null,
  ): string {
    if (testId) return '[data-testid="' + testId + '"]'
    if (id) return '#' + CSS.escape(id)
    if (role && ariaLabel) return tag + '[role="' + role + '"][aria-label="' + ariaLabel + '"]'
    if (name && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
      return tag + '[name="' + name + '"]'
    }
    if (placeholder && tag === 'input') {
      return 'input[placeholder="' + placeholder + '"]'
    }
    if (type && tag === 'input') return 'input[type="' + type + '"]'
    const classes = Array.from(el.classList).filter((c) => !c.match(/^(js-|is-|has-)/)).slice(0, 2)
    if (classes.length > 0) return tag + '.' + classes.map((c) => CSS.escape(c)).join('.')
    return tag
  }

  function implicitRole(tag: string, type: string | null): string {
    if (tag === 'button') return 'button'
    if (tag === 'a') return 'link'
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit') return 'button'
      if (!type || type === 'text' || type === 'email' || type === 'password' || type === 'search' || type === 'tel' || type === 'url' || type === 'number') return 'textbox'
    }
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    return ''
  }
}

/**
 * Read the current selection. Prefers the selection range of a focused
 * input/textarea, falling back to the document selection. Returns an empty
 * string when nothing is selected.
 */
export const GET_SELECTED_TEXT_SCRIPT = (): string => {
  const active = document.activeElement as PageInputElement | null
  if (
    active &&
    (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') &&
    active.selectionStart != null &&
    active.selectionEnd != null &&
    active.selectionStart !== active.selectionEnd
  ) {
    return active.value.substring(active.selectionStart, active.selectionEnd)
  }
  const sel = window.getSelection()
  return sel ? sel.toString() : ''
}

/**
 * Install (idempotently) focus/value/selection reporting for simple
 * input/textarea elements. Reports through the `window.__onBrowserFocus`
 * binding exposed by Playwright.
 *
 * Listener registration is guarded by `window.__browserFocusReportingInstalled`
 * so re-evaluating the script does not double-register handlers. The INITIAL
 * report runs on EVERY evaluation (outside the guard) so an element already
 * focused at injection time (e.g. an autofocused login field) is surfaced.
 *
 * Browser-side failures of the exposed binding are warned at most once here;
 * the Node side (browser-session.ts exposeBinding wrapper) adds server-log
 * observability for binding callback failures.
 */
export const FOCUS_REPORTING_SCRIPT = () => {
  // The per-document focus reporting state (listeners + lastReportedFocused) is
  // installed once. Hang the report() helper off window so a re-evaluation that
  // skips re-registration can still invoke the initial report below.
  if (!window.__browserFocusReportingInstalled) {
    window.__browserFocusReportingInstalled = true

    // Last focused state reported to the agent. Used to suppress repeated
    // { focused: false } notifications: selectionchange fires for the whole
    // document (including unrelated page text selections), so without this guard
    // every such selection would emit a redundant focused:false. We only forward
    // a false when transitioning from a previously-focused (true) state.
    var lastReportedFocused = false

    // Forward a payload through the exposed binding, recording the new focused
    // state and logging the first failure once (high-frequency events would
    // otherwise flood the browser console).
    function emit(payload: FocusReportPayload) {
      lastReportedFocused = payload.focused
      try {
        window.__onBrowserFocus!(payload)
      } catch (e) {
        if (!window.__focusReportErrorLogged) {
          window.__focusReportErrorLogged = true
          try { console.warn('[focus-reporting] report failed', e && (e as Error).message ? (e as Error).message : e) } catch (_) {}
        }
      }
    }

    function isReportingTarget(el: PageElement | null): el is PageInputElement {
      if (!el) return false
      const tag = el.tagName
      if (tag === 'TEXTAREA') return true
      if (tag !== 'INPUT') return false
      const type = (el.getAttribute('type') || '').toLowerCase()
      return type === '' || type === 'text' || type === 'search' || type === 'email' ||
        type === 'url' || type === 'tel' || type === 'password' || type === 'number'
    }

    function buildPayload(el: PageInputElement): FocusReportPayload {
      const rect = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const fontSize = parseFloat(cs.fontSize)
      const lineHeight = parseFloat(cs.lineHeight)
      const paddingTop = parseFloat(cs.paddingTop)
      const paddingLeft = parseFloat(cs.paddingLeft)
      const multiline = el.tagName === 'TEXTAREA'
      const payload: FocusReportPayload = {
        focused: true,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        value: el.value,
        selectionStart: el.selectionStart == null ? undefined : el.selectionStart,
        selectionEnd: el.selectionEnd == null ? undefined : el.selectionEnd,
        multiline: multiline,
        inputType: multiline ? 'textarea' : ((el.getAttribute('type') || 'text').toLowerCase()),
        textAlign: cs.textAlign,
      }
      if (typeof el.maxLength === 'number' && el.maxLength >= 0) payload.maxLength = el.maxLength
      if (!Number.isNaN(fontSize)) payload.fontSize = fontSize
      if (!Number.isNaN(lineHeight)) payload.lineHeight = lineHeight
      if (!Number.isNaN(paddingTop)) payload.paddingTop = paddingTop
      if (!Number.isNaN(paddingLeft)) payload.paddingLeft = paddingLeft
      // Native caret defaults to `caret-color`, which itself falls back to the
      // element's `color` when `auto`. Resolving it here makes the overlay caret
      // match the real page caret instead of the console theme token. A fully
      // transparent caret-color (e.g. editors like Ace hide the native caret on a
      // hidden textarea and draw their own) is resolved away so the overlay does
      // NOT re-introduce the invisible-caret bug: fall back to `color`, and if
      // that is also transparent/empty, omit the field so the web overlay uses
      // its visible `caret-foreground` theme class.
      let caretColor = cs.caretColor
      if (!caretColor || caretColor === 'auto' || isTransparentColor(caretColor)) caretColor = cs.color
      if (caretColor && !isTransparentColor(caretColor)) payload.caretColor = caretColor
      return payload
    }

    // Whether a CSS color string is fully transparent: the `transparent` keyword
    // or an alpha-0 functional form (`rgba(…, 0)` / `hsla(…, 0)`). Chromium
    // computes `caret-color: transparent` to `rgba(0, 0, 0, 0)`. Self-contained
    // so it survives serialization into the browser context. Empty → treated as
    // transparent (nothing usable to render).
    function isTransparentColor(c: string): boolean {
      if (!c) return true
      if (c === 'transparent') return true
      const m = c.match(/^(?:rgba?|hsla?)\(([^)]+)\)$/i)
      if (m) {
        const parts = m[1].split(/[,/]/).map((s) => s.trim()).filter(Boolean)
        const alpha = parts.length >= 4 ? parseFloat(parts[3]) : 1
        return alpha === 0
      }
      return false
    }

    // Report focused:true (with current value/selection) whenever a reporting
    // target is active; report focused:false only on the true->false transition.
    // Exposed on window so a guarded re-evaluation can still trigger the initial
    // report without re-registering listeners.
    window.__browserFocusReport = function () {
      const el = document.activeElement
      if (isReportingTarget(el)) {
        emit(buildPayload(el))
      } else if (lastReportedFocused) {
        emit({ focused: false })
      }
    }

    document.addEventListener('focusin', window.__browserFocusReport, true)
    document.addEventListener('focusout', function () {
      if (lastReportedFocused) emit({ focused: false })
    }, true)
    document.addEventListener('input', window.__browserFocusReport, true)
    document.addEventListener('selectionchange', window.__browserFocusReport, true)
  }

  // Initial report on EVERY evaluation: surfaces an element that is already
  // focused at injection time (autofocus) for which focusin will never fire.
  if (typeof window.__browserFocusReport === 'function') window.__browserFocusReport()
}

/**
 * Reflect a value into the currently-focused reporting-target input/textarea
 * using the native value setter + InputEvent('input') dispatch, so React-style
 * controlled components do not roll the value back. Optionally applies a
 * selection range. No-op when the active element is not a reporting target.
 */
export const SET_FOCUSED_INPUT_VALUE_SCRIPT = (args: {
  value: string
  selectionStart?: number
  selectionEnd?: number
}) => {
  const el = document.activeElement
  if (!el) return
  const tag = el.tagName
  let proto: object
  if (tag === 'TEXTAREA') {
    proto = window.HTMLTextAreaElement.prototype
  } else if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || '').toLowerCase()
    const ok = type === '' || type === 'text' || type === 'search' || type === 'email' ||
      type === 'url' || type === 'tel' || type === 'password' || type === 'number'
    if (!ok) return
    proto = window.HTMLInputElement.prototype
  } else {
    return
  }
  // The native value setter may be absent on exotic/polyfilled prototypes;
  // treat that as a no-op (same as a non-reporting target) rather than letting
  // a TypeError escape from reading .set of undefined.
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
  const setter = desc && desc.set
  if (!setter) return
  const input = el as PageInputElement
  setter.call(input, args.value)
  input.dispatchEvent(new InputEvent('input', { bubbles: true }))
  if (args.selectionStart != null && args.selectionEnd != null) {
    try { input.setSelectionRange(args.selectionStart, args.selectionEnd) } catch (e) {}
  }
}
