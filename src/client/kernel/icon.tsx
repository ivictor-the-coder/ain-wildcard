import type { ComponentType, ReactNode } from 'react';
import { iconByName } from '../design';

export type IconRef = ComponentType<{ size?: number; className?: string }> | string;

/**
 * Modules may register a nav or command icon either as a component or as a name
 * from the icon set. A name that is not in the set falls back to a neutral
 * glyph rather than rendering the raw string into the sidebar.
 */
export function renderIcon(icon: IconRef | undefined, size = 16): ReactNode {
  if (!icon) return null;
  if (typeof icon === 'string') {
    // A single character is a deliberate glyph ("⌂"), not an icon name.
    if ([...icon].length === 1 && !/[a-z]/i.test(icon)) return <span aria-hidden>{icon}</span>;
    const Named = iconByName(icon);
    return <Named size={size} />;
  }
  const Component = icon;
  return <Component size={size} />;
}
