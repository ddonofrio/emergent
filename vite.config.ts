import { defineConfig } from 'vite';

const configuredBase = process.env.BASE_PATH?.trim() || '/emergent/';
const base = configuredBase === '/' ? '/' : `/${configuredBase.replace(/^\/+|\/+$/g, '')}/`;

export default defineConfig({ base });
