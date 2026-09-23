// Публичные параметры подключения (anon-ключ Supabase публичен по назначению; доступ ограничен RLS).
// Можно переопределить при сборке: SUPABASE_URL=… SUPABASE_ANON_KEY=… npm run build
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;

export const SUPABASE_URL = __SUPABASE_URL__;
export const SUPABASE_ANON_KEY = __SUPABASE_ANON_KEY__;
export const DEFAULT_TZ = "Europe/Moscow";
