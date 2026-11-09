const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

export const appPath = (path: string) => `${basePath}${path.startsWith('/') ? path : `/${path}`}`;

export const routePath = () => {
  const path = window.location.pathname;
  return basePath && path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : path;
};
