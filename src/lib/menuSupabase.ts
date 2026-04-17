import type { MenuCategoryDef, MenuItem } from '../data/menuData'
import { supabase } from './supabaseClient'

/**
 * 與 Supabase public.menu_items 實際欄位一致：
 * id, name, price, category, created_at
 */
export type MenuItemRow = {
  id: string
  name: string
  price: number
  category: string
  created_at?: string
}

/** insert 時僅送 name / price / category（id、created_at 由資料庫處理） */
export type MenuItemMinimalInsert = {
  name: string
  price: number
  category: string
}

function categoryDefFromLabel(label: string): MenuCategoryDef {
  return { id: label, name: label }
}

export function menuFromRows(rows: MenuItemRow[]): {
  categories: MenuCategoryDef[]
  menu: MenuItem[]
} {
  const categories: MenuCategoryDef[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const label = r.category ?? ''
    if (!label || seen.has(label)) continue
    seen.add(label)
    categories.push(categoryDefFromLabel(label))
  }
  const menu: MenuItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    price: r.price,
    categoryId: r.category,
  }))
  return { categories, menu }
}

export async function fetchMenuFromSupabase(): Promise<{
  categories: MenuCategoryDef[]
  menu: MenuItem[]
}> {
  const { data, error } = await supabase
    .from('menu_items')
    .select('id, name, price, category')
    .order('category', { ascending: true })
    .order('name', { ascending: true })

  if (error) throw error
  const rows = (data ?? []) as MenuItemRow[]
  return menuFromRows(rows)
}

export async function insertMenuItemRow(row: MenuItemMinimalInsert): Promise<void> {
  const priceNum = Number(row.price)
  const priceInt = Number.isFinite(priceNum)
    ? Math.min(999999, Math.max(0, Math.round(priceNum)))
    : 0
  const payload: MenuItemMinimalInsert = {
    name: String(row.name ?? '').trim(),
    price: priceInt,
    category: String(row.category ?? '').trim(),
  }
  if (!payload.name) throw new Error('餐點名稱不可為空')
  if (!payload.category) throw new Error('類別不可為空')
  const { error } = await supabase.from('menu_items').insert(payload)
  if (error) throw error
}

export async function deleteMenuItemById(id: string): Promise<void> {
  const { error } = await supabase.from('menu_items').delete().eq('id', id)
  if (error) throw error
}

export async function deleteMenuItemsByCategoryName(
  categoryName: string,
): Promise<void> {
  const { error } = await supabase
    .from('menu_items')
    .delete()
    .eq('category', categoryName)
  if (error) throw error
}
