/**
 * element-info.ts — Extracts Playwright-friendly element information from the page.
 *
 * Used by BrowserSession to enrich action logs with CSS selectors, element types,
 * and text content so that chat AI can reproduce user interactions via Playwright.
 */

/** Structured information about a DOM element */
export interface ElementInfo {
  /** Best CSS selector for Playwright (e.g., '#submit-btn', 'button:has-text("Login")') */
  selector: string
  /** Tag name (e.g., 'button', 'input', 'a') */
  tagName: string
  /** Element type attribute for input/button (e.g., 'text', 'submit', 'checkbox') */
  type?: string
  /** Visible text content (truncated) */
  text?: string
  /** Role attribute or implicit ARIA role */
  role?: string
  /** name, placeholder, aria-label, or title attribute */
  label?: string
  /** href for links */
  href?: string
}

/**
 * JavaScript to run in the browser via page.evaluate() to extract element info.
 * Returns ElementInfo-compatible object or null.
 */
const ELEMENT_AT_POINT_SCRIPT = `(point) => {
  const el = document.elementFromPoint(point.x, point.y);
  if (!el) return null;
  return extractInfo(el);

  function extractInfo(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id;
    const name = el.getAttribute('name');
    const type = el.getAttribute('type');
    const role = el.getAttribute('role') || implicitRole(tag, type);
    const ariaLabel = el.getAttribute('aria-label');
    const placeholder = el.getAttribute('placeholder');
    const title = el.getAttribute('title');
    const href = el.getAttribute('href');
    const text = getVisibleText(el);
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');

    const selector = buildSelector(el, tag, id, name, testId, text, role, ariaLabel, placeholder, type);
    const label = ariaLabel || placeholder || name || title || undefined;

    return {
      selector,
      tagName: tag,
      type: type || undefined,
      text: text || undefined,
      role: role || undefined,
      label: label || undefined,
      href: href || undefined,
    };
  }

  function buildSelector(el, tag, id, name, testId, text, role, ariaLabel, placeholder, type) {
    // Priority 1: data-testid (most stable)
    if (testId) return '[data-testid="' + testId + '"]';

    // Priority 2: id (unique)
    if (id) return '#' + CSS.escape(id);

    // Priority 3: role + name (accessible selectors)
    if (role && ariaLabel) return tag + '[role="' + role + '"][aria-label="' + ariaLabel + '"]';

    // Priority 4: name attribute (forms)
    if (name && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
      return tag + '[name="' + name + '"]';
    }

    // Priority 5: Playwright text selector for buttons/links
    if (text && text.length <= 50 && (tag === 'button' || tag === 'a' || role === 'button' || role === 'link')) {
      return tag + ':has-text("' + text.replace(/"/g, '\\\\"') + '")';
    }

    // Priority 6: placeholder for inputs
    if (placeholder && tag === 'input') {
      return 'input[placeholder="' + placeholder + '"]';
    }

    // Priority 7: type for inputs
    if (type && tag === 'input') {
      // Check if unique enough by adding parent context
      const parent = el.parentElement;
      if (parent && parent.id) {
        return '#' + CSS.escape(parent.id) + ' > input[type="' + type + '"]';
      }
      return 'input[type="' + type + '"]';
    }

    // Priority 8: nth-of-type with class
    const classes = Array.from(el.classList).filter(c => !c.match(/^(js-|is-|has-)/)).slice(0, 2);
    if (classes.length > 0) {
      const classSelector = tag + '.' + classes.map(c => CSS.escape(c)).join('.');
      const siblings = document.querySelectorAll(classSelector);
      if (siblings.length === 1) return classSelector;
      const index = Array.from(siblings).indexOf(el);
      if (index >= 0) return classSelector + ':nth-of-type(' + (index + 1) + ')';
    }

    // Fallback: tag with index
    return tag;
  }

  function getVisibleText(el) {
    const text = (el.textContent || '').trim();
    return text.length > 80 ? text.substring(0, 77) + '...' : text;
  }

  function implicitRole(tag, type) {
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit') return 'button';
      if (!type || type === 'text' || type === 'email' || type === 'password' || type === 'search' || type === 'tel' || type === 'url' || type === 'number') return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'img') return 'img';
    return '';
  }
}`

/**
 * JavaScript to extract info about the currently focused element.
 */
const FOCUSED_ELEMENT_SCRIPT = `() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;

  const tag = el.tagName.toLowerCase();
  const id = el.id;
  const name = el.getAttribute('name');
  const type = el.getAttribute('type');
  const role = el.getAttribute('role') || implicitRole(tag, type);
  const ariaLabel = el.getAttribute('aria-label');
  const placeholder = el.getAttribute('placeholder');
  const title = el.getAttribute('title');
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');

  const selector = buildSelector(el, tag, id, name, testId, '', role, ariaLabel, placeholder, type);
  const label = ariaLabel || placeholder || name || title || undefined;

  return {
    selector,
    tagName: tag,
    type: type || undefined,
    role: role || undefined,
    label: label || undefined,
  };

  function buildSelector(el, tag, id, name, testId, text, role, ariaLabel, placeholder, type) {
    if (testId) return '[data-testid="' + testId + '"]';
    if (id) return '#' + CSS.escape(id);
    if (role && ariaLabel) return tag + '[role="' + role + '"][aria-label="' + ariaLabel + '"]';
    if (name && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
      return tag + '[name="' + name + '"]';
    }
    if (placeholder && tag === 'input') {
      return 'input[placeholder="' + placeholder + '"]';
    }
    if (type && tag === 'input') return 'input[type="' + type + '"]';
    const classes = Array.from(el.classList).filter(c => !c.match(/^(js-|is-|has-)/)).slice(0, 2);
    if (classes.length > 0) return tag + '.' + classes.map(c => CSS.escape(c)).join('.');
    return tag;
  }

  function implicitRole(tag, type) {
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit') return 'button';
      if (!type || type === 'text' || type === 'email' || type === 'password' || type === 'search' || type === 'tel' || type === 'url' || type === 'number') return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return '';
  }
}`

/**
 * Get element info at the given coordinates via page.evaluate().
 * Returns null if no element found or on error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getElementAtPoint(page: any, x: number, y: number): Promise<ElementInfo | null> {
  try {
    return await page.evaluate(ELEMENT_AT_POINT_SCRIPT, { x, y }) as ElementInfo | null
  } catch {
    return null
  }
}

/**
 * Get info about the currently focused element.
 * Returns null if no element is focused or on error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getFocusedElementInfo(page: any): Promise<ElementInfo | null> {
  try {
    return await page.evaluate(FOCUSED_ELEMENT_SCRIPT) as ElementInfo | null
  } catch {
    return null
  }
}

/**
 * Format ElementInfo into a human-readable, Playwright-actionable string.
 */
export function formatElementInfo(info: ElementInfo): string {
  const parts: string[] = []

  // selector is always first — the most important part for Playwright
  parts.push(`selector="${info.selector}"`)

  // Element description
  const desc: string[] = [info.tagName]
  if (info.type) desc.push(`type=${info.type}`)
  if (info.role) desc.push(`role=${info.role}`)
  parts.push(`<${desc.join(' ')}>`)

  if (info.label) parts.push(`label="${info.label}"`)
  if (info.text) parts.push(`text="${info.text}"`)
  if (info.href) parts.push(`href="${info.href}"`)

  return parts.join(' ')
}
