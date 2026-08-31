/**
 * Screens the shell itself owns. They are merged after the module registry, so
 * a module that later claims `/search` or `/login` wins and these step aside.
 */
import type { RouteDef } from './registry-types';
import { LoginPage } from './login';
import { SearchPage } from './search';

export const KERNEL_ROUTES: RouteDef[] = [
  { path: '/login', element: LoginPage, title: 'Sign in', layout: 'bare' },
  { path: '/search', element: SearchPage, title: 'Search' },
];
