import type { ReactNode } from 'react';
import './InteractionsPanel.css';

export function InteractionsPanel({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return <section className={`interactions-panel${compact ? ' is-compact' : ''}`} aria-label="Interactions">
    {!compact && <header><strong>Interactions</strong><span>Polls & votes</span></header>}
    {children}
  </section>;
}
