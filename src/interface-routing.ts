export type InterfaceMode = 'observer' | 'admin';

export interface InterfaceRoute {
  mode: InterfaceMode;
  contentPath: string;
}

export function parseInterfaceRoute(path: string): InterfaceRoute {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (normalized === '/admin' || normalized === '/admin/') return { mode: 'admin', contentPath: '/' };
  if (normalized.startsWith('/admin/')) return { mode: 'admin', contentPath: normalized.slice('/admin'.length) };
  return { mode: 'observer', contentPath: normalized };
}

export function interfaceRoutePath(mode: InterfaceMode, path: string) {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return mode === 'admin' ? `/admin${normalized === '/' ? '/' : normalized}` : normalized;
}
