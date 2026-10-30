-- Main version: clear every recorded sale, payment, purchase, stock change, expense, closing and forecast from
-- the live (public) tables and set all stock to 0. Keeps the menu, recipes, ingredient list, average costs and
-- staff logins. Take a backup first (backup-live.sql).
begin;
delete from public.payments;
delete from public.orders;            -- order_items and order_item_costs go with their orders
delete from public.bills;
delete from public.voids;
delete from public.day_closings;
delete from public.forecasts;
delete from public.stock_adjustments;
delete from public.purchases;
delete from public.expenses;
update public.ingredients set stock = 0;
update public.recipes set sold_out_on = null;
commit;
