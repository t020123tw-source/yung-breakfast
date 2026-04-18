import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  type MenuCategoryDef,
  type MenuItem,
  sortCategoriesForDisplay,
} from '../data/menuData'

const CATEGORY_DATALIST_ID = 'menu-category-options'

function formatMenuAddError(err: unknown): string {
  if (err && typeof err === 'object') {
    const o = err as {
      message?: unknown
      details?: unknown
      hint?: unknown
      code?: unknown
    }
    const parts: string[] = []
    if (typeof o.message === 'string' && o.message.trim()) parts.push(o.message)
    if (typeof o.details === 'string' && o.details.trim()) parts.push(o.details)
    if (typeof o.hint === 'string' && o.hint.trim()) parts.push(`提示：${o.hint}`)
    if (typeof o.code === 'string' && o.code.trim()) parts.push(`code: ${o.code}`)
    if (parts.length > 0) return parts.join(' · ')
  }
  if (err instanceof Error && err.message) return err.message
  return typeof err === 'string' ? err : '新增失敗，請見主控台詳情'
}

type Props = {
  /** 僅用於顯示與寫入；類別清單由 menu 內不重複的 categoryId 動態產生 */
  menu: MenuItem[]
  onAddItem: (args: {
    name: string
    price: number
    category: string
  }) => Promise<void>
  onRemoveItem: (itemId: string) => Promise<void>
  onRemoveCategory: (categoryId: string) => Promise<void>
  onUpdateItem: (args: { id: string; name: string; price: number }) => Promise<void>
}

function categoryEmoji(c: MenuCategoryDef): string {
  if (c.name === '飲料') return '🥤'
  if (c.name === '吐司') return '🍞'
  return '🍽️'
}

export function MenuManagementPanel({
  menu,
  onAddItem,
  onRemoveItem,
  onRemoveCategory,
  onUpdateItem,
}: Props) {
  const [itemName, setItemName] = useState('')
  const [itemPrice, setItemPrice] = useState('30')
  /** 類別：可從 datalist 選現有，或直接輸入新類別名稱 */
  const [categoryInput, setCategoryInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [editingPrice, setEditingPrice] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const didInitCategoryRef = useRef(false)

  /** 由 menu 內品項提取不重複類別（無獨立 categories 表） */
  const categoriesFromMenu = useMemo(() => {
    const set = new Set<string>()
    for (const m of menu) {
      const c = (m.categoryId ?? '').trim()
      if (c) set.add(c)
    }
    const labels = [...set].sort((a, b) => a.localeCompare(b, 'zh-Hant'))
    const defs: MenuCategoryDef[] = labels.map((name) => ({ id: name, name }))
    return sortCategoriesForDisplay(defs)
  }, [menu])

  /** 僅在首次取得類別列表時帶入預設值，避免與使用者清空／輸入衝突 */
  useEffect(() => {
    if (didInitCategoryRef.current) return
    if (categoriesFromMenu.length === 0) return
    setCategoryInput(categoriesFromMenu[0]?.name ?? '')
    didInitCategoryRef.current = true
  }, [categoriesFromMenu])

  const itemsByCategoryLists = useMemo(
    () =>
      categoriesFromMenu.map((c) => {
        const isDrinkCategory = c.name.includes('飲料')
        return {
          category: c,
          items: menu.filter((m) => m.categoryId === c.id).sort((a, b) => {
            if (isDrinkCategory) {
              return a.name.localeCompare(b.name, 'zh-Hant') || a.price - b.price
            }
            return a.price - b.price || a.name.localeCompare(b.name, 'zh-Hant')
          }),
        }
      }),
    [categoriesFromMenu, menu],
  )

  const removeCategory = useCallback(
    async (catId: string) => {
      if (saving) return
      setSaving(true)
      try {
        await onRemoveCategory(catId)
      } catch (e) {
        console.error(e)
      } finally {
        setSaving(false)
      }
    },
    [onRemoveCategory, saving],
  )

  const addItem = useCallback(async () => {
    if (saving) return
    const name = itemName.trim()
    const cat = categoryInput.trim()
    if (!name || !cat) return

    const price = Math.max(
      0,
      Math.min(999999, parseInt(itemPrice.replace(/\D/g, ''), 10) || 0),
    )

    setSaving(true)
    setAddError(null)
    try {
      await onAddItem({
        name,
        price: Number(price),
        category: cat,
      })
      setItemName('')
      setItemPrice(String(price))
    } catch (e: unknown) {
      console.error('新增餐點失敗（完整物件）:', e)
      if (e && typeof e === 'object') {
        console.error('message:', (e as { message?: string }).message)
        console.error('details:', (e as { details?: string }).details)
      }
      setAddError(formatMenuAddError(e))
    } finally {
      setSaving(false)
    }
  }, [saving, itemName, itemPrice, categoryInput, onAddItem])

  const removeItem = useCallback(
    async (itemId: string) => {
      if (saving) return
      setSaving(true)
      try {
        await onRemoveItem(itemId)
      } catch (e) {
        console.error(e)
      } finally {
        setSaving(false)
      }
    },
    [onRemoveItem, saving],
  )

  const startEditingItem = useCallback(
    (item: MenuItem) => {
      if (saving) return
      setEditingId(item.id)
      setEditingName(item.name)
      setEditingPrice(String(item.price))
      setEditError(null)
    },
    [saving],
  )

  const cancelEditing = useCallback(() => {
    setEditingId(null)
    setEditingName('')
    setEditingPrice('')
    setEditError(null)
  }, [])

  const saveEditingItem = useCallback(async () => {
    if (saving || !editingId) return
    const name = editingName.trim()
    if (!name) {
      setEditError('餐點名稱不可為空')
      return
    }
    const price = Math.max(
      0,
      Math.min(999999, parseInt(editingPrice.replace(/\D/g, ''), 10) || 0),
    )
    setSaving(true)
    setEditError(null)
    try {
      await onUpdateItem({
        id: editingId,
        name,
        price,
      })
      cancelEditing()
    } catch (e) {
      console.error(e)
      setEditError(formatMenuAddError(e))
    } finally {
      setSaving(false)
    }
  }, [cancelEditing, editingId, editingName, editingPrice, onUpdateItem, saving])

  return (
    <div className="mx-auto w-full max-w-7xl space-y-10 pb-16">
      <section className="rounded-lg border border-emerald-200/90 bg-white p-3 shadow-sm sm:p-4">
        <h2 className="mb-2 text-sm font-semibold text-emerald-950">新增餐點</h2>

        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:gap-3">
            <label className="block min-w-0 flex-1 text-sm font-medium text-slate-800">
              類別
              <input
                type="text"
                list={CATEGORY_DATALIST_ID}
                value={categoryInput}
                onChange={(e) => setCategoryInput(e.target.value)}
                placeholder="選擇或輸入類別名稱"
                disabled={saving}
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none ring-emerald-400/20 placeholder:text-slate-400 focus:ring-2 disabled:opacity-50"
              />
              <datalist id={CATEGORY_DATALIST_ID}>
                {categoriesFromMenu.map((c) => (
                  <option key={c.id} value={c.name} />
                ))}
              </datalist>
            </label>

            <label className="block min-w-0 flex-[2] text-sm font-medium text-slate-800">
              餐點名稱
              <input
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                placeholder="餐點名稱"
                disabled={saving}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 outline-none ring-emerald-400/20 placeholder:text-slate-400 focus:ring-2 disabled:opacity-50"
              />
            </label>

            <label className="block w-full shrink-0 text-sm font-medium text-slate-800 sm:w-28">
              金額
              <input
                inputMode="numeric"
                value={itemPrice}
                onChange={(e) => setItemPrice(e.target.value)}
                placeholder="金額"
                disabled={saving}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm tabular-nums text-slate-900 outline-none ring-emerald-400/20 placeholder:text-slate-400 focus:ring-2 disabled:opacity-50"
              />
            </label>

            <button
              type="button"
              onClick={() => void addItem()}
              disabled={saving || !itemName.trim() || !categoryInput.trim()}
              className="h-10 w-full shrink-0 rounded-lg bg-emerald-600 px-6 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 sm:h-[2.625rem] sm:w-auto sm:self-end"
            >
              {saving ? '同步中…' : '+ 新增'}
            </button>
          </div>
        </div>

        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          類別欄可從建議清單選取，或直接輸入新類別名稱。飲料請將類別命名為「飲料」，轉盤與固定飲料邏輯會依類別名稱判斷。
        </p>
        {addError ? (
          <p
            className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
            role="alert"
          >
            新增失敗：{addError}
          </p>
        ) : null}
        {editError ? (
          <p
            className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
            role="alert"
          >
            編輯失敗：{editError}
          </p>
        ) : null}
      </section>

      <section>
        <h2 className="text-lg font-bold text-slate-900">現有菜單列表</h2>
        <p className="mt-1 text-xs text-slate-600">
          依類別分組（「飲料」類固定排在最後一欄）；刪除類別會一併刪除該類所有餐點。
        </p>

        <ul className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3 lg:grid-cols-4 md:gap-5 lg:gap-6">
          {itemsByCategoryLists.map(({ category: c, items }) => (
            <li
              key={c.id}
              className="flex min-h-0 min-w-0 flex-col rounded-xl border border-slate-200/90 bg-slate-50/70 p-2.5 shadow-sm"
            >
              <div className="mb-1.5 flex shrink-0 items-start justify-between gap-1 border-b border-slate-200/80 pb-1.5">
                <p className="min-w-0 break-words font-mono text-xs font-bold leading-tight text-slate-800 sm:text-sm">
                  {categoryEmoji(c)} {c.name}
                </p>
                <button
                  type="button"
                  onClick={() => void removeCategory(c.id)}
                  disabled={saving}
                  className="shrink-0 text-[10px] font-semibold text-rose-700 hover:underline disabled:opacity-40 sm:text-xs"
                >
                  刪類別
                </button>
              </div>
              {items.length === 0 ? (
                <p className="py-1 text-xs text-slate-400">（尚無餐點）</p>
              ) : (
                <ul className="min-h-0 flex-1 space-y-1">
                  {items.map((it) => (
                    <li
                      key={it.id}
                      className="flex items-center gap-1.5 rounded-md border border-slate-100 bg-white px-1.5 py-1 shadow-sm"
                    >
                      {editingId === it.id ? (
                        <>
                          <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            <input
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              disabled={saving}
                              className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-xs text-slate-900 outline-none ring-emerald-400/20 focus:ring-2 disabled:opacity-50 sm:text-sm"
                              placeholder="餐點名稱"
                            />
                            <input
                              inputMode="numeric"
                              value={editingPrice}
                              onChange={(e) => setEditingPrice(e.target.value)}
                              disabled={saving}
                              className="w-16 shrink-0 rounded border border-slate-200 px-2 py-1 text-right text-xs tabular-nums text-slate-900 outline-none ring-emerald-400/20 focus:ring-2 disabled:opacity-50 sm:text-sm"
                              placeholder="金額"
                            />
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void saveEditingItem()}
                              disabled={saving || !editingName.trim()}
                              className="rounded border border-emerald-200/90 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-40 sm:text-xs"
                            >
                              儲存
                            </button>
                            <button
                              type="button"
                              onClick={() => cancelEditing()}
                              disabled={saving}
                              className="rounded border border-slate-200/90 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40 sm:text-xs"
                            >
                              取消
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 text-xs leading-snug text-slate-900 sm:text-sm">
                            <span className="text-slate-400">·</span>{' '}
                            <span className="font-medium">{it.name}</span>{' '}
                            <span className="whitespace-nowrap tabular-nums text-slate-600">
                              ${it.price}
                            </span>
                          </span>
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={() => startEditingItem(it)}
                              disabled={saving}
                              className="rounded border border-sky-200/90 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-40 sm:text-xs"
                            >
                              編輯
                            </button>
                            <button
                              type="button"
                              onClick={() => void removeItem(it.id)}
                              disabled={saving}
                              className="rounded border border-rose-200/90 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800 hover:bg-rose-100 disabled:opacity-40 sm:text-xs"
                            >
                              刪除
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
