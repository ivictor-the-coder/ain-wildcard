import { useMemo } from 'react';
import { Link, useIsActive, useRouter } from './router';
import { useSession } from './session';
import { NAV } from '../generated/registry';
import type { NavGroup, NavItem } from './registry-types';
import './shell.css';

const GROUP_LABEL: Record<NavGroup, string> = {
  workspace: '', crm: 'Customers', engage: 'Engage', revenue: 'Revenue',
  automation: 'Automation', insights: 'Insights', settings: '',
};
const GROUP_ORDER: NavGroup[] = ['workspace', 'crm', 'engage', 'revenue', 'automation', 'insights', 'settings'];

export function AppShell() {
  const { route, params } = useRouter();
  const session = useSession();
  const grouped = useMemo(() => {
    const map = new Map<NavGroup, NavItem[]>();
    for (const item of NAV) {
      const arr = map.get(item.group) || [];
      arr.push(item);
      map.set(item.group, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.order - b.order);
    return map;
  }, []);

  if (session.loading && !session.me) {
    return <div className="shell-boot"><div className="shell-boot__spinner" aria-label="Loading" /></div>;
  }

  const Element = route?.element;
  const layout = route?.layout ?? 'app';

  if (!Element) {
    return (
      <div className="shell-empty">
        <h1>Page not found</h1>
        <p>Nothing is registered for this address.</p>
        <Link to="/">Back to the dashboard</Link>
      </div>
    );
  }
  if (layout === 'bare') return <Element {...params} />;

  return (
    <div className="shell">
      <nav className="shell__nav" aria-label="Primary">
        <Link to="/" className="shell__brand">
          <span className="shell__mark" aria-hidden>◈</span>
          <span className="shell__brandname">{session.me?.org.name ?? 'Ain'}</span>
        </Link>
        <div className="shell__navscroll">
          {GROUP_ORDER.map((group) => {
            const items = grouped.get(group);
            if (!items?.length) return null;
            return (
              <div className="shell__group" key={group}>
                {GROUP_LABEL[group] && <div className="shell__grouplabel">{GROUP_LABEL[group]}</div>}
                {items.map((item) => <NavLink key={item.id} item={item} />)}
              </div>
            );
          })}
        </div>
      </nav>
      <main className="shell__main">
        <Element {...params} />
      </main>
    </div>
  );
}

function NavLink({ item }: { item: NavItem }) {
  const active = useIsActive(item.to, item.to === '/');
  const Icon = typeof item.icon === 'string' ? null : item.icon;
  return (
    <Link to={item.to} className={`shell__link${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}>
      <span className="shell__icon" aria-hidden>{Icon ? <Icon size={16} /> : String(item.icon)}</span>
      <span className="u-truncate">{item.label}</span>
      {item.badge && <span className="shell__badge">{item.badge()}</span>}
    </Link>
  );
}
