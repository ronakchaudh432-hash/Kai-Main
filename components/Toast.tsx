"use client";

import { useEffect, useState } from "react";

export interface ToastItem {
  id: string;
  message: string;
  type: "info" | "error" | "success";
}

let toastListener: ((t: ToastItem) => void) | null = null;

export function showToast(message: string, type: ToastItem["type"] = "info") {
  toastListener?.({
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    message,
    type,
  });
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    toastListener = (t) => setToasts((prev) => [...prev.slice(-4), t]);
    return () => { toastListener = null; };
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => setToasts((prev) => prev.slice(1)), 4000);
    return () => clearTimeout(timer);
  }, [toasts]);

  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
