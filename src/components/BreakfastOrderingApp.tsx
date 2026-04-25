import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import {
  type MenuCategoryDef,
  type MenuItem,
  compareSummaryLabelsByMenu,
  filterItemsForWheel,
  getFixedDrinkSelectOptions,
  isDrinkItem,
  isToastItem,
} from '../data/menuData'
import type { Order, Personnel } from '../domain/breakfastTypes'
import {
  bulkClearBreakfastFieldsByIds,
  buildNewColleagueInsertPayload,
  colleagueRowFromPersonnelAndOrder,
  deleteColleagueById,
  insertColleagueRow,
  updateColleagueFixedMealStatus,
  updateColleagueOrderIndices,
  upsertColleagueRows,
} from '../lib/colleagueSupabase'
import { DislikeSettingsModal } from './DislikeSettingsModal'

export type { MenuItem, MenuCategoryDef } from '../data/menuData'
export type { Order, Personnel } from '../domain/breakfastTypes'

export type BreakfastOrderingAppProps = {
  menu: MenuItem[]
  categories: MenuCategoryDef[]
  initialPersonnel: Personnel[]
  initialOrders: Order[]
  /** 與 key 同步：refetch 後要預設選中的同事 id */
  selectPersonIdOnMount?: string | null
  /** 新增／同步同事資料後由父層 refetch */
  onColleaguesSynced?: (opts: { newPersonId: string }) => Promise<void>
}

/** 備註含此字串時，單人金額額外加價（對應 current_note） */
const EGG_REMARK_TOKEN = '+蛋'
const EGG_EXTRA_PRICE = 15
const NOT_TOASTED_REMARK_TOKEN = '不烤'
const DEFAULT_BUDGET_INPUT = '65'

function buildMenuMap(menu: MenuItem[]): Map<string, MenuItem> {
  const m = new Map<string, MenuItem>()
  for (const item of menu) m.set(item.id, item)
  return m
}

function menuFromMap(
  menuMap: Map<string, MenuItem>,
  id: string | null | undefined,
): MenuItem | undefined {
  if (!id) return undefined
  return menuMap.get(id)
}

/** current_food 是否視為空白（轉盤可寫入） */
function foodLineIsEmpty(v: string | null | undefined): boolean {
  return splitCurrentFoodSegments(v).length === 0
}

function splitMealSlotsPreservingParentheses(
  raw: string | null | undefined,
): string[] {
  if (typeof raw !== 'string' || raw === '') return []
  const slots: string[] = []
  let current = ''
  let depth = 0
  for (let i = 0; i < raw.length; i++) {
    if (depth === 0 && raw.slice(i, i + 3) === ' + ') {
      slots.push(current.trim())
      current = ''
      i += 2
      continue
    }
    const ch = raw[i]
    if (ch === '(' || ch === '（' || ch === '[') depth += 1
    current += ch
    if ((ch === ')' || ch === '）' || ch === ']') && depth > 0) depth -= 1
  }
  slots.push(current.trim())
  return slots
}

/**
 * 與計價／彙整／點餐板共用：只在頂層分隔符 ` + ` 拆段，避免切開括號內的加號。
 */
function splitCurrentFoodSegments(raw: string | null | undefined): string[] {
  return splitMealSlotsPreservingParentheses(raw).filter(Boolean)
}

function splitCurrentFoodSlots(raw: string | null | undefined): string[] {
  return splitMealSlotsPreservingParentheses(raw)
}

function mealSlotCountFromCurrentFood(raw: string | null | undefined): number {
  if (raw == null) return 1
  return Math.max(1, splitCurrentFoodSlots(raw).length)
}

function emptyMealLines(count: number): string[] {
  return Array.from({ length: Math.max(1, count) }, () => '')
}

function mealLinesForEditor(
  raw: string | null | undefined,
  slotCount: number,
): string[] {
  const slots = splitCurrentFoodSlots(raw)
  if (slots.length === 0) return emptyMealLines(slotCount)
  if (slots.length >= slotCount) return slots
  return [...slots, ...emptyMealLines(slotCount - slots.length)]
}

function replaceMealDraftLine(lines: string[], index: number, value: string): string[] {
  return lines.map((line, lineIndex) => (lineIndex === index ? value : line))
}

function serializeEmptyMealSlots(count: number): string {
  return emptyMealLines(count).join(' + ')
}

/** 儲存：過濾空白列後以半形 ` + ` 串回 current_food */
function joinMealLinesToCurrentFood(lines: string[]): string | null {
  const filtered = lines.map((x) => x.trim()).filter(Boolean)
  if (filtered.length === 0) return null
  return filtered.join(' + ')
}

function pickDistinctMealLabelsForPerson(
  pool: MenuItem[],
  person: Personnel,
  slotCount: number,
): string[] {
  const available = [...pool]
  const result: string[] = []
  while (available.length > 0 && result.length < slotCount) {
    const idx = Math.floor(Math.random() * available.length)
    const [pick] = available.splice(idx, 1)
    if (!pick) break
    result.push(formatFoodLabelForPerson(pick, person))
  }
  while (result.length < slotCount) result.push('')
  return result
}

/**
 * 將 current_food 拆段後，每段比對 menu id 或 name 加總價格。
 */
function sumFoodPricesFromCurrentFood(
  raw: string,
  menu: MenuItem[],
  manualFoodPrice: number | null | undefined,
): { sum: number; hasUnpricedSegment: boolean } {
  const segments = splitCurrentFoodSegments(raw)
  if (segments.length === 0) return { sum: 0, hasUnpricedSegment: false }
  let sum = 0
  let missingCount = 0
  for (const seg of segments) {
    const byId = menu.find((m) => m.id === seg)
    const item = byId ?? menu.find((m) => m.name === seg)
    if (item) {
      sum += item.price
    } else {
      missingCount += 1
    }
  }
  const manual = Number.isFinite(Number(manualFoodPrice)) ? Number(manualFoodPrice) : 0
  if (missingCount > 0 && manual > 0) {
    sum += manual
  }
  return { sum, hasUnpricedSegment: missingCount > 0 && manual <= 0 }
}

/**
 * 單人總金額：以 menu_items 比對飲料與餐點。
 * - 固定飲料：優先以 id 對應；若無則以字串與品項 name 完全相符者計價。
 * - 餐點（current_food）：以 `+` 拆段（容錯空白），每段依 id 或 name 比對加總。
 * - 若備註（current_note）含「+蛋」，總額另加 15 元。
 */
function computeColleagueOrderTotal(
  p: Personnel,
  o: Order | undefined,
  menu: MenuItem[],
): { total: number; hasUnpriced: boolean } {
  if (!o || p.isAbsent) {
    return { total: 0, hasUnpriced: false }
  }

  let drinkPrice = 0
  let drinkOk = true
  const fd = (p.fixedDrinkId ?? '').trim()
  if (fd) {
    const byId = menu.find((m) => m.id === fd)
    if (byId) {
      drinkPrice = byId.price
    } else {
      const byName = menu.find((m) => m.name === fd)
      if (byName) {
        drinkPrice = byName.price
      } else {
        drinkPrice = 0
        drinkOk = false
      }
    }
  }

  const rawFood = (o.selectedFoodId ?? '').trim()
  const { sum: foodPrice, hasUnpricedSegment } = sumFoodPricesFromCurrentFood(
    rawFood,
    menu,
    o.manualFoodPrice,
  )
  const foodOk = rawFood === '' || !hasUnpricedSegment

  const hasUnpriced =
    (!drinkOk && fd !== '') || (!foodOk && rawFood !== '')
  let total = drinkPrice + foodPrice
  const note = o.foodRemark ?? ''
  if (note.includes(EGG_REMARK_TOKEN)) {
    total += EGG_EXTRA_PRICE
  }
  return { total, hasUnpriced }
}

function appendDisplayRemark(label: string, remark: string | null | undefined): string {
  const text = (remark ?? '').trim()
  if (!text) return label
  return `${label}(${text})`
}

function resolveMealItemFromSegment(
  segment: string,
  menuMap: Map<string, MenuItem>,
  menu: MenuItem[],
): MenuItem | undefined {
  const t = segment.trim()
  if (!t) return undefined
  return menuFromMap(menuMap, t) ?? menu.find((m) => m.name === t)
}

function promptForManualFoodPrice(
  label: string,
  initialValue: number | null | undefined,
): number {
  const fallback =
    initialValue != null && Number.isFinite(initialValue) && initialValue > 0
      ? String(initialValue)
      : ''
  const value = window.prompt(
    `找不到此餐點金額，請手動輸入金額：\n${label}`,
    fallback,
  )
  if (value == null) return Number(initialValue ?? 0) || 0
  const parsed = Number(value.replace(/[^\d.]/g, ''))
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0
}

function segmentLooksLikeToast(
  segment: string,
  menuMap: Map<string, MenuItem>,
  menu: MenuItem[],
): boolean {
  const item = resolveMealItemFromSegment(segment, menuMap, menu)
  if (item) return isToastItem(item) || item.name.includes('吐司')
  return segment.includes('吐司')
}

function mealContainsToast(
  raw: string | null | undefined,
  menuMap: Map<string, MenuItem>,
  menu: MenuItem[],
): boolean {
  return splitCurrentFoodSegments(raw).some((segment) =>
    segmentLooksLikeToast(segment, menuMap, menu),
  )
}

function normalizeRemarkTokens(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(/[，,]/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function stringifyRemarkTokens(tokens: string[]): string | undefined {
  const unique = tokens.filter((token, index) => tokens.indexOf(token) === index)
  return unique.length > 0 ? unique.join(', ') : undefined
}

function applyNotToastedRemark(
  rawRemark: string | null | undefined,
  selectedFoodId: string | null | undefined,
  isNotToasted: boolean | null | undefined,
  menuMap: Map<string, MenuItem>,
  menu: MenuItem[],
): string | undefined {
  const tokens = normalizeRemarkTokens(rawRemark).filter(
    (token) => token !== NOT_TOASTED_REMARK_TOKEN,
  )
  const shouldAppend =
    !!isNotToasted && mealContainsToast(selectedFoodId, menuMap, menu)
  if (shouldAppend) tokens.push(NOT_TOASTED_REMARK_TOKEN)
  return stringifyRemarkTokens(tokens)
}

/** 依人員設定：餐點走 foodRemark，飲料走 drinkRemark */
function formatFoodLabelForPerson(
  food: MenuItem,
  person: Personnel | undefined,
  options?: { foodRemark?: string | null | undefined },
): string {
  let s = food.name
  if (isDrinkItem(food)) return appendDisplayRemark(s, person?.drinkRemark)
  return appendDisplayRemark(s, options?.foodRemark)
}

/** HTML5 拖曳：將 source 列插入至 target 列位置，並重編 orderIndex 為 1…n */
function reorderPersonnelByInsert(
  list: Personnel[],
  sourceId: string,
  targetId: string,
): Personnel[] {
  const fromIdx = list.findIndex((p) => p.id === sourceId)
  const toIdx = list.findIndex((p) => p.id === targetId)
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return list
  const next = [...list]
  const [item] = next.splice(fromIdx, 1)
  next.splice(toIdx, 0, item)
  return next.map((p, i) => ({ ...p, orderIndex: i + 1 }))
}

/** 低調拖曳把手：六點陣 */
function ColleagueDragHandleIcon() {
  return (
    <span className="inline-grid shrink-0 grid-cols-2 gap-0.5" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <span key={i} className="size-[3px] rounded-full bg-slate-400/90" />
      ))}
    </span>
  )
}

/** 單段餐點字串 → 店家彙整用標籤（含備註） */
function labelForFoodSegment(
  menuMap: Map<string, MenuItem>,
  menu: MenuItem[],
  segment: string,
  person: Personnel | undefined,
  foodRemark?: string | null | undefined,
): string | null {
  const t = segment.trim()
  if (!t) return null
  const byId = menuFromMap(menuMap, t)
  const food = byId ?? menu.find((m) => m.name === t)
  if (food) {
    return formatFoodLabelForPerson(food, person, { foodRemark })
  }
  return appendDisplayRemark(t, foodRemark)
}

function buildFoodLineForShop(
  menuMap: Map<string, MenuItem>,
  menu: MenuItem[],
  o: Order,
  person: Personnel | undefined,
): string | null {
  const raw = (o.selectedFoodId ?? '').trim()
  if (!raw) return null
  const segments = splitCurrentFoodSegments(raw)
  if (segments.length === 0) return null
  const parts: string[] = []
  const foodRemark = o.foodRemark ?? ''
  for (const seg of segments) {
    const lab = labelForFoodSegment(menuMap, menu, seg, person, foodRemark)
    if (lab) parts.push(lab)
  }
  if (parts.length === 0) return null
  return parts.join(' + ')
}

function formatOneSlotSummary(slotMap: Map<string, number>, menu: MenuItem[]): string[] {
  return [...slotMap.entries()]
    .sort(([a], [b]) => compareSummaryLabelsByMenu(a, b, menu))
    .map(([label, count]) => `${label} x ${count}`)
}

function buildShopSummaryLines(
  menuMap: Map<string, MenuItem>,
  menu: MenuItem[],
  orders: Order[],
  personnel: Personnel[],
): string[] {
  const drinkMap = new Map<string, number>()
  const slotMaps = new Map<number, Map<string, number>>()

  for (const o of orders) {
    const person = personnel.find((p) => p.id === o.userId)
    if (person?.isAbsent) continue
    if (o.selectedDrinkId?.trim()) {
      const drinkItem =
        menuFromMap(menuMap, o.selectedDrinkId) ??
        menu.find((m) => m.name === o.selectedDrinkId)
      const drinkLine = drinkItem
        ? formatFoodLabelForPerson(drinkItem, person)
        : appendDisplayRemark(o.selectedDrinkId, person?.drinkRemark)
      if (drinkLine) {
        drinkMap.set(drinkLine, (drinkMap.get(drinkLine) ?? 0) + 1)
      }
    }
    if (o.selectedFoodId?.trim()) {
      const segments = splitCurrentFoodSegments(o.selectedFoodId)
      segments.forEach((segment, index) => {
        const line = labelForFoodSegment(menuMap, menu, segment, person, o.foodRemark)
        if (!line) return
        const slotMap = slotMaps.get(index) ?? new Map<string, number>()
        slotMap.set(line, (slotMap.get(line) ?? 0) + 1)
        slotMaps.set(index, slotMap)
      })
    }
  }

  return [
    ...formatOneSlotSummary(drinkMap, menu),
    ...[...slotMaps.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, slotMap]) => formatOneSlotSummary(slotMap, menu)),
  ]
}

export function BreakfastOrderingApp({
  menu,
  categories,
  initialPersonnel,
  initialOrders,
  selectPersonIdOnMount,
  onColleaguesSynced,
}: BreakfastOrderingAppProps) {
  const [budgetInput, setBudgetInput] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_BUDGET_INPUT
    const saved = window.localStorage.getItem('budget')
    if (!saved || saved.trim() === '') return DEFAULT_BUDGET_INPUT
    const parsed = parseInt(saved.replace(/\D/g, ''), 10)
    return Number.isFinite(parsed) ? String(Math.max(0, parsed)) : DEFAULT_BUDGET_INPUT
  })
  const globalBudget = useMemo(() => {
    const n = parseInt(budgetInput.replace(/\D/g, ''), 10)
    return Number.isFinite(n) ? Math.min(999999, Math.max(0, n)) : 0
  }, [budgetInput])
  const [personnel, setPersonnel] = useState<Personnel[]>(initialPersonnel)
  const [orders, setOrders] = useState<Order[]>(initialOrders)
  const [selectedPersonId, setSelectedPersonId] = useState<string>(
    () =>
      (selectPersonIdOnMount && selectPersonIdOnMount.length > 0
        ? selectPersonIdOnMount
        : null) ??
      initialPersonnel[0]?.id ??
      '',
  )

  const persistIdsRef = useRef(new Set<string>())
  const debouncedPersistIdsRef = useRef(new Set<string>())
  const latestPersonnelRef = useRef(initialPersonnel)
  const latestOrdersRef = useRef(initialOrders)
  const latestMealLineDraftsRef = useRef<string[]>([''])
  const latestSelectedPersonIdRef = useRef(
    (selectPersonIdOnMount && selectPersonIdOnMount.length > 0
      ? selectPersonIdOnMount
      : null) ??
      initialPersonnel[0]?.id ??
      '',
  )
  const [persistTick, setPersistTick] = useState(0)
  const [persistingCount, setPersistingCount] = useState(0)
  const [hasPendingPersist, setHasPendingPersist] = useState(false)

  const queuePersistIds = useCallback((ids: string[]) => {
    let added = false
    for (const id of ids) {
      if (!id) continue
      persistIdsRef.current.add(id)
      added = true
    }
    if (!added) return
    setHasPendingPersist(true)
    setPersistTick((n) => n + 1)
  }, [])

  const schedulePersist = useCallback((userId: string) => {
    queuePersistIds([userId])
  }, [queuePersistIds])

  const persistDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const schedulePersistDebounced = useCallback(
    (userId: string, ms = 420) => {
      if (!userId) return
      if (persistDebounceTimerRef.current) {
        clearTimeout(persistDebounceTimerRef.current)
      }
      debouncedPersistIdsRef.current.add(userId)
      setHasPendingPersist(true)
      persistDebounceTimerRef.current = setTimeout(() => {
        const ids = [...debouncedPersistIdsRef.current]
        debouncedPersistIdsRef.current.clear()
        persistDebounceTimerRef.current = null
        queuePersistIds(ids)
      }, ms)
    },
    [queuePersistIds],
  )

  useEffect(() => {
    return () => {
      if (persistDebounceTimerRef.current) {
        clearTimeout(persistDebounceTimerRef.current)
      }
    }
  }, [])

  const persistRowsNow = useCallback(async (rows: ReturnType<typeof colleagueRowFromPersonnelAndOrder>[]) => {
    if (rows.length === 0) return
    setPersistingCount((n) => n + 1)
    try {
      await upsertColleagueRows(rows)
    } finally {
      setPersistingCount((n) => Math.max(0, n - 1))
    }
  }, [])

  const persistUserSnapshotNow = useCallback(
    async (person: Personnel, order: Order | undefined) => {
      await persistRowsNow([colleagueRowFromPersonnelAndOrder(person, order)])
    },
    [persistRowsNow],
  )

  const getLatestBreakfastState = useCallback(() => {
    return {
      personnel: latestPersonnelRef.current,
      orders: latestOrdersRef.current,
      selectedPersonId: latestSelectedPersonIdRef.current,
    }
  }, [])

  useEffect(() => {
    latestPersonnelRef.current = personnel
    latestOrdersRef.current = orders
  }, [personnel, orders])

  useEffect(() => {
    latestSelectedPersonIdRef.current = selectedPersonId
  }, [selectedPersonId])

  const handleBudgetInputChange = useCallback(
    (value: string) => {
      setBudgetInput(value)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('budget', value)
      }
    },
    [],
  )

  const handleBudgetInputBlur = useCallback((value: string) => {
    const parsed = parseInt(value.replace(/\D/g, ''), 10)
    const normalized = Number.isFinite(parsed)
      ? String(Math.max(0, parsed))
      : DEFAULT_BUDGET_INPUT
    setBudgetInput(normalized)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('budget', normalized)
    }
  }, [])

  useEffect(() => {
    const ids = [...persistIdsRef.current]
    persistIdsRef.current.clear()
    if (ids.length === 0) {
      setHasPendingPersist(
        persistDebounceTimerRef.current != null ||
          debouncedPersistIdsRef.current.size > 0,
      )
      return
    }
    void (async () => {
      setPersistingCount((n) => n + 1)
      try {
        const rows = ids
          .map((id) => {
            const p = personnel.find((x) => x.id === id)
            const o = orders.find((x) => x.userId === id)
            return p ? colleagueRowFromPersonnelAndOrder(p, o) : null
          })
          .filter((r) => r != null)
        await upsertColleagueRows(rows)
      } catch (e) {
        console.error(e)
      } finally {
        setPersistingCount((n) => Math.max(0, n - 1))
        setHasPendingPersist(
          persistIdsRef.current.size > 0 ||
            persistDebounceTimerRef.current != null ||
            debouncedPersistIdsRef.current.size > 0,
        )
      }
    })()
  }, [personnel, orders, persistTick])

  useEffect(() => {
    return () => {
      if (persistDebounceTimerRef.current) {
        clearTimeout(persistDebounceTimerRef.current)
        persistDebounceTimerRef.current = null
      }
      const ids = new Set<string>([
        ...persistIdsRef.current,
        ...debouncedPersistIdsRef.current,
      ])
      persistIdsRef.current.clear()
      debouncedPersistIdsRef.current.clear()
      if (ids.size === 0) return
      const rows = [...ids]
        .map((id) => {
          const p = latestPersonnelRef.current.find((x) => x.id === id)
          const o = latestOrdersRef.current.find((x) => x.userId === id)
          return p ? colleagueRowFromPersonnelAndOrder(p, o) : null
        })
        .filter((r) => r != null)
      if (rows.length === 0) return
      void upsertColleagueRows(rows).catch((e) => {
        console.error(e)
      })
    }
  }, [])

  const isPersisting = hasPendingPersist || persistingCount > 0

  useEffect(() => {
    if (!isPersisting) return
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isPersisting])

  /** 今日餐點多欄草稿（儲存時拼接為 current_food） */
  const [mealLineDrafts, setMealLineDrafts] = useState<string[]>([''])
  const mealDraftEditingRef = useRef(false)
  const mealDraftComposingRef = useRef(false)
  const previousSelectedPersonIdRef = useRef<string>(
    (selectPersonIdOnMount && selectPersonIdOnMount.length > 0
      ? selectPersonIdOnMount
      : null) ??
      initialPersonnel[0]?.id ??
      '',
  )
  /** 每位同事目前開啟的餐點欄位數；DB 有值時以 split 後數量為準，空白時保留本地操作數 */
  const [mealSlotCounts, setMealSlotCounts] = useState<Record<string, number>>(
    () =>
      Object.fromEntries(
        initialPersonnel.map((p) => {
          const o = initialOrders.find((x) => x.userId === p.id)
          const count = mealSlotCountFromCurrentFood(o?.selectedFoodId)
          return [p.id, count]
        }),
      ),
  )
  useEffect(() => {
    latestMealLineDraftsRef.current = mealLineDrafts
  }, [mealLineDrafts])
  const [foodRemarkDraft, setFoodRemarkDraft] = useState('')

  const [spinPhase, setSpinPhase] = useState<'idle' | 'spinning'>('idle')
  /** 老虎機跳動：目前顯示的候選品項 id */
  const [shufflePreviewId, setShufflePreviewId] = useState<string | null>(null)
  const [lastSpinFoodId, setLastSpinFoodId] = useState<string | null>(null)
  /** 抽中後短暫慶祝動畫 */
  const [celebratePick, setCelebratePick] = useState(false)
  const [dislikeModalOpen, setDislikeModalOpen] = useState(false)
  /** 新增同事：永遠顯示於頂部；可輸入姓名後新增（留空則預設「新同事」） */
  const [newColleagueName, setNewColleagueName] = useState('')
  const [addColleagueError, setAddColleagueError] = useState<string | null>(
    null,
  )
  const [addColleagueBusy, setAddColleagueBusy] = useState(false)
  /** ＋蛋切換後，短暫強調該員金額卡 */
  const [eggAmountFlashUserId, setEggAmountFlashUserId] = useState<string | null>(
    null,
  )
  const eggFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 同事列表拖曳排序（HTML5 DnD） */
  const [colleagueDragId, setColleagueDragId] = useState<string | null>(null)
  const [colleagueDragOverId, setColleagueDragOverId] = useState<string | null>(
    null,
  )

  useEffect(() => {
    return () => {
      if (eggFlashTimerRef.current) clearTimeout(eggFlashTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (
      selectPersonIdOnMount &&
      personnel.some((p) => p.id === selectPersonIdOnMount)
    ) {
      setSelectedPersonId(selectPersonIdOnMount)
    }
  }, [selectPersonIdOnMount, personnel])

  /** 延遲單擊選人，避免與雙擊切換休假衝突 */
  const nameClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const spinRafRef = useRef<number | null>(null)
  const spinSessionIdRef = useRef(0)

  const selectedPerson = useMemo(
    () => personnel.find((p) => p.id === selectedPersonId),
    [personnel, selectedPersonId],
  )

  const currentOrder = useMemo(
    () => orders.find((o) => o.userId === selectedPersonId),
    [orders, selectedPersonId],
  )

  useEffect(() => {
    setOrders((prev) =>
      prev.map((o) => {
        const p = personnel.find((x) => x.id === o.userId)
        if (!p) return o
        return { ...o, selectedDrinkId: p.fixedDrinkId ?? null }
      }),
    )
  }, [personnel])

  /** 固定飲料：categoryId === '飲料'（與轉盤候選分離） */
  const drinkOptions = useMemo(() => getFixedDrinkSelectOptions(menu), [menu])

  const menuMap = useMemo(() => buildMenuMap(menu), [menu])

  const dislikedIdSet = useMemo(
    () => new Set(selectedPerson?.dislikedFoodIds ?? []),
    [selectedPerson?.dislikedFoodIds],
  )

  const wheelCandidates = useMemo(() => {
    if (!selectedPerson || selectedPerson.isAbsent) return []
    const drink = selectedPerson.fixedDrinkId
      ? menuFromMap(menuMap, selectedPerson.fixedDrinkId)
      : undefined
    const drinkPrice = drink && isDrinkItem(drink) ? drink.price : 0
    const remaining = globalBudget - drinkPrice
    return filterItemsForWheel(menu, dislikedIdSet, remaining)
  }, [menu, menuMap, selectedPerson, globalBudget, dislikedIdSet])

  const remainingBudget = useMemo(() => {
    if (!selectedPerson) return 0
    const drink = selectedPerson.fixedDrinkId
      ? menuFromMap(menuMap, selectedPerson.fixedDrinkId)
      : undefined
    const drinkPrice = drink && isDrinkItem(drink) ? drink.price : 0
    return Math.max(0, globalBudget - drinkPrice)
  }, [menuMap, selectedPerson, globalBudget])

  /** 菜單或類別變更時：修正無效的飲料／餐點／忌口 id（僅在實際變動時更新 state） */
  useEffect(() => {
    const ids = new Set(menu.map((x) => x.id))
    setPersonnel((prev) => {
      const touched = new Set<string>()
      let any = false
      const next = prev.map((p) => {
        let fd = p.fixedDrinkId
        if (fd) {
          const it = menuFromMap(menuMap, fd)
          if (!it || !isDrinkItem(it)) fd = null
        }
        const dis = p.dislikedFoodIds.filter((id) => ids.has(id))
        const fdChanged = fd !== p.fixedDrinkId
        const disChanged =
          dis.length !== p.dislikedFoodIds.length ||
          dis.some((id, i) => id !== p.dislikedFoodIds[i])
        if (!fdChanged && !disChanged) return p
        any = true
        touched.add(p.id)
        return { ...p, fixedDrinkId: fd, dislikedFoodIds: dis }
      })
      if (any) {
        queueMicrotask(() => {
          for (const id of touched) schedulePersist(id)
        })
      }
      return any ? next : prev
    })
    setOrders((prev) => {
      const touched = new Set<string>()
      let any = false
      const next = prev.map((o) => {
        const sd =
          o.selectedDrinkId && ids.has(o.selectedDrinkId)
            ? o.selectedDrinkId
            : null
        /** current_food 為任意文字／多段品項，不因菜單 id 表變更而清空 */
        if (sd === o.selectedDrinkId) return o
        any = true
        touched.add(o.userId)
        return { ...o, selectedDrinkId: sd }
      })
      if (any) {
        queueMicrotask(() => {
          for (const id of touched) schedulePersist(id)
        })
      }
      return any ? next : prev
    })
  }, [menu, categories, menuMap, schedulePersist])

  useEffect(() => {
    const selectedChanged = previousSelectedPersonIdRef.current !== selectedPersonId
    previousSelectedPersonIdRef.current = selectedPersonId
    if (mealDraftEditingRef.current || mealDraftComposingRef.current) {
      if (!selectedChanged) return
    }
    const o = orders.find((x) => x.userId === selectedPersonId)
    const slotCount = Math.max(1, mealSlotCounts[selectedPersonId] ?? 1)
    setMealLineDrafts(mealLinesForEditor(o?.selectedFoodId, slotCount))
    setFoodRemarkDraft(o?.foodRemark ?? '')
  }, [selectedPersonId, orders, mealSlotCounts])

  useEffect(() => {
    setMealSlotCounts((prev) => {
      const next: Record<string, number> = {}
      for (const p of personnel) {
        const o = orders.find((x) => x.userId === p.id)
        const persistedCount = mealSlotCountFromCurrentFood(o?.selectedFoodId)
        next[p.id] = Math.max(1, persistedCount, prev[p.id] ?? 1)
      }
      return next
    })
  }, [personnel, orders])

  /** 換人時中止抽獎動畫並重置顯示狀態 */
  useEffect(() => {
    spinSessionIdRef.current += 1
    if (spinRafRef.current != null) {
      cancelAnimationFrame(spinRafRef.current)
      spinRafRef.current = null
    }
    setSpinPhase('idle')
    setShufflePreviewId(null)
    setLastSpinFoodId(null)
    setCelebratePick(false)
    setDislikeModalOpen(false)
  }, [selectedPersonId])

  useEffect(() => {
    return () => {
      if (nameClickTimerRef.current) clearTimeout(nameClickTimerRef.current)
      if (spinRafRef.current != null) cancelAnimationFrame(spinRafRef.current)
    }
  }, [])

  const patchPersonnel = useCallback(
    (id: string, patch: Partial<Personnel>) => {
      setPersonnel((prev) =>
        prev.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      )
      const debounced =
        Object.prototype.hasOwnProperty.call(patch, 'name') ||
        Object.prototype.hasOwnProperty.call(patch, 'extraRemark') ||
        Object.prototype.hasOwnProperty.call(patch, 'drinkRemark')
      if (debounced) schedulePersistDebounced(id)
      else schedulePersist(id)
    },
    [schedulePersist, schedulePersistDebounced],
  )

  /** 餐點備註（對外）：先更新草稿，離焦時再強制寫入資料庫 */
  const onFoodRemarkInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value
      if (!selectedPersonId) return
      const person = personnel.find((x) => x.id === selectedPersonId)
      const currentOrder = orders.find((o) => o.userId === selectedPersonId)
      const nextRemark = applyNotToastedRemark(
        v,
        currentOrder?.selectedFoodId,
        person?.isNotToasted,
        menuMap,
        menu,
      )
      setFoodRemarkDraft(nextRemark ?? '')
      setOrders((prev) =>
        prev.map((o) =>
          o.userId === selectedPersonId
            ? { ...o, foodRemark: nextRemark }
            : o,
        ),
      )
      schedulePersistDebounced(selectedPersonId)
    },
    [selectedPersonId, personnel, orders, menuMap, menu, schedulePersistDebounced],
  )

  /** 切換備註中的「+蛋」（current_note），並立即寫入以更新金額卡 */
  const toggleEggRemark = useCallback(async () => {
    try {
      if (!selectedPersonId) return
      const person = personnel.find((x) => x.id === selectedPersonId)
      if (!person || person.isAbsent) return
      const o = orders.find((x) => x.userId === selectedPersonId)
      if (!o) return
      const cur = o.foodRemark ?? ''
      const next = cur.includes(EGG_REMARK_TOKEN)
        ? cur.split(EGG_REMARK_TOKEN).join('').replace(/\s+/g, ' ').trim()
        : cur
          ? `${cur}${EGG_REMARK_TOKEN}`
          : EGG_REMARK_TOKEN
      const normalizedRemark = applyNotToastedRemark(
        next,
        o.selectedFoodId,
        person.isNotToasted,
        menuMap,
        menu,
      )
      const nextOrder = {
        ...o,
        foodRemark: normalizedRemark,
      }
      await persistUserSnapshotNow(person, nextOrder)
      setFoodRemarkDraft(normalizedRemark ?? '')
      setOrders((prev) =>
        prev.map((row) => (row.userId === selectedPersonId ? nextOrder : row)),
      )
      setEggAmountFlashUserId(selectedPersonId)
      if (eggFlashTimerRef.current) clearTimeout(eggFlashTimerRef.current)
      eggFlashTimerRef.current = setTimeout(() => {
        setEggAmountFlashUserId(null)
        eggFlashTimerRef.current = null
      }, 520)
    } catch (err) {
      console.error('Supabase Error:', err)
    }
  }, [selectedPersonId, personnel, orders, persistUserSnapshotNow, menuMap, menu])

  const toggleDislikedFood = useCallback(
    (foodId: string) => {
      if (!selectedPersonId) return
      setPersonnel((prev) =>
        prev.map((p) => {
          if (p.id !== selectedPersonId) return p
          const has = p.dislikedFoodIds.includes(foodId)
          return {
            ...p,
            dislikedFoodIds: has
              ? p.dislikedFoodIds.filter((x) => x !== foodId)
              : [...p.dislikedFoodIds, foodId],
          }
        }),
      )
      schedulePersist(selectedPersonId)
    },
    [selectedPersonId, schedulePersist],
  )

  const toggleCategoryAllDisliked = useCallback(
    (categoryId: string) => {
      if (!selectedPersonId) return
      const itemIds = menu
        .filter((m) => m.categoryId === categoryId)
        .map((m) => m.id)
      if (itemIds.length === 0) return
      setPersonnel((prev) =>
        prev.map((p) => {
          if (p.id !== selectedPersonId) return p
          const allMarked = itemIds.every((id) =>
            p.dislikedFoodIds.includes(id),
          )
          const next = new Set(p.dislikedFoodIds)
          if (allMarked) {
            for (const id of itemIds) next.delete(id)
          } else {
            for (const id of itemIds) next.add(id)
          }
          return { ...p, dislikedFoodIds: [...next] }
        }),
      )
      schedulePersist(selectedPersonId)
    },
    [selectedPersonId, menu, schedulePersist],
  )

  /** 刪除目前選中的同事（標題列「－」；至少保留一人） */
  const deleteSelectedColleague = useCallback(async () => {
    if (personnel.length <= 1 || !selectedPersonId) return
    if (!window.confirm('確定從名單移除此同事？')) return
    const id = selectedPersonId
    try {
      await deleteColleagueById(id)
    } catch (e) {
      console.error(e)
      return
    }
    setPersonnel((prev) => {
      const next = prev
        .filter((p) => p.id !== id)
        .map((p, i) => ({ ...p, orderIndex: i + 1 }))
      setSelectedPersonId(next[0]?.id ?? '')
      queueMicrotask(() => {
        void updateColleagueOrderIndices(next.map((p) => p.id)).catch((err) => {
          console.error(err)
        })
      })
      return next
    })
    setMealSlotCounts((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setOrders((prev) => prev.filter((o) => o.userId !== id))
  }, [personnel.length, selectedPersonId])

  const clearPersonMeal = useCallback(
    async (userId: string) => {
      try {
        const person = personnel.find((p) => p.id === userId)
        const order = orders.find((o) => o.userId === userId)
        if (!person || !order) return
        const nextOrder = {
          ...order,
          selectedFoodId: null,
          foodRemark: undefined,
          manualFoodPrice: 0,
        }
        await persistUserSnapshotNow(person, nextOrder)
        setOrders((prev) =>
          prev.map((o) => (o.userId === userId ? nextOrder : o)),
        )
        setMealSlotCounts((prev) => ({ ...prev, [userId]: 1 }))
        if (userId === selectedPersonId) {
          setMealLineDrafts([''])
          setFoodRemarkDraft('')
        }
      } catch (err) {
        console.error('Supabase Error:', err)
      }
    },
    [personnel, orders, persistUserSnapshotNow, selectedPersonId],
  )

  /** 將多欄草稿寫入 current_food（與轉盤共用）；全空則清除餐點與餐點備註 */
  const persistMealLines = useCallback(
    async (lines: string[]) => {
      try {
        if (!selectedPersonId) return
        const p = personnel.find((x) => x.id === selectedPersonId)
        if (p?.isAbsent) return
        const joined = joinMealLinesToCurrentFood(lines)
        const currentOrder = orders.find((row) => row.userId === selectedPersonId)
        if (!p || !currentOrder) return
        if (joined === null) {
          const emptyStructure = serializeEmptyMealSlots(lines.length)
          const nextRemark = applyNotToastedRemark(
            undefined,
            emptyStructure,
            p.isNotToasted,
            menuMap,
            menu,
          )
          const nextOrder = {
            ...currentOrder,
            selectedFoodId: emptyStructure,
            foodRemark: nextRemark,
            manualFoodPrice: 0,
          }
          await persistUserSnapshotNow(p, nextOrder)
          setOrders((prev) =>
            prev.map((row) =>
              row.userId === selectedPersonId ? nextOrder : row,
            ),
          )
          setFoodRemarkDraft(nextRemark ?? '')
          setMealLineDrafts(emptyMealLines(lines.length))
          setMealSlotCounts((prev) => ({ ...prev, [selectedPersonId]: lines.length }))
        } else {
          const unmatchedSegments = splitCurrentFoodSegments(joined).filter(
            (segment) => !resolveMealItemFromSegment(segment, menuMap, menu),
          )
          const shouldPromptManualPrice =
            unmatchedSegments.length > 0 &&
            (currentOrder?.selectedFoodId !== joined ||
              (currentOrder?.manualFoodPrice ?? 0) <= 0)
          const nextManualFoodPrice =
            shouldPromptManualPrice
              ? promptForManualFoodPrice(
                  unmatchedSegments.join(' + '),
                  currentOrder?.manualFoodPrice ?? 0,
                )
              : unmatchedSegments.length > 0
                ? currentOrder?.manualFoodPrice ?? 0
                : 0
          const nextOrder = {
            ...currentOrder,
            selectedFoodId: joined,
            foodRemark: applyNotToastedRemark(
              currentOrder.foodRemark,
              joined,
              p.isNotToasted,
              menuMap,
              menu,
            ),
            manualFoodPrice: nextManualFoodPrice,
          }
          await persistUserSnapshotNow(p, nextOrder)
          setOrders((prev) =>
            prev.map((row) =>
              row.userId === selectedPersonId
                ? nextOrder
                : row,
            ),
          )
          setMealSlotCounts((prev) => ({
            ...prev,
            [selectedPersonId]: splitCurrentFoodSegments(joined).length,
          }))
          setFoodRemarkDraft(nextOrder.foodRemark ?? '')
        }
      } catch (err) {
        console.error('Supabase Error:', err)
      }
    },
    [selectedPersonId, personnel, orders, menuMap, menu, persistUserSnapshotNow],
  )

  const commitMealLines = useCallback(
    async (lines?: string[]) => {
      await persistMealLines(lines ?? latestMealLineDraftsRef.current)
    },
    [persistMealLines],
  )

  const setMealDraftLineValue = useCallback((index: number, value: string) => {
    setMealLineDrafts((prev) => {
      const next = replaceMealDraftLine(prev, index, value)
      latestMealLineDraftsRef.current = next
      return next
    })
  }, [])

  const beginMealDraftEditing = useCallback(() => {
    mealDraftEditingRef.current = true
  }, [])

  const endMealDraftEditing = useCallback(() => {
    mealDraftEditingRef.current = false
    mealDraftComposingRef.current = false
  }, [])

  const addMealLineRow = useCallback(() => {
    if (!selectedPersonId) return
    setMealLineDrafts((prev) => {
      const next = [...prev, '']
      setMealSlotCounts((counts) => ({ ...counts, [selectedPersonId]: next.length }))
      return next
    })
  }, [selectedPersonId])

  const removeMealLineRow = useCallback(
    (index: number) => {
      if (index < 1 || !selectedPersonId) return
      setMealLineDrafts((prev) => {
        const next = prev.filter((_, i) => i !== index)
        const normalized = next.length === 0 ? [''] : next
        setMealSlotCounts((counts) => ({
          ...counts,
          [selectedPersonId]: normalized.length,
        }))
        queueMicrotask(() => persistMealLines(normalized))
        return normalized
      })
    },
    [persistMealLines, selectedPersonId],
  )

  /**
   * 清空所有人非指定套用的餐點，並將全員恢復為出勤（取消休假）。
   */
  const clearAllWheelFoodsGlobally = useCallback(async () => {
    try {
      const {
        personnel: currentPersonnel,
        orders: currentOrders,
        selectedPersonId: currentSelectedPersonId,
      } = getLatestBreakfastState()
      const targets = currentPersonnel.filter((p) => p.isFixedMeal !== true)
      const currentIds = new Set(currentPersonnel.map((p) => p.id))
      const targetIds = new Set(targets.map((p) => p.id))
      const nextSlotCounts = Object.fromEntries(
        currentPersonnel.map((p) => [p.id, Math.max(1, mealSlotCounts[p.id] ?? 1)]),
      ) as Record<string, number>
      const idsToBulkClear: string[] = []
      const nextO = currentOrders
        .filter((o) => currentIds.has(o.userId))
        .map((o) => {
          if (targetIds.has(o.userId)) {
            idsToBulkClear.push(o.userId)
            nextSlotCounts[o.userId] = 1
            return {
              ...o,
              selectedFoodId: '',
              foodRemark: undefined,
              manualFoodPrice: 0,
            }
          }
          return o
        })
      if (idsToBulkClear.length === 0) return
      setPersistingCount((n) => n + 1)
      try {
        await bulkClearBreakfastFieldsByIds(idsToBulkClear)
      } finally {
        setPersistingCount((n) => Math.max(0, n - 1))
      }
      setOrders((prev) =>
        prev.map((o) => nextO.find((next) => next.userId === o.userId) ?? o),
      )
      latestOrdersRef.current = latestOrdersRef.current.map(
        (o) => nextO.find((next) => next.userId === o.userId) ?? o,
      )
      setMealSlotCounts(nextSlotCounts)
      setMealLineDrafts(
        mealLinesForEditor(
          nextO.find((o) => o.userId === currentSelectedPersonId)?.selectedFoodId,
          Math.max(1, nextSlotCounts[currentSelectedPersonId] ?? 1),
        ),
      )
      if (currentSelectedPersonId) {
        const selectedNextOrder = nextO.find((o) => o.userId === currentSelectedPersonId)
        setFoodRemarkDraft(selectedNextOrder?.foodRemark ?? '')
      }
    } catch (err) {
      console.error('Supabase Error:', err)
    }
  }, [getLatestBreakfastState, mealSlotCounts])

  /**
   * 一鍵全員轉盤：略過休假；僅對 current_food 為空者抽籤，寫入品項顯示名稱（與手動輸入同欄）。
   * 若勾選吐司不烤且餐點包含吐司，會同步把不烤寫入備註。
   */
  const batchSpinAll = useCallback(async () => {
    try {
    const {
      personnel: currentPersonnel,
      orders: currentOrders,
      selectedPersonId: currentSelectedPersonId,
    } = getLatestBreakfastState()
    const targets = currentPersonnel.filter(
      (p) => p.isFixedMeal !== true && !p.isAbsent,
    )
    const targetIds = new Set(targets.map((p) => p.id))
    spinSessionIdRef.current += 1
    if (spinRafRef.current != null) {
      cancelAnimationFrame(spinRafRef.current)
      spinRafRef.current = null
    }
    setSpinPhase('idle')
    setShufflePreviewId(null)
    setLastSpinFoodId(null)
    setCelebratePick(false)

    const nextO = currentOrders.map((o) => {
      if (!targetIds.has(o.userId)) return o
      const p = currentPersonnel.find((x) => x.id === o.userId)
      if (!p) return o
      if (!foodLineIsEmpty(o.selectedFoodId)) return o
      const slotCount = Math.max(1, mealSlotCounts[o.userId] ?? 1)

      const drink = p.fixedDrinkId
        ? menuFromMap(menuMap, p.fixedDrinkId)
        : undefined
      const drinkPrice =
        drink && isDrinkItem(drink) ? drink.price : 0
      const remaining = globalBudget - drinkPrice
      const pool = filterItemsForWheel(
        menu,
        new Set(p.dislikedFoodIds),
        remaining,
      )

      if (pool.length === 0) {
        return {
          ...o,
          selectedFoodId: serializeEmptyMealSlots(slotCount),
          foodRemark: applyNotToastedRemark(
            undefined,
            serializeEmptyMealSlots(slotCount),
            p.isNotToasted,
            menuMap,
            menu,
          ),
          manualFoodPrice: 0,
        }
      }

      const labels = pickDistinctMealLabelsForPerson(pool, p, slotCount)
      return {
        ...o,
        selectedFoodId: labels.join(' + '),
        foodRemark: applyNotToastedRemark(
          undefined,
          labels.join(' + '),
          p.isNotToasted,
          menuMap,
          menu,
        ),
        manualFoodPrice: 0,
      }
    })
    const changedRows = nextO
      .map((o, index) => {
        const prev = currentOrders[index]
        if (
          prev?.userId === o.userId &&
          prev?.selectedFoodId === o.selectedFoodId &&
          prev?.foodRemark === o.foodRemark &&
          (prev?.manualFoodPrice ?? 0) === (o.manualFoodPrice ?? 0)
        ) {
          return null
        }
        const p = currentPersonnel.find((x) => x.id === o.userId)
        return p ? colleagueRowFromPersonnelAndOrder(p, o) : null
      })
      .filter((r) => r != null)
    await persistRowsNow(changedRows)
    setOrders(nextO)
    latestOrdersRef.current = nextO
    if (currentSelectedPersonId) {
      const selectedNextOrder = nextO.find((o) => o.userId === currentSelectedPersonId)
      if (selectedNextOrder) {
        setMealLineDrafts(
          mealLinesForEditor(
            selectedNextOrder.selectedFoodId,
            Math.max(1, mealSlotCounts[currentSelectedPersonId] ?? 1),
          ),
        )
        setFoodRemarkDraft(selectedNextOrder.foodRemark ?? '')
      }
    }
    } catch (error) {
      console.error(error)
    }
  }, [getLatestBreakfastState, menu, menuMap, globalBudget, mealSlotCounts, persistRowsNow])

  const startWheel = useCallback(async () => {
    try {
    const {
      personnel: currentPersonnel,
      orders: currentOrders,
      selectedPersonId: currentSelectedPersonId,
    } = getLatestBreakfastState()
    if (!currentSelectedPersonId || wheelCandidates.length === 0) return
    const targets = currentPersonnel.filter((p) => p.isFixedMeal !== true)
    const targetIds = new Set(targets.map((p) => p.id))
    if (!targetIds.has(currentSelectedPersonId)) return
    const co = currentOrders.find((o) => o.userId === currentSelectedPersonId)
    if (co && !foodLineIsEmpty(co.selectedFoodId)) return
    const p = currentPersonnel.find((x) => x.id === currentSelectedPersonId)
    if (!p || p.isAbsent || p.isFixedMeal) return

    const pool = wheelCandidates
    const n = pool.length
    const pickIdx = Math.floor(Math.random() * n)
    const pick = pool[pickIdx]
    const slotCount = Math.max(
      1,
      mealLineDrafts.length,
      mealSlotCounts[currentSelectedPersonId] ?? 1,
    )
    const labels = pickDistinctMealLabelsForPerson(pool, p, slotCount)
    const mealLabel = labels.join(' + ')
    const nextOrderForPersist: Order = {
      ...(currentOrders.find((o) => o.userId === currentSelectedPersonId) ?? {
        userId: currentSelectedPersonId,
        selectedDrinkId: p.fixedDrinkId ?? null,
        selectedFoodId: mealLabel,
        foodRemark: undefined,
        manualFoodPrice: 0,
      }),
      selectedFoodId: mealLabel,
      foodRemark: applyNotToastedRemark(
        undefined,
        mealLabel,
        p.isNotToasted,
        menuMap,
        menu,
      ),
      manualFoodPrice: 0,
    }
    const persistPromise = persistUserSnapshotNow(p, nextOrderForPersist)

    spinSessionIdRef.current += 1
    const session = spinSessionIdRef.current
    if (spinRafRef.current != null) {
      cancelAnimationFrame(spinRafRef.current)
      spinRafRef.current = null
    }

    setCelebratePick(false)
    setSpinPhase('spinning')
    setLastSpinFoodId(null)
    setShufflePreviewId(pool[Math.floor(Math.random() * n)].id)

    /** 總時長約 2～3 秒：前期約每數十毫秒換名，後期 ease-out 減速 */
    const totalMs = 2000 + Math.random() * 1000
    const start = performance.now()
    let lastShuffleAt = start - 999
    const easeOutCubic = (u: number) => 1 - (1 - u) ** 3

    const run = (now: number) => {
      if (session !== spinSessionIdRef.current) return

      const elapsed = now - start
      const t = Math.min(1, elapsed / totalMs)
      const intervalMs = 34 + easeOutCubic(t) * 340

      if (t < 1) {
        if (now - lastShuffleAt >= intervalMs) {
          setShufflePreviewId(pool[(Math.random() * n) | 0].id)
          lastShuffleAt = now
        }
        spinRafRef.current = requestAnimationFrame(run)
        return
      }

      setShufflePreviewId(pick.id)
      void persistPromise
        .then(() => {
          setOrders((prev) =>
            prev.map((o) =>
              o.userId === currentSelectedPersonId ? nextOrderForPersist : o,
            ),
          )
          latestOrdersRef.current = latestOrdersRef.current.map((o) =>
            o.userId === currentSelectedPersonId ? nextOrderForPersist : o,
          )
          setMealLineDrafts(mealLinesForEditor(mealLabel, slotCount))
          setFoodRemarkDraft('')
          setLastSpinFoodId(pick.id)
          setSpinPhase('idle')
          setCelebratePick(true)
          window.setTimeout(() => setCelebratePick(false), 1400)
        })
        .catch((e) => {
          console.error(e)
          setSpinPhase('idle')
          setShufflePreviewId(null)
          setCelebratePick(false)
        })
      spinRafRef.current = null
    }

    spinRafRef.current = requestAnimationFrame(run)
    } catch (error) {
      console.error(error)
      setSpinPhase('idle')
      setShufflePreviewId(null)
      setCelebratePick(false)
    }
  }, [
    getLatestBreakfastState,
    wheelCandidates,
    persistUserSnapshotNow,
    mealLineDrafts.length,
    mealSlotCounts,
  ])

  const togglePersonAbsentByDoubleClick = useCallback(
    (id: string) => {
      const cur = personnel.find((x) => x.id === id)
      if (!cur) return
      const nextAbsent = !cur.isAbsent
      const nextPersonnel = personnel.map((p) =>
        p.id === id ? { ...p, isAbsent: nextAbsent } : p,
      )
      setPersonnel(nextPersonnel)
      latestPersonnelRef.current = nextPersonnel
      const p = nextPersonnel.find((x) => x.id === id)!
      const o = orders.find((x) => x.userId === id)
      void persistRowsNow([colleagueRowFromPersonnelAndOrder(p, o)]).catch((err) => {
        console.error('Supabase Error:', err)
      })
    },
    [personnel, orders, persistRowsNow],
  )

  const scheduleSelectPerson = useCallback((id: string) => {
    if (nameClickTimerRef.current) clearTimeout(nameClickTimerRef.current)
    nameClickTimerRef.current = setTimeout(() => {
      nameClickTimerRef.current = null
      setSelectedPersonId(id)
    }, 280)
  }, [])

  const cancelScheduledSelectAndToggleAbsent = useCallback(
    (id: string) => {
      if (nameClickTimerRef.current) {
        clearTimeout(nameClickTimerRef.current)
        nameClickTimerRef.current = null
      }
      togglePersonAbsentByDoubleClick(id)
    },
    [togglePersonAbsentByDoubleClick],
  )

  const handleColleagueRowDragOver = useCallback(
    (e: DragEvent<HTMLLIElement>) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    [],
  )

  const handleColleagueDrop = useCallback(
    (e: DragEvent<HTMLLIElement>, targetId: string) => {
      e.preventDefault()
      setColleagueDragOverId(null)
      const sourceId = e.dataTransfer.getData('text/plain')
      if (!sourceId || sourceId === targetId) return
      setPersonnel((prev) => {
        const next = reorderPersonnelByInsert(prev, sourceId, targetId)
        queueMicrotask(() => {
          void updateColleagueOrderIndices(next.map((p) => p.id)).catch(
            (err) => {
              console.error(err)
            },
          )
        })
        return next
      })
    },
    [],
  )

  /**
   * 新增同事：寫入 Supabase（欄位與 colleagues 表一致），成功後由父層 refetch 帶回最新名單。
   */
  const handleAddColleague = useCallback(async () => {
    if (addColleagueBusy) return
    const nameTrim = newColleagueName.trim()
    const displayName = nameTrim.length > 0 ? nameTrim : '新同事'
    /** 與 Supabase uuid 欄位相容（勿使用非 UUID 字串） */
    const id = crypto.randomUUID()
    const maxOrder = personnel.reduce((m, p) => Math.max(m, p.orderIndex), 0)
    const nextOrderIndex = maxOrder + 1
    const row = buildNewColleagueInsertPayload(id, displayName, nextOrderIndex)
    setAddColleagueError(null)
    setAddColleagueBusy(true)
    try {
      await insertColleagueRow(row)
      setNewColleagueName('')
      if (onColleaguesSynced) {
        await onColleaguesSynced({ newPersonId: id })
      } else {
      const p: Personnel = {
          id,
          orderIndex: nextOrderIndex,
          name: displayName,
          fixedDrinkId: null,
          dislikedFoodIds: [],
          extraRemark: undefined,
          drinkRemark: '',
          isFixedMeal: false,
          isNotToasted: false,
          isAbsent: false,
        }
        const o: Order = {
          userId: id,
          selectedDrinkId: null,
          selectedFoodId: null,
          foodRemark: undefined,
          manualFoodPrice: 0,
        }
        setPersonnel((prev) => [...prev, p])
        setOrders((prev) => [...prev, o])
        setSelectedPersonId(id)
      }
    } catch (e) {
      console.error('新增失敗詳細原因:', e)
      const msg =
        e && typeof e === 'object' && 'message' in e
          ? String((e as { message?: unknown }).message)
          : String(e)
      setAddColleagueError(msg || '新增失敗')
    } finally {
      setAddColleagueBusy(false)
    }
  }, [addColleagueBusy, newColleagueName, onColleaguesSynced, personnel])

  const shopSummaryLines = useMemo(
    () => buildShopSummaryLines(menuMap, menu, orders, personnel),
    [menuMap, menu, orders, personnel],
  )

  const wheelEmptyCenterText = useMemo(() => {
    const sp = personnel.find((p) => p.id === selectedPersonId)
    if (sp?.isAbsent) return '休假中'
    return '預算不足或無符合餐點'
  }, [personnel, selectedPersonId])

  /** 抽獎顯示框：跳動預覽或開獎結果 */
  const lotteryBoxItem = useMemo(() => {
    if (spinPhase === 'spinning' && shufflePreviewId) {
      return menuFromMap(menuMap, shufflePreviewId)
    }
    if (spinPhase === 'idle' && lastSpinFoodId) {
      return menuFromMap(menuMap, lastSpinFoodId)
    }
    return undefined
  }, [spinPhase, shufflePreviewId, lastSpinFoodId, menuMap])

  /** 同事列：休假時由格內圖示表示；未選飲料／餐點時為空白（不顯示「無」「尚未選餐」） */
  const colleagueRowDisplay = (userId: string) => {
    const o = orders.find((x) => x.userId === userId)
    const p = personnel.find((x) => x.id === userId)
    if (!o || !p) {
      return { name: '—', drinkName: '', mealLine: '', mealSegments: [], mealRemark: '' }
    }
    const drinkItem = o.selectedDrinkId ? menuFromMap(menuMap, o.selectedDrinkId) : undefined
    const drinkName = drinkItem ? formatFoodLabelForPerson(drinkItem, p) : ''
    const mealSegments = splitCurrentFoodSegments(o.selectedFoodId).map(
      (seg) => labelForFoodSegment(menuMap, menu, seg, p, o.foodRemark) ?? seg,
    )
    const mealRemark = ''
    const mealLine = buildFoodLineForShop(menuMap, menu, o, p) ?? ''
    return { name: p.name, drinkName, mealLine, mealSegments, mealRemark }
  }

  const todayMealSummaryLine = useMemo(() => {
    if (!selectedPerson || !currentOrder) return ''
    if (selectedPerson.isAbsent) return '休假中'
    const raw = (currentOrder.selectedFoodId ?? '').trim()
    if (!raw) return ''
    const fr = (currentOrder.foodRemark ?? '').trim()
    const segments = splitCurrentFoodSegments(raw)
    const parts = segments.map((seg) => {
      const item =
        menuFromMap(menuMap, seg) ?? menu.find((m) => m.name === seg)
      if (item) {
        const base = formatFoodLabelForPerson(item, selectedPerson, {
          foodRemark: fr,
        })
        return `${base}（$${item.price}）`
      }
      return `${appendDisplayRemark(seg, fr)}（未入價）`
    })
    return parts.join(' + ')
  }, [selectedPerson, currentOrder, menuMap, menu])

  return (
    <>
    <div className="w-full text-slate-900">
      <div className="flex w-full flex-col px-4 py-4 sm:px-6 lg:px-8 lg:py-5">
        {/* 截圖專區 2/3 · 操作專區 1/3 */}
        <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-3 lg:gap-5">
          {/* 左 2/3：截圖專區（同事列表 → 店家彙整 → 新增同事） */}
          <aside className="flex min-w-0 flex-col lg:col-span-2">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl border border-amber-200/70 bg-white/90 shadow-sm">
              <div className="border-b border-amber-100 px-3 py-3 sm:px-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold text-amber-950">
                      同事列表
                    </h2>
                    <p className="mt-1 text-xs text-amber-800/60">
                      共 {personnel.length} 人 · 單擊姓名選取、雙擊切換休假；右側編輯
                    </p>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 sm:gap-2 sm:pt-0.5">
                    <button
                      type="button"
                      onClick={deleteSelectedColleague}
                      disabled={personnel.length <= 1}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-rose-300/90 bg-rose-50 text-lg font-semibold leading-none text-rose-900 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-40"
                      title="刪除目前選中的同事"
                      aria-label="刪除同事"
                    >
                      －
                    </button>
                    <button
                      type="button"
                      onClick={() => void batchSpinAll()}
                      disabled={isPersisting}
                      className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-amber-600 px-2.5 text-[11px] font-bold text-white shadow-sm hover:bg-amber-700 sm:px-3 sm:text-xs"
                      title="僅為「今日餐點」空白者抽籤；已有餐點文字者略過；休假者略過"
                    >
                      🎲 全員轉盤
                    </button>
                    <button
                      type="button"
                      onClick={() => void clearAllWheelFoodsGlobally()}
                      disabled={isPersisting}
                      className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 px-2.5 text-[11px] font-semibold text-rose-800 hover:bg-rose-100 sm:px-3 sm:text-xs"
                      title="清除全員今日餐點與餐點備註，並將全員恢復為出勤"
                    >
                      一鍵淨空
                    </button>
                    <label className="inline-flex h-8 min-w-0 max-w-full items-center gap-1 rounded-lg border border-amber-300/90 bg-amber-50/80 px-2 py-1 pl-2.5 shadow-inner">
                      <span className="shrink-0 text-[10px] font-medium text-amber-900/80 sm:text-[11px]">
                        預算
                      </span>
                      <span className="flex min-w-0 items-center gap-0.5 text-amber-800/70">
                        $
                        <input
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          value={budgetInput}
                          onChange={(e) => handleBudgetInputChange(e.target.value)}
                          onBlur={(e) => {
                            void handleBudgetInputBlur(e.target.value)
                          }}
                          aria-label="全域預算（每人餐點上限）"
                          className="w-[3.25rem] min-w-0 appearance-none border-0 bg-transparent py-0 text-right text-xs font-semibold tabular-nums outline-none ring-0 focus:ring-0 sm:w-[3.75rem] sm:text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                      </span>
                    </label>
                    {isPersisting ? (
                      <span className="inline-flex h-8 items-center text-[10px] font-medium text-amber-900/75 sm:text-[11px]">
                        儲存中…
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <ul className="h-auto flex-1 px-1 pb-0 pt-1 sm:px-2">
                {personnel.length === 0 ? (
                  <li className="list-none px-3 py-10 text-center text-sm text-amber-800/80">
                    尚無同事列在此處；請使用本欄最下方「新增同事」加入第一位。
                  </li>
                ) : null}
                {personnel.map((p) => {
                  const active = p.id === selectedPersonId
                  const row = colleagueRowDisplay(p.id)
                  const orderRow = orders.find((x) => x.userId === p.id)
                  const { total: lineTotal, hasUnpriced } =
                    computeColleagueOrderTotal(p, orderRow, menu)
                  return (
                    <li
                      key={p.id}
                      className={`border-b border-amber-100/80 last:border-b-0 ${
                        colleagueDragOverId === p.id &&
                        colleagueDragId &&
                        colleagueDragId !== p.id
                          ? 'bg-amber-50/95 ring-1 ring-inset ring-amber-400/50'
                          : p.isAbsent
                            ? 'bg-slate-300/40'
                            : ''
                      } ${colleagueDragId === p.id ? 'opacity-60' : ''}`}
                      onDragOver={handleColleagueRowDragOver}
                      onDragEnter={() => setColleagueDragOverId(p.id)}
                      onDragLeave={(e) => {
                        const rel = e.relatedTarget as Node | null
                        if (e.currentTarget.contains(rel)) return
                        setColleagueDragOverId(null)
                      }}
                      onDrop={(e) => handleColleagueDrop(e, p.id)}
                    >
                      <div
                        className={`grid grid-cols-12 gap-0.5 py-1 pl-0.5 pr-0.5 transition sm:gap-1 sm:pl-1 sm:pr-1 ${
                          active
                            ? 'bg-amber-100/90 ring-1 ring-inset ring-amber-300/80'
                            : p.isAbsent
                              ? 'bg-slate-300/50'
                              : 'hover:bg-amber-50/80'
                        }`}
                      >
                        <div className="col-span-2 flex min-h-[2.2rem] min-w-0 gap-0.5">
                          <button
                            type="button"
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData('text/plain', p.id)
                              e.dataTransfer.effectAllowed = 'move'
                              setColleagueDragId(p.id)
                            }}
                            onDragEnd={() => {
                              setColleagueDragId(null)
                              setColleagueDragOverId(null)
                            }}
                            onClick={(e) => e.stopPropagation()}
                            title="拖曳排序"
                            aria-label={`拖曳以調整 ${p.name} 的順序`}
                            className="flex w-6 shrink-0 cursor-grab touch-none flex-col items-center justify-center rounded-md border border-transparent bg-transparent text-slate-400 hover:bg-slate-200/50 hover:text-slate-600 active:cursor-grabbing"
                          >
                            <ColleagueDragHandleIcon />
                          </button>
                          <button
                            type="button"
                            title={`${p.name}（雙擊切換休假）`}
                            onClick={() => scheduleSelectPerson(p.id)}
                            onDoubleClick={(e) => {
                              e.preventDefault()
                              cancelScheduledSelectAndToggleAbsent(p.id)
                            }}
                            className={`flex min-h-[2.2rem] min-w-0 max-w-[5.25rem] flex-1 cursor-pointer flex-col items-center justify-center rounded-lg border px-1 py-0.5 text-center text-xs font-semibold leading-tight shadow-sm sm:max-w-[5.75rem] sm:text-sm ${
                              p.isAbsent
                                ? 'border-slate-400/90 bg-slate-300 text-slate-700'
                                : 'border-slate-200/90 bg-slate-100 text-slate-900 hover:bg-slate-200/70'
                            }`}
                          >
                            <span className="line-clamp-2 w-full break-words text-center leading-tight">
                              {p.name}
                            </span>
                          </button>
                        </div>

                        <div
                          className={`col-span-3 flex min-h-[2.2rem] min-w-0 items-stretch rounded-lg border px-1 py-0.5 shadow-sm ${
                            p.isAbsent
                              ? 'border-slate-400/90 bg-slate-300'
                              : 'border-slate-200/90 bg-slate-100'
                          }`}
                        >
                          <button
                            type="button"
                            title={row.drinkName || undefined}
                            onClick={() => scheduleSelectPerson(p.id)}
                            className={`flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-md py-0 text-center text-xs font-medium leading-tight sm:text-sm ${
                              p.isAbsent
                                ? 'text-slate-700 opacity-80'
                                : 'text-slate-900 hover:bg-slate-200/60'
                            }`}
                          >
                            <span className="line-clamp-2 block min-w-0 max-w-full break-words text-center leading-tight">
                              {row.drinkName || (p.isAbsent ? '休假中' : '')}
                            </span>
                          </button>
                        </div>

                        <div className="col-span-5 flex min-h-[2.2rem] min-w-0 items-stretch gap-0.5">
                          <button
                            type="button"
                            onClick={() => scheduleSelectPerson(p.id)}
                            className={`flex min-h-[2.2rem] min-w-0 flex-1 items-center justify-center overflow-hidden rounded-lg border px-1 py-0.5 text-center text-xs font-medium leading-tight shadow-sm sm:text-sm ${
                              p.isAbsent
                                ? 'border-slate-400/90 bg-slate-300 text-slate-700 opacity-80'
                                : 'border-slate-200/90 bg-slate-100 text-slate-900 hover:bg-slate-200/70'
                            }`}
                            title={row.mealLine || undefined}
                          >
                            <span className="flex min-w-0 flex-1 flex-row flex-nowrap items-center justify-center gap-1 overflow-hidden whitespace-nowrap text-center leading-tight">
                              {row.mealSegments.length > 0
                                ? row.mealSegments.map((segment, idx) => (
                                    <span
                                      key={`${p.id}-meal-${idx}`}
                                      className={`min-w-0 shrink truncate rounded px-1 py-0.5 ${
                                        p.isAbsent
                                          ? 'bg-slate-400/60 text-slate-700'
                                          : 'bg-slate-200/80'
                                      }`}
                                    >
                                      {segment}
                                    </span>
                                  ))
                                : p.isAbsent
                                  ? '休假中'
                                  : null}
                              {row.mealRemark ? (
                                <span className="shrink-0 truncate text-[10px] text-slate-500">
                                  （{row.mealRemark}）
                                </span>
                              ) : null}
                            </span>
                          </button>
                          {!p.isAbsent && row.mealLine ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                clearPersonMeal(p.id)
                              }}
                              className="flex h-5 w-5 shrink-0 items-center justify-center self-center rounded-md border border-slate-300/80 bg-white text-[10px] font-bold leading-none text-slate-500 hover:bg-rose-50 hover:text-rose-700"
                              title="清除餐點"
                              aria-label="清除餐點"
                            >
                              ×
                            </button>
                          ) : null}
                        </div>

                        <div
                          className={`col-span-2 flex min-h-[2.2rem] min-w-0 max-w-[4.5rem] items-stretch justify-center self-stretch rounded-lg border px-0.5 py-0.5 text-center shadow-sm sm:max-w-[4.75rem] transition-[transform,box-shadow] duration-300 ease-out will-change-transform ${
                            p.isAbsent
                              ? 'border-slate-400/90 bg-slate-300'
                              : 'border-slate-200/90 bg-slate-100'
                          } ${
                            !p.isAbsent && eggAmountFlashUserId === p.id
                              ? 'z-[1] scale-[1.05] shadow-md ring-2 ring-amber-400 ring-offset-1 ring-offset-amber-50/90'
                              : ''
                          }`}
                          title={
                            p.isAbsent
                              ? undefined
                              : hasUnpriced
                                ? '部分品項與菜單名稱未對應，該項以 0 元計'
                                : `合計 $${lineTotal}`
                          }
                        >
                          <button
                            type="button"
                            onClick={() => scheduleSelectPerson(p.id)}
                            className={`flex w-full min-w-0 flex-col items-center justify-center gap-0.5 ${
                              p.isAbsent ? 'text-slate-700 opacity-80' : 'text-slate-900'
                            }`}
                          >
                            <span className="text-[8px] font-medium uppercase tracking-wide text-slate-500">
                              金額
                            </span>
                            <span
                              className={`text-xs font-bold tabular-nums leading-none sm:text-sm ${
                                p.isAbsent
                                  ? 'text-slate-700'
                                  : hasUnpriced
                                    ? 'text-amber-800'
                                    : 'text-slate-900'
                              }`}
                            >
                              $ {lineTotal}
                            </span>
                            {!p.isAbsent && hasUnpriced ? (
                              <span className="max-w-full truncate text-[9px] leading-tight text-amber-700/90">
                                部分未入價
                              </span>
                            ) : null}
                          </button>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>

              <div className="m-0 w-full border-t border-amber-200/80 bg-amber-50/30 px-4 py-4 sm:px-5">
                <h3 className="text-base font-bold text-amber-950 sm:text-lg">
                  店家點餐彙整（餐點統計明細）
                </h3>
                <div className="mt-2 select-all text-xl leading-relaxed text-black sm:text-2xl">
                  {shopSummaryLines.length > 0 ? (
                    shopSummaryLines.map((line) => (
                      <div key={line}>{line}</div>
                    ))
                  ) : (
                    <div>（尚無品項）</div>
                  )}
                </div>
                <p className="mt-2 text-sm text-amber-900/55 sm:text-base">
                  逐行顯示，可直接複製；若同事有勾選「吐司不烤」且點吐司，總結中會自動帶出
                  (不烤)。
                </p>
              </div>

              <section
                className="border-t border-amber-200/90 bg-amber-50/40 p-4 sm:p-5"
                aria-label="新增同事"
              >
                <h2 className="text-sm font-semibold text-amber-950">
                  新增同事
                </h2>
                <p className="mt-1 text-xs text-amber-900/65">
                  無論名單是否為空都可新增；姓名可留空，將以「新同事」建立。
                </p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                  <label className="min-w-0 flex-1 text-sm font-medium text-slate-800">
                    <span className="sr-only">新同事姓名</span>
                    <input
                      type="text"
                      value={newColleagueName}
                      onChange={(e) => setNewColleagueName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void handleAddColleague()
                        }
                      }}
                      placeholder="姓名（可留空）"
                      autoComplete="off"
                      disabled={addColleagueBusy}
                      className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-3 py-2.5 text-base text-slate-900 outline-none ring-amber-400/30 placeholder:text-slate-400 focus:ring-2 disabled:opacity-60"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={addColleagueBusy}
                    onClick={() => void handleAddColleague()}
                    className="shrink-0 rounded-xl bg-amber-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60 sm:py-3"
                  >
                    {addColleagueBusy ? '新增中…' : '新增同事'}
                  </button>
                </div>
                {addColleagueError ? (
                  <p
                    className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
                    role="alert"
                  >
                    新增失敗：{addColleagueError}
                  </p>
                ) : null}
                {personnel.length === 0 ? (
                  <p className="mt-3 text-sm text-amber-900/75">
                    目前尚無同事，請在此新增第一位；新增後會出現在上方列表。
                  </p>
                ) : null}
              </section>
            </div>
          </aside>

          {/* 右 1/3：操作專區（點餐板、轉盤；預算於左欄工具列） */}
          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 lg:col-span-1">
            {selectedPerson && currentOrder ? (
              <>
            <section
              className="rounded-2xl border border-amber-200/80 bg-white/95 p-4 shadow-sm"
              aria-label="點餐板 Order Board"
            >
              <div className="border-b border-amber-100/90 pb-2">
                <h2 className="text-sm font-semibold text-amber-950">
                  點餐板
                </h2>
                <p className="mt-0.5 text-[11px] text-amber-900/55">
                  Order Board · 左側點姓名選取；以下即時生效。
                </p>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block text-sm font-medium text-slate-800">
                  同事姓名
                  <input
                    type="text"
                    value={selectedPerson.name}
                    onChange={(e) =>
                      patchPersonnel(selectedPersonId, { name: e.target.value })
                    }
                    onBlur={() => schedulePersist(selectedPersonId)}
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-amber-400/30 focus:ring-2"
                  />
                </label>
                <label className="block text-sm font-medium text-slate-800">
                  固定飲料
                  <select
                    value={selectedPerson.fixedDrinkId ?? ''}
                    onChange={(e) =>
                      patchPersonnel(selectedPersonId, {
                        fixedDrinkId:
                          e.target.value === '' ? null : e.target.value,
                      })
                    }
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-amber-400/30 focus:ring-2"
                  >
                    <option value="">無飲料（不扣預算）</option>
                    {drinkOptions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} · ${d.price}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="mt-3 border-t border-amber-100/80 pt-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-xs font-medium text-slate-700">
                      今日餐點（與轉盤共用）
                    </p>
                    <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
                      <input
                        type="checkbox"
                        checked={!!selectedPerson.isFixedMeal}
                        onChange={async (e) => {
                          const nextChecked = e.target.checked
                          try {
                            await updateColleagueFixedMealStatus(
                              selectedPersonId,
                              nextChecked,
                            )
                            setPersonnel((prev) =>
                              prev.map((p) => {
                                const next =
                                  p.id === selectedPersonId
                                    ? { ...p, isFixedMeal: nextChecked }
                                    : p
                                return next
                              }),
                            )
                            latestPersonnelRef.current = latestPersonnelRef.current.map(
                              (p) =>
                                p.id === selectedPersonId
                                  ? { ...p, isFixedMeal: nextChecked }
                                  : p,
                            )
                          } catch (error) {
                            console.error(error)
                          }
                        }}
                        className="size-3.5 rounded border-slate-300"
                      />
                      固定餐點
                    </label>
                  </div>
                  <button
                    type="button"
                    disabled={!!selectedPerson.isAbsent}
                    onClick={() => commitMealLines()}
                    className="shrink-0 rounded-lg border border-amber-300/90 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-950 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    儲存餐點
                  </button>
                </div>
                <div className="flex max-h-[min(22rem,50vh)] flex-col gap-2 overflow-y-auto pr-0.5">
                  {mealLineDrafts.map((line, i) => (
                    <div
                      key={`meal-line-${i}`}
                      className="flex min-w-0 items-stretch gap-2"
                    >
                      <label className="block min-w-0 flex-1 text-sm font-medium text-slate-800">
                        <span className="sr-only">
                          餐點 {i + 1}
                        </span>
                        <input
                          type="text"
                          value={line ?? ''}
                          onFocus={() => beginMealDraftEditing()}
                          onChange={(e) => {
                            setMealDraftLineValue(i, e.target.value)
                          }}
                          onCompositionStart={() => {
                            mealDraftComposingRef.current = true
                          }}
                          onCompositionEnd={() => {
                            mealDraftComposingRef.current = false
                          }}
                          onBlur={(e) => {
                            const nextLines = replaceMealDraftLine(
                              latestMealLineDraftsRef.current,
                              i,
                              e.currentTarget.value,
                            )
                            latestMealLineDraftsRef.current = nextLines
                            setMealLineDrafts(nextLines)
                            endMealDraftEditing()
                            void commitMealLines(nextLines)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              if (
                                mealDraftComposingRef.current ||
                                (e.nativeEvent as KeyboardEvent).isComposing
                              ) {
                                return
                              }
                              e.preventDefault()
                              ;(e.currentTarget as HTMLInputElement).blur()
                            }
                          }}
                          disabled={!!selectedPerson.isAbsent}
                          placeholder={`第 ${i + 1} 道（菜單品項名稱）`}
                          autoComplete="off"
                          className="mt-1 min-h-[3rem] w-full rounded-lg border border-slate-200 bg-white px-3 py-3 text-base leading-snug text-slate-900 outline-none ring-amber-400/30 placeholder:text-slate-400 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      </label>
                      {i === 0 ? (
                        <button
                          type="button"
                          disabled={!!selectedPerson.isAbsent}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => addMealLineRow()}
                          title="新增下一道餐點"
                          className="mt-1 inline-flex h-[3rem] min-w-[3rem] shrink-0 items-center justify-center self-end rounded-lg border border-amber-400/90 bg-amber-50 text-xl font-bold text-amber-950 shadow-sm hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label="新增餐點欄位"
                        >
                          ＋
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={!!selectedPerson.isAbsent}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => removeMealLineRow(i)}
                          title="移除此餐點欄位"
                          className="mt-1 inline-flex h-[3rem] min-w-[3rem] shrink-0 items-center justify-center self-end rounded-lg border border-rose-300/90 bg-rose-50 text-xl font-bold text-rose-800 shadow-sm hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label="刪除此餐點欄位"
                        >
                          －
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-[10px] text-slate-500">
                  失去焦點或按「儲存餐點」會合併寫入（空白欄會略過）；與轉盤共用
                  current_food。「一鍵淨空」會清除全員餐點；休假中無法編輯。
                </p>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-amber-100/80 pt-3">
                <label
                  className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-800"
                  title="勾選後，餐點包含吐司時會自動在備註加入不烤"
                >
                  <input
                    type="checkbox"
                    checked={selectedPerson.isNotToasted ?? false}
                    onChange={async (e) => {
                      try {
                        const nextChecked = e.target.checked
                        const nextPerson = {
                          ...selectedPerson,
                          isNotToasted: nextChecked,
                        }
                        const nextOrder = {
                          ...currentOrder,
                          foodRemark: applyNotToastedRemark(
                            currentOrder.foodRemark ?? foodRemarkDraft,
                            currentOrder.selectedFoodId,
                            nextChecked,
                            menuMap,
                            menu,
                          ),
                        }
                        await persistUserSnapshotNow(nextPerson, nextOrder)
                        setPersonnel((prev) =>
                          prev.map((p) =>
                            p.id === selectedPersonId ? nextPerson : p,
                          ),
                        )
                        latestPersonnelRef.current = latestPersonnelRef.current.map((p) =>
                          p.id === selectedPersonId ? nextPerson : p,
                        )
                        setOrders((prev) =>
                          prev.map((o) =>
                            o.userId === selectedPersonId ? nextOrder : o,
                          ),
                        )
                        latestOrdersRef.current = latestOrdersRef.current.map((o) =>
                          o.userId === selectedPersonId ? nextOrder : o,
                        )
                        setFoodRemarkDraft(nextOrder.foodRemark ?? '')
                      } catch (err) {
                        console.error('Supabase Error:', err)
                      }
                    }}
                    className="rounded border-slate-300"
                  />
                  吐司不烤
                </label>
                <button
                  type="button"
                  disabled={!!selectedPerson.isAbsent}
                  onClick={() => setDislikeModalOpen(true)}
                  className="inline-flex w-auto shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span aria-hidden>🔍</span>
                  設定忌口項目（已設定 {selectedPerson.dislikedFoodIds.length} 項）
                </button>
              </div>

              <div className="mt-2 flex flex-col gap-2 border-t border-amber-100/80 pt-2.5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-2">
                  <label className="block min-w-0 flex-1 text-xs font-medium text-slate-800">
                    餐點忌口 / 備註
                    <input
                      type="text"
                      value={foodRemarkDraft}
                      onChange={onFoodRemarkInputChange}
                      onBlur={() => {
                        void (async () => {
                          const person = personnel.find((x) => x.id === selectedPersonId)
                          const order = orders.find((x) => x.userId === selectedPersonId)
                          if (!person || !order) return
                          const nextRemark = applyNotToastedRemark(
                            foodRemarkDraft,
                            order.selectedFoodId,
                            person.isNotToasted,
                            menuMap,
                            menu,
                          )
                          await persistUserSnapshotNow(person, {
                            ...order,
                            foodRemark: nextRemark,
                          })
                          setOrders((prev) =>
                            prev.map((row) =>
                              row.userId === selectedPersonId
                                ? {
                                    ...row,
                                    foodRemark: nextRemark,
                                  }
                                : row,
                            ),
                          )
                          setFoodRemarkDraft(nextRemark ?? '')
                        })()
                      }}
                      placeholder="例如：不加美乃滋"
                      autoComplete="off"
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none ring-amber-400/30 focus:ring-2"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!!selectedPerson.isAbsent}
                    aria-pressed={foodRemarkDraft.includes(EGG_REMARK_TOKEN)}
                    onClick={() => void toggleEggRemark()}
                    title={`切換備註「${EGG_REMARK_TOKEN}」（總價 ${EGG_EXTRA_PRICE} 元）`}
                    className={`mt-1 shrink-0 rounded-lg border px-3 py-2 text-sm font-bold tabular-nums shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:mt-0 sm:min-h-[2.125rem] ${
                      foodRemarkDraft.includes(EGG_REMARK_TOKEN)
                        ? 'border-amber-500 bg-amber-100 text-amber-950 ring-1 ring-amber-400/60'
                        : 'border-slate-300 bg-white text-slate-800 hover:bg-amber-50/80'
                    }`}
                  >
                    ＋蛋
                  </button>
                </div>
                <label className="block text-xs font-medium text-slate-800">
                  飲料備註
                  <input
                    type="text"
                    value={selectedPerson.drinkRemark ?? ''}
                    onChange={(e) =>
                      patchPersonnel(selectedPersonId, {
                        drinkRemark: e.target.value,
                      })
                    }
                    onBlur={() => schedulePersist(selectedPersonId)}
                    placeholder="例如：半糖少冰"
                    autoComplete="off"
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none ring-amber-400/30 focus:ring-2"
                  />
                </label>
                <label className="block text-xs font-medium text-slate-700">
                  其他備註 (僅限內部查看)
                  <input
                    type="text"
                    value={selectedPerson.extraRemark ?? ''}
                    onChange={(e) =>
                      patchPersonnel(selectedPersonId, {
                        extraRemark:
                          e.target.value === '' ? undefined : e.target.value,
                      })
                    }
                    onBlur={() => schedulePersist(selectedPersonId)}
                    placeholder="僅此處可見，不列入列表與彙整"
                    autoComplete="off"
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none ring-amber-400/30 focus:ring-2"
                  />
                </label>
              </div>

              <div className="mt-3 border-t border-slate-100 pt-3">
                <p className="text-xs text-slate-500">
                  今日餐點：
                  <span className="font-medium text-slate-800">
                    {todayMealSummaryLine}
                  </span>
                </p>
              </div>
            </section>

            <section
              className="flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl border border-orange-200/70 bg-white/90 p-4 shadow-sm shadow-orange-900/5 sm:p-5"
              aria-label="Breakfast Wheel 隨機抽籤"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                  <h2 className="text-lg font-semibold text-orange-950">
                    隨機抽籤轉盤
                  </h2>
                  <p className="mt-1 text-xs text-orange-900/55">
                    Breakfast Wheel · 候選由預算與忌口過濾；飲料類不參與抽選；大量品項時以文字跳動抽選。
                  </p>
                  <div className="mt-3 rounded-2xl border-2 border-dashed border-orange-300/80 bg-gradient-to-b from-orange-50/90 to-amber-50/50 p-4">
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="text-orange-900/75">
                    剩餘預算（無飲品則不扣款）
                  </span>
                  <span className="text-xl font-bold tabular-nums text-orange-950">
                    ${remainingBudget}
                  </span>
                </div>

                <div
                  className={`relative w-full rounded-2xl bg-gradient-to-b from-orange-200/95 via-amber-100/90 to-orange-300/90 p-[5px] shadow-[0_20px_56px_-14px_rgba(194,65,12,0.42)] ring-2 ring-amber-950/15 transition-[transform,box-shadow] duration-300 ${
                    celebratePick
                      ? 'scale-[1.02] shadow-[0_22px_60px_-10px_rgba(16,185,129,0.42)] ring-emerald-400/50'
                      : ''
                  }`}
                >
                  <div
                    className={`relative overflow-hidden rounded-[13px] border-2 border-orange-500/50 bg-gradient-to-b from-white via-orange-50/40 to-amber-50/80 px-4 py-6 text-center shadow-[inset_0_2px_24px_rgba(251,146,60,0.12)] ${
                      spinPhase === 'spinning'
                        ? 'shadow-[inset_0_0_0_1px_rgba(251,146,60,0.25)]'
                        : ''
                    }`}
                  >
                    <div
                      className="pointer-events-none absolute inset-x-0 top-0 z-10 h-7 bg-gradient-to-b from-orange-100/90 to-transparent"
                      aria-hidden
                    />
                    <div
                      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-7 bg-gradient-to-t from-amber-100/90 to-transparent"
                      aria-hidden
                    />
                    <p className="relative z-20 text-[10px] font-semibold uppercase tracking-[0.22em] text-orange-800/80">
                      {spinPhase === 'spinning' ? '老虎機滾動' : '開獎結果'}
                    </p>
                    <div className="relative z-20 mt-3 min-h-[5rem] content-center">
                      {wheelCandidates.length === 0 ? (
                        <p className="text-lg font-semibold leading-snug text-amber-900/95">
                          {wheelEmptyCenterText}
                        </p>
                      ) : lotteryBoxItem ? (
                        <>
                          <p
                            className={`will-change-transform text-xl font-extrabold leading-snug text-orange-950 transition-all duration-300 sm:text-2xl ${
                              spinPhase === 'spinning'
                                ? 'blur-[0.45px] motion-safe:animate-pulse'
                                : ''
                            } ${
                              celebratePick
                                ? 'scale-110 text-emerald-600 drop-shadow-[0_0_22px_rgba(52,211,153,0.55)] motion-safe:animate-[pulse_0.75s_ease-in-out_2]'
                                : ''
                            }`}
                          >
                            {formatFoodLabelForPerson(
                              lotteryBoxItem,
                              selectedPerson,
                            )}
                          </p>
                          <p className="mt-2 text-sm tabular-nums text-orange-800/80">
                            ${lotteryBoxItem.price}
                          </p>
                        </>
                      ) : (
                        <p className="text-lg font-medium text-orange-900/50">
                          準備就緒…
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <p className="mt-4 text-center text-sm text-orange-900/80">
                  候選共{' '}
                  <span className="font-bold tabular-nums text-orange-950">
                    {wheelCandidates.length}
                  </span>{' '}
                  項（符合預算與忌口）
                </p>

                <button
                  type="button"
                  onClick={() => void startWheel()}
                  disabled={
                    spinPhase === 'spinning' ||
                    wheelCandidates.length === 0 ||
                    !foodLineIsEmpty(currentOrder?.selectedFoodId) ||
                    isPersisting
                  }
                  className="mt-4 w-full rounded-2xl bg-gradient-to-r from-orange-500 to-amber-500 py-3.5 text-base font-bold text-white shadow-lg shadow-orange-500/25 hover:from-orange-600 hover:to-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {spinPhase === 'spinning' ? '抽取中…' : '開始抽餐'}
                </button>
              </div>

              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-sm text-slate-600">
                {lastSpinFoodId && spinPhase === 'idle' ? (
                  <>
                    已寫入今日訂單：
                    <span className="font-semibold text-slate-900">
                      {(() => {
                        const f = menuFromMap(menuMap, lastSpinFoodId)
                        return f
                          ? formatFoodLabelForPerson(f, selectedPerson)
                          : '—'
                      })()}
                    </span>
                  </>
                ) : spinPhase === 'spinning' ? (
                  '文字高速切換中，即將開獎…'
                ) : selectedPerson.isAbsent ? (
                  '休假中無法選餐，請雙擊姓名卡片恢復出勤。'
                ) : !foodLineIsEmpty(currentOrder?.selectedFoodId) ? (
                  '已有餐點；若要重新抽籤請先清空「今日餐點」欄位並離開以儲存。'
                ) : wheelCandidates.length === 0 ? (
                  '預算不足或無符合餐點，請調整預算、飲料或忌口後再試。'
                ) : (
                  '點擊「開始抽餐」以隨機選餐並寫入今日訂單。'
                )}
              </div>
              </div>
            </section>
              </>
            ) : (
              <>
                <div className="flex min-h-[min(28rem,55vh)] flex-1 flex-col gap-4">
                  <div className="rounded-2xl border border-dashed border-amber-300/80 bg-gradient-to-br from-amber-50/90 to-orange-50/50 px-5 py-8 shadow-inner">
                    <p className="text-base font-semibold text-amber-950">
                      尚未選取同事
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-amber-900/75">
                      請在左側「同事列表」點擊姓名；若尚無資料，請先於左欄最下方輸入姓名並按「新增同事」。
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-200/80 bg-white/80 px-5 py-6 shadow-sm">
                    <p className="text-sm font-medium text-slate-800">
                      選取後可在此編輯
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600">
                      此欄為點餐板（固定飲料、忌口、今日餐點與備註）與隨機轉盤。飲料品項不會納入轉盤候選。
                    </p>
                  </div>
                </div>
              </>
            )}
          </main>
        </div>
      </div>
    </div>

    {selectedPerson ? (
      <DislikeSettingsModal
        isOpen={dislikeModalOpen}
        onClose={() => setDislikeModalOpen(false)}
        personName={selectedPerson.name}
        categories={categories}
        menu={menu}
        dislikedIds={selectedPerson.dislikedFoodIds}
        onToggleItem={toggleDislikedFood}
        onToggleCategoryAll={toggleCategoryAllDisliked}
      />
    ) : null}

    </>
  )
}
