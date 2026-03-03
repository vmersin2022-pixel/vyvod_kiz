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

    let enrichedCount = 0

    // ====================================================================
    // ШАГ 1: ОБОГАЩЕНИЕ ДАННЫХ (Получение SRID/RID из FBS API)
    // ====================================================================
    // Проверяем, есть ли в базе заказы, у которых еще нет srid
    const { data: missingOrders, error: missingError } = await supabase
      .from('orders')
      .select('id')
      .is('srid', null)

    if (!missingError && missingOrders && missingOrders.length > 0) {
      const missingIds = new Set(missingOrders.map(o => o.id))
      
      // Берем заказы за последние 5 дней (с запасом, в Unix timestamp)
      const dateFromUnix = Math.floor(Date.now() / 1000) - (5 * 24 * 60 * 60)
      let next = 0
      let fetchCount = 0
      const MAX_REQUESTS = 10 // Защита от бесконечного цикла
      
      let allFbsOrders: any[] = []

      do {
        const fbsResponse = await fetch(`https://marketplace-api.wildberries.ru/api/v3/orders?limit=1000&next=${next}&dateFrom=${dateFromUnix}`, {
          headers: { 'Authorization': wbToken }
        })

        if (!fbsResponse.ok) {
          console.warn(`FBS API Error: ${fbsResponse.status} ${fbsResponse.statusText}`)
          break // Прерываем обогащение, но продолжаем работу функции (переходим к Шагу 2)
        }

        const fbsData = await fbsResponse.json()
        if (fbsData.orders) {
            allFbsOrders.push(...fbsData.orders)
        }
        next = fbsData.next
        fetchCount++
      } while (next && next !== 0 && fetchCount < MAX_REQUESTS)

      // Обновляем базу найденными rid
      for (const wbOrder of allFbsOrders) {
        if (missingIds.has(wbOrder.id) && wbOrder.rid) {
          const { error: updateErr } = await supabase
            .from('orders')
            .update({ srid: wbOrder.rid })
            .eq('id', wbOrder.id)
          
          if (!updateErr) enrichedCount++
        }
      }
      console.log(`Обогащено заказов (добавлен srid): ${enrichedCount}`)
    }

    // ====================================================================
    // ШАГ 2: ОБРАБОТКА ПРОДАЖ (API Статистики)
    // ====================================================================
    const { data: syncState, error: syncError } = await supabase
      .from('sync_state')
      .select('last_change_date')
      .eq('id', 'wb_sales_sync')
      .single()

    if (syncError) throw new Error('Failed to get last sync date from database')
    
    const dateFrom = syncState.last_change_date

    const response = await fetch(`https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(dateFrom)}&flag=0`, {
      headers: { 'Authorization': wbToken }
    })

    if (response.status === 429) {
      const retryAfter = response.headers.get('X-Ratelimit-Retry')
      const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 60
      
      return new Response(
        JSON.stringify({ 
          error: 'Rate limit exceeded', 
          message: `Слишком много запросов к WB. Попробуйте через ${waitSeconds} сек.`,
          retryAfter: waitSeconds
        }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!response.ok) {
      throw new Error(`WB API Error: ${response.status} ${response.statusText}`)
    }

    const sales = await response.json()

    if (!sales || sales.length === 0) {
      await supabase
        .from('sync_state')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', 'wb_sales_sync')
        
      return new Response(
        JSON.stringify({ 
          message: `Нет новых данных о продажах. Обогащено srid: ${enrichedCount}`, 
          updatedCount: 0 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let updatedCount = 0
    let latestChangeDate = syncState.last_change_date

    for (const item of sales) {
      const srid = item.srid
      const isReturn = item.IsStorno === 1 || item.IsStorno === true
      const date = item.date
      
      if (item.lastChangeDate && new Date(item.lastChangeDate) > new Date(latestChangeDate)) {
        latestChangeDate = item.lastChangeDate
      }

      if (!srid) continue; // Теперь мы строго зависим от srid

      if (isReturn) {
        const { data, error } = await supabase
          .from('orders')
          .update({ wb_status: 'returned', returned_at: date })
          .eq('srid', srid) // ИЩЕМ СТРОГО ПО SRID!
          .not('wb_status', 'eq', 'returned')
          .select()
          
        if (!error && data && data.length > 0) {
          updatedCount++
        }
      } else {
        const { data, error } = await supabase
          .from('orders')
          .update({ wb_status: 'sold', sold_at: date })
          .eq('srid', srid) // ИЩЕМ СТРОГО ПО SRID!
          .not('wb_status', 'eq', 'sold')
          .select()
          
        if (!error && data && data.length > 0) {
          updatedCount++
        }
      }
    }

    await supabase
      .from('sync_state')
      .update({ 
        last_change_date: latestChangeDate, 
        updated_at: new Date().toISOString() 
      })
      .eq('id', 'wb_sales_sync')

    return new Response(
      JSON.stringify({ 
        message: `Синхронизация завершена! Обогащено srid: ${enrichedCount}. Обновлено продаж: ${updatedCount}.`,
        updatedCount 
      }),
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
