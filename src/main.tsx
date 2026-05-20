import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError: boolean, error: Error | null}> {
  constructor(props: {children: React.ReactNode}) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: any) {
    console.error("App Crash:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', fontFamily: 'sans-serif', color: '#333' }}>
          <h2>Oops! Algo deu errado no aplicativo.</h2>
          <p>Tente limpar os dados do navegador ou abrir em aba anônima para resolver problemas de cache.</p>
          <pre style={{ background: '#eee', padding: '1rem', overflowX: 'auto' }}>
            {this.state.error?.toString()}
          </pre>
          <button 
             style={{ padding: '10px 20px', background: '#e11d48', color: 'white', border: 'none', borderRadius: '5px', marginTop: '10px' }}
             onClick={() => window.location.reload()}>
            Recarregar Página
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
