import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';

import { App } from './App';
import { I18nProvider } from './i18n';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element was not found');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 15_000,
    },
  },
});

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <App />
          <Toaster closeButton position="bottom-right" theme="light" />
        </I18nProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
