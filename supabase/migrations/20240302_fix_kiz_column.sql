-- Обновление триггера для использования колонки scanned_kiz вместо kiz

-- 1. Сначала удаляем старый триггер и функцию
DROP TRIGGER IF EXISTS trg_orders_wb_status_change ON public.orders;
DROP FUNCTION IF EXISTS public.handle_wb_status_change();

-- 2. Создаем новую функцию с правильным названием колонки
CREATE OR REPLACE FUNCTION public.handle_wb_status_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Проверяем, изменился ли wb_status
  IF OLD.wb_status IS DISTINCT FROM NEW.wb_status THEN
    
    -- Если статус стал 'sold' (продано)
    IF NEW.wb_status = 'sold' THEN
      INSERT INTO public.chz_tasks (
        order_id, sticker_id, srid, vendor_code, size, kiz, task_type, task_status, sale_date
      ) VALUES (
        NEW.id, NEW.sticker_id, NEW.srid, NEW.vendor_code, NEW.size, NEW.scanned_kiz, 'OUT', 'NEW', CURRENT_DATE
      );
    
    -- Если статус стал 'returned' (возврат)
    ELSIF NEW.wb_status = 'returned' THEN
      INSERT INTO public.chz_tasks (
        order_id, sticker_id, srid, vendor_code, size, kiz, task_type, task_status, sale_date
      ) VALUES (
        NEW.id, NEW.sticker_id, NEW.srid, NEW.vendor_code, NEW.size, NEW.scanned_kiz, 'RETURN', 'NEW', CURRENT_DATE
      );
    END IF;
    
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Вешаем триггер обратно на таблицу orders
CREATE TRIGGER trg_orders_wb_status_change
  AFTER UPDATE OF wb_status ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_wb_status_change();
