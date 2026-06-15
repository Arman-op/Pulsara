import * as React from 'react';
import { BrowserRouter, Routes, Route, Outlet } from 'react-router-dom';
import { ProtectedRoute } from './shared/components/ProtectedRoute';
import { Sidebar } from './app/Sidebar';
import Login from './features/auth/Login';
import Dashboard from './features/dashboard/Dashboard';
import Pipelines from './features/pipelines/Pipelines';
import Infrastructure from './features/infrastructure/Infrastructure';
import Alerts from './features/alerts/Alerts';
import Settings from './features/settings/Settings';
import { useToastStore } from './shared/store/toastStore';
import { X } from 'lucide-react';

function AppLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0A0C10]">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6 lg:p-10">
        <Outlet />
      </main>
    </div>
  );
}

function ToastContainer() {
  const { toasts, removeToast } = useToastStore();
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-full max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`p-4 rounded-xl border backdrop-blur-xl shadow-xl flex justify-between items-start transition-all duration-300 animate-in slide-in-from-bottom-5 ${
            t.type === 'success' ? 'bg-success/10 border-success/30 text-success' :
            t.type === 'error' ? 'bg-danger/10 border-danger/30 text-danger' :
            'bg-surface/85 border-border text-white'
          }`}
        >
          <div>
            <h4 className="font-semibold text-sm">{t.title}</h4>
            {t.message && <p className="text-xs text-muted mt-1">{t.message}</p>}
          </div>
          <button onClick={() => removeToast(t.id)} className="ml-4 text-muted hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        
        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/pipelines" element={<Pipelines />} />
            <Route path="/infrastructure" element={<Infrastructure />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Route>
      </Routes>
      <ToastContainer />
    </BrowserRouter>
  );
}
