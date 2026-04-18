import { useEffect, useMemo, useState } from 'react'
import type { OtherStoreEntry, Personnel } from '../domain/breakfastTypes'
import { updateColleagueOtherStoreFields } from '../lib/colleagueSupabase'

export type OtherStorePanelProps = {
  initialPersonnel: Personnel[]
  initialEntries: OtherStoreEntry[]
}

type EntryDraft = {
  otherFoods: [string, string]
  otherPrice: string
}

function normalizeFoodText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const text = raw.trim()
  return text === '' || text === '0' ? '' : text
}

function splitOtherFoods(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split('+')
    .map((item) => item.trim())
    .filter((item) => item !== '' && item !== '0')
}

function otherFoodsForInputs(raw: unknown): [string, string] {
  const parts = splitOtherFoods(raw)
  if (parts.length === 0) return ['', '']
  if (parts.length === 1) return [parts[0], '']
  return [parts[0], parts.slice(1).join(' + ')]
}

function joinOtherFoodsForSave(parts: [string, string]): string | null {
  const filtered = parts.map((item) => normalizeFoodText(item)).filter(Boolean)
  if (filtered.length === 0) return null
  return filtered.join(' + ')
}

function normalizeDraftMap(
  personnel: Personnel[],
  entries: OtherStoreEntry[],
): Record<string, EntryDraft> {
  return Object.fromEntries(
    personnel.map((p) => {
      const entry = entries.find((x) => x.userId === p.id)
      return [
        p.id,
        {
          otherFoods: otherFoodsForInputs(entry?.otherFood),
          otherPrice:
            entry?.otherPrice == null || Number.isNaN(entry.otherPrice)
              ? ''
              : String(entry.otherPrice),
        },
      ]
    }),
  )
}

export function OtherStorePanel({
  initialPersonnel,
  initialEntries,
}: OtherStorePanelProps) {
  const [personnel, setPersonnel] = useState<Personnel[]>(initialPersonnel)
  const [drafts, setDrafts] = useState<Record<string, EntryDraft>>(() =>
    normalizeDraftMap(initialPersonnel, initialEntries),
  )

  useEffect(() => {
    setPersonnel(initialPersonnel)
    setDrafts(normalizeDraftMap(initialPersonnel, initialEntries))
  }, [initialPersonnel, initialEntries])

  const summary = useMemo(() => {
    const foodCount = new Map<string, number>()
    let totalPrice = 0
    for (const p of personnel) {
      const draft = drafts[p.id]
      const foods = draft?.otherFoods ?? ['', '']
      const priceText = (draft?.otherPrice ?? '').trim()
      for (const food of foods.flatMap((item) => splitOtherFoods(item))) {
        if (!food) continue
        foodCount.set(food, (foodCount.get(food) ?? 0) + 1)
      }
      if (priceText !== '') {
        const n = Number(priceText)
        if (Number.isFinite(n)) totalPrice += n
      }
    }
    const foodSummary =
      [...foodCount.entries()]
        .sort(([a], [b]) => a.localeCompare(b, 'zh-Hant'))
        .map(([food, count]) => `${food} x ${count}`)
        .join('、') || '（尚無品項）'
    return { foodSummary, totalPrice }
  }, [personnel, drafts])

  return (
    <div className="w-full text-slate-900">
      <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 sm:px-6 lg:px-8 lg:py-5">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl border border-amber-200/70 bg-white/90 shadow-sm">
          <div className="border-b border-amber-100 px-3 py-3 sm:px-4">
            <h2 className="text-sm font-semibold text-amber-950">其他店家</h2>
            <p className="mt-1 text-xs text-amber-800/60">
              緊湊模式清單；餐點與金額於失焦時自動寫回 Supabase。
            </p>
          </div>

          <ul className="h-auto flex-1 px-1 pb-0 pt-1 sm:px-2">
            {personnel.length === 0 ? (
              <li className="list-none px-3 py-8 text-center text-sm text-amber-800/80">
                目前尚無同事資料。
              </li>
            ) : null}
            {personnel.map((p) => {
              const draft = drafts[p.id] ?? { otherFoods: ['', ''], otherPrice: '' }
              return (
                <li key={p.id} className="border-b border-amber-100/80 last:border-b-0">
                  <div className="grid grid-cols-12 gap-0.5 py-1 pl-0.5 pr-0.5 sm:gap-1 sm:pl-1 sm:pr-1">
                    <div className="col-span-3 flex min-h-[2.2rem] min-w-0 items-stretch">
                      <div className="flex min-h-[2.2rem] min-w-0 flex-1 items-center justify-center rounded-lg border border-slate-200/90 bg-slate-100 px-1 py-0.5 text-center text-xs font-semibold leading-tight text-slate-900 shadow-sm sm:text-sm">
                        <span className="line-clamp-2 w-full break-words">{p.name}</span>
                      </div>
                    </div>

                    <div className="col-span-6 flex min-h-[2.2rem] min-w-0 items-stretch">
                      <div className="grid min-h-[2.2rem] w-full min-w-0 grid-cols-2 gap-2">
                        {draft.otherFoods.map((food, idx) => (
                          <input
                            key={`${p.id}-other-food-${idx}`}
                            type="text"
                            value={food}
                            onChange={(e) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [p.id]: {
                                  ...draft,
                                  otherFoods: draft.otherFoods.map((item, i) =>
                                    i === idx ? e.target.value : item,
                                  ) as [string, string],
                                },
                              }))
                            }
                            onBlur={async () => {
                              const nextFood = joinOtherFoodsForSave(draft.otherFoods)
                              try {
                                await updateColleagueOtherStoreFields(p.id, {
                                  other_food: nextFood,
                                })
                                setDrafts((prev) => ({
                                  ...prev,
                                  [p.id]: {
                                    ...prev[p.id],
                                    otherFoods: otherFoodsForInputs(nextFood ?? ''),
                                  },
                                }))
                              } catch (e) {
                                console.error(e)
                              }
                            }}
                            placeholder={`餐點 ${idx + 1}`}
                            autoComplete="off"
                            className="min-h-[2.2rem] min-w-0 w-full rounded-lg border border-slate-200/90 bg-white px-2 py-0.5 text-xs leading-tight text-slate-900 outline-none ring-amber-400/30 focus:ring-2 sm:text-sm"
                          />
                        ))}
                      </div>
                    </div>

                    <div className="col-span-3 flex min-h-[2.2rem] min-w-0 items-stretch">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={draft.otherPrice}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [p.id]: { ...draft, otherPrice: e.target.value },
                          }))
                        }
                        onBlur={async () => {
                          const priceText = draft.otherPrice.trim()
                          const nextPrice =
                            priceText === ''
                              ? null
                              : Number.isFinite(Number(priceText))
                                ? Number(priceText)
                                : null
                          try {
                            await updateColleagueOtherStoreFields(p.id, {
                              other_price: nextPrice,
                            })
                            setDrafts((prev) => ({
                              ...prev,
                              [p.id]: {
                                ...prev[p.id],
                                otherPrice: nextPrice == null ? '' : String(nextPrice),
                              },
                            }))
                          } catch (e) {
                            console.error(e)
                          }
                        }}
                        placeholder="金額"
                        autoComplete="off"
                        className="min-h-[2.2rem] w-full rounded-lg border border-slate-200/90 bg-white px-2 py-0.5 text-right text-xs font-medium leading-tight text-slate-900 outline-none ring-amber-400/30 focus:ring-2 sm:text-sm"
                      />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>

          <div className="m-0 w-full border-t border-amber-200/80 bg-amber-50/30 px-4 py-4 sm:px-5">
            <h3 className="text-base font-bold text-amber-950 sm:text-lg">
              店家點餐彙整
            </h3>
            <p className="mt-2 select-all text-lg leading-relaxed text-black sm:text-xl">
              {summary.foodSummary}
            </p>
            <p className="mt-2 text-lg font-bold text-amber-950 sm:text-xl">
              總金額：$ {summary.totalPrice}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
