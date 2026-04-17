import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  type MenuCategoryDef,
  type MenuItem,
  newCategoryId,
  newMenuItemId,
  sortCategoriesForDisplay,
} from '../data/menuData'

const NEW_CAT_VALUE = '__new_category__'

type Props = {
  categories: MenuCategoryDef[]
  menu: MenuItem[]
  onAddItem: (args: {
    newCategory?: MenuCategoryDef
    item: MenuItem
  }) => Promise<void>
  onRemoveItem: (itemId: string) => Promise<void>
  onRemoveCategory: (categoryId: string) => Promise<void>
}

function categoryEmoji(c: MenuCategoryDef): string {
  if (c.isDrink) return '🥤'
  if (c.isToast) return '🍞'
  return '🍽️'
}

export function MenuManagementPanel({
  categories,
  menu,
  onAddItem,
  onRemoveItem,
  onRemoveCategory,
}: Props) {
  const [itemName, setItemName] = useState('')
  const [itemPrice, setItemPrice] = useState('30')
  const [categoryChoice, setCategoryChoice] = useState(
    () => categories[0]?.id ?? '',
  )

  const [newCatName, setNewCatName] = useState('')
  const [newCatDrink, setNewCatDrink] = useState(false)
  const [newCatToast, setNewCatToast] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (categoryChoice === NEW_CAT_VALUE) return
    if (categoryChoice && categories.some((c) => c.id === categoryChoice)) {
      return
    }
    setCategoryChoice(categories[0]?.id ?? NEW_CAT_VALUE)
  }, [categories, categoryChoice])

  const categoriesDisplayOrder = useMemo(
    () => sortCategoriesForDisplay(categories),
    [categories],
  )

  const itemsByCategoryLists = useMemo(
    () =>
      categoriesDisplayOrder.map((c) => ({
        category: c,
        items: menu.filter((m) => m.categoryId === c.id),
      })),
    [categoriesDisplayOrder, menu],
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
    if (!name) return

    let newCategory: MenuCategoryDef | undefined
    let targetCategoryId = categoryChoice

    if (categoryChoice === NEW_CAT_VALUE) {
      const cn = newCatName.trim()
      if (!cn || (newCatDrink && newCatToast)) return
      const id = newCategoryId()
      newCategory = {
        id,
        name: cn,
        isDrink: newCatDrink,
        isToast: newCatToast && !newCatDrink,
      }
      targetCategoryId = id
    }

    if (!targetCategoryId || targetCategoryId === NEW_CAT_VALUE) return

    const price = Math.max(
      0,
      Math.min(999999, parseInt(itemPrice.replace(/\D/g, ''), 10) || 0),
    )
    const id = newMenuItemId()
    const item: MenuItem = {
      id,
      name,
      price,
      categoryId: targetCategoryId,
    }

    setSaving(true)
    try {
      await onAddItem({ newCategory, item })
      if (categoryChoice === NEW_CAT_VALUE) {
        setNewCatName('')
        setNewCatDrink(false)
        setNewCatToast(false)
        setCategoryChoice(targetCategoryId)
      }
      setItemName('')
      setItemPrice(String(price))
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }, [
    saving,
    itemName,
    itemPrice,
    categoryChoice,
    newCatName,
    newCatDrink,
    newCatToast,
    onAddItem,
  ])

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

  return (
    <div className="mx-auto w-full max-w-7xl space-y-10 pb-16">
      {/* 上半部：新增餐點（單行橫向） */}
      <section className="rounded-lg border border-emerald-200/90 bg-white p-3 shadow-sm sm:p-4">
        <h2 className="mb-2 text-sm font-semibold text-emerald-950">新增餐點</h2>

        <div className="flex flex-col gap-2">
          <div className="flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto pb-0.5 sm:gap-3 md:overflow-visible">
            <div className="min-w-[10.5rem] shrink-0 md:min-w-0 md:flex-1">
              <select
                value={categoryChoice}
                onChange={(e) => setCategoryChoice(e.target.value)}
                title="類別"
                disabled={saving}
                className="h-10 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-sm text-slate-900 outline-none ring-emerald-400/20 focus:ring-2 disabled:opacity-50"
              >
                {categoriesDisplayOrder.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.isDrink ? '（飲料）' : ''}
                    {c.isToast ? '（吐司）' : ''}
                  </option>
                ))}
                <option value={NEW_CAT_VALUE}>＋ 建立新類別…</option>
              </select>
            </div>

            <div className="min-w-[10rem] shrink-0 md:min-w-0 md:flex-[2]">
              <input
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                placeholder="餐點名稱"
                disabled={saving}
                className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-900 outline-none ring-emerald-400/20 placeholder:text-slate-400 focus:ring-2 disabled:opacity-50"
              />
            </div>

            <div className="w-24 shrink-0 sm:w-28">
              <input
                inputMode="numeric"
                value={itemPrice}
                onChange={(e) => setItemPrice(e.target.value)}
                placeholder="金額"
                disabled={saving}
                className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm tabular-nums text-slate-900 outline-none ring-emerald-400/20 placeholder:text-slate-400 focus:ring-2 disabled:opacity-50"
              />
            </div>

            <button
              type="button"
              onClick={() => void addItem()}
              disabled={
                saving ||
                !itemName.trim() ||
                (categoryChoice === NEW_CAT_VALUE &&
                  (!newCatName.trim() || (newCatDrink && newCatToast)))
              }
              className="h-10 w-auto shrink-0 whitespace-nowrap rounded-lg bg-emerald-600 px-6 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? '同步中…' : '+ 新增'}
            </button>
          </div>

          {categoryChoice === NEW_CAT_VALUE ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-emerald-300/80 bg-emerald-50/60 px-2 py-1.5">
              <input
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder="新類別名稱"
                disabled={saving}
                className="h-9 min-w-[10rem] flex-1 rounded border border-slate-200 bg-white px-2.5 text-sm disabled:opacity-50"
              />
              <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={newCatDrink}
                  disabled={saving}
                  onChange={(e) => {
                    setNewCatDrink(e.target.checked)
                    if (e.target.checked) setNewCatToast(false)
                  }}
                  className="rounded border-slate-300"
                />
                飲料
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={newCatToast}
                  disabled={saving}
                  onChange={(e) => {
                    setNewCatToast(e.target.checked)
                    if (e.target.checked) setNewCatDrink(false)
                  }}
                  className="rounded border-slate-300"
                />
                吐司
              </label>
            </div>
          ) : null}
        </div>

        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          選「建立新類別」時須填新類別名稱；飲料／吐司屬性影響點餐介面。
        </p>
      </section>

      {/* 下半部：依類別分群列表 */}
      <section>
        <h2 className="text-lg font-bold text-slate-900">現有菜單列表</h2>
        <p className="mt-1 text-xs text-slate-600">
          依類別分組（飲料類固定排在最後一欄）；多欄並排以減少捲動。刪除類別會一併刪除該類所有餐點。
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
                      <span className="min-w-0 flex-1 text-xs leading-snug text-slate-900 sm:text-sm">
                        <span className="text-slate-400">·</span>{' '}
                        <span className="font-medium">{it.name}</span>{' '}
                        <span className="whitespace-nowrap tabular-nums text-slate-600">
                          ${it.price}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => void removeItem(it.id)}
                        disabled={saving}
                        className="shrink-0 rounded border border-rose-200/90 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800 hover:bg-rose-100 disabled:opacity-40 sm:text-xs"
                      >
                        刪除
                      </button>
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
