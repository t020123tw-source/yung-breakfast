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
  filterItemsForWheel,
  getFixedDrinkSelectOptions,
  isDrinkItem,
  isMealItem,
  isToastItem,
} from '../data/menuData'
import type { Order, Personnel } from '../domain/breakfastTypes'
import {
  buildNewColleagueInsertPayload,
  colleagueRowFromPersonnelAndOrder,
  deleteColleagueById,
  insertColleagueRow,
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

/**
 * 單人總金額：以 menu_items 比對飲料與餐點。
 * - 固定飲料：優先以 id 對應；若無則以字串與品項 name 完全相符者計價。
 * - 餐點：手動輸入以 name 比對；非手動以 id 比對。
 * - 比對不到者該項以 0 計；hasUnpriced 表示有欄位未在菜單中找到。
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

  let foodPrice = 0
  let foodOk = true
  const rawFood = (o.selectedFoodId ?? '').trim()
  if (rawFood) {
    if (o.isManual) {
      const byName = menu.find((m) => m.name === rawFood)
      if (byName) {
        foodPrice = byName.price
      } else {
        foodPrice = 0
        foodOk = false
      }
    } else {
      const byId = menu.find((m) => m.id === rawFood)
      if (byId) {
        foodPrice = byId.price
      } else {
        foodPrice = 0
        foodOk = false
      }
    }
  }

  const hasUnpriced = (!drinkOk && fd !== '') || (!foodOk && rawFood !== '')
  let total = drinkPrice + foodPrice
  const note = o.foodRemark ?? ''
  if (note.includes(EGG_REMARK_TOKEN)) {
    total += EGG_EXTRA_PRICE
  }
  return { total, hasUnpriced }
}

/** 依人員設定：僅在勾選「吐司類一律不烤」且品項為吐司時加 (不烤) */
function formatFoodLabelForPerson(
  food: MenuItem,
  person: Personnel | undefined,
): string {
  let s = food.name
  if (person?.requiresUntoastedToast && isToastItem(food)) {
    s += '(不烤)'
  }
  return s
}

/** 休假狀態：飲料／餐點格內之小紅圓＋白叉（置中） */
function AbsentSlotIcon() {
  return (
    <span
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-red-600 text-white shadow-sm ring-1 ring-red-700/30"
      role="img"
      aria-label="休假"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-3.5"
        aria-hidden
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
      >
        <path d="M7 7l10 10M17 7L7 17" />
      </svg>
    </span>
  )
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

function buildFoodLineForShop(
  menuMap: Map<string, MenuItem>,
  o: Order,
  person: Personnel | undefined,
): string | null {
  const raw = (o.selectedFoodId ?? '').trim()
  if (!raw) return null
  if (o.isManual) {
    let label = raw
    const fr = (o.foodRemark ?? '').trim()
    if (fr) label += `（${fr}）`
    return label
  }
  const food = menuFromMap(menuMap, o.selectedFoodId)
  if (!food || !isMealItem(food)) return null
  let label = formatFoodLabelForPerson(food, person)
  const fr = (o.foodRemark ?? '').trim()
  if (fr) label += `（${fr}）`
  return label
}

/** 產生單行純文字總結（不含表格） */
function buildShopSummaryLine(
  menuMap: Map<string, MenuItem>,
  orders: Order[],
  personnel: Personnel[],
): string {
  const map = new Map<string, number>()

  for (const o of orders) {
    const person = personnel.find((p) => p.id === o.userId)
    if (person?.isAbsent) continue
    if (o.selectedDrinkId) {
      const drink = menuFromMap(menuMap, o.selectedDrinkId)
      if (drink && isDrinkItem(drink)) {
        map.set(drink.name, (map.get(drink.name) ?? 0) + 1)
      }
    }
    if (o.selectedFoodId) {
      const line = buildFoodLineForShop(menuMap, o, person)
      if (line) {
        map.set(line, (map.get(line) ?? 0) + 1)
      }
    }
  }

  const entries = [...map.entries()].sort(([a], [b]) =>
    a.localeCompare(b, 'zh-Hant'),
  )
  const parts = entries.map(([label, count]) => `${label} x ${count}`)
  return parts.length > 0 ? `總結：${parts.join('、')}` : '總結：（尚無品項）'
}

export function BreakfastOrderingApp({
  menu,
  categories,
  initialPersonnel,
  initialOrders,
  selectPersonIdOnMount,
  onColleaguesSynced,
}: BreakfastOrderingAppProps) {
  const [budgetInput, setBudgetInput] = useState('120')
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
  const [persistTick, setPersistTick] = useState(0)

  const schedulePersist = useCallback((userId: string) => {
    persistIdsRef.current.add(userId)
    setPersistTick((n) => n + 1)
  }, [])

  const persistDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const schedulePersistDebounced = useCallback(
    (userId: string, ms = 420) => {
      if (persistDebounceTimerRef.current) {
        clearTimeout(persistDebounceTimerRef.current)
      }
      persistDebounceTimerRef.current = setTimeout(() => {
        persistDebounceTimerRef.current = null
        schedulePersist(userId)
      }, ms)
    },
    [schedulePersist],
  )

  useEffect(() => {
    return () => {
      if (persistDebounceTimerRef.current) {
        clearTimeout(persistDebounceTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const ids = [...persistIdsRef.current]
    persistIdsRef.current.clear()
    if (ids.length === 0) return
    void (async () => {
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
      }
    })()
  }, [personnel, orders, persistTick])

  /** 指定餐點手動輸入草稿（與轉盤選中的 id 分離；僅在 isManual 時與 DB 同步顯示） */
  const [manualFoodDraft, setManualFoodDraft] = useState('')
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
        /** 手動輸入之餐點為任意文字，不可依菜單 id 清掉 */
        const sf = o.isManual
          ? o.selectedFoodId
          : o.selectedFoodId && ids.has(o.selectedFoodId)
            ? o.selectedFoodId
            : null
        if (sf === o.selectedFoodId && sd === o.selectedDrinkId) return o
        any = true
        touched.add(o.userId)
        return { ...o, selectedFoodId: sf, selectedDrinkId: sd }
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
    const o = orders.find((x) => x.userId === selectedPersonId)
    setManualFoodDraft(o?.isManual ? (o.selectedFoodId ?? '') : '')
    setFoodRemarkDraft(o?.foodRemark ?? '')
  }, [selectedPersonId, orders])

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
        Object.prototype.hasOwnProperty.call(patch, 'extraRemark')
      if (debounced) schedulePersistDebounced(id)
      else schedulePersist(id)
    },
    [schedulePersist, schedulePersistDebounced],
  )

  /** 餐點備註（對外）：同步至訂單，供左側列表與店家彙整使用 */
  const onFoodRemarkInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value
      setFoodRemarkDraft(v)
      if (!selectedPersonId) return
      setOrders((prev) =>
        prev.map((o) =>
          o.userId === selectedPersonId
            ? { ...o, foodRemark: v === '' ? undefined : v }
            : o,
        ),
      )
      schedulePersistDebounced(selectedPersonId)
    },
    [selectedPersonId, schedulePersistDebounced],
  )

  /** 切換備註中的「+蛋」（current_note），並立即寫入以更新金額卡 */
  const toggleEggRemark = useCallback(() => {
    if (!selectedPersonId) return
    const person = personnel.find((x) => x.id === selectedPersonId)
    if (person?.isAbsent) return
    const o = orders.find((x) => x.userId === selectedPersonId)
    if (!o) return
    const cur = o.foodRemark ?? ''
    const next = cur.includes(EGG_REMARK_TOKEN)
      ? cur.split(EGG_REMARK_TOKEN).join('').replace(/\s+/g, ' ').trim()
      : cur
        ? `${cur}${EGG_REMARK_TOKEN}`
        : EGG_REMARK_TOKEN
    setFoodRemarkDraft(next)
    setOrders((prev) =>
      prev.map((row) =>
        row.userId === selectedPersonId
          ? { ...row, foodRemark: next === '' ? undefined : next }
          : row,
      ),
    )
    schedulePersist(selectedPersonId)
    setEggAmountFlashUserId(selectedPersonId)
    if (eggFlashTimerRef.current) clearTimeout(eggFlashTimerRef.current)
    eggFlashTimerRef.current = setTimeout(() => {
      setEggAmountFlashUserId(null)
      eggFlashTimerRef.current = null
    }, 520)
  }, [selectedPersonId, personnel, orders, schedulePersist])

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
    setOrders((prev) => prev.filter((o) => o.userId !== id))
  }, [personnel.length, selectedPersonId])

  const clearPersonMeal = useCallback(
    (userId: string) => {
      setOrders((prev) =>
        prev.map((o) =>
          o.userId === userId
            ? {
                ...o,
                selectedFoodId: null,
                foodRemark: undefined,
                isManual: false,
              }
            : o,
        ),
      )
      schedulePersist(userId)
    },
    [schedulePersist],
  )

  /**
   * 手動餐點：寫入 current_food 任意文字，is_manual = true；清空時 is_manual = false。
   * 轉盤結果（is_manual false）不受空白草稿影響。
   */
  const commitManualMealInput = useCallback(() => {
    if (!selectedPersonId) return
    const p = personnel.find((x) => x.id === selectedPersonId)
    if (p?.isAbsent) return
    const o = orders.find((x) => x.userId === selectedPersonId)
    if (!o) return
    const draft = manualFoodDraft.trim()
    if (draft === '') {
      if (o.isManual) {
        setOrders((prev) =>
          prev.map((row) =>
            row.userId === selectedPersonId
              ? {
                  ...row,
                  selectedFoodId: null,
                  isManual: false,
                  foodRemark: undefined,
                }
              : row,
          ),
        )
        setFoodRemarkDraft('')
        schedulePersist(selectedPersonId)
      }
      return
    }
    setOrders((prev) =>
      prev.map((row) =>
        row.userId === selectedPersonId
          ? {
              ...row,
              selectedFoodId: draft,
              isManual: true,
            }
          : row,
      ),
    )
    schedulePersist(selectedPersonId)
  }, [selectedPersonId, manualFoodDraft, personnel, orders, schedulePersist])

  /**
   * 清空所有人非指定套用的餐點，並將全員恢復為出勤（取消休假）。
   */
  const clearAllWheelFoodsGlobally = useCallback(() => {
    const nextP = personnel.map((p) => ({ ...p, isAbsent: false }))
    const nextO = orders.map((o) =>
      o.isManual ? o : { ...o, selectedFoodId: null, foodRemark: undefined },
    )
    setPersonnel(nextP)
    setOrders(nextO)
    void upsertColleagueRows(
      nextO.map((o) => {
        const p = nextP.find((x) => x.id === o.userId)!
        return colleagueRowFromPersonnelAndOrder(p, o)
      }),
    )
  }, [personnel, orders])

  /**
   * 一鍵全員轉盤：略過休假與手動指定；其餘依與單人轉盤相同規則隨機配餐。
   * (不烤) 由顯示層依品項類別與勾選自動加註，不寫入 id 以外欄位。
   */
  const batchSpinAll = useCallback(() => {
    spinSessionIdRef.current += 1
    if (spinRafRef.current != null) {
      cancelAnimationFrame(spinRafRef.current)
      spinRafRef.current = null
    }
    setSpinPhase('idle')
    setShufflePreviewId(null)
    setLastSpinFoodId(null)
    setCelebratePick(false)

    const nextO = orders.map((o) => {
      const p = personnel.find((x) => x.id === o.userId)
      if (!p || p.isAbsent) return o
      if (o.isManual) return o

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
          selectedFoodId: null,
          foodRemark: undefined,
          isManual: false,
        }
      }

      const pick = pool[Math.floor(Math.random() * pool.length)]
      return {
        ...o,
        selectedFoodId: pick.id,
        isManual: false,
        foodRemark: undefined,
      }
    })
    setOrders(nextO)
    void upsertColleagueRows(
      nextO.map((o) => {
        const p = personnel.find((x) => x.id === o.userId)
        return p ? colleagueRowFromPersonnelAndOrder(p, o) : null
      }).filter((r) => r != null),
    )
  }, [personnel, menu, menuMap, globalBudget, orders])

  const startWheel = useCallback(() => {
    if (!selectedPersonId || wheelCandidates.length === 0) return
    const co = orders.find((o) => o.userId === selectedPersonId)
    if (co?.isManual) return
    const p = personnel.find((x) => x.id === selectedPersonId)
    if (p?.isAbsent) return

    const pool = wheelCandidates
    const n = pool.length
    const pickIdx = Math.floor(Math.random() * n)
    const pick = pool[pickIdx]

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
      setOrders((prev) =>
        prev.map((o) =>
          o.userId === selectedPersonId
            ? {
                ...o,
                selectedFoodId: pick.id,
                isManual: false,
                foodRemark: undefined,
              }
            : o,
        ),
      )
      schedulePersist(selectedPersonId)
      setLastSpinFoodId(pick.id)
      setSpinPhase('idle')
      setCelebratePick(true)
      window.setTimeout(() => setCelebratePick(false), 1400)
      spinRafRef.current = null
    }

    spinRafRef.current = requestAnimationFrame(run)
  }, [selectedPersonId, wheelCandidates, personnel, schedulePersist, orders])

  const togglePersonAbsentByDoubleClick = useCallback(
    (id: string) => {
      const cur = personnel.find((x) => x.id === id)
      if (!cur) return
      const nextAbsent = !cur.isAbsent
      const nextPersonnel = personnel.map((p) =>
        p.id === id ? { ...p, isAbsent: nextAbsent } : p,
      )
      const nextOrders = orders.map((o) => {
        if (o.userId !== id) return o
        if (nextAbsent) {
          return {
            ...o,
            selectedFoodId: null,
            foodRemark: undefined,
            isManual: false,
          }
        }
        const np = nextPersonnel.find((x) => x.id === id)!
        return { ...o, selectedDrinkId: np.fixedDrinkId ?? null }
      })
      setPersonnel(nextPersonnel)
      setOrders(nextOrders)
      const p = nextPersonnel.find((x) => x.id === id)!
      const o = nextOrders.find((x) => x.userId === id)
      void upsertColleagueRows([colleagueRowFromPersonnelAndOrder(p, o)])
    },
    [personnel, orders],
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
          requiresUntoastedToast: false,
          isAbsent: false,
        }
        const o: Order = {
          userId: id,
          selectedDrinkId: null,
          selectedFoodId: null,
          isManual: false,
          foodRemark: undefined,
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

  const shopSummaryLine = useMemo(
    () => buildShopSummaryLine(menuMap, orders, personnel),
    [menuMap, orders, personnel],
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
      return { name: '—', drinkName: '', mealLine: '' }
    }
    if (p.isAbsent) {
      return { name: p.name, drinkName: '', mealLine: '' }
    }
    const drinkName = o.selectedDrinkId
      ? menuFromMap(menuMap, o.selectedDrinkId)?.name ?? ''
      : ''
    let mealLine = ''
    const fr = (o.foodRemark ?? '').trim()
    if ((o.selectedFoodId ?? '').trim()) {
      if (o.isManual) {
        mealLine = (o.selectedFoodId ?? '').trim()
        if (fr) mealLine += `（${fr}）`
      } else {
        const food = menuFromMap(menuMap, o.selectedFoodId)
        if (food && isMealItem(food)) {
          const base = formatFoodLabelForPerson(food, p)
          let tail = base
          if (fr) tail += `（${fr}）`
          mealLine = tail
        } else {
          mealLine = (o.selectedFoodId ?? '').trim()
        }
      }
    }
    return { name: p.name, drinkName, mealLine }
  }

  const todayMealSummaryLine = useMemo(() => {
    if (!selectedPerson || !currentOrder) return ''
    if (selectedPerson.isAbsent) return '休假中'
    const fr = (currentOrder.foodRemark ?? '').trim()
    const rawFood = (currentOrder.selectedFoodId ?? '').trim()
    if (currentOrder.isManual && rawFood) {
      let s = rawFood
      if (fr) s += `（${fr}）`
      return s
    }
    const food = menuFromMap(menuMap, currentOrder.selectedFoodId)
    if (food && isMealItem(food)) {
      const base = formatFoodLabelForPerson(food, selectedPerson)
      let s = `${base}（$${food.price}）`
      if (fr) s += `（${fr}）`
      return s
    }
    return ''
  }, [selectedPerson, currentOrder, menuMap])

  return (
    <>
    <div className="w-full text-slate-900">
      <div className="flex w-full flex-col px-4 py-5 sm:px-6 lg:px-10 lg:py-7">
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
                      onClick={batchSpinAll}
                      className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-amber-600 px-2.5 text-[11px] font-bold text-white shadow-sm hover:bg-amber-700 sm:px-3 sm:text-xs"
                      title="為所有出勤且非手動指定餐點的同事隨機配餐；休假與手動套用者略過"
                    >
                      🎲 全員轉盤
                    </button>
                    <button
                      type="button"
                      onClick={clearAllWheelFoodsGlobally}
                      className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 px-2.5 text-[11px] font-semibold text-rose-800 hover:bg-rose-100 sm:px-3 sm:text-xs"
                      title="清空非指定套用之餐點，並將全員恢復為出勤"
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
                          onChange={(e) => setBudgetInput(e.target.value)}
                          aria-label="全域預算（每人餐點上限）"
                          className="w-[3.25rem] min-w-0 appearance-none border-0 bg-transparent py-0 text-right text-xs font-semibold tabular-nums outline-none ring-0 focus:ring-0 sm:w-[3.75rem] sm:text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        />
                      </span>
                    </label>
                  </div>
                </div>
              </div>
              <ul className="h-auto flex-1 px-1 py-2 sm:px-3">
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
                        className={`grid grid-cols-12 gap-1.5 py-2.5 pl-1 pr-1 transition sm:gap-2 sm:pl-2 sm:pr-2 ${
                          active
                            ? 'bg-amber-100/90 ring-1 ring-inset ring-amber-300/80'
                            : 'hover:bg-amber-50/80'
                        }`}
                      >
                        <div className="col-span-2 flex min-h-[3.25rem] min-w-0 gap-1 sm:gap-1.5">
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
                            className="flex w-7 shrink-0 cursor-grab touch-none flex-col items-center justify-center rounded-lg border border-transparent bg-transparent text-slate-400 hover:bg-slate-200/50 hover:text-slate-600 active:cursor-grabbing"
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
                            className="flex min-h-[3.25rem] min-w-0 max-w-[6.5rem] flex-1 cursor-pointer flex-col items-center justify-center rounded-xl border border-slate-200/90 bg-slate-100 px-1.5 py-2 text-center text-base font-semibold leading-snug text-slate-900 shadow-sm hover:bg-slate-200/70 sm:max-w-[7.25rem] sm:text-lg"
                          >
                            <span className="line-clamp-3 w-full break-words text-center">
                              {p.name}
                            </span>
                          </button>
                        </div>

                        <div className="col-span-3 flex min-h-[3.25rem] min-w-0 items-stretch rounded-xl border border-slate-200/90 bg-slate-100 px-2 py-1.5 shadow-sm">
                          {p.isAbsent ? (
                            <div className="flex min-w-0 flex-1 items-center justify-center text-center">
                              <AbsentSlotIcon />
                            </div>
                          ) : (
                            <button
                              type="button"
                              title={row.drinkName || undefined}
                              onClick={() => scheduleSelectPerson(p.id)}
                              className="flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-lg py-1 text-center text-lg font-medium leading-snug text-slate-900 hover:bg-slate-200/60 sm:text-xl"
                            >
                              <span className="block min-w-0 max-w-full break-words text-center">
                                {row.drinkName}
                              </span>
                            </button>
                          )}
                        </div>

                        <div className="col-span-4 flex min-h-[3.25rem] min-w-0 items-stretch gap-1">
                          {p.isAbsent ? (
                            <div className="flex min-h-[3.25rem] min-w-0 flex-1 items-center justify-center rounded-xl border border-slate-200/90 bg-slate-100 px-2 py-2 text-center shadow-sm">
                              <AbsentSlotIcon />
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => scheduleSelectPerson(p.id)}
                              className="flex min-h-[3.25rem] min-w-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-slate-200/90 bg-slate-100 px-2 py-2 text-center text-lg font-medium leading-snug text-slate-900 shadow-sm hover:bg-slate-200/70 sm:text-xl"
                            >
                              <span className="block min-w-0 max-w-full break-words text-center">
                                {row.mealLine}
                              </span>
                            </button>
                          )}
                          {!p.isAbsent && row.mealLine ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                clearPersonMeal(p.id)
                              }}
                              className="flex h-8 w-8 shrink-0 items-center justify-center self-center rounded-md border border-slate-300/80 bg-white text-sm font-bold text-slate-500 hover:bg-rose-50 hover:text-rose-700"
                              title="清除餐點"
                              aria-label="清除餐點"
                            >
                              ×
                            </button>
                          ) : null}
                        </div>

                        <div
                          className={`col-span-3 flex min-h-[3.25rem] min-w-0 max-w-[5.5rem] items-stretch justify-center self-stretch rounded-xl border border-slate-200/90 bg-slate-100 px-1.5 py-2 text-center shadow-sm sm:max-w-[6rem] transition-[transform,box-shadow] duration-300 ease-out will-change-transform ${
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
                          {p.isAbsent ? (
                            <div className="flex flex-1 items-center justify-center">
                              <AbsentSlotIcon />
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => scheduleSelectPerson(p.id)}
                              className="flex w-full min-w-0 flex-col items-center justify-center gap-0.5 text-slate-900"
                            >
                              <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                金額
                              </span>
                              <span
                                className={`text-lg font-bold tabular-nums leading-none sm:text-xl ${
                                  hasUnpriced ? 'text-amber-800' : 'text-slate-900'
                                }`}
                              >
                                $ {lineTotal}
                              </span>
                              {hasUnpriced ? (
                                <span className="max-w-full truncate text-[9px] leading-tight text-amber-700/90">
                                  部分未入價
                                </span>
                              ) : null}
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>

              <div className="border-t border-amber-200/80 bg-amber-50/30 px-4 py-4 sm:px-5">
                <h3 className="text-sm font-semibold text-amber-950">
                  店家點餐彙整（餐點統計明細）
                </h3>
                <p className="mt-3 select-all text-lg leading-relaxed text-black">
                  {shopSummaryLine}
                </p>
                <p className="mt-3 text-xs text-amber-900/55">
                  純文字一行，可直接複製；若同事有勾選「吐司類一律不烤」且點吐司，總結中會出現
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
                <p className="mb-2 text-xs font-medium text-slate-700">
                  指定餐點（手動輸入）
                </p>
                <label className="block text-sm font-medium text-slate-800">
                  <span className="sr-only">指定餐點</span>
                  <input
                    type="text"
                    value={manualFoodDraft}
                    onChange={(e) => setManualFoodDraft(e.target.value)}
                    onBlur={() => commitManualMealInput()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        ;(e.target as HTMLInputElement).blur()
                      }
                    }}
                    disabled={!!selectedPerson.isAbsent}
                    placeholder="輸入任意餐點名稱，離開欄位時自動儲存"
                    autoComplete="off"
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-900 outline-none ring-amber-400/30 placeholder:text-slate-400 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </label>
                <p className="mt-1.5 text-[10px] text-slate-500">
                  儲存後寫入資料庫並標為手動指定；清空並離開欄位可改回參與轉盤。「一鍵淨空」仍保留手動餐點；休假中無法編輯。
                </p>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-amber-100/80 pt-3">
                <label
                  className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-800"
                  title="點選吐司類餐點時，名稱後自動加上 (不烤)"
                >
                  <input
                    type="checkbox"
                    checked={selectedPerson.requiresUntoastedToast ?? false}
                    onChange={(e) =>
                      patchPersonnel(selectedPersonId, {
                        requiresUntoastedToast: e.target.checked,
                      })
                    }
                    className="rounded border-slate-300"
                  />
                  吐司類一律不烤
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
                    餐點備註 (顯示於列表)
                    <input
                      type="text"
                      value={foodRemarkDraft}
                      onChange={onFoodRemarkInputChange}
                      placeholder="例如：不加美乃滋"
                      autoComplete="off"
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none ring-amber-400/30 focus:ring-2"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!!selectedPerson.isAbsent}
                    aria-pressed={foodRemarkDraft.includes(EGG_REMARK_TOKEN)}
                    onClick={() => toggleEggRemark()}
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
                  onClick={startWheel}
                  disabled={
                    spinPhase === 'spinning' ||
                    wheelCandidates.length === 0 ||
                    !!currentOrder?.isManual
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
                ) : currentOrder?.isManual ? (
                  '已手動指定餐點；若要使用轉盤請先清空「指定餐點」欄位並離開以儲存。'
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
