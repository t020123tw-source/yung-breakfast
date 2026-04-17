import type { Order, Personnel } from '../domain/breakfastTypes'
import { supabase } from './supabaseClient'

/**
 * 與 public.colleagues 欄位對應（snake_case）。
 * 飲料以 fixed_drink_id 為準；載入時 selectedDrinkId 由固定飲料帶入。
 *
 * 建議資料表（若欄位名稱不同請調整本檔或資料庫）：
 * - id text primary key
 * - name text not null
 * - fixed_drink_id text null（對應 menu_items.id）
 * - disliked_food_ids text[] not null default '{}'
 * - extra_remark text null
 * - requires_untoasted_toast boolean not null default false
 * - is_absent boolean not null default false
 * - selected_food_id text null
 * - is_manual boolean not null default false
 * - food_remark text null
 */
export type ColleagueRow = {
  id: string
  name: string
  fixed_drink_id: string | null
  disliked_food_ids: string[]
  extra_remark: string | null
  requires_untoasted_toast: boolean
  is_absent: boolean
  selected_food_id: string | null
  is_manual: boolean
  food_remark: string | null
}

const COLLEAGUE_SELECT =
  'id, name, fixed_drink_id, disliked_food_ids, extra_remark, requires_untoasted_toast, is_absent, selected_food_id, is_manual, food_remark'

export function personnelFromRow(r: ColleagueRow): Personnel {
  return {
    id: r.id,
    name: r.name,
    fixedDrinkId: r.fixed_drink_id,
    dislikedFoodIds: Array.isArray(r.disliked_food_ids)
      ? [...r.disliked_food_ids]
      : [],
    extraRemark: r.extra_remark ?? undefined,
    requiresUntoastedToast: r.requires_untoasted_toast,
    isAbsent: r.is_absent,
  }
}

export function orderFromRow(r: ColleagueRow): Order {
  return {
    userId: r.id,
    selectedDrinkId: r.fixed_drink_id,
    selectedFoodId: r.selected_food_id,
    isManual: r.is_manual,
    foodRemark: r.food_remark ?? undefined,
  }
}

export function colleagueRowFromPersonnelAndOrder(
  p: Personnel,
  o: Order | undefined,
): ColleagueRow {
  const mealOrder =
    o ??
    ({
      userId: p.id,
      selectedDrinkId: p.fixedDrinkId ?? null,
      selectedFoodId: null,
      isManual: false,
      foodRemark: undefined,
    } satisfies Order)

  return {
    id: p.id,
    name: p.name,
    fixed_drink_id: p.fixedDrinkId ?? null,
    disliked_food_ids: [...p.dislikedFoodIds],
    extra_remark: p.extraRemark ?? null,
    requires_untoasted_toast: p.requiresUntoastedToast ?? false,
    is_absent: p.isAbsent ?? false,
    selected_food_id: mealOrder.selectedFoodId ?? null,
    is_manual: mealOrder.isManual,
    food_remark: mealOrder.foodRemark ?? null,
  }
}

export async function fetchColleaguesFromSupabase(): Promise<{
  personnel: Personnel[]
  orders: Order[]
}> {
  const { data, error } = await supabase
    .from('colleagues')
    .select(COLLEAGUE_SELECT)
    .order('name', { ascending: true })

  if (error) throw error
  const rows = (data ?? []) as ColleagueRow[]
  const personnel = rows.map(personnelFromRow)
  const orders = rows.map(orderFromRow)
  return { personnel, orders }
}

export async function upsertColleagueRows(rows: ColleagueRow[]): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase.from('colleagues').upsert(rows, {
    onConflict: 'id',
  })
  if (error) throw error
}

export async function insertColleagueRow(row: ColleagueRow): Promise<void> {
  const { error } = await supabase.from('colleagues').insert(row)
  if (error) throw error
}

export async function deleteColleagueById(id: string): Promise<void> {
  const { error } = await supabase.from('colleagues').delete().eq('id', id)
  if (error) throw error
}
