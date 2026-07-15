/**
 * Rendo v1.0 — ฟังก์ชันคำนวณกลาง
 * จำนวนเงินทั้งหมดเก็บเป็น integer cents (สตางค์) เพื่อหลีกเลี่ยง floating point error
 */

export const ROLE = Object.freeze({
  OWNER: 'owner',
  MANAGER: 'manager',
  SUPERVISOR: 'supervisor',
  FRONT_KITCHEN: 'front_kitchen',
  BACK_KITCHEN: 'back_kitchen',
  FRONT_STAFF: 'front_staff',
  ROTATING_STAFF: 'rotating_staff',
  DAILY: 'daily'
});

export const ROLE_LABELS = Object.freeze({
  owner: 'เจ้าของ',
  manager: 'ผู้จัดการ',
  supervisor: 'หัวหน้า',
  front_kitchen: 'ครัวหน้าร้าน',
  back_kitchen: 'ครัวหลังบ้าน',
  front_staff: 'พนักงานหน้าร้าน',
  rotating_staff: 'พนักงานเวียน',
  daily: 'รายวัน'
});

export const DEFAULT_SETTINGS = Object.freeze({
  storeName: 'Rendo',
  fullStoreName: 'RENDO – RAMEN & GYOZA',
  primaryColor: '#b88746',
  secondaryColor: '#1f1b16',
  backgroundColor: '#fffaf1',
  fontScale: 1,
  grossMarginRate: 0.40,
  requirePaymentMismatchNote: true,
  rotatingBonusRendoOnly: true,
  otRateCents: 6000,
  outsideOtRateCents: 6000,
  dailyFullDayRateCents: 50000,
  dailyHourlyRateCents: 6000,
  dailyBonusKitchenThresholdCents: 1000000,
  dailyBonusKitchenAmountCents: 10000,
  dailyBonusFrontThresholdCents: 1000000,
  dailyBonusFrontAmountCents: 10000,
  beerRateCents: 500,
  monthlyBonusKitchenThresholdCents: 10000000,
  monthlyBonusKitchenAmountCents: 100000,
  monthlyBonusFrontThresholdCents: 10000000,
  monthlyBonusFrontAmountCents: 100000,
  socialSecurityEmployeeRate: 0.05,
  socialSecurityEmployerRate: 0.05,
  socialSecurityWageCeilingCents: 1500000,
  menuOrder: ['dashboard','attendance','sales','monthly','advances','compensation','expenses','audit','users','backup','settings','change-pin']
});

export function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function fromCents(cents) {
  const n = Number(cents || 0);
  return Number.isFinite(n) ? n / 100 : 0;
}

export function money(cents) {
  return new Intl.NumberFormat('th-TH', {
    style: 'currency', currency: 'THB', minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(fromCents(cents));
}

export function sumCents(values) {
  return values.reduce((sum, value) => sum + Math.round(Number(value || 0)), 0);
}

export function clampRate(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

export function calculateSales({ foodCents = 0, beverageCents = 0, discountCents = 0, cashCents = 0, transferCents = 0 }) {
  const grossSalesCents = sumCents([foodCents, beverageCents]);
  const revenueCents = Math.max(0, grossSalesCents - Math.max(0, discountCents));
  const paymentTotalCents = sumCents([cashCents, transferCents]);
  return {
    grossSalesCents,
    revenueCents,
    paymentTotalCents,
    paymentDifferenceCents: paymentTotalCents - revenueCents
  };
}

export function calculateCashEquation({ openingCashCents = 0, cashSalesCents = 0, shiftExpenses = [], cashToOwnerCents = 0, closingCashCents = 0 }) {
  const cashExpenseCents = shiftExpenses
    .filter((item) => !item.ownerPaid)
    .reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.amountCents || 0))), 0);
  const expectedClosingCents = openingCashCents + cashSalesCents - cashExpenseCents - cashToOwnerCents;
  const differenceCents = closingCashCents - expectedClosingCents;
  return {
    cashExpenseCents,
    expectedClosingCents,
    differenceCents,
    status: differenceCents === 0 ? 'balanced' : differenceCents < 0 ? 'short' : 'over'
  };
}

export function calculateHours(startMinutes, endMinutes) {
  const start = Number(startMinutes);
  const end = Number(endMinutes);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return 0;
  return (end - start) / 60;
}

export function monthKeyFromDate(date) {
  return String(date || '').slice(0, 7);
}

export function monthOrdinalFromDate(date) {
  const [year, month] = String(date || '').slice(0, 7).split('-').map(Number);
  return Number.isInteger(year) && Number.isInteger(month) ? year * 12 + month : 0;
}

export function allocateCents(totalCents, ids) {
  const ordered = [...new Set(ids)].sort();
  const result = Object.fromEntries(ordered.map((id) => [id, 0]));
  if (!ordered.length || totalCents <= 0) return result;
  const base = Math.floor(totalCents / ordered.length);
  let remainder = totalCents - base * ordered.length;
  for (const id of ordered) {
    result[id] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return result;
}

function isFullDay(attendance) {
  return attendance?.status === 'full_day';
}

function rotatingIsRendo(attendance, settings) {
  if (attendance?.role !== ROLE.ROTATING_STAFF) return true;
  return !settings.rotatingBonusRendoOnly || attendance.workLocation === 'Rendo';
}

function eligibleForBeer(attendance, settings) {
  if (!isFullDay(attendance)) return false;
  if (![ROLE.FRONT_STAFF, ROLE.ROTATING_STAFF, ROLE.DAILY].includes(attendance.role)) return false;
  return rotatingIsRendo(attendance, settings);
}

function eligibleForDailyBonus(attendance, settings) {
  if (!isFullDay(attendance)) return false;
  if (attendance.role === ROLE.ROTATING_STAFF) return rotatingIsRendo(attendance, settings);
  return [ROLE.FRONT_KITCHEN, ROLE.BACK_KITCHEN, ROLE.FRONT_STAFF].includes(attendance.role);
}

export function calculateBeerAllocation({ sales = [], attendance = [], settings = DEFAULT_SETTINGS }) {
  const attendanceByDate = new Map();
  for (const row of attendance) {
    if (!attendanceByDate.has(row.date)) attendanceByDate.set(row.date, []);
    attendanceByDate.get(row.date).push(row);
  }
  const byUser = {};
  const details = [];
  for (const sale of sales) {
    if (sale.status !== 'final' || sale.storeStatus !== 'open') continue;
    const beerBottles = Math.max(0, Math.floor(Number(sale.beerBottles || 0)));
    const totalCents = beerBottles * Math.max(0, Math.round(Number(settings.beerRateCents || 0)));
    const eligibleIds = (attendanceByDate.get(sale.date) || [])
      .filter((row) => eligibleForBeer(row, settings))
      .map((row) => row.userId);
    const allocation = allocateCents(totalCents, eligibleIds);
    for (const [userId, amountCents] of Object.entries(allocation)) {
      byUser[userId] = (byUser[userId] || 0) + amountCents;
    }
    details.push({ date: sale.date, beerBottles, totalCents, eligibleIds: [...new Set(eligibleIds)].sort(), allocation });
  }
  return { byUser, details };
}

function normalizeProfile(profile = {}, settings = DEFAULT_SETTINGS) {
  return {
    baseSalaryCents: Math.max(0, Math.round(Number(profile.baseSalaryCents || 0))),
    bankName: String(profile.bankName || ''),
    bankAccount: String(profile.bankAccount || ''),
    bankAccountName: String(profile.bankAccountName || ''),
    socialSecurityEnabled: profile.socialSecurityEnabled !== false,
    dailyFullDayRateCents: Math.max(0, Math.round(Number(profile.dailyFullDayRateCents ?? settings.dailyFullDayRateCents))),
    dailyHourlyRateCents: Math.max(0, Math.round(Number(profile.dailyHourlyRateCents ?? settings.dailyHourlyRateCents)))
  };
}

function normalizeDraft(draft = {}) {
  return {
    additionsCents: Math.max(0, Math.round(Number(draft.additionsCents || 0))),
    additionsNote: String(draft.additionsNote || ''),
    outsideOtCents: Math.max(0, Math.round(Number(draft.outsideOtCents || 0))),
    outsideOtNote: String(draft.outsideOtNote || ''),
    deductionsCents: Math.max(0, Math.round(Number(draft.deductionsCents || 0))),
    deductionsNote: String(draft.deductionsNote || '')
  };
}

export function calculateCompensationMonth({
  users = [], profiles = {}, attendance = [], sales = [], advances = [], recordDrafts = {}, settings = DEFAULT_SETTINGS
}) {
  const mergedSettings = { ...DEFAULT_SETTINGS, ...settings };
  const saleByDate = new Map(sales.filter((s) => s.status === 'final' && s.storeStatus === 'open').map((s) => [s.date, s]));
  const attendanceByUser = new Map();
  for (const row of attendance) {
    if (!attendanceByUser.has(row.userId)) attendanceByUser.set(row.userId, []);
    attendanceByUser.get(row.userId).push(row);
  }
  const advancesByUser = {};
  for (const row of advances) {
    if (row.deleted) continue;
    advancesByUser[row.userId] = (advancesByUser[row.userId] || 0) + Math.max(0, Math.round(Number(row.amountCents || 0)));
  }
  const beer = calculateBeerAllocation({ sales, attendance, settings: mergedSettings });
  const results = [];

  for (const user of users.filter((u) => ![ROLE.OWNER, ROLE.MANAGER, ROLE.SUPERVISOR].includes(u.role))) {
    const userAttendance = attendanceByUser.get(user.id) || [];
    const profile = normalizeProfile(profiles[user.id], mergedSettings);
    const draft = normalizeDraft(recordDrafts[user.id]);
    const fullDayRows = userAttendance.filter(isFullDay);
    const otMinutes = userAttendance.reduce((sum, row) => {
      const start = Number(row.otStartMinutes || 0);
      const end = Number(row.otEndMinutes || 0);
      return sum + (end > start ? end - start : 0);
    }, 0);
    const otCents = Math.round((otMinutes / 60) * Math.max(0, Number(mergedSettings.otRateCents || 0)));
    let dailyBonusCents = 0;
    let qualifyingKitchenSalesCents = 0;
    let qualifyingFrontSalesCents = 0;

    for (const row of fullDayRows) {
      if (!eligibleForDailyBonus(row, mergedSettings)) continue;
      const sale = saleByDate.get(row.date);
      if (!sale) continue;
      if ([ROLE.FRONT_KITCHEN, ROLE.BACK_KITCHEN].includes(user.role)) {
        const food = Math.max(0, Math.round(Number(sale.foodCents || 0)));
        qualifyingKitchenSalesCents += food;
        if (food > mergedSettings.dailyBonusKitchenThresholdCents) dailyBonusCents += mergedSettings.dailyBonusKitchenAmountCents;
      }
      if ([ROLE.FRONT_STAFF, ROLE.ROTATING_STAFF].includes(user.role)) {
        const beverage = Math.max(0, Math.round(Number(sale.beverageCents || 0)));
        qualifyingFrontSalesCents += beverage;
        if (beverage > mergedSettings.dailyBonusFrontThresholdCents) dailyBonusCents += mergedSettings.dailyBonusFrontAmountCents;
      }
    }

    let monthlyBonusCents = 0;
    if ([ROLE.FRONT_KITCHEN, ROLE.BACK_KITCHEN].includes(user.role) && qualifyingKitchenSalesCents > mergedSettings.monthlyBonusKitchenThresholdCents) {
      monthlyBonusCents = mergedSettings.monthlyBonusKitchenAmountCents;
    }
    if ([ROLE.FRONT_STAFF, ROLE.ROTATING_STAFF].includes(user.role) && qualifyingFrontSalesCents > mergedSettings.monthlyBonusFrontThresholdCents) {
      monthlyBonusCents = mergedSettings.monthlyBonusFrontAmountCents;
    }

    const beerBonusCents = beer.byUser[user.id] || 0;
    const advanceCents = advancesByUser[user.id] || 0;
    let basePayCents = profile.baseSalaryCents;
    let allDailyWagesCents = 0;
    let paidDailyWagesCents = 0;
    let unpaidDailyWagesCents = 0;
    let fullDayCount = 0;
    let hourlyHours = 0;

    if (user.role === ROLE.DAILY) {
      basePayCents = 0;
      for (const row of userAttendance) {
        let wage = 0;
        if (row.status === 'full_day') {
          fullDayCount += 1;
          wage = profile.dailyFullDayRateCents;
        } else if (row.status === 'hourly') {
          const hours = calculateHours(row.startMinutes, row.endMinutes);
          hourlyHours += hours;
          wage = Math.round(hours * profile.dailyHourlyRateCents);
        }
        allDailyWagesCents += wage;
        if (row.paid) paidDailyWagesCents += wage;
        else unpaidDailyWagesCents += wage;
      }
    }

    const ssBaseCents = user.role === ROLE.DAILY ? (profile.socialSecurityEnabled ? allDailyWagesCents : 0) : profile.baseSalaryCents;
    const ssCappedBaseCents = Math.min(Math.max(0, ssBaseCents), Math.max(0, mergedSettings.socialSecurityWageCeilingCents));
    const employeeSocialSecurityCents = profile.socialSecurityEnabled
      ? Math.round(ssCappedBaseCents * clampRate(mergedSettings.socialSecurityEmployeeRate, 0.05)) : 0;
    const employerSocialSecurityCents = profile.socialSecurityEnabled
      ? Math.round(ssCappedBaseCents * clampRate(mergedSettings.socialSecurityEmployerRate, 0.05)) : 0;

    const wageForTransferCents = user.role === ROLE.DAILY ? unpaidDailyWagesCents : basePayCents;
    const wageForCostCents = user.role === ROLE.DAILY ? allDailyWagesCents : basePayCents;
    const additionsAndBonusesCents = sumCents([
      otCents, draft.additionsCents, draft.outsideOtCents, dailyBonusCents, monthlyBonusCents, beerBonusCents
    ]);
    const transferCents = Math.max(0, sumCents([
      wageForTransferCents,
      additionsAndBonusesCents,
      -draft.deductionsCents,
      -advanceCents,
      -employeeSocialSecurityCents
    ]));
    const shopCostCents = Math.max(0, sumCents([
      wageForCostCents,
      additionsAndBonusesCents,
      -draft.deductionsCents,
      employerSocialSecurityCents
    ]));

    results.push({
      userId: user.id,
      displayName: user.displayName,
      role: user.role,
      profile,
      draft,
      basePayCents,
      fullDayCount,
      hourlyHours,
      allDailyWagesCents,
      paidDailyWagesCents,
      unpaidDailyWagesCents,
      otMinutes,
      otCents,
      dailyBonusCents,
      monthlyBonusCents,
      beerBonusCents,
      additionsCents: draft.additionsCents,
      outsideOtCents: draft.outsideOtCents,
      deductionsCents: draft.deductionsCents,
      advanceCents,
      employeeSocialSecurityCents,
      employerSocialSecurityCents,
      transferCents,
      shopCostCents,
      qualifyingKitchenSalesCents,
      qualifyingFrontSalesCents
    });
  }

  return {
    records: results.sort((a, b) => a.displayName.localeCompare(b.displayName, 'th')),
    totals: {
      transferCents: sumCents(results.map((r) => r.transferCents)),
      shopCostCents: sumCents(results.map((r) => r.shopCostCents)),
      employeeSocialSecurityCents: sumCents(results.map((r) => r.employeeSocialSecurityCents)),
      employerSocialSecurityCents: sumCents(results.map((r) => r.employerSocialSecurityCents))
    },
    beerDetails: beer.details
  };
}

export function calculateDashboard({ sales = [], ownerExpenses = [], recurringExpenses = [], compensationRecords = [], grossMarginRate = DEFAULT_SETTINGS.grossMarginRate }) {
  const finalSales = sales.filter((row) => row.status === 'final' && row.storeStatus === 'open');
  const revenueCents = sumCents(finalSales.map((row) => row.revenueCents));
  const shiftExpenseCents = sumCents(finalSales.flatMap((row) => row.shiftExpenses || []).map((row) => row.amountCents));
  const cashToOwnerCents = sumCents(finalSales.map((row) => row.cashToOwnerCents));
  const ownerExpenseCents = sumCents([
    ...ownerExpenses.filter((row) => !row.deleted).map((row) => row.amountCents),
    ...recurringExpenses.filter((row) => !row.deleted).map((row) => row.amountCents),
    ...compensationRecords.filter((row) => row.status === 'finalized').map((row) => row.shopCostCents)
  ]);
  const estimatedAfterProductCostCents = Math.round(revenueCents * clampRate(grossMarginRate, 0.40));
  const afterExpensesCents = estimatedAfterProductCostCents - shiftExpenseCents - ownerExpenseCents;
  return {
    revenueCents,
    shiftExpenseCents,
    ownerExpenseCents,
    cashToOwnerCents,
    estimatedAfterProductCostCents,
    afterExpensesCents
  };
}
