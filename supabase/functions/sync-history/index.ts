import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
    const wbToken = Deno.env.get('WB_API_TOKEN')

    if (!wbToken) throw new Error('WB_API_TOKEN is missing')

    // 1. Читаем текущий прогресс из базы
    const { data: syncState } = await supabase
      .from('sync_state')
      .select('rrdid')
      .eq('id', 'history_sync')
      .single()

    const currentRrdid = syncState?.rrdid || 0
    const dateFrom = '2024-01-01' 
    const dateTo = new Date().toISOString().split('T')[0]

    // 2. Делаем 1 запрос в WB (лимит 100 000 строк)
    const response = await fetch(
      `https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=${dateFrom}&dateTo=${dateTo}&limit=100000&rrdid=${currentRrdid}`,
      { headers: { 'Authorization': wbToken } }
    )

    // 3. Обработка лимитов (429)
    if (response.status === 429) {
      return new Response(JSON.stringify({ error: 'Rate limit', wait: 60 }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // 4. Код 204 означает, что данных больше нет
    if (response.status === 204) {
      await supabase.from('sync_state').update({ rrdid: 0 }).eq('id', 'history_sync')
      return new Response(JSON.stringify({ done: true, message: 'Миграция полностью завершена!' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (!response.ok) throw new Error(`WB API Error: ${response.status}`)

    const report = await response.json()
    
    if (!report || report.length === 0) {
      await supabase.from('sync_state').update({ rrdid: 0 }).eq('id', 'history_sync')
      return new Response(JSON.stringify({ done: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // 5. Фильтруем продажи и возвраты, вытаскиваем КИЗы
    const tasksToInsert = []
    let nextRrdid = currentRrdid

    for (const row of report) {
      nextRrdid = row.rrdid
      
      if (row.kiz) {
        if (row.doc_type_name === 'Продажа') {
          tasksToInsert.push({
            kiz: row.kiz,
            task_type: 'OUT',
            task_status: 'NEW',
            srid: row.srid,
            vendor_code: row.sa_name || '',
            size: row.ts_name || ''
          })
        } else if (row.doc_type_name === 'Возврат') {
          tasksToInsert.push({
            kiz: row.kiz,
            task_type: 'RETURN',
            task_status: 'NEW',
            srid: row.srid,
            vendor_code: row.sa_name || '',
            size: row.ts_name || ''
          })
        }
      }
    }

    // 6. Массово сохраняем задачи в базу (с защитой от дублей по КИЗу)
    if (tasksToInsert.length > 0) {
      await supabase.from('chz_tasks').upsert(tasksToInsert, { onConflict: 'kiz', ignoreDuplicates: true })
    }

    // 7. Запоминаем новый rrdid для следующего выстрела
    await supabase.from('sync_state').update({ rrdid: nextRrdid }).eq('id', 'history_sync')

    return new Response(JSON.stringify({ 
      done: false, 
      processed: report.length, 
      foundKiz: tasksToInsert.length,
      nextRrdid: nextRrdid
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
