import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    '缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY，請於 .env 設定 Supabase 連線。',
  )
}

export const supabase = createClient(url, anonKey)
