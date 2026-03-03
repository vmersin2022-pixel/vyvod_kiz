import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const wbToken = Deno.env.get('WB_API_TOKEN')
    if (!wbToken) {
      throw new Error('WB_API_TOKEN is not set in Supabase Secrets')
    }

    // 1. Получаем дату последней синхронизации
    const { data: syncState, error: syncError } = await supabase
      .from('sync_state')
      .select('last_change_date')
      .eq('id', 'wb_sales_sync')
      .single()

    if (syncError) throw new Error('Failed to get last sync date from database')
    
    const dateFrom = syncState.last_change_date

    // 2. Качаем продажи из WB API Статистики
    const response = await fetch(`https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(dateFrom)}&flag=0`, {
      headers: { 'Authorization': wbToken }
    })

    if (response.status === 429) {
      const retryAfter = response.headers.get('X-Ratelimit-Retry')
      const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 60
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded', message: `Слишком много запросов к WB. Попробуйте через ${waitSeconds} сек.`, retryAfter: waitSeconds }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!response.ok) throw new Error(`WB API Error: ${response.status} ${response.statusText}`)

    const sales = await response.json()

    if (!sales || sales.length === 0) {
      await supabase.from('sync_state').update({ updated_at: new Date().toISOString() }).eq('id', 'wb_sales_sync')
      return new Response(
        JSON.stringify({ message: `Нет новых данных о продажах.`, updatedCount: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 3. ОПТИМИЗАЦИЯ: Получаем все srid из нашей базы в память
    const { data: dbOrders } = await supabase
      .from('orders')
      .select('srid, wb_status')
      .not('srid', 'is', null)

    const dbOrdersMap = new Map()
    if (dbOrders) {
      for (const o of dbOrders) {
        dbOrdersMap.set(o.srid, o.wb_status)
      }
    }

    let updatedCount = 0
    let latestChangeDate = syncState.last_change_date
    const updatePromises = []

    // 4. Перебираем продажи и готовим обновления
    for (const item of sales) {
      const srid = item.srid
      const isReturn = item.IsStorno === 1 || item.IsStorno === true
      const date = item.date
      
      if (item.lastChangeDate && new Date(item.lastChangeDate) > new Date(latestChangeDate)) {
        latestChangeDate = item.lastChangeDate
      }

      // МГНОВЕННЫЙ ФИЛЬТР: Пропускаем чужие заказы, которых нет в нашей базе
      if (!srid || !dbOrdersMap.has(srid)) continue; 

      const currentStatus = dbOrdersMap.get(srid)
      const targetStatus = isReturn ? 'returned' : 'sold'

      // Обновляем только если статус реально изменился
      if (currentStatus !== targetStatus) {
        updatePromises.push(
          supabase.from('orders').update({ 
            wb_status: targetStatus, 
            [isReturn ? 'returned_at' : 'sold_at']: date 
          }).eq('srid', srid)
        )
        dbOrdersMap.set(srid, targetStatus) // Защита от дублей
      }
    }

    // 5. Выполняем обновления пачками по 10
    for (let i = 0; i < updatePromises.length; i += 10) {
      await Promise.all(updatePromises.slice(i, i + 10))
      updatedCount += updatePromises.slice(i, i + 10).length
    }

    // 6. Обновляем дату последней синхронизации
    await supabase
      .from('sync_state')
      .update({ last_change_date: latestChangeDate, updated_at: new Date().toISOString() })
      .eq('id', 'wb_sales_sync')

    return new Response(
      JSON.stringify({ message: `Синхронизация завершена! Обновлено продаж: ${updatedCount}.`, updatedCount }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error('Edge Function Error:', error.message)
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
