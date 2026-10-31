import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function loadEnvFile() {
  try {
    process.loadEnvFile(path.resolve(here, '../.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function readConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing Supabase configuration: ${missing.join(', ')}`);
  return {
    port: env.PORT || 4000,
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : 0,
    corsOrigins: env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
      : DEFAULT_ORIGINS
  };
}
