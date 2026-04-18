import type { Order, OtherStoreEntry, Personnel } from '../domain/breakfastTypes'
import { supabase } from './supabaseClient'

/**
 * 與 Supabase public.colleagues 實際欄位一致：
 * id, name, order_index, fixed_drink, requires_untoasted_toast, dislike_list, is_absent,
 * current_food, current_note, internal_note, is_manual, other_food, other_price, other_is_on_leave, created_at
 */
export type ColleagueRow = {
  id: string
  name: string
  order_index: number | null
  fixed_drink: string | null
  requires_untoasted_toast: boolean
  dislike_list: string[] | null
  is_absent: boolean
  current_food: string | null
  current_note: string | null
  internal_note: string | null
  is_manual: boolean
  other_food: string | null
  other_price: number | null
  other_is_on_leave: boolean | null
  created_at?: string
}

/** 早餐點餐頁 upsert 僅覆寫早餐相關欄位，不碰其他店家欄位 */
export type ColleagueUpsertPayload = {
  id: string
  name: string
  order_index: number | null
  fixed_drink: string | null
  requires_untoasted_toast: boolean
  dislike_list: string[] | null
  is_absent: boolean
  current_food: string | null
  current_note: string | null
  internal_note: string | null
  is_manual: boolean
}

/**
 * insert() 僅允許資料表實際存在的欄位（不含 created_at），避免多餘屬性導致 PostgREST 拒絕。
 * 與 colleagues：id, name, order_index, fixed_drink, requires_untoasted_toast, dislike_list, is_absent,
 * current_food, current_note, internal_note, is_manual, other_food, other_price, other_is_on_leave
 */
export type ColleagueInsertPayload = {
  id: string
  name: string
  order_index: number
  fixed_drink: string | null
  requires_untoasted_toast: boolean
  dislike_list: string[]
  is_absent: boolean
  current_food: string | null
  current_note: string | null
  internal_note: string | null
  is_manual: boolean
  other_food: string | null
  other_price: number | null
  other_is_on_leave: boolean
}

const COLLEAGUE_SELECT =
  'id, name, order_index, fixed_drink, requires_untoasted_toast, dislike_list, is_absent, current_food, current_note, internal_note, is_manual, other_food, other_price, other_is_on_leave'

const COLLEAGUE_SELECT_LEGACY =
  'id, name, order_index, fixed_drink, requires_untoasted_toast, dislike_list, is_absent, current_food, current_note, internal_note, is_manual'

function isMissingOtherStoreColumnsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const message =
    'message' in err && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message.toLowerCase()
      : ''
  const details =
    'details' in err && typeof (err as { details?: unknown }).details === 'string'
      ? (err as { details: string }).details.toLowerCase()
      : ''
  const hint =
    'hint' in err && typeof (err as { hint?: unknown }).hint === 'string'
      ? (err as { hint: string }).hint.toLowerCase()
      : ''
  const text = `${message} ${details} ${hint}`
  return (
    text.includes('other_food') ||
    text.includes('other_price') ||
    text.includes('other_is_on_leave') ||
    text.includes('column') && text.includes('does not exist')
  )
}

function normalizeDislikeList(raw: ColleagueRow['dislike_list']): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) return [...raw]
  return []
}

export function personnelFromRow(r: ColleagueRow): Personnel {
  return {
    id: r.id,
    orderIndex: r.order_index ?? 0,
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
    foodRemark: r.current_note ?? undefined,
  }
}

export function otherStoreEntryFromRow(r: ColleagueRow): OtherStoreEntry {
  const normalizedFood =
    typeof r.other_food === 'string' && r.other_food.trim() !== '0'
      ? r.other_food
      : ''
  return {
    userId: r.id,
    otherFood: normalizedFood,
    otherPrice: r.other_price ?? 0,
    otherIsOnLeave: r.other_is_on_leave ?? false,
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
      foodRemark: undefined,
    } satisfies Order)

  return {
    id: p.id,
    name: p.name,
    order_index: p.orderIndex,
    fixed_drink: p.fixedDrinkId ?? null,
    requires_untoasted_toast: p.requiresUntoastedToast ?? false,
    dislike_list: [...p.dislikedFoodIds],
    is_absent: p.isAbsent ?? false,
    current_food: mealOrder.selectedFoodId ?? null,
    current_note: mealOrder.foodRemark ?? null,
    internal_note: p.extraRemark ?? null,
    is_manual: false,
  }
}

export async function fetchColleaguesFromSupabase(): Promise<{
  personnel: Personnel[]
  orders: Order[]
  otherStoreEntries: OtherStoreEntry[]
}> {
  let rows: ColleagueRow[] = []
  const primary = await supabase
    .from('colleagues')
    .select(COLLEAGUE_SELECT)
    .order('order_index', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })

  if (primary.error) {
    if (!isMissingOtherStoreColumnsError(primary.error)) throw primary.error
    console.warn(
      'colleagues.other_food / other_price / other_is_on_leave 可能尚未被 API schema cache 識別，退回舊查詢。',
      primary.error,
    )
    const legacy = await supabase
      .from('colleagues')
      .select(COLLEAGUE_SELECT_LEGACY)
      .order('order_index', { ascending: true, nullsFirst: false })
      .order('name', { ascending: true })
    if (legacy.error) throw legacy.error
    rows = ((
      legacy.data ?? []
    ) as Array<Omit<ColleagueRow, 'other_food' | 'other_price' | 'other_is_on_leave'>>).map(
      (row) => ({
        ...row,
        other_food: '',
        other_price: 0,
        other_is_on_leave: false,
      }),
    )
  } else {
    rows = (primary.data ?? []) as ColleagueRow[]
  }

  const personnel = rows.map(personnelFromRow)
  const orders = rows.map(orderFromRow)
  const otherStoreEntries = rows.map(otherStoreEntryFromRow)
  return { personnel, orders, otherStoreEntries }
}

/** 依列表新順序寫回 order_index（1-based） */
export async function updateColleagueOrderIndices(orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return
  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[i]
    const { error } = await supabase
      .from('colleagues')
      .update({ order_index: i + 1 })
      .eq('id', id)
    if (error) throw error
  }
}

export async function upsertColleagueRows(rows: ColleagueUpsertPayload[]): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase.from('colleagues').upsert(rows, {
    onConflict: 'id',
  })
  if (error) throw error
}

/** 新建同事一筆 insert（僅含資料表欄位，無其他屬性） */
export function buildNewColleagueInsertPayload(
  id: string,
  name: string,
  orderIndex: number,
): ColleagueInsertPayload {
  return {
    id,
    name,
    order_index: orderIndex,
    fixed_drink: null,
    requires_untoasted_toast: false,
    dislike_list: [],
    is_absent: false,
    current_food: null,
    current_note: null,
    internal_note: null,
    is_manual: false,
    other_food: null,
    other_price: null,
    other_is_on_leave: false,
  }
}

export async function insertColleagueRow(row: ColleagueInsertPayload): Promise<void> {
  const payload: ColleagueInsertPayload = {
    id: row.id,
    name: row.name,
    order_index: row.order_index,
    fixed_drink: row.fixed_drink,
    requires_untoasted_toast: row.requires_untoasted_toast,
    dislike_list: row.dislike_list,
    is_absent: row.is_absent,
    current_food: row.current_food,
    current_note: row.current_note,
    internal_note: row.internal_note,
    is_manual: row.is_manual,
    other_food: row.other_food,
    other_price: row.other_price,
    other_is_on_leave: row.other_is_on_leave,
  }
  const { error } = await supabase.from('colleagues').insert(payload)
  if (error) throw error
}

export async function updateColleagueOtherStoreFields(
  userId: string,
  patch: {
    other_food?: string | null
    other_price?: number | null
    other_is_on_leave?: boolean
  },
): Promise<void> {
  const { error } = await supabase.from('colleagues').update(patch).eq('id', userId)
  if (error) throw error
}

export async function deleteColleagueById(id: string): Promise<void> {
  const { error } = await supabase.from('colleagues').delete().eq('id', id)
  if (error) throw error
}
