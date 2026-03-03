import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { format } from 'date-fns';
import { CheckCircle2, XCircle, Copy, Download, AlertCircle, ClipboardList, RefreshCw, Database, PlayCircle, Loader2 } from 'lucide-react';

// --- КОМПОНЕНТ МИГРАЦИИ ИСТОРИИ ---
function HistoryMigration({ onComplete }: { onComplete: () => void }) {
  const [isMigrating, setIsMigrating] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [stats, setStats] = useState({ processed: 0, found: 0 });
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (cooldown > 0 && isMigrating) {
      timer = setTimeout(() => setCooldown(c => c - 1), 1000);
    } else if (cooldown === 0 && isMigrating && !isDone) {
      fetchHistoryChunk();
    }
    return () => clearTimeout(timer);
  }, [cooldown, isMigrating, isDone]);

  const fetchHistoryChunk = async () => {
    try {
      const { data, error } = await supabase.functions.invoke('sync-history');
      
      if (error || data?.error) {
         setCooldown(61); 
         return;
      }

      if (data.done) {
        setIsDone(true);
        setIsMigrating(false);
        onComplete();
      } else {
        setStats(prev => ({
          processed: prev.processed + (data.processed || 0),
          found: prev.found + (data.foundKiz || 0)
        }));
        setCooldown(61);
      }
    } catch (err) {
      console.error("Ошибка миграции:", err);
      setIsMigrating(false);
    }
  };

  const handleStart = () => {
    setIsMigrating(true);
    setIsDone(false);
    setStats({ processed: 0, found: 0 });
    setCooldown(0);
  };

  return (
    <div className="bg-white p-6 rounded-xl border border-zinc-200 mb-6 shadow-sm">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-zinc-900 flex items-center gap-2">
            <Database className="w-5 h-5 text-indigo-600" />
            Глубокая миграция истории (за год)
          </h3>
          <p className="text-sm text-zinc-500 mt-1">
            Автоматическая выгрузка старых КИЗов из отчетов реализации WB.
          </p>
        </div>

        {!isMigrating && !isDone && (
          <button
            onClick={handleStart}
            className="flex items-center justify-center gap-2 bg-indigo-600 text-white px-6 py-2.5 rounded-lg hover:bg-indigo-700 transition font-medium shadow-sm"
          >
            <PlayCircle className="w-5 h-5" />
            Начать загрузку
          </button>
        )}

        {isMigrating && (
          <div className="flex items-center gap-4 bg-indigo-50 px-5 py-3 rounded-lg border border-indigo-100 min-w-[300px]">
            <Loader2 className="w-6 h-6 text-indigo-600 animate-spin shrink-0" />
            <div className="text-sm">
              <div className="font-bold text-indigo-900">
                {cooldown > 0 ? `Ожидание лимита WB: ${cooldown} сек...` : 'Скачивание пачки (до 100 000 строк)...'}
              </div>
              <div className="text-indigo-700 mt-0.5 font-medium">
                Проверено: {stats.processed.toLocaleString()} | Найдено КИЗ: {stats.found.toLocaleString()}
              </div>
            </div>
          </div>
        )}

        {isDone && (
          <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 px-5 py-3 rounded-lg border border-emerald-200 font-medium">
            <CheckCircle2 className="w-5 h-5" />
            <span>Миграция успешно завершена! Найдено марок: {stats.found}</span>
          </div>
        )}
      </div>
    </div>
  );
}

type Task = {
  id: string;
  order_id: number;
  sticker_id: string;
  srid: string;
  vendor_code: string;
  size: string;
  kiz: string;
  task_type: 'OUT' | 'RETURN';
  task_status: 'NEW' | 'DONE' | 'ERROR';
  sale_date: string;
  note: string;
};

export default function ChzTasks() {
  const [activeTab, setActiveTab] = useState<'OUT' | 'RETURN'>('OUT');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [errorNote, setErrorNote] = useState<{ id: string; note: string } | null>(null);

  useEffect(() => {
    fetchTasks();
  }, [activeTab]);

  const fetchTasks = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('chz_tasks')
      .select('*')
      .eq('task_type', activeTab)
      .in('task_status', ['NEW', 'ERROR'])
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching tasks:', error);
    } else {
      setTasks(data || []);
    }
    setLoading(false);
  };

  const [cooldown, setCooldown] = useState(0);

  // Timer for cooldown
  useEffect(() => {
    if (cooldown > 0) {
      const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [cooldown]);

  const handleSyncWB = async () => {
    if (syncing || cooldown > 0) return;
    setSyncing(true);
    
    try {
      // 1. Check DB first to prevent spamming the Edge Function if another user just synced
      const { data: syncState, error: syncError } = await supabase
        .from('sync_state')
        .select('updated_at')
        .eq('id', 'wb_sales_sync')
        .single();

      if (syncError) throw new Error('Не удалось получить дату последней синхронизации');

      // Check if less than 60 seconds passed since last successful sync
      const lastSyncTime = new Date(syncState.updated_at).getTime();
      const now = new Date().getTime();
      const secondsSinceLastSync = Math.floor((now - lastSyncTime) / 1000);

      if (secondsSinceLastSync < 60) {
        const waitTime = 60 - secondsSinceLastSync;
        setCooldown(waitTime);
        alert(`Данные недавно обновлялись. Следующий запрос к WB возможен через ${waitTime} сек.`);
        setSyncing(false);
        return;
      }

      // 2. Call the secure Supabase Edge Function
      const { data, error } = await supabase.functions.invoke('sync-wb-sales');

      // 3. Handle errors returned by the Edge Function
      if (error) {
        // Supabase functions.invoke wraps HTTP errors in a specific format
        if (error.status === 429) {
          // Try to parse the custom error message we sent from the Edge Function
          let waitSeconds = 60;
          try {
            const errorData = JSON.parse(error.message);
            if (errorData.retryAfter) waitSeconds = errorData.retryAfter;
          } catch (e) {
            // Fallback if parsing fails
          }
          setCooldown(waitSeconds);
          throw new Error(`Слишком много запросов к WB. Попробуйте через ${waitSeconds} сек.`);
        }
        throw new Error(`Ошибка сервера: ${error.message}`);
      }

      // 4. Handle successful response
      if (data && data.message) {
        alert(data.message);
      } else {
        alert('Синхронизация завершена!');
      }
      
      setCooldown(60); // Start 60s cooldown after successful sync
      fetchTasks();

    } catch (error: any) {
      console.error('Sync error:', error);
      alert(error.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleCopyAll = () => {
    const kizes = tasks.map((t) => t.kiz).join('\n');
    navigator.clipboard.writeText(kizes);
    alert(`Скопировано ${tasks.length} КиЗ`);
  };

  const handleCopySingle = (kiz: string) => {
    navigator.clipboard.writeText(kiz);
  };

  const handleExportCSV = () => {
    if (tasks.length === 0) return;
    
    const headers = ['SRID', 'Стикер', 'Артикул', 'Размер', 'КиЗ', 'Дата продажи', 'Статус'];
    const csvContent = [
      headers.join(','),
      ...tasks.map(t => [
        t.srid || '',
        t.sticker_id || '',
        t.vendor_code || '',
        t.size || '',
        t.kiz || '',
        t.sale_date ? format(new Date(t.sale_date), 'dd.MM.yyyy') : '',
        t.task_status
      ].join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `chz_tasks_${activeTab}_${format(new Date(), 'yyyyMMdd')}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const updateTaskStatus = async (id: string, status: 'DONE' | 'ERROR', note?: string) => {
    const { error } = await supabase
      .from('chz_tasks')
      .update({ task_status: status, note: note || null })
      .eq('id', id);

    if (error) {
      console.error('Error updating task:', error);
      alert('Ошибка при обновлении статуса');
    } else {
      setTasks(tasks.filter((t) => t.id !== id || status === 'ERROR')); // Keep ERROR tasks in the list, remove DONE
      if (status === 'ERROR') {
        fetchTasks(); // Refresh to show the updated note
      }
    }
    setErrorNote(null);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-white">
      {/* Header */}
      <div className="px-8 py-6 border-b border-zinc-200">
        <h1 className="text-2xl font-semibold text-zinc-900">Задачи Честного Знака</h1>
        <p className="text-zinc-500 mt-1">Оформление вывода из оборота и возвратов</p>
      </div>

      <div className="px-8 pt-6">
        <HistoryMigration onComplete={fetchTasks} />
      </div>

      {/* Tabs & Actions */}
      <div className="px-8 py-4 flex items-center justify-between border-b border-zinc-200 bg-zinc-50">
        <div className="flex space-x-1 bg-zinc-200/50 p-1 rounded-lg">
          <button
            onClick={() => setActiveTab('OUT')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              activeTab === 'OUT' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600 hover:text-zinc-900'
            }`}
          >
            Вывод из оборота (OUT)
          </button>
          <button
            onClick={() => setActiveTab('RETURN')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              activeTab === 'RETURN' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-600 hover:text-zinc-900'
            }`}
          >
            Возвраты (RETURN)
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSyncWB}
            disabled={syncing || cooldown > 0}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg text-sm font-medium hover:bg-indigo-100 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Синхронизация...' : cooldown > 0 ? `Доступно через ${cooldown} сек` : 'Обновить из WB'}
          </button>
          <div className="w-px h-6 bg-zinc-300 mx-1"></div>
          <button
            onClick={handleCopyAll}
            disabled={tasks.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-zinc-300 text-zinc-700 rounded-lg text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 transition-colors"
          >
            <Copy className="w-4 h-4" />
            Скопировать все КиЗ
          </button>
          <button
            onClick={handleExportCSV}
            disabled={tasks.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-lg text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 transition-colors"
          >
            <Download className="w-4 h-4" />
            Экспорт CSV
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto p-8">
        {loading ? (
          <div className="flex items-center justify-center h-full text-zinc-500">Загрузка задач...</div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500">
            <ClipboardList className="w-12 h-12 mb-4 text-zinc-300" />
            <p>Нет новых задач для вкладки {activeTab}</p>
          </div>
        ) : (
          <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
                <tr>
                  <th className="px-6 py-4 font-medium">Заказ (SRID / Стикер)</th>
                  <th className="px-6 py-4 font-medium">Товар</th>
                  <th className="px-6 py-4 font-medium">КиЗ</th>
                  <th className="px-6 py-4 font-medium">Дата</th>
                  <th className="px-6 py-4 font-medium text-right">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200">
                {tasks.map((task) => (
                  <tr key={task.id} className={task.task_status === 'ERROR' ? 'bg-red-50/50' : 'hover:bg-zinc-50/50'}>
                    <td className="px-6 py-4">
                      <div className="font-medium text-zinc-900">{task.srid || '—'}</div>
                      <div className="text-zinc-500 text-xs mt-1">{task.sticker_id || '—'}</div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-zinc-900">{task.vendor_code || '—'}</div>
                      <div className="text-zinc-500 text-xs mt-1">Размер: {task.size || '—'}</div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <code className="bg-zinc-100 px-2 py-1 rounded text-xs text-zinc-800 font-mono">
                          {task.kiz.length > 20 ? task.kiz.substring(0, 20) + '...' : task.kiz}
                        </code>
                        <button
                          onClick={() => handleCopySingle(task.kiz)}
                          className="p-1 text-zinc-400 hover:text-zinc-900 rounded"
                          title="Скопировать КиЗ"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      {task.task_status === 'ERROR' && task.note && (
                        <div className="flex items-center gap-1 text-red-600 text-xs mt-2">
                          <AlertCircle className="w-3 h-3" />
                          {task.note}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 text-zinc-600">
                      {task.sale_date ? format(new Date(task.sale_date), 'dd.MM.yyyy') : '—'}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {errorNote?.id === task.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              placeholder="Причина ошибки..."
                              className="px-2 py-1 border border-zinc-300 rounded text-xs w-40"
                              value={errorNote.note}
                              onChange={(e) => setErrorNote({ ...errorNote, note: e.target.value })}
                              autoFocus
                            />
                            <button
                              onClick={() => updateTaskStatus(task.id, 'ERROR', errorNote.note)}
                              className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                            >
                              Сохранить
                            </button>
                            <button
                              onClick={() => setErrorNote(null)}
                              className="text-xs text-zinc-500 hover:text-zinc-900"
                            >
                              Отмена
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={() => setErrorNote({ id: task.id, note: '' })}
                              className="p-2 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                              title="Отметить ошибку"
                            >
                              <XCircle className="w-5 h-5" />
                            </button>
                            <button
                              onClick={() => updateTaskStatus(task.id, 'DONE')}
                              className="p-2 text-zinc-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                              title="Отметить как выполнено"
                            >
                              <CheckCircle2 className="w-5 h-5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
