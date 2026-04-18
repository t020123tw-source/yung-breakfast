import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type MenuItem,
  compareSummaryLabelsByMenu,
  isDrinkItem,
} from '../data/menuData'
import type { OtherStoreEntry, Personnel } from '../domain/breakfastTypes'
import { updateColleagueOtherStoreFields } from '../lib/colleagueSupabase'

export type OtherStorePanelProps = {
  menu: MenuItem[]
  initialPersonnel: Personnel[]
  initialEntries: OtherStoreEntry[]
}

type EntryDraft = {
  otherFoods: [string, string]
  otherPrice1: string
  otherPrice2: string
  otherIsOnLeave: boolean
}

function normalizeFoodCellText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim()
}

function splitOtherStoreSlots(raw: unknown): [string, string] {
  if (typeof raw !== 'string' || raw === '') return ['', '']
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
  return [slots[0] ?? '', slots[1] ?? '']
}

function otherFoodsForInputs(raw: unknown): [string, string] {
  return splitOtherStoreSlots(raw)
}

function joinOtherFoodsForSave(parts: [string, string]): string {
  const [food1, food2] = parts.map((item) => normalizeFoodCellText(item)) as [string, string]
  if (food1 === '' && food2 === '') return ''
  return `${food1} + ${food2}`
}

function appendRemark(label: string, remark: string | null | undefined): string {
  const text = (remark ?? '').trim()
  if (!text) return label
  return `${label}(${text})`
}

function formatOtherStoreFoodLabel(
  rawLabel: string,
  person: Personnel | undefined,
  menuByName: Map<string, MenuItem>,
): string {
  const label = rawLabel.trim()
  if (!label) return ''
  const menuItem = menuByName.get(label)
  if (menuItem && isDrinkItem(menuItem)) {
    return appendRemark(label, person?.drinkRemark)
  }
  return label
}

function normalizeOtherStorePriceText(raw: unknown): string {
  if (raw == null) return ''
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return ''
  return String(Math.round(n))
}

function parseOtherStorePriceText(raw: string): number {
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n)
}

function computeOtherStoreTotal(price1: string, price2: string): number {
  return (Number(price1) || 0) + (Number(price2) || 0)
}

function formatOneSlotSummary(slotMap: Map<string, number>, menu: MenuItem[]): string[] {
  return [...slotMap.entries()]
    .sort(([a], [b]) => compareSummaryLabelsByMenu(a, b, menu))
    .map(([food, count]) => `${food} x ${count}`)
}

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
          otherPrice1: normalizeOtherStorePriceText(entry?.otherPrice1),
          otherPrice2: normalizeOtherStorePriceText(entry?.otherPrice2),
          otherIsOnLeave: entry?.otherIsOnLeave ?? false,
        },
      ]
    }),
  )
}

export function OtherStorePanel({
  menu,
  initialPersonnel,
  initialEntries,
}: OtherStorePanelProps) {
  const [personnel, setPersonnel] = useState<Personnel[]>(initialPersonnel)
  const [drafts, setDrafts] = useState<Record<string, EntryDraft>>(() =>
    normalizeDraftMap(initialPersonnel, initialEntries),
  )
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const menuByName = useMemo(
    () => new Map(menu.map((item) => [item.name, item])),
    [menu],
  )

  useEffect(() => {
    setPersonnel(initialPersonnel)
    setDrafts(normalizeDraftMap(initialPersonnel, initialEntries))
  }, [initialPersonnel, initialEntries])

  useEffect(() => {
    return () => {
      for (const timer of Object.values(saveTimersRef.current)) {
        clearTimeout(timer)
      }
    }
  }, [])

  const persistDraft = useCallback(async (userId: string, draft: EntryDraft) => {
    try {
      const total = computeOtherStoreTotal(draft.otherPrice1, draft.otherPrice2)
      await updateColleagueOtherStoreFields(userId, {
        other_food: joinOtherFoodsForSave(draft.otherFoods),
        other_price: total,
        other_price_1: parseOtherStorePriceText(draft.otherPrice1),
        other_price_2: parseOtherStorePriceText(draft.otherPrice2),
        other_is_on_leave: draft.otherIsOnLeave,
      })
    } catch (e) {
      console.error(e)
    }
  }, [])

  const schedulePersistDraft = useCallback(
    (userId: string, draft: EntryDraft, ms = 520) => {
      const existing = saveTimersRef.current[userId]
      if (existing) clearTimeout(existing)
      saveTimersRef.current[userId] = setTimeout(() => {
        delete saveTimersRef.current[userId]
        void persistDraft(userId, draft)
      }, ms)
    },
    [persistDraft],
  )

  const flushPersistDraft = useCallback(
    async (userId: string, draft: EntryDraft) => {
      const existing = saveTimersRef.current[userId]
      if (existing) {
        clearTimeout(existing)
        delete saveTimersRef.current[userId]
      }
      await persistDraft(userId, draft)
    },
    [persistDraft],
  )

  const clearPendingSaves = useCallback(() => {
    for (const timer of Object.values(saveTimersRef.current)) {
      clearTimeout(timer)
    }
    saveTimersRef.current = {}
  }, [])

  const togglePersonAbsent = useCallback(async (userId: string) => {
    const current = drafts[userId]
    if (!current) return
    const nextDraft = { ...current, otherIsOnLeave: !current.otherIsOnLeave }
    setDrafts((prev) => ({ ...prev, [userId]: nextDraft }))
    await flushPersistDraft(userId, nextDraft)
  }, [drafts, flushPersistDraft])

  const clearAllOtherStoreFields = useCallback(async () => {
    clearPendingSaves()
    const nextDrafts = Object.fromEntries(
      personnel.map((p) => [
        p.id,
        {
          ...(drafts[p.id] ?? {
            otherFoods: ['', ''] as [string, string],
            otherPrice1: '',
            otherPrice2: '',
            otherIsOnLeave: false,
          }),
          otherFoods: [
            menuByName.has(drafts[p.id]?.otherFoods?.[0]?.trim() ?? '')
              ? ''
              : drafts[p.id]?.otherFoods?.[0] ?? '',
            menuByName.has(drafts[p.id]?.otherFoods?.[1]?.trim() ?? '')
              ? ''
              : drafts[p.id]?.otherFoods?.[1] ?? '',
          ],
          otherPrice1: menuByName.has(drafts[p.id]?.otherFoods?.[0]?.trim() ?? '')
            ? ''
            : drafts[p.id]?.otherPrice1 ?? '',
          otherPrice2: menuByName.has(drafts[p.id]?.otherFoods?.[1]?.trim() ?? '')
            ? ''
            : drafts[p.id]?.otherPrice2 ?? '',
        },
      ]),
    ) as Record<string, EntryDraft>
    setDrafts(nextDrafts)
    try {
      await Promise.all(
        personnel.map((p) =>
          updateColleagueOtherStoreFields(p.id, {
            other_food: joinOtherFoodsForSave(nextDrafts[p.id]?.otherFoods ?? ['', '']),
            other_price: computeOtherStoreTotal(
              nextDrafts[p.id]?.otherPrice1 ?? '',
              nextDrafts[p.id]?.otherPrice2 ?? '',
            ),
            other_price_1: parseOtherStorePriceText(nextDrafts[p.id]?.otherPrice1 ?? ''),
            other_price_2: parseOtherStorePriceText(nextDrafts[p.id]?.otherPrice2 ?? ''),
          }),
        ),
      )
    } catch (e) {
      console.error(e)
    }
  }, [clearPendingSaves, drafts, personnel, menuByName])

  const summary = useMemo(() => {
    const slot1Map = new Map<string, number>()
    const slot2Map = new Map<string, number>()
    let totalPrice = 0
    for (const p of personnel) {
      const draft = drafts[p.id]
      if (draft?.otherIsOnLeave) continue
      const [slot1, slot2] = draft?.otherFoods ?? ['', '']
      const food1 = formatOtherStoreFoodLabel(slot1, p, menuByName)
      const food2 = formatOtherStoreFoodLabel(slot2, p, menuByName)
      if (food1) slot1Map.set(food1, (slot1Map.get(food1) ?? 0) + 1)
      if (food2) slot2Map.set(food2, (slot2Map.get(food2) ?? 0) + 1)
      totalPrice += computeOtherStoreTotal(
        draft?.otherPrice1 ?? '',
        draft?.otherPrice2 ?? '',
      )
    }
    const foodSummaryLines = [
      ...formatOneSlotSummary(slot1Map, menu),
      ...formatOneSlotSummary(slot2Map, menu),
    ]
    return { foodSummaryLines, totalPrice }
  }, [personnel, drafts, menuByName, menu])

  return (
    <div className="w-full text-slate-900">
      <div className="flex w-full max-w-none flex-col px-4 py-4 sm:px-5 lg:px-6 lg:py-5">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl border border-amber-200/70 bg-white/90 shadow-sm">
          <div className="border-b border-amber-100 px-3 py-3 sm:px-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-amber-950">其他店家</h2>
                <p className="mt-1 text-xs text-amber-800/60">
                  緊湊模式清單；輸入時自動儲存，失焦時立即寫回 Supabase。
                </p>
              </div>
              <button
                type="button"
                onClick={() => void clearAllOtherStoreFields()}
                className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 px-2.5 text-[11px] font-semibold text-rose-800 hover:bg-rose-100 sm:px-3 sm:text-xs"
              >
                一鍵淨空
              </button>
            </div>
          </div>

          <ul className="h-auto flex-1 px-1 pb-0 pt-1 sm:px-2">
            {personnel.length === 0 ? (
              <li className="list-none px-3 py-8 text-center text-sm text-amber-800/80">
                目前尚無同事資料。
              </li>
            ) : null}
            {personnel.map((p) => {
              const draft = drafts[p.id] ?? {
                otherFoods: ['', ''] as [string, string],
                otherPrice1: '',
                otherPrice2: '',
                otherIsOnLeave: false,
              }
              const totalPriceText = (() => {
                const total = computeOtherStoreTotal(draft.otherPrice1, draft.otherPrice2)
                return total > 0 ? String(total) : ''
              })()
              return (
                <li key={p.id} className="border-b border-amber-100/80 last:border-b-0">
                  <div className="flex items-center gap-2 py-1 pl-0.5 pr-0.5 sm:gap-2.5 sm:pl-1 sm:pr-1">
                    <div className="flex w-24 shrink-0 min-h-[2.2rem] min-w-0 items-stretch">
                      <button
                        type="button"
                        onDoubleClick={() => void togglePersonAbsent(p.id)}
                        title={`${p.name}（雙擊切換休假）`}
                        className={`flex min-h-[2.2rem] min-w-0 flex-1 items-center justify-center rounded-lg border px-1.5 py-0.5 text-center text-xs font-semibold leading-tight shadow-sm sm:text-sm ${
                          draft.otherIsOnLeave
                            ? 'border-slate-200/90 bg-slate-100 text-slate-500 opacity-60'
                            : 'border-slate-200/90 bg-slate-100 text-slate-900'
                        }`}
                      >
                        <span className="truncate">{p.name}</span>
                      </button>
                    </div>

                    <div className="flex min-h-[2.2rem] min-w-0 flex-1 items-center gap-2">
                      {draft.otherIsOnLeave ? (
                        <>
                          <div className="flex min-h-[2.2rem] min-w-0 flex-1 items-center justify-center rounded-lg border border-slate-200/90 bg-slate-100">
                            <AbsentSlotIcon />
                          </div>
                          <div className="flex w-20 shrink-0 items-center justify-center rounded-lg border border-slate-200/90 bg-slate-100">
                            <AbsentSlotIcon />
                          </div>
                          <div className="flex min-h-[2.2rem] min-w-0 flex-1 items-center justify-center rounded-lg border border-slate-200/90 bg-slate-100">
                            <AbsentSlotIcon />
                          </div>
                          <div className="flex w-20 shrink-0 items-center justify-center rounded-lg border border-slate-200/90 bg-slate-100">
                            <AbsentSlotIcon />
                          </div>
                        </>
                      ) : (
                        <>
                          <input
                            type="text"
                            value={draft.otherFoods[0]}
                            onChange={(e) => {
                              const nextDraft = {
                                ...draft,
                                otherFoods: draft.otherFoods.map((item, i) =>
                                  i === 0 ? e.target.value : item,
                                ) as [string, string],
                              }
                              setDrafts((prev) => ({
                                ...prev,
                                [p.id]: nextDraft,
                              }))
                              if (!nextDraft.otherIsOnLeave) {
                                schedulePersistDraft(p.id, nextDraft)
                              }
                            }}
                            onBlur={async () => {
                              if (draft.otherIsOnLeave) return
                              const nextFood = joinOtherFoodsForSave(draft.otherFoods)
                              const normalizedFoods = otherFoodsForInputs(nextFood)
                              const nextDraft = {
                                ...draft,
                                otherFoods: normalizedFoods,
                              }
                              try {
                                setDrafts((prev) => ({ ...prev, [p.id]: nextDraft }))
                                await flushPersistDraft(p.id, nextDraft)
                                setDrafts((prev) => ({
                                  ...prev,
                                  [p.id]: nextDraft,
                                }))
                              } catch (e) {
                                console.error(e)
                              }
                            }}
                            placeholder="餐點 1"
                            autoComplete="off"
                            disabled={!!draft.otherIsOnLeave}
                            className="min-h-[2.2rem] min-w-0 w-full flex-1 rounded-lg border border-slate-200/90 bg-white px-2 py-0.5 text-xs leading-tight text-slate-900 outline-none ring-amber-400/30 focus:ring-2 sm:text-sm"
                          />
                          <input
                            type="text"
                            inputMode="numeric"
                            value={draft.otherPrice1}
                            onChange={(e) => {
                              const nextValue = e.target.value.replace(/[^\d]/g, '')
                              const nextDraft = {
                                ...draft,
                                otherPrice1: nextValue,
                              }
                              setDrafts((prev) => ({
                                ...prev,
                                [p.id]: nextDraft,
                              }))
                              if (!nextDraft.otherIsOnLeave) {
                                schedulePersistDraft(p.id, nextDraft)
                              }
                            }}
                            onBlur={async () => {
                              if (draft.otherIsOnLeave) return
                              const nextValue = normalizeOtherStorePriceText(draft.otherPrice1)
                              const nextDraft = {
                                ...draft,
                                otherPrice1: nextValue,
                              }
                              try {
                                setDrafts((prev) => ({ ...prev, [p.id]: nextDraft }))
                                await flushPersistDraft(p.id, nextDraft)
                                setDrafts((prev) => ({
                                  ...prev,
                                  [p.id]: nextDraft,
                                }))
                              } catch (e) {
                                console.error(e)
                              }
                            }}
                            placeholder="金額"
                            autoComplete="off"
                            disabled={!!draft.otherIsOnLeave}
                            className="min-h-[2.2rem] w-20 shrink-0 rounded-lg border border-slate-200/90 bg-white px-2 py-0.5 text-right text-xs font-medium leading-tight text-slate-900 outline-none ring-amber-400/30 focus:ring-2 sm:text-sm"
                          />
                          <input
                            type="text"
                            value={draft.otherFoods[1]}
                            onChange={(e) => {
                              const nextDraft = {
                                ...draft,
                                otherFoods: draft.otherFoods.map((item, i) =>
                                  i === 1 ? e.target.value : item,
                                ) as [string, string],
                              }
                              setDrafts((prev) => ({
                                ...prev,
                                [p.id]: nextDraft,
                              }))
                              if (!nextDraft.otherIsOnLeave) {
                                schedulePersistDraft(p.id, nextDraft)
                              }
                            }}
                            onBlur={async () => {
                              if (draft.otherIsOnLeave) return
                              const nextFood = joinOtherFoodsForSave(draft.otherFoods)
                              const normalizedFoods = otherFoodsForInputs(nextFood)
                              const nextDraft = {
                                ...draft,
                                otherFoods: normalizedFoods,
                              }
                              try {
                                setDrafts((prev) => ({ ...prev, [p.id]: nextDraft }))
                                await flushPersistDraft(p.id, nextDraft)
                                setDrafts((prev) => ({
                                  ...prev,
                                  [p.id]: nextDraft,
                                }))
                              } catch (e) {
                                console.error(e)
                              }
                            }}
                            placeholder="餐點 2"
                            autoComplete="off"
                            disabled={!!draft.otherIsOnLeave}
                            className="min-h-[2.2rem] min-w-0 w-full flex-1 rounded-lg border border-slate-200/90 bg-white px-2 py-0.5 text-xs leading-tight text-slate-900 outline-none ring-amber-400/30 focus:ring-2 sm:text-sm"
                          />
                          <input
                            type="text"
                            inputMode="numeric"
                            value={draft.otherPrice2}
                            onChange={(e) => {
                              const nextValue = e.target.value.replace(/[^\d]/g, '')
                              const nextDraft = {
                                ...draft,
                                otherPrice2: nextValue,
                              }
                              setDrafts((prev) => ({
                                ...prev,
                                [p.id]: nextDraft,
                              }))
                              if (!nextDraft.otherIsOnLeave) {
                                schedulePersistDraft(p.id, nextDraft)
                              }
                            }}
                            onBlur={async () => {
                              if (draft.otherIsOnLeave) return
                              const nextValue = normalizeOtherStorePriceText(draft.otherPrice2)
                              const nextDraft = {
                                ...draft,
                                otherPrice2: nextValue,
                              }
                              try {
                                setDrafts((prev) => ({ ...prev, [p.id]: nextDraft }))
                                await flushPersistDraft(p.id, nextDraft)
                                setDrafts((prev) => ({
                                  ...prev,
                                  [p.id]: nextDraft,
                                }))
                              } catch (e) {
                                console.error(e)
                              }
                            }}
                            placeholder="金額"
                            autoComplete="off"
                            disabled={!!draft.otherIsOnLeave}
                            className="min-h-[2.2rem] w-20 shrink-0 rounded-lg border border-slate-200/90 bg-white px-2 py-0.5 text-right text-xs font-medium leading-tight text-slate-900 outline-none ring-amber-400/30 focus:ring-2 sm:text-sm"
                          />
                        </>
                      )}
                    </div>

                    <div className="flex w-20 shrink-0 min-h-[2.2rem] min-w-0 items-stretch">
                      {draft.otherIsOnLeave ? (
                        <div className="flex min-h-[2.2rem] w-full items-center justify-center rounded-lg border border-slate-200/90 bg-slate-100">
                          <AbsentSlotIcon />
                        </div>
                      ) : (
                        <input
                          type="text"
                          readOnly
                          value={totalPriceText}
                          placeholder="總額"
                          autoComplete="off"
                          disabled={!!draft.otherIsOnLeave}
                          className="min-h-[2.2rem] w-full rounded-lg border border-slate-200/90 bg-slate-50 px-2 py-0.5 text-right text-xs font-medium leading-tight text-slate-900 outline-none sm:text-sm"
                        />
                      )}
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
            <div className="mt-2 select-all text-lg leading-relaxed text-black sm:text-xl">
              {summary.foodSummaryLines.length > 0 ? (
                summary.foodSummaryLines.map((line) => (
                  <div key={line}>{line}</div>
                ))
              ) : (
                <div>（尚無品項）</div>
              )}
            </div>
            <p className="mt-2 text-lg font-bold text-amber-950 sm:text-xl">
              總金額：$ {summary.totalPrice}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
