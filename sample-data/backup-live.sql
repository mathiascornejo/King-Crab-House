-- Everything clear-live.sql removes, as one JSON document (save the output before clearing).
select jsonb_build_object(
  'taken_at', now(),
  'orders', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.orders x),
  'order_items', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.order_items x),
  'order_item_costs', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.order_item_costs x),
  'bills', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.bills x),
  'payments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.payments x),
  'voids', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.voids x),
  'day_closings', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.day_closings x),
  'forecasts', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.forecasts x),
  'stock_adjustments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.stock_adjustments x),
  'purchases', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.purchases x),
  'expenses', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.expenses x),
  'ingredients', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.ingredients x),
  'recipes', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.recipes x)) backup;
