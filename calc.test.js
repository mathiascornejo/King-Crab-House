// Run: node calc.test.js
const assert = require('assert');
const { computeServings, recipeCost, openBills, dailyTotals, billTotals, splitEven, dishStats, forecastBuy, batchesOnHand, salesByHour, dailyUse, weekForecast, daysOfCover, marginCoverage, forecastError } = require('./calc.js');

const ingredients = [
  { id: 'crab', name: 'Crab', unit: 'pcs', stock: 7 },
  { id: 'vetsin', name: 'Vetsin', unit: 'tbsp', stock: 1 },
  { id: 'egg', name: 'Egg', unit: 'pcs', stock: '0' }, // Supabase may return numerics as strings
];
const recipes = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const items = [
  { recipe_id: 'a', ingredient_id: 'crab', qty: 2 },
  { recipe_id: 'a', ingredient_id: 'vetsin', qty: 0.25 / 3 }, // 1/4 tsp → 12 per tbsp
  { recipe_id: 'b', ingredient_id: 'egg', qty: '2' },
];
const [a, b] = computeServings(recipes, items, ingredients);
assert.strictEqual(a.servings, 3);
assert.deepStrictEqual(a.limiting, ['Crab']);
assert.strictEqual(a.lines[1].portions, 12);
assert.strictEqual(b.servings, 0);
assert.deepStrictEqual(b.limiting, ['Egg']);
// cost per portion: 2 crab @250 + 1/12 tbsp vetsin @2
assert.strictEqual(+recipeCost('a', items, [{ id: 'crab', cost: '250' }, { id: 'vetsin', cost: 2 }]).toFixed(4), 500.1667);
assert.strictEqual(recipeCost('a', items, [{ id: 'crab' }]), 0); // missing cost counts as 0

// bills: paid orders skipped, same item merged, old orders without a recorded price use today's menu price
const menu = [{ id: 'a', name: 'A', price: 100 }, { id: 'b', name: 'B', price: '50' }];
const bills = openBills([
  { table_no: 3, created_at: '2026-10-29T02:00:00Z', paid_at: null, order_items: [{ recipe_id: 'a', qty: 2, price: 90 }] },
  { table_no: 3, created_at: '2026-10-29T01:00:00Z', paid_at: null, order_items: [{ recipe_id: 'a', qty: 1, price: 90 }, { recipe_id: 'b', qty: 1, price: null }] },
  { table_no: 3, created_at: '2026-10-28T01:00:00Z', paid_at: '2026-10-28T02:00:00Z', order_items: [{ recipe_id: 'a', qty: 9, price: 90 }] },
  { table_no: 1, created_at: '2026-10-29T03:00:00Z', paid_at: null, order_items: [{ recipe_id: 'b', qty: 2, price: 50 }] },
], menu);
assert.deepStrictEqual(bills.map(b => [b.table_no, b.orders, b.total]), [[1, 1, 100], [3, 2, 320]]);
assert.deepStrictEqual(bills[1].lines.map(l => [l.name, l.qty, l.price]), [['A', 3, 90], ['B', 1, 50]]);
assert.strictEqual(bills[1].since, '2026-10-29T01:00:00Z');

// daily totals: paid and unpaid both count; missing price/cost fall back to menu price / recipe cost
const utcDay = d => d.slice(0, 10);
const days = dailyTotals([
  { created_at: '2026-10-29T03:00:00Z', order_items: [{ recipe_id: 'a', qty: 2, price: 90, unit_cost: 40 }] },
  { created_at: '2026-10-29T01:00:00Z', paid_at: '2026-10-29T02:00:00Z', order_items: [{ recipe_id: 'b', qty: 1, price: null, unit_cost: null }] },
  { created_at: '2026-10-28T05:00:00Z', order_items: [{ recipe_id: 'a', qty: 1, price: 100, unit_cost: 30 }] },
], menu, [{ recipe_id: 'b', ingredient_id: 'x', qty: 2 }], [{ id: 'x', cost: 5 }], utcDay);
assert.deepStrictEqual(days.map(d => [d.day, d.orders, d.sales, d.cost, d.profit]),
  [['2026-10-29', 2, 230, 90, 140], ['2026-10-28', 1, 100, 30, 70]]);

// bill: ₱1,120 for 4 guests, 1 senior → share 280 → 250 VAT-exempt (30 VAT off) → 50 discount → 1,040
assert.deepStrictEqual(billTotals(1120, 4, 1, 0), { gross: 1120, vatRemoved: 30, discount: 50, serviceCharge: 0, total: 1040 });
assert.strictEqual(billTotals(1120, 4, 1, 0.1).total, 1144);           // + 10% of 1,040
assert.deepStrictEqual(billTotals(650, 1, 0, 0), { gross: 650, vatRemoved: 0, discount: 0, serviceCharge: 0, total: 650 });
assert.strictEqual(billTotals(1000, 3, 1, 0).total, 904.77);           // share 333.33: VAT 35.71, discount 59.52

// split adds up exactly
assert.deepStrictEqual(splitEven(100, 3), [33.34, 33.33, 33.33]);
assert.strictEqual(+splitEven(940.48, 7).reduce((a, b) => a + b, 0).toFixed(2), 940.48);

// dish stats: best profit first, missing cost falls back to the recipe cost
const stats = dishStats([{ order_items: [{ recipe_id: 'a', qty: 2, price: 100, unit_cost: 30 }, { recipe_id: 'b', qty: 1, price: 50, unit_cost: null }] }],
  menu, [{ recipe_id: 'b', ingredient_id: 'x', qty: 2 }], [{ id: 'x', cost: 5 }]);
assert.deepStrictEqual(stats.map(s => [s.id, s.qty, s.sales, s.cost, s.profit]), [['a', 2, 200, 60, 140], ['b', 1, 50, 10, 40]]);

// low stock: only ingredients with a level set, at or below it; buy back up to twice the level
// forecast: Fridays 1 and 2 weeks back sold 4 and 2 'a' (avg 3); 'a' uses 2 crab → need 6; stock 1 → buy 5
const fri = new Date(2026, 9, 30); // Fri Oct 30 2026
const at = (daysBack, h = 19) => new Date(2026, 9, 30 - daysBack, h).toISOString();
const fc = forecastBuy([
  { created_at: at(7), order_items: [{ recipe_id: 'a', qty: 4 }] },
  { created_at: at(14), order_items: [{ recipe_id: 'a', qty: 2 }] },
  { created_at: at(3), order_items: [{ recipe_id: 'a', qty: 50 }] },          // a Tuesday: ignored
], [{ recipe_id: 'a', ingredient_id: 'crab', qty: 2 }, { recipe_id: 'a', ingredient_id: 'oil', qty: 7.5 }],
   [{ id: 'crab', unit: 'pcs', stock: 1 }, { id: 'oil', unit: 'mL', stock: 0 }], fri);
assert.strictEqual(fc.days, 2);
assert.deepStrictEqual(fc.ingredients.map(i => [i.id, i.need, i.buy]), [['oil', 22.5, 30], ['crab', 6, 5]]);
assert.strictEqual(forecastBuy([], [], [], fri).days, 0);
// exponential smoothing: Fridays 3, 2, 1 weeks back sold 2, 4, 8 → 2, then .5·4+.5·2 = 3, then .5·8+.5·3 = 5.5
// (a plain average would say 4.67); a week where 'a' wasn't ordered but 'b' was counts as 0 for 'a'
const es = recipes => forecastBuy(recipes.map(([back, id, qty]) => ({ created_at: at(back), order_items: [{ recipe_id: id, qty }] })), [], [], fri).dishes;
assert.deepStrictEqual(es([[21, 'a', 2], [14, 'a', 4], [7, 'a', 8]]), [{ recipe_id: 'a', qty: 5.5 }]);
assert.deepStrictEqual(es([[14, 'a', 4], [7, 'b', 2]]).find(d => d.recipe_id === 'a').qty, 2);

// batches: stock 15 → newest batch (10, 1 dead → 9) full, older batch 6 of 20, nothing untracked
const bo = batchesOnHand(15, [{ id: 2, qty: 10 }, { id: 1, qty: 20 }], { 2: 1 });
assert.deepStrictEqual(bo.batches.map(b => [b.id, b.left]), [[2, 9], [1, 6]]);
assert.strictEqual(bo.older, 0);
assert.strictEqual(batchesOnHand(40, [{ id: 1, qty: 10 }]).older, 30);

// sales by hour
const g = salesByHour([{ created_at: new Date(2026, 9, 30, 19, 15).toISOString(), order_items: [{ recipe_id: 'a', qty: 2, price: 100 }] }], menu);
assert.strictEqual(g[5][19], 200);

// daily use: 6 crabs over orders spanning 3 days → 2/day; a 40-day-old order is outside the window
const now = new Date(2026, 9, 30, 12).getTime();
const use = dailyUse([
  { created_at: new Date(now - 3 * 864e5).toISOString(), order_items: [{ recipe_id: 'a', qty: 1 }] },
  { created_at: new Date(now - 864e5).toISOString(), order_items: [{ recipe_id: 'a', qty: 2 }] },
  { created_at: new Date(now - 40 * 864e5).toISOString(), order_items: [{ recipe_id: 'a', qty: 99 }] },
], [{ recipe_id: 'a', ingredient_id: 'crab', qty: 2 }], now);
assert.deepStrictEqual(use, { crab: 2 });
// days of cover, no weekday history (flat fallback): proposal example — 20 crabs, 5/day → 4 days, lead 2 + 1 safety
// → no reorder; 10 rice at 5/day → 2 days → reorder; oil unused → left out
const noHistory = Array(7).fill({ days: 0, need: {} });
const dc = daysOfCover([{ id: 'crab', stock: 20 }, { id: 'rice', stock: 10 }, { id: 'oil', stock: 5 }], noHistory, { crab: 5, rice: 5 }, 2);
assert.deepStrictEqual(dc.map(i => [i.id, i.cover, i.reorder]), [['rice', 2, true], ['crab', 4, false]]);
// with weekday forecasts: Thu 2, Fri 9, Sat 9, then 2/day — 20 crabs: 18, 9, 0 left → 3 days; 15 → 13, 4, then 4/9 of Sat
const wk = [2, 9, 9, 2, 2, 2, 2].map(n => ({ days: 2, need: { crab: n } }));
assert.strictEqual(daysOfCover([{ id: 'crab', stock: 20 }], wk, { crab: 5 }, 2)[0].cover, 3);
assert.strictEqual(daysOfCover([{ id: 'crab', stock: 15 }], wk, { crab: 5 }, 2)[0].reorder, true);
assert.ok(Math.abs(daysOfCover([{ id: 'crab', stock: 15 }], wk, {}, 2)[0].cover - (2 + 4 / 9)) < 1e-9);
assert.strictEqual(daysOfCover([{ id: 'crab', stock: 1e6 }], wk, {}, 2)[0].cover, 60); // capped
// buy: next 7 days' forecast (2+9+9+2+2+2+2 = 28) − stock 15 = 13; reorder level = next 3 days (2+9+9 = 20)
const c15 = daysOfCover([{ id: 'crab', unit: 'pcs', stock: 15 }], wk, {}, 2)[0];
assert.deepStrictEqual([c15.buy, c15.reorderAt], [13, 20]);
// per-ingredient target: crab held only 3 days → 2+9+9 = 20 − 15 = 5
assert.strictEqual(daysOfCover([{ id: 'crab', unit: 'pcs', stock: 15, batch_tracked: true }], wk, {}, 2, i => i.batch_tracked ? 3 : 7)[0].buy, 5);
assert.strictEqual(daysOfCover([{ id: 'rice', unit: 'g', stock: 5 }], [2, 9, 9, 2, 2, 2, 2].map(n => ({ days: 2, need: { rice: n } })), {}, 2)[0].buy, 30);
// weekForecast: Fridays 7 and 14 days back sold 4 and 2 'a' → forecast for Friday 3 (2 crab each → 6); Thursday has no history
const wf = weekForecast([{ created_at: at(7), order_items: [{ recipe_id: 'a', qty: 4 }] }, { created_at: at(14), order_items: [{ recipe_id: 'a', qty: 2 }] }],
  [{ recipe_id: 'a', ingredient_id: 'crab', qty: 2 }], [{ id: 'crab', unit: 'pcs', stock: 0 }], new Date(2026, 9, 29));
assert.deepStrictEqual([wf[0].days, wf[1].days, wf[1].need], [0, 2, { crab: 6 }]);
// margin coverage: fixed items from menu price; per-kg from actual sales; uncosted ingredient → no margin
const mc = marginCoverage(
  [{ id: 'f1', name: 'F1', price: 100 }, { id: 'f2', name: 'F2', price: 100 }, { id: 'kg', name: 'Kg', price: 1500, pricing: 'per_kg' }, { id: 'u', name: 'U', price: 100 }],
  [{ recipe_id: 'f1', ingredient_id: 'x', qty: 1 }, { recipe_id: 'f2', ingredient_id: 'x', qty: 3 }, { recipe_id: 'kg', ingredient_id: 'x', qty: 1 }, { recipe_id: 'u', ingredient_id: 'y', qty: 1 }],
  [{ id: 'x', cost: 20 }, { id: 'y', cost: 0 }],
  [{ id: 'kg', sales: 1000, profit: 600 }]);
assert.deepStrictEqual([mc.covered, mc.total], [3, 4]);
assert.deepStrictEqual(mc.rows.map(r => [r.id, r.margin]), [['f2', 0.4], ['kg', 0.6], ['f1', 0.8]]);
assert.deepStrictEqual(mc.bottom.map(r => r.id), ['f2']);
assert.deepStrictEqual(mc.missing.map(r => r.id), ['u']);
// forecast error: proposal example — model +5%, staff +25%; a day with nothing used is skipped
const fe = forecastError([
  { ingredient_id: 'crab', ingredient: 'Crab', unit: 'pcs', actual: 20, model: 21, staff: 25 },
  { ingredient_id: 'crab', ingredient: 'Crab', unit: 'pcs', actual: 20, model: 19, staff: null },
  { ingredient_id: 'crab', ingredient: 'Crab', unit: 'pcs', actual: 0, model: 5, staff: 5 },
]);
assert.strictEqual(fe.length, 1);
assert.deepStrictEqual([fe[0].model.days, fe[0].model.avg, fe[0].model.bias], [2, 0.05, 0]);
assert.deepStrictEqual([fe[0].staff.days, fe[0].staff.avg, fe[0].staff.bias], [1, 0.25, 0.25]);
console.log('ok');
