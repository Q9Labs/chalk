# Chalk Web App

Marketing site and official web app for Chalk video conferencing SDK. Built with Vite, React 19, TanStack Router.

## Routing

File-based routing in `src/routes/`:

- Routes auto-generated from files
- Layout in `src/routes/__root.tsx`
- `<Outlet />` renders child routes

**Add route:** Create file in `src/routes/` (TanStack auto-generates)

**Navigation:**

```tsx
import { Link } from "@tanstack/react-router";
<Link to="/about">About</Link>;
```

## Data Fetching

**TanStack Router Loader:**

```tsx
loader: async () => {
  const res = await fetch("https://api.example.com/data");
  return res.json();
};
```

**TanStack Query:**

```tsx
const { data } = useQuery({
  queryKey: ["people"],
  queryFn: () => fetch("/api/people").then((r) => r.json()),
});
```

## State Management

TanStack Store:

```tsx
import { Store, useStore } from "@tanstack/react-store";

const countStore = new Store(0);

function App() {
  const count = useStore(countStore);
  return <button onClick={() => countStore.setState((n) => n + 1)}>{count}</button>;
}
```

See [TanStack docs](https://tanstack.com) for more
