import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  type MenuCategoryDef,
  type MenuItem,
  buildCategoryMap,
  filterItemsForWheel,
  getFixedDrinkSelectOptions,
  isDrinkItem,
  isMealItem,
  isToastItem,
} from '../data/menuData'
import { DislikeSettingsModal } from './DislikeSettingsModal'

export type { MenuItem, MenuCategoryDef } from '../data/menuData'

export type BreakfastOrderingAppProps = {
  menu: MenuItem[]
  setMenu: Dispatch<SetStateAction<MenuItem[]>>
  categories: MenuCategoryDef[]
  setCategories: Dispatch<SetStateAction<MenuCategoryDef[]>>
}

/** 同事（不含個人預算；固定飲料可為 null＝無飲料） */
export type Personnel = {
  id: string
  name: string
  fixedDrinkId: string | null
  dislikedFoodIds: string[]
  /** 其他備註（僅內部查看；不顯示於同事列表與店家彙整） */
  extraRemark?: string
  /** 勾選後，該員點吐司類餐點時自動加 (不烤) */
  requiresUntoastedToast?: boolean
  /** 休假：飲料／餐點格顯示紅底白叉圖示，不列入店家彙整 */
  isAbsent?: boolean
}

/** 今日訂單（每人一筆） */
export type Order = {
  userId: string
  selectedDrinkId: string | null
  selectedFoodId: string | null
  isManual: boolean
  /** 餐點備註（對外：顯示於同事列表與店家彙整） */
  foodRemark?: string
}

const MOCK_PERSONNEL: Personnel[] = [
  {
    id: 'p1',
    name: '小安',
    fixedDrinkId: 'drink-americano',
    dislikedFoodIds: ['food-hash-tower'],
    extraRemark: '蛋要全熟',
    requiresUntoastedToast: true,
  },
  {
    id: 'p2',
    name: '阿哲',
    fixedDrinkId: 'drink-soy-milk-ice',
    dislikedFoodIds: ['food-pepper-noodle-egg', 'food-plain-omelet'],
    requiresUntoastedToast: true,
  },
  { id: 'p3', name: '怡君', fixedDrinkId: 'drink-iced-milk-tea-lg', dislikedFoodIds: [] },
  {
    id: 'p4',
    name: '冠宇',
    fixedDrinkId: null,
    dislikedFoodIds: ['food-plain-omelet'],
    isAbsent: true,
  },
  {
    id: 'p5',
    name: '書緯',
    fixedDrinkId: 'drink-fresh-milk-tea-lg-ns',
    dislikedFoodIds: ['food-crispy-chicken-burger'],
  },
  {
    id: 'p6',
    name: '品妍',
    fixedDrinkId: 'drink-fresh-milk-tea-lg-ns',
    dislikedFoodIds: ['food-hash-tower', 'food-turnip-cake'],
  },
  { id: 'p7', name: '志豪', fixedDrinkId: null, dislikedFoodIds: [] },
  {
    id: 'p8',
    name: '婉婷',
    fixedDrinkId: 'drink-soy-milk-ice',
    dislikedFoodIds: ['food-pepper-noodle-egg'],
  },
  { id: 'p9', name: '承恩', fixedDrinkId: null, dislikedFoodIds: ['food-plain-omelet'] },
  {
    id: 'p10',
    name: '詩涵',
    fixedDrinkId: 'drink-iced-milk-tea-lg',
    dislikedFoodIds: ['food-plain-omelet', 'food-hash-tower'],
  },
  { id: 'p11', name: '子晴', fixedDrinkId: 'drink-iced-milk-tea-lg', dislikedFoodIds: [] },
]

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

/** 依人員設定：僅在勾選「吐司類一律不烤」且品項為吐司時加 (不烤) */
function formatFoodLabelForPerson(
  food: MenuItem,
  person: Personnel | undefined,
  cm: Map<string, MenuCategoryDef>,
): string {
  let s = food.name
  if (person?.requiresUntoastedToast && isToastItem(food, cm)) {
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

function initialOrders(people: Personnel[]): Order[] {
  return people.map((p) => ({
    userId: p.id,
    selectedDrinkId: p.fixedDrinkId,
    selectedFoodId: null,
    isManual: false,
    foodRemark: undefined,
  }))
}

function buildFoodLineForShop(
  menuMap: Map<string, MenuItem>,
  cm: Map<string, MenuCategoryDef>,
  o: Order,
  person: Personnel | undefined,
): string | null {
  if (!o.selectedFoodId) return null
  const food = menuFromMap(menuMap, o.selectedFoodId)
  if (!food || !isMealItem(food, cm)) return null
  let label = formatFoodLabelForPerson(food, person, cm)
  const fr = (o.foodRemark ?? '').trim()
  if (fr) label += `（${fr}）`
  return label
}

/** 產生單行純文字總結（不含表格） */
function buildShopSummaryLine(
  menuMap: Map<string, MenuItem>,
  cm: Map<string, MenuCategoryDef>,
  orders: Order[],
  personnel: Personnel[],
): string {
  const map = new Map<string, number>()

  for (const o of orders) {
    const person = personnel.find((p) => p.id === o.userId)
    if (person?.isAbsent) continue
    if (o.selectedDrinkId) {
      const drink = menuFromMap(menuMap, o.selectedDrinkId)
      if (drink && isDrinkItem(drink, cm)) {
        map.set(drink.name, (map.get(drink.name) ?? 0) + 1)
      }
    }
    if (o.selectedFoodId) {
      const line = buildFoodLineForShop(menuMap, cm, o, person)
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
}: BreakfastOrderingAppProps) {
  const [budgetInput, setBudgetInput] = useState('120')
  const globalBudget = useMemo(() => {
    const n = parseInt(budgetInput.replace(/\D/g, ''), 10)
    return Number.isFinite(n) ? Math.min(999999, Math.max(0, n)) : 0
  }, [budgetInput])
  const [personnel, setPersonnel] = useState<Personnel[]>(MOCK_PERSONNEL)
  const [orders, setOrders] = useState<Order[]>(() => initialOrders(MOCK_PERSONNEL))
  const [selectedPersonId, setSelectedPersonId] = useState<string>(
    MOCK_PERSONNEL[0]?.id ?? '',
  )

  const [manualFoodId, setManualFoodId] = useState('')
  const [foodRemarkDraft, setFoodRemarkDraft] = useState('')

  const [spinPhase, setSpinPhase] = useState<'idle' | 'spinning'>('idle')
  /** 老虎機跳動：目前顯示的候選品項 id */
  const [shufflePreviewId, setShufflePreviewId] = useState<string | null>(null)
  const [lastSpinFoodId, setLastSpinFoodId] = useState<string | null>(null)
  /** 抽中後短暫慶祝動畫 */
  const [celebratePick, setCelebratePick] = useState(false)
  const [dislikeModalOpen, setDislikeModalOpen] = useState(false)

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

  const categoryMap = useMemo(
    () => buildCategoryMap(categories),
    [categories],
  )

  /** 固定飲料：即時自共用 `menu` 篩選 isDrink 類別（與轉盤候選分離） */
  const drinkOptions = useMemo(
    () => getFixedDrinkSelectOptions(menu, categoryMap),
    [menu, categoryMap],
  )
  /** 吐司＋一般餐（指定餐點、忌口、轉盤候選） */
  const foodOptions = useMemo(
    () => menu.filter((m) => isMealItem(m, categoryMap)),
    [menu, categoryMap],
  )

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
    const drinkPrice = drink && isDrinkItem(drink, categoryMap) ? drink.price : 0
    const remaining = globalBudget - drinkPrice
    return filterItemsForWheel(menu, categoryMap, dislikedIdSet, remaining)
  }, [menu, menuMap, categoryMap, selectedPerson, globalBudget, dislikedIdSet])

  const remainingBudget = useMemo(() => {
    if (!selectedPerson) return 0
    const drink = selectedPerson.fixedDrinkId
      ? menuFromMap(menuMap, selectedPerson.fixedDrinkId)
      : undefined
    const drinkPrice = drink && isDrinkItem(drink, categoryMap) ? drink.price : 0
    return Math.max(0, globalBudget - drinkPrice)
  }, [menuMap, categoryMap, selectedPerson, globalBudget])

  /** 菜單或類別變更時：修正無效的飲料／餐點／忌口 id（僅在實際變動時更新 state） */
  useEffect(() => {
    const ids = new Set(menu.map((x) => x.id))
    setPersonnel((prev) => {
      let any = false
      const next = prev.map((p) => {
        let fd = p.fixedDrinkId
        if (fd) {
          const it = menuFromMap(menuMap, fd)
          if (!it || !isDrinkItem(it, categoryMap)) fd = null
        }
        const dis = p.dislikedFoodIds.filter((id) => ids.has(id))
        const fdChanged = fd !== p.fixedDrinkId
        const disChanged =
          dis.length !== p.dislikedFoodIds.length ||
          dis.some((id, i) => id !== p.dislikedFoodIds[i])
        if (!fdChanged && !disChanged) return p
        any = true
        return { ...p, fixedDrinkId: fd, dislikedFoodIds: dis }
      })
      return any ? next : prev
    })
    setOrders((prev) => {
      let any = false
      const next = prev.map((o) => {
        const sf =
          o.selectedFoodId && ids.has(o.selectedFoodId)
            ? o.selectedFoodId
            : null
        const sd =
          o.selectedDrinkId && ids.has(o.selectedDrinkId)
            ? o.selectedDrinkId
            : null
        if (sf === o.selectedFoodId && sd === o.selectedDrinkId) return o
        any = true
        return { ...o, selectedFoodId: sf, selectedDrinkId: sd }
      })
      return any ? next : prev
    })
  }, [menu, categories, categoryMap, menuMap])

  useEffect(() => {
    const o = orders.find((x) => x.userId === selectedPersonId)
    setManualFoodId(o?.selectedFoodId ?? '')
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

  const patchPersonnel = useCallback((id: string, patch: Partial<Personnel>) => {
    setPersonnel((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    )
  }, [])

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
    },
    [selectedPersonId],
  )

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
    },
    [selectedPersonId],
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
    },
    [selectedPersonId, menu],
  )

  /** 刪除目前選中的同事（標題列「－」；至少保留一人） */
  const deleteSelectedColleague = useCallback(() => {
    if (personnel.length <= 1 || !selectedPersonId) return
    if (!window.confirm('確定從名單移除此同事？')) return
    const id = selectedPersonId
    setPersonnel((prev) => {
      const next = prev.filter((p) => p.id !== id)
      setSelectedPersonId(next[0]?.id ?? '')
      return next
    })
    setOrders((prev) => prev.filter((o) => o.userId !== id))
  }, [personnel.length, selectedPersonId])

  const clearPersonMeal = useCallback((userId: string) => {
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
  }, [])

  const applyManualFood = useCallback(() => {
    if (!selectedPersonId || !manualFoodId) return
    const p = personnel.find((x) => x.id === selectedPersonId)
    if (p?.isAbsent) return
    setOrders((prev) =>
      prev.map((o) =>
        o.userId === selectedPersonId
          ? {
              ...o,
              selectedFoodId: manualFoodId,
              isManual: true,
              foodRemark: foodRemarkDraft.trim() || undefined,
            }
          : o,
      ),
    )
  }, [selectedPersonId, manualFoodId, foodRemarkDraft, personnel])

  /**
   * 清空所有人非指定套用的餐點，並將全員恢復為出勤（取消休假）。
   */
  const clearAllWheelFoodsGlobally = useCallback(() => {
    setOrders((prev) =>
      prev.map((o) =>
        o.isManual ? o : { ...o, selectedFoodId: null, foodRemark: undefined },
      ),
    )
    setPersonnel((prev) => prev.map((p) => ({ ...p, isAbsent: false })))
  }, [])

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

    setOrders((prev) =>
      prev.map((o) => {
        const p = personnel.find((x) => x.id === o.userId)
        if (!p || p.isAbsent) return o
        if (o.isManual) return o

        const drink = p.fixedDrinkId
          ? menuFromMap(menuMap, p.fixedDrinkId)
          : undefined
        const drinkPrice =
          drink && isDrinkItem(drink, categoryMap) ? drink.price : 0
        const remaining = globalBudget - drinkPrice
        const pool = filterItemsForWheel(
          menu,
          categoryMap,
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
      }),
    )
  }, [personnel, menu, categoryMap, menuMap, globalBudget])

  const startWheel = useCallback(() => {
    if (!selectedPersonId || wheelCandidates.length === 0) return
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
      setLastSpinFoodId(pick.id)
      setSpinPhase('idle')
      setCelebratePick(true)
      window.setTimeout(() => setCelebratePick(false), 1400)
      spinRafRef.current = null
    }

    spinRafRef.current = requestAnimationFrame(run)
  }, [selectedPersonId, wheelCandidates, personnel])

  const togglePersonAbsentByDoubleClick = useCallback((id: string) => {
    setPersonnel((prev) => {
      const cur = prev.find((x) => x.id === id)
      if (!cur) return prev
      const turningAbsent = !cur.isAbsent
      if (turningAbsent) {
        queueMicrotask(() => {
          setOrders((oPrev) =>
            oPrev.map((o) =>
              o.userId === id
                ? {
                    ...o,
                    selectedFoodId: null,
                    foodRemark: undefined,
                    isManual: false,
                  }
                : o,
            ),
          )
        })
      }
      return prev.map((p) =>
        p.id === id ? { ...p, isAbsent: !p.isAbsent } : p,
      )
    })
  }, [])

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

  /** 標題列「＋」：列表內新增一列；姓名於右側「當前點餐編輯」修改 */
  const addColleagueInline = () => {
    const id = `p-${crypto.randomUUID().slice(0, 8)}`
    const p: Personnel = {
      id,
      name: '新同事',
      fixedDrinkId: null,
      dislikedFoodIds: [],
      extraRemark: undefined,
      requiresUntoastedToast: false,
      isAbsent: false,
    }
    setPersonnel((prev) => [...prev, p])
    setOrders((prev) => [
      ...prev,
      {
        userId: id,
        selectedDrinkId: null,
        selectedFoodId: null,
        isManual: false,
        foodRemark: undefined,
      },
    ])
    setSelectedPersonId(id)
  }

  const shopSummaryLine = useMemo(
    () => buildShopSummaryLine(menuMap, categoryMap, orders, personnel),
    [menuMap, categoryMap, orders, personnel],
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
    if (o.selectedFoodId) {
      const food = menuFromMap(menuMap, o.selectedFoodId)
      if (food && isMealItem(food, categoryMap)) {
        const base = formatFoodLabelForPerson(food, p, categoryMap)
        const fr = (o.foodRemark ?? '').trim()
        let tail = base
        if (fr) tail += `（${fr}）`
        mealLine = tail
      }
    }
    return { name: p.name, drinkName, mealLine }
  }

  const selectedFood =
    selectedPerson && currentOrder
      ? menuFromMap(menuMap, currentOrder.selectedFoodId)
      : undefined

  const orderTabEmpty = !selectedPerson || !currentOrder

  return (
    <>
    <div className="w-full text-slate-900">
      <div className="flex w-full flex-col px-4 py-5 sm:px-6 lg:px-10 lg:py-7">
        {orderTabEmpty ? (
          <div className="flex min-h-[50vh] w-full items-center justify-center rounded-2xl border border-amber-200 bg-white/80 p-8">
            <p className="text-amber-900/80">請先新增至少一位同事。</p>
          </div>
        ) : (
          <>
        <header className="mb-5 flex flex-col gap-4 border-b border-amber-200/80 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-3xl text-sm text-amber-900/70">
            全域預算套用全體同事；單擊姓名卡片選人、雙擊切換休假。右側可編輯資料、指定餐點或隨機選餐。「一鍵淨空」會清空非指定套用之餐點並取消全員休假。
          </p>
          <label className="flex shrink-0 items-center gap-2 text-sm font-medium text-amber-950">
            <span className="whitespace-nowrap">全域預算（每人餐點上限）</span>
            <span className="text-amber-800/60">$</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
              className="w-28 appearance-none rounded-lg border border-amber-300 bg-white px-3 py-2 text-base font-semibold tabular-nums shadow-inner outline-none ring-amber-400/30 focus:ring-2 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </label>
        </header>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:items-start lg:gap-6 xl:gap-8">
          {/* 左：同事列表（依人數撐開高度，列表區不使用捲軸） */}
          <aside className="flex flex-col lg:col-span-8 xl:col-span-8">
            <div className="flex h-auto flex-col rounded-2xl border border-amber-200/70 bg-white/90 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-amber-100 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-semibold text-amber-950">
                    同事列表
                  </h2>
                  <p className="mt-1 text-xs text-amber-800/60">
                    共 {personnel.length} 人 · 單擊姓名選取、雙擊切換休假；右側編輯
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={addColleagueInline}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-400/80 bg-amber-50 text-lg font-semibold leading-none text-amber-950 hover:bg-amber-100"
                    title="新增同事（於列表內輸入姓名）"
                    aria-label="新增同事"
                  >
                    ＋
                  </button>
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
                    className="rounded-lg bg-amber-600 px-3 py-2 text-xs font-bold text-white shadow-sm hover:bg-amber-700 sm:px-4 sm:text-sm"
                    title="為所有出勤且非手動指定餐點的同事隨機配餐；休假與手動套用者略過"
                  >
                    🎲 一鍵全員轉盤
                  </button>
                </div>
              </div>
              <ul className="h-auto px-1 py-2 sm:px-3">
                {personnel.map((p) => {
                  const active = p.id === selectedPersonId
                  const row = colleagueRowDisplay(p.id)
                  return (
                    <li key={p.id} className="border-b border-amber-100/80 last:border-b-0">
                      <div
                        className={`flex min-w-0 flex-nowrap items-stretch gap-2 py-2.5 pl-1 pr-1 transition sm:gap-3 sm:pl-2 sm:pr-2 ${
                          active
                            ? 'bg-amber-100/90 ring-1 ring-inset ring-amber-300/80'
                            : 'hover:bg-amber-50/80'
                        }`}
                      >
                        <button
                          type="button"
                          title={`${p.name}（雙擊切換休假）`}
                          onClick={() => scheduleSelectPerson(p.id)}
                          onDoubleClick={(e) => {
                            e.preventDefault()
                            cancelScheduledSelectAndToggleAbsent(p.id)
                          }}
                          className="flex min-h-[3.25rem] w-16 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-slate-200/80 bg-slate-100 px-1 py-2 text-center text-xl font-medium leading-tight text-slate-900 shadow-sm hover:bg-slate-200/70"
                        >
                          <span className="line-clamp-2 w-full break-all text-center">
                            {p.name}
                          </span>
                        </button>

                        <div className="flex min-h-[3.25rem] w-64 shrink-0 items-stretch rounded-lg border border-slate-200/80 bg-slate-100 px-2 py-1 shadow-sm">
                          {p.isAbsent ? (
                            <div className="flex min-w-0 flex-1 items-center justify-center text-center">
                              <AbsentSlotIcon />
                            </div>
                          ) : (
                            <button
                              type="button"
                              title={row.drinkName || undefined}
                              onClick={() => scheduleSelectPerson(p.id)}
                              className="flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-md py-1 text-center text-xl font-medium leading-snug text-slate-900 hover:bg-slate-200/60"
                            >
                              <span className="block min-w-0 max-w-full truncate whitespace-nowrap text-center">
                                {row.drinkName}
                              </span>
                            </button>
                          )}
                        </div>

                        <div className="flex min-h-[3.25rem] min-w-0 flex-1 items-stretch gap-1">
                          {p.isAbsent ? (
                            <div className="flex min-h-[3.25rem] min-w-0 flex-1 items-center justify-center rounded-lg border border-slate-200/80 bg-slate-100 px-3 py-2 text-center shadow-sm">
                              <AbsentSlotIcon />
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => scheduleSelectPerson(p.id)}
                              className="flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-slate-200/80 bg-slate-100 px-3 py-2 text-center text-xl font-medium leading-snug text-slate-900 shadow-sm hover:bg-slate-200/70"
                            >
                              <span className="block min-w-0 max-w-full truncate whitespace-nowrap text-center">
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
                      </div>
                    </li>
                  )
                })}
              </ul>

              <div className="border-t border-amber-200/80 bg-amber-50/30 px-4 py-4 sm:px-5">
                <h3 className="text-sm font-semibold text-amber-950">
                  店家點餐彙整
                </h3>
                <p className="mt-3 select-all text-lg leading-relaxed text-black">
                  {shopSummaryLine}
                </p>
                <p className="mt-3 text-xs text-amber-900/55">
                  純文字一行，可直接複製；若同事有勾選「吐司類一律不烤」且點吐司，總結中會出現
                  (不烤)。
                </p>
              </div>
            </div>
          </aside>

          {/* 右：當前編輯、指定餐點、隨機選餐 */}
          <main className="flex min-w-0 flex-col gap-3 lg:col-span-4 xl:col-span-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start sm:justify-end">
              <div className="flex max-w-xl flex-col items-stretch gap-1 sm:items-end sm:ml-auto">
                <button
                  type="button"
                  onClick={clearAllWheelFoodsGlobally}
                  className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-800 hover:bg-rose-100"
                  title="清空非指定套用之餐點，並將全員恢復為出勤"
                >
                  一鍵淨空
                </button>
                <p className="text-right text-[11px] leading-snug text-rose-900/55">
                  影響全部 {personnel.length}
                  人；清空非指定餐點、取消全員休假；指定套用與飲品／忌口設定不變
                </p>
              </div>
            </div>

            <section className="rounded-2xl border border-amber-200/80 bg-white/95 p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-amber-950">
                當前點餐編輯
              </h2>
              <p className="mt-0.5 text-[11px] text-amber-900/55">
                左側點姓名選取同事；以下修改即時生效。
              </p>
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
                  指定餐點
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
                  <select
                    value={manualFoodId}
                    onChange={(e) => setManualFoodId(e.target.value)}
                    className="min-h-[2.25rem] min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-amber-400/30 focus:ring-2"
                  >
                    <option value="">請選擇餐點</option>
                    {foodOptions.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name} · ${f.price}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={applyManualFood}
                    disabled={!manualFoodId || !!selectedPerson.isAbsent}
                    className="h-9 shrink-0 rounded-lg bg-amber-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                  >
                    套用
                  </button>
                </div>
                <p className="mt-1.5 text-[10px] text-slate-500">
                  「一鍵淨空」不會清除此處已套用餐點；休假中無法套用。
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
                <label className="block text-xs font-medium text-slate-800">
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
                    {selectedPerson.isAbsent
                      ? '休假中'
                      : selectedFood
                        ? (() => {
                            const base = formatFoodLabelForPerson(
                              selectedFood,
                              selectedPerson,
                              categoryMap,
                            )
                            const fr = (currentOrder.foodRemark ?? '').trim()
                            let s = `${base}（$${selectedFood.price}）`
                            if (fr) s += `（${fr}）`
                            return s
                          })()
                        : ''}
                  </span>
                </p>
              </div>
            </section>

            <section className="rounded-2xl border border-orange-200/70 bg-white/90 p-5 shadow-sm shadow-orange-900/5">
              <h2 className="text-lg font-semibold text-orange-950">隨機選餐</h2>
              <p className="mt-1 text-xs text-orange-900/55">
                候選由預算與忌口過濾；大量品項時以文字跳動抽選，不使用圓餅圖。
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
                  className={`relative mx-auto w-full max-w-lg rounded-2xl bg-gradient-to-b from-orange-200/95 via-amber-100/90 to-orange-300/90 p-[5px] shadow-[0_20px_56px_-14px_rgba(194,65,12,0.42)] ring-2 ring-amber-950/15 transition-[transform,box-shadow] duration-300 ${
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
                              categoryMap,
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
                    spinPhase === 'spinning' || wheelCandidates.length === 0
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
                          ? formatFoodLabelForPerson(f, selectedPerson, categoryMap)
                          : '—'
                      })()}
                    </span>
                  </>
                ) : spinPhase === 'spinning' ? (
                  '文字高速切換中，即將開獎…'
                ) : selectedPerson.isAbsent ? (
                  '休假中無法選餐，請雙擊姓名卡片恢復出勤。'
                ) : wheelCandidates.length === 0 ? (
                  '預算不足或無符合餐點，請調整預算、飲料或忌口後再試。'
                ) : (
                  '點擊「開始抽餐」以隨機選餐並寫入今日訂單。'
                )}
              </div>
            </section>
          </main>
        </div>
          </>
        )}
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
