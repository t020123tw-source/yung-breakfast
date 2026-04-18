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

/** 與 fetchMenuFromSupabase 相同；insert 成功後請再次呼叫以從資料庫同步畫面 */
export const fetchMenuItems = fetchMenuFromSupabase

export async function insertMenuItemRow(row: MenuItemMinimalInsert): Promise<void> {
  const priceNum = Number(row.price)
  const priceInt = Number.isFinite(priceNum)
    ? Math.min(999999, Math.max(0, Math.round(priceNum)))
    : 0
  const name = String(row.name ?? '').trim()
  const category = String(row.category ?? '').trim()
  if (!name) throw new Error('餐點名稱不可為空')
  if (!category) throw new Error('類別不可為空')

  const record = {
    name,
    price: priceInt,
    category,
  }

  const { error } = await supabase.from('menu_items').insert([record])
  if (error) {
    console.error('menu_items insert 失敗:', {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    })
    throw error
  }
}

export async function deleteMenuItemById(id: string): Promise<void> {
  const { error } = await supabase.from('menu_items').delete().eq('id', id)
  if (error) throw error
}

export async function updateMenuItemById(args: {
  id: string
  name: string
  price: number
}): Promise<void> {
  const id = String(args.id ?? '').trim()
  const name = String(args.name ?? '').trim()
  const priceNum = Number(args.price)
  const priceInt = Number.isFinite(priceNum)
    ? Math.min(999999, Math.max(0, Math.round(priceNum)))
    : 0
  if (!id) throw new Error('餐點 ID 不可為空')
  if (!name) throw new Error('餐點名稱不可為空')

  const { error } = await supabase
    .from('menu_items')
    .update({
      name,
      price: priceInt,
    })
    .eq('id', id)
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
