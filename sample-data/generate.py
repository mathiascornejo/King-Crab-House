"""Sample month for the test version: Oct 1 – Oct 30, 2026 at a small family crab restaurant (8 tables).

Simulates service day by day — tables, orders, add-ons, voids, Senior/PWD bills, split payments, cash change —
plus market runs, live-crab batches that die off the longer they're held, kitchen waste, monthly expenses,
cash-drawer closings and crab forecasts vs the manager's guesses. Stock never goes below zero: if an
ingredient runs out, that dish can't be ordered (a crab stockout), just like the real Order screen.

Usage: python3 -I generate.py live.json > demo-data.sql
live.json holds the current menu, recipes and ingredient costs (exported from the live database).
"""
import json, math, random, sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP

random.seed(20261030)
live = json.load(open(sys.argv[1]))
NOW = datetime(2026, 10, 30, 15, 0)           # Manila time; today's data stops after lunch
DAYS = [date(2026, 10, 1) + timedelta(d) for d in range(30)]
SERVICE = Decimal('0.10')

menu = {r['id']: r for r in live['recipes'] if not r['archived_at']}
recipe = defaultdict(dict)
for it in live['items']:
    if it['recipe_id'] in menu: recipe[it['recipe_id']][it['ingredient_id']] = float(it['qty'])
ings = {i['id']: i for i in live['ingredients']}
base_cost = {i: float(ings[i]['cost'] or 0) for i in ings}

def r2(x): return Decimal(str(x)).quantize(Decimal('0.01'), ROUND_HALF_UP)
def ts(dt): return dt.strftime("'%Y-%m-%d %H:%M:%S+08'")
def q(s): return "'" + s.replace("'", "''") + "'" if s is not None else 'null'
def at(d, h, m=0): return datetime(d.year, d.month, d.day, h, m) + timedelta(seconds=random.randint(0, 59))

# ---------- stock, batches and running average cost (as add_purchase / log_dead / place_order do) ----------
stock = defaultdict(float); avg = dict(base_cost); crab_batches = []   # [purchase_id, left, bought_on]
purchases, adjustments, ids = [], [], defaultdict(int)
def nid(t): ids[t] += 1; return ids[t]

def buy(ing, qty, when, price_factor=None):
    if qty <= 0: return
    unit = base_cost[ing] * (price_factor or random.uniform(0.94, 1.07))
    total = round(qty * unit) if unit * qty >= 1 else round(qty * unit, 2)
    on_hand = max(stock[ing], 0)
    avg[ing] = (on_hand * avg[ing] + total) / (on_hand + qty)
    stock[ing] += qty
    pid = nid('purchases')
    purchases.append((pid, ing, qty, total, when))
    if ing == 'crab': crab_batches.append([pid, qty, when.date()])
    return pid

def remove(ing, qty, when, reason, purchase_id=None):
    qty = min(qty, stock[ing])
    if qty <= 0: return
    stock[ing] -= qty
    adjustments.append((nid('adj'), ing, -qty, stock[ing], reason, when, avg[ing], purchase_id))

def use(ing, qty):
    stock[ing] -= qty
    if ing == 'crab':                         # kitchen takes the oldest crabs first
        for b in crab_batches:
            take = min(b[1], qty); b[1] -= take; qty -= take
            if not qty: break

def can_make(rid, n=1): return all(stock[i] >= a * n - 1e-9 for i, a in recipe[rid].items())
def portion_cost(rid): return sum(a * avg[i] for i, a in recipe[rid].items())

# ---------- demand ----------
WEEKDAY_BILLS = [11, 10, 11, 12, 15, 21, 20]         # Mon..Sun
CRAB = ['crab_rice', 'crab_sotanghon', 'crispy_salted_crab', 'crab_ginger_onion']
CRAB_W = [0.31, 0.30, 0.21, 0.18]
PLATTER = ['shrimp_pork_canton', 'szechuan_chicken']; PLATTER_W = [0.55, 0.45]
DRINK = ['coke', 'sprite', 'royal', 'coke_zero']; DRINK_W = [0.45, 0.2, 0.2, 0.15]
NOTES = ['Less spicy', 'No MSG', 'Extra ginger', 'Serve together', 'Cut crab in small pieces']

def daily_bills(d):
    n = WEEKDAY_BILLS[d.weekday()] * random.uniform(0.85, 1.15)
    if d.day in (15, 30): n *= 1.15                     # paydays
    return max(6, round(n))

# expected usage per day of week, for planning purchases (from the menu mix above)
def expected_use(d):
    n = WEEKDAY_BILLS[d.weekday()]
    crab_dishes = n * 1.3; platters = n * 0.8; drinks = n * 2.6           # per bill, matching the ordering below
    use_ = defaultdict(float)
    for rid, w in zip(CRAB, CRAB_W):
        for i, a in recipe[rid].items(): use_[i] += crab_dishes * w * a
    for rid, w in zip(PLATTER, PLATTER_W):
        for i, a in recipe[rid].items(): use_[i] += platters * w * a
    for rid, w in zip(DRINK, DRINK_W):
        for i, a in recipe[rid].items(): use_[i] += drinks * w * a
    return use_

def need(ing, start, days): return sum(expected_use(start + timedelta(k))[ing] for k in range(days))
def nice(ing, qty):
    unit = ings[ing]['unit']
    if unit == 'pcs': return math.ceil(qty / (24 if ing in DRINK else 5)) * (24 if ing in DRINK else 5)
    step = 1000 if qty > 3000 else 500 if qty > 800 else 250
    return math.ceil(qty / step) * step

orders, items, item_costs, bills, payments, voids, closings, expenses, forecasts = [], [], [], [], [], [], [], [], []
crab_use_by_day, dish_sold = {}, defaultdict(lambda: defaultdict(int))
FRESH = ['pechay', 'onion_leeks', 'carrot', 'ginger', 'onion_native', 'garlic', 'pork', 'shrimp', 'chicken_legs', 'chorizo', 'egg', 'canton']
PANTRY = ['oyster_sauce', 'sugar', 'chicken_powder', 'sesame_oil', 'soy_sauce', 'vetsin', 'cornstarch', 'salt', 'hebi']

for d in DAYS:
    # --- morning: crab deaths overnight (worse the longer a batch is held), then market runs ---
    for b in crab_batches:
        held = (d - b[2]).days
        if b[1] > 0 and held >= 1:
            rate = {1: 0.02, 2: 0.05, 3: 0.10}.get(held, 0.18)
            dead = sum(random.random() < rate for _ in range(int(b[1])))
            if dead:
                b[1] -= dead; remove('crab', dead, at(d, 8, random.randint(0, 40)), 'dead', b[0])
    # live crab: keep about 2-3 days on hand, never more (they die if held long)
    if stock['crab'] < need('crab', d, 2) * 1.15:
        buy('crab', nice('crab', need('crab', d, 3) * 1.15 - stock['crab']), at(d, 6, random.randint(30, 59)))
    # fresh produce and meat: Monday and Thursday market runs (and on day 1, the opening stock)
    if d.weekday() in (0, 3) or d == DAYS[0]:
        for ing in FRESH:
            days = 4 if d.weekday() == 3 else 3
            if d == DAYS[0]: days = 4
            want = need(ing, d, days) * 1.2 - stock[ing]
            if want > 0: buy(ing, nice(ing, want), at(d, 7, random.randint(0, 50)))
    # pantry: weekly top-up on Mondays; drinks delivered by the case when low
    for ing in PANTRY:
        if d == DAYS[0] or (d.weekday() == 0 and stock[ing] < need(ing, d, 9)):
            buy(ing, nice(ing, need(ing, d, 14) - stock[ing]), at(d, 7, random.randint(0, 50)))
    for ing in DRINK:
        if stock[ing] < need(ing, d, 3):
            buy(ing, nice(ing, need(ing, d, 6) - stock[ing]), at(d, 10, random.randint(0, 30)), random.uniform(0.98, 1.02))

    # --- service ---
    n_bills = daily_bills(d)
    last_start = datetime(d.year, d.month, d.day, 13, 45) if d == NOW.date() else None
    starts = []
    for _ in range(n_bills):
        lunch = random.random() < (0.42 if d.weekday() < 5 else 0.48)
        t = at(d, 11, 0) + timedelta(minutes=random.randint(0, 165)) if lunch else at(d, 17, 30) + timedelta(minutes=random.randint(0, 200))
        if last_start and t > last_start: continue
        starts.append(t)
    starts.sort()
    table_free = {n: datetime.min for n in range(1, 9)}
    day_crab = 0
    for t in starts:
        free = [n for n, f in table_free.items() if f <= t]
        if not free: continue                                   # full house: the family goes elsewhere
        table = random.choice(free)
        guests = random.choice([2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8])
        seniors = 0
        if random.random() < 0.2: seniors = 1 + (guests >= 6 and random.random() < 0.3)
        # what the table orders
        lines = defaultdict(int)
        dishes = math.ceil(guests / 3.5) + (random.random() < 0.35)
        for k in range(dishes):
            pick_crab = random.random() < (0.85 if k == 0 else 0.45)
            rid = random.choices(CRAB, CRAB_W)[0] if pick_crab else random.choices(PLATTER, PLATTER_W)[0]
            if not can_make(rid, lines.get(rid, 0) + 1):
                rid = random.choices(PLATTER, PLATTER_W)[0]       # crab ran out: they get a platter instead
                if not can_make(rid, lines.get(rid, 0) + 1): continue
            lines[rid] += 1
        for _ in range(guests):
            if random.random() < 0.5:
                rid = random.choices(DRINK, DRINK_W)[0]
                if can_make(rid, lines.get(rid, 0) + 1): lines[rid] += 1
        if not lines: continue
        rounds = [dict(lines)]
        if random.random() < 0.25:                                # add-on order: more drinks or another platter
            extra = defaultdict(int)
            for _ in range(random.randint(1, 3)):
                rid = random.choices(DRINK + PLATTER, [0.2, 0.1, 0.1, 0.1, 0.27, 0.23])[0]
                if can_make(rid, lines.get(rid, 0) + extra.get(rid, 0) + 1): extra[rid] += 1
            if extra: rounds.append(dict(extra))
        bill_id = nid('bills'); gross = Decimal(0); order_time = t; last_order = t
        for k, rnd in enumerate(rounds):
            if k: order_time = t + timedelta(minutes=random.randint(20, 45)); last_order = order_time
            oid = nid('orders')
            orders.append([oid, table, order_time, None, bill_id])
            for rid, n in rnd.items():
                for i, a in recipe[rid].items(): use(i, a * n)
                if rid in CRAB: day_crab += 2 * n
                dish_sold[d][rid] += n
                price = Decimal(str(menu[rid]['price']))
                gross += price * n
                note = random.choice(NOTES) if rid in CRAB and random.random() < 0.08 else None
                items.append((oid, rid, n, price, note))
                item_costs.append((oid, rid, portion_cost(rid)))
        # an occasional void: one drink sent back before paying (the order line is reduced, stock returned)
        if random.random() < 0.03:
            drinks_ = [x for x in items if x[0] == orders[-1][0] and x[1] in DRINK]
            if drinks_:
                oid, rid, n, price, note = drinks_[0]
                k = items.index(drinks_[0])
                if n > 1: items[k] = (oid, rid, n - 1, price, note)
                else: items.pop(k); item_costs[:] = [c for c in item_costs if not (c[0] == oid and c[1] == rid)]
                for i, a in recipe[rid].items(): stock[i] += a
                dish_sold[d][rid] -= 1; gross -= price
                voids.append((nid('voids'), table, rid, 1, price, last_order + timedelta(minutes=5)))
        paid = last_order + timedelta(minutes=random.randint(45, 80))
        if paid > NOW: paid = NOW - timedelta(minutes=random.randint(5, 20))
        for o in orders:
            if o[4] == bill_id: o[3] = paid
        share = gross * seniors / guests
        vat = r2(share - share / Decimal('1.12')); disc = r2(share / Decimal('1.12') * Decimal('0.20'))
        svc = r2((gross - vat - disc) * SERVICE); total = r2(gross - vat - disc + svc)
        bills.append((bill_id, table, guests, seniors, gross, vat, disc, svc, total, paid))
        methods = [random.choices(['cash', 'gcash', 'card'], [0.45, 0.35, 0.20])[0]]
        if guests >= 4 and random.random() < 0.12: methods.append(random.choice([m for m in ['cash', 'gcash', 'card'] if m != methods[0]]))
        cents = int(total * 100); parts = [(cents // len(methods) + (i < cents % len(methods))) / 100 for i in range(len(methods))]
        for m, amt in zip(methods, parts):
            amt = Decimal(str(amt))
            if m == 'cash':
                step = random.choice([100, 500, 1000])
                received = Decimal(math.ceil(amt / step) * step)
            else: received = amt
            payments.append((nid('payments'), bill_id, m, amt, received, received - amt, paid))
        table_free[table] = paid + timedelta(minutes=10)
    crab_use_by_day[d] = day_crab

    # --- evening: kitchen waste and the cash-drawer closing ---
    if d.weekday() == 6:                                         # Sunday clean-out of tired greens
        for ing in ['pechay', 'onion_leeks', 'carrot']:
            remove(ing, round(stock[ing] * random.uniform(0.05, 0.12) / 10) * 10, at(d, 21, random.randint(0, 30)), 'waste')
    if random.random() < 0.08: remove('egg', random.randint(2, 6), at(d, 20, random.randint(0, 50)), 'waste')
    if d.day == 17: remove('sesame_oil', 250, at(d, 19, 12), 'waste')   # dropped bottle
    if d.day == 23: remove('shrimp', 400, at(d, 21, 5), 'waste')        # freezer left open
    if d < NOW.date():
        day_bills = [b for b in bills if b[9].date() == d]
        day_pay = [p for p in payments if p[6].date() == d]
        cash = sum((p[3] for p in day_pay if p[2] == 'cash'), Decimal(0))
        diff = random.choices([Decimal(0), Decimal(-20), Decimal(-50), Decimal(10), Decimal(-100)], [0.72, 0.1, 0.08, 0.06, 0.04])[0]
        summary = {'bills': len(day_bills), 'gross': float(sum(b[4] for b in day_bills)), 'discount': float(sum(b[5] + b[6] for b in day_bills)),
                   'service_charge': float(sum(b[7] for b in day_bills)), 'cash': float(cash),
                   'gcash': float(sum((p[3] for p in day_pay if p[2] == 'gcash'), Decimal(0))), 'card': float(sum((p[3] for p in day_pay if p[2] == 'card'), Decimal(0)))}
        closings.append((d, cash, cash + diff, diff, json.dumps(summary), at(d, 21, 45) + timedelta(minutes=random.randint(0, 25))))

# ---------- crab forecasts (the app's method: smoothed same-weekday sales) vs the manager's guesses ----------
def model_forecast(d):
    past = [d - timedelta(7 * k) for k in range(4, 0, -1)]
    past = [p for p in past if p in crab_use_by_day and sum(dish_sold[p].values())]
    if not past: return None
    total = 0
    for rid in CRAB:
        level = None
        for j, p in enumerate(past):
            x = dish_sold[p][rid]
            level = x if j == 0 else 0.5 * x + 0.5 * level
        total += level * 2
    return round(total, 2)
for d in DAYS[7:]:
    m = model_forecast(d)
    if m is None: continue
    actual = crab_use_by_day[d]
    # tantsya: the manager's rule of thumb (busy weekends, quieter weekdays), leaning on the safe side
    habit = {4: 40, 5: 60, 6: 55}.get(d.weekday(), 30)
    guess = max(10, round(habit * random.gauss(1.08, 0.15)))
    forecasts.append((d, m, guess, at(d - timedelta(1), 21, random.randint(30, 59))))

# ---------- expenses for the month ----------
for day_, cat, amt, note in [
    (1, 'rent', 65000, 'October rent'), (3, 'gas', 4350, 'LPG 50 kg'), (2, 'supplies', 2840, 'Takeout boxes, tissue'),
    (9, 'other', 1200, 'Pest control'), (11, 'gas', 4350, 'LPG 50 kg'), (12, 'electricity', 31480, 'Meralco, Sept bill'),
    (14, 'water', 5860, 'Maynilad, Sept bill'), (15, 'wages', 72000, 'Payroll Oct 1–15, 9 staff'), (16, 'supplies', 3150, 'Dishwashing liquid, gloves'),
    (19, 'gas', 4350, 'LPG 50 kg'), (21, 'repairs', 4500, 'Crab tank pump repair'), (24, 'other', 2480, 'Lalamove deliveries'),
    (27, 'gas', 4350, 'LPG 50 kg'), (30, 'wages', 72000, 'Payroll Oct 16–31, 9 staff')]:
    expenses.append((date(2026, 10, day_), cat, amt, note))

# ---------- SQL ----------
out = ["-- Generated by sample-data/generate.py — sample month for the test version (demo schema).", "begin;", "set local search_path = demo;"]
def rows(table, cols, data, fmt):
    if not data: return
    for k in range(0, len(data), 500):
        out.append(f"insert into {table} ({', '.join(cols)}) overriding system value values\n" + ',\n'.join(fmt(r) for r in data[k:k + 500]) + ';' if 'id' in cols else
                   f"insert into {table} ({', '.join(cols)}) values\n" + ',\n'.join(fmt(r) for r in data[k:k + 500]) + ';')
rows('purchases', ['id', 'ingredient_id', 'qty', 'total_cost', 'created_at'], purchases, lambda r: f"({r[0]}, {q(r[1])}, {r[2]}, {r[3]}, {ts(r[4])})")
rows('stock_adjustments', ['id', 'ingredient_id', 'change', 'new_stock', 'reason', 'created_at', 'old_cost', 'new_cost', 'purchase_id'], adjustments,
     lambda r: f"({r[0]}, {q(r[1])}, {round(r[2], 4)}, {round(max(r[3], 0), 4)}, {q(r[4])}, {ts(r[5])}, {r[6]:.6f}, {r[6]:.6f}, {r[7] or 'null'})")
rows('bills', ['id', 'table_no', 'guests', 'seniors', 'gross', 'vat_removed', 'discount', 'service_charge', 'total', 'closed_at'], bills,
     lambda r: f"({r[0]}, {r[1]}, {r[2]}, {r[3]}, {r[4]}, {r[5]}, {r[6]}, {r[7]}, {r[8]}, {ts(r[9])})")
rows('orders', ['id', 'table_no', 'created_at', 'paid_at', 'bill_id'], orders, lambda r: f"({r[0]}, {r[1]}, {ts(r[2])}, {ts(r[3])}, {r[4]})")
rows('order_items', ['order_id', 'recipe_id', 'qty', 'price', 'note'], items, lambda r: f"({r[0]}, {q(r[1])}, {r[2]}, {r[3]}, {q(r[4])})")
rows('order_item_costs', ['order_id', 'recipe_id', 'unit_cost'], item_costs, lambda r: f"({r[0]}, {q(r[1])}, {r[2]:.4f})")
rows('payments', ['id', 'bill_id', 'method', 'amount', 'received', 'change', 'created_at'], payments,
     lambda r: f"({r[0]}, {r[1]}, {q(r[2])}, {r[3]}, {r[4]}, {r[5]}, {ts(r[6])})")
rows('voids', ['id', 'table_no', 'recipe_id', 'qty', 'price', 'created_at'], voids, lambda r: f"({r[0]}, {r[1]}, {q(r[2])}, {r[3]}, {r[4]}, {ts(r[5])})")
rows('day_closings', ['day', 'expected_cash', 'counted_cash', 'difference', 'summary', 'created_at'], closings,
     lambda r: f"('{r[0]}', {r[1]}, {r[2]}, {r[3]}, {q(r[4])}::jsonb, {ts(r[5])})")
rows('expenses', ['spent_on', 'category', 'amount', 'note'], expenses, lambda r: f"('{r[0]}', {q(r[1])}, {r[2]}, {q(r[3])})")
rows('forecasts', ['day', 'ingredient_id', 'model', 'staff', 'updated_at'], forecasts, lambda r: f"('{r[0]}', 'crab', {r[1]}, {r[2]}, {ts(r[3])})")
for ing in ings:
    out.append(f"update ingredients set stock = {round(max(stock[ing], 0), 4)} where id = {q(ing)};")
    out.append(f"insert into ingredient_costs (ingredient_id, cost, estimated) values ({q(ing)}, {avg[ing]:.6f}, false) on conflict (ingredient_id) do update set cost = excluded.cost, estimated = false;")
for t in ['purchases', 'stock_adjustments', 'bills', 'orders', 'payments', 'voids', 'day_closings', 'expenses']:
    out.append(f"select setval(pg_get_serial_sequence('demo.{t}', 'id'), greatest((select max(id) from demo.{t}), 1));")
out.append("commit;")
print('\n'.join(out))

# summary for a sanity check, on stderr
sales = sum(b[8] for b in bills); cost = sum(Decimal(str(c[2])) * next(i[2] for i in items if i[0] == c[0] and i[1] == c[1]) for c in item_costs)
dead = sum(-a[2] for a in adjustments if a[4] == 'dead'); bought = sum(p[2] for p in purchases if p[1] == 'crab')
print(f"bills {len(bills)}  orders {len(orders)}  collected ₱{sales:,.2f}  ingredient cost ₱{cost:,.2f}  expenses ₱{sum(e[2] for e in expenses):,}", file=sys.stderr)
print(f"crab bought {bought:.0f}  dead {dead:.0f} ({dead / bought:.1%})  used {sum(crab_use_by_day.values())}  end stock {stock['crab']:.0f}", file=sys.stderr)
print(f"purchases {len(purchases)}  adjustments {len(adjustments)}  voids {len(voids)}  closings {len(closings)}  forecasts {len(forecasts)}", file=sys.stderr)
print('min stock seen ok' if all(stock[i] >= -1e-6 for i in ings) else 'NEGATIVE STOCK', file=sys.stderr)
done = [f for f in forecasts if f[0] < NOW.date() and crab_use_by_day[f[0]]]   # Reports only scores finished days
errs = [abs(f[1] - crab_use_by_day[f[0]]) / crab_use_by_day[f[0]] for f in done]
serr = [abs(f[2] - crab_use_by_day[f[0]]) / crab_use_by_day[f[0]] for f in done]
print(f"forecast error model ±{sum(errs) / len(errs):.0%} vs guesses ±{sum(serr) / len(serr):.0%}", file=sys.stderr)
