import type { ReactNode, ComponentType } from 'react';

export interface RouteDef {
  /** Pattern with `:params`, e.g. `/contacts/:id`. */
  path: string;
  element: ComponentType<any>;
  /** Document title fragment. Receives resolved params. */
  title?: string | ((params: Record<string, string>) => string);
  /** `app` renders inside the shell (default); `bare` is full-bleed (login, portal). */
  layout?: 'app' | 'bare' | 'focus';
}

export type NavGroup = 'workspace' | 'crm' | 'engage' | 'revenue' | 'automation' | 'insights' | 'settings';

export interface NavItem {
  id: string;
  label: string;
  to: string;
  group: NavGroup;
  order: number;
  icon: ComponentType<{ size?: number; className?: string }> | string;
  /** Sub-navigation rendered when the section is active. */
  children?: { label: string; to: string; id: string }[];
  badge?: () => ReactNode;
  /** Hide for roles below this. */
  minRole?: 'owner' | 'admin' | 'member' | 'analyst' | 'readonly';
}

export interface CommandDef {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  keywords?: string[];
  shortcut?: string;
  icon?: ComponentType<{ size?: number }> | string;
  run(nav: (to: string) => void): void | Promise<void>;
}

export interface WidgetDef {
  id: string;
  title: string;
  description?: string;
  /** Grid width in 12-column units. */
  span: number;
  minSpan?: number;
  component: ComponentType<any>;
  group?: string;
}

export interface SettingsPage {
  id: string;
  label: string;
  group: string;
  order: number;
  path: string;
  element: ComponentType<any>;
  description?: string;
}
