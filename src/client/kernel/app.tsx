import { useMemo } from 'react';
import { RouterProvider } from './router';
import { SessionProvider } from './session';
import { AppShell } from './shell';
import { KERNEL_ROUTES } from './routes';
import { ROUTES } from '../generated/registry';

export function App() {
  // Module routes take precedence: if a module ships its own /search or /login,
  // the shell's version stands down rather than shadowing it.
  const routes = useMemo(() => {
    const claimed = new Set(ROUTES.map((route) => route.path));
    return [...ROUTES, ...KERNEL_ROUTES.filter((route) => !claimed.has(route.path))];
  }, []);

  return (
    <SessionProvider>
      <RouterProvider routes={routes}>
        <AppShell />
      </RouterProvider>
    </SessionProvider>
  );
}
