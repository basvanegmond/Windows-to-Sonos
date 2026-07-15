---
paths:
  - "src/components/**"
  - "app/**/*.tsx"
---

# Frontend Rules

## Components
- Functional components only — no class components
- One component per file
- Props typed with TypeScript interfaces
- No prop drilling past 2 levels — use context or a state store

## State management
- Local state: useState / useReducer
- Global state: [your state library, e.g. Zustand]
- No business logic in components — extract to hooks

## Performance
- Memoize expensive computations with useMemo
- Stabilise callback references with useCallback
- Lazy-load heavy components with React.lazy

## Accessibility
- All interactive elements keyboard-navigable
- Images have meaningful alt text
- Colour contrast meets WCAG AA minimum
