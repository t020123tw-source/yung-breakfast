import type { MenuCategoryDef, MenuItem } from '../data/menuData'
import { supabase } from './supabaseClient'

/**
 * 與 public.menu_items 欄位對應（snake_case）。
 * 類別資訊與品項同列（denormalized），以便單表還原 MenuCategoryDef + MenuItem。
 *
 * 建議資料表：
 * - id text primary key
 * - name text not null
 * - price int not null
 * - category_id text not null
 * - category_name text not null
 * - is_drink boolean not null default false
 * - is_toast boolean not null default false
 */
export type MenuItemRow = {
  id: string
  name: string
  price: number
  category_id: string
  category_name: string
  is_drink: boolean
  is_toast: boolean
}

function rowToCategory(r: MenuItemRow): MenuCategoryDef {
  return {
    id: r.category_id,
    name: r.category_name,
    isDrink: r.is_drink,
    isToast: r.is_toast,
  }
}

/** 由資料列還原 categories（依出現順序去重）與 menu */
export function menuFromRows(rows: MenuItemRow[]): {
  categories: MenuCategoryDef[]
  menu: MenuItem[]
} {
  const categories: MenuCategoryDef[] = []
  const seenCat = new Set<string>()
  for (const r of rows) {
    if (seenCat.has(r.category_id)) continue
    seenCat.add(r.category_id)
    categories.push(rowToCategory(r))
  }
  const menu: MenuItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    price: r.price,
    categoryId: r.category_id,
  }))
  return { categories, menu }
}

export function menuItemToRow(
  item: MenuItem,
  categories: MenuCategoryDef[],
): MenuItemRow {
  const c = categories.find((x) => x.id === item.categoryId)
  if (!c) {
    throw new Error(`找不到類別：${item.categoryId}`)
  }
  return {
    id: item.id,
    name: item.name,
    price: item.price,
    category_id: item.categoryId,
    category_name: c.name,
    is_drink: c.isDrink,
    is_toast: c.isToast,
  }
}

export async function fetchMenuFromSupabase(): Promise<{
  categories: MenuCategoryDef[]
  menu: MenuItem[]
}> {
  const { data, error } = await supabase
    .from('menu_items')
    .select(
      'id, name, price, category_id, category_name, is_drink, is_toast',
    )
    .order('category_id', { ascending: true })
    .order('name', { ascending: true })

  if (error) throw error
  const rows = (data ?? []) as MenuItemRow[]
  return menuFromRows(rows)
}

export async function insertMenuItemRow(row: MenuItemRow): Promise<void> {
  const { error } = await supabase.from('menu_items').insert(row)
  if (error) throw error
}

export async function deleteMenuItemById(id: string): Promise<void> {
  const { error } = await supabase.from('menu_items').delete().eq('id', id)
  if (error) throw error
}

export async function deleteMenuItemsByCategoryId(
  categoryId: string,
): Promise<void> {
  const { error } = await supabase
    .from('menu_items')
    .delete()
    .eq('category_id', categoryId)
  if (error) throw error
}


