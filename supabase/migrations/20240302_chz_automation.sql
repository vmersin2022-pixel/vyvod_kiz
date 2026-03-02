-- 1. Добавляем новые колонки в таблицу orders
ALTER TABLE public.orders 
ADD COLUMN IF NOT EXISTS srid text,
ADD COLUMN IF NOT EXISTS wb_status text,
ADD COLUMN IF NOT EXISTS sold_at timestamptz,
ADD COLUMN IF NOT EXISTS returned_at timestamptz;

-- 2. Создаем уникальный индекс для КиЗ (чтобы один КиЗ не мог быть в двух активных заказах)
-- Мы делаем его частичным, чтобы отмененные заказы "отпускали" КиЗ
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_scanned_kiz_unique 
ON public.orders (scanned_kiz) 
WHERE scanned_kiz IS NOT NULL AND wb_status != 'canceled' AND wb_status != 'declined_by_client' AND wb_status != 'canceled_by_client' AND wb_status != 'defect';

-- 3. Создаем таблицу для задач Честного Знака
CREATE TABLE IF NOT EXISTS public.chz_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    order_id bigint NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    sticker_id text,
    srid text,
    vendor_code text,
    size text,
    kiz text NOT NULL,
    task_type text NOT NULL CHECK (task_type IN ('OUT', 'RETURN')),
    task_status text NOT NULL DEFAULT 'NEW' CHECK (task_status IN ('NEW', 'DONE', 'ERROR')),
    sale_date date,
    note text,
    CONSTRAINT chz_tasks_kiz_task_type_key UNIQUE (kiz, task_type)
);

-- 4. Создаем служебную таблицу для хранения состояния синхронизации (крона)
CREATE TABLE IF NOT EXISTS public.sync_state (
    id text PRIMARY KEY,
    last_change_date timestamptz NOT NULL,
    updated_at timestamptz DEFAULT now()
);

-- Инициализируем начальное значение (например, 7 дней назад)
INSERT INTO public.sync_state (id, last_change_date) 
VALUES ('wb_sales_sync', now() - interval '7 days')
ON CONFLICT (id) DO NOTHING;

-- 5. Триггер для автоматического создания задач ЧЗ при смене статуса WB
CREATE OR REPLACE FUNCTION public.handle_wb_status_change()
RETURNS TRIGGER AS $$
BEGIN
    -- Если статус изменился на 'sold' и есть привязанный КиЗ
    IF NEW.wb_status = 'sold' AND OLD.wb_status IS DISTINCT FROM 'sold' AND NEW.scanned_kiz IS NOT NULL THEN
        INSERT INTO public.chz_tasks (
            order_id, sticker_id, srid, vendor_code, size, kiz, task_type, task_status, sale_date
        ) VALUES (
            NEW.id, NEW.sticker_id, NEW.srid, NEW.vendor_code, NEW.size, NEW.scanned_kiz, 'OUT', 'NEW', NEW.sold_at::date
        )
        ON CONFLICT (kiz, task_type) DO NOTHING;
    END IF;

    -- Если статус изменился на 'returned' (возврат после выкупа) и есть привязанный КиЗ
    IF NEW.wb_status = 'returned' AND OLD.wb_status IS DISTINCT FROM 'returned' AND NEW.scanned_kiz IS NOT NULL THEN
        INSERT INTO public.chz_tasks (
            order_id, sticker_id, srid, vendor_code, size, kiz, task_type, task_status, sale_date
        ) VALUES (
            NEW.id, NEW.sticker_id, NEW.srid, NEW.vendor_code, NEW.size, NEW.scanned_kiz, 'RETURN', 'NEW', NEW.returned_at::date
        )
        ON CONFLICT (kiz, task_type) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Привязываем триггер к таблице orders
DROP TRIGGER IF EXISTS trg_orders_wb_status_change ON public.orders;
CREATE TRIGGER trg_orders_wb_status_change
AFTER UPDATE OF wb_status ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.handle_wb_status_change();

-- 6. RLS Политики для новых таблиц (разрешаем все для простоты, как в остальных таблицах)
ALTER TABLE public.chz_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access chz_tasks" ON public.chz_tasks FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access sync_state" ON public.sync_state FOR ALL USING (true) WITH CHECK (true);
