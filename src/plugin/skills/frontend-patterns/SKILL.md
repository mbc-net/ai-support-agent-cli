---
name: frontend-patterns
description: A pattern collection for component design, state management, performance, forms, error handling, and accessibility in React (Next.js App Router) and Vue.js (Composition API). Use when creating or refactoring frontend components, deciding on a state management or data-fetching approach, or checking what to look for when reviewing frontend code.
---

# Frontend Development Patterns

This guide centers on React (Next.js App Router), with the equivalent Vue.js (Composition API)
pattern noted alongside each topic. When in doubt, follow the principle of "start simple, add
complexity only when you actually need it."

## 1. Component Design

### Splitting responsibilities

Aim for one responsibility per component. If you can't describe what a component does in a
single sentence, consider splitting it.

- Separate presentation (display) from data fetching and state management (container).
- In the Next.js App Router, fetch data in Server Components and carve out only the
  interactive parts into small `"use client"` Client Components.
- In Vue, once the logic inside `setup` starts spanning multiple areas of the screen, split it
  into child components or composables.

### Signs a component has grown too large

If several of these apply, it's a signal to split the component:

- The file is over 300 lines, or the JSX/template is over 100 lines.
- Seven or more `useState`/`ref` calls are lined up.
- Boolean props (`isCompact`, `showHeader`, etc.) keep growing and their conditional branches
  start interacting with each other.
- The component performs multiple unrelated data fetches.
- Writing a test for it requires mocking a pile of unrelated functionality.

### Composing with children / slots

Express variants through composition rather than piling on flag props.

```tsx
// Bad: variants expressed as a growing set of flag props
<Card title="Sales" showIcon iconType="chart" footerText="Details" footerLink="/sales" />

// Good: composition via children lets the caller decide the structure
<Card>
  <Card.Header icon={<ChartIcon />}>Sales</Card.Header>
  <Card.Body>{children}</Card.Body>
  <Card.Footer><Link href="/sales">Details</Link></Card.Footer>
</Card>
```

```vue
<!-- In Vue, named slots express the same structure -->
<Card>
  <template #header>Sales</template>
  <template #default>...</template>
  <template #footer><RouterLink to="/sales">Details</RouterLink></template>
</Card>
```

## 2. Reusing Logic (Custom Hooks / Composables)

### When to extract

- The same combination of state and effects shows up in two or more places.
- There's logic you want to unit test independently of the component.
- You can give it a name that describes what it does (`useDebounce`, `usePagination`, etc.).

Conversely, don't force an extraction for logic that's used in only one place and is hard to
name meaningfully.

```tsx
// Good: extract the state + effect boilerplate into a hook (React)
function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
```

```ts
// Good: the same logic implemented as a Vue composable
export function useDebouncedValue<T>(source: Ref<T>, delayMs = 300) {
  const debounced = ref(source.value) as Ref<T>;
  let id: ReturnType<typeof setTimeout>;
  watch(source, (v) => {
    clearTimeout(id);
    id = setTimeout(() => (debounced.value = v), delayMs);
  });
  onUnmounted(() => clearTimeout(id));
  return debounced;
}
```

- Hooks/composables should not return UI. If the reusable unit involves UI, make it a
  component instead.
- Return an object so callers can destructure only what they need.

## 3. State Management

### Where state should live: priority order

1. Local state (`useState` / `ref`). Always start here.
2. Lift state up to a parent, once it needs to be shared between siblings.
3. Context (`createContext` / `provide` and `inject`), once passing props down deeply becomes
   painful.
4. A global store (Zustand / Pinia), once it meets the criteria below.

### When a global store is warranted

- State that outlives a single screen (authenticated user, theme, cart, etc.).
- State that must survive route changes without being discarded.
- State that's read and written by many far-apart components.

If the only issue is "props get passed through 2-3 levels," component composition or context
can usually solve it — that alone isn't a reason to introduce a store.

### Let a data-fetching library own server state

Don't hand-roll caching, refetching, and loading-state management for API responses. Delegate
to SWR or TanStack Query (React Query / Vue Query).

```tsx
// Bad: manually managing server data with useEffect + a global store
useEffect(() => {
  fetch("/api/users").then((r) => r.json()).then((d) => store.setUsers(d));
}, []);

// Good: delegate to a data-fetching library (caching, revalidation, and dedup included)
const { data, error, isLoading } = useQuery({
  queryKey: ["users"],
  queryFn: fetchUsers,
});
```

- Reserve the global store for genuinely client-only state.
- Copying server data into a store means you end up reimplementing freshness tracking and
  invalidation yourself.

## 4. Derived State

Values that can be computed from existing state should be derived during render (React) or via
`computed` (Vue) — don't duplicate them into a separate piece of state via an effect or watcher.

```tsx
// Bad: duplicating a derived value into separate state via useEffect
// (lags a render behind and is a common source of bugs)
const [filtered, setFiltered] = useState<Item[]>([]);
useEffect(() => {
  setFiltered(items.filter((i) => i.name.includes(query)));
}, [items, query]);

// Good: compute it during render; add useMemo only if profiling shows it's expensive
const filtered = items.filter((i) => i.name.includes(query));
```

```ts
// Bad: duplicating into a separate ref via watch (Vue)
watch([items, query], () => {
  filtered.value = items.value.filter((i) => i.name.includes(query.value));
});

// Good: derive it declaratively with computed
const filtered = computed(() =>
  items.value.filter((i) => i.name.includes(query.value))
);
```

- Whenever you see "an effect that updates state B when state A changes," ask first whether B
  can just be a derived value instead.
- Effects/watchers are legitimately for syncing with external systems (DOM manipulation,
  subscriptions, sending logs, etc.) — not for mirroring state.

## 5. Performance

### Memoization discipline: measure first

- Check actual re-render cost with React DevTools Profiler / Vue DevTools before optimizing.
- Don't reflexively slap `useMemo` / `useCallback` / `memo` on everything — it costs
  readability, and a wrong dependency array turns into a bug.
- It's worth adding when a computation is measurably expensive, or when referential stability
  matters for a `memo`-ized child or a dependency array.
- In environments where the React Compiler or Vue's built-in optimizations are effective,
  manual memoization can often be reduced further.

### Code splitting and lazy loading

- Route-level splitting is handled automatically by Next.js / Vue Router — rely on that first.
- Lazy-load heavy components that aren't needed on initial render (modals, charts, editors)
  with `next/dynamic` or `defineAsyncComponent`.

```tsx
// Good: lazily load a heavy component that's only needed once it's opened
const ChartPanel = dynamic(() => import("./ChartPanel"), { ssr: false });
```

### Virtualizing long lists

Don't render every row of a list with hundreds of items — render only the visible range with
`@tanstack/react-virtual` / `@tanstack/vue-virtual` or similar. Before reaching for
virtualization, first consider whether pagination or a "load more" pattern can simply reduce
the item count.

## 6. Forms

### Schema-based validation

Define validation rules as a schema (Zod, Valibot, etc.) and wire it into your form library
(React Hook Form / VeeValidate). Re-validate with the same schema on the server.

```tsx
// Good: the schema is the single source of truth for validation rules
const schema = z.object({
  email: z.string().email("Please enter a valid email address"),
  age: z.coerce.number().int().min(18, "Must be 18 or older"),
});

const { register, handleSubmit, formState } = useForm({
  resolver: zodResolver(schema),
});
```

- Display error messages near the relevant field and associate them with the input via
  `aria-describedby`.
- Don't hardcode validation logic inline in JSX or templates.

### Submission state and preventing double submits

```tsx
// Bad: no submission-state guard, so rapid clicks trigger duplicate POSTs
<button onClick={() => submit(values)}>Submit</button>

// Good: disable the button while submitting and show the state to the user
const { isSubmitting } = formState;
<button type="submit" disabled={isSubmitting}>
  {isSubmitting ? "Submitting..." : "Submit"}
</button>
```

- Using `useMutation` from React Query / Vue Query for mutations standardizes handling of
  `isPending`, errors, and retries.
- After a successful submission, reset the form or navigate away so the user isn't left in a
  state where they could resubmit the same data.

## 7. Error Handling

### Error boundaries / onErrorCaptured

- React: place an error boundary around each layout region so one failure doesn't blank out
  the whole screen. In the Next.js App Router, add an `error.tsx` per segment.
- Vue: catch descendant rendering errors in a parent's `onErrorCaptured` and switch to a
  fallback UI.
- Never swallow the error silently in the boundary — always report it to your error monitoring
  service.

### The three states of a data-fetching UI

Always explicitly handle the three states: loading, error, and empty (zero results).

```tsx
// Good: handle all three states before rendering the real content
if (isLoading) return <Spinner />;
if (error) return <ErrorMessage error={error} onRetry={refetch} />;
if (data.length === 0) return <EmptyState message="No data available" />;
return <UserList users={data} />;
```

- Give the error state a retry action (a retry button).
- Word the empty state so it clearly reads as "not an error," and point toward a next action
  (e.g., create new).
- To avoid flicker, consider a skeleton UI or `placeholderData` (keeping the previous data
  visible while refetching).

## 8. Accessibility

### Semantic elements

- Use `button` / `a` for anything clickable. Don't attach `onClick` to a `div`.
- Use `a` (`Link`) for navigation/URL changes and `button` for in-place actions.
- Keep heading levels in order starting from `h1`; don't pick a heading level for its visual
  size.
- Use landmarks (`main`, `nav`, `header`, `footer`) to convey document structure.

```tsx
// Bad: onClick on a div (unreachable via keyboard or assistive technology)
<div onClick={save}>Save</div>

// Good: use a native button (focus and Enter/Space work out of the box)
<button type="button" onClick={save}>Save</button>
```

### Labels

- Associate every form input with a `label` (`htmlFor` / `for`).
- Add `aria-label` to icon-only buttons.
- Image `alt` text should describe the content; use `alt=""` for purely decorative images.

### Keyboard operation basics

- Everything should be reachable via Tab, operable with Enter/Space, and modals should close
  with Esc.
- Don't remove the focus ring via CSS. If you do, provide an alternative visible style.
- When a modal opens, move focus into it, and restore focus to the triggering element when it
  closes.
- Before building custom UI, consider whether a native element or a proven headless UI library
  already covers the need.

## Related

- For reviews, use the react-reviewer / typescript-reviewer subagents, or `/code-review`.
- For Next.js-specific concerns (Server/Client boundaries, Server Actions, caching, etc.), use
  the nextjs-reviewer.
- For usability and consistency (UI/UX) concerns, use the ui-reviewer.
- Treat this skill as the decision criteria to apply during implementation and refactoring;
  delegate the actual application of review criteria to the subagents listed above.
