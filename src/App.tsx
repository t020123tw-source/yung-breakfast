import { useCallback, useEffect, useState } from 'react'
import type { MenuCategoryDef, MenuItem } from './data/menuData'
import { INITIAL_CATEGORIES, INITIAL_MENU_ITEMS } from './data/menuData'
import { BreakfastOrderingApp } from './components/BreakfastOrderingApp'
import { MenuManagementPanel } from './components/MenuManagementPanel'
import { fetchColleaguesFromSupabase } from './lib/colleagueSupabase'
import {
  deleteMenuItemById,
  deleteMenuItemsByCategoryName,
  fetchMenuFromSupabase,
  insertMenuItemRow,
  menuItemToInsertPayload,
} from './lib/menuSupabase'
import type { Order, Personnel } from './domain/breakfastTypes'

export type AppTab = 'order' | 'menu'

function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="flex min-h-[40vh] w-full items-center justify-center px-4 py-16">
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-amber-200/90 bg-white/90 px-8 py-10 shadow-sm">
        <div
          className="size-10 animate-spin rounded-full border-2 border-amber-200 border-t-amber-600"
          aria-hidden
        />
        <p className="text-sm font-medium text-amber-950">{label}</p>
      </div>
    </div>
  )
}

function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('order')
  const [categories, setCategories] =
    useState<MenuCategoryDef[]>(INITIAL_CATEGORIES)
  const [menu, setMenu] = useState<MenuItem[]>(INITIAL_MENU_ITEMS)

  const [menuTabLoading, setMenuTabLoading] = useState(false)
  const [menuTabError, setMenuTabError] = useState<string | null>(null)

  /** 初次進入點餐分頁需先拉取雲端資料，避免以本地預設菜單／空名單誤渲染 */
  const [orderTabLoading, setOrderTabLoading] = useState(true)
  const [orderTabError, setOrderTabError] = useState<string | null>(null)
  const [orderPersonnel, setOrderPersonnel] = useState<Personnel[]>([])
  const [orderOrders, setOrderOrders] = useState<Order[]>([])
  const [orderDataKey, setOrderDataKey] = useState(0)

  useEffect(() => {
    if (activeTab !== 'menu') return
    let cancelled = false
    setMenuTabLoading(true)
    setMenuTabError(null)
    void (async () => {
      try {
        const { categories: c, menu: m } = await fetchMenuFromSupabase()
        if (cancelled) return
        setCategories(c)
        setMenu(m)
      } catch (e) {
        if (cancelled) return
        setMenuTabError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setMenuTabLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeTab])

  useEffect(() => {
    if (activeTab !== 'order') return
    let cancelled = false
    setOrderTabLoading(true)
    setOrderTabError(null)
    void (async () => {
      try {
        const [{ categories: c, menu: m }, col] = await Promise.all([
          fetchMenuFromSupabase(),
          fetchColleaguesFromSupabase(),
        ])
        if (cancelled) return
        setCategories(c)
        setMenu(m)
        setOrderPersonnel(col.personnel)
        setOrderOrders(col.orders)
        setOrderDataKey((k) => k + 1)
      } catch (e) {
        if (cancelled) return
        setOrderTabError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setOrderTabLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeTab])

  const onAddMenuItem = useCallback(
    async (args: { newCategory?: MenuCategoryDef; item: MenuItem }) => {
      const nextCategories = args.newCategory
        ? [...categories, args.newCategory]
        : categories
      if (args.newCategory) {
        setCategories(nextCategories)
      }
      const row = menuItemToInsertPayload(args.item, nextCategories)
      await insertMenuItemRow(row)
      setMenu((prev) => [...prev, args.item])
    },
    [categories],
  )

  const onRemoveMenuItem = useCallback(async (itemId: string) => {
    await deleteMenuItemById(itemId)
    setMenu((prev) => prev.filter((x) => x.id !== itemId))
  }, [])

  const onRemoveMenuCategory = useCallback(async (categoryId: string) => {
    await deleteMenuItemsByCategoryName(categoryId)
    setMenu((prev) => prev.filter((m) => m.categoryId !== categoryId))
    setCategories((prev) => prev.filter((c) => c.id !== categoryId))
  }, [])

  return (
    <div className="min-h-dvh w-full bg-gradient-to-br from-amber-50 via-orange-50/40 to-emerald-50/30 text-slate-900">
      <header className="sticky top-0 z-[100] border-b-2 border-amber-300/90 bg-white/95 shadow-md backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-4 py-4 sm:px-6 lg:px-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-xl font-bold tracking-tight text-amber-950 sm:text-2xl">
              早餐點餐系統
            </h1>
          </div>

          <div
            className="flex flex-wrap gap-2 rounded-2xl border-2 border-amber-200/90 bg-amber-50/80 p-2 shadow-inner"
            role="tablist"
            aria-label="主分頁"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'order'}
              id="tab-order"
              onClick={() => setActiveTab('order')}
              className={`min-h-[48px] min-w-[140px] rounded-xl px-5 py-3 text-sm font-bold shadow-sm transition-all sm:text-base ${
                activeTab === 'order'
                  ? 'bg-amber-500 text-white ring-2 ring-amber-600 ring-offset-2'
                  : 'bg-white text-amber-900 hover:bg-amber-100'
              }`}
            >
              點餐介面
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'menu'}
              id="tab-menu"
              onClick={() => setActiveTab('menu')}
              className={`min-h-[48px] min-w-[200px] rounded-xl px-5 py-3 text-sm font-bold shadow-sm transition-all sm:text-base ${
                activeTab === 'menu'
                  ? 'bg-emerald-600 text-white ring-2 ring-emerald-700 ring-offset-2'
                  : 'bg-white text-emerald-900 hover:bg-emerald-50'
              }`}
            >
              菜單設定與管理
            </button>
          </div>

          <p className="text-xs text-slate-600">
            {activeTab === 'order'
              ? '編輯同事、隨機抽餐與店家彙整。菜單與同事資料由 Supabase 同步。'
              : '此頁僅顯示菜單 CRUD；變更即寫入 menu_items。'}
          </p>
        </div>
      </header>

      <main className="w-full">
        {activeTab === 'order' ? (
          orderTabLoading ? (
            <LoadingBlock label="正在載入菜單與同事名單…" />
          ) : orderTabError ? (
            <div className="px-4 py-10 sm:px-6 lg:px-10">
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
                載入失敗：{orderTabError}
              </div>
            </div>
          ) : (
            <BreakfastOrderingApp
              key={orderDataKey}
              menu={menu}
              categories={categories}
              initialPersonnel={orderPersonnel}
              initialOrders={orderOrders}
            />
          )
        ) : menuTabLoading ? (
          <div className="border-t border-emerald-100/80 bg-emerald-50/20 px-4 py-6 sm:px-6 lg:px-10">
            <LoadingBlock label="正在載入菜單…" />
          </div>
        ) : menuTabError ? (
          <div className="border-t border-emerald-100/80 bg-emerald-50/20 px-4 py-6 sm:px-6 lg:px-10">
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
              載入失敗：{menuTabError}
            </div>
          </div>
        ) : (
          <div className="border-t border-emerald-100/80 bg-emerald-50/20 px-4 py-6 sm:px-6 lg:px-10">
            <MenuManagementPanel
              categories={categories}
              menu={menu}
              onAddItem={onAddMenuItem}
              onRemoveItem={onRemoveMenuItem}
              onRemoveCategory={onRemoveMenuCategory}
            />
          </div>
        )}
      </main>
    </div>
  )
}

export default App
