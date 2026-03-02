-- 1. Удаляем задачу из расписания крона (если она успела создаться)
SELECT cron.unschedule('sync-wb-sales-every-15-min');

-- 2. Удаляем триггер (если он успел создаться)
DROP TRIGGER IF EXISTS trg_process_wb_response ON net.http_response;

-- 3. Удаляем функции, которые мы создавали для pg_net
DROP FUNCTION IF EXISTS public.handle_net_response();
DROP FUNCTION IF EXISTS public.sync_wb_sales();
DROP FUNCTION IF EXISTS public.process_wb_sales_response(bigint, integer, jsonb);
DROP FUNCTION IF EXISTS public.process_wb_sales_response(net.http_response);

-- 4. Опционально: отключаем расширения, если они больше нигде не используются
-- (Обычно их оставляют, так как они не мешают, но для чистоты эксперимента можно отключить)
-- DROP EXTENSION IF EXISTS pg_cron;
-- DROP EXTENSION IF EXISTS pg_net;

-- Примечание: Таблицу sync_state мы ОСТАВЛЯЕМ! 
-- Она нам пригодится для кнопки в браузере, чтобы помнить дату последней синхронизации.
