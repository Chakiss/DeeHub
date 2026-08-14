/**
 * The expense categories a Thai hotel actually has (accounting-plan.md §4).
 *
 * Seeded per property on first use. An owner facing an empty category list
 * invents their own, and then no two months group the same way and the profit
 * and loss cannot be compared to itself. A list they edit is better than a
 * list they build.
 *
 * **The withholding rates here are suggestions with a legal basis, not law as
 * applied to a specific payment.** They follow the common cases under
 * ท.ป.4/2528 — rent 5%, hire of work and general services 3%, professional
 * fees 3%, advertising 2%, transport 1%, non-life insurance 1% — and every one
 * of them can be wrong for a particular supplier or contract. The rate stored
 * on the expense is what gets filed; this only decides what the form offers
 * before anyone touches it.
 *
 * Zero here means "usually nothing is withheld", which covers three different
 * situations worth keeping apart in your head: goods rather than services
 * (nothing is withheld on buying towels), payees outside the rules (state
 * utilities, banks, government fees), and payroll, where withholding is real
 * but progressive and filed on ภ.ง.ด.1 — a payroll system's job, and an
 * explicit non-goal in ADR-0008.
 */

export const EXPENSE_GROUPS = [
  'COGS',
  'PAYROLL',
  'UTILITIES',
  'OPERATIONS',
  'MARKETING',
  'ADMIN',
  'FINANCE',
  'TAX',
  'OTHER',
] as const;
export type ExpenseGroup = (typeof EXPENSE_GROUPS)[number];

/** The category of เงินได้พึงประเมิน a withholding certificate will cite. */
export const WHT_INCOME_TYPES = [
  /** มาตรา 40(2) — general hire of work, commission, brokerage. */
  'SERVICE_40_2',
  /** มาตรา 40(5) — rent. */
  'RENT_40_5',
  /** มาตรา 40(6) — the liberal professions: law, accountancy, medicine. */
  'PROFESSIONAL_40_6',
  /** มาตรา 40(7) — contract work where the contractor supplies materials. */
  'CONTRACT_40_7',
  /** มาตรา 40(8) — business, commerce, and everything else. */
  'OTHER_40_8',
] as const;
export type WhtIncomeType = (typeof WHT_INCOME_TYPES)[number];

export interface ExpenseCategorySeed {
  readonly code: string;
  readonly nameTh: string;
  readonly nameEn: string;
  readonly group: ExpenseGroup;
  readonly defaultWhtRateBp: number;
  readonly defaultWhtIncomeType: WhtIncomeType | null;
  /** False for real spending that does not reduce taxable profit. */
  readonly isDeductible: boolean;
}

const SERVICE = 300;
const RENT = 500;
const ADVERTISING = 200;
const TRANSPORT = 100;
const INSURANCE = 100;

/**
 * Ordered the way an owner thinks about their month, not alphabetically:
 * the bills that arrive every month first, then the ones that arrive when
 * something breaks, then the ones that arrive once a year.
 */
export const DEFAULT_EXPENSE_CATEGORIES: readonly ExpenseCategorySeed[] = [
  // Utilities — the recurring bills, and the reason the month-end check exists.
  {
    code: 'ELECTRICITY',
    nameTh: 'ค่าไฟฟ้า',
    nameEn: 'Electricity',
    group: 'UTILITIES',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },
  {
    code: 'WATER',
    nameTh: 'ค่าน้ำประปา',
    nameEn: 'Water',
    group: 'UTILITIES',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },
  {
    code: 'INTERNET',
    nameTh: 'ค่าอินเทอร์เน็ตและโทรศัพท์',
    nameEn: 'Internet and telephone',
    group: 'UTILITIES',
    defaultWhtRateBp: SERVICE,
    defaultWhtIncomeType: 'OTHER_40_8',
    isDeductible: true,
  },
  {
    code: 'FUEL',
    nameTh: 'ค่าแก๊สและเชื้อเพลิง',
    nameEn: 'Gas and fuel',
    group: 'UTILITIES',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },

  // Payroll — recorded here, but the withholding is ภ.ง.ด.1 and not ours.
  {
    code: 'SALARY',
    nameTh: 'เงินเดือนและค่าจ้าง',
    nameEn: 'Salaries and wages',
    group: 'PAYROLL',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },
  {
    code: 'SOCIAL_SECURITY',
    nameTh: 'เงินสมทบประกันสังคม',
    nameEn: 'Social security contributions',
    group: 'PAYROLL',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },
  {
    code: 'STAFF_WELFARE',
    nameTh: 'สวัสดิการพนักงาน',
    nameEn: 'Staff welfare',
    group: 'PAYROLL',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },

  // Cost of sales — goods, so nothing is withheld.
  {
    code: 'FNB_COST',
    nameTh: 'ต้นทุนอาหารและเครื่องดื่ม',
    nameEn: 'Food and beverage cost',
    group: 'COGS',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },
  {
    code: 'AMENITIES',
    nameTh: 'ของใช้ในห้องพัก',
    nameEn: 'Guest amenities',
    group: 'COGS',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },
  {
    code: 'LINEN',
    nameTh: 'ผ้าและเครื่องนอน',
    nameEn: 'Linen and bedding',
    group: 'COGS',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },

  // Running the place.
  {
    code: 'LAUNDRY',
    nameTh: 'ค่าซักรีด',
    nameEn: 'Laundry',
    group: 'OPERATIONS',
    defaultWhtRateBp: SERVICE,
    defaultWhtIncomeType: 'OTHER_40_8',
    isDeductible: true,
  },
  {
    code: 'CLEANING',
    nameTh: 'ค่าทำความสะอาด',
    nameEn: 'Cleaning services',
    group: 'OPERATIONS',
    defaultWhtRateBp: SERVICE,
    defaultWhtIncomeType: 'OTHER_40_8',
    isDeductible: true,
  },
  {
    code: 'MAINTENANCE',
    nameTh: 'ค่าซ่อมแซมและบำรุงรักษา',
    nameEn: 'Repairs and maintenance',
    group: 'OPERATIONS',
    defaultWhtRateBp: SERVICE,
    defaultWhtIncomeType: 'CONTRACT_40_7',
    isDeductible: true,
  },
  {
    code: 'PEST_CONTROL',
    nameTh: 'ค่ากำจัดแมลงและปลวก',
    nameEn: 'Pest control',
    group: 'OPERATIONS',
    defaultWhtRateBp: SERVICE,
    defaultWhtIncomeType: 'OTHER_40_8',
    isDeductible: true,
  },
  {
    code: 'POOL_GARDEN',
    nameTh: 'ค่าดูแลสระว่ายน้ำและสวน',
    nameEn: 'Pool and garden care',
    group: 'OPERATIONS',
    defaultWhtRateBp: SERVICE,
    defaultWhtIncomeType: 'OTHER_40_8',
    isDeductible: true,
  },
  {
    code: 'SECURITY',
    nameTh: 'ค่ารักษาความปลอดภัย',
    nameEn: 'Security',
    group: 'OPERATIONS',
    defaultWhtRateBp: SERVICE,
    defaultWhtIncomeType: 'OTHER_40_8',
    isDeductible: true,
  },
  {
    code: 'WASTE',
    nameTh: 'ค่าเก็บขยะ',
    nameEn: 'Waste collection',
    group: 'OPERATIONS',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },
  {
    code: 'TRANSPORT',
    nameTh: 'ค่าขนส่ง',
    nameEn: 'Transport',
    group: 'OPERATIONS',
    defaultWhtRateBp: TRANSPORT,
    defaultWhtIncomeType: 'OTHER_40_8',
    isDeductible: true,
  },

  // Selling the rooms.
  {
    code: 'OTA_COMMISSION',
    nameTh: 'ค่าคอมมิชชั่นตัวแทนขาย (OTA)',
    nameEn: 'OTA commission',
    group: 'MARKETING',
    defaultWhtRateBp: SERVICE,
    defaultWhtIncomeType: 'SERVICE_40_2',
    isDeductible: true,
  },
  {
    code: 'ADVERTISING',
    nameTh: 'ค่าโฆษณา',
    nameEn: 'Advertising',
    group: 'MARKETING',
    defaultWhtRateBp: ADVERTISING,
    defaultWhtIncomeType: 'OTHER_40_8',
    isDeductible: true,
  },
  {
    code: 'WEBSITE',
    nameTh: 'ค่าเว็บไซต์และซอฟต์แวร์',
    nameEn: 'Website and software',
    group: 'MARKETING',
    defaultWhtRateBp: SERVICE,
    defaultWhtIncomeType: 'OTHER_40_8',
    isDeductible: true,
  },

  // Keeping the business a business.
  {
    code: 'RENT',
    nameTh: 'ค่าเช่าที่ดินและอาคาร',
    nameEn: 'Land and building rent',
    group: 'ADMIN',
    defaultWhtRateBp: RENT,
    defaultWhtIncomeType: 'RENT_40_5',
    isDeductible: true,
  },
  {
    code: 'ACCOUNTING',
    nameTh: 'ค่าทำบัญชีและสอบบัญชี',
    nameEn: 'Accounting and audit fees',
    group: 'ADMIN',
    defaultWhtRateBp: SERVICE,
    defaultWhtIncomeType: 'PROFESSIONAL_40_6',
    isDeductible: true,
  },
  {
    code: 'LEGAL',
    nameTh: 'ค่าที่ปรึกษากฎหมาย',
    nameEn: 'Legal fees',
    group: 'ADMIN',
    defaultWhtRateBp: SERVICE,
    defaultWhtIncomeType: 'PROFESSIONAL_40_6',
    isDeductible: true,
  },
  {
    code: 'INSURANCE',
    nameTh: 'ค่าเบี้ยประกันภัย',
    nameEn: 'Insurance premiums',
    group: 'ADMIN',
    defaultWhtRateBp: INSURANCE,
    defaultWhtIncomeType: 'OTHER_40_8',
    isDeductible: true,
  },
  {
    code: 'LICENSE',
    nameTh: 'ค่าธรรมเนียมและใบอนุญาต',
    nameEn: 'Licences and government fees',
    group: 'ADMIN',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },
  {
    code: 'OFFICE',
    nameTh: 'ค่าเครื่องเขียนและอุปกรณ์สำนักงาน',
    nameEn: 'Office supplies',
    group: 'ADMIN',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },

  // The cost of handling money.
  {
    code: 'BANK_FEE',
    nameTh: 'ค่าธรรมเนียมธนาคาร',
    nameEn: 'Bank charges',
    group: 'FINANCE',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },
  {
    code: 'CARD_FEE',
    nameTh: 'ค่าธรรมเนียมบัตรเครดิต',
    nameEn: 'Card processing fees',
    group: 'FINANCE',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },
  {
    code: 'INTEREST',
    nameTh: 'ดอกเบี้ยจ่าย',
    nameEn: 'Interest expense',
    group: 'FINANCE',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },

  {
    code: 'PROPERTY_TAX',
    nameTh: 'ภาษีที่ดินและสิ่งปลูกสร้าง',
    nameEn: 'Land and building tax',
    group: 'TAX',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },
  {
    code: 'SIGNBOARD_TAX',
    nameTh: 'ภาษีป้าย',
    nameEn: 'Signboard tax',
    group: 'TAX',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },

  {
    code: 'MISC',
    nameTh: 'ค่าใช้จ่ายเบ็ดเตล็ด',
    nameEn: 'Miscellaneous',
    group: 'OTHER',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: true,
  },
  /*
   * Money the owner takes out of the business.
   *
   * Not deductible, and not an expense at all in a strict sense — but owners of
   * small hotels take cash from the till, and a category that records it is the
   * difference between a profit figure that reconciles to the bank and one that
   * is quietly short every month with no explanation.
   */
  {
    code: 'OWNER_DRAW',
    nameTh: 'เงินถอนของเจ้าของ',
    nameEn: "Owner's drawings",
    group: 'OTHER',
    defaultWhtRateBp: 0,
    defaultWhtIncomeType: null,
    isDeductible: false,
  },
];

/** Order the profit and loss prints its expense sections in. */
export const EXPENSE_GROUP_ORDER: readonly ExpenseGroup[] = [
  'COGS',
  'PAYROLL',
  'UTILITIES',
  'OPERATIONS',
  'MARKETING',
  'ADMIN',
  'FINANCE',
  'TAX',
  'OTHER',
];
