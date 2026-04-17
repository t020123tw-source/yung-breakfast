import { useState } from 'react'
import type { MenuCategoryDef, MenuItem } from './data/menuData'
import {
  INITIAL_CATEGORIES,
  INITIAL_MENU_ITEMS,
} from './data/menuData'
import { BreakfastOrderingApp } from './components/BreakfastOrderingApp'
import { MenuManagementPanel } from './components/MenuManagementPanel'

export type AppTab = 'order' | 'menu'

function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('order')
  const [categories, setCategories] =
    useState<MenuCategoryDef[]>(INITIAL_CATEGORIES)
  const [menu, setMenu] = useState<MenuItem[]>(INITIAL_MENU_ITEMS)

  return (
    <div className="min-h-dvh w-full bg-gradient-to-br from-amber-50 via-orange-50/40 to-emerald-50/30 text-slate-900">
      {/* 強制雙分頁：頂部固定導覽 */}
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
              ? '編輯同事、隨機抽餐與店家彙整。切換至「菜單設定與管理」可維護品項。'
              : '此頁僅顯示菜單 CRUD；點餐介面已完全隱藏。變更會即時寫入共用資料。'}
          </p>
        </div>
      </header>

      {/* 單一視圖：非 A 即 B，互不並存 */}
      <main className="w-full">
        {activeTab === 'order' ? (
          <BreakfastOrderingApp
            menu={menu}
            setMenu={setMenu}
            categories={categories}
            setCategories={setCategories}
          />
        ) : (
          <div className="border-t border-emerald-100/80 bg-emerald-50/20 px-4 py-6 sm:px-6 lg:px-10">
            <MenuManagementPanel
              categories={categories}
              setCategories={setCategories}
              menu={menu}
              setMenu={setMenu}
            />
          </div>
        )}
      </main>
    </div>
  )
}

export default App
