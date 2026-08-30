import type { NavItem, RouteDef } from '../../kernel/registry-types';
import { useSession } from '../../kernel/session';

function Home() {
  const { me } = useSession();
  return (
    <div style={{ padding: 32 }}>
      <h1>Good to see you{me?.user ? `, ${me.user.name.split(' ')[0]}` : ''}</h1>
      <p style={{ color: 'var(--text-secondary)', marginTop: 8 }}>
        {me?.org.name} · workspace ready.
      </p>
    </div>
  );
}

export const routes: RouteDef[] = [{ path: '/', element: Home, title: 'Home' }];
export const nav: NavItem[] = [{ id: 'home', label: 'Home', to: '/', group: 'workspace', order: 0, icon: '⌂' }];
