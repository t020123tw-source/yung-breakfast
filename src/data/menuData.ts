/**
 * 早餐菜單：由「類別」+「品項」組成，可於「菜單管理」分頁即時編輯。
 * - isDrink：飲料類（固定飲料選單、扣預算）
 * - isToast：吐司類（觸發「吐司不烤」自動備註）
 */

export type MenuCategoryDef = {
  id: string
  name: string
  /** 飲料類：出現在固定飲料、扣預算 */
  isDrink: boolean
  /** 吐司類：配合「吐司類一律不烤」加 (不烤) */
  isToast: boolean
}

export type MenuItem = {
  id: string
  name: string
  price: number
  categoryId: string
}

export const INITIAL_CATEGORIES: MenuCategoryDef[] = [
  { id: 'cat-drink', name: '飲料', isDrink: true, isToast: false },
  { id: 'cat-toast', name: '吐司', isDrink: false, isToast: true },
  { id: 'cat-burger', name: '漢堡', isDrink: false, isToast: false },
  { id: 'cat-omelet', name: '蛋餅', isDrink: false, isToast: false },
  { id: 'cat-thick', name: '厚片', isDrink: false, isToast: false },
  { id: 'cat-side', name: '小品', isDrink: false, isToast: false },
]

/** 預設菜單品項（與同事 mock 的 dislikedFoodIds 等 id 連動） */
export const INITIAL_MENU_ITEMS: MenuItem[] = [
  // 飲料
  {
    id: 'drink-iced-milk-tea-lg',
    name: '（大）冰奶茶',
    price: 30,
    categoryId: 'cat-drink',
  },
  {
    id: 'drink-fresh-milk-tea-lg-ns',
    name: '（大）鮮奶茶（無糖）',
    price: 45,
    categoryId: 'cat-drink',
  },
  {
    id: 'drink-soy-milk-ice',
    name: '冰豆漿',
    price: 25,
    categoryId: 'cat-drink',
  },
  {
    id: 'drink-americano',
    name: '美式咖啡',
    price: 50,
    categoryId: 'cat-drink',
  },
  // 吐司
  {
    id: 'toast-choco',
    name: '巧克力吐司',
    price: 20,
    categoryId: 'cat-toast',
  },
  {
    id: 'toast-bacon-egg',
    name: '培根蛋吐司',
    price: 40,
    categoryId: 'cat-toast',
  },
  {
    id: 'toast-bbq-rib',
    name: '烤肉排吐司',
    price: 45,
    categoryId: 'cat-toast',
  },
  {
    id: 'toast-tuna',
    name: '鮪魚吐司',
    price: 40,
    categoryId: 'cat-toast',
  },
  // 漢堡
  {
    id: 'food-crispy-chicken-burger',
    name: '咔啦雞腿堡',
    price: 65,
    categoryId: 'cat-burger',
  },
  // 蛋餅
  {
    id: 'food-plain-omelet',
    name: '原味蛋餅',
    price: 30,
    categoryId: 'cat-omelet',
  },
  {
    id: 'food-pepper-noodle-egg',
    name: '黑胡椒鐵板麵加蛋',
    price: 60,
    categoryId: 'cat-omelet',
  },
  // 厚片
  {
    id: 'thick-garlic',
    name: '香蒜厚片',
    price: 35,
    categoryId: 'cat-thick',
  },
  {
    id: 'thick-choco',
    name: '巧克力厚片',
    price: 30,
    categoryId: 'cat-thick',
  },
  // 小品
  {
    id: 'food-hash-tower',
    name: '薯餅塔',
    price: 45,
    categoryId: 'cat-side',
  },
  {
    id: 'food-turnip-cake',
    name: '蘿蔔糕',
    price: 30,
    categoryId: 'cat-side',
  },
  {
    id: 'food-hotdog-3',
    name: '熱狗 (3條)',
    price: 20,
    categoryId: 'cat-side',
  },
]

export function buildCategoryMap(
  categories: MenuCategoryDef[],
): Map<string, MenuCategoryDef> {
  return new Map(categories.map((c) => [c.id, c]))
}

/**
 * 類別顯示排序：所有飲料類 (isDrink) 固定排在最後，其餘維持原本相對順序。
 */
export function sortCategoriesForDisplay(
  categories: MenuCategoryDef[],
): MenuCategoryDef[] {
  const nonDrink = categories.filter((c) => !c.isDrink)
  const drink = categories.filter((c) => c.isDrink)
  return [...nonDrink, ...drink]
}

/**
 * 是否為「飲料」品項：所屬類別 `isDrink === true`（語意等同舊版 `category: 'drink'`）。
 * 請在菜單管理中將飲料類別勾為「飲料類」，以與轉盤／餐點邏輯分離。
 */
export function isDrinkItem(
  m: MenuItem,
  cm: Map<string, MenuCategoryDef>,
): boolean {
  return cm.get(m.categoryId)?.isDrink ?? false
}

/**
 * 「固定飲料」下拉選單資料：從即時 `menu` 篩選飲料品項，依名稱排序。
 */
export function getFixedDrinkSelectOptions(
  menu: MenuItem[],
  categoryMap: Map<string, MenuCategoryDef>,
): MenuItem[] {
  return [...menu]
    .filter((m) => isDrinkItem(m, categoryMap))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
}

/**
 * 轉盤候選名單（與飲料完全分離）：
 * 1. 排除所有飲料類品項
 * 2. 排除忌口 id
 * 3. 餐點價格 <= maxMealPrice（已扣該員固定飲料後之剩餘預算）
 */
export function filterItemsForWheel(
  menu: MenuItem[],
  categoryMap: Map<string, MenuCategoryDef>,
  dislikedIds: ReadonlySet<string>,
  maxMealPrice: number,
): MenuItem[] {
  return menu.filter(
    (m) =>
      !isDrinkItem(m, categoryMap) &&
      !dislikedIds.has(m.id) &&
      m.price <= maxMealPrice,
  )
}

export function isToastItem(
  m: MenuItem,
  cm: Map<string, MenuCategoryDef>,
): boolean {
  return cm.get(m.categoryId)?.isToast ?? false
}

/** 可列入轉盤／指定餐點／忌口（非飲料） */
export function isMealItem(
  m: MenuItem,
  cm: Map<string, MenuCategoryDef>,
): boolean {
  return !isDrinkItem(m, cm)
}

export function newCategoryId(): string {
  return `cat-${crypto.randomUUID().slice(0, 8)}`
}

export function newMenuItemId(): string {
  return `item-${crypto.randomUUID().slice(0, 10)}`
}
