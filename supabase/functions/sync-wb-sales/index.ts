import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Initialize Supabase client using environment variables provided by the Edge Function environment
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // 2. Get the securely stored WB API Token
    const wbToken = Deno.env.get('WB_API_TOKEN')
    if (!wbToken) {
      throw new Error('WB_API_TOKEN is not set in Supabase Secrets')
    }

    // 3. Get last sync date from Supabase
    const { data: syncState, error: syncError } = await supabase
      .from('sync_state')
      .select('last_change_date')
      .eq('id', 'wb_sales_sync')
      .single()

    if (syncError) throw new Error('Failed to get last sync date from database')
    
    // Format date for WB API (YYYY-MM-DD)
    const dateFrom = new Date(syncState.last_change_date).toISOString().split('T')[0]

    // 4. Fetch data from WB API
    const response = await fetch(`https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${dateFrom}&flag=0`, {
      headers: {
        'Authorization': wbToken
      }
    })

    // 5. Smart Error Handling for 429 Too Many Requests
    if (response.status === 429) {
      // Read the correct header according to WB documentation
      const retryAfter = response.headers.get('X-Ratelimit-Retry')
      const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 60
      
      return new Response(
        JSON.stringify({ 
          error: 'Rate limit exceeded', 
          message: `Слишком много запросов к WB. Попробуйте через ${waitSeconds} сек.`,
          retryAfter: waitSeconds
        }),
        { 
          status: 429, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      )
    }

    if (!response.ok) {
      throw new Error(`WB API Error: ${response.status} ${response.statusText}`)
    }

    const sales = await response.json()

    if (!sales || sales.length === 0) {
      // Update the updated_at timestamp to enforce cooldown even if no new data
      await supabase
        .from('sync_state')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', 'wb_sales_sync')
        
      return new Response(
        JSON.stringify({ message: 'Нет новых данных о продажах или возвратах', updatedCount: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let updatedCount = 0
    let latestChangeDate = syncState.last_change_date

    // 6. Process sales and update orders in Supabase
    for (const item of sales) {
      const srid = item.srid
      const isReturn = item.IsStorno === 1 || item.IsStorno === true
      const date = item.date
      
      if (item.lastChangeDate && new Date(item.lastChangeDate) > new Date(latestChangeDate)) {
        latestChangeDate = item.lastChangeDate
      }

      if (isReturn) {
        const { error } = await supabase
          .from('orders')
          .update({ wb_status: 'returned', returned_at: date })
          .eq('srid', srid)
          .not('wb_status', 'eq', 'returned')
          
        if (!error) updatedCount++
      } else {
        const { error } = await supabase
          .from('orders')
          .update({ wb_status: 'sold', sold_at: date })
          .eq('srid', srid)
          .not('wb_status', 'eq', 'sold')
          
        if (!error) updatedCount++
      }
    }

    // 7. Update last sync date AND updated_at timestamp
    await supabase
      .from('sync_state')
      .update({ 
        last_change_date: latestChangeDate, 
        updated_at: new Date().toISOString() 
      })
      .eq('id', 'wb_sales_sync')

    return new Response(
      JSON.stringify({ 
        message: `Синхронизация завершена! Обновлено заказов: ${updatedCount}.`,
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
