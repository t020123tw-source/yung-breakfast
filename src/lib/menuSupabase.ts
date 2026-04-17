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

export type MenuItemInsertPayload = Pick<
  MenuItemRow,
  'id' | 'name' | 'price' | 'category'
>

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

export function menuItemToInsertPayload(
  item: MenuItem,
  categories: MenuCategoryDef[],
): MenuItemInsertPayload {
  const c = categories.find((x) => x.id === item.categoryId)
  if (!c) {
    throw new Error(`找不到類別：${item.categoryId}`)
  }
  return {
    id: item.id,
    name: item.name,
    price: item.price,
    category: c.name,
  }
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

export async function insertMenuItemRow(row: MenuItemInsertPayload): Promise<void> {
  const { error } = await supabase.from('menu_items').insert(row)
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
