import { defineConfig } from 'vite';

const configuredBase = process.env.BASE_PATH?.trim() || '/';
const base = configuredBase === '/' ? '/' : `/${configuredBase.replace(/^\/+|\/+$/g, '')}/`;

export default defineConfig({ base });
