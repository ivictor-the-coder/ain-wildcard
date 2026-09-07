/**
 * Screens the shell itself owns. They are merged after the module registry, so
 * a module that later claims `/search` or `/login` wins and these step aside.
 */
import type { RouteDef } from './registry-types';
import { AcceptInvitePage } from './accept';
import { LoginPage } from './login';
import { SearchPage } from './search';

export const KERNEL_ROUTES: RouteDef[] = [
  { path: '/login', element: LoginPage, title: 'Sign in', layout: 'bare' },
  // The other end of "Invite a teammate": public, because the person opening it
  // has no session yet — that is the whole point of the link.
  { path: '/accept', element: AcceptInvitePage, title: 'Accept your invitation', layout: 'bare' },
  { path: '/search', element: SearchPage, title: 'Search' },
];
