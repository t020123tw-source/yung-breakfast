/** 同事（不含個人預算；固定飲料可為 null＝無飲料） */
export type Personnel = {
  id: string
  /** 與 colleagues.order_index 對應；列表顯示順序（1, 2, 3…） */
  orderIndex: number
  name: string
  fixedDrinkId: string | null
  dislikedFoodIds: string[]
  /** 其他備註（僅內部查看；不顯示於同事列表與店家彙整） */
  extraRemark?: string
  /** 飲料備註：僅套用於飲料類品項與固定飲料 */
  drinkRemark?: string
  /** 固定餐點：一鍵淨空時保留早餐資料 */
  isFixedMeal?: boolean
  /** 勾選後，若餐點包含吐司，會自動在備註加入不烤 */
  isNotToasted?: boolean
  /** 休假：飲料／餐點格顯示紅底白叉圖示，不列入店家彙整 */
  isAbsent?: boolean
}

/** 今日訂單（每人一筆） */
export type Order = {
  userId: string
  selectedDrinkId: string | null
  /**
   * 對應 colleagues.current_food：手動與轉盤共用同一字串。
   * 多品項請以「 + 」串接（與 UI「＋」按鈕一致）；可為菜單 name 或舊資料之 uuid。
   */
  selectedFoodId: string | null
  /** 餐點備註（對外：顯示於同事列表與店家彙整） */
  foodRemark?: string
  /** 手動輸入且未對應菜單時的總金額 */
  manualFoodPrice?: number | null
}

/** 其他店家頁使用：手動輸入餐點與金額 */
export type OtherStoreEntry = {
  userId: string
  otherFood?: string
  otherPrice?: number | null
  otherPrice1?: number | null
  otherPrice2?: number | null
  otherIsOnLeave?: boolean
}
