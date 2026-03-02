import { LayoutDashboard } from 'lucide-react';

export default function OrderAssembly() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full bg-zinc-50 p-8 text-center">
      <div className="w-16 h-16 bg-white border border-zinc-200 rounded-2xl flex items-center justify-center mb-6 shadow-sm">
        <LayoutDashboard className="w-8 h-8 text-zinc-400" />
      </div>
      <h1 className="text-2xl font-semibold text-zinc-900 mb-2">Сборка заказов</h1>
      <p className="text-zinc-500 max-w-md">
        Этот функционал реализован в другом приложении. Пожалуйста, используйте его для привязки КиЗ к новым заказам.
      </p>
    </div>
  );
}
