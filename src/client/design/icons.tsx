/**
 * The Ain icon set — ~100 hand-drawn glyphs on a 24×24 grid, stroked at 1.75
 * so they stay crisp at 16px and read at 20px. No icon font, no dependency:
 * every glyph is a path string in the table below.
 */
import type { CSSProperties, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  /** Rendered square size in px. 16 is the product default, 20 for headers. */
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  /** Give an icon an accessible name; without it the glyph is decorative. */
  title?: string;
}

export type IconComponent = (props: IconProps) => JSX.Element;

/** `s` = stroked paths, `f` = filled paths. */
interface IconSpec { s?: string[]; f?: string[] }

const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;

const P: Record<string, IconSpec> = {
  /* --- product navigation --- */
  dashboard: { s: ['M4 4.8A.8.8 0 0 1 4.8 4h4.4a.8.8 0 0 1 .8.8v5.4a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8z', 'M14 4.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v2.4a.8.8 0 0 1-.8.8h-4.4a.8.8 0 0 1-.8-.8z', 'M14 11.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v7.4a.8.8 0 0 1-.8.8h-4.4a.8.8 0 0 1-.8-.8z', 'M4 15.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v3.4a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8z'] },
  contacts: { s: ['M16 19v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V19', circle(9.5, 7.5, 3.5), 'M17 5.2a3.4 3.4 0 0 1 0 6.6', 'M21 19v-1.4a3.6 3.6 0 0 0-2.6-3.4'] },
  companies: { s: ['M3 20h18', 'M5 20V6.4a1 1 0 0 1 .7-.95l6-1.9a1 1 0 0 1 1.3.95V20', 'M13 9.5h4.6a1 1 0 0 1 1 1V20', 'M8 9h2M8 12.5h2M8 16h2'] },
  building: { s: ['M3 20h18', 'M5 20V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15', 'M15 10h3.5a1 1 0 0 1 1 1v9', 'M8 8h4M8 12h4M8 16h4'] },
  deals: { s: ['M3 7.5 12 3l9 4.5-9 4.5z', 'M3 12.2 12 16.7l9-4.5', 'M3 16.7 12 21.2l9-4.5'] },
  inbox: { s: ['M3.5 13h4l1.4 2.6a1 1 0 0 0 .9.5h4.4a1 1 0 0 0 .9-.5L16.5 13h4', 'M4.8 5h14.4a1 1 0 0 1 .96.73l1.3 6.5a1 1 0 0 1 .04.27V18a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1v-5.5a1 1 0 0 1 .04-.27l1.3-6.5A1 1 0 0 1 4.8 5z'] },
  tickets: { s: ['M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v2a2.5 2.5 0 0 0 0 5v2a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-2a2.5 2.5 0 0 0 0-5z', 'M14 6v2M14 11v2M14 16v2'] },
  campaigns: { s: ['M4 9.5v5a1 1 0 0 0 1 1h2.6L14 20V4L7.6 8.5H5a1 1 0 0 0-1 1z', 'M17.5 8.5a5 5 0 0 1 0 7', 'M20 6a8.5 8.5 0 0 1 0 12'] },
  workflows: { s: [circle(6, 6, 2.5), circle(18, 18, 2.5), 'M6 8.5V14a4 4 0 0 0 4 4h5.5', 'M13.5 5.5H18a2 2 0 0 1 2 2v8'] },
  agents: { s: ['M7 9h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z', 'M12 5.5V9', circle(12, 4, 1.4), 'M2.5 12.5v2M21.5 12.5v2'], f: [circle(9.5, 13.2, 1.05), circle(14.5, 13.2, 1.05)] },
  sparkles: { s: ['M11 3.5 12.6 8 17 9.6 12.6 11.2 11 15.6 9.4 11.2 5 9.6 9.4 8z', 'M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z'] },
  bot: { s: ['M6 8.5h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M12 4.5v4', circle(12, 3.4, 1.2)], f: [circle(9, 12.6, 1.1), circle(15, 12.6, 1.1)] },
  brain: { s: ['M12 5.2a2.7 2.7 0 0 0-5 1.4 2.6 2.6 0 0 0-1.4 4.6A2.8 2.8 0 0 0 6.6 16 2.7 2.7 0 0 0 12 15.4z', 'M12 5.2a2.7 2.7 0 0 1 5 1.4 2.6 2.6 0 0 1 1.4 4.6A2.8 2.8 0 0 1 17.4 16 2.7 2.7 0 0 1 12 15.4z', 'M12 5.2V20'] },

  /* --- revenue --- */
  invoice: { s: ['M6 3.5h9.5L19 7v13.5l-2.2-1.3-2.2 1.3-2.2-1.3-2.2 1.3-2.2-1.3L6 20.5z', 'M15 3.5V7h3.5', 'M9 11h7M9 14.5h5'] },
  'credit-card': { s: ['M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5z', 'M3 10.5h18', 'M6.5 14.5h3'] },
  receipt: { s: ['M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z', 'M9 8h6M9 11.5h6M9 15h3'] },
  coins: { s: [circle(9, 8, 4.5), 'M13.2 5.2A4.5 4.5 0 0 1 15 14.6', 'M4.5 13v3c0 1.7 2 3 4.5 3s4.5-1.3 4.5-3v-3', 'M13.6 16.9c2.7-.2 4.9-1.4 4.9-3v-3'] },
  wallet: { s: ['M3.5 7.5A1.5 1.5 0 0 1 5 6h11.5a1.5 1.5 0 0 1 1.5 1.5V9', 'M3.5 7.5v9A1.5 1.5 0 0 0 5 18h14a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 19 9H5a1.5 1.5 0 0 1-1.5-1.5z'], f: [circle(16.5, 13.5, 1.1)] },
  percent: { s: ['M18.5 5.5 5.5 18.5', circle(7.8, 7.8, 2.3), circle(16.2, 16.2, 2.3)] },
  gauge: { s: ['M4.2 17.5a9 9 0 1 1 15.6 0', 'M12 12.5 15.6 9'], f: [circle(12, 13.4, 1.3)] },
  target: { s: [circle(12, 12, 8.5), circle(12, 12, 4.6)], f: [circle(12, 12, 1.4)] },

  /* --- charts --- */
  'chart-line': { s: ['M4 4v15.2a.8.8 0 0 0 .8.8H20', 'M7.5 15.5 11 11l3 2.6 4.5-6'] },
  'chart-bar': { s: ['M4 4v15.2a.8.8 0 0 0 .8.8H20', 'M8 17v-4M12 17V8M16 17v-6'] },
  'chart-area': { s: ['M4 4v15.2a.8.8 0 0 0 .8.8H20', 'M7 16.5l3.4-4.6 3 2.2 4.6-6.1v8.5H7z'] },
  'chart-pie': { s: ['M12 3.2a8.8 8.8 0 1 0 8.8 8.8H12z', 'M15.6 3.9A8.8 8.8 0 0 1 20.1 8.4l-4.5 1.9z'] },
  'trending-up': { s: ['M3.5 16.5 9 11l3.5 3.2L20.5 6', 'M15.5 6h5v5'] },
  'trending-down': { s: ['M3.5 7.5 9 13l3.5-3.2L20.5 18', 'M15.5 18h5v-5'] },
  activity: { s: ['M3 12.5h3.6L9.4 5.5l4.4 13 2.6-6h4.6'] },
  funnel: { s: ['M3.5 5h17l-6.4 7.6V20l-4.2-2.4v-5z'] },
  layers: { s: ['M12 3.5 3.5 8 12 12.5 20.5 8z', 'M3.5 12.5 12 17l8.5-4.5', 'M3.5 16.8 12 21.3l8.5-4.5'] },

  /* --- actions --- */
  search: { s: [circle(11, 11, 6.4), 'M15.8 15.8 20.5 20.5'] },
  filter: { s: ['M4 5.5h16l-6.2 7.3V19l-3.6-2v-4.2z'] },
  'filter-x': { s: ['M4 5.5h16l-5 5.9', 'M10.2 12.6V17l3.6 2v-3', 'M16 15l5 5M21 15l-5 5'] },
  sliders: { s: ['M4 8h9M17 8h3M4 16h3M11 16h9', circle(15, 8, 2.1), circle(9, 16, 2.1)] },
  plus: { s: ['M12 5v14M5 12h14'] },
  'plus-circle': { s: [circle(12, 12, 8.6), 'M12 8.4v7.2M8.4 12h7.2'] },
  minus: { s: ['M5 12h14'] },
  check: { s: ['M4.8 12.6 9.6 17.4 19.2 6.8'] },
  'check-circle': { s: [circle(12, 12, 8.6), 'M8.3 12.2 11 14.9l4.9-5.6'] },
  'check-double': { s: ['M2.5 12.8 6 16.3l6.6-7.4', 'M10 16.3 13.5 12.8', 'M14.6 8.9 21.5 8.9'] },
  x: { s: ['M6 6l12 12M18 6 6 18'] },
  'x-circle': { s: [circle(12, 12, 8.6), 'M9.4 9.4l5.2 5.2M14.6 9.4l-5.2 5.2'] },
  edit: { s: ['M4 20h4l10.3-10.3a2.1 2.1 0 0 0-3-3L5 17v3z', 'M14.8 6.8l2.4 2.4'] },
  trash: { s: ['M4.5 6.5h15', 'M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5', 'M6.5 6.5 7.4 19a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9l.9-12.5', 'M10.3 10v6M13.7 10v6'] },
  copy: { s: ['M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5z', 'M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15H9'] },
  clipboard: { s: ['M9 5H7a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-12A1.5 1.5 0 0 0 17 5h-2', 'M9.5 3.5h5a1 1 0 0 1 1 1V6a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z'] },
  download: { s: ['M12 4v11', 'M7.6 10.8 12 15.2l4.4-4.4', 'M4.5 19.5h15'] },
  upload: { s: ['M12 20V9', 'M7.6 13.2 12 8.8l4.4 4.4', 'M4.5 4.5h15'] },
  send: { s: ['M20.5 3.5 3.5 10.4l6.7 2.9M20.5 3.5 13.6 20.5l-3.4-7.2M20.5 3.5l-10.3 9.8'] },
  refresh: { s: ['M19.5 11a7.6 7.6 0 0 0-13.4-3.6L4 9.6', 'M4.5 13a7.6 7.6 0 0 0 13.4 3.6L20 14.4', 'M4 5.4v4.2h4.2M20 18.6v-4.2h-4.2'] },
  'rotate-ccw': { s: ['M3.5 8.5A8.5 8.5 0 1 1 3.5 15', 'M3.5 4.5v4h4'] },
  repeat: { s: ['M6 8.5h11.5A2.5 2.5 0 0 1 20 11v1', 'M17.2 5.6 20 8.4l-2.8 2.8', 'M18 15.5H6.5A2.5 2.5 0 0 1 4 13v-1', 'M6.8 18.4 4 15.6l2.8-2.8'] },
  play: { s: ['M8 5.5 18.5 12 8 18.5z'] },
  pause: { s: ['M9 5.5v13M15 5.5v13'] },
  share: { s: [circle(6.5, 12, 2.4), circle(17, 6.5, 2.4), circle(17, 17.5, 2.4), 'M8.7 10.8 14.8 7.7M8.7 13.2l6.1 3.1'] },
  link: { s: ['M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1.4 1.4', 'M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1.4-1.4'] },
  external: { s: ['M18.5 13.5v5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5V7A1.5 1.5 0 0 1 5.5 5.5h5', 'M14 4h6v6M20 4l-8.5 8.5'] },
  paperclip: { s: ['M19.5 11.5 12 19a4.6 4.6 0 0 1-6.5-6.5l7.8-7.8a3.1 3.1 0 0 1 4.4 4.4l-7.8 7.8a1.6 1.6 0 0 1-2.2-2.2l7.1-7.1'] },
  pin: { s: ['M14.5 3.5 20.5 9.5', 'M15.6 4.6 13 10l-6 2.2 4.8 4.8L14 11l5.4-2.6z', 'M9.4 14.6 4.5 19.5'] },
  print: { s: ['M7 9V4.5h10V9', 'M7 17H5.5A1.5 1.5 0 0 1 4 15.5v-5A1.5 1.5 0 0 1 5.5 9h13a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H17', 'M7 14h10v5.5H7z'] },
  wand: { s: ['M4 20 15 9', 'M13.4 4.2l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z', 'M19.4 12.4l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z'] },

  /* --- chevrons + arrows --- */
  'chevron-up': { s: ['M6.5 14.5 12 9l5.5 5.5'] },
  'chevron-down': { s: ['M6.5 9.5 12 15l5.5-5.5'] },
  'chevron-left': { s: ['M14.5 6.5 9 12l5.5 5.5'] },
  'chevron-right': { s: ['M9.5 6.5 15 12l-5.5 5.5'] },
  'chevrons-up-down': { s: ['M8 10.2 12 6.2l4 4M8 13.8l4 4 4-4'] },
  'chevrons-left': { s: ['M11.5 6.5 6 12l5.5 5.5M18 6.5 12.5 12 18 17.5'] },
  'chevrons-right': { s: ['M12.5 6.5 18 12l-5.5 5.5M6 6.5 11.5 12 6 17.5'] },
  'arrow-up': { s: ['M12 19.5v-15M6 10.5 12 4.5l6 6'] },
  'arrow-down': { s: ['M12 4.5v15M6 13.5l6 6 6-6'] },
  'arrow-left': { s: ['M19.5 12h-15M10.5 6 4.5 12l6 6'] },
  'arrow-right': { s: ['M4.5 12h15M13.5 6l6 6-6 6'] },
  'arrow-up-right': { s: ['M6.5 17.5 17.5 6.5M8.5 6.5h9v9'] },
  'arrow-down-right': { s: ['M6.5 6.5 17.5 17.5M17.5 8.5v9h-9'] },
  'corner-down-right': { s: ['M5.5 4.5v8a2 2 0 0 0 2 2h11', 'M15 10.5 19 14.5 15 18.5'] },
  'git-branch': { s: [circle(6.5, 6, 2.3), circle(6.5, 18, 2.3), circle(17.5, 9, 2.3), 'M6.5 8.3v7.4', 'M17.5 11.3c0 3-2.4 4.4-5.5 4.7'] },

  /* --- objects --- */
  calendar: { s: ['M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z', 'M4 10.5h16', 'M8 4v4M16 4v4'] },
  'calendar-check': { s: ['M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z', 'M4 10.5h16', 'M8 4v4M16 4v4', 'M9 15.2l2.1 2.1 4-4.2'] },
  clock: { s: [circle(12, 12, 8.6), 'M12 7.2V12l3.2 2'] },
  mail: { s: ['M3.5 7.5A1.5 1.5 0 0 1 5 6h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5z', 'M3.8 7.2 12 13l8.2-5.8'] },
  phone: { s: ['M8.4 4.5H5.6a1.6 1.6 0 0 0-1.6 1.8C4.8 13.8 10.2 19.2 17.7 20a1.6 1.6 0 0 0 1.8-1.6v-2.8a1.2 1.2 0 0 0-.9-1.16l-2.7-.7a1.2 1.2 0 0 0-1.24.44l-.9 1.16a11.6 11.6 0 0 1-4.6-4.6l1.16-.9a1.2 1.2 0 0 0 .44-1.24l-.7-2.7a1.2 1.2 0 0 0-1.16-.9z'] },
  'message-square': { s: ['M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H9.5L5 20v-4H5.5A1.5 1.5 0 0 1 4 14.5z'] },
  'message-circle': { s: ['M20.5 11.6c0 4.2-3.8 7.6-8.5 7.6a9.6 9.6 0 0 1-3.1-.5L4 20.2l1.6-4a7.1 7.1 0 0 1-2.1-4.9C3.5 7.4 7.3 4 12 4s8.5 3.4 8.5 7.6z'] },
  note: { s: ['M5.5 4.5h13a1 1 0 0 1 1 1v9.2a1 1 0 0 1-.3.7l-4.3 4.3a1 1 0 0 1-.7.3H5.5a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z', 'M19.3 14.4H14.5v4.8', 'M8 8.5h8M8 12h5'] },
  'file-text': { s: ['M6 3.5h7.5L19 9v11.5H6z', 'M13.5 3.5V9H19', 'M9 12.5h7M9 16h5'] },
  folder: { s: ['M3.5 6.5a1 1 0 0 1 1-1h4l2 2.5h8a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-14a1 1 0 0 1-1-1z'] },
  book: { s: ['M4.5 5.2A1.7 1.7 0 0 1 6.2 3.5H19v14H6.2a1.7 1.7 0 0 0-1.7 1.7z', 'M4.5 19.2A1.7 1.7 0 0 1 6.2 17.5H19v3H6.2a1.7 1.7 0 0 1-1.7-1.3z', 'M8.5 7.5h6.5'] },
  code: { s: ['M8.5 8 4 12l4.5 4M15.5 8 20 12l-4.5 4M13.6 5.5l-3.2 13'] },
  terminal: { s: ['M4 5.5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z', 'M7 9.5 10 12l-3 2.5M12.5 15h4.5'] },
  database: { s: ['M4.5 6.5c0-1.4 3.4-2.5 7.5-2.5s7.5 1.1 7.5 2.5-3.4 2.5-7.5 2.5-7.5-1.1-7.5-2.5z', 'M4.5 6.5v11c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-11', 'M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5'] },
  server: { s: ['M4 5.5h16a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z', 'M4 13.5h16a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z'], f: [circle(7, 8, 1), circle(7, 16, 1)] },
  globe: { s: [circle(12, 12, 8.6), 'M3.6 12h16.8', 'M12 3.4c2.2 2.4 3.3 5.4 3.3 8.6s-1.1 6.2-3.3 8.6c-2.2-2.4-3.3-5.4-3.3-8.6S9.8 5.8 12 3.4z'] },
  'map-pin': { s: ['M12 21c4-4.4 6-7.7 6-10a6 6 0 1 0-12 0c0 2.3 2 5.6 6 10z', circle(12, 10.6, 2.3)] },
  tag: { s: ['M4 11.4V5.4a1.4 1.4 0 0 1 1.4-1.4h6l8.2 8.2a1.4 1.4 0 0 1 0 2l-5.6 5.6a1.4 1.4 0 0 1-2 0z'], f: [circle(8.4, 8.4, 1.3)] },
  briefcase: { s: ['M4 8.5h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z', 'M9 8.5V6.4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2.1', 'M3 12.8c2.6 1.2 5.7 1.9 9 1.9s6.4-.7 9-1.9'] },
  gift: { s: ['M3.5 9.5h17v3h-17z', 'M5 12.5h14v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z', 'M12 9.5v11', 'M12 9.5S10.6 4 8.2 4a2.2 2.2 0 0 0 0 5.5z', 'M12 9.5S13.4 4 15.8 4a2.2 2.2 0 0 1 0 5.5z'] },
  star: { s: ['M12 3.8 14.6 9l5.7.9-4.1 4 1 5.7-5.2-2.8-5.2 2.8 1-5.7-4.1-4L9.4 9z'] },
  bookmark: { s: ['M6.5 4.5h11a1 1 0 0 1 1 1v14.4l-6.5-4-6.5 4V5.5a1 1 0 0 1 1-1z'] },
  flag: { s: ['M5.5 20V4.5', 'M5.5 5.2h11.8l-1.8 3.6 1.8 3.6H5.5'] },
  zap: { s: ['M13.4 3 5.5 13.5h5.6L10.6 21l7.9-10.5h-5.6z'] },
  cpu: { s: ['M8 8h8v8H8z', 'M6 6h12v12H6z', 'M9.5 3.5V6M14.5 3.5V6M9.5 18v2.5M14.5 18v2.5M3.5 9.5H6M3.5 14.5H6M18 9.5h2.5M18 14.5h2.5'] },
  key: { s: [circle(7.6, 15.4, 3.6), 'M10.2 12.8 19.5 3.5', 'M16.5 6.5 19 9M14.4 8.6l2.2 2.2'] },
  lock: { s: ['M6.5 10.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z', 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5'] },
  shield: { s: ['M12 3.5 19.5 6v6c0 4-3.1 7.2-7.5 8.5C7.6 19.2 4.5 16 4.5 12V6z', 'M9.2 12.2 11.3 14.3l3.7-4'] },
  eye: { s: ['M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z', circle(12, 12, 2.8)] },
  'eye-off': { s: ['M4 4 20 20', 'M9.6 9.7a2.8 2.8 0 0 0 3.9 3.9', 'M6.6 6.8C4.2 8.4 2.5 12 2.5 12s3.5 5.5 9.5 5.5a9.8 9.8 0 0 0 4.2-.9', 'M18.2 15.6c2.1-1.6 3.3-3.6 3.3-3.6S18 6.5 12 6.5a9.4 9.4 0 0 0-2 .2'] },
  bell: { s: ['M6 16.5h12l-1.3-2.2V10.6a4.7 4.7 0 0 0-9.4 0v3.7z', 'M10.2 19a2 2 0 0 0 3.6 0'] },
  user: { s: [circle(12, 8, 3.8), 'M4.8 20a7.2 7.2 0 0 1 14.4 0'] },
  users: { s: [circle(9.5, 8, 3.4), 'M3 19.5a6.5 6.5 0 0 1 13 0', 'M16.4 5.2a3.4 3.4 0 0 1 0 6.4', 'M18 15.2a5.2 5.2 0 0 1 3 4.3'] },
  logout: { s: ['M14 4.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 19.5h8', 'M17 8.5 20.5 12 17 15.5', 'M20 12H10'] },
  login: { s: ['M10 4.5h8A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5h-8', 'M7 8.5 3.5 12 7 15.5', 'M4 12h10'] },
  settings: { s: ['M11 3.5h2a.9.9 0 0 1 .9.8l.2 1.6 1.7.7 1.3-1a.9.9 0 0 1 1.2.1l1.4 1.4a.9.9 0 0 1 .1 1.2l-1 1.3.7 1.7 1.6.2a.9.9 0 0 1 .8.9v2a.9.9 0 0 1-.8.9l-1.6.2-.7 1.7 1 1.3a.9.9 0 0 1-.1 1.2l-1.4 1.4a.9.9 0 0 1-1.2.1l-1.3-1-1.7.7-.2 1.6a.9.9 0 0 1-.9.8h-2a.9.9 0 0 1-.9-.8l-.2-1.6-1.7-.7-1.3 1a.9.9 0 0 1-1.2-.1l-1.4-1.4a.9.9 0 0 1-.1-1.2l1-1.3-.7-1.7-1.6-.2a.9.9 0 0 1-.8-.9v-2a.9.9 0 0 1 .8-.9l1.6-.2.7-1.7-1-1.3a.9.9 0 0 1 .1-1.2l1.4-1.4a.9.9 0 0 1 1.2-.1l1.3 1 1.7-.7.2-1.6a.9.9 0 0 1 .9-.8z', circle(12, 12, 2.8)] },
  command: { s: ['M8.5 15.5v-7h7v7z', 'M8.5 8.5a2.25 2.25 0 1 0-2.25 2.25H8.5z', 'M15.5 8.5a2.25 2.25 0 1 1 2.25 2.25H15.5z', 'M8.5 15.5a2.25 2.25 0 1 1-2.25-2.25H8.5z', 'M15.5 15.5a2.25 2.25 0 1 0 2.25-2.25H15.5z'] },
  menu: { s: ['M4 7h16M4 12h16M4 17h16'] },
  list: { s: ['M8.5 6.5h11.5M8.5 12h11.5M8.5 17.5h11.5'], f: [circle(4.6, 6.5, 1.2), circle(4.6, 12, 1.2), circle(4.6, 17.5, 1.2)] },
  grid: { s: ['M4 4.8A.8.8 0 0 1 4.8 4h4.4a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8z', 'M14 4.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8h-4.4a.8.8 0 0 1-.8-.8z', 'M4 14.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8z', 'M14 14.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8h-4.4a.8.8 0 0 1-.8-.8z'] },
  columns: { s: ['M4 5.5h16a.5.5 0 0 1 .5.5v12a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V6a.5.5 0 0 1 .5-.5z', 'M9.3 5.5v13M14.7 5.5v13'] },
  table: { s: ['M4 5.5h16a.5.5 0 0 1 .5.5v12a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V6a.5.5 0 0 1 .5-.5z', 'M3.5 10h17M10 10v8.5'] },
  grip: { f: [circle(9, 6, 1.35), circle(15, 6, 1.35), circle(9, 12, 1.35), circle(15, 12, 1.35), circle(9, 18, 1.35), circle(15, 18, 1.35)] },
  more: { f: [circle(5.5, 12, 1.6), circle(12, 12, 1.6), circle(18.5, 12, 1.6)] },
  'more-vertical': { f: [circle(12, 5.5, 1.6), circle(12, 12, 1.6), circle(12, 18.5, 1.6)] },
  'sort-asc': { s: ['M7 20V5M3.5 8.5 7 5l3.5 3.5', 'M13.5 7.5h7M13.5 12h5M13.5 16.5h3'] },
  'sort-desc': { s: ['M7 4v15M3.5 15.5 7 19l3.5-3.5', 'M13.5 7.5h3M13.5 12h5M13.5 16.5h7'] },
  maximize: { s: ['M4 9.5V5a1 1 0 0 1 1-1h4.5M14.5 4H19a1 1 0 0 1 1 1v4.5M20 14.5V19a1 1 0 0 1-1 1h-4.5M9.5 20H5a1 1 0 0 1-1-1v-4.5'] },
  minimize: { s: ['M9.5 4v4.5a1 1 0 0 1-1 1H4M15.5 9.5a1 1 0 0 1-1-1V4M14.5 20v-4.5a1 1 0 0 1 1-1H20M4 14.5h4.5a1 1 0 0 1 1 1V20'] },
  sun: { s: [circle(12, 12, 4), 'M12 2.5v2.2M12 19.3v2.2M4.7 4.7 6.3 6.3M17.7 17.7l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.7 19.3 6.3 17.7M17.7 6.3l1.6-1.6'] },
  moon: { s: ['M20 14.4A8.6 8.6 0 0 1 9.6 4 8.6 8.6 0 1 0 20 14.4z'] },
  smile: { s: [circle(12, 12, 8.6), 'M8.6 13.8a4.2 4.2 0 0 0 6.8 0'], f: [circle(9.3, 10, 1.05), circle(14.7, 10, 1.05)] },
  'thumbs-up': { s: ['M7.5 10.5 11 4a2.2 2.2 0 0 1 2.2 2.2V9.5h4.6a1.8 1.8 0 0 1 1.76 2.16l-1.1 5.5a1.8 1.8 0 0 1-1.76 1.44H7.5z', 'M7.5 10.5H4.5v8.1h3z'] },
  'alert-triangle': { s: ['M10.7 4.4 2.9 17.8a1.5 1.5 0 0 0 1.3 2.2h15.6a1.5 1.5 0 0 0 1.3-2.2L13.3 4.4a1.5 1.5 0 0 0-2.6 0z', 'M12 9.5v4'], f: [circle(12, 16.6, 1.05)] },
  'alert-circle': { s: [circle(12, 12, 8.6), 'M12 7.6v5'], f: [circle(12, 15.9, 1.05)] },
  'alert-octagon': { s: ['M8.4 3.5h7.2l5 5v7.2l-5 5H8.4l-5-5V8.5z', 'M12 7.6v5'], f: [circle(12, 15.9, 1.05)] },
  info: { s: [circle(12, 12, 8.6), 'M12 11.2v5'], f: [circle(12, 8.1, 1.05)] },
  help: { s: [circle(12, 12, 8.6), 'M9.6 9.6a2.5 2.5 0 1 1 3.2 2.4c-.6.2-.8.7-.8 1.3v.6'], f: [circle(12, 16.4, 1.05)] },
  hash: { s: ['M5 9.5h14M4.5 15h14M10 4.5 8 19.5M16 4.5l-2 15'] },
  'at-sign': { s: [circle(12, 12, 3.6), 'M15.6 8.4v4.5a2.7 2.7 0 0 0 5.4 0V12a9 9 0 1 0-3.5 7.1'] },
  home: { s: ['M3.5 11 12 4l8.5 7', 'M5.6 9.4V19a1 1 0 0 0 1 1h10.8a1 1 0 0 0 1-1V9.4', 'M9.8 20v-5.4h4.4V20'] },
  bolt: { s: ['M11 3 4.5 13h5.2l-1 8L16.5 11h-5.2z'] },
};

/** Every icon name in the set — useful for pickers and the style guide. */
export type IconName = keyof typeof P;
export const ICON_NAMES = Object.keys(P).sort() as IconName[];

function make(name: IconName): IconComponent {
  const spec = P[name];
  function AinIcon({ size = 16, strokeWidth, className, title, style, ...rest }: IconProps) {
    // Keep the optical weight even as the glyph scales: 1.75 at 16px, 1.6 at 24.
    const sw = strokeWidth ?? (size >= 24 ? 1.6 : size >= 20 ? 1.7 : 1.75);
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style}
        role={title ? 'img' : undefined}
        aria-hidden={title ? undefined : true}
        aria-label={title}
        focusable="false"
        {...rest}
      >
        {title ? <title>{title}</title> : null}
        {spec.s?.map((d, i) => <path key={`s${i}`} d={d} />)}
        {spec.f?.map((d, i) => <path key={`f${i}`} d={d} fill="currentColor" stroke="none" />)}
      </svg>
    );
  }
  AinIcon.displayName = `Icon(${name})`;
  return AinIcon;
}

export const Icons = Object.fromEntries(ICON_NAMES.map((n) => [n, make(n)])) as Record<IconName, IconComponent>;

/** Look an icon up by name; unknown names fall back to a neutral dot. */
export const iconByName = (name: string): IconComponent => Icons[name as IconName] ?? Icons.more;

export const DashboardIcon = Icons.dashboard;
export const ContactsIcon = Icons.contacts;
export const CompaniesIcon = Icons.companies;
export const BuildingIcon = Icons.building;
export const DealsIcon = Icons.deals;
export const InboxIcon = Icons.inbox;
export const TicketsIcon = Icons.tickets;
export const CampaignsIcon = Icons.campaigns;
export const WorkflowsIcon = Icons.workflows;
export const AgentsIcon = Icons.agents;
export const SparklesIcon = Icons.sparkles;
export const BotIcon = Icons.bot;
export const BrainIcon = Icons.brain;
export const InvoiceIcon = Icons.invoice;
export const CreditCardIcon = Icons['credit-card'];
export const ReceiptIcon = Icons.receipt;
export const CoinsIcon = Icons.coins;
export const WalletIcon = Icons.wallet;
export const PercentIcon = Icons.percent;
export const GaugeIcon = Icons.gauge;
export const TargetIcon = Icons.target;
export const ChartLineIcon = Icons['chart-line'];
export const ChartBarIcon = Icons['chart-bar'];
export const ChartAreaIcon = Icons['chart-area'];
export const ChartPieIcon = Icons['chart-pie'];
export const TrendingUpIcon = Icons['trending-up'];
export const TrendingDownIcon = Icons['trending-down'];
export const ActivityIcon = Icons.activity;
export const FunnelIcon = Icons.funnel;
export const LayersIcon = Icons.layers;
export const SearchIcon = Icons.search;
export const FilterIcon = Icons.filter;
export const FilterXIcon = Icons['filter-x'];
export const SlidersIcon = Icons.sliders;
export const PlusIcon = Icons.plus;
export const PlusCircleIcon = Icons['plus-circle'];
export const MinusIcon = Icons.minus;
export const CheckIcon = Icons.check;
export const CheckCircleIcon = Icons['check-circle'];
export const CheckDoubleIcon = Icons['check-double'];
export const XIcon = Icons.x;
export const XCircleIcon = Icons['x-circle'];
export const EditIcon = Icons.edit;
export const TrashIcon = Icons.trash;
export const CopyIcon = Icons.copy;
export const ClipboardIcon = Icons.clipboard;
export const DownloadIcon = Icons.download;
export const UploadIcon = Icons.upload;
export const SendIcon = Icons.send;
export const RefreshIcon = Icons.refresh;
export const RotateCcwIcon = Icons['rotate-ccw'];
export const RepeatIcon = Icons.repeat;
export const PlayIcon = Icons.play;
export const PauseIcon = Icons.pause;
export const ShareIcon = Icons.share;
export const LinkIcon = Icons.link;
export const ExternalIcon = Icons.external;
export const PaperclipIcon = Icons.paperclip;
export const PinIcon = Icons.pin;
export const PrintIcon = Icons.print;
export const WandIcon = Icons.wand;
export const ChevronUpIcon = Icons['chevron-up'];
export const ChevronDownIcon = Icons['chevron-down'];
export const ChevronLeftIcon = Icons['chevron-left'];
export const ChevronRightIcon = Icons['chevron-right'];
export const ChevronsUpDownIcon = Icons['chevrons-up-down'];
export const ChevronsLeftIcon = Icons['chevrons-left'];
export const ChevronsRightIcon = Icons['chevrons-right'];
export const ArrowUpIcon = Icons['arrow-up'];
export const ArrowDownIcon = Icons['arrow-down'];
export const ArrowLeftIcon = Icons['arrow-left'];
export const ArrowRightIcon = Icons['arrow-right'];
export const ArrowUpRightIcon = Icons['arrow-up-right'];
export const ArrowDownRightIcon = Icons['arrow-down-right'];
export const CornerDownRightIcon = Icons['corner-down-right'];
export const GitBranchIcon = Icons['git-branch'];
export const CalendarIcon = Icons.calendar;
export const CalendarCheckIcon = Icons['calendar-check'];
export const ClockIcon = Icons.clock;
export const MailIcon = Icons.mail;
export const PhoneIcon = Icons.phone;
export const MessageSquareIcon = Icons['message-square'];
export const MessageCircleIcon = Icons['message-circle'];
export const NoteIcon = Icons.note;
export const FileTextIcon = Icons['file-text'];
export const FolderIcon = Icons.folder;
export const BookIcon = Icons.book;
export const CodeIcon = Icons.code;
export const TerminalIcon = Icons.terminal;
export const DatabaseIcon = Icons.database;
export const ServerIcon = Icons.server;
export const GlobeIcon = Icons.globe;
export const MapPinIcon = Icons['map-pin'];
export const TagIcon = Icons.tag;
export const BriefcaseIcon = Icons.briefcase;
export const GiftIcon = Icons.gift;
export const StarIcon = Icons.star;
export const BookmarkIcon = Icons.bookmark;
export const FlagIcon = Icons.flag;
export const ZapIcon = Icons.zap;
export const CpuIcon = Icons.cpu;
export const KeyIcon = Icons.key;
export const LockIcon = Icons.lock;
export const ShieldIcon = Icons.shield;
export const EyeIcon = Icons.eye;
export const EyeOffIcon = Icons['eye-off'];
export const BellIcon = Icons.bell;
export const UserIcon = Icons.user;
export const UsersIcon = Icons.users;
export const LogoutIcon = Icons.logout;
export const LoginIcon = Icons.login;
export const SettingsIcon = Icons.settings;
export const CommandIcon = Icons.command;
export const MenuIcon = Icons.menu;
export const ListIcon = Icons.list;
export const GridIcon = Icons.grid;
export const ColumnsIcon = Icons.columns;
export const TableIcon = Icons.table;
export const GripIcon = Icons.grip;
export const MoreIcon = Icons.more;
export const MoreVerticalIcon = Icons['more-vertical'];
export const SortAscIcon = Icons['sort-asc'];
export const SortDescIcon = Icons['sort-desc'];
export const MaximizeIcon = Icons.maximize;
export const MinimizeIcon = Icons.minimize;
export const SunIcon = Icons.sun;
export const MoonIcon = Icons.moon;
export const SmileIcon = Icons.smile;
export const ThumbsUpIcon = Icons['thumbs-up'];
export const AlertTriangleIcon = Icons['alert-triangle'];
export const AlertCircleIcon = Icons['alert-circle'];
export const AlertOctagonIcon = Icons['alert-octagon'];
export const InfoIcon = Icons.info;
export const HelpIcon = Icons.help;
export const HashIcon = Icons.hash;
export const AtSignIcon = Icons['at-sign'];
export const HomeIcon = Icons.home;
export const BoltIcon = Icons.bolt;
