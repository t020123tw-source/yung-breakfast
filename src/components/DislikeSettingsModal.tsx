import { memo, useEffect, useMemo, useState } from 'react'
import type { MenuCategoryDef, MenuItem } from '../data/menuData'
import { sortCategoriesForDisplay } from '../data/menuData'

type Props = {
  isOpen: boolean
  onClose: () => void
  personName: string
  categories: MenuCategoryDef[]
  menu: MenuItem[]
  dislikedIds: readonly string[]
  onToggleItem: (itemId: string) => void
  onToggleCategoryAll: (categoryId: string) => void
}

export const DislikeSettingsModal = memo(function DislikeSettingsModal({
  isOpen,
  onClose,
  personName,
  categories,
  menu,
  dislikedIds,
  onToggleItem,
  onToggleCategoryAll,
}: Props) {
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!isOpen) setSearch('')
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [isOpen])

  const dislikedSet = useMemo(() => new Set(dislikedIds), [dislikedIds])

  const groupedColumns = useMemo(() => {
    const q = search.trim().toLowerCase()
    const ordered = sortCategoriesForDisplay(categories)
    return ordered
      .map((c) => ({
        category: c,
        items: menu.filter((m) => {
          if (m.categoryId !== c.id) return false
          if (!q) return true
          return m.name.toLowerCase().includes(q)
        }),
      }))
      .filter((g) => g.items.length > 0)
  }, [categories, menu, search])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto py-6 sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dislike-modal-title"
    >
      <button
        type="button"
        className="fixed inset-0 bg-slate-900/55 backdrop-blur-md transition-opacity"
        onClick={onClose}
        aria-label="關閉視窗"
      />

      <div className="relative z-10 mx-4 flex w-full max-w-6xl flex-col rounded-2xl border border-slate-200/90 bg-white shadow-2xl shadow-slate-900/20">
        {/* 頂部：標題 + 搜尋 */}
        <div className="sticky top-0 z-10 rounded-t-2xl border-b border-slate-200 bg-gradient-to-b from-amber-50/95 to-white px-5 py-4 sm:px-7">
          <h2
            id="dislike-modal-title"
            className="text-lg font-bold tracking-tight text-slate-900 sm:text-xl"
          >
            {personName} 的忌口與喜好設定
          </h2>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋餐點名稱…"
            autoComplete="off"
            className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-lg text-slate-900 outline-none ring-amber-400/30 placeholder:text-slate-400 focus:ring-2"
          />
        </div>

        {/* 多欄類別網格（飲料已於 sortCategoriesForDisplay 置底） */}
        <div className="max-h-[min(72vh,860px)] overflow-y-auto px-4 py-5 sm:px-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3 lg:grid-cols-4 md:gap-5">
            {groupedColumns.map(({ category: c, items }) => {
              const allDisliked = items.every((it) => dislikedSet.has(it.id))
              return (
                <section
                  key={c.id}
                  className="flex min-h-0 min-w-0 flex-col rounded-xl border border-slate-200/90 bg-slate-50/80 p-3 shadow-inner"
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 pb-2">
                    <h3 className="text-lg font-bold text-slate-900">
                      {c.name}
                    </h3>
                    <button
                      type="button"
                      onClick={() => onToggleCategoryAll(c.id)}
                      className="shrink-0 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-sm font-semibold text-rose-800 hover:bg-rose-100"
                    >
                      {allDisliked ? '全類取消' : '全類別打 X'}
                    </button>
                  </div>
                  <ul className="space-y-2">
                    {items.map((it) => {
                      const dis = dislikedSet.has(it.id)
                      return (
                        <li key={it.id}>
                          <button
                            type="button"
                            onClick={() => onToggleItem(it.id)}
                            className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-lg font-medium text-slate-900 transition-colors ${
                              dis
                                ? 'border-rose-300 bg-rose-50/90 text-rose-950'
                                : 'border-slate-200/80 bg-white hover:bg-amber-50/50'
                            }`}
                          >
                            <span className="min-w-0 flex-1 leading-snug">
                              {it.name}
                              <span className="ml-2 tabular-nums text-base text-slate-600">
                                ${it.price}
                              </span>
                            </span>
                            <span
                              className={`flex h-9 min-w-[2.25rem] shrink-0 items-center justify-center rounded-lg border text-base font-bold ${
                                dis
                                  ? 'border-rose-400 bg-rose-100 text-rose-800'
                                  : 'border-slate-200 bg-slate-100 text-slate-400'
                              }`}
                            >
                              {dis ? '✕' : '—'}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>

          {groupedColumns.length === 0 ? (
            <p className="py-8 text-center text-lg text-slate-500">
              沒有符合搜尋的餐點。
            </p>
          ) : null}
        </div>

        {/* 底部操作 */}
        <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50/90 px-5 py-4 sm:px-7">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-amber-600 px-6 py-3 text-lg font-bold text-white shadow-md hover:bg-amber-700"
          >
            儲存並關閉
          </button>
        </div>
      </div>
    </div>
  )
})
