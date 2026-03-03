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

    // 1. Читаем текущий прогресс из базы (теперь rrdid будет хранить дату, с которой начать)
    // Формат: YYYY-MM-DD. Если 0 или пусто - начинаем год назад.
    const { data: syncState } = await supabase
      .from('sync_state')
      .select('rrdid')
      .eq('id', 'history_sync')
      .single()

    let startDateStr = ''
    if (!syncState?.rrdid || syncState.rrdid === 0) {
      // Начинаем ровно год назад от сегодня
      const oneYearAgo = new Date()
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
      startDateStr = oneYearAgo.toISOString().split('T')[0]
    } else {
      // Иначе берем сохраненную дату (мы будем сохранять ее как число YYYYMMDD для совместимости с rrdid, 
      // но лучше пока просто брать 1 день для теста, если там мусор от старой логики)
      // Для надежности, если там старый rrdid (миллионы), сбросим на год назад
      if (syncState.rrdid > 20300000) {
        const oneYearAgo = new Date()
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
        startDateStr = oneYearAgo.toISOString().split('T')[0]
      } else {
        // Конвертируем YYYYMMDD обратно в YYYY-MM-DD
        const str = syncState.rrdid.toString()
        startDateStr = `${str.substring(0,4)}-${str.substring(4,6)}-${str.substring(6,8)}`
      }
    }

    // Для обхода лимита WB (10 запросов в 5 часов) берем период в 3 месяца!
    const dateFrom = new Date(startDateStr)
    const dateTo = new Date(dateFrom)
    dateTo.setMonth(dateTo.getMonth() + 3) // +3 месяца
    
    // Если dateTo больше сегодня, ограничиваем сегодняшним днем
    const today = new Date()
    if (dateTo > today) {
      dateTo.setTime(today.getTime())
    }

    const dateFromStr = dateFrom.toISOString().split('T')[0]
    const dateToStr = dateTo.toISOString().split('T')[0]

    console.log(`Запрашиваем период: ${dateFromStr} - ${dateToStr}`)

    // 2. Делаем POST запрос к API Аналитики (Отчет по КИЗам)
    const response = await fetch(
      `https://seller-analytics-api.wildberries.ru/api/v1/analytics/excise-report?dateFrom=${dateFromStr}&dateTo=${dateToStr}`,
      {
        method: 'POST',
        headers: {
          'Authorization': wbToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({}) // пустой объект, чтобы получить все страны
      }
    )

    if (response.status === 429) {
      return new Response(JSON.stringify({ error: 'Rate limit (10 запросов в 5 часов)', wait: 300 }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (!response.ok) throw new Error(`WB API Error: ${response.status} ${response.statusText}`)

    const json = await response.json()
    const reportData = json.response?.data || [] 

    if (!reportData || reportData.length === 0) {
      // Данных за этот месяц нет, двигаем ползунок дальше
      const nextDateNum = parseInt(dateToStr.replace(/-/g, ''))
      
      if (dateToStr === today.toISOString().split('T')[0]) {
        // Дошли до сегодня
        await supabase.from('sync_state').update({ rrdid: 0 }).eq('id', 'history_sync')
        return new Response(JSON.stringify({ done: true, message: 'Миграция полностью завершена!' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }

      await supabase.from('sync_state').update({ rrdid: nextDateNum }).eq('id', 'history_sync')
      return new Response(JSON.stringify({ done: false, message: `Нет данных за ${dateFromStr}-${dateToStr}, идем дальше` }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // 3. Фильтруем продажи и возвраты, вытаскиваем КИЗы
    const tasksToInsert = []
    let missingKizCount = 0
    let wrongDocTypeCount = 0
    let loggedSample = false

    for (const row of reportData) {
      // Логируем первую строку, чтобы увидеть реальные названия полей
      if (!loggedSample) {
        console.log('Пример строки из нового API:', JSON.stringify(row))
        loggedSample = true
      }

      // В новом API поля называются excise_short, operation_type_id, srid, fiscal_dt
      const kiz = row.excise_short
      const operationId = row.operation_type_id
      const srid = row.srid
      const date = row.fiscal_dt || dateFromStr

      if (!kiz) {
        missingKizCount++
        continue
      }

      // В API: 1 - Продажа, 2 - Возврат, 3 - Брак (или другие статусы)
      if (operationId === 1) {
        tasksToInsert.push({
          kiz: kiz,
          task_type: 'OUT',
          task_status: 'NEW',
          srid: srid || `sync-${kiz}`, // fallback если srid нет
          vendor_code: row.nm_id ? row.nm_id.toString() : '',
          size: ''
        })
      } else if (operationId === 2) {
        tasksToInsert.push({
          kiz: kiz,
          task_type: 'RETURN',
          task_status: 'NEW',
          srid: srid || `sync-${kiz}`,
          vendor_code: row.nm_id ? row.nm_id.toString() : '',
          size: ''
        })
      } else {
        wrongDocTypeCount++
      }
    }

    console.log(`--- Итоги периода ${dateFromStr} - ${dateToStr} ---`)
    console.log(`Всего строк: ${reportData.length}`)
    console.log(`Без КИЗа: ${missingKizCount}`)
    console.log(`С КИЗом, но не продажа/возврат: ${wrongDocTypeCount}`)
    console.log(`Добавлено в базу: ${tasksToInsert.length}`)
    console.log(`-------------------`)

    // 4. Массово сохраняем задачи в базу
    if (tasksToInsert.length > 0) {
      for (let i = 0; i < tasksToInsert.length; i += 1000) {
        const chunk = tasksToInsert.slice(i, i + 1000)
        await supabase.from('chz_tasks').upsert(chunk, { onConflict: 'kiz', ignoreDuplicates: true })
      }
    }

    // 5. Запоминаем новую дату для следующего выстрела
    const nextDateNum = parseInt(dateToStr.replace(/-/g, ''))
    
    if (dateToStr === today.toISOString().split('T')[0]) {
      await supabase.from('sync_state').update({ rrdid: 0 }).eq('id', 'history_sync')
      return new Response(JSON.stringify({ done: true, message: 'Миграция полностью завершена!' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    await supabase.from('sync_state').update({ rrdid: nextDateNum }).eq('id', 'history_sync')

    return new Response(JSON.stringify({ 
      done: false, 
      processed: reportData.length, 
      foundKiz: tasksToInsert.length,
      period: `${dateFromStr} - ${dateToStr}`
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error: any) {
    console.error('Ошибка:', error.message)
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
