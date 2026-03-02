import React, { useState, useRef, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { PackageOpen, CheckCircle2, AlertTriangle, Search, XCircle } from 'lucide-react';

type ReturnStatus = 'idle' | 'success' | 'warning' | 'error';

export default function ReturnsReceiving() {
  const [kizInput, setKizInput] = useState('');
  const [status, setStatus] = useState<ReturnStatus>('idle');
  const [message, setMessage] = useState('');
  const [currentOrder, setCurrentOrder] = useState<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!kizInput.trim()) return;

    const scannedKiz = kizInput.trim();
    setKizInput(''); // Clear input for next scan
    setStatus('idle');
    setMessage('Поиск заказа...');
    setCurrentOrder(null);

    try {
      // 1. Find order by KiZ
      const { data: orders, error } = await supabase
        .from('orders')
        .select('*')
        .eq('scanned_kiz', scannedKiz)
        .limit(1);

      if (error) throw error;

      if (!orders || orders.length === 0) {
        setStatus('error');
        setMessage('КиЗ не найден в базе или уже отвязан.');
        return;
      }

      const order = orders[0];
      setCurrentOrder(order);

      // 2. Check wb_status
      const wbStatus = order.wb_status;

      if (['canceled', 'canceled_by_client', 'declined_by_client', 'defect', 'returned'].includes(wbStatus)) {
        // Green scenario: Safe to unbind
        await unbindKiz(order.id, scannedKiz);
        setStatus('success');
        setMessage('Товар возвращен на склад. Марка свободна.');
      } else {
        // Yellow scenario: WB status doesn't indicate return yet
        setStatus('warning');
        setMessage(`Внимание! Статус WB: "${wbStatus || 'неизвестно'}". Товар еще не числится возвращенным. Отвязать принудительно?`);
      }
    } catch (err: any) {
      console.error('Scan error:', err);
      setStatus('error');
      setMessage('Произошла ошибка при поиске заказа.');
    }
  };

  const unbindKiz = async (orderId: number, kiz: string) => {
    try {
      // Update DB to remove scanned_kiz
      const { error } = await supabase
        .from('orders')
        .update({ scanned_kiz: null })
        .eq('id', orderId);

      if (error) throw error;

      // In a real scenario, you would also call an Edge Function here
      // to send DELETE /api/v3/orders/{orderId}/meta?key=sgtin to WB API.
      console.log(`KiZ ${kiz} unbound from order ${orderId}`);
    } catch (err) {
      console.error('Error unbinding KiZ:', err);
      throw err;
    }
  };

  const handleForceUnbind = async () => {
    if (!currentOrder) return;
    try {
      await unbindKiz(currentOrder.id, currentOrder.scanned_kiz);
      setStatus('success');
      setMessage('Марка принудительно отвязана и свободна.');
    } catch (err) {
      setStatus('error');
      setMessage('Ошибка при принудительной отвязке.');
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-50 p-8">
      <div className="max-w-2xl mx-auto w-full space-y-8">
        
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white shadow-sm border border-zinc-200 mb-4">
            <PackageOpen className="w-8 h-8 text-zinc-900" />
          </div>
          <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">Приемка возвратов</h1>
          <p className="text-zinc-500">Отсканируйте марку (КиЗ) возвращенного товара, чтобы освободить её</p>
        </div>

        {/* Scanner Input */}
        <form onSubmit={handleScan} className="relative">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <Search className="h-6 w-6 text-zinc-400" />
          </div>
          <input
            ref={inputRef}
            type="text"
            value={kizInput}
            onChange={(e) => setKizInput(e.target.value)}
            className="block w-full pl-12 pr-4 py-4 bg-white border-2 border-zinc-200 rounded-2xl text-lg shadow-sm focus:ring-0 focus:border-zinc-900 transition-colors placeholder:text-zinc-400"
            placeholder="Отсканируйте DataMatrix код (КиЗ)..."
            autoFocus
          />
        </form>

        {/* Status Indicator */}
        {status !== 'idle' && (
          <div className={`p-6 rounded-2xl border ${
            status === 'success' ? 'bg-emerald-50 border-emerald-200' :
            status === 'warning' ? 'bg-amber-50 border-amber-200' :
            'bg-red-50 border-red-200'
          }`}>
            <div className="flex items-start gap-4">
              {status === 'success' && <CheckCircle2 className="w-8 h-8 text-emerald-600 shrink-0" />}
              {status === 'warning' && <AlertTriangle className="w-8 h-8 text-amber-600 shrink-0" />}
              {status === 'error' && <XCircle className="w-8 h-8 text-red-600 shrink-0" />}
              
              <div className="flex-1">
                <h3 className={`text-lg font-medium ${
                  status === 'success' ? 'text-emerald-900' :
                  status === 'warning' ? 'text-amber-900' :
                  'text-red-900'
                }`}>
                  {status === 'success' ? 'Успешно' : status === 'warning' ? 'Требуется внимание' : 'Ошибка'}
                </h3>
                <p className={`mt-1 ${
                  status === 'success' ? 'text-emerald-700' :
                  status === 'warning' ? 'text-amber-700' :
                  'text-red-700'
                }`}>
                  {message}
                </p>

                {status === 'warning' && currentOrder && (
                  <div className="mt-4 flex gap-3">
                    <button
                      onClick={handleForceUnbind}
                      className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700 transition-colors shadow-sm"
                    >
                      Отвязать принудительно
                    </button>
                    <button
                      onClick={() => { setStatus('idle'); inputRef.current?.focus(); }}
                      className="px-4 py-2 bg-white border border-amber-300 text-amber-900 text-sm font-medium rounded-lg hover:bg-amber-50 transition-colors shadow-sm"
                    >
                      Отмена
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Current Order Details (if found) */}
        {currentOrder && status !== 'error' && (
          <div className="bg-white rounded-2xl border border-zinc-200 p-6 shadow-sm">
            <h4 className="text-sm font-medium text-zinc-500 uppercase tracking-wider mb-4">Информация о заказе</h4>
            <div className="grid grid-cols-2 gap-y-4 gap-x-8">
              <div>
                <div className="text-sm text-zinc-500">SRID / Заказ</div>
                <div className="font-medium text-zinc-900">{currentOrder.srid || currentOrder.id}</div>
              </div>
              <div>
                <div className="text-sm text-zinc-500">Стикер WB</div>
                <div className="font-medium text-zinc-900">{currentOrder.sticker_id || '—'}</div>
              </div>
              <div>
                <div className="text-sm text-zinc-500">Артикул</div>
                <div className="font-medium text-zinc-900">{currentOrder.vendor_code || '—'}</div>
              </div>
              <div>
                <div className="text-sm text-zinc-500">Статус WB</div>
                <div className="font-medium text-zinc-900">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-100 text-zinc-800">
                    {currentOrder.wb_status || 'неизвестно'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
