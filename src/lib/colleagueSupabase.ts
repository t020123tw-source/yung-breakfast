import type { Order, Personnel } from '../domain/breakfastTypes'
import { supabase } from './supabaseClient'

/**
 * 與 Supabase public.colleagues 實際欄位一致：
 * id, name, fixed_drink, requires_untoasted_toast, dislike_list, is_absent,
 * current_food, current_note, internal_note, is_manual, created_at
 */
export type ColleagueRow = {
  id: string
  name: string
  fixed_drink: string | null
  requires_untoasted_toast: boolean
  dislike_list: string[] | null
  is_absent: boolean
  current_food: string | null
  current_note: string | null
  internal_note: string | null
  is_manual: boolean
  created_at?: string
}

/** upsert / insert 時不送 created_at */
export type ColleagueUpsertPayload = Omit<ColleagueRow, 'created_at'>

const COLLEAGUE_SELECT =
  'id, name, fixed_drink, requires_untoasted_toast, dislike_list, is_absent, current_food, current_note, internal_note, is_manual'

function normalizeDislikeList(raw: ColleagueRow['dislike_list']): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) return [...raw]
  return []
}

export function personnelFromRow(r: ColleagueRow): Personnel {
  return {
    id: r.id,
    name: r.name,
    fixedDrinkId: r.fixed_drink,
    dislikedFoodIds: normalizeDislikeList(r.dislike_list),
    extraRemark: r.internal_note ?? undefined,
    requiresUntoastedToast: r.requires_untoasted_toast,
    isAbsent: r.is_absent,
  }
}

export function orderFromRow(r: ColleagueRow): Order {
  return {
    userId: r.id,
    selectedDrinkId: r.fixed_drink,
    selectedFoodId: r.current_food,
    isManual: r.is_manual,
    foodRemark: r.current_note ?? undefined,
  }
}

export function colleagueRowFromPersonnelAndOrder(
  p: Personnel,
  o: Order | undefined,
): ColleagueUpsertPayload {
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
    fixed_drink: p.fixedDrinkId ?? null,
    requires_untoasted_toast: p.requiresUntoastedToast ?? false,
    dislike_list: [...p.dislikedFoodIds],
    is_absent: p.isAbsent ?? false,
    current_food: mealOrder.selectedFoodId ?? null,
    current_note: mealOrder.foodRemark ?? null,
    internal_note: p.extraRemark ?? null,
    is_manual: mealOrder.isManual,
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

export async function upsertColleagueRows(rows: ColleagueUpsertPayload[]): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase.from('colleagues').upsert(rows, {
    onConflict: 'id',
  })
  if (error) throw error
}

export async function insertColleagueRow(row: ColleagueUpsertPayload): Promise<void> {
  const { error } = await supabase.from('colleagues').insert(row)
  if (error) throw error
}

export async function deleteColleagueById(id: string): Promise<void> {
  const { error } = await supabase.from('colleagues').delete().eq('id', id)
  if (error) throw error
}
