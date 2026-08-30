import { RouterProvider } from './router';
import { SessionProvider } from './session';
import { AppShell } from './shell';
import { ROUTES } from '../generated/registry';

export function App() {
  return (
    <SessionProvider>
      <RouterProvider routes={ROUTES}>
        <AppShell />
      </RouterProvider>
    </SessionProvider>
  );
}
