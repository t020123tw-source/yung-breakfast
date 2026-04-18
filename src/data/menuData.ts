/**
 * 早餐菜單：品項以 `categoryId` 對應資料庫 `category` 字串（例如「飲料」「吐司」）。
 * 飲料與轉盤：一律以類別字串判斷，不使用額外 boolean。
 */

export type MenuCategoryDef = {
  id: string
  name: string
}

export type MenuItem = {
  id: string
  name: string
  price: number
  /** 與 Supabase menu_items.category 相同之類別名稱 */
  categoryId: string
}

export const INITIAL_CATEGORIES: MenuCategoryDef[] = [
  { id: '飲料', name: '飲料' },
  { id: '吐司', name: '吐司' },
  { id: '漢堡', name: '漢堡' },
  { id: '蛋餅', name: '蛋餅' },
  { id: '厚片', name: '厚片' },
  { id: '小品', name: '小品' },
]

/** 預設菜單品項 */
export const INITIAL_MENU_ITEMS: MenuItem[] = [
  {
    id: 'drink-iced-milk-tea-lg',
    name: '（大）冰奶茶',
    price: 30,
    categoryId: '飲料',
  },
  {
    id: 'drink-fresh-milk-tea-lg-ns',
    name: '（大）鮮奶茶（無糖）',
    price: 45,
    categoryId: '飲料',
  },
  {
    id: 'drink-soy-milk-ice',
    name: '冰豆漿',
    price: 25,
    categoryId: '飲料',
  },
  {
    id: 'drink-americano',
    name: '美式咖啡',
    price: 50,
    categoryId: '飲料',
  },
  {
    id: 'toast-choco',
    name: '巧克力吐司',
    price: 20,
    categoryId: '吐司',
  },
  {
    id: 'toast-bacon-egg',
    name: '培根蛋吐司',
    price: 40,
    categoryId: '吐司',
  },
  {
    id: 'toast-bbq-rib',
    name: '烤肉排吐司',
    price: 45,
    categoryId: '吐司',
  },
  {
    id: 'toast-tuna',
    name: '鮪魚吐司',
    price: 40,
    categoryId: '吐司',
  },
  {
    id: 'food-crispy-chicken-burger',
    name: '咔啦雞腿堡',
    price: 65,
    categoryId: '漢堡',
  },
  {
    id: 'food-plain-omelet',
    name: '原味蛋餅',
    price: 30,
    categoryId: '蛋餅',
  },
  {
    id: 'food-pepper-noodle-egg',
    name: '黑胡椒鐵板麵加蛋',
    price: 60,
    categoryId: '蛋餅',
  },
  {
    id: 'thick-garlic',
    name: '香蒜厚片',
    price: 35,
    categoryId: '厚片',
  },
  {
    id: 'thick-choco',
    name: '巧克力厚片',
    price: 30,
    categoryId: '厚片',
  },
  {
    id: 'food-hash-tower',
    name: '薯餅塔',
    price: 45,
    categoryId: '小品',
  },
  {
    id: 'food-turnip-cake',
    name: '蘿蔔糕',
    price: 30,
    categoryId: '小品',
  },
  {
    id: 'food-hotdog-3',
    name: '熱狗 (3條)',
    price: 20,
    categoryId: '小品',
  },
]

/**
 * 類別顯示排序：名稱為「飲料」的類別固定排在最後。
 */
export function sortCategoriesForDisplay(
  categories: MenuCategoryDef[],
): MenuCategoryDef[] {
  const nonDrink = categories.filter((c) => c.name !== '飲料')
  const drink = categories.filter((c) => c.name === '飲料')
  return [...nonDrink, ...drink]
}

/** 是否為飲料品項：類別字串必須完全等於「飲料」（不列入轉盤正餐、固定飲料選單） */
export function isDrinkItem(m: MenuItem): boolean {
  return m.categoryId === '飲料'
}

export function normalizeDrinkBaseName(name: string): string {
  return name.replace(/[[(（][大中小][)\]）]/g, '').trim()
}

export function compareMenuItemsForDisplay(a: MenuItem, b: MenuItem): number {
  const aDrink = isDrinkItem(a)
  const bDrink = isDrinkItem(b)
  if (aDrink && bDrink) {
    return (
      normalizeDrinkBaseName(a.name).localeCompare(
        normalizeDrinkBaseName(b.name),
        'zh-TW',
      ) ||
      a.price - b.price ||
      a.name.localeCompare(b.name, 'zh-TW')
    )
  }
  if (aDrink !== bDrink) return aDrink ? 1 : -1
  return a.price - b.price || a.name.localeCompare(b.name, 'zh-TW')
}

export function findMenuItemByLabelPrefix(
  label: string,
  menu: MenuItem[],
): MenuItem | undefined {
  const trimmed = label.trim()
  let matched: MenuItem | undefined
  for (const item of menu) {
    const exact =
      trimmed === item.name ||
      trimmed.startsWith(`${item.name}(`) ||
      trimmed.startsWith(`${item.name}（`)
    if (!exact) continue
    if (!matched || item.name.length > matched.name.length) {
      matched = item
    }
  }
  return matched
}

export function compareSummaryLabelsByMenu(
  a: string,
  b: string,
  menu: MenuItem[],
): number {
  const aItem = findMenuItemByLabelPrefix(a, menu)
  const bItem = findMenuItemByLabelPrefix(b, menu)
  if (aItem && bItem) {
    return compareMenuItemsForDisplay(aItem, bItem) || a.localeCompare(b, 'zh-TW')
  }
  if (aItem && !bItem) return -1
  if (!aItem && bItem) return 1
  return a.localeCompare(b, 'zh-TW')
}

export function getFixedDrinkSelectOptions(menu: MenuItem[]): MenuItem[] {
  return [...menu]
    .filter((m) => isDrinkItem(m))
    .sort(compareMenuItemsForDisplay)
}

/**
 * 轉盤候選：排除飲料類、忌口、超過預算。
 */
export function filterItemsForWheel(
  menu: MenuItem[],
  dislikedIds: ReadonlySet<string>,
  maxMealPrice: number,
): MenuItem[] {
  return menu
    .filter(
      (m) =>
        !isDrinkItem(m) && !dislikedIds.has(m.id) && m.price <= maxMealPrice,
    )
    .sort(compareMenuItemsForDisplay)
}

/** 吐司類：類別字串為「吐司」時觸發 (不烤) 顯示邏輯 */
export function isToastItem(m: MenuItem): boolean {
  return m.categoryId === '吐司'
}

/** 可列入轉盤／指定餐點／忌口（非飲料） */
export function isMealItem(m: MenuItem): boolean {
  return !isDrinkItem(m)
}

export function newMenuItemId(): string {
  return `item-${crypto.randomUUID().slice(0, 10)}`
}
