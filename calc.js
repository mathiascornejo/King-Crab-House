// For each recipe: how many portions current stock allows, and which ingredient runs out first.
function computeServings(recipes, items, ingredients) {
  const byId = Object.fromEntries(ingredients.map(i => [i.id, i]));
  return recipes.map(r => {
    const lines = items.filter(it => it.recipe_id === r.id).map(it => {
      const ing = byId[it.ingredient_id];
      const qty = Number(it.qty), stock = Number(ing.stock);
      // epsilon guards against 0.9999… from fractional amounts
      return { ...ing, qty, stock, portions: Math.floor(stock / qty + 1e-9) };
    });
    const servings = lines.length ? Math.min(...lines.map(l => l.portions)) : 0;
    const limiting = lines.filter(l => l.portions === servings).map(l => l.name);
    return { ...r, servings, limiting, lines };
  });
}
// Ingredient cost of one portion (ingredients.cost is pesos per unit).
function recipeCost(recipeId, items, ingredients) {
  const cost = Object.fromEntries(ingredients.map(i => [i.id, Number(i.cost) || 0]));
  return items.filter(it => it.recipe_id === recipeId).reduce((sum, it) => sum + Number(it.qty) * (cost[it.ingredient_id] || 0), 0);
}

// Open bills per table: unpaid orders merged into one line per menu item.
// Uses the price recorded on the order, falling back to today's menu price for orders placed before prices existed.
function openBills(orders, recipes) {
  const menu = Object.fromEntries(recipes.map(r => [r.id, r]));
  const bills = {};
  for (const o of orders) {
    if (o.paid_at) continue;
    const bill = bills[o.table_no] ||= { table_no: o.table_no, since: o.created_at, orders: 0, lines: {}, total: 0 };
    bill.orders++;
    if (o.created_at < bill.since) bill.since = o.created_at;
    for (const i of o.order_items) {
      const price = Number(i.price ?? menu[i.recipe_id]?.price ?? 0);
      const line = bill.lines[`${i.recipe_id}@${price}`] ||= { recipe_id: i.recipe_id, name: menu[i.recipe_id]?.name || i.recipe_id, price, qty: 0 };
      line.qty += i.qty;
      if (i.note) (line.notes ||= []).push(i.note);
      bill.total += i.qty * price;
    }
  }
  return Object.values(bills).map(b => ({ ...b, lines: Object.values(b.lines) })).sort((a, b) => a.table_no - b.table_no);
}
// Sales, ingredient cost and profit per day, newest day first. dayKey turns a timestamp into a local-day key.
// Orders placed before prices/costs were recorded fall back to today's menu price and recipe cost.
function dailyTotals(orders, recipes, items, ingredients, dayKey = d => new Date(d).toDateString()) {
  const price = Object.fromEntries(recipes.map(r => [r.id, Number(r.price) || 0]));
  const days = new Map();
  for (const o of orders) {
    const k = dayKey(o.created_at);
    const day = days.get(k) || { day: k, first: o.created_at, orders: 0, sales: 0, cost: 0 };
    day.orders++;
    if (o.created_at > day.first) day.first = o.created_at;
    for (const i of o.order_items) {
      day.sales += i.qty * Number(i.price ?? price[i.recipe_id] ?? 0);
      day.cost += i.qty * Number(i.unit_cost ?? recipeCost(i.recipe_id, items, ingredients));
    }
    days.set(k, day);
  }
  return [...days.values()].map(d => ({ ...d, profit: d.sales - d.cost })).sort((a, b) => (a.first < b.first ? 1 : -1));
}
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Bill with Senior/PWD and service charge — same formula as close_table() in the database.
// The Senior/PWD share (seniors/guests of the bill) is VAT-exempt (price / 1.12), then 20% off.
function billTotals(gross, guests, seniors, serviceRate) {
  const share = gross * seniors / guests;
  const vatRemoved = round2(share - share / 1.12);
  const discount = round2(share / 1.12 * 0.20);
  const serviceCharge = round2((gross - vatRemoved - discount) * serviceRate);
  return { gross, vatRemoved, discount, serviceCharge, total: round2(gross - vatRemoved - discount + serviceCharge) };
}

// Split an amount into n parts that add up exactly to the centavo (earlier parts get the extra centavos).
function splitEven(total, n) {
  const cents = Math.round(total * 100), base = Math.floor(cents / n);
  return Array.from({ length: n }, (_, i) => (base + (i < cents % n ? 1 : 0)) / 100);
}

// Sales, cost and profit per dish, best profit first.
function dishStats(orders, recipes, items, ingredients) {
  const byId = Object.fromEntries(recipes.map(r => [r.id, { id: r.id, name: r.name, qty: 0, sales: 0, cost: 0 }]));
  for (const o of orders) for (const i of o.order_items) {
    const d = byId[i.recipe_id]; if (!d) continue;
    d.qty += i.qty;
    d.sales += i.qty * Number(i.price ?? recipes.find(r => r.id === i.recipe_id).price);
    d.cost += i.qty * Number(i.unit_cost ?? recipeCost(i.recipe_id, items, ingredients));
  }
  return Object.values(byId).filter(d => d.qty).map(d => ({ ...d, profit: d.sales - d.cost })).sort((a, b) => b.profit - a.profit);
}

// Tomorrow's buy list: portions forecast per dish from the same weekday over past weeks (days with orders only)
// by simple exponential smoothing — each week counts ALPHA, older weeks share the rest — turned into
// ingredient needs; buy what stock doesn't cover.
const ALPHA = 0.5;
// amount to buy, rounded up: whole pieces, otherwise to the next 10 g / mL; nothing if not needed
const roundBuy = (i, raw) => raw > 0 ? (i.unit === 'pcs' ? Math.ceil(raw) : Math.ceil(raw / 10) * 10) : 0;
function forecastBuy(orders, items, ingredients, target, weeks = 4, dayKey = d => new Date(d).toDateString()) {
  const t = new Date(target), sampleDays = [];
  for (let k = weeks; k >= 1; k--) sampleDays.push(dayKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 7 * k))); // oldest first
  const sold = {}; // day -> recipe_id -> qty
  for (const o of orders) {
    const k = dayKey(o.created_at);
    if (!sampleDays.includes(k)) continue;
    const day = sold[k] ||= {};
    for (const i of o.order_items) day[i.recipe_id] = (day[i.recipe_id] || 0) + i.qty;
  }
  const days = sampleDays.filter(k => sold[k]);
  if (!days.length) return { days: 0, dishes: [], ingredients: [] };
  const ids = [...new Set(days.flatMap(k => Object.keys(sold[k])))];
  // a dish not ordered on a sampled day counts as 0 that day; the oldest day seeds the level
  const dishes = ids.map(recipe_id => ({ recipe_id, qty: days.reduce((level, k, j) => {
    const x = sold[k][recipe_id] || 0;
    return j === 0 ? x : ALPHA * x + (1 - ALPHA) * level;
  }, 0) }));
  const need = {};
  for (const d of dishes) for (const it of items.filter(it => it.recipe_id === d.recipe_id)) need[it.ingredient_id] = (need[it.ingredient_id] || 0) + d.qty * Number(it.qty);
  const list = ingredients.filter(i => need[i.id]).map(i => {
    return { ...i, need: need[i.id], buy: roundBuy(i, need[i.id] - Number(i.stock)) };
  }).sort((a, b) => b.buy - a.buy);
  return { days: days.length, dishes, ingredients: list };
}

// Average amount of each ingredient used per day over the last `days` days (shorter if the orders don't go back that far).
function dailyUse(orders, items, now = Date.now(), days = 28) {
  const from = now - days * 864e5, used = {};
  let oldest = now;
  for (const o of orders) {
    const t = new Date(o.created_at).getTime();
    if (t < from) continue;
    if (t < oldest) oldest = t;
    for (const i of o.order_items) for (const it of items.filter(it => it.recipe_id === i.recipe_id))
      used[it.ingredient_id] = (used[it.ingredient_id] || 0) + i.qty * Number(it.qty);
  }
  const span = Math.max(1, Math.ceil((now - oldest) / 864e5));
  return Object.fromEntries(Object.entries(used).map(([id, q]) => [id, q / span]));
}
// The buy-list forecast for each of the 7 days from `start`: { days: weeks of history used, need: { ingredient_id: qty } }.
function weekForecast(orders, items, ingredients, start, dayKey) {
  const s = new Date(start);
  return Array.from({ length: 7 }, (_, d) => {
    const f = forecastBuy(orders, items, ingredients, new Date(s.getFullYear(), s.getMonth(), s.getDate() + d), 4, dayKey);
    return { days: f.days, need: Object.fromEntries(f.ingredients.map(i => [i.id, i.need])) };
  });
}
// Days of cover: walk forward from week[0] taking each day's forecast use until stock runs out (the week repeats;
// a weekday with no history yet uses the flat daily average `fallback`). Reorder when it drops below lead time
// + 1 safety day: reorderAt (the forecast low-stock level) is the use over those days. Capped at `max` days.
// buy = forecast use over the next `target` days − stock;
// `target` can be a function of the ingredient (e.g. fewer days for live crab, which dies if held too long).
// Lowest cover first.
function daysOfCover(ingredients, week, fallback, leadDays, target = 7, max = 60) {
  return ingredients.map(i => {
    const useOn = d => week[d % 7].days ? (week[d % 7].need[i.id] || 0) : (fallback[i.id] || 0);
    const weekly = [0, 1, 2, 3, 4, 5, 6].reduce((s, d) => s + useOn(d), 0);
    if (!(weekly > 0)) return null;
    let left = Math.max(Number(i.stock), 0), cover = 0;
    while (cover < max) {
      const u = useOn(cover);
      if (u > left) { cover += left / u; break; }
      left -= u; cover++;
    }
    let upcoming = 0, reorderAt = 0;
    const days = typeof target === 'function' ? target(i) : target;
    for (let d = 0; d < days; d++) upcoming += useOn(d);
    for (let d = 0; d < leadDays + 1; d++) reorderAt += useOn(d);
    return { ...i, perDay: weekly / 7, cover, reorderAt, reorder: cover < leadDays + 1,
      buy: roundBuy(i, upcoming - Math.max(Number(i.stock), 0)) };
  }).filter(Boolean).sort((a, b) => a.cover - b.cover);
}
// Margin % per menu item and how much of the menu has one. Fixed-price items use menu price − recipe cost;
// per-kg items use what they actually sold for (stats from dishStats), since the menu price is per kg, not per portion.
// Bottom = the lowest-margin quarter (at least one) of the items that have a margin.
function marginCoverage(recipes, items, ingredients, stats) {
  const sold = Object.fromEntries(stats.map(s => [s.id, s]));
  const costed = new Set(ingredients.filter(i => Number(i.cost) > 0).map(i => i.id));
  const rows = recipes.map(r => {
    const lines = items.filter(it => it.recipe_id === r.id);
    let margin = null;
    if (lines.length && lines.every(l => costed.has(l.ingredient_id))) {
      if (r.pricing === 'per_kg') { const s = sold[r.id]; if (s?.sales > 0) margin = s.profit / s.sales; }
      else if (Number(r.price) > 0) margin = (Number(r.price) - recipeCost(r.id, items, ingredients)) / Number(r.price);
    }
    return { id: r.id, name: r.name, margin };
  });
  const known = rows.filter(r => r.margin !== null).sort((a, b) => a.margin - b.margin);
  return { total: rows.length, covered: known.length, rows: known, bottom: known.slice(0, Math.ceil(known.length / 4)), missing: rows.filter(r => r.margin === null) };
}

// Forecast error per ingredient, as in the proposal: (forecast − actual) ÷ actual, for the model and for the staff
// estimate separately. avg = mean of the absolute errors (how far off), bias = mean signed error (+ over, − under).
// Days with nothing used are skipped (no error % without a base).
function forecastError(rows) {
  const by = {};
  for (const r of rows) {
    if (!(Number(r.actual) > 0)) continue;
    const g = by[r.ingredient_id] ||= { ingredient_id: r.ingredient_id, ingredient: r.ingredient, unit: r.unit, model: [], staff: [] };
    for (const k of ['model', 'staff']) if (r[k] !== null && r[k] !== undefined) g[k].push((Number(r[k]) - Number(r.actual)) / Number(r.actual));
  }
  const sum = e => e.length ? { days: e.length, avg: e.reduce((s, x) => s + Math.abs(x), 0) / e.length, bias: e.reduce((s, x) => s + x, 0) / e.length } : null;
  return Object.values(by).map(g => ({ ...g, model: sum(g.model), staff: sum(g.staff) }));
}

// What's left of each batch, oldest used first: today's stock is assigned to the newest batches first.
// purchases newest first; dead = { purchase_id: qty } logged against each batch.
function batchesOnHand(stock, purchases, dead = {}) {
  let left = Number(stock);
  const batches = purchases.map(p => {
    const take = Math.max(0, Math.min(Number(p.qty) - (dead[p.id] || 0), left));
    left -= take;
    return { ...p, left: take };
  }).filter(b => b.left > 0);
  return { batches, older: left }; // older = stock from before batches were recorded
}

// Sales by weekday (0 = Sunday) and hour, for the busiest-hours chart.
function salesByHour(orders, recipes) {
  const price = Object.fromEntries(recipes.map(r => [r.id, Number(r.price) || 0]));
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const o of orders) {
    const d = new Date(o.created_at);
    grid[d.getDay()][d.getHours()] += o.order_items.reduce((s, i) => s + i.qty * Number(i.price ?? price[i.recipe_id] ?? 0), 0);
  }
  return grid;
}
if (typeof module !== 'undefined') module.exports = { computeServings, recipeCost, openBills, dailyTotals, billTotals, splitEven, dishStats, forecastBuy, batchesOnHand, salesByHour, dailyUse, weekForecast, daysOfCover, marginCoverage, forecastError };
